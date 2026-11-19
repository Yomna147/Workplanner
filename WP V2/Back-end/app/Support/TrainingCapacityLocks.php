<?php

namespace App\Support;

use App\Models\Employee;
use App\Models\EmployeeTraining;
use Carbon\Carbon;
use Carbon\CarbonPeriod;
use Illuminate\Support\Collection;

/**
 * Builds operative-day hour maps from saved trainings so the algorithm and
 * training occupancy checks reserve the same capacity.
 *
 * @phpstan-type HoursByEmployeeDate array<string, array<string, float>>
 */
class TrainingCapacityLocks
{
    /**
     * Training hours keyed by employee_id then Y-m-d (preferred for algo locks).
     *
     * @param  array{0?: string, 1?: string}|null  $dateBounds  [start, end] inclusive
     * @param  list<int>|null  $employeeIds  null = all employees with trainings in range
     * @return array<int, array<string, float>>
     */
    public static function buildHoursByEmployeeId(
        ?array $dateBounds = null,
        ?array $employeeIds = null,
        ?int $ignoreTrainingId = null,
    ): array {
        $start = isset($dateBounds[0]) ? self::normalizeDate((string) $dateBounds[0]) : null;
        $end = isset($dateBounds[1]) ? self::normalizeDate((string) $dateBounds[1]) : null;

        $query = EmployeeTraining::query()
            ->whereNotNull('start_date')
            ->whereNotNull('end_date')
            ->where('hours_per_day', '>', 0);

        if ($start && $end) {
            $query->whereDate('start_date', '<=', $end)
                ->whereDate('end_date', '>=', $start);
        }

        if (is_array($employeeIds) && $employeeIds !== []) {
            $ids = array_values(array_unique(array_filter(array_map('intval', $employeeIds))));
            if ($ids === []) {
                return [];
            }
            $query->whereIn('employee_id', $ids);
        }

        if ($ignoreTrainingId) {
            $query->where('id', '!=', $ignoreTrainingId);
        }

        $trainings = $query->get([
            'id',
            'employee_id',
            'start_date',
            'end_date',
            'hours_per_day',
        ]);

        if ($trainings->isEmpty()) {
            return [];
        }

        $used = [];

        foreach ($trainings as $training) {
            $employeeId = (int) $training->employee_id;
            $hours = (float) $training->hours_per_day;
            if ($employeeId <= 0 || $hours <= 0.05) {
                continue;
            }

            $from = $training->start_date->toDateString();
            $to = $training->end_date->toDateString();
            if ($start && $from < $start) {
                $from = $start;
            }
            if ($end && $to > $end) {
                $to = $end;
            }
            if ($to < $from) {
                continue;
            }

            foreach (CarbonPeriod::create($from, $to) as $day) {
                if ($day->isWeekend()) {
                    continue;
                }
                $ymd = $day->toDateString();
                if (! isset($used[$employeeId])) {
                    $used[$employeeId] = [];
                }
                $used[$employeeId][$ymd] = round(
                    ($used[$employeeId][$ymd] ?? 0.0) + $hours,
                    4,
                );
            }
        }

        return $used;
    }

    /**
     * Training hours keyed by canonical employee name then Y-m-d.
     *
     * @param  array{0?: string, 1?: string}|null  $dateBounds  [start, end] inclusive
     * @param  list<int>|null  $employeeIds  null = all employees with trainings in range
     * @return HoursByEmployeeDate
     */
    public static function buildAvailabilityUsedMap(
        ?array $dateBounds = null,
        ?array $employeeIds = null,
        ?int $ignoreTrainingId = null,
    ): array {
        $byId = self::buildHoursByEmployeeId($dateBounds, $employeeIds, $ignoreTrainingId);
        if ($byId === []) {
            return [];
        }

        $employees = Employee::query()
            ->whereIn('id', array_keys($byId))
            ->get(['id', 'first_name', 'last_name'])
            ->keyBy('id');

        // Never replace a warm algo employee cache with a training-only subset.
        $used = [];

        foreach ($byId as $employeeId => $byDate) {
            $employee = $employees->get((int) $employeeId);
            if (! $employee) {
                continue;
            }

            $displayName = EmployeeNames::displayName($employee);
            $employeeName = EmployeeNames::canonicalize($displayName) ?? $displayName;
            if ($employeeName === '') {
                continue;
            }

            if (! isset($used[$employeeName])) {
                $used[$employeeName] = [];
            }
            foreach ($byDate as $ymd => $hours) {
                $used[$employeeName][$ymd] = round(
                    ($used[$employeeName][$ymd] ?? 0.0) + (float) $hours,
                    4,
                );
            }
        }

        return $used;
    }

    /**
     * Merge training hours into an existing availability-used map.
     *
     * @param  HoursByEmployeeDate  $availabilityUsed
     * @param  array{0?: string, 1?: string}|null  $dateBounds
     */
    public static function mergeIntoAvailabilityUsed(
        array &$availabilityUsed,
        ?array $dateBounds = null,
        ?array $employeeIds = null,
        ?int $ignoreTrainingId = null,
    ): void {
        $trainingUsed = self::buildAvailabilityUsedMap($dateBounds, $employeeIds, $ignoreTrainingId);
        foreach ($trainingUsed as $employeeName => $byDate) {
            if (! isset($availabilityUsed[$employeeName])) {
                $availabilityUsed[$employeeName] = [];
            }
            foreach ($byDate as $ymd => $hours) {
                $availabilityUsed[$employeeName][$ymd] = round(
                    ($availabilityUsed[$employeeName][$ymd] ?? 0.0) + (float) $hours,
                    4,
                );
            }
        }
    }

    /**
     * Flat map of hours for one employee (Y-m-d => hours), for occupancy checkers.
     *
     * @return array<string, float>
     */
    public static function hoursByDayForEmployee(
        int $employeeId,
        string $startDate,
        string $endDate,
        ?int $ignoreTrainingId = null,
    ): array {
        $start = self::normalizeDate($startDate);
        $end = self::normalizeDate($endDate);
        if (! $start || ! $end || $employeeId <= 0) {
            return [];
        }

        $map = self::buildHoursByEmployeeId([$start, $end], [$employeeId], $ignoreTrainingId);

        return is_array($map[$employeeId] ?? null) ? $map[$employeeId] : [];
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
