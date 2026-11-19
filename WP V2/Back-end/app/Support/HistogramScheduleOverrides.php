<?php

namespace App\Support;

use App\Models\HistogramScheduleOverride;
use Carbon\Carbon;

/**
 * Durable per-employee histogram schedules (task_id + employee).
 * Survives algorithm cache rebuilds by reapplying after each algo run.
 */
class HistogramScheduleOverrides
{
    /**
     * Drop saved histogram schedules (pins) for the given tasks.
     * Used when PDE/DL edits a task so the next algo run is not stuck on a stale day map.
     *
     * @param  array<int, int|string>  $taskIds
     */
    public static function clearForTaskIds(array $taskIds): void
    {
        $ids = collect($taskIds)
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($ids === []) {
            return;
        }

        HistogramScheduleOverride::query()
            ->whereIn('task_id', $ids)
            ->delete();
    }

    /**
     * Persist the resulting schedules for every employee touched by the edits.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  array<int, array<string, mixed>>  $edits
     */
    public static function persistFromEdits(array $assignmentDetails, array $edits): void
    {
        $keys = [];

        foreach ($edits as $edit) {
            $taskId = (int) ($edit['task_id'] ?? 0);
            if ($taskId <= 0) {
                continue;
            }

            foreach ([
                trim((string) ($edit['employee'] ?? '')),
                trim((string) ($edit['previous_employee'] ?? '')),
            ] as $employee) {
                if ($employee === '') {
                    continue;
                }
                $canonical = EmployeeNames::canonicalize($employee) ?? $employee;
                $keys[$taskId.'|'.mb_strtolower($canonical)] = [
                    'task_id' => $taskId,
                    'employee' => $canonical,
                ];
            }
        }

        foreach ($keys as $key) {
            $hoursByDay = self::extractEmployeeHours(
                $assignmentDetails,
                $key['task_id'],
                $key['employee'],
            );

            if ($hoursByDay === []) {
                HistogramScheduleOverride::query()
                    ->where('task_id', $key['task_id'])
                    ->where('employee', $key['employee'])
                    ->delete();
                continue;
            }

            HistogramScheduleOverride::query()->updateOrCreate(
                [
                    'task_id' => $key['task_id'],
                    'employee' => $key['employee'],
                ],
                [
                    'hours_by_day' => $hoursByDay,
                ],
            );
        }
    }

    /**
     * After algorithm reconcile, rewrite existing override rows from the final
     * assignment details so the next algo run reapplies the reconciled schedules.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     */
    public static function syncExistingFromAssignments(array $assignmentDetails): void
    {
        $overrides = HistogramScheduleOverride::query()->get();
        if ($overrides->isEmpty()) {
            return;
        }

        $sealedIds = AlgorithmSealedAssignments::sealedTaskIdSet(
            $overrides->pluck('task_id')->map(fn ($id) => (int) $id)->all(),
        );

        foreach ($overrides as $override) {
            $taskId = (int) $override->task_id;
            if ($taskId > 0 && isset($sealedIds[$taskId])) {
                continue;
            }

            $employee = EmployeeNames::canonicalize((string) $override->employee)
                ?? trim((string) $override->employee);

            $lockedRoster = self::resolveManualOverrideRosterForTask($assignmentDetails, $taskId);
            if ($lockedRoster !== null && ! self::employeeOnManualOverrideRoster($employee, $lockedRoster)) {
                $override->delete();
                continue;
            }

            $hoursByDay = self::extractEmployeeHours(
                $assignmentDetails,
                $taskId,
                (string) $override->employee,
            );

            if ($hoursByDay === []) {
                $override->delete();
                continue;
            }

            $override->hours_by_day = $hoursByDay;
            $override->save();
        }
    }

