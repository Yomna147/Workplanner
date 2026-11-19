<?php

namespace App\Support;

use Carbon\Carbon;

/**
 * A progress percentage locks that share of plan hours on or before the day it
 * was saved. The algorithm schedules only the hours still left, after that day.
 */
class ProgressFixedHours
{
    /**
     * @param  array<string, mixed>  $task
     * @return array{
     *     percent: float,
     *     anchor: string,
     *     fixed_hours: float,
     *     remainder: float,
     *     full_plan: float
     * }|null
     */
    public static function targetForTask(array $task): ?array
    {
        $percent = self::percent($task);
        if ($percent === null || $percent <= 0.0001 || $percent >= 100.0) {
            return null;
        }

        $anchor = self::anchor($task);
        if ($anchor === null) {
            return null;
        }

        $plan = is_numeric($task['Plan'] ?? null) ? (float) $task['Plan'] : 0.0;
        if ($plan <= 0.0001) {
            return null;
        }

        $fixed = round(min($plan, $plan * ($percent / 100.0)), 4);
        if ($fixed <= 0.0001) {
            return null;
        }

        return [
            'percent' => $percent,
            'anchor' => $anchor,
            'fixed_hours' => $fixed,
            'remainder' => round($plan - $fixed, 4),
            'full_plan' => $plan,
        ];
    }

    /**
     * Keep existing hours that already sit on or before the update day, up to the
     * progress share. Prefer days closest to the anchor so the locked past sits
     * against the unlock day and the remainder can continue without a mid-bar gap.
     * Hours after the anchor are left for the algorithm to place again.
     *
     * @param  list<array<string, mixed>>  $tasks
     * @param  list<array<string, mixed>>  $priorDetails
     * @return array<int, array<string, mixed>>
     */
    public static function build(array $tasks, array $priorDetails): array
    {
        $assignmentsByTask = [];
        foreach ($priorDetails as $detail) {
            if (! is_array($detail)) {
                continue;
            }
            $taskId = (int) ($detail['task_id'] ?? 0);
            if ($taskId <= 0) {
                continue;
            }
            $assignmentsByTask[$taskId] = is_array($detail['assignments'] ?? null)
                ? $detail['assignments']
                : [];
        }

        $fixed = [];
        foreach ($tasks as $task) {
            if (! is_array($task)) {
                continue;
            }
            $taskId = (int) ($task['id'] ?? 0);
            $target = self::targetForTask($task);
            if ($taskId <= 0 || $target === null) {
                continue;
            }

            $prior = $assignmentsByTask[$taskId] ?? [];
            $kept = self::slice($prior, $target['anchor'], $target['fixed_hours']);

            // If the locked past ends well before the progress day, keeping it would
            // open a hole until remainder starts the next day. Drop it so shortfall
            // fill can rebuild those hours against the anchor.
            if ($kept !== [] && self::leavesGapBeforeAnchor($kept, $target['anchor'])) {
                $kept = [];
            }

            $fixed[$taskId] = [
                'assignments' => $kept,
                'hours' => self::sum($kept),
                'anchor' => $target['anchor'],
                'full_plan' => $target['full_plan'],
                'percent' => $target['percent'],
                'target_hours' => $target['fixed_hours'],
                'doc_supply' => self::date($task['Doc_Supply'] ?? null),
                'names' => self::employeeNames($task, $prior),
                'remainder' => [],
            ];
        }

        return $fixed;
    }

    /**
     * True when kept past hours stop before the last workday on/before the anchor.
     *
     * @param  list<array{employee: string, date: string, hours: float}>  $kept
     */
    public static function leavesGapBeforeAnchor(array $kept, string $anchor): bool
    {
        $latest = null;
        foreach ($kept as $row) {
            $date = $row['date'] ?? null;
            if (! is_string($date) || $date === '') {
                continue;
            }
            if ($latest === null || $date > $latest) {
                $latest = $date;
            }
        }

        if ($latest === null) {
            return false;
        }

        try {
            $anchorDay = Carbon::parse($anchor)->startOfDay();
        } catch (\Throwable) {
            return false;
        }

        // Walk back to the previous workday on/before the anchor.
        $probe = $anchorDay->copy();
        for ($i = 0; $i < 7; $i++) {
            if ($probe->isWeekday()) {
                break;
            }
            $probe->subDay();
        }

        return $latest < $probe->toDateString();
    }

