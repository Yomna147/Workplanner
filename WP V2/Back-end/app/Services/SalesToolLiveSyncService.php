<?php

namespace App\Services;

use App\Models\Project;
use App\Models\SalesToolProjectProposal;
use Carbon\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Pull eligible CRM deals from the Sales Tool database and upsert WP proposals.
 */
class SalesToolLiveSyncService
{
    /** @var list<string> */
    private const ELIGIBLE_STATUSES = [
        'deal_won',
        'deal_not_invoiced',
        'in_progress',
        'in_progress_not_started',
        'january',
        'february',
        'march',
        'april',
        'may',
        'june',
        'july',
        'august',
        'september',
        'october',
        'november',
        'december',
    ];

    public function __construct(
        private readonly SalesToolProjectProposeService $propose,
    ) {}

    public function isConfigured(): bool
    {
        if (! config('sales_tool.live_sync_enabled', true)) {
            return false;
        }

        try {
            DB::connection('sales_tool')->getPdo();

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    /**
     * @return array{
     *   ok: bool,
     *   synced: int,
     *   created: int,
     *   updated: int,
     *   skipped: int,
     *   failed: int,
     *   error?: string
     * }
     */
    public function syncEligibleDeals(?Carbon $since = null, ?Carbon $until = null, ?int $limit = null): array
    {
        $limit = $limit ?? (int) config('sales_tool.live_sync_limit', 80);
        $since ??= now()->startOfMonth()->startOfDay();
        $until ??= now()->endOfDay();

        if (! $this->isConfigured()) {
            return [
                'ok' => false,
                'synced' => 0,
                'created' => 0,
                'updated' => 0,
                'skipped' => 0,
                'failed' => 0,
                'error' => 'Sales Tool live sync is disabled or the sales_tool DB connection failed.',
            ];
        }

        try {
            $rows = $this->fetchEligibleDealRows();
        } catch (Throwable $exception) {
            Log::warning('Sales Tool live sync failed to read crm_deals', [
                'error' => $exception->getMessage(),
            ]);

            return [
                'ok' => false,
                'synced' => 0,
                'created' => 0,
                'updated' => 0,
                'skipped' => 0,
                'failed' => 0,
                'error' => $exception->getMessage(),
            ];
        }

        $existingProjectJobs = $this->existingProjectJobNumbers();
        $created = 0;
        $updated = 0;
        $skipped = 0;
        $failed = 0;
        $synced = 0;

        foreach ($rows as $row) {
            if ($synced >= $limit) {
                break;
            }

            $payload = $this->rowToProposePayload($row);
            $jobNumber = $this->propose->canonicalJobNumber($payload['job_number'] ?? '');
            if ($jobNumber === '' || ! preg_match('/^\d{3,8}[A-Z]?$/', $jobNumber)) {
                $skipped++;
                continue;
            }

            if (isset($existingProjectJobs[$jobNumber])) {
                $skipped++;
                continue;
            }

            $proposalProbe = new SalesToolProjectProposal([
                'st_status' => $payload['status'] ?? null,
                'start_date' => $payload['start_date'] ?? null,
                'end_date' => $payload['end_date'] ?? null,
                'payload' => [
                    'deal_updated_at' => $payload['deal_updated_at'] ?? null,
                    'deal_created_at' => $payload['deal_created_at'] ?? null,
                    'start_date' => $payload['start_date'] ?? null,
                    'end_date' => $payload['end_date'] ?? null,
                ],
                'updated_at' => isset($row->updated_at) ? Carbon::parse($row->updated_at) : null,
                'created_at' => isset($row->created_at) ? Carbon::parse($row->created_at) : null,
            ]);

            if (! $proposalProbe->isDealTouchedSince($since, $until)) {
                $skipped++;
                continue;
            }

            try {
                $result = $this->propose->propose($payload);
                $synced++;
                if (($result['action'] ?? '') === 'created') {
                    $created++;
                } else {
                    $updated++;
                }
            } catch (Throwable $exception) {
                $failed++;
                Log::warning('Sales Tool live sync propose failed', [
                    'deal_id' => $payload['deal_id'] ?? null,
                    'job_number' => $jobNumber,
                    'error' => $exception->getMessage(),
                ]);
            }
        }

        return [
            'ok' => true,
            'synced' => $synced,
            'created' => $created,
            'updated' => $updated,
            'skipped' => $skipped,
            'failed' => $failed,
        ];
    }

    /**
     * @return list<object>
     */
    private function fetchEligibleDealRows(): array
    {
        $statuses = self::ELIGIBLE_STATUSES;
        $placeholders = implode(',', array_fill(0, count($statuses), '?'));

        $sql = <<<SQL
SELECT
  id,
  status,
  title,
  updated_at,
  created_at,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.jobNumber')) AS job_number,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.client')) AS client,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.owner')) AS owner,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.stage')) AS stage,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.pipelineId')) AS pipeline_id,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.agreedCost')) AS agreed_cost,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.value')) AS value,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.quotedHours')) AS quoted_hours,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.actualHours')) AS actual_hours,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.startDate')) AS start_date,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.endDate')) AS end_date,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.deliveryAddress')) AS delivery_address,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.contactName')) AS contact_name,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.contactPhone')) AS contact_phone,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.contactEmail')) AS contact_email,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.companyPhone')) AS company_phone,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.companyEmail')) AS company_email,
  JSON_UNQUOTE(JSON_EXTRACT(data, '$.notes')) AS notes
