<?php

namespace App\Services;

use App\Models\SalesToolProjectProposal;
use InvalidArgumentException;
use Throwable;

class SalesToolProjectProposeService
{
    public function __construct(
        private readonly GoogleDriveQuotationsService $googleDriveQuotations,
    ) {}

    public function canonicalJobNumber(mixed $value): string
    {
        $compact = strtoupper(preg_replace('/[\s,]+/', '', (string) $value) ?? '');
        if (preg_match('/^(\d{3,8})[\/\-]?([A-Z])$/', $compact, $m)) {
            return $m[1].$m[2];
        }

        return $compact;
    }

    /**
     * Store or refresh a pending proposal. Does NOT create a WP project.
     *
     * @param  array<string, mixed>  $payload
     * @return array{action: string, proposal: SalesToolProjectProposal}
     */
    public function propose(array $payload): array
    {
        $jobNumber = $this->canonicalJobNumber($payload['job_number'] ?? $payload['jobNumber'] ?? '');
        if ($jobNumber === '' || ! preg_match('/^\d{3,8}[A-Z]?$/', $jobNumber)) {
            throw new InvalidArgumentException('A valid job_number is required.');
        }

        $title = trim((string) ($payload['title'] ?? $payload['name'] ?? ''));
        $projectName = $title !== '' ? $jobNumber.' '.$title : $jobNumber;
        $dealId = trim((string) ($payload['deal_id'] ?? $payload['dealId'] ?? ''));
        $dealId = $dealId !== '' ? $dealId : null;

        $fields = [
            'deal_id' => $dealId,
            'job_number' => $jobNumber,
            'title' => $title !== '' ? $title : null,
            'project_name' => $projectName,
            'client' => $this->nullableString($payload['client'] ?? null),
            'st_status' => $this->nullableString($payload['status'] ?? $payload['st_status'] ?? null),
            'stage' => $this->nullableString($payload['stage'] ?? null),
            'pipeline_id' => $this->nullableString($payload['pipeline_id'] ?? $payload['pipelineId'] ?? null),
            'owner' => $this->nullableString($payload['owner'] ?? null),
            'agreed_cost' => $this->nullableString($payload['agreed_cost'] ?? $payload['agreedCost'] ?? null),
            'value' => $this->nullableString($payload['value'] ?? null),
            'quoted_hours' => $this->nullableString($payload['quoted_hours'] ?? $payload['quotedHours'] ?? null),
            'actual_hours' => $this->nullableString($payload['actual_hours'] ?? $payload['actualHours'] ?? null),
            'start_date' => $this->nullableDate($payload['start_date'] ?? $payload['startDate'] ?? null),
            'end_date' => $this->nullableDate($payload['end_date'] ?? $payload['endDate'] ?? null),
            'delivery_address' => $this->nullableString($payload['delivery_address'] ?? $payload['deliveryAddress'] ?? null),
            'contact_name' => $this->nullableString($payload['contact_name'] ?? $payload['contactName'] ?? null),
            'contact_phone' => $this->nullableString($payload['contact_phone'] ?? $payload['contactPhone'] ?? null),
            'contact_email' => $this->nullableString($payload['contact_email'] ?? $payload['contactEmail'] ?? null),
            'company_phone' => $this->nullableString($payload['company_phone'] ?? $payload['companyPhone'] ?? null),
            'company_email' => $this->nullableString($payload['company_email'] ?? $payload['companyEmail'] ?? null),
            'notes' => $this->nullableString($payload['notes'] ?? null),
            'payload' => $payload,
            'status' => SalesToolProjectProposal::STATUS_PENDING,
            'dismissed_at' => null,
            'accepted_at' => null,
            'created_project_id' => null,
        ];

        $existing = $this->findExisting($dealId, $jobNumber);
        if ($existing) {
            $existing->fill($fields);
            $existing->save();
            $this->attachQuotations($existing, force: false);

            return ['action' => 'updated', 'proposal' => $existing->fresh()];
        }

        $proposal = SalesToolProjectProposal::create($fields);
        $this->attachQuotations($proposal, force: true);

        return ['action' => 'created', 'proposal' => $proposal->fresh()];
    }

