<?php

namespace App\Services;

use App\Models\ActivityLog;
use App\Models\EmailNotificationRule;
use App\Models\Employee;
use App\Models\EmployeeAvailability;
use App\Models\EmployeeTraining;
use App\Models\HistogramScheduleOverride;
use App\Models\Nrm;
use App\Models\Part;
use App\Models\Project;
use App\Models\ProjectTask;
use App\Models\SalesToolProjectProposal;
use App\Models\Team;
use App\Models\TrainingCourse;
use App\Models\TtHoursCache;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Throwable;

class SystemMonitorService
{
    public function __construct(
        private readonly TimeTrackingService $timeTracking,
        private readonly GoogleDriveQuotationsService $googleDriveQuotations,
        private readonly OutlookGraphService $outlookGraph,
    ) {}

    public function snapshot(): array
    {
        $checkedAt = Carbon::now();
        $database = $this->checkDatabase();
        $cache = $this->checkCache();

        $functions = $database['status'] === 'ok'
            ? $this->functionChecks()
            : [];
        $integrations = $this->integrationSnapshots();
        $recentActivity = $database['status'] === 'ok'
            ? $this->recentActivity()
            : [];

        $platform = [
            'app' => config('app.name', 'Workplanner 2.0'),
            'env' => (string) config('app.env', 'production'),
            'debug' => (bool) config('app.debug'),
            'php' => PHP_VERSION,
            'laravel' => app()->version(),
            'database' => $database,
            'cache' => $cache,
        ];

        $items = array_merge(
            [$database, $cache],
            $functions,
            $integrations,
        );

        return [
            'checked_at' => $checkedAt->toIso8601String(),
            'overall' => $this->aggregateStatus($items),
            'platform' => $platform,
            'functions' => $functions,
            'integrations' => $integrations,
            'recent_activity' => $recentActivity,
        ];
    }