    /**
     * Reapply durable histogram schedule overrides onto algorithm assignment details.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return array<int, array<string, mixed>>
     */
    public static function reapply(array $assignmentDetails): array
    {
        if ($assignmentDetails === []) {
            return $assignmentDetails;
        }

        $overrides = HistogramScheduleOverride::query()->get();
        if ($overrides->isEmpty()) {
            return $assignmentDetails;
        }

        $sealedFromDetails = [];
        foreach ($assignmentDetails as $detail) {
            $taskId = (int) ($detail['task_id'] ?? 0);
            if ($taskId > 0 && ! empty($detail['sealed'])) {
                $sealedFromDetails[$taskId] = true;
            }
        }
        $sealedIds = AlgorithmSealedAssignments::sealedTaskIdSet(array_values(array_unique(array_merge(
            array_keys($sealedFromDetails),
            $overrides->pluck('task_id')->map(fn ($id) => (int) $id)->all(),
        ))));

        foreach ($overrides as $override) {
            $taskId = (int) $override->task_id;
            if ($taskId > 0 && (isset($sealedIds[$taskId]) || isset($sealedFromDetails[$taskId]))) {
                continue;
            }

            $employee = EmployeeNames::canonicalize((string) $override->employee)
                ?? trim((string) $override->employee);

            if ($employee === '') {
                continue;
            }

            // Manual override roster (2+) locks assignees — drop stale histogram rows (e.g. Gabriel).
            $lockedRoster = self::resolveManualOverrideRosterForTask($assignmentDetails, $taskId);
            if ($lockedRoster !== null && ! self::employeeOnManualOverrideRoster($employee, $lockedRoster)) {
                $override->delete();
                continue;
            }

            $assignmentDetails = self::replaceEmployeeSchedule(
                $assignmentDetails,
                $taskId,
                $employee,
                is_array($override->hours_by_day) ? $override->hours_by_day : [],
            );
        }

        return $assignmentDetails;
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return array<string, float>
     */
    public static function extractEmployeeHours(
        array $assignmentDetails,
        int $taskId,
        string $employee,
    ): array {
        $hoursByDay = [];

        foreach ($assignmentDetails as $taskDetail) {
            if ((int) ($taskDetail['task_id'] ?? 0) !== $taskId) {
                continue;
            }

            foreach ($taskDetail['assignments'] ?? [] as $assignment) {
                if (! is_array($assignment)) {
                    continue;
                }
                if (! self::employeeMatches($assignment, $employee)) {
                    continue;
                }

                $day = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null)
                    ? (float) $assignment['hours']
                    : 0.0;
                if ($day === null || $hours <= 0.001) {
                    continue;
                }

                $hoursByDay[$day] = ($hoursByDay[$day] ?? 0.0) + $hours;
            }

            break;
        }

        ksort($hoursByDay);

        return array_map(
            static fn (float $hours) => round($hours, 4),
            $hoursByDay,
        );
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  array<string, mixed>  $hoursByDay
     * @return array<int, array<string, mixed>>
     */
    public static function replaceEmployeeSchedule(
        array $assignmentDetails,
        int $taskId,
        string $employee,
        array $hoursByDay,
    ): array {
        if ($taskId <= 0 || trim($employee) === '') {
            return $assignmentDetails;
        }

        $canonical = EmployeeNames::canonicalize($employee) ?? $employee;
        $normalizedHours = self::normalizeHoursByDay($hoursByDay);
        $usedByDay = self::otherTaskHoursByDay($assignmentDetails, $taskId, $canonical);
        $capIndex = EmployeeAvailabilityHours::buildCapIndexForAssignments($assignmentDetails);

        foreach ($assignmentDetails as $index => $taskDetail) {
            if ((int) ($taskDetail['task_id'] ?? 0) !== $taskId) {
                continue;
            }

            $assignments = is_array($taskDetail['assignments'] ?? null)
                ? $taskDetail['assignments']
                : [];

            // Keep every other employee's rows; drop this employee's entire schedule.
            $assignments = array_values(array_filter(
                $assignments,
                static fn ($assignment) => is_array($assignment)
                    && ! self::employeeMatches($assignment, $canonical),
            ));

            // Do NOT apply SH fair-cap here. A saved histogram pin is the user's
            // explicit day map — capping to SH/override slots silently undoes edits
            // (especially after Allocation % pins create 2+ overrides).
            // Daily AVA room below still prevents impossible overloads.

            foreach ($normalizedHours as $day => $hours) {
                $cap = EmployeeAvailabilityHours::resolveDailyCapForEmployee(
                    $capIndex,
                    $canonical,
                    $day,
                    false,
                );
                // Match ApplyHistogramBarEdits: unknown/missing AVA → default workday,
                // not 0h (which was wiping saved pins when the cap index lacked the emp).
                $maxHours = max(0.0, $cap ?? EmployeeAvailabilityHours::DEFAULT_WORKDAY_HOURS);
                $usedElsewhere = $usedByDay[$day] ?? 0.0;
                $allowed = max(0.0, $maxHours - $usedElsewhere);
                $hours = round(min($hours, $allowed), 4);
                if ($hours <= 0.001) {
                    continue;
                }

                $assignments[] = [
                    'employee' => $canonical,
                    'date' => $day,
                    'hours' => $hours,
                ];
            }

            usort($assignments, static function (array $left, array $right) {
                $dateCmp = strcmp((string) ($left['date'] ?? ''), (string) ($right['date'] ?? ''));
                if ($dateCmp !== 0) {
                    return $dateCmp;
                }

                return strcasecmp((string) ($left['employee'] ?? ''), (string) ($right['employee'] ?? ''));
            });

            $assignmentDetails[$index]['assignments'] = $assignments;

            return $assignmentDetails;
        }

        return $assignmentDetails;
    }

    /**
     * Hours already booked for this employee on other tasks, keyed by day.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return array<string, float>
     */
    private static function otherTaskHoursByDay(
        array $assignmentDetails,
        int $excludeTaskId,
        string $employee,
    ): array {
        $used = [];

        foreach ($assignmentDetails as $taskDetail) {
            $currentTaskId = (int) ($taskDetail['task_id'] ?? 0);
            if ($currentTaskId === $excludeTaskId) {
                continue;
            }

            foreach ($taskDetail['assignments'] ?? [] as $assignment) {
                if (! is_array($assignment) || ! self::employeeMatches($assignment, $employee)) {
                    continue;
                }

                $day = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null)
                    ? (float) $assignment['hours']
                    : 0.0;
                if ($day === null || $hours <= 0.001) {
                    continue;
                }

                $used[$day] = ($used[$day] ?? 0.0) + $hours;
            }
        }

        return $used;
    }

