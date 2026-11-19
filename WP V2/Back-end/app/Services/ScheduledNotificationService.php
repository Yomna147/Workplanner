<?php

namespace App\Services;

use App\Models\EmailNotificationRule;
use App\Models\Employee;
use App\Models\EmployeeTraining;
use App\Models\Project;
use App\Models\ScheduledNotificationNotice;
use App\Models\User;
use App\Support\DlQuickUpdate;
use App\Support\EmailNotificationCaseTypes;
use App\Support\EmployeeNames;
use Carbon\Carbon;
use Illuminate\Database\QueryException;
use Illuminate\Support\Collection;

class ScheduledNotificationService
{
    /** @var list<string> */
    private const TRAINING_AUDIENCE_CASES = [
        'incomplete_training_days',
        'capacity_gap_hours',
        'training_project_override',
        'trainee_over_capacity_hours',
    ];

    public function __construct(private EmailNotificationService $emailNotifications) {}

    /**
     * Evaluate cron-style scheduled rules (DL weekly status, incomplete training, etc.).
     *
     * @param  list<string>|null  $onlyCaseTypes
     * @return array{
     *   dry_run: bool,
     *   matches_found: int,
     *   delivered: array{
     *     in_app: list<string>,
     *     emails_sent: int,
     *     triggered_rules: list<string>,
     *     email_errors: list<array{rule: string, error: string}>,
     *     summary: string
     *   },
     *   by_case: array<string, int>,
     *   skipped: list<string>,
     *   preview: list<array{rule: string, item_name: string, detail: string}>
     * }
     */
    public function run(bool $dryRun = false, ?array $onlyCaseTypes = null): array
    {
        $rules = $this->enabledScheduledRules($onlyCaseTypes);
        $matches = [];
        $skipped = [];
        $byCase = [];

        foreach ($rules as $rule) {
            $evaluator = EmailNotificationCaseTypes::resolveEvaluator($rule->case_type);
            $caseMatches = match ($evaluator) {
                'dl_update_overdue' => $this->matchDlWeeklyStatus($rule, DlQuickUpdate::STATUS_OVERDUE, alsoNever: true, dryRun: $dryRun),
                'dl_edited_after_submit' => $this->matchDlWeeklyStatus($rule, DlQuickUpdate::STATUS_STALE, alsoNever: false, dryRun: $dryRun),
                'new_project_docs_ready' => $this->matchNewProjectDocsReady($rule, $dryRun),
                'incomplete_training_days' => $this->matchIncompleteTrainings($rule, $dryRun),
                'capacity_gap_hours', 'trainee_over_capacity_hours' => $this->skipHistogramDependent($rule, $skipped),
                'histogram_schedule_override', 'training_project_override' => [],
                default => [],
            };

            $byCase[$rule->case_type] = count($caseMatches);
            $matches = array_merge($matches, $caseMatches);
        }

        return $this->finish($matches, $dryRun, $skipped, $byCase);
    }

    /**
     * Fire when training is confirmed over project work.
     *
     * @param  list<array<string, mixed>>  $conflicts
     * @return array{
     *   in_app: list<string>,
     *   emails_sent: int,
     *   triggered_rules: list<string>,
     *   email_errors: list<array{rule: string, error: string}>,
     *   summary: string
     * }
     */
    public function onTrainingProjectOverride(EmployeeTraining $training, array $conflicts, ?User $actor = null): array
    {
        if ($conflicts === [] || ! (bool) $training->confirm_override) {
            return $this->emptyDelivered();
        }

        $rule = $this->enabledRuleByCase('training_project_override');
        if ($rule === null) {
            return $this->emptyDelivered();
        }

        $training->loadMissing(['employee.team']);
        $trainee = trim((string) ($training->employee?->name ?? ''))
            ?: trim(($training->employee?->first_name ?? '').' '.($training->employee?->last_name ?? ''))
            ?: 'Unknown trainee';
        $team = trim((string) ($training->employee?->team?->name ?? '')) ?: 'Not set';
        $course = trim((string) $training->title) ?: 'Untitled course';
        $who = trim((string) ($actor?->name ?? '')) ?: 'System';
        $conflictCount = count($conflicts);
        $slot = ($training->start_date?->toDateString() ?? '').':'.($training->end_date?->toDateString() ?? '');
        $range = $this->formatDateRange(
            $training->start_date?->toDateString(),
            $training->end_date?->toDateString(),
        );
        $conflictLines = collect($conflicts)
            ->map(function (array $conflict) {
                $project = trim((string) ($conflict['project_name'] ?? $conflict['project'] ?? '')) ?: 'Project';
                $task = trim((string) ($conflict['task_name'] ?? $conflict['task'] ?? '')) ?: 'task';
                $hours = $conflict['hours'] ?? $conflict['displaced_hours'] ?? null;
                $hoursLabel = is_numeric($hours) ? ' · '.rtrim(rtrim(number_format((float) $hours, 1), '0'), '.').'h' : '';

                return "• {$project} / {$task}{$hoursLabel}";
            })
            ->filter()
            ->take(8)
            ->values()
            ->all();
        if (count($conflicts) > 8) {
            $conflictLines[] = '• … +'.(count($conflicts) - 8).' more';
        }
        $detail = implode("\n", array_filter([
            "Team / DL: {$team}",
            "Dates: {$range}",
            "Confirmed by: {$who}",
            '',
            ...$conflictLines,
        ], fn ($line) => $line !== null));
        $title = $this->titleWithFirstName(
            "Training overrides project · {$course} · {$conflictCount} conflict".($conflictCount === 1 ? '' : 's'),
            $trainee,
        );

        $match = $this->remember(
            $rule,
            "training_project_override:{$training->id}:{$slot}",
            $trainee,
            $detail,
            [
                'employee_id' => $training->employee_id,
                'employee_training_id' => $training->id,
            ],
            personName: $trainee,
            titleOverride: $title,
        );

        if ($match === null) {
            return $this->emptyDelivered();
        }

        return $this->emailNotifications->deliverMatches('Training', $trainee, [$match]);
    }

