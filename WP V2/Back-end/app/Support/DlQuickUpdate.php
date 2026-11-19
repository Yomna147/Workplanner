<?php

namespace App\Support;

use App\Models\DlUpdateSubmission;
use App\Models\Employee;
use App\Models\ProjectTask;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Support\Collection;

class DlQuickUpdate
{
    public const STATUS_SUBMITTED = 'submitted';
    public const STATUS_STALE = 'stale';
    public const STATUS_DUE = 'due';
    public const STATUS_OVERDUE = 'overdue';
    public const STATUS_NEVER = 'never';

    public static function isOapValue(mixed $value): bool
    {
        $trimmed = trim((string) ($value ?? ''));

        return $trimmed !== '' && strcasecmp($trimmed, 'Chk') !== 0;
    }

    public static function extractNrmNumber(?string $taskName): ?string
    {
        $normalized = NrmCatalog::normalizeTaskNamePrefix($taskName);
        if ($normalized === '') {
            return null;
        }

        if (preg_match('/^(\d+(?:\.\d+)?)/', $normalized, $matches) !== 1) {
            return null;
        }

        return NrmCatalog::canonicalNumber($matches[1]) ?? $matches[1];
    }

    public static function isRfiOn(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        $normalized = strtolower(trim((string) ($value ?? '')));

        return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
    }