    /**
     * @param  list<string>  $targets
     */
    public function probe(array $targets): array
    {
        $results = [];

        foreach ($targets as $target) {
            $results[$target] = match ($target) {
                'timetracking' => $this->probeTimeTracking(),
                'google_sheets' => $this->probeGoogleSheets(),
                'google_drive_quotations' => $this->probeGoogleDriveQuotations(),
                'sales_tool' => $this->probeSalesTool(),
                'outlook_deals' => $this->probeOutlook('deals'),
                'outlook_leads' => $this->probeOutlook('leads'),
                default => $this->statusItem($target, $target, 'unknown', 'Unknown probe target.'),
            };
        }

        return [
            'checked_at' => Carbon::now()->toIso8601String(),
            'results' => $results,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function checkDatabase(): array
    {
        $started = microtime(true);

        try {
            DB::select('select 1');

            return $this->statusItem('database', 'Database', 'ok', 'Connected.', [
                'driver' => (string) config('database.default'),
                'latency_ms' => $this->elapsedMs($started),
            ]);
        } catch (Throwable $exception) {
            return $this->statusItem('database', 'Database', 'error', 'Unable to reach the database.', [
                'driver' => (string) config('database.default'),
                'latency_ms' => $this->elapsedMs($started),
                'detail' => $exception->getMessage(),
            ]);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function checkCache(): array
    {
        $driver = (string) config('cache.default', 'file');
        $key = 'wp2:system-monitor:'.bin2hex(random_bytes(4));
        $started = microtime(true);

        try {
            Cache::put($key, 'ok', 10);
            $value = Cache::get($key);
            Cache::forget($key);

            if ($value !== 'ok') {
                return $this->statusItem('cache', 'Cache', 'warn', 'Cache did not round-trip a test value.', [
                    'driver' => $driver,
                    'latency_ms' => $this->elapsedMs($started),
                ]);
            }

            return $this->statusItem('cache', 'Cache', 'ok', 'Read/write succeeded.', [
                'driver' => $driver,
                'latency_ms' => $this->elapsedMs($started),
            ]);
        } catch (Throwable $exception) {
            return $this->statusItem('cache', 'Cache', 'error', 'Cache is not available.', [
                'driver' => $driver,
                'latency_ms' => $this->elapsedMs($started),
                'detail' => $exception->getMessage(),
            ]);
        }
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function functionChecks(): array
    {
        return [
            $this->safeCheck('projects', 'Project Data Entry', '/projects', function () {
                $projects = Project::count();
                $active = Project::query()->where('status', '!=', 'completed')->count();
                $parts = Part::count();
                $tasks = ProjectTask::count();
                $openTasks = ProjectTask::query()->where('done', false)->count();

                return $this->functionItem(
                    'projects',
                    'Project Data Entry',
                    '/projects',
                    $projects === 0 ? 'warn' : 'ok',
                    $projects === 0 ? 'No projects in the database.' : 'Projects, parts, and tasks are available.',
                    [
                        'projects' => $projects,
                        'active_projects' => $active,
                        'parts' => $parts,
                        'tasks' => $tasks,
                        'open_tasks' => $openTasks,
                    ],
                    $this->lastActivity(['pde']),
                );
            }),
            $this->safeCheck('algorithm', 'Scheduling algorithm', '/projects', function () {
                $tasks = $this->schedulableTasksQuery()->count();
                $assigned = $this->schedulableTasksQuery()->where($this->filledColumn('algorithm_1'))->count();
                $openUnassigned = $this->schedulableTasksQuery()
                    ->where(function ($query) {
                        $query->whereNull('algorithm_1')->orWhere('algorithm_1', '');
                    })
                    ->where(function ($query) {
                        $query->whereNull('override_1')->orWhere('override_1', '');
                    })
                    ->count();
                $status = $tasks === 0 ? 'warn' : ($openUnassigned > 0 ? 'warn' : 'ok');
                $message = $tasks === 0
                    ? 'No open tasks with plan hours to schedule.'
                    : ($openUnassigned > 0
                        ? "{$openUnassigned} open task(s) with plan hours have no algorithm or override assignee."
                        : 'Open tasks with plan hours have schedule assignees.');

                return $this->functionItem(
                    'algorithm',
                    'Scheduling algorithm',
                    '/projects',
                    $status,
                    $message,
                    [
                        'tasks' => $tasks,
                        'assigned_algorithm_1' => $assigned,
                        'open_unassigned' => $openUnassigned,
                    ],
                    $this->lastActivity(['pde'], 'algorithm_save'),
                );
            }),
            $this->safeCheck('histogram', 'Resource Histogram', '/resource-histogram', function () {
                $overrides = HistogramScheduleOverride::count();
                $assigned = ProjectTask::query()
                    ->where(function ($query) {
                        $query->where($this->filledColumn('algorithm_1'))
                            ->orWhere($this->filledColumn('override_1'));
                    })
                    ->count();

                return $this->functionItem(
                    'histogram',
                    'Resource Histogram',
                    '/resource-histogram',
                    $assigned === 0 ? 'warn' : 'ok',
                    $assigned === 0 ? 'No scheduled assignments to display.' : 'Histogram assignments are present.',
                    [
                        'assigned_tasks' => $assigned,
                        'bar_overrides' => $overrides,
                    ],
                    $this->lastActivity(['histogram']),
                );
            }),
            $this->safeCheck('trainings', 'Trainings', '/trainings', function () {
                $courses = TrainingCourse::count();
                $assignments = EmployeeTraining::count();
                $active = EmployeeTraining::query()
                    ->whereNotIn('status', ['completed'])
                    ->count();

                return $this->functionItem(
                    'trainings',
                    'Trainings',
                    '/trainings',
                    $assignments === 0 && $courses === 0 ? 'warn' : 'ok',
                    $assignments === 0 ? 'No training assignments yet.' : 'Training courses and assignments are available.',
                    [
                        'courses' => $courses,
                        'assignments' => $assignments,
                        'active_assignments' => $active,
                    ],
                    $this->lastActivity(['Trainings']),
                );
            }),
            $this->safeCheck('operatives', 'Operatives Allocation', '/operatives-allocation', function () {
                $employees = Employee::count();
                $teams = Team::count();
                $nrms = Nrm::count();
                $allocations = DB::table('employee_nrm')->count();
                $withoutTeam = Employee::query()->whereNull('team_id')->count();

                $status = $employees === 0 ? 'warn' : ($withoutTeam > 0 ? 'warn' : 'ok');
                $message = $employees === 0
                    ? 'No operatives in the database.'
                    : ($withoutTeam > 0
                        ? "{$withoutTeam} operative(s) are not assigned to a team."
                        : 'Operatives, teams, and NRM allocations are available.');

                return $this->functionItem(
                    'operatives',
                    'Operatives Allocation',
                    '/operatives-allocation',
                    $status,
                    $message,
                    [
                        'employees' => $employees,
                        'teams' => $teams,
                        'nrms' => $nrms,
                        'nrm_allocations' => $allocations,
                        'without_team' => $withoutTeam,
                    ],
                    null,
                );
            }),
            $this->safeCheck('tt_hours', 'TT Project Hours', '/tt-project-hours', function () {
                $cache = TtHoursCache::query()
                    ->where('scope_key', TtHoursCache::SCOPE_GLOBAL)
                    ->first();
                $fetchedAt = $cache?->fetched_at;
                $stale = $fetchedAt && $fetchedAt->lt(Carbon::now()->subDays(7));
                $summaryCount = is_array($cache?->payload['summaries'] ?? null)
                    ? count($cache->payload['summaries'])
                    : 0;

                if (! $cache) {
                    $status = 'warn';
                    $message = 'Time Tracking hours have not been synced into Work Planner yet.';
                } elseif ($stale) {
                    $status = 'warn';
                    $message = 'TT hours cache is older than 7 days.';
                } else {
                    $status = 'ok';
                    $message = 'TT hours cache is present.';
                }

                return $this->functionItem(
                    'tt_hours',
                    'TT Project Hours',
                    '/tt-project-hours',
                    $status,
                    $message,
                    [
                        'summary_count' => $summaryCount,
                        'fetched_at' => $fetchedAt?->toIso8601String(),
                        'date_start' => $cache?->date_start?->format('Y-m-d'),
                        'date_end' => $cache?->date_end?->format('Y-m-d'),
                    ],
                    $fetchedAt?->toIso8601String(),
                );
            }),
            $this->safeCheck('availability', 'User Availability', '/user-availability', function () {
                $rows = EmployeeAvailability::count();
                $employeesWith = (int) DB::table('employee_availabilities')->distinct()->count('employee_id');
                $latestDate = EmployeeAvailability::query()->max('date');
                $latestUpdated = EmployeeAvailability::query()->max('updated_at');
                $monthStart = Carbon::now()->startOfMonth()->toDateString();
                $currentMonthRows = EmployeeAvailability::query()
                    ->whereDate('date', '>=', $monthStart)
                    ->count();

                $status = $rows === 0 ? 'warn' : ($currentMonthRows === 0 ? 'warn' : 'ok');
                $message = $rows === 0
                    ? 'No availability rows stored.'
                    : ($currentMonthRows === 0
                        ? 'No availability rows for the current month.'
                        : 'Availability data is present for the current month.');

                return $this->functionItem(
                    'availability',
                    'User Availability',
                    '/user-availability',
                    $status,
                    $message,
                    [
                        'rows' => $rows,
                        'employees_with_availability' => $employeesWith,
                        'current_month_rows' => $currentMonthRows,
                        'latest_date' => $latestDate,
                    ],
                    $latestUpdated ? Carbon::parse($latestUpdated)->toIso8601String() : null,
                );
            }),
            $this->safeCheck('dl_hours', 'DL Input Hours', '/dl-input-hours', function () {
                $updated = ProjectTask::query()->where($this->filledColumn('dl_progress_updated'))->count();
                $withDlOwner = ProjectTask::query()->where($this->filledColumn('dl_owner'))->count();
                $approved = ProjectTask::query()->where('dl_sec_hrs_approved', true)->count();

                return $this->functionItem(
                    'dl_hours',
                    'DL Input Hours',
                    '/dl-input-hours',
                    'ok',
                    'DL hours and progress fields are readable.',
                    [
                        'tasks_with_dl_progress' => $updated,
                        'tasks_with_dl_owner' => $withDlOwner,
                        'section_hours_approved' => $approved,
                    ],
                    $this->lastActivity(['dl']),
                );
            }),
            $this->safeCheck('project_progress', "Measurer's Time Planning", '/project-progress', function () {
                $withSectionHours = ProjectTask::query()
                    ->where($this->filledColumn('sec_hrs_total'))
                    ->count();

                return $this->functionItem(
                    'project_progress',
                    "Measurer's Time Planning",
                    '/project-progress',
                    'ok',
                    $withSectionHours === 0
                        ? 'No measurer section hours have been entered yet.'
                        : 'Section-hour entries are present.',
                    [
                        'tasks_with_section_hours' => $withSectionHours,
                    ],
                    $this->lastActivity(['pde', 'dl']),
                );
            }),
            $this->safeCheck('users', 'Users & access', '/admin/access-permissions', function () {
                $users = User::count();
                $admins = User::query()->where('is_admin', true)->count();
                $active = User::query()->where('active', true)->count();
                $inactive = max(0, $users - $active);

                return $this->functionItem(
                    'users',
                    'Users & access',
                    '/admin/access-permissions',
                    $admins === 0 ? 'error' : 'ok',
                    $admins === 0 ? 'No administrator accounts found.' : 'User accounts and admin access are in place.',
                    [
                        'users' => $users,
                        'active_users' => $active,
                        'inactive_users' => $inactive,
                        'admins' => $admins,
                    ],
                    null,
                );
            }),
            $this->safeCheck('email_rules', 'Email notifications', '/admin/email-notifications', function () {
                $rules = EmailNotificationRule::count();
                $enabled = EmailNotificationRule::query()->where('enabled', true)->count();
                $emailEnabled = EmailNotificationRule::query()
                    ->where('enabled', true)
                    ->where('email_enabled', true)
                    ->count();

                return $this->functionItem(
                    'email_rules',
                    'Email notifications',
                    '/admin/email-notifications',
                    $rules === 0 ? 'warn' : 'ok',
                    $rules === 0 ? 'No notification rules configured.' : 'Notification rules are configured.',
                    [
                        'rules' => $rules,
                        'enabled' => $enabled,
                        'email_enabled' => $emailEnabled,
                    ],
                    null,
                );
            }),
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function integrationSnapshots(): array
    {
        return [
            $this->timeTrackingSnapshot(),
            $this->googleSheetsSnapshot(),
            $this->googleDriveQuotationsSnapshot(),
            $this->salesToolSnapshot(),
            $this->outlookSnapshot('deals'),
            $this->outlookSnapshot('leads'),
            $this->mailSnapshot(),
            $this->scheduledImportSnapshot(),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function timeTrackingSnapshot(): array
    {
        $login = trim((string) config('timetracking.login', ''));
        $passwordSet = trim((string) config('timetracking.password', '')) !== '';
        $baseUrl = (string) config('timetracking.base_url', '');
        $configured = $login !== '' && $passwordSet;

        $cache = TtHoursCache::query()
            ->where('scope_key', TtHoursCache::SCOPE_GLOBAL)
            ->first();

        if (! $configured) {
            $status = 'error';
            $message = 'Time Tracking login or password is not set in the backend .env.';
        } else {
            $status = 'ok';
            $message = 'Service account is configured. Run a live check to confirm login.';
        }

        return $this->statusItem('timetracking', 'Time Tracking', $status, $message, [
            'kind' => 'integration',
            'href' => '/tt-project-hours',
            'base_url' => $baseUrl,
            'login' => $login !== '' ? $login : null,
            'password_configured' => $passwordSet,
            'live' => 'pending',
            'cache_fetched_at' => $cache?->fetched_at?->toIso8601String(),
            'cache_summaries' => is_array($cache?->payload['summaries'] ?? null)
                ? count($cache->payload['summaries'])
                : 0,
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function googleSheetsSnapshot(): array
    {
        $apiKeySet = trim((string) config('availability.google_sheets_api_key', '')) !== '';
        $spreadsheetId = trim((string) config('availability.spreadsheet_id', ''));
        $months = (int) config('availability.scheduled_months_ahead', 3);

        if (! $apiKeySet) {
            $status = 'error';
            $message = 'GOOGLE_SHEETS_API_KEY is not set in the backend .env.';
        } elseif ($spreadsheetId === '') {
            $status = 'error';
            $message = 'AVAILABILITY_SPREADSHEET_ID is not set.';
        } else {
            $status = 'ok';
            $message = 'API key and spreadsheet are configured. Run a live check to confirm access.';
        }

        return $this->statusItem('google_sheets', 'Google Sheets', $status, $message, [
            'kind' => 'integration',
            'href' => '/user-availability',
            'spreadsheet_id' => $spreadsheetId !== '' ? $spreadsheetId : null,
            'api_key_configured' => $apiKeySet,
            'scheduled_months_ahead' => $months,
            'used_for' => ['User Availability import', 'PDE estimate hours (frontend key)'],
            'live' => 'pending',
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function googleDriveQuotationsSnapshot(): array
    {
        $raw = trim((string) config('google_drive.service_account_json', ''));
        $folderId = trim((string) config('google_drive.quotations_folder_id', ''));
        $serviceAccountConfigured = $raw !== '';
        $clientEmail = null;

        if ($serviceAccountConfigured) {
            $json = $raw;
            if (is_file($raw) && is_readable($raw)) {
                $json = (string) file_get_contents($raw);
            }
            $decoded = json_decode($json, true);
            if (is_array($decoded)) {
                $email = trim((string) ($decoded['client_email'] ?? ''));
                $clientEmail = $email !== '' ? $email : null;
            }
        }

        if (! $serviceAccountConfigured) {
            $status = 'error';
            $message = 'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not set in the backend .env.';
        } elseif ($folderId === '') {
            $status = 'error';
            $message = 'GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID is not set.';
        } elseif ($clientEmail === null) {
            $status = 'warn';
            $message = 'Service account JSON is set but client_email could not be read. Run a live check.';
        } else {
            $status = 'ok';
            $message = 'Service account and folder are configured. Run a live check to confirm Drive access.';
        }

        return $this->statusItem('google_drive_quotations', 'Google Drive quotations', $status, $message, [
            'kind' => 'integration',
            'href' => '/projects',
            'service_account_configured' => $serviceAccountConfigured,
            'client_email' => $clientEmail,
            'folder_id' => $folderId !== '' ? $folderId : null,
            'used_for' => ['New Project quotation file picker'],
            'live' => 'pending',
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function mailSnapshot(): array
    {
        $mailer = (string) config('mail.default', 'log');
        $from = (string) config('mail.from.address', '');
        $fromName = (string) config('mail.from.name', '');
        $host = (string) config("mail.mailers.{$mailer}.host", '');
        $placeholderFrom = $from === '' || $from === 'hello@example.com';

        if ($mailer === 'log' || $mailer === 'array') {
            $status = 'warn';
            $message = 'Mail is writing to the log, not sending to inboxes.';
        } elseif ($mailer === 'smtp' && ($host === '' || $host === '127.0.0.1')) {
            $status = 'warn';
            $message = 'SMTP is selected but the host looks like a local placeholder.';
        } elseif ($placeholderFrom) {
            $status = 'warn';
            $message = 'MAIL_FROM_ADDRESS is still the Laravel default.';
        } else {
            $status = 'ok';
            $message = 'Mailer is configured.';
        }

        return $this->statusItem('mail', 'Email / SMTP', $status, $message, [
            'kind' => 'integration',
            'href' => '/admin/email-notifications',
            'mailer' => $mailer,
            'from' => $from !== '' ? $from : null,
            'from_name' => $fromName !== '' ? $fromName : null,
            'host' => $mailer === 'smtp' && $host !== '' ? $host : null,
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function scheduledImportSnapshot(): array
    {
        $next = $this->nextScheduledImportAt();
        $latestUpdated = EmployeeAvailability::query()->max('updated_at');

        return $this->statusItem(
            'scheduled_import',
            'Scheduled availability import',
            'ok',
            'Runs Tuesday and Friday at 06:00 from the TSA Google Sheet.',
            [
                'kind' => 'integration',
                'href' => '/user-availability',
                'schedule' => 'Tue & Fri 06:00',
                'command' => 'availabilities:import-scheduled',
                'next_run_at' => $next,
                'last_availability_update' => $latestUpdated
                    ? Carbon::parse($latestUpdated)->toIso8601String()
                    : null,
            ],
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function salesToolSnapshot(): array
    {
        $baseUrl = trim((string) config('sales_tool.base_url', ''));
        $tokenSet = trim((string) config('sales_tool.integration_token', '')) !== '';
        $liveSync = (bool) config('sales_tool.live_sync_enabled', true);

        $pending = 0;
        $lastProposalAt = null;
        try {
            $pending = (int) SalesToolProjectProposal::query()->pending()->count();
            $latest = SalesToolProjectProposal::query()->max('updated_at');
            $lastProposalAt = $latest ? Carbon::parse($latest)->toIso8601String() : null;
        } catch (Throwable) {
            // Table may be missing on older DBs — keep snapshot usable.
        }

        if (! $tokenSet) {
            $status = 'error';
            $message = 'SALES_TOOL_INTEGRATION_TOKEN is not set in the backend .env.';
        } elseif ($baseUrl === '') {
            $status = 'warn';
            $message = 'Integration token is set but SALES_TOOL_BASE_URL is empty.';
        } elseif (! $liveSync) {
            $status = 'warn';
            $message = 'Sales Tool inbound API is ready; live DB sync is disabled.';
        } else {
            $status = 'ok';
            $message = 'Sales Tool integration is configured. Run a live check to confirm the ST database.';
        }

        return $this->statusItem('sales_tool', 'Sales Tool', $status, $message, [
            'kind' => 'integration',
            'href' => '/',
            'base_url' => $baseUrl !== '' ? $baseUrl : null,
            'token_configured' => $tokenSet,
            'live_sync_enabled' => $liveSync,
            'pending_proposals' => $pending,
            'st_last_sync_at' => $lastProposalAt,
            'used_for' => ['Home project proposals', 'CRM deal → WP proposal sync'],
            'live' => 'pending',
        ]);
    }

    /**
     * @param  'deals'|'leads'  $profile
     * @return array<string, mixed>
     */
    private function outlookSnapshot(string $profile): array
    {
        $profile = $profile === 'leads' ? 'leads' : 'deals';
        $config = $this->outlookGraph->profileConfig($profile);
        $label = trim((string) ($config['label'] ?? ($profile === 'leads' ? 'Outlook — Angela (Leads)' : 'Outlook — Deals & Enquiries')));
        $mailbox = trim((string) ($config['mailbox'] ?? ''));
        $auth = trim((string) ($config['auth'] ?? 'Microsoft Graph app (server credentials)'));
        $usedFor = trim((string) ($config['used_for'] ?? ''));
        $id = $profile === 'leads' ? 'outlook_leads' : 'outlook_deals';

        $tenantId = trim((string) ($config['tenant_id'] ?? ''));
        $clientId = trim((string) ($config['client_id'] ?? ''));
        $clientSecret = trim((string) ($config['client_secret'] ?? ''));
        $credentialsConfigured = $tenantId !== '' && $clientId !== '' && $clientSecret !== '';

        if (! $credentialsConfigured) {
            $status = 'error';
            $message = $profile === 'leads'
                ? 'Outlook Leads Graph credentials are not set (MICROSOFT_* / OUTLOOK_LEADS_*).'
                : 'Outlook Deals Graph credentials are not set (OUTLOOK_* / CLIENT_*).';
        } elseif ($mailbox === '') {
            $status = 'error';
            $message = 'Outlook mailbox is not configured for this profile.';
        } else {
            $status = 'ok';
            $message = 'Mailbox and Graph credentials are configured. Run a live check to confirm token access.';
        }

        return $this->statusItem($id, $label, $status, $message, [
            'kind' => 'integration',
            'href' => $profile === 'leads' ? '/crm/leads' : '/crm',
            'mailbox' => $mailbox !== '' ? $mailbox : null,
            'auth' => $auth !== '' ? $auth : null,
            'credentials_configured' => $credentialsConfigured,
            'used_for' => $usedFor !== '' ? [$usedFor] : null,
            'live' => 'pending',
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function probeTimeTracking(): array
    {
        $started = microtime(true);
        $baseUrl = (string) config('timetracking.base_url', '');

        try {
            $this->timeTracking->healthCheck(12);

            return $this->statusItem('timetracking', 'Time Tracking', 'ok', 'Service account login succeeded.', [
                'kind' => 'integration',
                'href' => '/tt-project-hours',
                'base_url' => $baseUrl,
                'login' => $this->timeTracking->serviceLoginName() ?: null,
                'live' => 'ok',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        } catch (Throwable $exception) {
            return $this->statusItem(
                'timetracking',
                'Time Tracking',
                'error',
                $exception->getMessage(),
                [
                    'kind' => 'integration',
                    'href' => '/tt-project-hours',
                    'base_url' => $baseUrl,
                    'login' => $this->timeTracking->serviceLoginName() ?: null,
                    'live' => 'error',
                    'latency_ms' => $this->elapsedMs($started),
                ],
            );
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function probeGoogleSheets(): array
    {
        $started = microtime(true);
        $apiKey = trim((string) config('availability.google_sheets_api_key', ''));
        $spreadsheetId = trim((string) config('availability.spreadsheet_id', ''));

        if ($apiKey === '') {
            return $this->statusItem('google_sheets', 'Google Sheets', 'error', 'GOOGLE_SHEETS_API_KEY is not set.', [
                'kind' => 'integration',
                'href' => '/user-availability',
                'live' => 'error',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        }

        if ($spreadsheetId === '') {
            return $this->statusItem('google_sheets', 'Google Sheets', 'error', 'AVAILABILITY_SPREADSHEET_ID is not set.', [
                'kind' => 'integration',
                'href' => '/user-availability',
                'live' => 'error',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        }

        try {
            $client = new GoogleSheetsValuesClient($apiKey, $spreadsheetId);
            $titles = $client->listSheetTitles();

            return $this->statusItem(
                'google_sheets',
                'Google Sheets',
                $titles === [] ? 'warn' : 'ok',
                $titles === []
                    ? 'Spreadsheet is reachable but has no sheet tabs.'
                    : 'Spreadsheet is reachable.',
                [
                    'kind' => 'integration',
                    'href' => '/user-availability',
                    'spreadsheet_id' => $spreadsheetId,
                    'sheet_count' => count($titles),
                    'sheet_titles' => array_slice($titles, 0, 12),
                    'live' => $titles === [] ? 'warn' : 'ok',
                    'latency_ms' => $this->elapsedMs($started),
                ],
            );
        } catch (Throwable $exception) {
            return $this->statusItem('google_sheets', 'Google Sheets', 'error', $exception->getMessage(), [
                'kind' => 'integration',
                'href' => '/user-availability',
                'spreadsheet_id' => $spreadsheetId,
                'live' => 'error',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function probeGoogleDriveQuotations(): array
    {
        $started = microtime(true);
        $folderId = trim((string) config('google_drive.quotations_folder_id', ''));
        $raw = trim((string) config('google_drive.service_account_json', ''));

        if ($raw === '') {
            return $this->statusItem(
                'google_drive_quotations',
                'Google Drive quotations',
                'error',
                'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON is not set.',
                [
                    'kind' => 'integration',
                    'href' => '/projects',
                    'live' => 'error',
                    'latency_ms' => $this->elapsedMs($started),
                ],
            );
        }

        if ($folderId === '') {
            return $this->statusItem(
                'google_drive_quotations',
                'Google Drive quotations',
                'error',
                'GOOGLE_DRIVE_QUOTATIONS_FOLDER_ID is not set.',
                [
                    'kind' => 'integration',
                    'href' => '/projects',
                    'live' => 'error',
                    'latency_ms' => $this->elapsedMs($started),
                ],
            );
        }

        try {
            $files = $this->googleDriveQuotations->listQuotationSpreadsheets();
            $count = count($files);
            $sampleNames = array_slice(array_map(
                static fn (array $file) => (string) ($file['name'] ?? ''),
                $files,
            ), 0, 8);

            return $this->statusItem(
                'google_drive_quotations',
                'Google Drive quotations',
                $count === 0 ? 'warn' : 'ok',
                $count === 0
                    ? 'Drive is reachable but no spreadsheet files were found in the quotations folder.'
                    : "Drive is reachable. Found {$count} quotation spreadsheet(s).",
                [
                    'kind' => 'integration',
                    'href' => '/projects',
                    'folder_id' => $folderId,
                    'quotation_count' => $count,
                    'quotation_names' => array_values(array_filter($sampleNames)),
                    'live' => $count === 0 ? 'warn' : 'ok',
                    'latency_ms' => $this->elapsedMs($started),
                ],
            );
        } catch (Throwable $exception) {
            return $this->statusItem(
                'google_drive_quotations',
                'Google Drive quotations',
                'error',
                $exception->getMessage(),
                [
                    'kind' => 'integration',
                    'href' => '/projects',
                    'folder_id' => $folderId,
                    'live' => 'error',
                    'latency_ms' => $this->elapsedMs($started),
                ],
            );
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function probeSalesTool(): array
    {
        $started = microtime(true);
        $baseUrl = trim((string) config('sales_tool.base_url', ''));
        $tokenSet = trim((string) config('sales_tool.integration_token', '')) !== '';
        $liveSync = (bool) config('sales_tool.live_sync_enabled', true);

        $pending = 0;
        try {
            $pending = (int) SalesToolProjectProposal::query()->pending()->count();
        } catch (Throwable) {
            // ignore
        }

        if (! $tokenSet) {
            return $this->statusItem('sales_tool', 'Sales Tool', 'error', 'SALES_TOOL_INTEGRATION_TOKEN is not set.', [
                'kind' => 'integration',
                'href' => '/',
                'base_url' => $baseUrl !== '' ? $baseUrl : null,
                'token_configured' => false,
                'live_sync_enabled' => $liveSync,
                'pending_proposals' => $pending,
                'live' => 'error',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        }

        try {
            DB::connection('sales_tool')->select('select 1 as ok');

            return $this->statusItem(
                'sales_tool',
                'Sales Tool',
                'ok',
                'Sales Tool database is reachable.',
                [
                    'kind' => 'integration',
                    'href' => '/',
                    'base_url' => $baseUrl !== '' ? $baseUrl : null,
                    'token_configured' => true,
                    'live_sync_enabled' => $liveSync,
                    'pending_proposals' => $pending,
                    'live' => 'ok',
                    'latency_ms' => $this->elapsedMs($started),
                ],
            );
        } catch (Throwable $exception) {
            $status = $liveSync ? 'error' : 'warn';
            $message = $liveSync
                ? 'Sales Tool database is unreachable: '.$exception->getMessage()
                : 'Live sync is disabled; ST DB check failed (inbound API token is still set).';

            return $this->statusItem('sales_tool', 'Sales Tool', $status, $message, [
                'kind' => 'integration',
                'href' => '/',
                'base_url' => $baseUrl !== '' ? $baseUrl : null,
                'token_configured' => true,
                'live_sync_enabled' => $liveSync,
                'pending_proposals' => $pending,
                'live' => $status,
                'latency_ms' => $this->elapsedMs($started),
                'detail' => $exception->getMessage(),
            ]);
        }
    }

    /**
     * @param  'deals'|'leads'  $profile
     * @return array<string, mixed>
     */
    private function probeOutlook(string $profile): array
    {
        $started = microtime(true);
        $profile = $profile === 'leads' ? 'leads' : 'deals';
        $config = $this->outlookGraph->profileConfig($profile);
        $label = trim((string) ($config['label'] ?? ($profile === 'leads' ? 'Outlook — Angela (Leads)' : 'Outlook — Deals & Enquiries')));
        $mailbox = trim((string) ($config['mailbox'] ?? ''));
        $id = $profile === 'leads' ? 'outlook_leads' : 'outlook_deals';
        $href = $profile === 'leads' ? '/crm/leads' : '/crm';

        if ($mailbox === '') {
            return $this->statusItem($id, $label, 'error', 'Outlook mailbox is not configured.', [
                'kind' => 'integration',
                'href' => $href,
                'mailbox' => null,
                'live' => 'error',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        }

        try {
            $this->outlookGraph->accessToken($profile);

            return $this->statusItem($id, $label, 'ok', 'Microsoft Graph token obtained.', [
                'kind' => 'integration',
                'href' => $href,
                'mailbox' => $mailbox,
                'credentials_configured' => true,
                'live' => 'ok',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        } catch (Throwable $exception) {
            return $this->statusItem($id, $label, 'error', $exception->getMessage(), [
                'kind' => 'integration',
                'href' => $href,
                'mailbox' => $mailbox,
                'live' => 'error',
                'latency_ms' => $this->elapsedMs($started),
            ]);
        }
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function recentActivity(): array
    {
        try {
            return ActivityLog::query()
                ->orderByDesc('created_at')
                ->limit(12)
                ->get(['id', 'user_name', 'area', 'action', 'summary', 'created_at'])
                ->map(fn (ActivityLog $log) => [
                    'id' => $log->id,
                    'user_name' => $log->user_name,
                    'area' => $log->area,
                    'action' => $log->action,
                    'summary' => $log->summary,
                    'created_at' => $log->created_at?->toIso8601String(),
                ])
                ->all();
        } catch (Throwable) {
            return [];
        }
    }

    /**
     * @param  list<string>  $areas
     */
    private function lastActivity(array $areas, ?string $action = null): ?string
    {
        try {
            $query = ActivityLog::query()->whereIn('area', $areas);
            if ($action) {
                $query->where('action', $action);
            }

            $value = $query->max('created_at');

            return $value ? Carbon::parse($value)->toIso8601String() : null;
        } catch (Throwable) {
            return null;
        }
    }

    private function nextScheduledImportAt(): string
    {
        $now = Carbon::now();

        for ($offset = 0; $offset < 10; $offset++) {
            $candidate = $now->copy()->startOfDay()->addDays($offset)->setTime(6, 0, 0);
            if (in_array((int) $candidate->dayOfWeekIso, [2, 5], true) && $candidate->greaterThan($now)) {
                return $candidate->toIso8601String();
            }
        }

        return $now->copy()->next(Carbon::TUESDAY)->setTime(6, 0, 0)->toIso8601String();
    }

    /**
     * @param  callable(): array<string, mixed>  $callback
     * @return array<string, mixed>
     */
    private function safeCheck(string $id, string $label, string $href, callable $callback): array
    {
        try {
            return $callback();
        } catch (Throwable $exception) {
            return $this->functionItem(
                $id,
                $label,
                $href,
                'error',
                'Unable to read this function: '.$exception->getMessage(),
                [],
                null,
            );
        }
    }

    /**
     * @param  array<string, mixed>  $metrics
     * @return array<string, mixed>
     */
    private function functionItem(
        string $id,
        string $label,
        string $href,
        string $status,
        string $message,
        array $metrics,
        ?string $lastActivityAt,
    ): array {
        return $this->statusItem($id, $label, $status, $message, [
            'kind' => 'function',
            'href' => $href,
            'metrics' => $metrics,
            'last_activity_at' => $lastActivityAt,
        ]);
    }

    /**
     * @param  array<string, mixed>  $extra
     * @return array<string, mixed>
     */
    private function statusItem(string $id, string $label, string $status, string $message, array $extra = []): array
    {
        return array_merge([
            'id' => $id,
            'label' => $label,
            'status' => $status,
            'message' => $message,
        ], $extra);
    }

    /**
     * Open tasks that have plan hours (the set the scheduler actually considers).
     */
    private function schedulableTasksQuery()
    {
        return ProjectTask::query()
            ->where(function ($query) {
                $query->where('done', false)->orWhereNull('done');
            })
            ->whereNotNull('plan')
            ->where('plan', '!=', '')
            ->whereRaw('CAST(plan AS DECIMAL(12, 2)) > 0');
    }

    /**
     * @return \Closure(\Illuminate\Database\Eloquent\Builder): void
     */
    private function filledColumn(string $column): \Closure
    {
        return function ($query) use ($column) {
            $query->whereNotNull($column)->where($column, '!=', '');
        };
    }

    /**
     * @param  list<array<string, mixed>>  $items
     */
    private function aggregateStatus(array $items): string
    {
        $statuses = array_map(fn (array $item) => $item['status'] ?? 'unknown', $items);

        if (in_array('error', $statuses, true)) {
            return 'error';
        }
        if (in_array('warn', $statuses, true)) {
            return 'warn';
        }
        if (in_array('unknown', $statuses, true)) {
            return 'unknown';
        }

        return 'ok';
    }

    private function elapsedMs(float $started): int
    {
        return (int) max(0, round((microtime(true) - $started) * 1000));
    }
}