    private static function employeeMatches(array $assignment, string $employee): bool
    {
        $assignmentEmployee = trim((string) ($assignment['employee'] ?? ''));
        if ($assignmentEmployee === '') {
            return false;
        }

        $left = EmployeeNames::canonicalize($assignmentEmployee) ?? $assignmentEmployee;
        $right = EmployeeNames::canonicalize($employee) ?? $employee;

        return strcasecmp($left, $right) === 0;
    }

    /**
     * @param  array<string|int, mixed>  $hoursByDay
     * @return array<string, float>
     */
    private static function normalizeHoursByDay(array $hoursByDay): array
    {
        $normalized = [];

        foreach ($hoursByDay as $day => $hours) {
            $ymd = self::normalizeDate(is_string($day) ? $day : (string) $day);
            if ($ymd === null) {
                continue;
            }

            $value = is_numeric($hours) ? (float) $hours : 0.0;
            if ($value <= 0.001) {
                continue;
            }

            $normalized[$ymd] = round($value, 4);
        }

        ksort($normalized);

        return $normalized;
    }

    private static function normalizeDate(string $value): ?string
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }

        try {
            return Carbon::parse($value)->toDateString();
        } catch (\Throwable) {
            if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $value, $matches)) {
                return $matches[1];
            }

            return null;
        }
    }

    /**
     * When a task has 2+ manual overrides, only those employees may receive hours.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return list<string>|null Canonical employee names, or null when roster is not locked
     */
    private static function resolveManualOverrideRosterForTask(array $assignmentDetails, int $taskId): ?array
    {
        if ($taskId <= 0) {
            return null;
        }

        foreach ($assignmentDetails as $taskDetail) {
            if ((int) ($taskDetail['task_id'] ?? 0) !== $taskId) {
                continue;
            }

            $names = array_values(array_filter([
                $taskDetail['override_1'] ?? null,
                $taskDetail['override_2'] ?? null,
                $taskDetail['override_3'] ?? null,
            ]));

            if (count($names) < 2) {
                return null;
            }

            return array_values(array_filter(array_map(
                static fn ($name) => EmployeeNames::canonicalize((string) $name) ?? trim((string) $name),
                $names,
            )));
        }

        return null;
    }

    /**
     * @param  list<string>  $lockedRoster
     */
    private static function employeeOnManualOverrideRoster(string $employee, array $lockedRoster): bool
    {
        $canonical = EmployeeNames::canonicalize($employee) ?? trim($employee);
        if ($canonical === '') {
            return false;
        }

        foreach ($lockedRoster as $allowed) {
            if (strcasecmp($canonical, $allowed) === 0) {
                return true;
            }
        }

        return false;
    }

    /**
     * Rebuild end_dates / totals on a task detail after its assignments change.
     *
     * @param  array<string, mixed>  $detail
     * @return array<string, mixed>
     */
    public static function refreshDetailAggregates(array $detail): array
    {
        $assignments = is_array($detail['assignments'] ?? null) ? $detail['assignments'] : [];
        $endDates = [];
        $totalHours = 0.0;

        foreach ($assignments as $row) {
            if (! is_array($row)) {
                continue;
            }
            $employee = EmployeeNames::canonicalize((string) ($row['employee'] ?? ''))
                ?: trim((string) ($row['employee'] ?? ''));
            $day = self::normalizeDate((string) ($row['date'] ?? ''));
            $hours = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
            if ($employee === '' || $day === null || $hours <= 0.001) {
                continue;
            }

            $totalHours += $hours;
            if (! isset($endDates[$employee]) || strcmp($day, $endDates[$employee]) > 0) {
                $endDates[$employee] = $day;
            }
        }

        $detail['assignments'] = array_values($assignments);
        $detail['end_dates'] = $endDates;
        $detail['total_assigned_hours'] = round($totalHours, 4);

        return $detail;
    }
}
