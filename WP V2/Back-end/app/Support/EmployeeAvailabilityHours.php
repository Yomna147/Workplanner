<?php

namespace App\Support;

use App\Models\EmployeeAvailability;
use Carbon\Carbon;

class EmployeeAvailabilityHours
{
    public const DEFAULT_WORKDAY_HOURS = 8.0;

    public static function parseTimeToHours(mixed $value): float
    {
        if ($value === null) {
            return 0.0;
        }

        if (is_numeric($value)) {
            return (float) $value;
        }

        $text = trim((string) $value);
        if ($text === '') {
            return 0.0;
        }

        if (str_contains($text, ':')) {
            $parts = explode(':', $text);
            $hours = (float) ($parts[0] ?? 0);
            $minutes = (float) ($parts[1] ?? 0);
            $seconds = (float) ($parts[2] ?? 0);

            return $hours + ($minutes / 60) + ($seconds / 3600);
        }

        return 0.0;
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return array<int, array<string, float>> employee_id => [Y-m-d => available hours]
     */
    public static function buildCapIndexForAssignments(array $assignmentDetails): array
    {
        $dates = [];
        $employeeNames = [];

        foreach ($assignmentDetails as $taskDetail) {
            foreach ($taskDetail['assignments'] ?? [] as $assignment) {
                $employee = trim((string) ($assignment['employee'] ?? ''));
                $date = self::normalizeDate((string) ($assignment['date'] ?? ''));

                if ($employee !== '') {
                    $employeeNames[$employee] = true;
                }

                if ($date !== null) {
                    $dates[] = $date;
                }
            }
        }

        if ($dates === []) {
            return [];
        }

        EmployeeNames::warmEmployeeCache();

        $employeeIds = [];
        foreach (array_keys($employeeNames) as $name) {
            $employee = EmployeeNames::findByAnyName($name);
            if ($employee) {
                $employeeIds[(int) $employee->id] = true;
            }
        }

        if ($employeeIds === []) {
            return [];
        }

        sort($dates);
        $start = $dates[0];
        $end = $dates[array_key_last($dates)];

        $rows = EmployeeAvailability::query()
            ->whereIn('employee_id', array_keys($employeeIds))
            ->whereBetween('date', [$start, $end])
            ->get(['employee_id', 'date', 'total', 'total_ava']);

        $index = [];
        foreach ($rows as $row) {
            $day = Carbon::parse($row->date)->toDateString();
            $hours = self::parseTimeToHours($row->total_ava ?? $row->total ?? '00:00');
            $index[(int) $row->employee_id][$day] = $hours;
        }

        return $index;
    }

    /**
     * @param  array<int, array<string, float>>  $capIndex
     */
    public static function resolveDailyCapForEmployee(
        array $capIndex,
        string $employeeName,
        string $date,
        bool $missingDayMeansZero = true,
    ): ?float {
        $employee = EmployeeNames::findByAnyName($employeeName);
        if (! $employee) {
            return null;
        }

        $day = self::normalizeDate($date);
        if ($day === null) {
            return null;
        }

        if (! array_key_exists((int) $employee->id, $capIndex)) {
            return null;
        }

        if (! array_key_exists($day, $capIndex[(int) $employee->id])) {
            // Algo: missing AVA row = 0 so we never invent capacity.
            // Histogram edits: missing row = default workday so stretching
            // into empty calendar days matches the chart's 8h fallback.
            return $missingDayMeansZero ? 0.0 : self::DEFAULT_WORKDAY_HOURS;
        }

        return $capIndex[(int) $employee->id][$day];
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
}
