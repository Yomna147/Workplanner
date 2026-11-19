<?php

namespace App\Support;

use App\Models\Employee;
use App\Models\EmployeeAvailability;
use App\Models\EmployeeTraining;
use App\Models\Nrm;
use App\Models\ProjectTask;
use Carbon\Carbon;
use Carbon\CarbonPeriod;

class TrainingOccupiedSlotChecker
{
    private const FULL_DAY_HOURS = 8.0;

    /**
     * Days in the range that are holidays / zero-AVA (cannot host training).
     *
     * @return list<string> Y-m-d
     */
    public static function holidayDaysFor(int $employeeId, string $startDate, string $endDate): array
    {
        $employee = Employee::query()->find($employeeId);
        if (! $employee) {
            return [];
        }

        $start = Carbon::parse($startDate)->toDateString();
        $end = Carbon::parse($endDate)->toDateString();
        $availability = self::availabilityByDay($employeeId, $start, $end);
        $days = [];

        foreach (CarbonPeriod::create($start, $end) as $day) {
            if ($day->isWeekend()) {
                continue;
            }
            $ymd = $day->toDateString();
            if (self::isHolidayDay($availability, $ymd)) {
                $days[] = $ymd;
            }
        }

        return $days;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public static function conflictsFor(
        int $employeeId,
        string $startDate,
        string $endDate,
        float $hoursPerDay,
        ?int $ignoreTrainingId = null,
        ?int $daySegment = 0,
    ): array {
        $employee = Employee::query()->find($employeeId);
        if (! $employee) {
            return [];
        }

        EmployeeNames::warmEmployeeCache();
        try {
            $displayName = EmployeeNames::displayName($employee);
            $employeeName = EmployeeNames::canonicalize($displayName) ?? $displayName;
            if ($employeeName === '') {
                return [];
            }

            $start = Carbon::parse($startDate)->toDateString();
            $end = Carbon::parse($endDate)->toDateString();
            $proposedSegment = max(0, min(3, (int) ($daySegment ?? 0)));

            $availability = self::availabilityByDay($employeeId, $start, $end);
            $histogram = self::buildHistogramForEmployee($employeeName);
            $projectBookedByDay = is_array($histogram['daily_hours'] ?? null)
                ? $histogram['daily_hours']
                : [];
            $trainingBookedByDay = [];
            self::addTrainingHours(
                $trainingBookedByDay,
                $employeeId,
                $start,
                $end,
                $ignoreTrainingId,
                $availability,
            );

            $bookedByDay = $projectBookedByDay;
            foreach ($trainingBookedByDay as $ymd => $hours) {
                $bookedByDay[$ymd] = (float) ($bookedByDay[$ymd] ?? 0) + (float) $hours;
            }

            $projectTasksByDay = [];
            $trainingSlotsByDay = [];
            self::collectOverlapLabels(
                $employeeName,
                $employeeId,
                $start,
                $end,
                $ignoreTrainingId,
                $availability,
                $histogram,
                $projectTasksByDay,
                $trainingSlotsByDay,
            );

            $conflictDays = [];
            $hardTrainingDays = [];
            $segmentConflictDays = [];
            $segmentConflictTitles = [];

            foreach (CarbonPeriod::create($start, $end) as $day) {
                if ($day->isWeekend()) {
                    continue;
                }

                $ymd = $day->toDateString();
                if (self::isHolidayDay($availability, $ymd)) {
                    continue;
                }

                $ava = $availability[$ymd] ?? self::FULL_DAY_HOURS;
                $proposedSpan = self::segmentSpan($proposedSegment, $hoursPerDay, $ava);
                $slotOverlaps = [];
                foreach ($trainingSlotsByDay[$ymd] ?? [] as $slot) {
                    $existingSpan = self::segmentSpan(
                        (int) ($slot['day_segment'] ?? 0),
                        (float) ($slot['hours_per_day'] ?? 2),
                        $ava,
                    );
                    if (self::segmentsOverlap($proposedSpan, $existingSpan)) {
                        $slotOverlaps[] = (string) ($slot['title'] ?? 'Training');
                    }
                }

                if ($slotOverlaps !== []) {
                    $conflictDays[] = $ymd;
                    $hardTrainingDays[$ymd] = true;
                    $segmentConflictDays[$ymd] = true;
                    foreach ($slotOverlaps as $title) {
                        $segmentConflictTitles[$title] = $title;
                    }
                    continue;
                }

                $booked = (float) ($bookedByDay[$ymd] ?? 0);
                if ($booked <= 0.05) {
                    continue;
                }

                $gap = max(0, $ava - $booked);
                if ($gap >= $hoursPerDay - 0.05) {
                    continue;
                }

                $conflictDays[] = $ymd;

                $trainingOnly = (float) ($trainingBookedByDay[$ymd] ?? 0);
                $gapAfterProjectOverride = max(0, $ava - $trainingOnly);
                $hasTraining = ($trainingSlotsByDay[$ymd] ?? []) !== [];
                if ($hasTraining && $gapAfterProjectOverride < $hoursPerDay - 0.05) {
                    $hardTrainingDays[$ymd] = true;
                }
            }

            if ($conflictDays === []) {
                return [];
            }

            $tasks = [];
            $seenTaskKeys = [];
            foreach ($conflictDays as $ymd) {
                foreach ($projectTasksByDay[$ymd] ?? [] as $task) {
                    $taskId = isset($task['task_id']) ? (int) $task['task_id'] : 0;
                    $project = trim((string) ($task['project_name'] ?? ''));
                    $name = trim((string) ($task['task_name'] ?? ''));
                    $key = $taskId > 0
                        ? 'id:'.$taskId
                        : 'name:'.mb_strtolower($project.'|'.$name);
                    if (isset($seenTaskKeys[$key])) {
                        continue;
                    }
                    $seenTaskKeys[$key] = true;
                    $tasks[] = $task;
                }
            }

            // Only trainings that actually collide with the proposed day-section.
            $overlappingTrainingTitles = array_values($segmentConflictTitles);
            if ($overlappingTrainingTitles === []) {
                foreach ($conflictDays as $ymd) {
                    $ava = $availability[$ymd] ?? self::FULL_DAY_HOURS;
                    $proposedSpan = self::segmentSpan($proposedSegment, $hoursPerDay, $ava);
                    foreach ($trainingSlotsByDay[$ymd] ?? [] as $slot) {
                        $existingSpan = self::segmentSpan(
                            (int) ($slot['day_segment'] ?? 0),
                            (float) ($slot['hours_per_day'] ?? 2),
                            $ava,
                        );
                        if (! self::segmentsOverlap($proposedSpan, $existingSpan)) {
                            continue;
                        }
                        $title = trim((string) ($slot['title'] ?? 'Training'));
                        if ($title !== '') {
                            $overlappingTrainingTitles[$title] = $title;
                        }
                    }
                }
                $overlappingTrainingTitles = array_values($overlappingTrainingTitles);
            }

            $dayText = self::formatDayList($conflictDays);
            $taskLabels = array_map(
                function (array $task): string {
                    $name = (string) ($task['task_name'] ?? 'Untitled task');
                    $project = trim((string) ($task['project_name'] ?? ''));

                    return $project !== '' ? "{$project} — {$name}" : $name;
                },
                array_slice($tasks, 0, 3),
            );
            $trainingLabel = implode('; ', array_slice($overlappingTrainingTitles, 0, 3));

            $firstDayBooked = (float) ($bookedByDay[$conflictDays[0]] ?? 0);
            $firstAva = $availability[$conflictDays[0]] ?? self::FULL_DAY_HOURS;
            $firstGap = round(max(0, $firstAva - $firstDayBooked), 1);
            $trainingBlocks = $hardTrainingDays !== [];
            $sectionConflict = $segmentConflictDays !== [];
            $sectionLabel = 'Section '.($proposedSegment + 1);

            if ($sectionConflict) {
                return [[
                    'employee_id' => $employeeId,
                    'employee_name' => $employeeName,
                    'kind' => 'training',
                    'holiday' => false,
                    'segment_conflict' => true,
                    'days' => $conflictDays,
                    // Section clash: only the colliding courses (not project work).
                    'tasks' => [],
                    'trainings' => $overlappingTrainingTitles,
                    'message' => "{$employeeName} already has training in {$sectionLabel} on {$dayText} ("
                        .($trainingLabel !== '' ? $trainingLabel : 'existing course')
                        .'). Choose another day section.',
                ]];
            }

            if ($trainingBlocks) {
                $blockingTrainings = $overlappingTrainingTitles;
                if ($blockingTrainings === []) {
                    $blockingTrainings = [];
                    $seenTitles = [];
                    foreach ($conflictDays as $ymd) {
                        foreach ($trainingSlotsByDay[$ymd] ?? [] as $slot) {
                            $title = trim((string) ($slot['title'] ?? 'Training'));
                            if ($title === '' || isset($seenTitles[$title])) {
                                continue;
                            }
                            $seenTitles[$title] = true;
                            $blockingTrainings[] = $title;
                        }
                    }
                }

                return [[
                    'employee_id' => $employeeId,
                    'employee_name' => $employeeName,
                    'kind' => 'training',
                    'holiday' => false,
                    'days' => $conflictDays,
                    // Training alone blocks the day — list colliding courses only.
                    'tasks' => [],
                    'trainings' => $blockingTrainings,
                    'message' => "{$employeeName} has no free slot on {$dayText} — existing training ("
                        .(($trainingLabel !== '' ? $trainingLabel : implode('; ', array_slice($blockingTrainings, 0, 3))) ?: 'course')
                        .") leaves only {$firstGap}h free even if project hours are reduced.",
                ]];
            }

            // Project override: only the project work that will be reduced — not other trainings.
            $occupied = $taskLabels !== []
                ? implode('; ', $taskLabels).(count($tasks) > 3 ? '…' : '')
                : 'existing planned work';

            $message = "{$employeeName} already has {$occupied} on {$dayText} — only {$firstGap}h gap available. Confirm override to reduce project hours and free a slot.";

            return [[
                'employee_id' => $employeeId,
                'employee_name' => $employeeName,
                'kind' => 'project',
                'holiday' => false,
                'days' => $conflictDays,
                'tasks' => array_slice($tasks, 0, 3),
                'trainings' => [],
                'message' => $message,
            ]];
        } finally {
            EmployeeNames::clearEmployeeCache();
        }
    }

    /**
     * @return array{start:int,end:int}
     */
    private static function segmentSpan(int $daySegment, float $hoursPerDay, float $dayCapacity): array
    {
        $start = max(0, min(3, $daySegment));
        $capacity = $dayCapacity > 0 ? $dayCapacity : self::FULL_DAY_HOURS;
        if ($hoursPerDay >= $capacity - 0.05) {
            $num = 4;
        } else {
            $num = (int) max(1, min(4, (int) round(($hoursPerDay / $capacity) * 4) ?: 1));
        }
        $num = max(1, min($num, 4 - $start));

        return ['start' => $start, 'end' => $start + $num];
    }

    /**
     * @param  array{start:int,end:int}  $a
     * @param  array{start:int,end:int}  $b
     */
    private static function segmentsOverlap(array $a, array $b): bool
    {
        return $a['start'] < $b['end'] && $b['start'] < $a['end'];
    }

    /**
     * @return array<string, float>
     */
    private static function availabilityByDay(int $employeeId, string $start, string $end): array
    {
        $rows = EmployeeAvailability::query()
            ->where('employee_id', $employeeId)
            ->whereBetween('date', [$start, $end])
            ->get(['date', 'total', 'total_ava']);

        $map = [];
        foreach ($rows as $row) {
            $ymd = $row->date->toDateString();
            $map[$ymd] = self::parseTimeToHours($row->total_ava ?? $row->total ?? '00:00');
        }

        return $map;
    }

    /**
     * @param  array<string, float>  $availability
     */
    private static function isHolidayDay(array $availability, string $ymd): bool
    {
        if (! array_key_exists($ymd, $availability)) {
            return false;
        }

        return (float) $availability[$ymd] <= 0.05;
    }

    /**
     * @param  array<string, float>  $bookedByDay
     * @param  array<string, float>  $availability
     */
    private static function addTrainingHours(
        array &$bookedByDay,
        int $employeeId,
        string $start,
        string $end,
        ?int $ignoreTrainingId,
        array $availability = [],
    ): void {
        $trainingByDay = TrainingCapacityLocks::hoursByDayForEmployee(
            $employeeId,
            $start,
            $end,
            $ignoreTrainingId,
        );

        foreach ($trainingByDay as $ymd => $hours) {
            if (self::isHolidayDay($availability, $ymd)) {
                continue;
            }
            $bookedByDay[$ymd] = (float) ($bookedByDay[$ymd] ?? 0) + (float) $hours;
        }
    }

    /**
     * @param  array<string, list<array<string, mixed>>>  $projectTasksByDay
     * @param  array<string, list<array<string, mixed>>>  $trainingSlotsByDay
     * @param  array<string, float>  $availability
     * @param  array{daily_hours: array<string, float>, bars: array<int, array<string, mixed>>}  $histogram
     */
    private static function collectOverlapLabels(
        string $employeeName,
        int $employeeId,
        string $start,
        string $end,
        ?int $ignoreTrainingId,
        array $availability,
        array $histogram,
        array &$projectTasksByDay,
        array &$trainingSlotsByDay,
    ): void {
        $built = $histogram;
        $wanted = [];
        foreach (CarbonPeriod::create($start, $end) as $day) {
            if ($day->isWeekend()) {
                continue;
            }
            $ymd = $day->toDateString();
            if (self::isHolidayDay($availability, $ymd)) {
                continue;
            }
            $wanted[$ymd] = true;
        }

        foreach (self::conflictingTasks($built['bars'], $employeeName, array_keys($wanted)) as $task) {
            $ymd = (string) ($task['date'] ?? '');
            if ($ymd === '') {
                continue;
            }
            $projectTasksByDay[$ymd][] = $task;
        }

        $query = EmployeeTraining::query()
            ->where('employee_id', $employeeId)
            ->whereDate('start_date', '<=', $end)
            ->whereDate('end_date', '>=', $start);

        if ($ignoreTrainingId) {
            $query->where('id', '!=', $ignoreTrainingId);
        }

        foreach ($query->get(['title', 'start_date', 'end_date', 'day_segment', 'hours_per_day']) as $training) {
            $from = $training->start_date->toDateString();
            $to = $training->end_date->toDateString();
            $rangeStart = $from > $start ? $from : $start;
            $rangeEnd = $to < $end ? $to : $end;
            foreach (CarbonPeriod::create($rangeStart, $rangeEnd) as $day) {
                if ($day->isWeekend()) {
                    continue;
                }
                $ymd = $day->toDateString();
                if (self::isHolidayDay($availability, $ymd)) {
                    continue;
                }
                $trainingSlotsByDay[$ymd][] = [
                    'title' => (string) ($training->title ?: 'Training'),
                    'day_segment' => (int) ($training->day_segment ?? 0),
                    'hours_per_day' => (float) ($training->hours_per_day ?? 2),
                ];
            }
        }
    }

    /**
     * @param  list<string>  $days
     */
    private static function formatDayList(array $days): string
    {
        $labels = array_map(
            fn (string $ymd) => Carbon::parse($ymd)->format('D j M'),
            array_slice($days, 0, 3),
        );

        if (count($days) === 1) {
            return $labels[0];
        }
        if (count($days) === 2) {
            return $labels[0].' and '.$labels[1];
        }

        return implode(', ', $labels).(count($days) > 3 ? '…' : '');
    }

    private static function parseTimeToHours(?string $value): float
    {
        if ($value === null || trim($value) === '') {
            return 0.0;
        }

        $parts = explode(':', trim($value));
        $hours = (float) ($parts[0] ?? 0);
        $minutes = (float) ($parts[1] ?? 0);
        $seconds = (float) ($parts[2] ?? 0);

        return $hours + ($minutes / 60) + ($seconds / 3600);
    }

    /**
     * @return array{daily_hours: array<string, float>, bars: array<int, array<string, mixed>>}
     */
    private static function buildHistogramForEmployee(string $employeeName): array
    {
        $cached = AlgorithmCache::get();
        $assignmentDetails = is_array($cached['assignmentDetails'] ?? null)
            ? $cached['assignmentDetails']
            : [];

        if ($assignmentDetails === []) {
            return ['daily_hours' => [], 'bars' => []];
        }

        $taskIds = collect($assignmentDetails)
            ->pluck('task_id')
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($taskIds === []) {
            return ['daily_hours' => [], 'bars' => []];
        }

        $tasksById = ProjectTask::query()
            ->with(['part.project'])
            ->whereIn('id', $taskIds)
            ->whereHas('part.project')
            ->get()
            ->keyBy('id');

        $nrms = Nrm::query()->orderBy('id')->get();
        $built = HistogramFromAssignments::build($assignmentDetails, $tasksById, $nrms);
        $dailyHours = $built['daily_hours'][$employeeName] ?? [];

        return [
            'daily_hours' => is_array($dailyHours) ? $dailyHours : [],
            'bars' => is_array($built['bars'] ?? null) ? $built['bars'] : [],
        ];
    }

    /**
     * @param  array<int, array<string, mixed>>  $bars
     * @param  list<string>  $conflictDays
     * @return list<array{task_id:int|null,task_name:string,project_name:string,date:string}>
     */
    private static function conflictingTasks(array $bars, string $employeeName, array $conflictDays): array
    {
        $wantedDays = array_fill_keys($conflictDays, true);
        $seen = [];
        $tasks = [];

        foreach ($bars as $bar) {
            $barEmployee = EmployeeNames::canonicalize((string) ($bar['employee'] ?? ''))
                ?? trim((string) ($bar['employee'] ?? ''));
            if ($barEmployee !== $employeeName && trim((string) ($bar['employee'] ?? '')) !== $employeeName) {
                continue;
            }

            $hoursByDay = is_array($bar['hours_by_day'] ?? null) ? $bar['hours_by_day'] : [];
            foreach ($hoursByDay as $ymd => $hours) {
                if (! isset($wantedDays[$ymd]) || (float) $hours <= 0.05) {
                    continue;
                }

                $taskId = isset($bar['task_id']) ? (int) $bar['task_id'] : 0;
                $key = $taskId > 0 ? (string) $taskId : ((string) ($bar['task_name'] ?? '')).'|'.$ymd;
                if (isset($seen[$key])) {
                    continue;
                }
                $seen[$key] = true;
                $tasks[] = [
                    'task_id' => $taskId > 0 ? $taskId : null,
                    'task_name' => (string) ($bar['task_name'] ?? 'Untitled task'),
                    'project_name' => (string) ($bar['project_name'] ?? ''),
                    'date' => (string) $ymd,
                ];
            }
        }

        return $tasks;
    }
}