FROM crm_deals
WHERE status IN ({$placeholders})
ORDER BY updated_at DESC
LIMIT 500
SQL;

        return DB::connection('sales_tool')->select($sql, $statuses);
    }

    /**
     * @return array<string, true>
     */
    private function existingProjectJobNumbers(): array
    {
        $jobs = [];
        foreach (Project::query()->get(['name']) as $project) {
            $name = trim((string) ($project->name ?? ''));
            if ($name === '') {
                continue;
            }
            if (preg_match('/^(\d{3,8}[A-Za-z]?)/', $name, $match)) {
                $job = $this->propose->canonicalJobNumber($match[1]);
                if ($job !== '') {
                    $jobs[$job] = true;
                }
            }
        }

        return $jobs;
    }

    /**
     * @param  object  $row
     * @return array<string, mixed>
     */
    private function rowToProposePayload(object $row): array
    {
        $start = $this->normalizeDate($row->start_date ?? null);
        $end = $this->normalizeDate($row->end_date ?? null);

        return [
            'deal_id' => (string) ($row->id ?? ''),
            'job_number' => (string) ($row->job_number ?? ''),
            'title' => trim((string) ($row->title ?? '')),
            'client' => $row->client ?? null,
            'status' => $row->status ?? null,
            'stage' => $row->stage ?? null,
            'pipeline_id' => $row->pipeline_id ?? null,
            'owner' => $row->owner ?? null,
            'agreed_cost' => $row->agreed_cost ?? $row->value ?? null,
            'value' => $row->value ?? null,
            'quoted_hours' => $row->quoted_hours ?? null,
            'actual_hours' => $row->actual_hours ?? null,
            'start_date' => $start,
            'end_date' => $end,
            'delivery_address' => $row->delivery_address ?? null,
            'contact_name' => $row->contact_name ?? null,
            'contact_phone' => $row->contact_phone ?? null,
            'contact_email' => $row->contact_email ?? null,
            'company_phone' => $row->company_phone ?? null,
            'company_email' => $row->company_email ?? null,
            'notes' => $row->notes ?? null,
            'deal_updated_at' => isset($row->updated_at) ? (string) $row->updated_at : null,
            'deal_created_at' => isset($row->created_at) ? (string) $row->created_at : null,
        ];
    }

    private function normalizeDate(mixed $value): ?string
    {
        $raw = trim((string) ($value ?? ''));
        if ($raw === '' || strcasecmp($raw, 'null') === 0) {
            return null;
        }

        // ST often stores UK-style dates: 15/10/2026
        if (preg_match('/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/', $raw, $m)) {
            return sprintf('%04d-%02d-%02d', (int) $m[3], (int) $m[2], (int) $m[1]);
        }

        try {
            return Carbon::parse($raw)->toDateString();
        } catch (Throwable) {
            return null;
        }
    }
}
