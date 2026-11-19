<?php

namespace App\Support;

use App\Models\ProjectTask;
use Carbon\Carbon;
use Illuminate\Support\Collection;

/**
 * Builds histogram bars and daily hours from algorithm assignmentDetails
 * (same per-day assignment model produced by AlgoController::assignTaskHours).
 */
class HistogramFromAssignments
{
    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  Collection<int, ProjectTask>  $tasksById
     * @param  Collection<int, Nrm>  $nrms
     * @return array{bars: array<int, array<string, mixed>>, daily_hours: array<string, array<string, float>>}
     */
    public static function build(array $assignmentDetails, Collection $tasksById, mixed $nrms): array
    {
        $nrms = $nrms instanceof Collection ? $nrms : collect($nrms);
        $bars = [];
        $dailyHours = [];

        foreach ($assignmentDetails as $taskDetail) {
            $taskId = (int) ($taskDetail['task_id'] ?? 0);
            if ($taskId <= 0) {
                continue;
            }

            /** @var ProjectTask|null $task */
            $task = $tasksById->get($taskId);
            if (! $task) {
                continue;
            }

            $project = $task->part?->project;
            if (! $project) {
                continue;
            }

            $assignments = $taskDetail['assignments'] ?? [];
            $assignments = ReleaseAssignmentsAfterDone::clipTaskAssignments($task, is_array($assignments) ? $assignments : []);
            if ($assignments === []) {
                continue;
            }

            $byEmployee = [];
            foreach ($assignments as $assignment) {
                $employee = EmployeeNames::canonicalize((string) ($assignment['employee'] ?? ''))
                    ?? trim((string) ($assignment['employee'] ?? ''));
                $date = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;

                if ($employee === '' || $date === null || $hours <= 0) {
                    continue;
                }

                $byEmployee[$employee][] = [
                    'date' => $date,
                    'hours' => $hours,
                ];

                if (! isset($dailyHours[$employee])) {
                    $dailyHours[$employee] = [];
                }
                $dailyHours[$employee][$date] = round(
                    ($dailyHours[$employee][$date] ?? 0) + $hours,
                    4,
                );
            }

            foreach ($byEmployee as $employee => $employeeAssignments) {
                usort(
                    $employeeAssignments,
                    fn (array $a, array $b) => strcmp($a['date'], $b['date']),
                );

                $groups = self::groupConsecutiveDates($employeeAssignments);

                foreach ($groups as $groupIndex => $group) {
                    $hoursByDay = [];
                    foreach ($group as $entry) {
                        $hoursByDay[$entry['date']] = round(
                            ($hoursByDay[$entry['date']] ?? 0) + $entry['hours'],
                            4,
                        );
                    }

                    $dates = array_keys($hoursByDay);
                    sort($dates);
                    $start = $dates[0];
                    $end = $dates[count($dates) - 1];
                    $totalHours = array_sum($hoursByDay);
                    $taskDocSupply = self::formatTaskDate($task->doc_supply) ?? $start;
                    $taskCompletion = self::formatTaskDate($task->completion) ?? $end;

                    $bars[] = [
                        'id' => "task-{$taskId}-{$employee}-{$groupIndex}",
                        'task_id' => $taskId,
                        'task_name' => $task->task_name ?: 'Untitled task',
                        'nrm_number' => self::resolveNrmNumber($task->task_name, $nrms),
                        'employee' => $employee,
                        'project_id' => $project->id,
                        'project_name' => $project->name,
                        'project_status' => $project->status,
                        'part_id' => $task->part_id,
                        'part_name' => $task->part?->name,
                        'start' => $start,
                        'end' => $end,
                        'doc_supply' => $taskDocSupply,
                        'completion' => $taskCompletion,
                        'hours' => round($totalHours, 4),
                        'hours_by_day' => $hoursByDay,
                        'est' => $task->est,
                        'plan' => $task->plan,
                        'color' => $project->color ?: '#3B82F6',
                        'progress' => min(100, max(0, (float) ($task->progress_per ?: 0))),
                        'progress_per' => $task->progress_per,
                        'act' => $task->act,
                        'duration_left' => $task->duration_left,
                        'done' => (bool) $task->done,
                        'con' => $task->con,
                        'ats' => $task->ats,
                        'sp' => (bool) $task->sp,
                        'pp' => is_numeric($task->pp) ? (float) $task->pp : null,
                        'pri' => is_numeric($task->pri) ? (float) $task->pri : null,
                        'algorithm_1' => $task->algorithm_1,
                        'algorithm_2' => $task->algorithm_2,
                        'algorithm_3' => $task->algorithm_3,
                        'override_1' => $task->override_1,
                        'override_2' => $task->override_2,
                        'override_3' => $task->override_3,
                    ];
                }
            }
        }

        return [
            'bars' => $bars,
            'daily_hours' => $dailyHours,
        ];
    }