    public static function isDone(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        $normalized = strtolower(trim((string) ($value ?? '')));

        return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * Map team_id => list of canonical NRM numbers with an OAP value on that team.
     *
     * @param  Collection<int, Employee>  $employees
     * @return array<int, list<string>>
     */
    public static function teamOapNrmNumbers(Collection $employees): array
    {
        $map = [];

        foreach (self::nrmTeamCounts($employees) as $number => $teamCounts) {
            foreach (array_keys($teamCounts) as $teamId) {
                $map[$teamId][$number] = $number;
            }
        }

        foreach ($map as $teamId => $numbers) {
            $map[$teamId] = array_values($numbers);
        }

        return $map;
    }

    /**
     * Map NRM number => team ids that have OAP for it, ranked by operative count.
     *
     * @param  Collection<int, Employee>  $employees
     * @return array<string, list<int>>
     */
    public static function nrmToTeamIds(Collection $employees): array
    {
        $ranked = [];
        foreach (self::nrmTeamCounts($employees) as $number => $teamCounts) {
            arsort($teamCounts);
            $ranked[$number] = array_map('intval', array_keys($teamCounts));
        }

        return $ranked;
    }

    /**
     * @param  Collection<int, Employee>  $employees
     * @return array<string, array<int, int>>
     */
    public static function nrmTeamCounts(Collection $employees): array
    {
        $counts = [];

        foreach ($employees as $employee) {
            $teamId = (int) ($employee->team_id ?? 0);
            if ($teamId <= 0) {
                continue;
            }

            foreach ($employee->nrms ?? [] as $nrm) {
                if (! self::isOapValue($nrm->pivot->OAP ?? null)) {
                    continue;
                }

                $number = NrmCatalog::canonicalNumber((string) ($nrm->number ?? '')) ?? trim((string) ($nrm->number ?? ''));
                if ($number === '') {
                    continue;
                }

                $counts[$number][$teamId] = ($counts[$number][$teamId] ?? 0) + 1;
            }
        }

        return $counts;
    }

    public static function weekStart(?Carbon $now = null): Carbon
    {
        $now ??= Carbon::now();

        return $now->copy()->startOfWeek(Carbon::MONDAY)->startOfDay();
    }

    /**
     * Previous week, current week, and next week (Mon–Sun).
     *
     * @return array{week_start: Carbon, range_start: Carbon, range_end: Carbon}
     */
    public static function threeWeekRange(?Carbon $now = null): array
    {
        $weekStart = self::weekStart($now);

        return [
            'week_start' => $weekStart,
            'range_start' => $weekStart->copy()->subWeek()->startOfDay(),
            'range_end' => $weekStart->copy()->addWeek()->endOfWeek(Carbon::SUNDAY)->endOfDay(),
        ];
    }

    /**
     * NRM section numbers from a team name such as "NRM2 superstructure" or "NRM3&4 finishes".
     *
     * @return list<string>
     */
    public static function nrmSectionKeysFromTeamName(?string $name): array
    {
        if (preg_match('/nrm\s*([\d&+,]+)/i', (string) $name, $matches) !== 1) {
            return [];
        }

        $parts = preg_split('/[&+,]/', str_replace(' ', '', $matches[1])) ?: [];
        $keys = [];
        foreach ($parts as $part) {
            $digits = preg_replace('/\D+/', '', $part) ?? '';
            if ($digits === '') {
                continue;
            }
            $keys[] = ltrim($digits, '0') ?: '0';
        }

        return array_values(array_unique($keys));
    }

    public static function nrmSectionKeyFromNumber(?string $number): ?string
    {
        if (preg_match('/^(\d+)/', trim((string) $number), $matches) !== 1) {
            return null;
        }

        return ltrim($matches[1], '0') ?: '0';
    }

    /**
     * @param  array<string, mixed>  $row
     * @param  list<string>  $sectionKeys
     */
    public static function taskBelongsToNrmSection(array $row, array $sectionKeys): bool
    {
        if ($sectionKeys === []) {
            return true;
        }

        $key = self::nrmSectionKeyFromNumber($row['nrm_number'] ?? '');

        return $key !== null && in_array($key, $sectionKeys, true);
    }

    /**
     * Same rule as the histogram task editor: keep tasks whose NRM prefix is in the team's OAP set.
     *
     * @param  list<string>  $oapNumbers
     */
    public static function taskMatchesOapNumbers(?string $nrmNumber, array $oapNumbers): bool
    {
        if ($oapNumbers === []) {
            return false;
        }

        $taskRaw = trim((string) $nrmNumber);
        if ($taskRaw === '') {
            return false;
        }

        $allowed = [];
        foreach ($oapNumbers as $number) {
            $raw = trim((string) $number);
            if ($raw === '') {
                continue;
            }
            $allowed[$raw] = true;
            $canonical = NrmCatalog::canonicalNumber($raw) ?? $raw;
            $allowed[$canonical] = true;
        }

        $taskCanonical = NrmCatalog::canonicalNumber($taskRaw) ?? $taskRaw;

        return isset($allowed[$taskRaw]) || isset($allowed[$taskCanonical]);
    }

    /**
     * @param  array<string, mixed>  $row
     */
    public static function taskOverlapsRange(array $row, Carbon $rangeStart, Carbon $rangeEnd): bool
    {
        $start = self::toYmd($row['doc_supply'] ?? null);
        $end = self::toYmd($row['project_completion_date'] ?? null)
            ?: self::toYmd($row['completion'] ?? null)
            ?: $start;
        if ($start === null && $end === null) {
            return false;
        }
        $start ??= $end;
        $end ??= $start;

        return $start <= $rangeEnd->toDateString() && $end >= $rangeStart->toDateString();
    }

    /**
     * @param  list<string>  $dates
     */
    public static function maxDate(array $dates): ?string
    {
        $best = null;
        foreach ($dates as $date) {
            $ymd = self::toYmd($date);
            if ($ymd === null) {
                continue;
            }
            if ($best === null || $ymd > $best) {
                $best = $ymd;
            }
        }

        return $best;
    }

    public static function toYmd(mixed $value): ?string
    {
        $raw = trim((string) ($value ?? ''));
        if ($raw === '') {
            return null;
        }

        if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $raw, $matches) === 1) {
            return $matches[1];
        }

