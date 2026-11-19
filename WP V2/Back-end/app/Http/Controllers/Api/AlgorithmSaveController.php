<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ProjectTask;
use App\Services\ActivityLogService;
use App\Support\AlgorithmCache;
use App\Support\AlgorithmTaskMapper;
use App\Support\DlMirrorFields;
use App\Support\EmployeeNames;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class AlgorithmSaveController extends Controller
{
    public function saveResults(Request $request): JsonResponse
    {
        $cachedData = AlgorithmCache::get($request);
        $filteredTasks = is_array($cachedData['filteredTasks'] ?? null)
            ? $cachedData['filteredTasks']
            : [];

        if ($filteredTasks === []) {
            return response()->json([
                'message' => 'No algorithm results to save. Run the algorithm first.',
            ], 422);
        }

        EmployeeNames::warmEmployeeCache();

        try {
            $taskIds = collect($filteredTasks)
                ->pluck('id')
                ->filter()
                ->map(fn ($id) => (int) $id)
                ->unique()
                ->values()
                ->all();

            $existing = ProjectTask::query()
                ->whereIn('id', $taskIds)
                ->get()
                ->keyBy('id');

            $updated = 0;
            $skipped = 0;

            DB::transaction(function () use ($filteredTasks, $existing, &$updated, &$skipped) {
                foreach ($filteredTasks as $legacyTask) {
                    if (! is_array($legacyTask)) {
                        $skipped++;
                        continue;
                    }

                    $id = (int) ($legacyTask['id'] ?? 0);
                    if ($id <= 0 || ! $existing->has($id)) {
                        $skipped++;
                        continue;
                    }

                    /** @var ProjectTask $task */
                    $task = $existing->get($id);
                    $payload = AlgorithmTaskMapper::fromLegacy($legacyTask);
                    $payload['algorithm_1'] = $payload['algorithm_1'] ?? '';
                    $payload['algorithm_2'] = $payload['algorithm_2'] ?? '';
                    $payload['algorithm_3'] = $payload['algorithm_3'] ?? '';
                    if (DlMirrorFields::shouldPreserveOwner($task)) {
                        unset($payload['owner']);
                    }
                    EmployeeNames::normalizeTaskPayload($payload);

                    $task->update($payload);
                    $updated++;
                }
            });

            if ($updated > 0) {
                ActivityLogService::log(
                    $request,
                    'pde',
                    'algorithm_save',
                    sprintf('Saved algorithm results for %d task%s across all projects', $updated, $updated === 1 ? '' : 's'),
                    null,
                    null,
                    null,
                    [
                        'updated' => $updated,
                        'skipped' => $skipped,
                    ],
                );
            }

            return response()->json([
                'message' => 'Algorithm results saved for all projects.',
                'updated' => $updated,
                'skipped' => $skipped,
            ]);
        } catch (\Throwable $e) {
            Log::error('Algorithm save failed', ['exception' => $e]);

            return response()->json([
                'message' => 'Unable to save algorithm results.',
                'error' => config('app.debug') ? $e->getMessage() : 'An unexpected error occurred while saving.',
            ], 500);
        } finally {
            EmployeeNames::clearEmployeeCache();
        }
    }
}
