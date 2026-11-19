<?php

namespace App\Services;

use App\Models\SalesToolProjectProposal;
use Throwable;

class ProjectCreatePrefillService
{
    public function __construct(
        private readonly GoogleDriveQuotationsService $googleDriveQuotations,
        private readonly OutlookGraphService $outlook,
        private readonly SalesToolProjectProposeService $salesToolPropose,
    ) {}

    /**
     * Resolve quotation + dates for Create New Project from Drive, Sales Tool, and Outlook.
     *
     * @return array<string, mixed>
     */
    public function lookup(string $query, string $outlookProfile = 'deals'): array
    {
        $query = trim($query);
        if ($query === '') {
            return $this->emptyResult($query);
        }

        $job = $this->leadingJobNumber($query);
        $title = $this->titleWithoutJob($query);

        $driveForms = [];
        try {
            foreach (array_values(array_unique(array_filter([$query, $job !== '' ? $job.' '.$title : '', $job, $title]))) as $needle) {
                foreach ($this->googleDriveQuotations->findQuotationFormsForProject($needle) as $form) {
                    $id = (string) ($form['id'] ?? '');
                    if ($id === '') {
                        continue;
                    }
                    $driveForms[$id] = $form;
                }
            }
        } catch (Throwable $e) {
            report($e);
        }
        $driveForms = array_values($driveForms);

        $stMatch = $this->findSalesToolProposal($job, $query, $title);
        if ($stMatch && (! is_array($stMatch->quotations) || $stMatch->quotations === [])) {
            try {
                $this->salesToolPropose->attachQuotations($stMatch, force: true);
                $stMatch->refresh();
            } catch (Throwable $e) {
                report($e);
            }
        }

        $outlookMatch = null;
        try {
            $outlookMatch = $this->findOutlookProject($query, $job, $title, $outlookProfile);
        } catch (Throwable $e) {
            report($e);
        }

        $quotations = [];
        $seen = [];
        foreach ([
            ...(is_array($stMatch?->quotations) ? $stMatch->quotations : []),
            ...$driveForms,
            ...(is_array($outlookMatch['quotation_forms'] ?? null) ? $outlookMatch['quotation_forms'] : []),
        ] as $file) {
            if (! is_array($file)) {
                continue;
            }
            $sheetTitles = [];
            foreach ($file['sheet_titles'] ?? [] as $title) {
                $title = trim((string) $title);
                if ($title !== '') {
                    $sheetTitles[] = $title;
                }
            }
            $sheetName = (string) ($file['sheet_name'] ?? 'Adjudication - TEMPL');
            $seenKey = ((string) ($file['id'] ?? $file['webViewLink'] ?? $file['web_link'] ?? '')).'|'.mb_strtolower($sheetName);
            if ($seenKey === '|' || isset($seen[$seenKey])) {
                continue;
            }
            $seen[$seenKey] = true;
            $quotations[] = [
                'id' => (string) ($file['id'] ?? ''),
                'name' => (string) ($file['name'] ?? ''),
                'webViewLink' => (string) ($file['webViewLink'] ?? $file['web_link'] ?? ''),
                'mimeType' => (string) ($file['mimeType'] ?? $file['mime_type'] ?? ''),
                'sheet_name' => $sheetName,
                'sheet_titles' => $sheetTitles,
                'format_compatible' => (bool) ($file['format_compatible'] ?? true),
                'has_tasks' => (bool) ($file['has_tasks'] ?? true),
                'is_quotation' => true,
                'is_quotation_form' => (bool) ($file['is_quotation_form'] ?? preg_match('/^quotation\s*form\s*[-–—:]/i', (string) ($file['name'] ?? ''))),
                'source' => ! empty($file['is_quotation_form']) || preg_match('/^quotation\s*form\s*[-–—:]/i', (string) ($file['name'] ?? ''))
                    ? 'google_drive'
                    : (string) ($file['source'] ?? 'google_drive'),
            ];
        }

        $order = is_array($outlookMatch['order_confirmation'] ?? null) ? $outlookMatch['order_confirmation'] : [];
        $docSupply = $this->firstDate([
            $stMatch?->start_date?->toDateString(),
            $order['start_date'] ?? null,
            $order['documentation_arrival'] ?? null,
        ]);
        $completion = $this->firstDate([
            $stMatch?->end_date?->toDateString(),
            $order['completion'] ?? null,
        ]);

        $preferred = $quotations[0] ?? null;
        $sources = array_values(array_filter([
            $stMatch ? 'Sales Tool' : null,
            $driveForms !== [] || ($outlookMatch && ! empty($outlookMatch['has_quotation_form'])) ? 'Drive' : null,
            $outlookMatch && ! empty($outlookMatch['has_order_confirmation']) ? 'Outlook' : null,
        ]));

        $resolvedName = $query;
        if ($stMatch && trim((string) $stMatch->project_name) !== '') {
            $resolvedName = (string) $stMatch->project_name;
        } elseif (is_array($outlookMatch) && trim((string) ($outlookMatch['project_name'] ?? '')) !== '') {
            $resolvedName = (string) $outlookMatch['project_name'];
        }

        return [
            'query' => $query,
            'job_number' => $job !== '' ? $job : ($stMatch?->job_number),
            'name' => $resolvedName,
            'doc_supply' => $docSupply,
            'completion' => $completion,
            'sheet_url' => $preferred['webViewLink'] ?? '',
            'sheet_name' => $preferred['sheet_name'] ?? 'Adjudication - TEMPL',
            'quotations' => $quotations,
            'has_quotation' => $quotations !== [],
            'quotation_count' => count($quotations),
            'sales_tool_proposal_id' => $stMatch?->id,
            'sales_tool' => $stMatch ? [
                'id' => $stMatch->id,
                'job_number' => $stMatch->job_number,
                'project_name' => $stMatch->project_name,
                'client' => $stMatch->client,
                'agreed_cost' => $stMatch->agreed_cost,
                'quoted_hours' => $stMatch->quoted_hours,
                'start_date' => $stMatch->start_date?->toDateString(),
                'end_date' => $stMatch->end_date?->toDateString(),
            ] : null,
            'outlook' => $outlookMatch ? [
                'project_name' => $outlookMatch['project_name'] ?? null,
                'has_order_confirmation' => (bool) ($outlookMatch['has_order_confirmation'] ?? false),
                'has_quotation_form' => (bool) ($outlookMatch['has_quotation_form'] ?? false),
                'order_confirmation' => $order ?: null,
            ] : null,
            'sources' => $sources,
            'autofilled_fields' => array_values(array_filter([
                $docSupply ? 'doc_supply' : null,
                $completion ? 'completion' : null,
                ($preferred['webViewLink'] ?? '') !== '' ? 'sheet_url' : null,
                ($preferred['sheet_name'] ?? '') !== '' && $quotations !== [] ? 'sheet_name' : null,
                $quotations !== [] ? 'quotations' : null,
            ])),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function emptyResult(string $query): array
    {
        return [
            'query' => $query,
            'job_number' => null,
            'name' => $query,
            'doc_supply' => null,
            'completion' => null,
            'sheet_url' => '',
            'sheet_name' => 'Adjudication - TEMPL',
            'quotations' => [],
            'has_quotation' => false,
            'quotation_count' => 0,
            'sales_tool_proposal_id' => null,
            'sales_tool' => null,
            'outlook' => null,
            'sources' => [],
            'autofilled_fields' => [],
        ];
    }

    private function findSalesToolProposal(string $job, string $query, string $title): ?SalesToolProjectProposal
    {
        $pending = SalesToolProjectProposal::query()
            ->pending()
            ->orderByDesc('updated_at')
            ->limit(200)
            ->get();

        $queryLower = mb_strtolower($query);
        $titleLower = mb_strtolower($title);

        foreach ($pending as $row) {
            if ($job !== '' && $this->jobNumbersEqual((string) $row->job_number, $job)) {
                return $row;
            }
        }
        foreach ($pending as $row) {
            $name = mb_strtolower(trim((string) $row->project_name));
            if ($name !== '' && ($name === $queryLower || ($titleLower !== '' && str_contains($name, $titleLower)))) {
                return $row;
            }
        }

        return null;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function findOutlookProject(string $query, string $job, string $title, string $profile): ?array
    {
        @set_time_limit(90);

        $search = $job !== '' ? $job : ($title !== '' ? $title : $query);
        $payload = $this->outlook->listMessages(
            profile: $profile === 'leads' ? 'leads' : 'deals',
            filter: 'order_and_quotations',
            top: 40,
            search: $search,
        );
        $projects = is_array($payload['projects'] ?? null) ? $payload['projects'] : [];
        if ($projects === []) {
            return null;
        }

        $needle = mb_strtolower($this->titleWithoutJob($query));
        $best = null;
        $bestScore = -1;
        foreach ($projects as $project) {
            if (! is_array($project)) {
                continue;
            }
            $name = trim((string) ($project['project_name'] ?? ''));
            $nameLower = mb_strtolower($this->titleWithoutJob($name));
            $score = -1;
            if ($job !== '' && preg_match('/^'.preg_quote($job, '/').'\b/', $name) === 1) {
                $score = 1000;
            } elseif ($nameLower !== '' && $needle !== '' && $nameLower === $needle) {
                $score = 900;
            } elseif ($nameLower !== '' && $needle !== '' && (str_contains($nameLower, $needle) || str_contains($needle, $nameLower))) {
                $score = 700;
            } elseif (! empty($project['has_order_confirmation']) && ! empty($project['has_quotation_form'])) {
                $score = 100;
            }
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $project;
            }
        }

        return $bestScore >= 100 ? $best : null;
    }

    private function leadingJobNumber(string $name): string
    {
        if (preg_match('/^(\d{3,})/', trim($name), $matches) === 1) {
            return $matches[1];
        }

        return '';
    }

    private function titleWithoutJob(string $name): string
    {
        $title = preg_replace('/^\d{3,}\s*[-–—:_]?\s*/u', '', trim($name)) ?? '';

        return trim(preg_replace('/\s+/u', ' ', $title) ?? $title);
    }

    private function jobNumbersEqual(string $a, string $b): bool
    {
        $left = strtoupper(preg_replace('/[\s,]+/', '', $a) ?? '');
        $right = strtoupper(preg_replace('/[\s,]+/', '', $b) ?? '');
        if ($left === '' || $right === '') {
            return false;
        }

        return $left === $right || (ctype_digit($left) && ctype_digit($right) && (int) $left === (int) $right);
    }

    /**
     * @param  list<mixed>  $candidates
     */
    private function firstDate(array $candidates): ?string
    {
        foreach ($candidates as $value) {
            $raw = trim((string) ($value ?? ''));
            if ($raw === '') {
                continue;
            }
            if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $raw, $m)) {
                return $m[1];
            }
            $ts = strtotime($raw);
            if ($ts !== false) {
                return date('Y-m-d', $ts);
            }
        }

        return null;
    }
}
