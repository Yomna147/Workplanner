<?php

namespace App\Support;

use App\Http\Controllers\Api\ResourceHistogramController;
use App\Models\Employee;
use App\Models\EmployeeTraining;
use App\Models\HistogramScheduleOverride;
use Carbon\Carbon;
use Carbon\CarbonPeriod;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/**
 * When training takes capacity on a day, free those operative-hours from the
 * algorithm schedule so project + training does not overbook the day.
 * Project tasks stay; only assigned hours on the conflicting days are reduced.
 */
class TrainingProjectHourDisplacement
{
    /** Free min(project, training) so training always has room (override save). */
    public const MODE_RESERVE = 'reserve';

    /** Free only overflow so project + training fits day capacity (post-algo repair). */
    public const MODE_OVERFLOW = 'overflow';

    /**
     * Reduce project assignment hours for an operative to make room for training.
     *
     * @param  list<array<string, mixed>>  $conflicts  From TrainingOccupiedSlotChecker
     * @return array{changed: bool, hours_freed: float, suggest_algorithm_rerun: bool}
     */
    public static function applyForTraining(
        EmployeeTraining $training,
        array $conflicts = [],
        ?Request $request = null,
    ): array {
        if (! (bool) $training->confirm_override) {
            return self::emptyResult();
        }

        $employeeId = (int) $training->employee_id;
        $hoursPerDay = (float) $training->hours_per_day;
        $start = $training->start_date?->toDateString();
        $end = $training->end_date?->toDateString() ?: $start;

        if ($employeeId <= 0 || $hoursPerDay <= 0.05 || ! $start || ! $end) {
            return self::emptyResult(true);
        }

        $jobs = [[
            'employee_id' => $employeeId,
            'days' => self::workingDays($start, $end),
            'hours_per_day' => $hoursPerDay,
            'preferred_task_ids' => self::preferredTaskIdsFromConflicts($conflicts),
            'mode' => self::MODE_RESERVE,
        ]];

        $result = self::runDisplacementJobs($jobs, $request);

        // Override always means capacity changed — planners should re-run the algo
        // so remaining project hours can land on free days.
        return [
            'changed' => $result['changed'],
            'hours_freed' => $result['hours_freed'],
            'suggest_algorithm_rerun' => true,
        ];
    }

    /**
     * Fix trainings (override or not) that still overbook project hours —
     * e.g. after HistogramScheduleOverrides::reapply restores full-day bars.
     *
     * @return array{changed: bool, hours_freed: float, suggest_algorithm_rerun: bool}
     */
    public static function repairOverbookedOverrides(?Request $request = null): array
    {
        $trainings = EmployeeTraining::query()
            ->whereNotNull('start_date')
            ->whereNotNull('end_date')
            ->where('hours_per_day', '>', 0)
            ->get([
                'id',
                'employee_id',
                'start_date',
                'end_date',
                'hours_per_day',
                'confirm_override',
            ]);

        if ($trainings->isEmpty()) {
            return self::emptyResult();
        }

        $jobs = [];
        foreach ($trainings as $training) {
            $start = $training->start_date->toDateString();
            $end = $training->end_date->toDateString();
            $jobs[] = [
                'employee_id' => (int) $training->employee_id,
                'days' => self::workingDays($start, $end),
                'hours_per_day' => (float) $training->hours_per_day,
                'preferred_task_ids' => [],
                'mode' => (bool) $training->confirm_override
                    ? self::MODE_RESERVE
                    : self::MODE_OVERFLOW,
            ];
        }

        return self::runDisplacementJobs($jobs, $request);
    }