    /**
     * Attach matching Drive "Quotation form - {Project}" files (same filter as Outlook awaiting).
     */
    public function attachQuotations(SalesToolProjectProposal $proposal, bool $force = false): SalesToolProjectProposal
    {
        if (
            ! $force
            && $proposal->quotations_checked_at
            && $this->proposalHasQuotationForm($proposal)
        ) {
            return $proposal;
        }

        $queries = array_values(array_unique(array_filter([
            trim((string) $proposal->project_name),
            trim((string) ($proposal->job_number.' '.($proposal->title ?? ''))),
            trim((string) $proposal->job_number),
            trim((string) ($proposal->title ?? '')),
        ])));

        $matched = [];
        $seen = [];

        foreach ($queries as $query) {
            try {
                $files = $this->googleDriveQuotations->findQuotationFormsForProject($query);
            } catch (Throwable $e) {
                report($e);
                continue;
            }

            foreach ($files as $file) {
                $id = (string) ($file['id'] ?? '');
                if ($id === '' || isset($seen[$id])) {
                    continue;
                }
                $seen[$id] = true;
                $matched[] = [
                    'id' => $id,
                    'name' => (string) ($file['name'] ?? ''),
                    'project_name' => (string) ($file['project_name'] ?? ''),
                    'webViewLink' => (string) ($file['webViewLink'] ?? ''),
                    'mimeType' => (string) ($file['mimeType'] ?? ''),
                    'sheet_name' => $file['sheet_name'] ?? 'Adjudication - TEMPL',
                    'sheet_titles' => is_array($file['sheet_titles'] ?? null) ? array_values($file['sheet_titles']) : [],
                    'format_compatible' => true,
                    'has_tasks' => true,
                    'is_quotation' => true,
                    'is_quotation_form' => true,
                    'modifiedTime' => $file['modifiedTime'] ?? null,
                ];
            }
        }

        usort($matched, static function (array $a, array $b) {
            return strcasecmp((string) $a['name'], (string) $b['name']);
        });

        $proposal->quotations = array_values($matched);
        $proposal->quotations_checked_at = now();
        $proposal->save();

        return $proposal;
    }

    /**
     * Refresh Quotation form matches for pending proposals missing a form (or force all).
     *
     * @return array{checked: int, with_files: int}
     */
    public function refreshPendingQuotations(int $limit = 40, bool $force = false): array
    {
        $rows = SalesToolProjectProposal::query()
            ->pending()
            ->orderByDesc('updated_at')
            ->limit($force ? $limit : min(max($limit * 3, $limit), 120))
            ->get();

        if (! $force) {
            $rows = $rows
                ->filter(function (SalesToolProjectProposal $row): bool {
                    return ! $row->quotations_checked_at || ! $this->proposalHasQuotationForm($row);
                })
                ->take($limit)
                ->values();
        }

        $withFiles = 0;
        foreach ($rows as $row) {
            $this->attachQuotations($row, force: true);
            $row->refresh();
            if ($this->proposalHasQuotationForm($row)) {
                $withFiles++;
            }
        }

        return ['checked' => $rows->count(), 'with_files' => $withFiles];
    }

    public function proposalHasQuotationForm(SalesToolProjectProposal $proposal): bool
    {
        $quotations = is_array($proposal->quotations) ? $proposal->quotations : [];
        foreach ($quotations as $file) {
            if (! is_array($file)) {
                continue;
            }
            if (! empty($file['is_quotation_form'])) {
                return true;
            }
            $name = trim((string) ($file['name'] ?? ''));
            if ($name !== '' && preg_match('/^quotation\s*form\s*[-–—:]/i', $name) === 1) {
                return true;
            }
        }

        return false;
    }

    private function findExisting(?string $dealId, string $jobNumber): ?SalesToolProjectProposal
    {
        if ($dealId) {
            $byDeal = SalesToolProjectProposal::query()
                ->where('deal_id', $dealId)
                ->orderByDesc('id')
                ->first();
            if ($byDeal) {
                return $byDeal;
            }
        }

        return SalesToolProjectProposal::query()
            ->pending()
            ->where('job_number', $jobNumber)
            ->orderByDesc('id')
            ->first();
    }

    private function nullableString(mixed $value): ?string
    {
        $trimmed = trim((string) ($value ?? ''));

        return $trimmed !== '' ? $trimmed : null;
    }

    private function nullableDate(mixed $value): ?string
    {
        $raw = trim((string) ($value ?? ''));
        if ($raw === '') {
            return null;
        }
        if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $raw, $m)) {
            return $m[1];
        }

        $ts = strtotime($raw);

        return $ts ? date('Y-m-d', $ts) : null;
    }
}