    /**
     * @param  list<array<string, mixed>>  $assignments
     * @return list<array{employee: string, date: string, hours: float}>
     */
    public static function slice(array $assignments, string $anchor, float $fixedHours): array
    {
        $rows = [];
        foreach ($assignments as $row) {
            if (! is_array($row)) {
                continue;
            }
            $date = self::date($row['date'] ?? null);
            $employee = trim((string) ($row['employee'] ?? ''));
            $hours = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
            if ($date === null || $employee === '' || $hours <= 0.0001 || $date > $anchor) {
                continue;
            }
            $canonical = EmployeeNames::canonicalize($employee) ?? $employee;
            $rows[] = ['employee' => $canonical, 'date' => $date, 'hours' => $hours];
        }

        // Latest-first: pack the progress-locked hours against the anchor day so
        // remainder scheduling (day after anchor) continues the bar instead of
        // leaving a hole after early front-loaded past days.
        usort($rows, static function (array $left, array $right) {
            $dateCmp = strcmp($right['date'], $left['date']);

            return $dateCmp !== 0 ? $dateCmp : strcasecmp($left['employee'], $right['employee']);
        });

        $kept = [];
        $left = $fixedHours;
        foreach ($rows as $row) {
            if ($left <= 0.0001) {
                break;
            }
            $take = min($row['hours'], $left);
            if ($take <= 0.0001) {
                continue;
            }
            $kept[] = [
                'employee' => $row['employee'],
                'date' => $row['date'],
                'hours' => round($take, 4),
            ];
            $left -= $take;
        }

        usort($kept, static function (array $left, array $right) {
            $dateCmp = strcmp($left['date'], $right['date']);

            return $dateCmp !== 0 ? $dateCmp : strcasecmp($left['employee'], $right['employee']);
        });

        return $kept;
    }

    public static function scheduleAfter(string $anchor): string
    {
        return Carbon::parse($anchor)->addDay()->toDateString();
    }

    /**
     * @param  list<array{employee: string, date: string, hours: float}>  $rows
     */
    public static function sum(array $rows): float
    {
        $total = 0.0;
        foreach ($rows as $row) {
            $total += (float) ($row['hours'] ?? 0.0);
        }

        return round($total, 4);
    }

    /**
     * @param  array<string, mixed>  $task
     */
    private static function percent(array $task): ?float
    {
        $raw = $task['Progress_Per'] ?? $task['progress_per'] ?? null;
        if ($raw === null || trim((string) $raw) === '') {
            return null;
        }

        $normalized = str_replace('%', '', trim((string) $raw));
        if (! is_numeric($normalized)) {
            return null;
        }

        return min(100.0, max(0.0, (float) $normalized));
    }

    /**
     * @param  array<string, mixed>  $task
     */
    private static function anchor(array $task): ?string
    {
        $stored = self::date($task['Progress_Updated'] ?? $task['progress_updated'] ?? null);
        if ($stored !== null) {
            return $stored;
        }

        if (self::percent($task) === null) {
            return null;
        }

        return Carbon::today()->toDateString();
    }

    private static function date(mixed $value): ?string
    {
        if ($value === null || trim((string) $value) === '') {
            return null;
        }

        try {
            return Carbon::parse($value)->toDateString();
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * People already on the task, so a shortfall in the past stays with them.
     *
     * @param  array<string, mixed>  $task
     * @param  list<array<string, mixed>>  $priorRows
     * @return list<string>
     */
    private static function employeeNames(array $task, array $priorRows): array
    {
        $names = [];
        $seen = [];
        $push = static function (string $name) use (&$names, &$seen): void {
            $trimmed = trim($name);
            if ($trimmed === '') {
                return;
            }
            $canonical = EmployeeNames::canonicalize($trimmed) ?? $trimmed;
            $key = mb_strtolower($canonical);
            if (isset($seen[$key])) {
                return;
            }
            $seen[$key] = true;
            $names[] = $canonical;
        };

        foreach ($priorRows as $row) {
            if (is_array($row)) {
                $push((string) ($row['employee'] ?? ''));
            }
        }

        foreach (['Override_1', 'Override_2', 'Override_3', 'Algorithm_1', 'Algorithm_2', 'Algorithm_3'] as $key) {
            $push((string) ($task[$key] ?? ''));
        }

        return $names;
    }
}
