<?php

namespace App\Support;

use App\Models\ActivityLog;
use App\Models\ProjectTask;
use App\Models\User;
use Illuminate\Support\Collection;

class DlLogScope
{
    /**
     * Restrict activity-log listings for the DLs role to that person's team
     * and the tasks that belong to it. Other roles get null (no restriction).
     *
     * @return array{
     *   user_id: int,
     *   dl_name: string,
     *   team_id: int|null,
     *   team_name: string,
     *   oap_numbers: list<string>,
     *   section_keys: list<string>,
     *   employee_ids: list<int>,
     *   employee_names: list<string>
     * }|null
     */
    public static function forUser(?User $user): ?array
    {
        if (! $user) {
            return null;
        }

        $user->loadMissing('role');
        if (strcasecmp(trim((string) ($user->role?->name ?? '')), 'DLs') !== 0) {
            return null;
        }

        $employees = DlQuickUpdate::loadEmployees();
        EmployeeNames::warmEmployeeCache($employees);

        $matched = null;
        foreach ([
            $user->name,
            trim(trim((string) ($user->first_name ?? '')).' '.trim((string) ($user->last_name ?? ''))),
            $user->first_name,
            $user->login_name,
        ] as $label) {
            $match = EmployeeNames::findByAnyName($label);
            if ($match) {
                $matched = $match;
                $matched->loadMissing('team');
                break;
            }
        }

        $teamId = $matched?->team_id ? (int) $matched->team_id : null;
        $teamName = $matched?->team?->name ?? '';
        $oapNumbers = $teamId
            ? (DlQuickUpdate::teamOapNrmNumbers($employees)[$teamId] ?? [])
            : [];
        $sectionKeys = DlQuickUpdate::nrmSectionKeysFromTeamName($teamName);
        $nrmTeamIds = DlQuickUpdate::nrmToTeamIds($employees);

        $employeeIds = [];
        $employeeNames = [];
        foreach ($employees as $employee) {
            if ($teamId && (int) $employee->team_id === (int) $teamId) {
                $employeeIds[] = (int) $employee->id;
                $employeeNames[] = EmployeeNames::displayName($employee);
            }
        }

        if ($matched) {
            $employeeIds[] = (int) $matched->id;
            $employeeNames[] = EmployeeNames::displayName($matched);
        }

        return [
            'user_id' => (int) $user->id,
            'dl_name' => $matched
                ? EmployeeNames::displayName($matched)
                : (trim((string) ($user->name ?? '')) ?: 'DL'),
            'team_id' => $teamId,
            'team_name' => $teamName,
            'oap_numbers' => $oapNumbers,
            'section_keys' => $sectionKeys,
            'nrm_team_ids' => $nrmTeamIds,
            'employee_ids' => array_values(array_unique($employeeIds)),
            'employee_names' => array_values(array_unique($employeeNames)),
        ];
    }

    /**
     * @param  array<string, mixed>  $scope
     * @param  Collection<int, ProjectTask>  $tasksById
     */
    public static function histogramEditMatches(array $edit, array $scope, Collection $tasksById): bool
    {
        if (self::employeeNameInScope((string) ($edit['employee'] ?? ''), $scope)
            || self::employeeNameInScope((string) ($edit['previous_employee'] ?? ''), $scope)
        ) {
            return true;
        }

        $taskId = (int) ($edit['task_id'] ?? 0);
        if ($taskId > 0 && $tasksById->has($taskId) && self::taskInScope($tasksById->get($taskId), $scope)) {
            return true;
        }

        return self::taskNameInScope((string) ($edit['task_name'] ?? ''), $scope);
    }

