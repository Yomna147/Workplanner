<?php

namespace App\Services;

use App\Models\Project;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

class OutlookGraphService
{
    private const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

    /** @var array<string, array{token: string, expires_at: int}> */
    private array $tokenCache = [];

    /**
     * @param  'deals'|'leads'  $profile
     * @return array<string, mixed>
     */
    public function profileConfig(string $profile): array
    {
        $key = $profile === 'leads' ? 'leads' : 'deals';
        $config = config("outlook.{$key}");

        return is_array($config) ? $config : [];
    }

    /**
     * @param  'deals'|'leads'  $profile
     */
    public function mailbox(string $profile): string
    {
        return trim((string) ($this->profileConfig($profile)['mailbox'] ?? ''));
    }

    /**
     * @param  'deals'|'leads'  $profile
     * @return array{messages: list<array<string, mixed>>, mailbox: string, filter: string, fetched_at: string, total: int}
     */
    public function listMessages(
        string $profile = 'deals',
        string $filter = 'order_and_quotations',
        int $top = 80,
        ?string $search = null,
    ): array {
        $mailbox = $this->mailbox($profile);
        if ($mailbox === '') {
            throw new RuntimeException('Outlook mailbox is not configured for this profile.');
        }

        $top = max(1, min($top, 100));
        $filter = match ($filter) {
            'all' => 'all',
            'order_confirmation' => 'order_confirmation',
            'quotations' => 'quotations',
            default => 'order_and_quotations',
        };
        $query = trim((string) ($search ?? ''));

        $raw = $this->collectRawMessages($profile, $mailbox, $filter, $top, $query);

        $messages = [];
        $seen = [];
        foreach ($raw as $row) {
            $normalized = $this->normalizeMessage($row);
            $id = (string) ($normalized['id'] ?? '');
            if ($id !== '' && isset($seen[$id])) {
                continue;
            }

            $isOrder = $this->isOrderConfirmationWithProjectInfo($normalized);
            $isQuotation = $this->isQuotationEmail($normalized);
            $normalized['is_order_confirmation'] = $isOrder;
            $normalized['is_quotation'] = false;
            $normalized['has_quotation_file'] = false;
            $normalized['quotation_files'] = [];
            $normalized['quotation_forms'] = [];
            $normalized['has_files'] = (bool) ($normalized['has_attachments'] ?? false);
            $normalized['file_count'] = $normalized['has_files'] ? 1 : 0;

            if ($isOrder) {
                $normalized['parsed'] = $this->parseOrderConfirmation($normalized);
            } elseif ($isQuotation) {
                $normalized['parsed'] = $this->parseQuotation($normalized);
            }

            // Provisional keep; Quotation form matching happens after Drive catalog load.
            if ($filter === 'order_confirmation' && ! $isOrder) {
                continue;
            }
            if ($filter === 'quotations' && ! $isQuotation) {
                continue;
            }
            if ($filter === 'order_and_quotations' && ! $isOrder && ! $isQuotation) {
                continue;
            }

            if ($id !== '') {
                $seen[$id] = true;
            }
            $messages[] = $normalized;
        }

        usort($messages, static function (array $a, array $b): int {
            return strcmp((string) ($b['received_at'] ?? ''), (string) ($a['received_at'] ?? ''));
        });

        if (in_array($filter, ['quotations', 'order_and_quotations'], true)) {
            $messages = $this->attachQuotationFormsFromDrive($messages, $filter);
        } elseif ($filter === 'order_confirmation') {
            // Still try to attach Quotation forms so project cards can show both sides.
            $messages = $this->attachQuotationFormsFromDrive($messages, 'order_and_quotations');
        }

        $projects = $filter === 'all'
            ? []
            : $this->groupMessagesIntoProjects($messages);

        $comparison = $filter === 'all'
            ? [
                'drive_forms' => 0,
                'drive_projects' => 0,
                'matched' => 0,
                'drive_only' => 0,
                'outlook_only' => 0,
                'with_order_confirmation' => 0,
                'in_workplanner' => 0,
                'missing_in_workplanner' => 0,
                'workplanner_projects' => 0,
            ]
            : $this->compareProjectsToDriveForms($projects);

        return [
            'mailbox' => $mailbox,
            'profile' => $profile === 'leads' ? 'leads' : 'deals',
            'filter' => $filter,
            'search' => $query !== '' ? $query : null,
            'total' => count($messages),
            'project_total' => count($comparison['projects'] ?? $projects),
            'messages' => $messages,
            'projects' => $comparison['projects'] ?? $projects,
            'drive_comparison' => [
                'drive_forms' => $comparison['drive_forms'] ?? 0,
                'drive_projects' => $comparison['drive_projects'] ?? 0,
                'matched' => $comparison['matched'] ?? 0,
                'drive_only' => $comparison['drive_only'] ?? 0,
                'outlook_only' => $comparison['outlook_only'] ?? 0,
                'with_order_confirmation' => $comparison['with_order_confirmation'] ?? 0,
                'in_workplanner' => $comparison['in_workplanner'] ?? 0,
                'missing_in_workplanner' => $comparison['missing_in_workplanner'] ?? 0,
                'workplanner_projects' => $comparison['workplanner_projects'] ?? 0,
            ],
            'fetched_at' => now()->toIso8601String(),
        ];
    }

    /**
     * Home-page awaiting-confirmation candidates: Order Confirmation + Quotation form,
     * not already in Work Planner. Shaped like Sales Tool proposals for the Dashboard UI.
     *
     * @param  'deals'|'leads'  $profile
     * @return array{data: list<array<string, mixed>>, meta: array<string, mixed>}
     */
    public function listAwaitingConfirmationCandidates(string $profile = 'deals', int $top = 80): array
    {
        @set_time_limit(120);

        $payload = $this->listMessages(
            profile: $profile,
            filter: 'order_and_quotations',
            top: max(1, min($top, 100)),
            search: null,
        );

        $ttCatalog = $this->loadTimeTrackingProjectCatalog();
        $projects = is_array($payload['projects'] ?? null) ? $payload['projects'] : [];
        $rows = [];
        $ttMatched = 0;
        foreach ($projects as $project) {
            if (! is_array($project)) {
                continue;
            }
            // Order confirmation is enough to list; Quotation form may still be missing.
            if (empty($project['has_order_confirmation'])) {
                continue;
            }
            if (! empty($project['in_workplanner'])) {
                continue;
            }
            $mapped = $this->mapProjectToAwaitingProposal($project, $profile, $ttCatalog['projects']);
            if ($mapped !== null) {
                if (! empty($mapped['job_number'])) {
                    $ttMatched++;
                }
                $rows[] = $mapped;
            }
        }

        usort($rows, static function (array $a, array $b): int {
            return strcmp((string) ($b['updated_at'] ?? ''), (string) ($a['updated_at'] ?? ''));
        });

        return [
            'data' => array_values($rows),
            'meta' => [
                'mailbox' => $payload['mailbox'] ?? null,
                'profile' => $payload['profile'] ?? $profile,
                'scanned_projects' => (int) ($payload['project_total'] ?? count($projects)),
                'awaiting' => count($rows),
                'tt_projects' => $ttCatalog['count'],
                'tt_matched' => $ttMatched,
                'tt_error' => $ttCatalog['error'],
                'drive_comparison' => $payload['drive_comparison'] ?? [],
                'fetched_at' => $payload['fetched_at'] ?? now()->toIso8601String(),
            ],
        ];
    }

    /**
     * @param  array<string, mixed>  $project
     * @param  'deals'|'leads'  $profile
     * @param  list<array{id: string, name: string, job_number: string, title_hint: string}>  $ttProjects
     * @return array<string, mixed>|null
     */
    private function mapProjectToAwaitingProposal(array $project, string $profile, array $ttProjects = []): ?array
    {
        $projectName = trim((string) ($project['project_name'] ?? ''));
        if ($projectName === '') {
            return null;
        }

        $order = is_array($project['order_confirmation'] ?? null) ? $project['order_confirmation'] : [];
        $forms = is_array($project['quotation_forms'] ?? null) ? $project['quotation_forms'] : [];
        $quotations = [];
        foreach ($forms as $form) {
            if (! is_array($form)) {
                continue;
            }
            $quotations[] = [
                'id' => (string) ($form['id'] ?? ''),
                'name' => (string) ($form['name'] ?? ''),
                'webViewLink' => (string) ($form['web_link'] ?? $form['webViewLink'] ?? ''),
                'mimeType' => (string) ($form['mime_type'] ?? $form['mimeType'] ?? ''),
                'sheet_name' => (string) ($form['sheet_name'] ?? 'Adjudication - TEMPL'),
                'sheet_titles' => array_values(array_filter(array_map(
                    static fn ($title) => trim((string) $title),
                    is_array($form['sheet_titles'] ?? null) ? $form['sheet_titles'] : []
                ))),
                'has_tasks' => true,
                'format_compatible' => true,
                'source' => 'google_drive',
            ];
        }

        $preferred = $quotations[0] ?? null;
        $start = $this->normalizeIsoDate($order['start_date'] ?? $order['documentation_arrival'] ?? null);
        $end = $this->normalizeIsoDate($order['completion'] ?? null);
        $cost = $order['cost'] ?? null;
        $costStr = $cost === null || $cost === '' ? null : (string) $cost;
        $id = (string) ($project['id'] ?? ('outlook_'.substr(sha1($projectName), 0, 16)));
        $inOutlook = ! empty($project['in_outlook']) || ! empty($project['has_order_confirmation']);
        $inDrive = ! empty($project['in_drive']) || $forms !== [];

        $ttMatch = $this->findTimeTrackingProject($projectName, $ttProjects);
        $jobNumber = $ttMatch['job_number'] ?? null;
        $displayName = $projectName;
        if (is_array($ttMatch) && ! empty($ttMatch['name'])) {
            $displayName = (string) $ttMatch['name'];
        } elseif ($jobNumber !== null && $jobNumber !== '' && ! preg_match('/^\d{3,}/', $projectName)) {
            $displayName = trim($jobNumber.' '.$projectName);
        }

        $sourceTags = [];
        if ($inOutlook) {
            $sourceTags[] = ['key' => 'outlook', 'label' => 'Outlook'];
        }
        if ($inDrive) {
            $sourceTags[] = ['key' => 'drive', 'label' => 'Drive'];
        }
        if ($jobNumber !== null && $jobNumber !== '') {
            $sourceTags[] = ['key' => 'tt', 'label' => 'TT'];
        }
        if ($sourceTags === []) {
            $sourceTags[] = ['key' => 'outlook', 'label' => 'Outlook'];
        }

        $sourceKey = implode('+', array_column($sourceTags, 'key'));
        $sourceLabel = implode(' + ', array_column($sourceTags, 'label'));

        $description = $this->buildOutlookAwaitingDescription($project, $order, $profile, $ttMatch);
        $hrefParams = http_build_query(array_filter([
            'newProject' => '1',
            'name' => $displayName,
            'doc_supply' => $start,
            'completion' => $end,
            'sheet_url' => $preferred['webViewLink'] ?? null,
            'sheet_name' => $preferred['sheet_name'] ?? null,
            'description' => $description,
        ], static fn ($value) => $value !== null && $value !== ''));

        $prefill = [
            'name' => $displayName,
            'color' => '#6b7280',
            'status' => 'active',
            'part_name' => 'Main',
            'pp' => '',
            'doc_supply' => $start ?: now()->startOfMonth()->toDateString(),
            'completion' => $end ?: now()->endOfMonth()->toDateString(),
            'description' => $description,
            'sheet_url' => $preferred['webViewLink'] ?? '',
            'sheet_name' => $preferred['sheet_name'] ?? 'Adjudication - TEMPL',
            'quotation_file_id' => $preferred['id'] ?? null,
            'quotations' => $quotations,
            'has_quotation' => $quotations !== [],
            'tasks' => [
                [
                    'task_name' => 'Main',
                    'est' => '',
                    'dl' => '',
                    'plan' => '',
                    'rap' => '',
                    'pp' => '',
                    'pri' => '',
                    'doc_supply' => $start ?: now()->startOfMonth()->toDateString(),
                    'completion' => $end ?: now()->endOfMonth()->toDateString(),
                ],
            ],
        ];

        return [
            'id' => 'outlook:'.$id,
            'source' => $sourceKey,
            'source_label' => $sourceLabel,
            'source_tags' => $sourceTags,
            'deal_id' => null,
            'job_number' => $jobNumber,
            'title' => $displayName,
            'project_name' => $displayName,
            'client' => null,
            'st_status' => null,
            'stage' => null,
            'pipeline_id' => null,
            'owner' => null,
            'agreed_cost' => $costStr,
            'value' => $costStr,
            'quoted_hours' => null,
            'actual_hours' => null,
            'start_date' => $start,
            'end_date' => $end,
            'delivery_address' => null,
            'contact_name' => null,
            'contact_phone' => null,
            'contact_email' => null,
            'company_phone' => null,
            'company_email' => null,
            'notes' => null,
            'status' => 'pending',
            'created_project_id' => null,
            'quotations' => $quotations,
            'quotations_checked_at' => now()->toIso8601String(),
            'has_quotation' => $quotations !== [],
            'quotation_count' => count($quotations),
            'created_at' => $project['latest_received_at'] ?? now()->toIso8601String(),
            'updated_at' => $project['latest_received_at'] ?? now()->toIso8601String(),
            'prefill' => $prefill,
            'description' => $prefill['description'],
            'href' => '/projects?'.$hrefParams,
            'dismissible' => false,
            'outlook_project_id' => $id,
            'has_order_confirmation' => true,
            'order_confirmation' => $order !== [] ? $order : null,
            'match_status' => (string) ($project['match_status'] ?? ''),
            'profile' => $profile === 'leads' ? 'leads' : 'deals',
            'tt_match' => $ttMatch,
        ];
    }