    /**
     * @param  list<array{employee_id:int, days:list<string>, hours_per_day:float, preferred_task_ids:list<int>, mode?:string}>  $jobs
     * @return array{changed: bool, hours_freed: float, suggest_algorithm_rerun: bool}
     */
    private static function runDisplacementJobs(array $jobs, ?Request $request = null): array
    {
        $jobs = array_values(array_filter(
            $jobs,
            static fn (array $job) => ($job['employee_id'] ?? 0) > 0
                && ($job['hours_per_day'] ?? 0) > 0.05
                && ($job['days'] ?? []) !== [],
        ));

        if ($jobs === []) {
            return self::emptyResult();
        }

        EmployeeNames::warmEmployeeCache();
        $lock = Cache::lock('algorithm-cache-write', 30);
        $lockAcquired = false;

        try {
            $lock->block(15);
            $lockAcquired = true;

            $cached = AlgorithmCache::get($request);
            $details = is_array($cached['assignmentDetails'] ?? null)
                ? $cached['assignmentDetails']
                : [];
            if ($details === []) {
                return self::emptyResult(true);
            }

            $capIndex = EmployeeAvailabilityHours::buildCapIndexForAssignments($details);
            $touchedKeys = [];
            $changed = false;
            $hoursFreed = 0.0;

            foreach ($jobs as $job) {
                $employee = Employee::query()->find((int) $job['employee_id']);
                if (! $employee) {
                    continue;
                }

                $displayName = EmployeeNames::displayName($employee);
                $employeeName = EmployeeNames::canonicalize($displayName) ?? $displayName;
                if ($employeeName === '') {
                    continue;
                }

                $nameKeys = self::employeeMatchKeys($employee, $employeeName);
                $preferred = array_fill_keys(
                    array_map('intval', array_filter($job['preferred_task_ids'] ?? [])),
                    true,
                );
                $trainingHours = (float) $job['hours_per_day'];
                $mode = ($job['mode'] ?? self::MODE_OVERFLOW) === self::MODE_RESERVE
                    ? self::MODE_RESERVE
                    : self::MODE_OVERFLOW;

                foreach ($job['days'] as $ymd) {
                    $projectBooked = self::employeeProjectHoursOnDay($details, $nameKeys, $ymd);
                    if ($projectBooked <= 0.05) {
                        continue;
                    }

                    $capacity = EmployeeAvailabilityHours::resolveDailyCapForEmployee(
                        $capIndex,
                        $employeeName,
                        $ymd,
                        false,
                    );
                    if ($capacity === null) {
                        $capacity = EmployeeAvailabilityHours::DEFAULT_WORKDAY_HOURS;
                    }

                    if ($mode === self::MODE_RESERVE) {
                        // Always free training hours from project work on override.
                        $hoursToFree = min($projectBooked, $trainingHours);
                    } else {
                        $hoursToFree = max(0.0, $projectBooked + $trainingHours - (float) $capacity);
                    }

                    if ($hoursToFree <= 0.05) {
                        continue;
                    }

                    $result = self::reduceDayHours(
                        $details,
                        $nameKeys,
                        $ymd,
                        $hoursToFree,
                        $preferred,
                    );
                    $details = $result['details'];
                    if ($result['reduced'] > 0.05) {
                        $changed = true;
                        $hoursFreed = round($hoursFreed + $result['reduced'], 4);
                        foreach ($result['touched'] as $key => $meta) {
                            $touchedKeys[$key] = $meta;
                        }
                    }
                }
            }

            if (! $changed) {
                return self::emptyResult();
            }

            foreach ($touchedKeys as $meta) {
                $hoursByDay = HistogramScheduleOverrides::extractEmployeeHours(
                    $details,
                    (int) $meta['task_id'],
                    (string) $meta['employee'],
                );

                if ($hoursByDay === []) {
                    HistogramScheduleOverride::query()
                        ->where('task_id', (int) $meta['task_id'])
                        ->where('employee', (string) $meta['employee'])
                        ->delete();
                    continue;
                }

                HistogramScheduleOverride::query()->updateOrCreate(
                    [
                        'task_id' => (int) $meta['task_id'],
                        'employee' => (string) $meta['employee'],
                    ],
                    [
                        'hours_by_day' => $hoursByDay,
                    ],
                );
            }

            AlgorithmCache::put([
                ...(is_array($cached) ? $cached : []),
                'assignmentDetails' => $details,
            ], $request);

            ResourceHistogramController::clearFullPayloadCache($request);

            return [
                'changed' => true,
                'hours_freed' => $hoursFreed,
                'suggest_algorithm_rerun' => true,
            ];
        } finally {
            if ($lockAcquired) {
                $lock->release();
            }
            EmployeeNames::clearEmployeeCache();
        }
    }

    /**
     * @return array{changed: bool, hours_freed: float, suggest_algorithm_rerun: bool}
     */
    private static function emptyResult(bool $suggestRerun = false): array
    {
        return [
            'changed' => false,
            'hours_freed' => 0.0,
            'suggest_algorithm_rerun' => $suggestRerun,
        ];
    }

    /**
     * @return list<string>
     */
    private static function employeeMatchKeys(Employee $employee, string $canonicalName): array
    {
        $keys = [];
        foreach ([
            $canonicalName,
            EmployeeNames::displayName($employee),
            trim((string) $employee->first_name),
            trim((string) (($employee->first_name ?? '').' '.($employee->last_name ?? ''))),
        ] as $value) {
            $trimmed = trim((string) $value);
            if ($trimmed === '') {
                continue;
            }
            $canon = EmployeeNames::canonicalize($trimmed) ?? $trimmed;
            $keys[mb_strtolower($canon)] = $canon;
            $keys[mb_strtolower($trimmed)] = $trimmed;
        }

        return array_values($keys);
    }