    /**
     * @param  array<string, mixed>  $scope
     * @param  Collection<int, ProjectTask>  $tasksById
     */
    public static function histogramLogMatches(ActivityLog $log, array $scope, Collection $tasksById): bool
    {
        if ((int) $log->user_id === (int) $scope['user_id']) {
            return true;
        }

        $changes = is_array($log->changes) ? $log->changes : [];
        foreach ($changes['edits'] ?? [] as $edit) {
            if (is_array($edit) && self::histogramEditMatches($edit, $scope, $tasksById)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Drop edits that are not this DL's team/tasks. Clears undo when the save
     * also contains other teams' bars.
     *
     * @param  array<string, mixed>  $scope
     * @param  Collection<int, ProjectTask>  $tasksById
     */
    public static function restrictHistogramLog(ActivityLog $log, array $scope, Collection $tasksById): ?ActivityLog
    {
        if (! self::histogramLogMatches($log, $scope, $tasksById)) {
            return null;
        }

        $changes = is_array($log->changes) ? $log->changes : [];
        $edits = is_array($changes['edits'] ?? null) ? $changes['edits'] : [];
        $kept = [];
        foreach ($edits as $edit) {
            if (is_array($edit) && self::histogramEditMatches($edit, $scope, $tasksById)) {
                $kept[] = $edit;
            }
        }

        $ownLog = (int) $log->user_id === (int) $scope['user_id'];
        if ($kept === [] && ! $ownLog) {
            return null;
        }

        if ($kept !== [] && count($kept) !== count($edits)) {
            $changes['edits'] = $kept;
            $changes['reversible_edits'] = [];
            $log->setAttribute('changes', $changes);
        }

        return $log;
    }

    /**
     * @param  array<string, mixed>  $scope
     * @param  Collection<int, ProjectTask>  $tasksById
     */
    public static function dlPlanLogMatches(ActivityLog $log, array $scope, Collection $tasksById): bool
    {
        if ((int) $log->user_id === (int) $scope['user_id']) {
            return true;
        }

        $changes = is_array($log->changes) ? $log->changes : [];
        $meta = is_array($log->meta) ? $log->meta : [];

        foreach (PlanActivityLog::taskIdsFromLog($meta, $changes) as $taskId) {
            if ($tasksById->has($taskId) && self::taskInScope($tasksById->get($taskId), $scope)) {
                return true;
            }
        }

        foreach (PlanActivityLog::taskIdsFromChanges($changes) as $taskId) {
            if ($tasksById->has($taskId) && self::taskInScope($tasksById->get($taskId), $scope)) {
                return true;
            }
        }

        foreach (['created', 'updated', 'deleted'] as $bucket) {
            foreach ($changes[$bucket] ?? [] as $item) {
                if (! is_array($item)) {
                    continue;
                }
                if (self::taskNameInScope((string) ($item['task_name'] ?? ''), $scope)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * @param  array<string, mixed>  $scope
     * @param  Collection<int, ProjectTask>  $tasksById
     */
    public static function restrictDlPlanLog(ActivityLog $log, array $scope, Collection $tasksById): ?ActivityLog
    {
        if (! self::dlPlanLogMatches($log, $scope, $tasksById)) {
            return null;
        }

        $changes = is_array($log->changes) ? $log->changes : [];
        $ownLog = (int) $log->user_id === (int) $scope['user_id'];
        $filtered = false;

        foreach (['created', 'updated', 'deleted'] as $bucket) {
            if (! is_array($changes[$bucket] ?? null)) {
                continue;
            }

            $kept = [];
            foreach ($changes[$bucket] as $item) {
                if (! is_array($item)) {
                    continue;
                }
                $taskId = (int) ($item['id'] ?? 0);
                $matches = ($taskId > 0 && $tasksById->has($taskId) && self::taskInScope($tasksById->get($taskId), $scope))
                    || self::taskNameInScope((string) ($item['task_name'] ?? ''), $scope);
                if ($matches) {
                    $kept[] = $item;
                }
            }

            if (count($kept) !== count($changes[$bucket])) {
                $changes[$bucket] = $kept;
                $filtered = true;
            }
        }

        if ($filtered) {
            $hasItems = ($changes['created'] ?? []) !== []
                || ($changes['updated'] ?? []) !== []
                || ($changes['deleted'] ?? []) !== [];
            if (! $hasItems && ! $ownLog) {
                return null;
            }
            $log->setAttribute('changes', $changes);
        }

        return $log;
    }

    /**
     * @param  array<string, mixed>  $scope
     */
    public static function trainingLogMatches(ActivityLog $log, array $scope): bool
    {
        if ((int) $log->user_id === (int) $scope['user_id']) {
            return true;
        }

        $meta = is_array($log->meta) ? $log->meta : [];
        $changes = is_array($log->changes) ? $log->changes : [];
        $employeeIds = [];

        foreach (['employee_id'] as $key) {
            if (isset($meta[$key]) && is_numeric($meta[$key])) {
                $employeeIds[] = (int) $meta[$key];
            }
        }

        $employeeChange = $changes['employee_id'] ?? null;
        if (is_array($employeeChange)) {
            foreach (['from', 'to'] as $side) {
                if (isset($employeeChange[$side]) && is_numeric($employeeChange[$side])) {
                    $employeeIds[] = (int) $employeeChange[$side];
                }
            }
        }

        $allowed = array_fill_keys($scope['employee_ids'], true);
        foreach ($employeeIds as $employeeId) {
            if (isset($allowed[$employeeId])) {
                return true;
            }
        }

        $summary = (string) ($log->summary ?? '');
        foreach ($scope['employee_names'] as $name) {
            if ($name !== '' && mb_stripos($summary, $name) !== false) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<string, mixed>  $scope
     */
    public static function taskInScope(?ProjectTask $task, array $scope): bool
    {
        if (! $task) {
            return false;
        }

        return self::taskNameInScope((string) ($task->task_name ?? ''), $scope);
    }

    /**
     * @param  array<string, mixed>  $scope
     */
    public static function taskNameInScope(string $taskName, array $scope): bool
    {
        $nrmNumber = DlQuickUpdate::extractNrmNumber($taskName);
        if ($scope['oap_numbers'] !== [] && DlQuickUpdate::taskMatchesOapNumbers($nrmNumber, $scope['oap_numbers'])) {
            return true;
        }

        if ($scope['section_keys'] !== [] && DlQuickUpdate::taskBelongsToNrmSection(
            ['nrm_number' => $nrmNumber],
            $scope['section_keys'],
        )) {
            return true;
        }

        $teamId = (int) ($scope['team_id'] ?? 0);
        if ($teamId > 0 && $nrmNumber) {
            $canonical = NrmCatalog::canonicalNumber($nrmNumber) ?? $nrmNumber;
            $teams = $scope['nrm_team_ids'][$nrmNumber]
                ?? $scope['nrm_team_ids'][$canonical]
                ?? [];
            if (in_array($teamId, array_map('intval', $teams), true)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<string, mixed>  $scope
     */
    public static function employeeNameInScope(string $name, array $scope): bool
    {
        $name = trim($name);
        if ($name === '') {
            return false;
        }

        foreach ($scope['employee_names'] as $teamName) {
            if (EmployeeNames::namesMatch($name, $teamName)) {
                return true;
            }
        }

        return EmployeeNames::namesMatch($name, (string) ($scope['dl_name'] ?? ''));
    }

    /**
     * @param  Collection<int, ActivityLog>  $logs
     * @return list<int>
     */
    public static function collectTaskIds(Collection $logs): array
    {
        $ids = [];

        foreach ($logs as $log) {
            $changes = is_array($log->changes) ? $log->changes : [];
            $meta = is_array($log->meta) ? $log->meta : [];

            foreach ($changes['edits'] ?? [] as $edit) {
                if (! is_array($edit)) {
                    continue;
                }
                $taskId = (int) ($edit['task_id'] ?? 0);
                if ($taskId > 0) {
                    $ids[] = $taskId;
                }
            }

            foreach (PlanActivityLog::taskIdsFromLog($meta, $changes) as $taskId) {
                $ids[] = $taskId;
            }
            foreach (PlanActivityLog::taskIdsFromChanges($changes) as $taskId) {
                $ids[] = $taskId;
            }
        }

        return array_values(array_unique($ids));
    }

    /**
     * @param  list<int>  $taskIds
     * @return Collection<int, ProjectTask>
     */
    public static function tasksById(array $taskIds): Collection
    {
        if ($taskIds === []) {
            return collect();
        }

        return ProjectTask::query()
            ->whereIn('id', $taskIds)
            ->get(['id', 'task_name'])
            ->keyBy('id');
    }
}