    /**
     * @param  array<string, mixed>  $project
     * @param  array<string, mixed>  $order
     * @param  array{id: string, name: string, job_number: string, title_hint: string}|null  $ttMatch
     */
    private function buildOutlookAwaitingDescription(array $project, array $order, string $profile, ?array $ttMatch = null): string
    {
        $parts = ['Source: Outlook Order Confirmation + Google Drive Quotation form'];
        $parts[] = 'Mailbox profile: '.($profile === 'leads' ? 'leads' : 'deals');
        if (is_array($ttMatch) && ! empty($ttMatch['job_number'])) {
            $parts[] = 'TT job: '.$ttMatch['job_number'];
            if (! empty($ttMatch['name'])) {
                $parts[] = 'TT project: '.$ttMatch['name'];
            }
        }
        if (! empty($order['cost'])) {
            $parts[] = 'Cost: '.$order['cost'];
        }
        foreach (['documentation_arrival' => 'Docs', 'start_date' => 'Start', 'completion' => 'Completion'] as $field => $label) {
            if (! empty($order[$field])) {
                $parts[] = $label.': '.$order[$field];
            }
        }
        $emailSubject = trim((string) ($order['email']['subject'] ?? ''));
        if ($emailSubject !== '') {
            $parts[] = 'OC subject: '.$emailSubject;
        }
        $emailCount = (int) ($project['email_count'] ?? 0);
        if ($emailCount > 0) {
            $parts[] = 'Related emails: '.$emailCount;
        }

        return implode(' | ', $parts);
    }

    /**
     * @return array{projects: list<array{id: string, name: string, job_number: string, title_hint: string}>, count: int, error: string|null}
     */
    private function loadTimeTrackingProjectCatalog(): array
    {
        try {
            $tt = app(TimeTrackingService::class);
            $token = $tt->loginWithServiceAccount();
            $raw = $tt->getProjectList($token);
            $list = [];
            if (is_array($raw)) {
                if (array_is_list($raw)) {
                    $list = $raw;
                } elseif (isset($raw['data']) && is_array($raw['data'])) {
                    $list = $raw['data'];
                } elseif (isset($raw['projects']) && is_array($raw['projects'])) {
                    $list = $raw['projects'];
                } elseif (isset($raw['project']) && is_array($raw['project'])) {
                    $list = $raw['project'];
                }
            }

            $projects = [];
            $seen = [];
            foreach ($list as $row) {
                if (! is_array($row)) {
                    continue;
                }
                $name = trim((string) ($row['name'] ?? $row['Name'] ?? $row['projectName'] ?? $row['ProjectName'] ?? ''));
                if ($name === '') {
                    continue;
                }
                $job = $this->extractLeadingJobNumber($name);
                if ($job === '') {
                    continue;
                }
                $key = strtolower($name);
                if (isset($seen[$key])) {
                    continue;
                }
                $seen[$key] = true;
                $title = preg_replace('/^\d{3,}\s*[-–—:_]?\s*/u', '', $name) ?? $name;
                $projects[] = [
                    'id' => (string) ($row['id'] ?? $row['projectId'] ?? $row['Id'] ?? $name),
                    'name' => $name,
                    'job_number' => $job,
                    'title_hint' => $this->normalizeProjectHint($title),
                ];
            }

            return [
                'projects' => $projects,
                'count' => count($projects),
                'error' => null,
            ];
        } catch (Throwable $e) {
            report($e);

            return [
                'projects' => [],
                'count' => 0,
                'error' => $e->getMessage(),
            ];
        }
    }

    /**
     * @param  list<array{id: string, name: string, job_number: string, title_hint: string}>  $ttProjects
     * @return array{id: string, name: string, job_number: string, title_hint: string}|null
     */
    private function findTimeTrackingProject(string $projectName, array $ttProjects): ?array
    {
        if ($ttProjects === []) {
            return null;
        }

        $needleJob = $this->extractLeadingJobNumber($projectName);
        $needleTitle = preg_replace('/^\d{3,}\s*[-–—:_]?\s*/u', '', $projectName) ?? $projectName;
        $needle = $this->normalizeProjectHint($needleTitle);
        if ($needle === '' && $needleJob === '') {
            return null;
        }

        $best = null;
        $bestScore = -1;
        foreach ($ttProjects as $tt) {
            $score = -1;
            $ttJob = (string) ($tt['job_number'] ?? '');
            $ttHint = (string) ($tt['title_hint'] ?? '');

            if ($needleJob !== '' && $ttJob === $needleJob) {
                $score = 1000;
            } elseif ($ttHint !== '' && $needle !== '') {
                if ($ttHint === $needle) {
                    $score = 900;
                } elseif (str_contains($ttHint, $needle) || str_contains($needle, $ttHint)) {
                    $score = 700;
                } elseif ($this->projectHintsShareTokens($ttHint, $needle)) {
                    $score = 400;
                    $extraA = array_values(array_diff(
                        $this->distinctiveProjectTokens($ttHint),
                        $this->distinctiveProjectTokens($needle)
                    ));
                    $extraB = array_values(array_diff(
                        $this->distinctiveProjectTokens($needle),
                        $this->distinctiveProjectTokens($ttHint)
                    ));
                    if ($extraA !== [] && $extraB !== []) {
                        $score = -1;
                    }
                }
            }

            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $tt;
            }
        }

