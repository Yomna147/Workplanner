<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\SalesToolProjectProposal;
use App\Services\SalesToolLiveSyncService;
use App\Services\SalesToolProjectProposeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use InvalidArgumentException;
use Throwable;

class SalesToolIntegrationController extends Controller
{
    public function ping(): JsonResponse
    {
        return response()->json([
            'ok' => true,
            'app' => 'Workplanner 2.0',
            'integration' => 'sales_tool',
            'mode' => 'proposal',
        ]);
    }

    /**
     * Sales Tool → WP: queue a pending project proposal (no project created yet).
     */
    public function proposeProject(Request $request, SalesToolProjectProposeService $propose): JsonResponse
    {
        try {
            $result = $propose->propose($request->all());
            $proposal = $result['proposal'];

            return response()->json([
                'ok' => true,
                'action' => $result['action'],
                'proposal_id' => $proposal->id,
                'status' => $proposal->status,
                'job_number' => $proposal->job_number,
                'name' => $proposal->project_name,
                'message' => 'Proposal queued for confirmation on WorkPlanner Home.',
            ], $result['action'] === 'created' ? 201 : 200);
        } catch (InvalidArgumentException $e) {
            return response()->json(['ok' => false, 'message' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'ok' => false,
                'message' => 'Unable to queue Sales Tool proposal.',
            ], 500);
        }
    }

    /** @deprecated Use proposeProject — kept so older ST builds do not 404. */
    public function upsertProject(Request $request, SalesToolProjectProposeService $propose): JsonResponse
    {
        return $this->proposeProject($request, $propose);
    }

    public function indexPending(
        Request $request,
        SalesToolProjectProposeService $propose,
        SalesToolLiveSyncService $liveSync,
    ): JsonResponse {
        // Default: deals relevant for this month and the next two
        // (created/updated timestamps OR deal start/end dates OR month CRM column).
        // days=0 or window=all returns all pending; days=N overrides to a rolling window.
        $window = strtolower(trim((string) $request->input('window', '3months')));
        $since = null;
        $until = now()->endOfDay();
        $days = null;
        if ($request->has('days')) {
            $days = max((int) $request->integer('days'), 0);
            $since = $days > 0 ? now()->subDays($days)->startOfDay() : null;
            $window = $days > 0 ? 'days' : 'all';
        } elseif (in_array($window, ['all', 'none'], true)) {
            $since = null;
            $window = 'all';
        } elseif (in_array($window, ['3months', '3month', 'quarter'], true)) {
            // Current calendar month plus the next two.
            $since = now()->startOfMonth()->startOfDay();
            $until = now()->startOfMonth()->addMonths(2)->endOfMonth()->endOfDay();
            $window = '3months';
        } else {
            $since = now()->startOfMonth()->startOfDay();
            $window = 'month';
        }

        $syncMeta = null;
        $shouldSyncFromSt = $request->boolean(
            'sync_from_st',
            (bool) config('sales_tool.live_sync_enabled', true),
        );
        if ($shouldSyncFromSt) {
            $syncMeta = $liveSync->syncEligibleDeals(
                since: $since ?? now()->startOfMonth()->startOfDay(),
                until: $until,
                limit: min(max((int) $request->integer('limit', 80), 1), 120),
            );
        }

        if ($request->boolean('refresh_quotations')) {
            $propose->refreshPendingQuotations(
                limit: min(max((int) $request->integer('limit', 30), 1), 80),
                force: $request->boolean('force'),
            );
        }

        $readyOnly = $request->boolean('ready_only', $window === 'month');

        $rows = SalesToolProjectProposal::query()
            ->pending()
            ->orderByDesc('updated_at')
            ->limit(500)
            ->get()
            ->when($since, fn ($collection) => $collection->filter(
                fn (SalesToolProjectProposal $row) => $row->isDealTouchedSince($since, $until)
            ))
            ->when($readyOnly, fn ($collection) => $collection->filter(
                fn (SalesToolProjectProposal $row) => $row->hasCreateReadyData()
            ))
            ->sortByDesc(fn (SalesToolProjectProposal $row) => [
                is_array($row->quotations) && count($row->quotations) > 0 ? 1 : 0,
                in_array($row->st_status, ['in_progress', 'in_progress_not_started'], true) ? 1 : 0,
                isset(SalesToolProjectProposal::MONTH_STATUS_INDEX[strtolower((string) $row->st_status)]) ? 1 : 0,
                $row->updated_at?->timestamp ?? 0,
            ])
            ->take(200)
            ->values()
            ->map(fn (SalesToolProjectProposal $row) => $row->toApiArray())
            ->values();

        return response()->json([
            'data' => $rows,
            'meta' => [
                'window' => $window,
                'days' => $days,
                'since' => $since?->toIso8601String(),
                'until' => $since ? $until->toIso8601String() : null,
                'ready_only' => $readyOnly,
                'year' => $since?->year,
                'month' => $since?->month,
                'sync_from_st' => $shouldSyncFromSt,
                'st_sync' => $syncMeta,
            ],
        ]);
    }

    public function show(SalesToolProjectProposal $salesToolProposal, SalesToolProjectProposeService $propose): JsonResponse
    {
        if (! $salesToolProposal->quotations_checked_at) {
            $propose->attachQuotations($salesToolProposal, force: true);
            $salesToolProposal->refresh();
        }

        return response()->json(['data' => $salesToolProposal->toApiArray()]);
    }

    public function refreshQuotations(
        SalesToolProjectProposal $salesToolProposal,
        SalesToolProjectProposeService $propose,
    ): JsonResponse {
        $propose->attachQuotations($salesToolProposal, force: true);

        return response()->json(['data' => $salesToolProposal->fresh()->toApiArray()]);
    }

    public function refreshPendingQuotations(Request $request, SalesToolProjectProposeService $propose): JsonResponse
    {
        $result = $propose->refreshPendingQuotations(
            limit: min(max((int) $request->integer('limit', 40), 1), 100),
            force: $request->boolean('force'),
        );

        return response()->json(['data' => $result]);
    }

    public function dismiss(SalesToolProjectProposal $salesToolProposal): JsonResponse
    {
        $salesToolProposal->status = SalesToolProjectProposal::STATUS_DISMISSED;
        $salesToolProposal->dismissed_at = now();
        $salesToolProposal->save();

        return response()->json(['data' => $salesToolProposal->toApiArray()]);
    }

    public function accept(Request $request, SalesToolProjectProposal $salesToolProposal): JsonResponse
    {
        $validated = $request->validate([
            'project_id' => 'nullable|integer|exists:projects,id',
        ]);

        $salesToolProposal->status = SalesToolProjectProposal::STATUS_ACCEPTED;
        $salesToolProposal->accepted_at = now();
        $salesToolProposal->created_project_id = $validated['project_id'] ?? null;
        $salesToolProposal->save();

        return response()->json(['data' => $salesToolProposal->toApiArray()]);
    }
}