    /**
     * Fire when durable histogram schedule overrides are saved.
     *
     * @param  list<array<string, mixed>>  $edits
     * @return array{
     *   in_app: list<string>,
     *   emails_sent: int,
     *   triggered_rules: list<string>,
     *   email_errors: list<array{rule: string, error: string}>,
     *   summary: string
     * }
     */
    public function onHistogramScheduleOverride(array $edits, ?User $actor = null): array
    {
        if ($edits === []) {
            return $this->emptyDelivered();
        }

        $rule = $this->enabledRuleByCase('histogram_schedule_override');
        if ($rule === null) {
            return $this->emptyDelivered();
        }

        $who = trim((string) ($actor?->name ?? '')) ?: 'System';
        $taskIds = collect($edits)
            ->map(fn ($edit) => (int) ($edit['task_id'] ?? 0))
            ->filter(fn (int $id) => $id > 0)
            ->unique()
            ->values()
            ->all();
        $editCount = count($edits);
        $taskLabel = $taskIds === []
            ? 'Histogram edits'
            : 'Task #'.implode(', #', array_slice($taskIds, 0, 5)).(count($taskIds) > 5 ? '…' : '');
        $hash = substr(sha1(json_encode([
            'tasks' => $taskIds,
            'count' => $editCount,
            'day' => Carbon::today()->toDateString(),
            'actor' => $who,
        ])), 0, 16);
        $editLines = collect($edits)
            ->map(function (array $edit) {
                $taskId = (int) ($edit['task_id'] ?? 0);
                $taskName = trim((string) ($edit['task_name'] ?? '')) ?: ($taskId > 0 ? "Task #{$taskId}" : 'Task');
                $employee = trim((string) ($edit['employee_name'] ?? $edit['employee'] ?? ''));
                $day = $this->formatDisplayDate($edit['day'] ?? $edit['date'] ?? null);
                $bits = array_values(array_filter([
                    $taskName,
                    $employee !== '' ? $employee : null,
                    $day !== '—' ? $day : null,
                ]));

                return '• '.implode(' · ', $bits);
            })
            ->unique()
            ->values()
            ->all();
        $shownLines = array_slice($editLines, 0, 8);
        if (count($editLines) > 8) {
            $shownLines[] = '• … +'.(count($editLines) - 8).' more';
        }
        $detail = implode("\n", [
            'Tasks: '.($taskIds === [] ? 'n/a' : '#'.implode(', #', $taskIds)),
            '',
            ...($shownLines !== [] ? $shownLines : ['• (details not available)']),
        ]);
        $title = $this->titleWithFirstName(
            "Histogram override · {$editCount} edit".($editCount === 1 ? '' : 's'),
            $who,
        );

        $match = $this->remember(
            $rule,
            "histogram_schedule_override:{$hash}",
            $taskLabel,
            $detail,
            [
                'project_task_id' => $taskIds[0] ?? null,
            ],
            personName: $who,
            titleOverride: $title,
        );

        if ($match === null) {
            return $this->emptyDelivered();
        }

        return $this->emailNotifications->deliverMatches('Resource Histogram', 'Schedule override', [$match]);
    }

    /**
     * @param  list<string>|null  $onlyCaseTypes
     * @return Collection<int, EmailNotificationRule>
     */
    private function enabledScheduledRules(?array $onlyCaseTypes): Collection
    {
        $values = EmailNotificationCaseTypes::scheduledValues();
        if ($onlyCaseTypes !== null && $onlyCaseTypes !== []) {
            $values = array_values(array_intersect($values, $onlyCaseTypes));
        }

        if ($values === []) {
            return collect();
        }

        return EmailNotificationRule::query()
            ->where('enabled', true)
            ->whereIn('case_type', $values)
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get();
    }

    private function enabledRuleByCase(string $caseType): ?EmailNotificationRule
    {
        return EmailNotificationRule::query()
            ->where('enabled', true)
            ->where('case_type', $caseType)
            ->orderBy('sort_order')
            ->orderBy('id')
            ->first();
    }