    /**
     * @param  array<int, array{date: string, hours: float}>  $assignments
     * @return array<int, array<int, array{date: string, hours: float}>>
     */
    private static function groupConsecutiveDates(array $assignments): array
    {
        $groups = [];
        $currentGroup = [];

        foreach ($assignments as $assignment) {
            $previous = $currentGroup !== [] ? $currentGroup[count($currentGroup) - 1] : null;

            if (
                $previous !== null
                && ! self::isNextWorkdayOrSame($previous['date'], $assignment['date'])
            ) {
                $groups[] = $currentGroup;
                $currentGroup = [];
            }

            $currentGroup[] = $assignment;
        }

        if ($currentGroup !== []) {
            $groups[] = $currentGroup;
        }

        return $groups;
    }

    private static function isNextWorkdayOrSame(string $previousDate, string $nextDate): bool
    {
        $previous = Carbon::parse($previousDate)->startOfDay();
        $next = Carbon::parse($nextDate)->startOfDay();

        if ($next->lte($previous)) {
            return true;
        }

        $cursor = $previous->copy();
        while ($cursor->lt($next)) {
            $cursor->addDay();
            if ($cursor->isWeekend()) {
                continue;
            }

            if ($cursor->equalTo($next)) {
                return true;
            }

            return false;
        }

        return true;
    }

    private static function normalizeDate(string $value): ?string
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }

        if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $value, $matches)) {
            return $matches[1];
        }

        try {
            return Carbon::parse($value)->toDateString();
        } catch (\Throwable) {
            return null;
        }
    }

    private static function formatTaskDate(?string $value): ?string
    {
        $date = self::normalizeDate((string) $value);

        return $date;
    }

    /**
     * @param  Collection<int, mixed>  $nrms
     */
    private static function resolveNrmNumber(?string $taskName, Collection $nrms): ?string
    {
        $taskName = NrmCatalog::normalizeTaskNamePrefix(trim((string) $taskName));
        if ($taskName === '') {
            return null;
        }

        $taskLower = strtolower($taskName);
        $withoutPrefix = strtolower(trim((string) preg_replace('/^\d+(?:\.\d+)?\s*[-–—]\s*/u', '', $taskName)));

        foreach ($nrms as $nrm) {
            $name = strtolower(trim((string) data_get($nrm, 'name', '')));
            $scName = strtolower(trim((string) data_get($nrm, 'sc_name', '')));
            $number = data_get($nrm, 'number');

            if ($name !== '' && (str_contains($taskLower, $name) || ($withoutPrefix !== '' && str_contains($withoutPrefix, $name)))) {
                return $number;
            }

            if ($scName !== '' && (str_contains($taskLower, $scName) || ($withoutPrefix !== '' && str_contains($withoutPrefix, $scName)))) {
                return $number;
            }
        }

        if (preg_match('/^(\d+\.\d+)(.*)$/u', $taskName, $matches)) {
            return NrmCatalog::canonicalNumber($matches[1]);
        }

        return null;
    }
}
