<?php

namespace App\Support;

use Carbon\Carbon;

class HistogramActivityLog
{
    /**
     * @param  array<int, array<string, mixed>>  $edits
     * @return array{summary: string, changes: array{edits: list<array<string, mixed>>}}
     */
    public static function buildSavePayload(array $edits): array
    {
        $loggedEdits = array_map(
            static fn (array $edit) => self::summarizeEdit($edit),
            $edits,
        );

        $reversibleEdits = array_map(
            static fn (array $edit) => self::reversibleEdit($edit),
            $edits,
        );

        $count = count($loggedEdits);
        if ($count === 1) {
            $summary = $loggedEdits[0]['summary'];
        } else {
            $taskNames = array_values(array_filter(array_map(
                static fn (array $edit) => trim((string) ($edit['task_name'] ?? '')),
                $loggedEdits,
            )));
            $preview = implode(', ', array_slice($taskNames, 0, 3));
            if (count($taskNames) > 3) {
                $preview .= ', …';
            }
            $summary = sprintf(
                'Saved %d histogram bar edits%s',
                $count,
                $preview !== '' ? ": {$preview}" : '',
            );
        }

        return [
            'summary' => $summary,
            'changes' => [
                'edits' => $loggedEdits,
                'reversible_edits' => $reversibleEdits,
            ],
        ];
    }

    /**
     * Build the edit payload that restores the prior schedule.
     *
     * @param  array<string, mixed>  $edit
     * @return array<string, mixed>
     */
    public static function buildRevertEdit(array $edit): array
    {
        $employee = trim((string) ($edit['employee'] ?? ''));
        $previousEmployee = trim((string) ($edit['previous_employee'] ?? ''));
        $nextHours = is_array($edit['hours_by_day'] ?? null) ? $edit['hours_by_day'] : [];
        $previousHours = is_array($edit['previous_hours_by_day'] ?? null)
            ? $edit['previous_hours_by_day']
            : [];

        $restoreEmployee = $previousEmployee !== '' ? $previousEmployee : $employee;
        $clearEmployee = $employee;

        $payload = [
            'bar_id' => (string) ($edit['bar_id'] ?? ''),
            'task_id' => (int) ($edit['task_id'] ?? 0),
            'task_name' => trim((string) ($edit['task_name'] ?? '')),
            'project_name' => trim((string) ($edit['project_name'] ?? '')),
            'employee' => $restoreEmployee,
            'previous_hours_by_day' => $nextHours,
            'hours_by_day' => $previousHours,
        ];

        if (
            $previousEmployee !== ''
            && $clearEmployee !== ''
            && strcasecmp($previousEmployee, $clearEmployee) !== 0
        ) {
            $payload['previous_employee'] = $clearEmployee;
        }

        return $payload;
    }

    /**
     * @param  array<string, mixed>  $edit
     * @return array<string, mixed>
     */
    private static function reversibleEdit(array $edit): array
    {
        return [
            'bar_id' => (string) ($edit['bar_id'] ?? ''),
            'task_id' => (int) ($edit['task_id'] ?? 0),
            'task_name' => trim((string) ($edit['task_name'] ?? '')),
            'project_name' => trim((string) ($edit['project_name'] ?? '')),
            'employee' => trim((string) ($edit['employee'] ?? '')),
            'previous_employee' => trim((string) ($edit['previous_employee'] ?? '')) ?: null,
            'previous_hours_by_day' => is_array($edit['previous_hours_by_day'] ?? null)
                ? $edit['previous_hours_by_day']
                : [],
            'hours_by_day' => is_array($edit['hours_by_day'] ?? null)
                ? $edit['hours_by_day']
                : [],
        ];
    }

    /**
     * @param  array<string, mixed>  $edit
     * @return array<string, mixed>
     */
    private static function summarizeEdit(array $edit): array
    {
        $taskId = (int) ($edit['task_id'] ?? 0);
        $taskName = trim((string) ($edit['task_name'] ?? ''));
        if ($taskName === '') {
            $taskName = $taskId > 0 ? "Task #{$taskId}" : 'Task';
        }

        $employee = trim((string) ($edit['employee'] ?? ''));
        $previousDays = self::activeDays($edit['previous_hours_by_day'] ?? []);
        $nextDays = self::activeDays($edit['hours_by_day'] ?? []);
        $fromRange = self::rangeLabel($previousDays);
        $toRange = self::rangeLabel($nextDays);

        return [
            'bar_id' => (string) ($edit['bar_id'] ?? ''),
            'task_id' => $taskId > 0 ? $taskId : null,
            'task_name' => $taskName,
            'employee' => $employee,
            'project_name' => trim((string) ($edit['project_name'] ?? '')) ?: null,
            'from' => $fromRange,
            'to' => $toRange,
            'summary' => self::describeScheduleChange($taskName, $employee, $previousDays, $nextDays),
        ];
    }

    /**
     * @param  array<string|int, mixed>  $hoursByDay
     * @return list<string>
     */
    private static function activeDays(array $hoursByDay): array
    {
        $days = [];

        foreach ($hoursByDay as $day => $hours) {
            $ymd = self::normalizeDate(is_string($day) ? $day : (string) $day);
            if ($ymd === null) {
                continue;
            }

            $value = is_numeric($hours) ? (float) $hours : 0.0;
            if ($value <= 0.001) {
                continue;
            }

            $days[] = $ymd;
        }

        sort($days);

        return $days;
    }

    /**
     * @param  list<string>  $days
     */
    private static function rangeLabel(array $days): ?string
    {
        if ($days === []) {
            return null;
        }

        $start = self::dayLabel($days[0]);
        $end = self::dayLabel($days[array_key_last($days)]);

        return $start === $end ? $start : "{$start} – {$end}";
    }

    /**
     * @param  list<string>  $previousDays
     * @param  list<string>  $nextDays
     */
    private static function describeScheduleChange(
        string $taskName,
        string $employee,
        array $previousDays,
        array $nextDays,
    ): string {
        $employeeLabel = $employee !== '' ? " · {$employee}" : '';

        if ($previousDays === [] || $nextDays === []) {
            return "{$taskName}{$employeeLabel}: schedule updated";
        }

        $prevStart = $previousDays[0];
        $prevEnd = $previousDays[array_key_last($previousDays)];
        $nextStart = $nextDays[0];
        $nextEnd = $nextDays[array_key_last($nextDays)];

        if ($prevStart === $nextStart && $prevEnd !== $nextEnd) {
            return sprintf(
                '%s%s: end %s → %s',
                $taskName,
                $employeeLabel,
                self::dayLabel($prevEnd),
                self::dayLabel($nextEnd),
            );
        }

        if ($prevEnd === $nextEnd && $prevStart !== $nextStart) {
            return sprintf(
                '%s%s: start %s → %s',
                $taskName,
                $employeeLabel,
                self::dayLabel($prevStart),
                self::dayLabel($nextStart),
            );
        }

        return sprintf(
            '%s%s: %s–%s → %s–%s',
            $taskName,
            $employeeLabel,
            self::dayLabel($prevStart),
            self::dayLabel($prevEnd),
            self::dayLabel($nextStart),
            self::dayLabel($nextEnd),
        );
    }

    private static function dayLabel(string $ymd): string
    {
        try {
            return Carbon::parse($ymd)->format('j M Y');
        } catch (\Throwable) {
            return $ymd;
        }
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