    /**
     * @param  array<int, array<string, mixed>>  $details
     * @param  list<string>  $nameKeys
     */
    private static function employeeProjectHoursOnDay(
        array $details,
        array $nameKeys,
        string $ymd,
    ): float {
        $total = 0.0;
        $keySet = [];
        foreach ($nameKeys as $key) {
            $keySet[mb_strtolower($key)] = true;
        }

        foreach ($details as $taskDetail) {
            foreach ($taskDetail['assignments'] ?? [] as $assignment) {
                if (! is_array($assignment)) {
                    continue;
                }

                $assignee = EmployeeNames::canonicalize((string) ($assignment['employee'] ?? ''))
                    ?? trim((string) ($assignment['employee'] ?? ''));
                if ($assignee === '' || ! isset($keySet[mb_strtolower($assignee)])) {
                    $raw = trim((string) ($assignment['employee'] ?? ''));
                    if ($raw === '' || ! isset($keySet[mb_strtolower($raw)])) {
                        continue;
                    }
                }

                $day = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;
                if ($day === $ymd && $hours > 0.05) {
                    $total += $hours;
                }
            }
        }

        return round($total, 4);
    }

    /**
     * @param  array<int, array<string, mixed>>  $details
     * @param  list<string>  $nameKeys
     * @param  array<int, true>  $preferredTaskIds
     * @return array{details: array<int, array<string, mixed>>, reduced: float, touched: array<string, array{task_id:int, employee:string}>}
     */
    private static function reduceDayHours(
        array $details,
        array $nameKeys,
        string $ymd,
        float $hoursToFree,
        array $preferredTaskIds,
    ): array {
        $keySet = [];
        foreach ($nameKeys as $key) {
            $keySet[mb_strtolower($key)] = true;
        }

        $candidates = [];

        foreach ($details as $detailIndex => $taskDetail) {
            $taskId = (int) ($taskDetail['task_id'] ?? 0);
            $assignments = is_array($taskDetail['assignments'] ?? null)
                ? $taskDetail['assignments']
                : [];

            foreach ($assignments as $assignmentIndex => $assignment) {
                if (! is_array($assignment)) {
                    continue;
                }

                $raw = trim((string) ($assignment['employee'] ?? ''));
                $assignee = EmployeeNames::canonicalize($raw) ?? $raw;
                if ($assignee === '' || (
                    ! isset($keySet[mb_strtolower($assignee)])
                    && ! isset($keySet[mb_strtolower($raw)])
                )) {
                    continue;
                }

                $day = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;
                if ($day !== $ymd || $hours <= 0.05) {
                    continue;
                }

                $candidates[] = [
                    'detail_index' => $detailIndex,
                    'assignment_index' => $assignmentIndex,
                    'task_id' => $taskId,
                    'employee' => $assignee !== '' ? $assignee : $raw,
                    'hours' => $hours,
                    'preferred' => $taskId > 0 && isset($preferredTaskIds[$taskId]),
                ];
            }
        }

        if ($candidates === []) {
            return ['details' => $details, 'reduced' => 0.0, 'touched' => []];
        }

        usort($candidates, static function (array $left, array $right) {
            if ($left['preferred'] !== $right['preferred']) {
                return $left['preferred'] ? -1 : 1;
            }

            return $right['hours'] <=> $left['hours'];
        });

        $remaining = $hoursToFree;
        $touched = [];
        $reducedTotal = 0.0;

        foreach ($candidates as $candidate) {
            if ($remaining <= 0.05) {
                break;
            }

            $detailIndex = $candidate['detail_index'];
            $assignmentIndex = $candidate['assignment_index'];
            $current = (float) ($details[$detailIndex]['assignments'][$assignmentIndex]['hours'] ?? 0);
            if ($current <= 0.05) {
                continue;
            }

            $cut = min($current, $remaining);
            $nextHours = round($current - $cut, 4);

            if ($nextHours <= 0.05) {
                unset($details[$detailIndex]['assignments'][$assignmentIndex]);
                $details[$detailIndex]['assignments'] = array_values(
                    $details[$detailIndex]['assignments'],
                );
            } else {
                $details[$detailIndex]['assignments'][$assignmentIndex]['hours'] = $nextHours;
            }

            $remaining = round($remaining - $cut, 4);
            $reducedTotal = round($reducedTotal + $cut, 4);
            $key = $candidate['task_id'].'|'.mb_strtolower($candidate['employee']);
            $touched[$key] = [
                'task_id' => $candidate['task_id'],
                'employee' => $candidate['employee'],
            ];
        }

        return [
            'details' => $details,
            'reduced' => $reducedTotal,
            'touched' => $touched,
        ];
    }

    /**
     * @param  list<array<string, mixed>>  $conflicts
     * @return list<int>
     */
    private static function preferredTaskIdsFromConflicts(array $conflicts): array
    {
        $ids = [];
        foreach ($conflicts as $conflict) {
            foreach (($conflict['tasks'] ?? []) as $task) {
                $id = (int) ($task['task_id'] ?? 0);
                if ($id > 0) {
                    $ids[$id] = $id;
                }
            }
        }

        return array_values($ids);
    }

    /**
     * @return list<string>
     */
    private static function workingDays(string $start, string $end): array
    {
        $days = [];
        foreach (CarbonPeriod::create($start, $end) as $day) {
            if ($day->isWeekend()) {
                continue;
            }
            $days[] = $day->toDateString();
        }

        return $days;
    }

    private static function normalizeDate(string $value): ?string
    {
        $raw = trim($value);
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
}