        try {
            return Carbon::parse($raw)->toDateString();
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * @param  array<string, mixed>  $task
     */
    public static function taskLastUpdatedYmd(array $task): ?string
    {
        return self::maxDate([
            (string) ($task['progress_updated'] ?? ''),
            (string) ($task['dl_progress_updated'] ?? ''),
            (string) ($task['updated_at'] ?? ''),
        ]);
    }

    public static function resolveStatus(?string $lastSubmittedAt, ?string $lastUpdatedYmd, Carbon $weekStart): string
    {
        $submittedYmd = self::toYmd($lastSubmittedAt);
        $updatedYmd = self::toYmd($lastUpdatedYmd);
        $weekStartYmd = $weekStart->toDateString();

        if ($submittedYmd !== null && $submittedYmd >= $weekStartYmd) {
            if ($updatedYmd !== null && $updatedYmd > $submittedYmd) {
                return self::STATUS_STALE;
            }

            return self::STATUS_SUBMITTED;
        }

        if ($updatedYmd !== null && $updatedYmd >= $weekStartYmd) {
            return self::STATUS_DUE;
        }

        if ($submittedYmd !== null) {
            return self::STATUS_OVERDUE;
        }

        if ($updatedYmd !== null) {
            return self::STATUS_OVERDUE;
        }

        return self::STATUS_NEVER;
    }

    /**
     * @param  Collection<int, Employee>  $employees
     * @return list<array{dl_name: string, employee_id: int|null, team_id: int|null, team_name: string, user_id: int|null}>
     */
    public static function resolveDlProfiles(Collection $employees, Collection $dlUsers): array
    {
        EmployeeNames::warmEmployeeCache($employees);

        $profiles = [];

        foreach ($dlUsers as $user) {
            $labels = array_filter([
                trim((string) ($user->name ?? '')),
                trim(trim((string) ($user->first_name ?? '')).' '.trim((string) ($user->last_name ?? ''))),
                trim((string) ($user->first_name ?? '')),
                trim((string) ($user->login_name ?? '')),
            ]);

            $employee = null;
            foreach ($labels as $label) {
                $employee = EmployeeNames::findByAnyName($label);
                if ($employee) {
                    break;
                }
            }

            $dlName = $employee
                ? EmployeeNames::displayName($employee)
                : (trim((string) ($user->name ?? '')) ?: trim((string) ($user->login_name ?? '')) ?: 'DL');

            $key = mb_strtolower($dlName);
            if (isset($profiles[$key])) {
                continue;
            }

            $profiles[$key] = [
                'dl_name' => $dlName,
                'employee_id' => $employee?->id,
                'team_id' => $employee?->team_id ? (int) $employee->team_id : null,
                'team_name' => $employee?->team?->name ?? '',
                'user_id' => $user->id,
            ];
        }

        return array_values($profiles);
    }

    /**
     * Include people who already own DL plan rows even if they are not in the DLs role.
     *
     * @param  Collection<int, ProjectTask>  $tasks
     * @param  list<array{dl_name: string, employee_id: int|null, team_id: int|null, team_name: string, user_id: int|null}>  $profiles
     * @return list<array{dl_name: string, employee_id: int|null, team_id: int|null, team_name: string, user_id: int|null}>
     */
    public static function mergeOwnerProfiles(Collection $tasks, array $profiles): array
    {
        $keyed = [];
        foreach ($profiles as $profile) {
            $keyed[mb_strtolower($profile['dl_name'])] = $profile;
        }

        foreach ($tasks as $task) {
            $owner = trim((string) ($task->dl_owner ?? ''));
            if ($owner === '') {
                continue;
            }

            $employee = EmployeeNames::findByAnyName($owner);
            $display = $employee ? EmployeeNames::displayName($employee) : $owner;
            $key = mb_strtolower($display);
            if (isset($keyed[$key])) {
                continue;
            }

            $keyed[$key] = [
                'dl_name' => $display,
                'employee_id' => $employee?->id,
                'team_id' => $employee?->team_id ? (int) $employee->team_id : null,
                'team_name' => $employee?->team?->name ?? '',
                'user_id' => null,
            ];
        }

        return array_values($keyed);
    }

    /**
     * @param  Collection<int, ProjectTask>  $tasks
     * @param  list<array{dl_name: string, employee_id: int|null, team_id: int|null, team_name: string, user_id: int|null}>  $dlProfiles
     * @param  array<int, list<string>>  $teamOapNumbers
     * @param  array<string, list<int>>  $nrmTeamIds
     * @param  array<string, DlUpdateSubmission>  $latestSubmissions
     * @param  list<string>  $sectionKeys
     * @param  list<string>  $oapNumbers
     * @param  array{dl_name: string, employee_id: int|null, team_id: int|null, team_name: string, user_id: int|null}|null  $singleGroupProfile
     * @return list<array<string, mixed>>
     */
    public static function buildGroupedPayload(
        Collection $tasks,
        array $dlProfiles,
        array $teamOapNumbers,
        array $nrmTeamIds,
        array $latestSubmissions,
        Collection $employees,
        Carbon $weekStart,
        ?Carbon $rangeStart = null,
        ?Carbon $rangeEnd = null,
        array $sectionKeys = [],
        array $oapNumbers = [],
        ?array $singleGroupProfile = null,
    ): array {
        $teamNames = [];
        foreach ($employees as $employee) {
            if ($employee->team_id && $employee->team?->name) {
                $teamNames[(int) $employee->team_id] = $employee->team->name;
            }
        }

        $dlByTeam = [];
        foreach ($dlProfiles as $profile) {
            if ($profile['team_id']) {
                $dlByTeam[$profile['team_id']][] = $profile['dl_name'];
            }
        }

        $groups = [];
        $unassignedKey = 'unassigned';
        $flattenToTeam = $singleGroupProfile !== null;

        if ($flattenToTeam) {
            $groups['team'] = [
                'dl_name' => $singleGroupProfile['dl_name'],
                'employee_id' => $singleGroupProfile['employee_id'] ?? null,
                'team_id' => $singleGroupProfile['team_id'] ?? null,
                'team_name' => $singleGroupProfile['team_name'] ?? '',
                'user_id' => $singleGroupProfile['user_id'] ?? null,
                'oap_nrm_numbers' => $oapNumbers !== []
                    ? $oapNumbers
                    : (($singleGroupProfile['team_id'] ?? null)
                        ? ($teamOapNumbers[$singleGroupProfile['team_id']] ?? [])
                        : []),
                'projects' => [],
            ];
        } else {
            foreach ($dlProfiles as $profile) {
                $groups[mb_strtolower($profile['dl_name'])] = [
                    ...$profile,
                    'oap_nrm_numbers' => $profile['team_id'] ? ($teamOapNumbers[$profile['team_id']] ?? []) : [],
                    'projects' => [],
                ];
            }

            $groups[$unassignedKey] = [
                'dl_name' => 'Unassigned',
                'employee_id' => null,
                'team_id' => null,
                'team_name' => '',
                'user_id' => null,
                'oap_nrm_numbers' => [],
                'projects' => [],
            ];
        }

        $viewerTeamId = $flattenToTeam ? ($singleGroupProfile['team_id'] ?? null) : null;

        foreach ($tasks as $task) {
            $row = self::formatTaskRow($task, $nrmTeamIds, $teamNames);
            if ($rangeStart && $rangeEnd && ! self::taskOverlapsRange($row, $rangeStart, $rangeEnd)) {
                continue;
            }
            if ($oapNumbers !== [] && ! self::taskMatchesOapNumbers($row['nrm_number'] ?? null, $oapNumbers)) {
                continue;
            }
            if ($sectionKeys !== [] && ! self::taskBelongsToNrmSection($row, $sectionKeys)) {
                continue;
            }
            if ($flattenToTeam && $oapNumbers === [] && $sectionKeys === [] && $viewerTeamId) {
                if ((int) ($row['team_id'] ?? 0) !== (int) $viewerTeamId) {
                    continue;
                }
            }

            $assigned = [];
            if ($flattenToTeam) {
                $assigned[] = 'team';
            } else {
                $ownerName = trim((string) ($row['dl_owner'] ?: $row['owner']));

                if ($ownerName !== '') {
                    foreach ($dlProfiles as $profile) {
                        if (EmployeeNames::namesMatch($profile['dl_name'], $ownerName)) {
                            $assigned[] = mb_strtolower($profile['dl_name']);
                        }
                    }
                }

                if ($assigned === [] && $row['team_id']) {
                    foreach ($dlByTeam[$row['team_id']] ?? [] as $dlName) {
                        $assigned[] = mb_strtolower($dlName);
                    }
                }

                if ($assigned === []) {
                    $assigned[] = $unassignedKey;
                }
            }

            foreach (array_unique($assigned) as $groupKey) {
                if (! isset($groups[$groupKey])) {
                    continue;
                }
                $projectKey = (string) $row['project_id'];
                if (! isset($groups[$groupKey]['projects'][$projectKey])) {
                    $groups[$groupKey]['projects'][$projectKey] = [
                        'project_id' => $row['project_id'],
                        'project_name' => $row['project_name'],
                        'project_status' => $row['project_status'],
                        'project_color' => $row['project_color'] ?? '',
                        'tasks' => [],
                    ];
                }
                $groups[$groupKey]['projects'][$projectKey]['tasks'][] = $row;
            }
        }

        $payload = [];
        foreach ($groups as $key => $group) {
            if ($key === $unassignedKey && $group['projects'] === []) {
                continue;
            }
            if ($group['projects'] === []) {
                continue;
            }

            $projects = [];
            foreach ($group['projects'] as $project) {
                $projects[] = self::finalizeProject(
                    $project,
                    $group['dl_name'],
                    $latestSubmissions,
                    $weekStart,
                );
            }

            usort($projects, fn ($left, $right) => strcasecmp($left['project_name'], $right['project_name']));

            $lastSubmitted = self::maxDate(array_map(
                fn ($project) => (string) ($project['last_submitted_at'] ?? ''),
                $projects,
            ));
            $lastUpdated = self::maxDate(array_map(
                fn ($project) => (string) ($project['last_updated'] ?? ''),
                $projects,
            ));

            $payload[] = [
                'dl_name' => $group['dl_name'],
                'employee_id' => $group['employee_id'],
                'team_id' => $group['team_id'],
                'team_name' => $group['team_name'],
                'user_id' => $group['user_id'],
                'oap_nrm_numbers' => $group['oap_nrm_numbers'],
                'last_submitted_at' => $lastSubmitted,
                'last_updated' => $lastUpdated,
                'update_status' => self::resolveStatus($lastSubmitted, $lastUpdated, $weekStart),
                'projects' => $projects,
            ];
        }

        usort($payload, function ($left, $right) {
            if ($left['dl_name'] === 'Unassigned') {
                return 1;
            }
            if ($right['dl_name'] === 'Unassigned') {
                return -1;
            }

            return strcasecmp($left['dl_name'], $right['dl_name']);
        });

        return $payload;
    }

    /**
     * @param  array<string, mixed>  $project
     * @param  array<string, DlUpdateSubmission>  $latestSubmissions
     * @return array<string, mixed>
     */
    private static function finalizeProject(
        array $project,
        string $dlName,
        array $latestSubmissions,
        Carbon $weekStart,
    ): array {
        $tasks = $project['tasks'];
        usort($tasks, fn ($left, $right) => strcasecmp((string) $left['task_name'], (string) $right['task_name']));

        $partNames = array_values(array_unique(array_filter(array_map(
            fn ($task) => trim((string) ($task['part_name'] ?? '')),
            $tasks,
        ))));

        $submissionKey = mb_strtolower($dlName).'|'.$project['project_id'];
        $submission = $latestSubmissions[$submissionKey] ?? null;
        $lastSubmitted = $submission?->submitted_at?->toIso8601String();
        $lastUpdated = self::maxDate(array_map(
            fn ($task) => (string) ($task['last_updated'] ?? ''),
            $tasks,
        ));

        return [
            'project_id' => $project['project_id'],
            'project_name' => $project['project_name'],
            'project_status' => $project['project_status'],
            'project_color' => $project['project_color'] ?? '',
            'part_names' => $partNames,
            'task_count' => count($tasks),
            'last_submitted_at' => $lastSubmitted,
            'last_updated' => $lastUpdated,
            'update_status' => self::resolveStatus($lastSubmitted, $lastUpdated, $weekStart),
            'tasks' => $tasks,
        ];
    }

    /**
     * @param  array<string, list<int>>  $nrmTeamIds
     * @param  array<int, string>  $teamNames
     * @return array<string, mixed>
     */
    private static function formatTaskRow(ProjectTask $task, array $nrmTeamIds, array $teamNames): array
    {
        $data = DlMirrorFields::applyMirrorValuesToPde($task->toArray());
        $part = $task->part;
        $project = $part?->project;
        $nrmNumber = self::extractNrmNumber($task->task_name);
        $teamId = null;
        if ($nrmNumber && isset($nrmTeamIds[$nrmNumber][0])) {
            $teamId = $nrmTeamIds[$nrmNumber][0];
        }

        $start = self::toYmd($data['doc_supply'] ?? null);
        $planned = self::toYmd($data['completion'] ?? null);
        $actual = self::toYmd($data['project_completion_date'] ?? $data['dl_project_completion_date'] ?? null);

        return [
            'id' => $task->id,
            'part_id' => $task->part_id,
            'part_name' => $part?->name ?? '',
            'project_id' => $project?->id,
            'project_name' => $project?->name ?? 'Untitled project',
            'project_status' => $project?->status ?? 'active',
            'project_color' => $project?->color ?? '',
            'team_id' => $teamId,
            'team_name' => $teamId ? ($teamNames[$teamId] ?? '') : '',
            'nrm_number' => $nrmNumber,
            'task_name' => $data['task_name'] ?? '',
            'rfi' => $data['rfi'] ?? '',
            'dl' => $data['dl'] ?? '',
            'plan' => $data['plan'] ?? '',
            'override_1' => $data['override_1'] ?? '',
            'override_2' => $data['override_2'] ?? '',
            'override_3' => $data['override_3'] ?? '',
            'progress_per' => $data['progress_per'] ?? '',
            'progress_left_hours' => $data['progress_left_hours'] ?? '',
            'doc_supply' => $start ?? '',
            'completion' => $planned ?? '',
            'done' => self::isDone($data['done'] ?? false),
            'project_completion_date' => $actual ?? '',
            'owner' => trim((string) ($data['owner'] ?? '')),
            'dl_owner' => trim((string) ($data['dl_owner'] ?? '')),
            'progress_updated' => self::toYmd($data['progress_updated'] ?? $data['dl_progress_updated'] ?? null) ?? '',
            'last_updated' => self::taskLastUpdatedYmd($data) ?? '',
            'updated_at' => optional($task->updated_at)?->toIso8601String(),
            'dl_sec_hrs_02' => $data['dl_sec_hrs_02'] ?? '',
            'dl_sec_hrs_03' => $data['dl_sec_hrs_03'] ?? '',
            'dl_sec_hrs_04' => $data['dl_sec_hrs_04'] ?? '',
            'dl_sec_hrs_05' => $data['dl_sec_hrs_05'] ?? '',
            'dl_sec_hrs_06' => $data['dl_sec_hrs_06'] ?? '',
        ];
    }

    /**
     * Latest submission keyed by "dl_name|project_id".
     *
     * @return array<string, DlUpdateSubmission>
     */
    public static function latestSubmissionsByDlProject(): array
    {
        $rows = DlUpdateSubmission::query()
            ->orderByDesc('submitted_at')
            ->orderByDesc('id')
            ->get();

        $map = [];
        foreach ($rows as $row) {
            $key = mb_strtolower(trim((string) $row->dl_name)).'|'.$row->project_id;
            if (! isset($map[$key])) {
                $map[$key] = $row;
            }
        }

        return $map;
    }

    public static function loadActiveTasks(): Collection
    {
        return ProjectTask::query()
            ->with(['part.project'])
            ->whereHas('part.project', function ($query) {
                $query->where(function ($inner) {
                    $inner->whereNull('status')
                        ->orWhere('status', '!=', 'completed');
                });
            })
            ->orderBy('id')
            ->get();
    }

    public static function loadDlUsers(): Collection
    {
        return User::query()
            ->with('role')
            ->where('active', true)
            ->whereHas('role', fn ($query) => $query->where('name', 'DLs'))
            ->orderBy('name')
            ->get();
    }

    public static function loadEmployees(): Collection
    {
        return Employee::query()
            ->with(['team', 'nrms'])
            ->orderBy('first_name')
            ->get();
    }

    /**
     * @param  Collection<int, Employee>  $employees
     * @return list<array{id: int, name: string, team_id: int|null, team_name: string}>
     */
    public static function employeeOptions(Collection $employees): array
    {
        return $employees
            ->map(fn (Employee $employee) => [
                'id' => $employee->id,
                'name' => EmployeeNames::displayName($employee),
                'team_id' => $employee->team_id ? (int) $employee->team_id : null,
                'team_name' => $employee->team?->name ?? '',
            ])
            ->values()
            ->all();
    }

    /**
     * @param  Collection<int, Employee>  $employees
     * @return list<array{id: int, name: string}>
     */
    public static function teamOptions(Collection $employees, array $teamOapNumbers): array
    {
        $options = [];
        foreach ($employees as $employee) {
            $teamId = (int) ($employee->team_id ?? 0);
            if ($teamId <= 0 || ! isset($teamOapNumbers[$teamId]) || isset($options[$teamId])) {
                continue;
            }
            $options[$teamId] = [
                'id' => $teamId,
                'name' => $employee->team?->name ?? ('Team '.$teamId),
            ];
        }

        $list = array_values($options);
        usort($list, fn ($left, $right) => strcasecmp($left['name'], $right['name']));

        return $list;
    }
}