    /**
     * @return list<array{rule: EmailNotificationRule, item_name: string, detail: string}>
     */
    private function matchDlWeeklyStatus(
        EmailNotificationRule $rule,
        string $status,
        bool $alsoNever = false,
        bool $dryRun = false,
    ): array {
        $groups = $this->loadDlGroups();
        $weekStart = DlQuickUpdate::weekStart();
        $weekLabel = $weekStart->toDateString();
        $matches = [];

        foreach ($groups as $group) {
            $dlName = trim((string) ($group['dl_name'] ?? ''));
            if ($dlName === '' || strcasecmp($dlName, 'Unassigned') === 0) {
                continue;
            }

            $updateStatus = (string) ($group['update_status'] ?? '');
            $isMatch = $updateStatus === $status
                || ($alsoNever && $updateStatus === DlQuickUpdate::STATUS_NEVER);
            if (! $isMatch) {
                continue;
            }

            $team = trim((string) ($group['team_name'] ?? '')) ?: 'Not set';
            $teamId = isset($group['team_id']) ? (int) $group['team_id'] : 0;
            $lastSubmitted = $group['last_submitted_at'] ?? null;
            $lastUpdated = $group['last_updated'] ?? null;
            $projects = collect($group['projects'] ?? [])->values()->all();
            $projectCount = count($projects);
            // Skip empty digests — no projects means nothing useful to notify about.
            if ($projectCount === 0) {
                continue;
            }
            $weekEnd = $weekStart->copy()->addDays(6);
            $teamSnapshot = $this->loadDlTeamMemberSnapshot($teamId > 0 ? $teamId : null);
            $detail = $this->formatDlWeeklyBody(
                $team,
                $updateStatus,
                $weekStart,
                $weekEnd,
                $lastSubmitted,
                $lastUpdated,
                $projects,
                $teamSnapshot,
            );
            $title = $this->formatDlWeeklyTitle(
                $dlName,
                $updateStatus,
                $projectCount,
                count($teamSnapshot['issue_lines']),
            );

            // Overdue / never: rematch daily while still outstanding (24h-style repeat).
            // Stale: rematch when last_updated changes after submit.
            $dedupe = sprintf(
                '%s:%s:%s:%s',
                $rule->case_type,
                mb_strtolower($dlName),
                $weekLabel,
                $updateStatus === DlQuickUpdate::STATUS_STALE
                    ? (string) ($lastUpdated ?? 'stale')
                    : Carbon::today()->toDateString(),
            );

            $match = $this->remember($rule, $dedupe, $dlName, $detail, [
                'employee_id' => $group['employee_id'] ?? null,
                // Overdue DL also receives this notice (not only planners).
                'recipient_user_id' => $this->resolveDlUserId($group),
            ], persist: ! $dryRun, personName: $dlName, titleOverride: $title);
            if ($match !== null) {
                $matches[] = $match;
            }
        }

        return $matches;
    }

    /**
     * New projects: Have all docs + incomplete task Doc Supply (start) date has passed.
     * One notice per booked operative (algorithm/override slots) — not OAP owner/dl_owner.
     *
     * @return list<array{rule: EmailNotificationRule, item_name: string, detail: string, recipient_user_id?: int|null, title?: string|null}>
     */
    private function matchNewProjectDocsReady(EmailNotificationRule $rule, bool $dryRun = false): array
    {
        $today = Carbon::today();
        $dayKey = $today->toDateString();
        $byBooked = $this->loadNewProjectsDocsReadyByBooked($today);
        if ($byBooked === []) {
            return [];
        }

        $matches = [];
        foreach ($byBooked as $group) {
            $personNameFull = trim((string) ($group['person_name'] ?? ''));
            if ($personNameFull === '' || strcasecmp($personNameFull, 'Unassigned') === 0) {
                $personNameFull = 'Unassigned';
            }

            $projects = $group['projects'] ?? [];
            if ($projects === []) {
                continue;
            }

            $projectCount = count($projects);
            $detail = $this->formatNewProjectDocsReadyBody(
                (string) ($group['team_name'] ?? 'Not set'),
                $projects,
            );
            $baseTitle = $projectCount === 1
                ? 'New project · 1 project'
                : "New project · {$projectCount} projects";
            $personName = $personNameFull === 'Unassigned' ? '' : $personNameFull;
            $title = $personName === ''
                ? $baseTitle
                : $this->titleWithFirstName($baseTitle, $personName);

            $dedupe = sprintf(
                '%s:%s:%s',
                $rule->case_type,
                mb_strtolower($personNameFull),
                $dayKey,
            );

            $firstProjectId = (int) ($projects[0]['project_id'] ?? 0) ?: null;

            $match = $this->remember($rule, $dedupe, $personNameFull, $detail, [
                'employee_id' => $group['employee_id'] ?? null,
                'project_id' => $firstProjectId,
                'recipient_user_id' => $personNameFull === 'Unassigned'
                    ? null
                    : $this->resolvePersonUserId($group),
            ], persist: ! $dryRun, personName: $personName, titleOverride: $title);

            if ($match !== null) {
                $matches[] = $match;
            }
        }

        return $matches;
    }