        return $bestScore >= 400 ? $best : null;
    }

    private function extractLeadingJobNumber(string $name): string
    {
        if (preg_match('/^(\d{3,})/', trim($name), $matches) === 1) {
            return $matches[1];
        }

        return '';
    }

    private function normalizeIsoDate(mixed $value): ?string
    {
        $raw = trim((string) ($value ?? ''));
        if ($raw === '') {
            return null;
        }
        if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $raw, $m)) {
            return $m[1];
        }
        $ts = strtotime($raw);
        if ($ts === false) {
            return null;
        }

        return date('Y-m-d', $ts);
    }

    /**
     * Compare Outlook-collected projects against Drive "Quotation form - {Project}" packs.
     * Drive is the baseline: matched, Drive-only, and Outlook-only rows are all returned.
     *
     * @param  list<array<string, mixed>>  $outlookProjects
     * @return array{
     *   projects: list<array<string, mixed>>,
     *   drive_forms: int,
     *   drive_projects: int,
     *   matched: int,
     *   drive_only: int,
     *   outlook_only: int,
     *   with_order_confirmation: int
     * }
     */
    private function compareProjectsToDriveForms(array $outlookProjects): array
    {
        try {
            $forms = app(GoogleDriveQuotationsService::class)->listQuotationForms();
        } catch (Throwable $e) {
            report($e);
            $forms = [];
        }

        // Collapse Drive files to one row per project and one preferred Quotation form file.
        $driveByProject = [];
        foreach ($forms as $form) {
            $projectName = trim((string) ($form['project_name'] ?? ''));
            $norm = $this->normalizeProjectHint($projectName);
            if ($norm === '') {
                continue;
            }

            $entry = [
                'id' => (string) ($form['id'] ?? ''),
                'name' => (string) ($form['name'] ?? ''),
                'project_name' => $projectName,
                'web_link' => (string) ($form['webViewLink'] ?? ''),
                'mime_type' => (string) ($form['mimeType'] ?? ''),
                'sheet_name' => (string) ($form['sheet_name'] ?? 'Adjudication - TEMPL'),
                'sheet_titles' => is_array($form['sheet_titles'] ?? null) ? array_values($form['sheet_titles']) : [],
                'source' => 'google_drive',
            ];

            if (! isset($driveByProject[$norm])) {
                $driveByProject[$norm] = [
                    'project_key' => $norm,
                    'project_name' => $projectName,
                    'forms' => [$entry],
                ];
                continue;
            }

            $driveByProject[$norm]['forms'][] = $entry;
            $driveByProject[$norm]['forms'] = $this->dedupeQuotationForms($driveByProject[$norm]['forms']);
            $preferred = $driveByProject[$norm]['forms'][0] ?? $entry;
            $driveByProject[$norm]['project_name'] = (string) ($preferred['project_name'] ?? $projectName);
        }

        $usedOutlook = [];
        $projects = [];
        $matched = 0;
        $driveOnly = 0;
        $withOrder = 0;

        foreach ($driveByProject as $norm => $driveProject) {
            $outlookIndex = null;
            $bestScore = -1;
            foreach ($outlookProjects as $i => $outlook) {
                if (isset($usedOutlook[$i])) {
                    continue;
                }
                $outlookKey = $this->normalizeProjectHint((string) ($outlook['project_name'] ?? ''));
                if ($outlookKey === '') {
                    continue;
                }
                $score = -1;
                if ($outlookKey === $norm) {
                    $score = 1000;
                } elseif (str_starts_with($outlookKey, $norm) || str_starts_with($norm, $outlookKey)) {
                    $score = 700;
                } elseif ($this->projectHintsShareTokens($outlookKey, $norm)) {
                    $score = 300;
                    $extraA = array_values(array_diff($this->distinctiveProjectTokens($outlookKey), $this->distinctiveProjectTokens($norm)));
                    $extraB = array_values(array_diff($this->distinctiveProjectTokens($norm), $this->distinctiveProjectTokens($outlookKey)));
                    if ($extraA !== [] && $extraB !== []) {
                        $score = -1; // sibling jobs that only share a place name
                    }
                }
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $outlookIndex = $i;
                }
            }
            if ($bestScore < 0) {
                $outlookIndex = null;
            }

            if ($outlookIndex === null) {
                $driveOnly++;
                $projects[] = [
                    'id' => 'drive_'.substr(sha1($norm), 0, 16),
                    'project_name' => (string) $driveProject['project_name'],
                    'has_order_confirmation' => false,
                    'has_quotation_form' => true,
                    'match_status' => 'drive_only',
                    'in_drive' => true,
                    'in_outlook' => false,
                    'order_confirmation' => null,
                    'quotation_forms' => $this->dedupeQuotationForms($driveProject['forms']),
                    'emails' => [],
                    'email_count' => 0,
                    'latest_received_at' => null,
                ];
                continue;
            }

            $usedOutlook[$outlookIndex] = true;
            $matched++;
            $outlook = $outlookProjects[$outlookIndex];

            $projectName = (string) ($driveProject['project_name'] ?: ($outlook['project_name'] ?? ''));
            $formsMerged = $this->formsForProject(
                $projectName,
                array_merge(
                    $driveProject['forms'],
                    is_array($outlook['quotation_forms'] ?? null) ? $outlook['quotation_forms'] : []
                )
            );
            $emails = $this->dedupeProjectEmails(is_array($outlook['emails'] ?? null) ? $outlook['emails'] : []);

            $hasOrder = (bool) ($outlook['has_order_confirmation'] ?? false);
            if ($hasOrder) {
                $withOrder++;
            }

            $projects[] = [
                'id' => (string) ($outlook['id'] ?? ('match_'.substr(sha1($norm), 0, 16))),
                'project_name' => $projectName,
                'has_order_confirmation' => $hasOrder,
                'has_quotation_form' => $formsMerged !== [],
                'match_status' => 'matched',
                'in_drive' => true,
                'in_outlook' => true,
                'order_confirmation' => $outlook['order_confirmation'] ?? null,
                'quotation_forms' => $formsMerged,
                'emails' => $emails,
                'email_count' => count($emails),
                'latest_received_at' => $outlook['latest_received_at'] ?? null,
            ];
        }

        $outlookOnly = 0;
        foreach ($outlookProjects as $i => $outlook) {
            if (isset($usedOutlook[$i])) {
                continue;
            }
            $outlookOnly++;
            if (! empty($outlook['has_order_confirmation'])) {
                $withOrder++;
            }
            $emails = $this->dedupeProjectEmails(is_array($outlook['emails'] ?? null) ? $outlook['emails'] : []);
            $projectName = (string) ($outlook['project_name'] ?? '');
            $formsOnly = $this->formsForProject(
                $projectName,
                is_array($outlook['quotation_forms'] ?? null) ? $outlook['quotation_forms'] : []
            );
            $projects[] = [
                ...$outlook,
                'match_status' => 'outlook_only',
                'in_drive' => false,
                'in_outlook' => true,
                'quotation_forms' => $formsOnly,
                'emails' => $emails,
                'email_count' => count($emails),
                'has_quotation_form' => $formsOnly !== [],
            ];
        }

        $projects = $this->dedupeProjectRows($projects);
        $wpMeta = $this->annotateProjectsWithWorkplanner($projects);
        $projects = $wpMeta['projects'];

        usort($projects, static function (array $a, array $b): int {
            // Missing WP projects first — that's usually what people want to act on.
            $aMissing = empty($a['in_workplanner']) ? 0 : 1;
            $bMissing = empty($b['in_workplanner']) ? 0 : 1;
            if ($aMissing !== $bMissing) {
                return $aMissing <=> $bMissing;
            }
            $rank = static function (array $row): int {
                return match ($row['match_status'] ?? '') {
                    'matched' => 0,
                    'outlook_only' => 1,
                    default => 2,
                };
            };
            $ra = $rank($a);
            $rb = $rank($b);
            if ($ra !== $rb) {
                return $ra <=> $rb;
            }
            $aComplete = ((int) ($a['has_order_confirmation'] ?? false)) + ((int) ($a['has_quotation_form'] ?? false));
            $bComplete = ((int) ($b['has_order_confirmation'] ?? false)) + ((int) ($b['has_quotation_form'] ?? false));
            if ($aComplete !== $bComplete) {
                return $bComplete <=> $aComplete;
            }

            return strcasecmp((string) ($a['project_name'] ?? ''), (string) ($b['project_name'] ?? ''));
        });

        $matched = 0;
        $driveOnly = 0;
        $outlookOnly = 0;
        $withOrder = 0;
        foreach ($projects as $row) {
            $status = (string) ($row['match_status'] ?? '');
            if ($status === 'matched') {
                $matched++;
            } elseif ($status === 'drive_only') {
                $driveOnly++;
            } elseif ($status === 'outlook_only') {
                $outlookOnly++;
            }
            if (! empty($row['has_order_confirmation'])) {
                $withOrder++;
            }
        }

        return [
            'projects' => array_values($projects),
            'drive_forms' => count($forms),
            'drive_projects' => count($driveByProject),
            'matched' => $matched,
            'drive_only' => $driveOnly,
            'outlook_only' => $outlookOnly,
            'with_order_confirmation' => $withOrder,
            'in_workplanner' => $wpMeta['in_workplanner'],
            'missing_in_workplanner' => $wpMeta['missing_in_workplanner'],
            'workplanner_projects' => $wpMeta['workplanner_projects'],
        ];
    }

    /**
     * Mark each quotation/email project as present or missing in Work Planner projects.
     *
     * @param  list<array<string, mixed>>  $projects
     * @return array{
     *   projects: list<array<string, mixed>>,
     *   in_workplanner: int,
     *   missing_in_workplanner: int,
     *   workplanner_projects: int
     * }
     */
    private function annotateProjectsWithWorkplanner(array $projects): array
    {
        $wpProjects = Project::query()
            ->select(['id', 'name', 'status'])
            ->orderBy('name')
            ->get()
            ->map(static fn (Project $project): array => [
                'id' => (int) $project->id,
                'name' => (string) $project->name,
                'status' => (string) ($project->status ?? ''),
            ])
            ->all();

        $inWp = 0;
        $missing = 0;
        foreach ($projects as &$project) {
            $match = $this->findWorkplannerProject(
                (string) ($project['project_name'] ?? ''),
                $wpProjects
            );
            if ($match !== null) {
                $project['in_workplanner'] = true;
                $project['workplanner_project'] = $match;
                $inWp++;
            } else {
                $project['in_workplanner'] = false;
                $project['workplanner_project'] = null;
                $missing++;
            }
        }
        unset($project);

        return [
            'projects' => $projects,
            'in_workplanner' => $inWp,
            'missing_in_workplanner' => $missing,
            'workplanner_projects' => count($wpProjects),
        ];
    }

    /**
     * @param  list<array{id: int, name: string, status: string}>  $wpProjects
     * @return array{id: int, name: string, status: string}|null
     */
    private function findWorkplannerProject(string $projectName, array $wpProjects): ?array
    {
        $needle = $this->normalizeProjectHint($projectName);
        if ($needle === '') {
            return null;
        }

        $best = null;
        $bestScore = -1;
        foreach ($wpProjects as $wp) {
            $hay = $this->normalizeProjectHint((string) ($wp['name'] ?? ''));
            if ($hay === '') {
                continue;
            }

            $score = -1;
            if ($hay === $needle) {
                $score = 1000;
            } elseif (str_contains($hay, $needle) || str_contains($needle, $hay)) {
                $score = 700;
            } elseif ($this->projectHintsShareTokens($hay, $needle)) {
                $score = 300;
                $extraA = array_values(array_diff($this->distinctiveProjectTokens($hay), $this->distinctiveProjectTokens($needle)));
                $extraB = array_values(array_diff($this->distinctiveProjectTokens($needle), $this->distinctiveProjectTokens($hay)));
                if ($extraA !== [] && $extraB !== []) {
                    $score = -1;
                }
            }

            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $wp;
            }
        }

        return $bestScore >= 300 ? $best : null;
    }

    /**
     * Collapse multiple emails for the same job into one project card with
     * Order Confirmation fields + Quotation form links.
     *
     * @param  list<array<string, mixed>>  $messages
     * @return list<array<string, mixed>>
     */
    private function groupMessagesIntoProjects(array $messages): array
    {
        /** @var list<array<string, mixed>> $projects */
        $projects = [];

        foreach ($messages as $message) {
            $name = $this->projectDisplayName($message);
            $norm = $this->normalizeProjectHint($name);
            if ($norm === '') {
                continue;
            }

            $index = null;
            foreach ($projects as $i => $existing) {
                $existingNorm = (string) ($existing['project_key'] ?? '');
                if ($existingNorm === $norm
                    || $this->projectHintsShareTokens($existingNorm, $norm)) {
                    $index = $i;
                    break;
                }
            }

            if ($index === null) {
                $projects[] = $this->emptyProjectSummary($name, $norm);
                $index = count($projects) - 1;
            }

            $projects[$index] = $this->mergeMessageIntoProject($projects[$index], $message);
        }

        // Collapse any remaining near-duplicate project groups (e.g. Haileybury School / Turnford).
        $projects = $this->collapseSimilarOutlookProjects($projects);

        usort($projects, static function (array $a, array $b): int {
            $aComplete = ((int) ($a['has_order_confirmation'] ?? false)) + ((int) ($a['has_quotation_form'] ?? false));
            $bComplete = ((int) ($b['has_order_confirmation'] ?? false)) + ((int) ($b['has_quotation_form'] ?? false));
            if ($aComplete !== $bComplete) {
                return $bComplete <=> $aComplete;
            }

            return strcmp((string) ($b['latest_received_at'] ?? ''), (string) ($a['latest_received_at'] ?? ''));
        });

        return array_values(array_map(function (array $project): array {
            $projectName = (string) ($project['project_name'] ?? '');
            $project['quotation_forms'] = $this->formsForProject(
                $projectName,
                is_array($project['quotation_forms'] ?? null) ? $project['quotation_forms'] : []
            );
            $project['emails'] = $this->dedupeProjectEmails(
                is_array($project['emails'] ?? null) ? $project['emails'] : []
            );
            $project['email_count'] = count($project['emails']);
            $project['has_quotation_form'] = $project['quotation_forms'] !== [];
            unset($project['project_key']);

            return $project;
        }, $projects));
    }

    /**
     * @param  array<string, mixed>  $message
     */
    private function projectDisplayName(array $message): string
    {
        $forms = $message['quotation_forms'] ?? [];
        if (is_array($forms) && $forms !== []) {
            $fromForm = trim((string) ($forms[0]['project_name'] ?? ''));
            if ($fromForm !== '') {
                return $fromForm;
            }
        }

        $parsed = trim((string) ($message['parsed']['project_name'] ?? ''));
        if ($parsed !== '') {
            return $parsed;
        }

        $subject = trim((string) ($message['subject'] ?? ''));
        $subject = preg_replace('/^\s*(?:re|fw|fwd)\s*:\s*/i', '', $subject) ?? $subject;
        $subject = preg_replace('/\s*-\s*(?:bills?\s+of\s+quantities\s*-?\s*)?(?:provisional\s+|revised\s+)?fee\s+quotations?\s*$/i', '', $subject) ?? $subject;
        $subject = preg_replace('/\s*-\s*order\s+confirmation\s*$/i', '', $subject) ?? $subject;

        return trim($subject);
    }

    /**
     * @return array<string, mixed>
     */
    private function emptyProjectSummary(string $name, string $norm): array
    {
        return [
            'id' => 'proj_'.substr(sha1($norm), 0, 16),
            'project_key' => $norm,
            'project_name' => $name,
            'has_order_confirmation' => false,
            'has_quotation_form' => false,
            'order_confirmation' => null,
            'quotation_forms' => [],
            'emails' => [],
            'email_count' => 0,
            'latest_received_at' => null,
        ];
    }

    /**
     * @param  array<string, mixed>  $project
     * @param  array<string, mixed>  $message
     * @return array<string, mixed>
     */
    private function mergeMessageIntoProject(array $project, array $message): array
    {
        $received = (string) ($message['received_at'] ?? '');
        if ($received !== '' && ($project['latest_received_at'] === null || strcmp($received, (string) $project['latest_received_at']) > 0)) {
            $project['latest_received_at'] = $received;
        }

        // Prefer Quotation form project title when available.
        $forms = is_array($message['quotation_forms'] ?? null) ? $message['quotation_forms'] : [];
        if ($forms !== []) {
            $formName = trim((string) ($forms[0]['project_name'] ?? ''));
            if ($formName !== '') {
                $project['project_name'] = $formName;
            }
            foreach ($forms as $form) {
                $formId = (string) ($form['id'] ?? $form['name'] ?? '');
                if ($formId === '') {
                    continue;
                }
                $exists = false;
                foreach ($project['quotation_forms'] as $existing) {
                    if ((string) ($existing['id'] ?? $existing['name'] ?? '') === $formId) {
                        $exists = true;
                        break;
                    }
                }
                if (! $exists) {
                    $project['quotation_forms'][] = $form;
                }
            }
            $project['has_quotation_form'] = $project['quotation_forms'] !== [];
        }

        if (! empty($message['is_order_confirmation'])) {
            $parsed = is_array($message['parsed'] ?? null) ? $message['parsed'] : [];
            $incoming = [
                'project_name' => (string) ($parsed['project_name'] ?? $project['project_name']),
                'cost' => $parsed['cost'] ?? null,
                'documentation_arrival' => $parsed['documentation_arrival'] ?? null,
                'start_date' => $parsed['start_date'] ?? null,
                'completion' => $parsed['completion'] ?? null,
                'email' => [
                    'id' => (string) ($message['id'] ?? ''),
                    'subject' => (string) ($message['subject'] ?? ''),
                    'from' => (string) ($message['from'] ?? ''),
                    'received_at' => $received,
                    'web_link' => (string) ($message['web_link'] ?? ''),
                    'preview' => (string) ($message['preview'] ?? ''),
                ],
            ];

            $current = is_array($project['order_confirmation'] ?? null) ? $project['order_confirmation'] : null;
            $currentReceived = (string) ($current['email']['received_at'] ?? '');
            $shouldReplace = $current === null
                || ($received !== '' && strcmp($received, $currentReceived) > 0)
                || $this->orderConfirmationScore($incoming) > $this->orderConfirmationScore($current ?? []);

            if ($shouldReplace) {
                // Keep richer fields from either side.
                if (is_array($current)) {
                    foreach (['cost', 'documentation_arrival', 'start_date', 'completion'] as $field) {
                        if (($incoming[$field] ?? null) === null || $incoming[$field] === '') {
                            $incoming[$field] = $current[$field] ?? null;
                        }
                    }
                }
                $project['order_confirmation'] = $incoming;
                if (! empty($incoming['project_name']) && empty($forms)) {
                    $project['project_name'] = (string) $incoming['project_name'];
                }
            } elseif (is_array($current)) {
                foreach (['cost', 'documentation_arrival', 'start_date', 'completion'] as $field) {
                    if (($current[$field] ?? null) === null || $current[$field] === '') {
                        $current[$field] = $incoming[$field] ?? null;
                    }
                }
                $project['order_confirmation'] = $current;
            }
            $project['has_order_confirmation'] = true;
        }

        $project['emails'][] = [
            'id' => (string) ($message['id'] ?? ''),
            'subject' => (string) ($message['subject'] ?? ''),
            'from' => (string) ($message['from'] ?? ''),
            'received_at' => $received,
            'web_link' => (string) ($message['web_link'] ?? ''),
            'is_order_confirmation' => (bool) ($message['is_order_confirmation'] ?? false),
            'is_quotation' => (bool) ($message['is_quotation'] ?? false),
        ];
        $project['emails'] = $this->dedupeProjectEmails($project['emails']);
        $project['quotation_forms'] = $this->dedupeQuotationForms(
            is_array($project['quotation_forms'] ?? null) ? $project['quotation_forms'] : []
        );
        $project['email_count'] = count($project['emails']);
        $project['has_quotation_form'] = $project['quotation_forms'] !== [];

        return $project;
    }

    /**
     * Keep one Quotation form per project: prefer Google Sheet, then non-.xlsx name.
     *
     * @param  list<array<string, mixed>>  $forms
     * @return list<array<string, mixed>>
     */
    private function dedupeQuotationForms(array $forms): array
    {
        $byProject = [];
        foreach ($forms as $form) {
            if (! is_array($form)) {
                continue;
            }
            $project = trim((string) ($form['project_name'] ?? ''));
            if ($project === '') {
                $project = preg_replace('/^quotation\s*form\s*[-–—:]\s*/i', '', (string) ($form['name'] ?? '')) ?? '';
                $project = preg_replace('/\.xlsx?$/i', '', $project) ?? $project;
                $project = trim($project);
            }
            $key = $this->normalizeProjectHint($project !== '' ? $project : (string) ($form['id'] ?? $form['name'] ?? ''));
            if ($key === '') {
                continue;
            }

            $candidate = $form;
            $candidate['project_name'] = $project !== '' ? $project : (string) ($form['project_name'] ?? '');

            if (! isset($byProject[$key]) || $this->quotationFormPreferenceScore($candidate) > $this->quotationFormPreferenceScore($byProject[$key])) {
                $byProject[$key] = $candidate;
            }
        }

        return array_values($byProject);
    }

    /**
     * @param  array<string, mixed>  $form
     */
    private function quotationFormPreferenceScore(array $form): int
    {
        $score = 0;
        $mime = strtolower((string) ($form['mime_type'] ?? $form['mimeType'] ?? ''));
        $name = strtolower((string) ($form['name'] ?? ''));
        if (str_contains($mime, 'google-apps.spreadsheet')) {
            $score += 100;
        }
        if (! str_ends_with($name, '.xlsx') && ! str_ends_with($name, '.xls')) {
            $score += 40;
        }
        if (str_contains($name, 'quotation form')) {
            $score += 10;
        }
        if (! empty($form['web_link']) || ! empty($form['webViewLink'])) {
            $score += 5;
        }

        return $score;
    }

    /**
     * Deduplicate thread noise: same subject (ignoring Re:/FW:) keeps the newest email.
     *
     * @param  list<array<string, mixed>>  $emails
     * @return list<array<string, mixed>>
     */
    private function dedupeProjectEmails(array $emails): array
    {
        $bySubject = [];
        foreach ($emails as $email) {
            if (! is_array($email)) {
                continue;
            }
            $subject = trim((string) ($email['subject'] ?? ''));
            $norm = mb_strtolower(preg_replace('/^\s*(?:re|fw|fwd)\s*:\s*/i', '', $subject) ?? $subject);
            $norm = preg_replace('/\s+/', ' ', $norm) ?? $norm;
            $key = $norm !== '' ? $norm : ('id:'.(string) ($email['id'] ?? uniqid('email_', true)));

            $existing = $bySubject[$key] ?? null;
            if ($existing === null) {
                $bySubject[$key] = $email;
                continue;
            }

            $incomingReceived = (string) ($email['received_at'] ?? '');
            $existingReceived = (string) ($existing['received_at'] ?? '');
            $incomingBetter = $incomingReceived !== '' && strcmp($incomingReceived, $existingReceived) > 0;
            if ($incomingBetter) {
                // Preserve useful flags from either copy.
                $email['is_order_confirmation'] = ! empty($email['is_order_confirmation']) || ! empty($existing['is_order_confirmation']);
                $email['is_quotation'] = ! empty($email['is_quotation']) || ! empty($existing['is_quotation']);
                $bySubject[$key] = $email;
            } else {
                $existing['is_order_confirmation'] = ! empty($existing['is_order_confirmation']) || ! empty($email['is_order_confirmation']);
                $existing['is_quotation'] = ! empty($existing['is_quotation']) || ! empty($email['is_quotation']);
                $bySubject[$key] = $existing;
            }
        }

        $rows = array_values($bySubject);
        usort($rows, static function (array $a, array $b): int {
            return strcmp((string) ($b['received_at'] ?? ''), (string) ($a['received_at'] ?? ''));
        });

        return $rows;
    }

    /**
     * @param  list<array<string, mixed>>  $projects
     * @return list<array<string, mixed>>
     */
    private function collapseSimilarOutlookProjects(array $projects): array
    {
        $collapsed = [];
        foreach ($projects as $project) {
            $norm = (string) ($project['project_key'] ?? $this->normalizeProjectHint((string) ($project['project_name'] ?? '')));
            $index = null;
            foreach ($collapsed as $i => $existing) {
                $existingNorm = (string) ($existing['project_key'] ?? $this->normalizeProjectHint((string) ($existing['project_name'] ?? '')));
                if ($existingNorm === $norm || $this->projectHintsShareTokens($existingNorm, $norm)) {
                    $index = $i;
                    break;
                }
            }

            if ($index === null) {
                $collapsed[] = $project;
                continue;
            }

            $target = $collapsed[$index];
            foreach (is_array($project['emails'] ?? null) ? $project['emails'] : [] as $email) {
                $target['emails'][] = $email;
            }
            foreach (is_array($project['quotation_forms'] ?? null) ? $project['quotation_forms'] : [] as $form) {
                $target['quotation_forms'][] = $form;
            }
            if (! empty($project['has_order_confirmation'])) {
                $target['has_order_confirmation'] = true;
                if (empty($target['order_confirmation']) || $this->orderConfirmationScore($project['order_confirmation'] ?? []) > $this->orderConfirmationScore($target['order_confirmation'] ?? [])) {
                    $target['order_confirmation'] = $project['order_confirmation'];
                }
            }
            if (! empty($project['latest_received_at'])
                && (($target['latest_received_at'] ?? null) === null
                    || strcmp((string) $project['latest_received_at'], (string) $target['latest_received_at']) > 0)) {
                $target['latest_received_at'] = $project['latest_received_at'];
            }
            // Prefer Quotation form project title when merging.
            if (! empty($project['quotation_forms'][0]['project_name'])) {
                $target['project_name'] = (string) $project['quotation_forms'][0]['project_name'];
            }
            $target['emails'] = $this->dedupeProjectEmails($target['emails'] ?? []);
            $target['quotation_forms'] = $this->dedupeQuotationForms($target['quotation_forms'] ?? []);
            $target['email_count'] = count($target['emails']);
            $target['has_quotation_form'] = $target['quotation_forms'] !== [];
            $collapsed[$index] = $target;
        }

        return $collapsed;
    }

    /**
     * Final safety pass: one row per normalized project name.
     *
     * @param  list<array<string, mixed>>  $projects
     * @return list<array<string, mixed>>
     */
    private function dedupeProjectRows(array $projects): array
    {
        $unique = [];
        foreach ($projects as $project) {
            $norm = $this->normalizeProjectHint((string) ($project['project_name'] ?? ''));
            if ($norm === '') {
                $unique[] = $project;
                continue;
            }

            $index = null;
            foreach ($unique as $i => $existing) {
                $existingNorm = $this->normalizeProjectHint((string) ($existing['project_name'] ?? ''));
                if ($existingNorm === $norm || $this->projectHintsShareTokens($existingNorm, $norm)) {
                    $index = $i;
                    break;
                }
            }

            if ($index === null) {
                $project['quotation_forms'] = $this->dedupeQuotationForms(
                    is_array($project['quotation_forms'] ?? null) ? $project['quotation_forms'] : []
                );
                $project['emails'] = $this->dedupeProjectEmails(
                    is_array($project['emails'] ?? null) ? $project['emails'] : []
                );
                $project['email_count'] = count($project['emails']);
                $unique[] = $project;
                continue;
            }

            $target = $unique[$index];
            $rank = static fn (array $row): int => match ($row['match_status'] ?? '') {
                'matched' => 3,
                'outlook_only' => 2,
                'drive_only' => 1,
                default => 0,
            };
            $keepIncoming = $rank($project) > $rank($target)
                || ($rank($project) === $rank($target)
                    && ((int) ($project['has_order_confirmation'] ?? false)) > ((int) ($target['has_order_confirmation'] ?? false)));

            $base = $keepIncoming ? $project : $target;
            $other = $keepIncoming ? $target : $project;

            foreach (is_array($other['emails'] ?? null) ? $other['emails'] : [] as $email) {
                $base['emails'][] = $email;
            }
            foreach (is_array($other['quotation_forms'] ?? null) ? $other['quotation_forms'] : [] as $form) {
                $base['quotation_forms'][] = $form;
            }
            if (! empty($other['has_order_confirmation'])) {
                $base['has_order_confirmation'] = true;
                if (empty($base['order_confirmation'])) {
                    $base['order_confirmation'] = $other['order_confirmation'];
                }
            }
            if (! empty($other['in_drive'])) {
                $base['in_drive'] = true;
            }
            if (! empty($other['in_outlook'])) {
                $base['in_outlook'] = true;
            }
            if (! empty($base['in_drive']) && ! empty($base['in_outlook'])) {
                $base['match_status'] = 'matched';
            }
            $baseName = (string) ($base['project_name'] ?? '');
            $base['quotation_forms'] = $this->formsForProject(
                $baseName,
                is_array($base['quotation_forms'] ?? null) ? $base['quotation_forms'] : []
            );
            $base['emails'] = $this->dedupeProjectEmails(
                is_array($base['emails'] ?? null) ? $base['emails'] : []
            );
            $base['email_count'] = count($base['emails']);
            $base['has_quotation_form'] = $base['quotation_forms'] !== [];
            $unique[$index] = $base;
        }

        // Absolute guarantee: one Quotation form max per project row.
        return array_values(array_map(function (array $project): array {
            $project['quotation_forms'] = $this->formsForProject(
                (string) ($project['project_name'] ?? ''),
                is_array($project['quotation_forms'] ?? null) ? $project['quotation_forms'] : []
            );
            $project['emails'] = $this->dedupeProjectEmails(
                is_array($project['emails'] ?? null) ? $project['emails'] : []
            );
            $project['email_count'] = count($project['emails']);
            $project['has_quotation_form'] = $project['quotation_forms'] !== [];

            return $project;
        }, $unique));
    }

    /**
     * @param  array<string, mixed>  $order
     */
    private function orderConfirmationScore(array $order): int
    {
        $score = 0;
        foreach (['cost', 'documentation_arrival', 'start_date', 'completion'] as $field) {
            if (! empty($order[$field])) {
                $score++;
            }
        }

        return $score;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function collectRawMessages(
        string $profile,
        string $mailbox,
        string $filter,
        int $top,
        string $query,
    ): array {
        if ($query !== '') {
            return $this->searchMessages($profile, $mailbox, $query, $top);
        }

        if ($filter === 'all') {
            return $this->listInboxMessages($profile, $mailbox, $top);
        }

        if ($filter === 'order_confirmation') {
            return $this->searchMessages($profile, $mailbox, 'order confirmation', $top);
        }

        if ($filter === 'quotations') {
            return $this->searchQuotationFileEmails($profile, $mailbox, $top);
        }

        // order_and_quotations (default): pull both searches and merge.
        return $this->mergeRawMessages([
            $this->searchMessages($profile, $mailbox, 'order confirmation', $top),
            $this->searchQuotationFileEmails($profile, $mailbox, $top),
        ]);
    }

    /**
     * Search for quotation-related email threads that map to Drive "Quotation form - {Project}" files.
     *
     * @return list<array<string, mixed>>
     */
    private function searchQuotationFileEmails(string $profile, string $mailbox, int $top): array
    {
        // Keep Graph searches lean; Drive Quotation form matching selects the right project packs.
        return $this->mergeRawMessages([
            $this->searchMessages($profile, $mailbox, 'Fee Quotation', $top),
            $this->searchMessages($profile, $mailbox, 'Fee Quotation Letter', min(50, $top)),
            $this->searchMessages($profile, $mailbox, 'Provisional Fee Quotation', min(40, $top)),
        ]);
    }

    /**
     * Match emails to Google Drive Quotation form packs (not Fee Quotation Letter PDFs).
     *
     * @param  list<array<string, mixed>>  $messages
     * @return list<array<string, mixed>>
     */
    private function attachQuotationFormsFromDrive(array $messages, string $filter): array
    {
        try {
            $forms = app(GoogleDriveQuotationsService::class)->listQuotationForms();
        } catch (Throwable $e) {
            report($e);
            $forms = [];
        }

        if ($forms === []) {
            // Without Drive forms we cannot prove Quotation form matches — drop quotation-only hits.
            return array_values(array_filter(
                $messages,
                static fn (array $mail): bool => (bool) ($mail['is_order_confirmation'] ?? false)
                    && $filter !== 'quotations'
            ));
        }

        $out = [];
        foreach ($messages as $message) {
            $isOrder = (bool) ($message['is_order_confirmation'] ?? false);
            $hint = trim((string) (
                ($message['parsed']['project_name'] ?? '')
                ?: ($message['subject'] ?? '')
            ));
            $matched = $this->matchQuotationFormsForHint($hint, $forms);

            $message['quotation_forms'] = $matched;
            $message['has_quotation_file'] = $matched !== [];
            $message['is_quotation'] = $matched !== [];
            $message['quotation_files'] = array_values(array_map(
                static fn (array $form): string => (string) ($form['name'] ?? ''),
                $matched
            ));

            if ($matched !== [] && empty($message['parsed'])) {
                $message['parsed'] = [
                    'project_name' => (string) ($matched[0]['project_name'] ?? $hint),
                    'cost' => null,
                    'documentation_arrival' => null,
                    'start_date' => null,
                    'completion' => null,
                ];
            } elseif ($matched !== [] && ! empty($message['parsed']) && empty($message['parsed']['project_name'])) {
                $message['parsed']['project_name'] = (string) ($matched[0]['project_name'] ?? $hint);
            }

            if ($filter === 'quotations' && $matched === []) {
                continue;
            }
            if ($filter === 'order_and_quotations' && ! $isOrder && $matched === []) {
                continue;
            }

            $out[] = $message;
        }

        return $out;
    }

    /**
     * @param  list<array<string, mixed>>  $forms
     * @return list<array<string, mixed>>
     */
    private function matchQuotationFormsForHint(string $hint, array $forms): array
    {
        $hintNorm = $this->normalizeProjectHint($hint);
        if ($hintNorm === '') {
            return [];
        }

        $matches = [];
        foreach ($forms as $form) {
            $project = (string) ($form['project_name'] ?? '');
            $projectNorm = $this->normalizeProjectHint($project);
            if ($projectNorm === '') {
                continue;
            }

            if ($hintNorm === $projectNorm
                || str_contains($hintNorm, $projectNorm)
                || str_contains($projectNorm, $hintNorm)
                || $this->projectHintsShareTokens($hintNorm, $projectNorm)) {
                $matches[] = [
                    'id' => (string) ($form['id'] ?? ''),
                    'name' => (string) ($form['name'] ?? ''),
                    'project_name' => $project,
                    'web_link' => (string) ($form['webViewLink'] ?? ''),
                    'mime_type' => (string) ($form['mimeType'] ?? ''),
                    'source' => 'google_drive',
                ];
            }
        }

        // Prefer exact-ish longer project names, unique by id/name.
        usort($matches, static function (array $a, array $b): int {
            return strlen((string) $b['project_name']) <=> strlen((string) $a['project_name']);
        });

        $unique = [];
        $seen = [];
        foreach ($matches as $match) {
            $key = (string) ($match['id'] ?: mb_strtolower((string) $match['name']));
            if ($key === '' || isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $unique[] = $match;
            if (count($unique) >= 3) {
                break;
            }
        }

        return $unique;
    }

    private function normalizeProjectHint(string $value): string
    {
        $text = mb_strtolower(trim($value));
        $text = preg_replace('/^\s*(?:re|fw|fwd)\s*:\s*/i', '', $text) ?? $text;
        $text = preg_replace('/\b(?:bills?\s+of\s+quantities|boq|provisional|revised|fee\s+quotations?|quotations?|qoutations?|letter|stage\s+\d+|order\s+confirmation)\b/i', ' ', $text) ?? $text;
        $text = preg_replace('/[^a-z0-9&]+/i', ' ', $text) ?? $text;
        $text = preg_replace('/\s+/', ' ', $text) ?? $text;

        return trim($text);
    }

    private function projectHintsShareTokens(string $a, string $b): bool
    {
        $tokensA = $this->distinctiveProjectTokens($a);
        $tokensB = $this->distinctiveProjectTokens($b);
        if ($tokensA === [] || $tokensB === []) {
            return false;
        }

        $shared = [];
        foreach ($tokensA as $token) {
            if (in_array($token, $tokensB, true)) {
                $shared[] = $token;
            }
        }
        if ($shared === []) {
            return false;
        }

        // One strong distinctive token is enough (e.g. Haileybury ↔ Haileybury Turnford).
        foreach ($shared as $token) {
            if (mb_strlen($token) >= 7) {
                return true;
            }
        }

        // Otherwise require at least two distinctive shared tokens.
        return count($shared) >= 2;
    }

    /**
     * @return list<string>
     */
    private function distinctiveProjectTokens(string $normalizedHint): array
    {
        $stop = [
            'school', 'schools', 'primary', 'secondary', 'academy', 'college', 'university',
            'hospital', 'centre', 'center', 'leisure', 'community', 'development', 'developments',
            'phase', 'building', 'buildings', 'project', 'projects', 'park', 'road', 'house',
            'hub', 'quarter', 'estate', 'works', 'major', 'new', 'and', 'the', 'for', 'stage',
            'high', 'junior', 'infant', 'care', 'home', 'homes', 'arena', 'depot', 'station',
            'north', 'south', 'east', 'west', 'city', 'town', 'village', 'green', 'court',
        ];

        $tokens = array_values(array_filter(
            preg_split('/\s+/', $normalizedHint) ?: [],
            static function (string $token) use ($stop): bool {
                if (mb_strlen($token) < 4) {
                    return false;
                }

                return ! in_array($token, $stop, true);
            }
        ));

        return $tokens;
    }

    /**
     * Keep a single best Quotation form for this project (no Sheet+.xlsx / sibling-job duplicates).
     *
     * @param  list<array<string, mixed>>  $forms
     * @return list<array<string, mixed>>
     */
    private function formsForProject(string $projectName, array $forms): array
    {
        $projectNorm = $this->normalizeProjectHint($projectName);
        if ($projectNorm === '' || $forms === []) {
            $deduped = $this->dedupeQuotationForms($forms);

            return $deduped === [] ? [] : [array_values($deduped)[0]];
        }

        $best = null;
        $bestScore = -1;
        foreach ($forms as $form) {
            if (! is_array($form)) {
                continue;
            }
            $formProject = trim((string) ($form['project_name'] ?? ''));
            if ($formProject === '') {
                $formProject = preg_replace('/^quotation\s*form\s*[-–—:]\s*/i', '', (string) ($form['name'] ?? '')) ?? '';
                $formProject = preg_replace('/\.xlsx?$/i', '', $formProject) ?? $formProject;
                $formProject = trim($formProject);
            }
            $formNorm = $this->normalizeProjectHint($formProject);
            if ($formNorm === '') {
                continue;
            }

            $score = $this->quotationFormPreferenceScore($form);
            if ($formNorm === $projectNorm) {
                $score += 1000;
            } elseif (str_starts_with($formNorm, $projectNorm) || str_starts_with($projectNorm, $formNorm)) {
                // Same stem with job-number suffix / short prefix only.
                $score += 600;
            } elseif ($this->projectHintsShareTokens($projectNorm, $formNorm)) {
                $score += 200;
            } else {
                continue;
            }

            // Penalize forms that clearly belong to a different sibling job
            // (shared place name but extra distinctive tokens on both sides).
            $projectTokens = $this->distinctiveProjectTokens($projectNorm);
            $formTokens = $this->distinctiveProjectTokens($formNorm);
            $extraForm = array_values(array_diff($formTokens, $projectTokens));
            $extraProject = array_values(array_diff($projectTokens, $formTokens));
            if ($extraForm !== [] && $extraProject !== []) {
                $score -= 400;
            }

            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $form;
                $best['project_name'] = $formProject;
            }
        }

        return $best ? [$best] : [];
    }

    /**
     * @param  list<list<array<string, mixed>>>  $batches
     * @return list<array<string, mixed>>
     */
    private function mergeRawMessages(array $batches): array
    {
        $merged = [];
        $seen = [];
        foreach ($batches as $batch) {
            foreach ($batch as $row) {
                if (! is_array($row)) {
                    continue;
                }
                $id = (string) ($row['id'] ?? '');
                if ($id !== '' && isset($seen[$id])) {
                    continue;
                }
                if ($id !== '') {
                    $seen[$id] = true;
                }
                $merged[] = $row;
            }
        }

        return $merged;
    }

    /**
     * @param  'deals'|'leads'  $profile
     * @return array<string, mixed>
     */
    public function getMessage(string $profile, string $messageId): array
    {
        $mailbox = $this->mailbox($profile);
        if ($mailbox === '' || trim($messageId) === '') {
            throw new RuntimeException('Mailbox or message id is missing.');
        }

        $token = $this->accessToken($profile);
        $url = self::GRAPH_BASE.'/users/'.rawurlencode($mailbox).'/messages/'.rawurlencode($messageId)
            .'?$select=id,internetMessageId,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,webLink,hasAttachments';

        $response = Http::withToken($token)
            ->acceptJson()
            ->timeout(30)
            ->withOptions(['verify' => $this->resolveSslVerifyPath()])
            ->withHeaders(['Prefer' => 'IdType="ImmutableId"'])
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException(
                'Unable to load Outlook message (HTTP '.$response->status().').'
            );
        }

        $normalized = $this->normalizeMessage($response->json() ?? [], includeBody: true);
        $isOrder = $this->isOrderConfirmationWithProjectInfo($normalized);
        $isQuotation = $this->isQuotationEmail($normalized);
        $normalized['is_order_confirmation'] = $isOrder;
        $normalized['is_quotation'] = $isQuotation;
        if ($isOrder) {
            $normalized['parsed'] = $this->parseOrderConfirmation($normalized);
        } elseif ($isQuotation) {
            $normalized['parsed'] = $this->parseQuotation($normalized);
        }

        $attachments = [];
        try {
            $attachments = $this->listAttachments($profile, $mailbox, $messageId, $token);
            $normalized['body_html'] = $this->embedInlineAttachments(
                (string) ($normalized['body_html'] ?? ''),
                $attachments,
                $profile,
                $mailbox,
                $messageId,
                $token,
            );
        } catch (Throwable $e) {
            report($e);
        }
        $documentAttachments = $this->publicAttachments(
            array_values(array_filter(
                $attachments,
                fn (array $item): bool => $this->isDocumentAttachment($item)
                    && ! $this->isFeeQuotationLetterAttachment($item)
            ))
        );
        $normalized['attachments'] = $documentAttachments;
        $normalized['file_count'] = count($documentAttachments);
        $normalized['has_files'] = $normalized['file_count'] > 0;
        $normalized['has_attachments'] = $normalized['has_files'];

        $hint = trim((string) (
            ($normalized['parsed']['project_name'] ?? '')
            ?: ($normalized['subject'] ?? '')
        ));
        try {
            $forms = app(GoogleDriveQuotationsService::class)->listQuotationForms();
        } catch (Throwable $e) {
            report($e);
            $forms = [];
        }
        $matched = $this->matchQuotationFormsForHint($hint, $forms);
        $normalized['quotation_forms'] = $matched;
        $normalized['quotation_files'] = array_values(array_map(
            static fn (array $form): string => (string) ($form['name'] ?? ''),
            $matched
        ));
        $normalized['has_quotation_file'] = $matched !== [];
        $normalized['is_quotation'] = $matched !== [];
        if ($matched !== [] && empty($normalized['parsed'])) {
            $normalized['parsed'] = $this->parseQuotation($normalized);
            $normalized['parsed']['project_name'] = (string) ($matched[0]['project_name'] ?? $hint);
        }

        return $normalized;
    }

    /**
     * @param  list<array<string, mixed>>  $messages
     * @return list<array<string, mixed>>
     */
    private function enrichMessagesWithFileTags(
        string $profile,
        string $mailbox,
        string $token,
        array $messages,
    ): array {
        foreach ($messages as &$message) {
            $message['quotation_files'] = [];
            $message['has_quotation_file'] = false;

            if (! ($message['has_attachments'] ?? false)) {
                $message['has_files'] = false;
                $message['file_count'] = 0;
                continue;
            }

            try {
                $meta = $this->listAttachmentMeta($profile, $mailbox, (string) $message['id'], $token);
                $fileCount = 0;
                $quotationFiles = [];
                foreach ($meta as $item) {
                    if (! $this->isDocumentAttachment($item)) {
                        continue;
                    }
                    $fileCount++;
                    if ($this->isQuotationFileAttachment($item)) {
                        $quotationFiles[] = (string) ($item['name'] ?? 'Quotation file');
                    }
                }
                $message['file_count'] = $fileCount;
                $message['has_files'] = $fileCount > 0;
                $message['quotation_files'] = $quotationFiles;
                $message['has_quotation_file'] = $quotationFiles !== [];
                if ($message['has_quotation_file']) {
                    $message['is_quotation'] = true;
                    if (empty($message['parsed'])) {
                        $message['parsed'] = $this->parseQuotation($message);
                    }
                }
            } catch (Throwable $e) {
                report($e);
                // Fall back to Graph's flag when metadata cannot be inspected.
                $message['has_files'] = (bool) ($message['has_attachments'] ?? false);
                $message['file_count'] = $message['has_files'] ? 1 : 0;
            }
        }
        unset($message);

        return $messages;
    }

    /**
     * Keep only emails that match the active filter after attachment inspection.
     *
     * @param  list<array<string, mixed>>  $messages
     * @return list<array<string, mixed>>
     */
    private function finalizeQuotationMatches(array $messages, string $filter): array
    {
        if ($filter === 'all') {
            return $messages;
        }

        $filtered = [];
        foreach ($messages as $message) {
            $isOrder = (bool) ($message['is_order_confirmation'] ?? false);
            $hasQuoteFile = (bool) ($message['has_quotation_file'] ?? false);

            // Quotation tag only when a TSA quotation workbook / Fee Quotation Letter is attached.
            $message['is_quotation'] = $hasQuoteFile;

            if ($filter === 'order_confirmation' && ! $isOrder) {
                continue;
            }
            if ($filter === 'quotations' && ! $hasQuoteFile) {
                continue;
            }
            if ($filter === 'order_and_quotations' && ! $isOrder && ! $hasQuoteFile) {
                continue;
            }

            $filtered[] = $message;
        }

        return array_values($filtered);
    }

    /**
     * Lightweight attachment metadata (no contentBytes).
     *
     * @return list<array<string, mixed>>
     */
    private function listAttachmentMeta(string $profile, string $mailbox, string $messageId, string $token): array
    {
        $url = self::GRAPH_BASE.'/users/'.rawurlencode($mailbox)
            .'/messages/'.rawurlencode($messageId)
            .'/attachments'
            .'?$select='.rawurlencode('id,name,contentType,size,isInline');

        $response = Http::withToken($token)
            ->acceptJson()
            ->timeout(30)
            ->withOptions(['verify' => $this->resolveSslVerifyPath()])
            ->withHeaders(['Prefer' => 'IdType="ImmutableId"'])
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException(
                'Unable to list Outlook attachment metadata (HTTP '.$response->status().').'
            );
        }

        $value = $response->json('value');
        if (! is_array($value)) {
            return [];
        }

        $attachments = [];
        foreach ($value as $row) {
            if (! is_array($row)) {
                continue;
            }
            $odataType = (string) ($row['@odata.type'] ?? '');
            $name = trim((string) ($row['name'] ?? ''));
            $contentType = trim((string) ($row['contentType'] ?? ''));
            $size = (int) ($row['size'] ?? 0);
            $attachments[] = [
                'id' => (string) ($row['id'] ?? ''),
                'name' => $name !== '' ? $name : 'Attachment',
                'content_type' => $contentType !== '' ? $contentType : 'application/octet-stream',
                'size' => $size,
                'size_label' => $this->formatBytes($size),
                'is_inline' => (bool) ($row['isInline'] ?? false),
                'content_id' => '',
                'is_file' => str_contains($odataType, 'fileAttachment') || $odataType === '',
                'is_image' => str_starts_with(strtolower($contentType), 'image/'),
            ];
        }

        return array_values(array_filter(
            $attachments,
            static fn (array $item): bool => $item['id'] !== ''
        ));
    }

    /**
     * @param  'deals'|'leads'  $profile
     * @return array{id: string, name: string, content_type: string, size: int, content: string}
     */
    public function getAttachment(string $profile, string $messageId, string $attachmentId): array
    {
        $mailbox = $this->mailbox($profile);
        if ($mailbox === '' || trim($messageId) === '' || trim($attachmentId) === '') {
            throw new RuntimeException('Mailbox, message id, or attachment id is missing.');
        }

        $token = $this->accessToken($profile);
        $raw = $this->fetchAttachmentRaw($profile, $mailbox, $messageId, $attachmentId, $token);
        $name = trim((string) ($raw['name'] ?? 'attachment'));
        $contentType = trim((string) ($raw['contentType'] ?? 'application/octet-stream')) ?: 'application/octet-stream';
        $contentBytes = (string) ($raw['contentBytes'] ?? '');
        if ($contentBytes === '') {
            throw new RuntimeException('This attachment has no downloadable file content.');
        }

        $binary = base64_decode($contentBytes, true);
        if ($binary === false) {
            throw new RuntimeException('Unable to decode attachment content.');
        }

        return [
            'id' => (string) ($raw['id'] ?? $attachmentId),
            'name' => $name !== '' ? $name : 'attachment',
            'content_type' => $contentType,
            'size' => strlen($binary),
            'content' => $binary,
        ];
    }

    /**
     * @param  'deals'|'leads'  $profile
     * @return list<array<string, mixed>>
     */
    private function listInboxMessages(string $profile, string $mailbox, int $top): array
    {
        $token = $this->accessToken($profile);
        $select = 'id,internetMessageId,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,webLink,hasAttachments';
        $url = self::GRAPH_BASE.'/users/'.rawurlencode($mailbox)
            .'/mailFolders/inbox/messages'
            .'?$top='.$top
            .'&$orderby=receivedDateTime desc'
            .'&$select='.rawurlencode($select);

        $response = Http::withToken($token)
            ->acceptJson()
            ->timeout(45)
            ->withOptions(['verify' => $this->resolveSslVerifyPath()])
            ->withHeaders(['Prefer' => 'IdType="ImmutableId"'])
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException(
                'Unable to list Outlook inbox (HTTP '.$response->status().').'
            );
        }

        $value = $response->json('value');

        return is_array($value) ? $value : [];
    }

    /**
     * @param  'deals'|'leads'  $profile
     * @return list<array<string, mixed>>
     */
    private function searchMessages(string $profile, string $mailbox, string $query, int $top): array
    {
        $token = $this->accessToken($profile);
        $select = 'id,internetMessageId,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,webLink,hasAttachments';
        $search = '"'.str_replace('"', '', $query).'"';
        $url = self::GRAPH_BASE.'/users/'.rawurlencode($mailbox)
            .'/messages'
            .'?$search='.rawurlencode($search)
            .'&$top='.$top
            .'&$select='.rawurlencode($select);

        $response = Http::withToken($token)
            ->acceptJson()
            ->timeout(60)
            ->withOptions(['verify' => $this->resolveSslVerifyPath()])
            ->withHeaders([
                'Prefer' => 'IdType="ImmutableId"',
                'ConsistencyLevel' => 'eventual',
            ])
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException(
                'Unable to search Outlook messages (HTTP '.$response->status().').'
            );
        }

        $value = $response->json('value');

        return is_array($value) ? $value : [];
    }

    /**
     * @param  'deals'|'leads'  $profile
     */
    public function accessToken(string $profile): string
    {
        $profile = $profile === 'leads' ? 'leads' : 'deals';
        $cached = $this->tokenCache[$profile] ?? null;
        if (is_array($cached) && ($cached['expires_at'] ?? 0) > time() + 30) {
            return (string) $cached['token'];
        }

        $config = $this->profileConfig($profile);
        $tenantId = trim((string) ($config['tenant_id'] ?? ''));
        $clientId = trim((string) ($config['client_id'] ?? ''));
        $clientSecret = trim((string) ($config['client_secret'] ?? ''));
        if ($tenantId === '' || $clientId === '' || $clientSecret === '') {
            throw new RuntimeException('Outlook Graph credentials are not configured.');
        }

        $tokenUrl = 'https://login.microsoftonline.com/'.rawurlencode($tenantId).'/oauth2/v2.0/token';
        $response = Http::asForm()
            ->timeout(20)
            ->withOptions(['verify' => $this->resolveSslVerifyPath()])
            ->post($tokenUrl, [
                'grant_type' => 'client_credentials',
                'client_id' => $clientId,
                'client_secret' => $clientSecret,
                'scope' => 'https://graph.microsoft.com/.default',
            ]);

        $token = (string) ($response->json('access_token') ?? '');
        if (! $response->successful() || $token === '') {
            $message = (string) (
                $response->json('error_description')
                ?? $response->json('error')
                ?? 'Could not obtain Microsoft Graph token.'
            );
            throw new RuntimeException($message);
        }

        $expiresIn = (int) ($response->json('expires_in') ?? 3600);
        $this->tokenCache[$profile] = [
            'token' => $token,
            'expires_at' => time() + max(60, $expiresIn - 30),
        ];

        return $token;
    }

    /**
     * @param  array<string, mixed>  $message
     * @return array<string, mixed>
     */
    private function normalizeMessage(array $message, bool $includeBody = false): array
    {
        $from = is_array($message['from'] ?? null) ? $message['from'] : [];
        $emailAddress = is_array($from['emailAddress'] ?? null) ? $from['emailAddress'] : [];
        $fromName = trim((string) ($emailAddress['name'] ?? ''));
        $fromAddress = trim((string) ($emailAddress['address'] ?? ''));

        $body = is_array($message['body'] ?? null) ? $message['body'] : [];
        $bodyContent = (string) ($body['content'] ?? '');
        $bodyType = strtolower((string) ($body['contentType'] ?? 'text'));
        $preview = trim((string) ($message['bodyPreview'] ?? ''));
        if ($preview === '' && $bodyContent !== '') {
            $preview = $this->plainTextFromBody($bodyContent, $bodyType);
            $preview = mb_substr(preg_replace('/\s+/u', ' ', $preview) ?? $preview, 0, 280);
        }

        $plain = $this->plainTextFromBody($bodyContent, $bodyType);
        if ($plain === '') {
            $plain = $preview;
        }

        $normalized = [
            'id' => (string) ($message['id'] ?? ''),
            'internet_message_id' => (string) ($message['internetMessageId'] ?? ''),
            'subject' => (string) ($message['subject'] ?? ''),
            'from_name' => $fromName,
            'from_address' => $fromAddress,
            'from' => $fromName !== '' ? ($fromAddress !== '' ? "{$fromName} <{$fromAddress}>" : $fromName) : $fromAddress,
            'received_at' => (string) ($message['receivedDateTime'] ?? ''),
            'preview' => $preview,
            'is_read' => (bool) ($message['isRead'] ?? false),
            'web_link' => (string) ($message['webLink'] ?? ''),
            'has_attachments' => (bool) ($message['hasAttachments'] ?? false),
            'has_files' => false,
            'file_count' => 0,
            'is_order_confirmation' => false,
            'is_quotation' => false,
        ];

        if ($includeBody || $bodyContent !== '') {
            $normalized['body_html'] = $bodyType === 'html' ? $bodyContent : nl2br(e($bodyContent));
            $normalized['body_text'] = $plain;
        }

        $probe = [
            'subject' => $normalized['subject'],
            'preview' => $normalized['preview'].' '.$plain,
        ];
        $normalized['is_order_confirmation'] = $this->isOrderConfirmationWithProjectInfo($probe);
        $normalized['is_quotation'] = $this->isQuotationEmail($probe);

        return $normalized;
    }

    /**
     * @param  array<string, mixed>  $mail
     */
    public function isOrderConfirmationWithProjectInfo(array $mail): bool
    {
        $subject = (string) ($mail['subject'] ?? '');
        $preview = (string) ($mail['preview'] ?? $mail['bodyPreview'] ?? $mail['body_text'] ?? '');
        $blob = strtolower($subject.' '.$preview);

        if (! preg_match('/order\s+confirmation/i', $blob)) {
            return false;
        }

        return (bool) preg_match('/documentation\s*arrival/i', $blob)
            || (bool) preg_match('/start\s*date/i', $blob)
            || (bool) preg_match('/completion/i', $blob)
            || (bool) preg_match('/\bcost of\s*£/i', $blob);
    }

    /**
     * @param  array<string, mixed>  $mail
     */
    public function isQuotationEmail(array $mail): bool
    {
        $subject = (string) ($mail['subject'] ?? '');
        $preview = (string) ($mail['preview'] ?? $mail['bodyPreview'] ?? $mail['body_text'] ?? '');
        $blob = strtolower($subject.' '.$preview);

        // Match the TSA quotation workbook / Fee Quotation Letter pack style.
        if (preg_match('/(?:fee\s+quotation(?:\s+letter)?|provisional\s+fee\s+quotation|revised\s+(?:fee\s+)?quotation|boq.{0,40}quotation)/i', $subject)) {
            return true;
        }

        if (preg_match('/quoted\s*hrs|quote\s+to\s+send|trevor\s+sadd\s+associates/i', $blob)
            && preg_match('/\b(?:quotation|qoutation|boq)\b/i', $blob)) {
            return true;
        }

        if (! preg_match('/\b(?:quotations?|qoutations?|fee\s+quotation)\b/i', $blob)) {
            return false;
        }

        return (bool) preg_match('/(?:please find attached|further to your enquiry|provisional fee|at a cost of|we have excluded the following sections)/i', $blob)
            || (bool) preg_match('/\bcost of\s*£/i', $blob)
            || (bool) preg_match('/\bour quotation\b/i', $blob);
    }

    /**
     * Detect attached TSA quotation files (Fee Quotation Letter PDFs / quotation workbooks).
     *
     * @param  array<string, mixed>  $attachment
     */
    public function isQuotationFileAttachment(array $attachment): bool
    {
        if (! $this->isDocumentAttachment($attachment)) {
            return false;
        }
        if ($this->isFeeQuotationLetterAttachment($attachment)) {
            return false;
        }

        $name = strtolower((string) ($attachment['name'] ?? ''));

        // Prefer the Drive-style Quotation form workbook, not the client letter PDF.
        if (preg_match('/quotation\s*form/i', $name)) {
            return true;
        }

        if (preg_match('/\.(xlsx|xlsm|xls)$/i', $name)
            && preg_match('/(?:fee\s*quotation|provisional\s*fee\s*quotation|boq.*quotation)/i', $name)
            && ! preg_match('/letter/i', $name)) {
            return true;
        }

        return false;
    }

    /**
     * @param  array<string, mixed>  $attachment
     */
    public function isFeeQuotationLetterAttachment(array $attachment): bool
    {
        $name = (string) ($attachment['name'] ?? '');

        return (bool) preg_match('/fee\s*quotation\s*letter|boq.{0,80}fee\s*quotation\s*letter/i', $name);
    }

    /**
     * @param  array<string, mixed>  $mail
     * @return array<string, mixed>
     */
    public function parseOrderConfirmation(array $mail): array
    {
        $subject = trim((string) ($mail['subject'] ?? ''));
        $text = (string) ($mail['body_text'] ?? $mail['preview'] ?? '');
        if ($text === '' && ! empty($mail['body_html'])) {
            $text = $this->plainTextFromBody((string) $mail['body_html'], 'html');
        }

        $project = $subject;
        if (preg_match('/^\s*(?:re|fw|fwd)\s*:\s*(.+?)\s*-\s*order\s+confirmation\s*$/i', $subject, $m)) {
            $project = trim($m[1]);
        } elseif (preg_match('/(.+?)\s*-\s*order\s+confirmation/i', $subject, $m)) {
            $project = trim($m[1]);
        }

        $cost = null;
        if (preg_match('/cost of\s*£?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i', $text, $m)) {
            $cost = str_replace(',', '', $m[1]);
        }

        return [
            'project_name' => $project,
            'cost' => $cost,
            'documentation_arrival' => $this->extractLabeledDate($text, 'documentation\\s*arrival'),
            'start_date' => $this->extractLabeledDate($text, 'start\\s*date'),
            'completion' => $this->extractLabeledDate($text, '(?:end\\s*date|completion(?:\\s*date)?)'),
        ];
    }

    /**
     * @param  array<string, mixed>  $mail
     * @return array<string, mixed>
     */
    public function parseQuotation(array $mail): array
    {
        $subject = trim((string) ($mail['subject'] ?? ''));
        $text = (string) ($mail['body_text'] ?? $mail['preview'] ?? '');
        if ($text === '' && ! empty($mail['body_html'])) {
            $text = $this->plainTextFromBody((string) $mail['body_html'], 'html');
        }

        $project = $subject;
        $quoteFiles = $mail['quotation_files'] ?? [];
        if (is_array($quoteFiles) && $quoteFiles !== []) {
            $fromFile = $this->projectNameFromQuotationFileName((string) $quoteFiles[0]);
            if ($fromFile !== '') {
                $project = $fromFile;
            }
        }

        if ($project === $subject) {
            if (preg_match('/^\s*(?:re|fw|fwd)\s*:\s*(.+?)(?:\s*-\s*(?:bills?\s+of\s+quantities\s*-?\s*)?(?:provisional\s+)?fee\s+)?(?:quotations?|qoutations?)\s*$/i', $subject, $m)) {
                $project = trim($m[1]);
            } elseif (preg_match('/(.+?)\s*-\s*(?:.+\s+)?(?:quotations?|qoutations?)\s*$/i', $subject, $m)) {
                $project = trim($m[1]);
                $project = preg_replace('/^\s*(?:re|fw|fwd)\s*:\s*/i', '', $project) ?? $project;
            } else {
                $project = preg_replace('/^\s*(?:re|fw|fwd)\s*:\s*/i', '', $project) ?? $project;
            }
        }

        $cost = null;
        if (preg_match('/(?:at a\s+)?cost of\s*£?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i', $text, $m)) {
            $cost = str_replace(',', '', $m[1]);
        } elseif (preg_match('/£\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:plus\s+VAT)?/i', $text, $m)) {
            $cost = str_replace(',', '', $m[1]);
        }

        return [
            'project_name' => trim($project),
            'cost' => $cost,
            'documentation_arrival' => null,
            'start_date' => null,
            'completion' => null,
        ];
    }

    private function projectNameFromQuotationFileName(string $fileName): string
    {
        $base = pathinfo($fileName, PATHINFO_FILENAME);
        $base = preg_replace('/^\d{4}[.\-\/]\d{1,2}[.\-\/]\d{1,2}[_\s-]*/', '', $base) ?? $base;
        $base = preg_replace('/[-_\s]*(?:boq\s*)?(?:provisional\s+|revised\s+)?fee\s*quotation(?:\s*letter)?.*$/i', '', $base) ?? $base;
        $base = preg_replace('/[-_\s]*quotation(?:\s*letter)?.*$/i', '', $base) ?? $base;
        $base = str_replace('_', ' ', $base);
        $base = preg_replace('/\s+/', ' ', $base) ?? $base;

        return trim($base, " \t-–—");
    }

    private function extractLabeledDate(string $bodyText, string $labelPattern): ?string
    {
        $re = '/'.$labelPattern.'\\s*[:\\-]?\\s*(.+?)(?=\\s*(?:documentation|start|end|completion|brief|budget|kind\\s+regards)|$)/is';
        if (! preg_match($re, $bodyText, $m)) {
            return null;
        }
        $raw = trim(preg_replace('/\s+/u', ' ', (string) $m[1]) ?? '');
        $iso = $this->parseDateToIso($raw);

        return $iso !== '' ? $iso : ($raw !== '' ? $raw : null);
    }

    private function parseDateToIso(string $value): string
    {
        $raw = trim($value);
        if ($raw === '') {
            return '';
        }
        if (preg_match('/^(\d{4})[.\\/\s-]+(\d{1,2})[.\\/\s-]+(\d{1,2})/', $raw, $m)) {
            return sprintf('%04d-%02d-%02d', (int) $m[1], (int) $m[2], (int) $m[3]);
        }
        if (preg_match('/^(\d{1,2})[.\\/\s-]+(\d{1,2})[.\\/\s-]+(\d{4})/', $raw, $m)) {
            return sprintf('%04d-%02d-%02d', (int) $m[3], (int) $m[2], (int) $m[1]);
        }
        try {
            return \Carbon\Carbon::parse($raw)->toDateString();
        } catch (Throwable) {
            return '';
        }
    }

    private function plainTextFromBody(string $content, string $type): string
    {
        if ($content === '') {
            return '';
        }
        if (strtolower($type) === 'html') {
            $text = html_entity_decode(strip_tags($content), ENT_QUOTES | ENT_HTML5, 'UTF-8');

            return trim(preg_replace("/[ \t]+/u", ' ', $text) ?? $text);
        }

        return trim($content);
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function listAttachments(string $profile, string $mailbox, string $messageId, string $token): array
    {
        $url = self::GRAPH_BASE.'/users/'.rawurlencode($mailbox)
            .'/messages/'.rawurlencode($messageId)
            .'/attachments';

        $response = Http::withToken($token)
            ->acceptJson()
            ->timeout(60)
            ->withOptions(['verify' => $this->resolveSslVerifyPath()])
            ->withHeaders(['Prefer' => 'IdType="ImmutableId"'])
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException(
                'Unable to list Outlook attachments (HTTP '.$response->status().').'
            );
        }

        $value = $response->json('value');
        if (! is_array($value)) {
            return [];
        }

        $attachments = [];
        foreach ($value as $row) {
            if (! is_array($row)) {
                continue;
            }
            $odataType = (string) ($row['@odata.type'] ?? '');
            $name = trim((string) ($row['name'] ?? ''));
            $contentType = trim((string) ($row['contentType'] ?? ''));
            $size = (int) ($row['size'] ?? 0);
            $contentBytes = (string) ($row['contentBytes'] ?? '');
            $attachments[] = [
                'id' => (string) ($row['id'] ?? ''),
                'name' => $name !== '' ? $name : 'Attachment',
                'content_type' => $contentType !== '' ? $contentType : 'application/octet-stream',
                'size' => $size,
                'size_label' => $this->formatBytes($size),
                'is_inline' => (bool) ($row['isInline'] ?? false),
                'content_id' => trim((string) ($row['contentId'] ?? ''), " \t\n\r\0\x0B<>"),
                'is_file' => str_contains($odataType, 'fileAttachment') || $odataType === '',
                'is_image' => str_starts_with(strtolower($contentType), 'image/'),
                // Kept privately for inline embedding; stripped before JSON response.
                '_content_bytes' => $contentBytes !== '' ? $contentBytes : null,
            ];
        }

        return array_values(array_filter(
            $attachments,
            static fn (array $item): bool => $item['id'] !== ''
        ));
    }

    /**
     * @param  list<array<string, mixed>>  $attachments
     * @return list<array<string, mixed>>
     */
    private function publicAttachments(array $attachments): array
    {
        return array_map(static function (array $attachment): array {
            unset($attachment['_content_bytes']);

            return $attachment;
        }, $attachments);
    }

    /**
     * Document/file attachments only — exclude images and signature/inline pictures.
     *
     * @param  array<string, mixed>  $attachment
     */
    private function isDocumentAttachment(array $attachment): bool
    {
        if (! ($attachment['is_file'] ?? true)) {
            return false;
        }
        if ($attachment['is_image'] ?? false) {
            return false;
        }

        $contentType = strtolower((string) ($attachment['content_type'] ?? ''));
        if (str_starts_with($contentType, 'image/')) {
            return false;
        }

        $name = strtolower((string) ($attachment['name'] ?? ''));
        if (preg_match('/\.(png|jpe?g|gif|webp|bmp|svg|ico|tif{1,2})$/i', $name)) {
            return false;
        }

        // Skip tiny nameless inline blobs that are almost always signatures.
        if (($attachment['is_inline'] ?? false) && $contentType === '') {
            return false;
        }

        return true;
    }

    /**
     * @param  list<array<string, mixed>>  $attachments
     */
    private function embedInlineAttachments(
        string $bodyHtml,
        array $attachments,
        string $profile,
        string $mailbox,
        string $messageId,
        string $token,
    ): string {
        if ($bodyHtml === '' || $attachments === []) {
            return $bodyHtml;
        }

        foreach ($attachments as $attachment) {
            if (! ($attachment['is_inline'] ?? false) && ! ($attachment['is_image'] ?? false)) {
                continue;
            }
            $contentId = trim((string) ($attachment['content_id'] ?? ''));
            if ($contentId === '') {
                continue;
            }
            if (! str_contains($bodyHtml, 'cid:'.$contentId) && ! str_contains($bodyHtml, 'cid:'.rawurlencode($contentId))) {
                continue;
            }

            $bytes = (string) ($attachment['_content_bytes'] ?? '');
            if ($bytes === '') {
                try {
                    $raw = $this->fetchAttachmentRaw($profile, $mailbox, $messageId, (string) $attachment['id'], $token);
                    $bytes = (string) ($raw['contentBytes'] ?? '');
                } catch (Throwable) {
                    continue;
                }
            }
            if ($bytes === '') {
                continue;
            }
            $contentType = trim((string) ($attachment['content_type'] ?? 'application/octet-stream'));
            if ($contentType === '') {
                $contentType = 'application/octet-stream';
            }
            $dataUrl = 'data:'.$contentType.';base64,'.$bytes;
            $bodyHtml = str_replace(
                ['cid:'.$contentId, 'cid:'.rawurlencode($contentId)],
                [$dataUrl, $dataUrl],
                $bodyHtml
            );
        }

        return $bodyHtml;
    }

    /**
     * @return array<string, mixed>
     */
    private function fetchAttachmentRaw(
        string $profile,
        string $mailbox,
        string $messageId,
        string $attachmentId,
        ?string $token = null,
    ): array {
        $token ??= $this->accessToken($profile);
        $url = self::GRAPH_BASE.'/users/'.rawurlencode($mailbox)
            .'/messages/'.rawurlencode($messageId)
            .'/attachments/'.rawurlencode($attachmentId);

        $response = Http::withToken($token)
            ->acceptJson()
            ->timeout(60)
            ->withOptions(['verify' => $this->resolveSslVerifyPath()])
            ->withHeaders(['Prefer' => 'IdType="ImmutableId"'])
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException(
                'Unable to download Outlook attachment (HTTP '.$response->status().').'
            );
        }

        $json = $response->json();

        return is_array($json) ? $json : [];
    }

    public function formatBytes(int $bytes): string
    {
        if ($bytes < 1024) {
            return $bytes.' B';
        }
        if ($bytes < 1048576) {
            return round($bytes / 1024, 1).' KB';
        }

        return round($bytes / 1048576, 1).' MB';
    }

    private function resolveSslVerifyPath(): string|bool
    {
        $configured = config('outlook.http_verify');
        if ($configured === false || $configured === 0 || $configured === '0' || $configured === 'false') {
            return false;
        }

        if (is_string($configured) && $configured !== '' && $configured !== '1' && $configured !== 'true') {
            return is_file($configured) ? $configured : true;
        }

        $candidates = array_filter([
            storage_path('app/certs/cacert.pem'),
            (string) env('CURL_CA_BUNDLE', ''),
            (string) ini_get('curl.cainfo'),
            (string) ini_get('openssl.cafile'),
        ]);

        foreach ($candidates as $path) {
            if (is_string($path) && $path !== '' && is_file($path)) {
                return $path;
            }
        }

        return true;
    }
}