    /**
     * Ready incomplete tasks grouped by histogram booking slots
     * (algorithm_1..3 / override_1..3) — not OAP owner / dl_owner.
     *
     * @return list<array{
     *   person_name: string,
     *   team_id: int|null,
     *   team_name: string,
     *   user_id: int|null,
     *   employee_id: int|null,
     *   task_count: int,
     *   projects: list<array{
     *     project_id: int,
     *     project_name: string,
     *     start_date: string,
     *     days_past_start: int,
     *     ready_task_count: int,
     *     task_names: list<string>
     *   }>
     * }>
     */
    private function loadNewProjectsDocsReadyByBooked(Carbon $today): array
    {
        // Newest projects first — only the 3 most recent ready projects notify.
        $projects = Project::query()
            ->with(['team', 'parts.tasks'])
            ->where('have_all_docs', true)
            ->where(function ($query) {
                $query->whereNull('status')
                    ->orWhereNotIn('status', ['completed', 'on_hold']);
            })
            ->orderByDesc('id')
            ->get();

        $employees = DlQuickUpdate::loadEmployees();
        EmployeeNames::warmEmployeeCache($employees);

        /** @var list<\App\Models\Project> $recentReady */
        $recentReady = [];
        /** @var array<string, array{person_name: string, team_id: int|null, team_name: string, user_id: int|null, employee_id: int|null, projects: array<int, array<string, mixed>>}> $byPerson */
        $byPerson = [];

        try {
            foreach ($projects as $project) {
                if (! $this->projectHasReadyBookedTasks($project, $today)) {
                    continue;
                }
                $recentReady[] = $project;
                if (count($recentReady) >= 3) {
                    break;
                }
            }

            foreach ($recentReady as $project) {
                $projectId = (int) $project->id;
                $projectName = trim((string) $project->name) ?: 'Untitled project';
                $projectTeamName = trim((string) ($project->team?->name ?? '')) ?: 'Not set';

                foreach ($project->parts as $part) {
                    foreach ($part->tasks as $task) {
                        if ((bool) $task->done) {
                            continue;
                        }
                        $progress = $this->parseProgressPercent($task->progress_per ?? null);
                        if ($progress !== null && $progress >= 100) {
                            continue;
                        }

                        $docRaw = trim((string) ($task->doc_supply ?? ''));
                        if ($docRaw === '') {
                            continue;
                        }

                        try {
                            $start = Carbon::parse($docRaw)->startOfDay();
                        } catch (\Throwable) {
                            continue;
                        }

                        if ($start->gt($today)) {
                            continue;
                        }

                        $bookedPeople = $this->resolveBookedPeopleOnTask($task);
                        if ($bookedPeople === []) {
                            continue;
                        }

                        $daysPast = max(0, (int) $start->diffInDays($today));
                        $taskName = trim((string) ($task->task_name ?? '')) ?: 'Untitled task';

                        foreach ($bookedPeople as $booked) {
                            $personKey = (string) $booked['key'];
                            $display = (string) $booked['display'];
                            /** @var \App\Models\Employee|null $employee */
                            $employee = $booked['employee'];

                            $byPerson[$personKey] ??= [
                                'person_name' => $display,
                                'team_id' => $employee?->team_id ? (int) $employee->team_id : null,
                                'team_name' => trim((string) ($employee?->team?->name ?? $projectTeamName)) ?: 'Not set',
                                'user_id' => null,
                                'employee_id' => $employee?->id,
                                'projects' => [],
                            ];

                            if (! isset($byPerson[$personKey]['projects'][$projectId])) {
                                $byPerson[$personKey]['projects'][$projectId] = [
                                    'project_id' => $projectId,
                                    'project_name' => $projectName,
                                    'start_date' => $start->toDateString(),
                                    'days_past_start' => $daysPast,
                                    'ready_task_count' => 0,
                                    'task_names' => [],
                                ];
                            }

                            $row = &$byPerson[$personKey]['projects'][$projectId];
                            $row['ready_task_count']++;
                            if (count($row['task_names']) < 8) {
                                $row['task_names'][] = $taskName.' (start '.$this->formatDisplayDate($start).')';
                            }
                            $existingStart = Carbon::parse($row['start_date'])->startOfDay();
                            if ($start->lt($existingStart)) {
                                $row['start_date'] = $start->toDateString();
                                $row['days_past_start'] = $daysPast;
                            }
                            unset($row);
                        }
                    }
                }
            }
        } finally {
            EmployeeNames::clearEmployeeCache();
        }

        $groups = [];
        foreach ($byPerson as $group) {
            $projects = array_values($group['projects']);
            usort($projects, static fn (array $a, array $b) => strcmp($a['project_name'], $b['project_name']));
            $taskCount = 0;
            foreach ($projects as $project) {
                $taskCount += (int) ($project['ready_task_count'] ?? 0);
            }
            $groups[] = [
                'person_name' => $group['person_name'],
                'dl_name' => $group['person_name'], // resolvePersonUserId / resolveDlUserId compat
                'team_id' => $group['team_id'],
                'team_name' => $group['team_name'],
                'user_id' => $group['user_id'],
                'employee_id' => $group['employee_id'],
                'task_count' => $taskCount,
                'projects' => $projects,
            ];
        }

        usort($groups, static fn (array $a, array $b) => strcmp($a['person_name'], $b['person_name']));

        return $groups;
    }

    /**
     * Whether a project has at least one incomplete booked task with Doc Supply ≤ today.
     */
    private function projectHasReadyBookedTasks(Project $project, Carbon $today): bool
    {
        foreach ($project->parts as $part) {
            foreach ($part->tasks as $task) {
                if ((bool) $task->done) {
                    continue;
                }
                $progress = $this->parseProgressPercent($task->progress_per ?? null);
                if ($progress !== null && $progress >= 100) {
                    continue;
                }

                $docRaw = trim((string) ($task->doc_supply ?? ''));
                if ($docRaw === '') {
                    continue;
                }

                try {
                    $start = Carbon::parse($docRaw)->startOfDay();
                } catch (\Throwable) {
                    continue;
                }

                if ($start->gt($today)) {
                    continue;
                }

                if ($this->resolveBookedPeopleOnTask($task) !== []) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * People booked on a task via algorithm / override slots (histogram), not OAP owners.
     *
     * @return list<array{key: string, display: string, employee: \App\Models\Employee|null}>
     */
    private function resolveBookedPeopleOnTask(object $task): array
    {
        /** @var array<string, array{key: string, display: string, employee: \App\Models\Employee|null}> $people */
        $people = [];

        foreach (EmployeeNames::ASSIGNEE_FIELDS as $field) {
            $raw = trim((string) ($task->{$field} ?? ''));
            if ($raw === '') {
                continue;
            }

            $canonical = EmployeeNames::canonicalize($raw) ?? $raw;
            $employee = EmployeeNames::findByAnyName($canonical)
                ?? EmployeeNames::findByAnyName($raw);
            $display = $employee
                ? EmployeeNames::displayName($employee)
                : trim((string) $canonical);
            if ($display === '') {
                continue;
            }

            $key = mb_strtolower($display);
            $people[$key] = [
                'key' => $key,
                'display' => $display,
                'employee' => $employee,
            ];
        }

        return array_values($people);
    }

    /**
     * @param  list<array<string, mixed>>  $projects
     */
    private function formatNewProjectDocsReadyBody(string $team, array $projects): string
    {
        $lines = [];
        foreach (array_slice($projects, 0, 20) as $project) {
            $name = trim((string) ($project['project_name'] ?? '')) ?: 'Untitled project';
            $lines[] = "• {$name}";
        }
        if (count($projects) > 20) {
            $lines[] = '• … +'.(count($projects) - 20).' more';
        }

        return implode("\n", [
            'Start date has passed and docs are ready.',
            '',
            "Team: {$team}",
            'Projects ('.count($projects).'):',
            ...$lines,
        ]);
    }

    /**
     * Resolve login user for a booked person (any role, not only DLs).
     *
     * @param  array{person_name?: string, dl_name?: string, user_id?: int|null}  $group
     */
    private function resolvePersonUserId(array $group): ?int
    {
        $userId = (int) ($group['user_id'] ?? 0);
        if ($userId > 0) {
            return $userId;
        }

        $fromDl = $this->resolveDlUserId($group);
        if ($fromDl !== null) {
            return $fromDl;
        }

        $personName = trim((string) ($group['person_name'] ?? $group['dl_name'] ?? ''));
        if ($personName === '') {
            return null;
        }

        $users = User::query()->where('active', true)->get();
        foreach ($users as $user) {
            $labels = array_filter([
                trim((string) ($user->name ?? '')),
                trim(trim((string) ($user->first_name ?? '')).' '.trim((string) ($user->last_name ?? ''))),
                trim((string) ($user->first_name ?? '')),
                trim((string) ($user->login_name ?? '')),
            ]);
            foreach ($labels as $label) {
                if (EmployeeNames::namesMatch($label, $personName)) {
                    return (int) $user->id;
                }
            }
        }

        return null;
    }

    private function parseProgressPercent(mixed $raw): ?int
    {
        $text = trim((string) ($raw ?? ''));
        if ($text === '') {
            return null;
        }
        $text = rtrim($text, '%');
        if (! is_numeric($text)) {
            return null;
        }

        return (int) max(0, min(100, round((float) $text)));
    }

    /**
     * @return list<array{rule: EmailNotificationRule, item_name: string, detail: string}>
     */
    private function matchIncompleteTrainings(EmailNotificationRule $rule, bool $dryRun = false): array
    {
        $minDays = max(0, (int) $rule->case_value);
        $today = Carbon::today();
        $cutoff = $today->copy()->subDays($minDays);
        $weekKey = DlQuickUpdate::weekStart($today)->toDateString();
        $matches = [];

        $trainings = EmployeeTraining::query()
            ->with(['employee.team'])
            ->where('status', '!=', 'completed')
            ->whereDate('start_date', '<=', $cutoff->toDateString())
            ->get();

        foreach ($trainings as $training) {
            $trainee = trim((string) ($training->employee?->name ?? ''))
                ?: trim(($training->employee?->first_name ?? '').' '.($training->employee?->last_name ?? ''))
                ?: 'Unknown trainee';
            $team = trim((string) ($training->employee?->team?->name ?? '')) ?: 'Not set';
            $course = trim((string) $training->title) ?: 'Untitled course';
            $start = $training->start_date?->toDateString();
            $end = $training->end_date?->toDateString();
            $daysOpen = $start
                ? max(0, (int) Carbon::parse($start)->startOfDay()->diffInDays($today))
                : 0;
            // Title already has trainee + “Incomplete training” + course + days —
            // body only adds what is not in the title.
            $detail = implode("\n", [
                'Mark this training complete, or reschedule it.',
                '',
                "Team / DL: {$team}",
                'Assigned: '.$this->formatDateRange($start, $end),
            ]);
            $daysBit = $daysOpen === 1 ? '1 day open' : "{$daysOpen} days open";
            $title = $this->titleWithFirstName(
                "Incomplete training · {$course} · {$daysBit}",
                $trainee,
            );

            $match = $this->remember(
                $rule,
                "incomplete_training:{$training->id}:{$weekKey}",
                $trainee,
                $detail,
                [
                    'employee_id' => $training->employee_id,
                    'employee_training_id' => $training->id,
                ],
                persist: ! $dryRun,
                personName: $trainee,
                titleOverride: $title,
            );
            if ($match !== null) {
                $matches[] = $match;
            }
        }

        return $matches;
    }

    /**
     * @param  list<string>  $skipped
     * @return list<array{rule: EmailNotificationRule, item_name: string, detail: string}>
     */
    private function skipHistogramDependent(EmailNotificationRule $rule, array &$skipped): array
    {
        $skipped[] = "{$rule->label} ({$rule->case_type}): needs live histogram/availability data — not evaluated in the cron job yet.";

        return [];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function loadDlGroups(): array
    {
        $employees = DlQuickUpdate::loadEmployees();
        EmployeeNames::warmEmployeeCache($employees);

        try {
            $tasks = DlQuickUpdate::loadActiveTasks();
            $dlUsers = DlQuickUpdate::loadDlUsers();
            $teamOapNumbers = DlQuickUpdate::teamOapNrmNumbers($employees);
            $nrmTeamIds = DlQuickUpdate::nrmToTeamIds($employees);
            $dlProfiles = DlQuickUpdate::mergeOwnerProfiles(
                $tasks,
                DlQuickUpdate::resolveDlProfiles($employees, $dlUsers),
            );
            $submissions = DlQuickUpdate::latestSubmissionsByDlProject();
            $window = DlQuickUpdate::threeWeekRange();

            return DlQuickUpdate::buildGroupedPayload(
                $tasks,
                $dlProfiles,
                $teamOapNumbers,
                $nrmTeamIds,
                $submissions,
                $employees,
                $window['week_start'],
                $window['range_start'],
                $window['range_end'],
            );
        } finally {
            EmployeeNames::clearEmployeeCache();
        }
    }

    /**
     * @param  array{
     *   employee_id?: int|null,
     *   employee_training_id?: int|null,
     *   project_task_id?: int|null,
     *   project_id?: int|null,
     *   recipient_user_id?: int|null
     * }  $meta
     * @return array{rule: EmailNotificationRule, item_name: string, detail: string}|null
     */
    private function remember(
        EmailNotificationRule $rule,
        string $dedupeKey,
        string $itemName,
        string $detail,
        array $meta = [],
        bool $persist = true,
        ?string $personName = null,
        ?string $titleOverride = null,
    ): ?array {
        if (! $rule->enabled) {
            return null;
        }

        $title = $titleOverride ?: $this->titleWithFirstName($rule->label, $personName ?: $itemName);
        $detail = trim($detail);
        $title = trim($title);
        // Never persist or email blank notices.
        if ($title === '' && $detail === '') {
            return null;
        }
        if ($title === '') {
            $title = trim((string) $rule->label) ?: 'Notification';
        }

        if ($persist) {
            $audience = in_array($rule->case_type, self::TRAINING_AUDIENCE_CASES, true) ? 'trainings' : 'system';

            try {
                ScheduledNotificationNotice::query()->create([
                    'dedupe_key' => $dedupeKey,
                    'rule_code' => $rule->code,
                    'case_type' => $rule->case_type,
                    'audience' => $audience,
                    'recipient_user_id' => isset($meta['recipient_user_id']) ? (int) $meta['recipient_user_id'] ?: null : null,
                    'title' => $title,
                    'body' => $detail,
                    'employee_id' => $meta['employee_id'] ?? null,
                    'employee_training_id' => $meta['employee_training_id'] ?? null,
                    'project_task_id' => $meta['project_task_id'] ?? null,
                    'project_id' => $meta['project_id'] ?? null,
                ]);
            } catch (QueryException) {
                return null;
            }
        } elseif (ScheduledNotificationNotice::query()->where('dedupe_key', $dedupeKey)->exists()) {
            return null;
        }

        return [
            'rule' => $rule,
            'item_name' => $itemName,
            'detail' => $detail,
            'recipient_user_id' => isset($meta['recipient_user_id'])
                ? ((int) $meta['recipient_user_id'] ?: null)
                : null,
            'title' => $title,
        ];
    }

    /**
     * @param  array{dl_name?: string, user_id?: int|null, employee_id?: int|null}  $group
     */
    private function resolveDlUserId(array $group): ?int
    {
        $userId = (int) ($group['user_id'] ?? 0);
        if ($userId > 0) {
            return $userId;
        }

        $dlName = trim((string) ($group['dl_name'] ?? ''));
        if ($dlName === '') {
            return null;
        }

        $dlUsers = DlQuickUpdate::loadDlUsers();
        foreach ($dlUsers as $user) {
            $labels = array_filter([
                trim((string) ($user->name ?? '')),
                trim(trim((string) ($user->first_name ?? '')).' '.trim((string) ($user->last_name ?? ''))),
                trim((string) ($user->first_name ?? '')),
                trim((string) ($user->login_name ?? '')),
            ]);
            foreach ($labels as $label) {
                if (EmployeeNames::namesMatch($label, $dlName)) {
                    return (int) $user->id;
                }
            }
        }

        return null;
    }

    private function titleWithFirstName(string $ruleLabel, string $personName): string
    {
        $first = $this->firstName($personName);
        if ($first === '') {
            return $ruleLabel;
        }

        return "{$first} — {$ruleLabel}";
    }

    private function firstName(string $fullName): string
    {
        $trimmed = trim($fullName);
        if ($trimmed === '') {
            return '';
        }

        $parts = preg_split('/\s+/', $trimmed) ?: [];

        return trim((string) ($parts[0] ?? ''));
    }

    private function formatDlWeeklyTitle(
        string $dlName,
        string $status,
        int $projectCount,
        int $teamIssueCount = 0,
    ): string {
        $statusLabel = match ($status) {
            DlQuickUpdate::STATUS_STALE => 'Edited after submit',
            DlQuickUpdate::STATUS_NEVER => 'Never submitted this week',
            default => 'Weekly update overdue',
        };
        $projectBit = $projectCount === 1 ? '1 project' : "{$projectCount} projects";
        $bits = ["{$statusLabel} · {$projectBit}"];
        if ($teamIssueCount > 0) {
            $bits[] = $teamIssueCount === 1
                ? '1 team training issue'
                : "{$teamIssueCount} team training issues";
        }

        return $this->titleWithFirstName(implode(' · ', $bits), $dlName);
    }

    /**
     * Body only — title already has DL name, status, and project count.
     *
     * @param  list<array<string, mixed>>  $projects
     * @param  array{member_lines: list<string>, issue_lines: list<string>}  $teamSnapshot
     */
    private function formatDlWeeklyBody(
        string $team,
        string $status,
        Carbon $weekStart,
        Carbon $weekEnd,
        mixed $lastSubmitted,
        mixed $lastUpdated,
        array $projects,
        array $teamSnapshot = ['member_lines' => [], 'issue_lines' => []],
    ): string {
        $action = match ($status) {
            DlQuickUpdate::STATUS_STALE => 'Re-submit this week\'s Quick Update after the latest edits (or have a planner complete it).',
            DlQuickUpdate::STATUS_NEVER => 'Submit the first Quick Update for this week (or have a planner complete it).',
            default => 'Submit this week\'s Quick Update (or have a planner complete it).',
        };

        $projectLines = [];
        foreach (array_slice($projects, 0, 10) as $project) {
            $name = trim((string) ($project['project_name'] ?? '')) ?: 'Untitled project';
            $taskCount = (int) ($project['task_count'] ?? count($project['tasks'] ?? []));
            $projStatus = $this->humanStatus((string) ($project['update_status'] ?? ''));
            $projUpdated = $this->formatDisplayDate($project['last_updated'] ?? null);
            $taskBit = $taskCount === 1 ? '1 task' : "{$taskCount} tasks";
            $projectLines[] = "• {$name} — {$projStatus} · {$taskBit} · updated {$projUpdated}";
        }
        if (count($projects) > 10) {
            $projectLines[] = '• … +'.(count($projects) - 10).' more';
        }

        $issueLines = $teamSnapshot['issue_lines'] ?? [];
        $parts = [
            $action,
            '',
            "Team: {$team}",
            'Week: '.$weekStart->format('j M Y').' – '.$weekEnd->format('j M Y'),
            'Last submitted: '.$this->formatDisplayDate($lastSubmitted, emptyLabel: 'never'),
            'Last updated: '.$this->formatDisplayDate($lastUpdated),
            '',
            'Projects:',
            ...$projectLines,
        ];

        // Only include training issues when there is at least one.
        if ($issueLines !== []) {
            $parts[] = '';
            $parts[] = 'Team training issues ('.count($issueLines).'):';
            array_push($parts, ...$issueLines);
        }

        return implode("\n", $parts);
    }

    /**
     * Roster + open/overdue/starting-soon trainings for everyone on the DL's team.
     *
     * @return array{member_lines: list<string>, issue_lines: list<string>}
     */
    private function loadDlTeamMemberSnapshot(?int $teamId): array
    {
        if ($teamId === null || $teamId <= 0) {
            return ['member_lines' => [], 'issue_lines' => []];
        }

        $today = Carbon::today();
        $soonUntil = $today->copy()->addDays(2);

        $employees = Employee::query()
            ->where('team_id', $teamId)
            ->orderBy('first_name')
            ->orderBy('last_name')
            ->get();

        $memberLines = [];
        foreach ($employees as $employee) {
            $name = trim((string) ($employee->name ?? ''))
                ?: trim(($employee->first_name ?? '').' '.($employee->last_name ?? ''))
                ?: 'Unknown';
            $memberLines[] = "• {$name}";
        }

        $trainings = EmployeeTraining::query()
            ->with(['employee'])
            ->where('status', '!=', 'completed')
            ->whereHas('employee', fn ($query) => $query->where('team_id', $teamId))
            ->orderBy('end_date')
            ->orderBy('start_date')
            ->get();

        $issueLines = [];
        foreach ($trainings as $training) {
            $trainee = trim((string) ($training->employee?->name ?? ''))
                ?: trim(($training->employee?->first_name ?? '').' '.($training->employee?->last_name ?? ''))
                ?: 'Unknown trainee';
            $course = trim((string) $training->title) ?: 'Untitled course';
            $status = $this->humanStatus((string) ($training->status ?? 'unknown'));
            $start = $training->start_date?->toDateString();
            $end = $training->end_date?->toDateString();
            $endDay = $end ? Carbon::parse($end)->startOfDay() : null;
            $startDay = $start ? Carbon::parse($start)->startOfDay() : null;

            if ($endDay !== null && $endDay->lt($today)) {
                $daysLate = max(1, (int) $endDay->diffInDays($today));
                $issueLines[] = "• {$trainee} — {$course} · Overdue · {$daysLate}d late · ".$this->formatDateRange($start, $end);
                continue;
            }

            if ($startDay !== null && $startDay->betweenIncluded($today, $soonUntil)) {
                $daysUntil = max(0, (int) $today->diffInDays($startDay, false));
                $when = $daysUntil === 0 ? 'starts today' : ($daysUntil === 1 ? 'starts tomorrow' : "starts in {$daysUntil}d");
                $issueLines[] = "• {$trainee} — {$course} · Starting soon · {$when} · ".$this->formatDateRange($start, $end);
                continue;
            }

            if ($startDay !== null && $startDay->lte($today)) {
                $daysOpen = max(0, (int) $startDay->diffInDays($today));
                $issueLines[] = "• {$trainee} — {$course} · Incomplete · {$status} · {$daysOpen}d open · ".$this->formatDateRange($start, $end);
            }
        }

        return [
            'member_lines' => $memberLines,
            'issue_lines' => $issueLines,
        ];
    }

    private function formatDateRange(?string $start, ?string $end): string
    {
        $from = $this->formatDisplayDate($start);
        $to = $this->formatDisplayDate($end);
        if ($from === '—' && $to === '—') {
            return 'not set';
        }
        if ($from === $to) {
            return $from;
        }

        return "{$from} → {$to}";
    }

    private function formatDisplayDate(mixed $value, string $emptyLabel = '—'): string
    {
        $raw = trim((string) ($value ?? ''));
        if ($raw === '') {
            return $emptyLabel;
        }

        try {
            return Carbon::parse($raw)->format('j M Y');
        } catch (\Throwable) {
            return $raw;
        }
    }

    private function humanStatus(string $status): string
    {
        $normalized = strtolower(trim($status));
        if ($normalized === '') {
            return 'unknown';
        }

        return match ($normalized) {
            DlQuickUpdate::STATUS_OVERDUE => 'Overdue',
            DlQuickUpdate::STATUS_NEVER => 'Never submitted',
            DlQuickUpdate::STATUS_STALE => 'Edited after submit',
            'due' => 'Due',
            'submitted' => 'Submitted',
            'completed' => 'Completed',
            'in_progress', 'in-progress' => 'In progress',
            default => ucwords(str_replace(['_', '-'], ' ', $normalized)),
        };
    }

    /**
     * @param  list<array{rule: EmailNotificationRule, item_name: string, detail: string}>  $matches
     * @param  list<string>  $skipped
     * @param  array<string, int>  $byCase
     * @return array{
     *   dry_run: bool,
     *   matches_found: int,
     *   delivered: array{
     *     in_app: list<string>,
     *     emails_sent: int,
     *     triggered_rules: list<string>,
     *     email_errors: list<array{rule: string, error: string}>,
     *     summary: string
     *   },
     *   by_case: array<string, int>,
     *   skipped: list<string>,
     *   preview: list<array{rule: string, item_name: string, detail: string}>
     * }
     */
    private function finish(array $matches, bool $dryRun, array $skipped, array $byCase): array
    {
        $preview = array_map(static fn (array $match) => [
            'rule' => $match['rule']->label,
            'item_name' => $match['item_name'],
            'detail' => $match['detail'],
        ], $matches);

        if ($dryRun || $matches === []) {
            return [
                'dry_run' => $dryRun,
                'matches_found' => count($matches),
                'delivered' => $this->emptyDelivered(),
                'by_case' => $byCase,
                'skipped' => $skipped,
                'preview' => $preview,
            ];
        }

        return [
            'dry_run' => false,
            'matches_found' => count($matches),
            'delivered' => $this->emailNotifications->deliverMatches(
                'WorkPlanner',
                'Scheduled notifications',
                $matches,
            ),
            'by_case' => $byCase,
            'skipped' => $skipped,
            'preview' => $preview,
        ];
    }

    /**
     * @return array{
     *   in_app: list<string>,
     *   emails_sent: int,
     *   triggered_rules: list<string>,
     *   email_errors: list<array{rule: string, error: string}>,
     *   summary: string
     * }
     */
    private function emptyDelivered(): array
    {
        return [
            'in_app' => [],
            'emails_sent' => 0,
            'triggered_rules' => [],
            'email_errors' => [],
            'summary' => '',
        ];
    }
}
