<?php

namespace App\Support;

use Carbon\Carbon;

/**
 * Final algorithm pass: fold small detached pieces of a task (per employee) back
 * into that task's main block, so the histogram shows one bar instead of slivers.
 *
 * Works on each employee's calendar. A piece moves onto the main block's days (or
 * up to two workdays either side) using free capacity, or by nudging another
 * task's hours from that day into the other task's own block. A move is kept only
 * when the piece's task ends with fewer bars and no other task gains a bar, so
 * daily capacity (AVA minus training), saved histogram hours, sealed (done /
 * completed) rows and task start dates are all respected.
 */
class TaskFragmentCompactor
{
    private const MAX_EXTENSION_DAYS = 2;

    /** @var array<string, array<string, array<int, float>>> employee => day => taskId => hours */
    private array $calendar = [];

    /** @var array<int, true> */
    private array $sealedTasks = [];

    /** @var array<int, array<string, array<string, float>>> taskId => employee => day => hours */
    private array $pinned = [];

    /** @var array<int, string> */
    private array $taskStart = [];

    /** @var array<int, array<string, float>> */
    private array $capIndex = [];

    /** @var array<int, array<string, float>> employee id => day => training hours */
    private array $training = [];

    private float $maxFragmentHours = 8.0;

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  array<int, array<string, array<string, float>>>  $pinned  taskId => employee => day => hours
     * @param  array<int, string>  $taskStartById  task id => Y-m-d
     * @return array<int, array<string, mixed>>
     */
    public static function compact(
        array $assignmentDetails,
        array $pinned = [],
        array $taskStartById = [],
        float $maxFragmentHours = 8.0,
    ): array {
        $compactor = new self;
        $compactor->pinned = $compactor->canonicalPinned($pinned);
        $compactor->taskStart = $taskStartById;
        $compactor->maxFragmentHours = $maxFragmentHours;

        return $compactor->run($assignmentDetails);
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return array<int, array<string, mixed>>
     */
    private function run(array $assignmentDetails): array
    {
        $this->buildCalendar($assignmentDetails);
        if ($this->calendar === []) {
            return $assignmentDetails;
        }
        $this->indexCapacity($assignmentDetails);

        $changedEmployees = [];
        foreach (array_keys($this->calendar) as $employee) {
            // Each accepted merge removes at least one bar, so this terminates; the guard is a backstop.
            for ($guard = 0; $guard < 500 && $this->mergeOneFragment($employee); $guard++) {
                $changedEmployees[$employee] = true;
            }
        }

        if ($changedEmployees === []) {
            return $assignmentDetails;
        }

        foreach ($assignmentDetails as $index => $detail) {
            $taskId = (int) ($detail['task_id'] ?? 0);
            if ($taskId <= 0 || isset($this->sealedTasks[$taskId])) {
                continue;
            }

            $rows = [];
            $touched = false;
            foreach ($detail['assignments'] ?? [] as $row) {
                $employee = $this->canonical((string) ($row['employee'] ?? ''));
                if (isset($changedEmployees[$employee])) {
                    $touched = true;
                    continue;
                }
                $rows[] = $row;
            }
            if (! $touched) {
                continue;
            }

            foreach (array_keys($changedEmployees) as $employee) {
                foreach ($this->calendar[$employee] as $day => $tasks) {
                    if (($tasks[$taskId] ?? 0.0) > 0.001) {
                        $rows[] = ['employee' => $employee, 'date' => $day, 'hours' => round($tasks[$taskId], 4)];
                    }
                }
            }

            $assignmentDetails[$index]['assignments'] = $rows;
            $assignmentDetails[$index] = HistogramScheduleOverrides::refreshDetailAggregates($assignmentDetails[$index]);
        }

        return $assignmentDetails;
    }

    /**
     * Merge the smallest piece that can be merged on this employee's calendar.
     */
    private function mergeOneFragment(string $employee): bool
    {
        $calendar = $this->calendar[$employee];
        $barsBefore = $this->barCounts($calendar);

        $fragments = [];
        foreach (array_keys($barsBefore) as $taskId) {
            if ($barsBefore[$taskId] < 2 || isset($this->sealedTasks[$taskId])) {
                continue;
            }

            $groups = $this->groups($calendar, $taskId);
            $mainIndex = 0;
            foreach ($groups as $i => $group) {
                if (array_sum($group) > array_sum($groups[$mainIndex]) + 0.0001) {
                    $mainIndex = $i;
                }
            }

            $pinnedDays = $this->pinned[$taskId][$employee] ?? [];
            foreach ($groups as $i => $group) {
                $hours = array_sum($group);
                // Saved days stay put, so a piece holding one can never disappear.
                if ($i === $mainIndex || $hours > $this->maxFragmentHours + 0.0001 || array_intersect_key($pinnedDays, $group) !== []) {
                    continue;
                }

                $main = $groups[$mainIndex];
                $afterMain = array_key_first($group) > array_key_last($main);
                $fragments[] = [
                    'task' => $taskId,
                    'group' => $group,
                    'hours' => $hours,
                    'main' => $main,
                    'anchor' => $afterMain ? array_key_last($main) : array_key_first($main),
                ];
            }
        }
        usort($fragments, static fn ($a, $b) => $a['hours'] <=> $b['hours']);

        foreach ($fragments as $fragment) {
            $trial = $calendar;
            foreach (array_keys($fragment['group']) as $day) {
                unset($trial[$day][$fragment['task']]);
            }

            if (! $this->place($trial, $employee, $fragment['task'], $fragment['hours'], $fragment['main'], $fragment['anchor'], true)) {
                continue;
            }

            $barsAfter = $this->barCounts($trial);
            if (($barsAfter[$fragment['task']] ?? 0) >= $barsBefore[$fragment['task']]) {
                continue;
            }
            foreach ($barsAfter as $taskId => $count) {
                if ($count > ($barsBefore[$taskId] ?? 0)) {
                    continue 2;
                }
            }

            $this->calendar[$employee] = $trial;

            return true;
        }

        return false;
    }

    /**
     * Put $hours of a task on its block's days (nearest the anchor first), then extend
     * the block day by day on the anchor's side, then the other side.
     *
     * @param  array<string, array<int, float>>  $calendar
     * @param  array<string, float>  $block
     */
    private function place(
        array &$calendar,
        string $employee,
        int $taskId,
        float $hours,
        array $block,
        string $anchor,
        bool $canDisplace,
        ?string $avoidDay = null,
    ): bool {
        $left = $hours;
        $inside = array_keys($block);
        usort($inside, fn ($a, $b) => $this->workdayDistance($a, $anchor) <=> $this->workdayDistance($b, $anchor));

        foreach ($inside as $day) {
            if ($day === $avoidDay) {
                continue;
            }
            $left -= $this->fill($calendar, $employee, $taskId, $day, $left, $canDisplace);
            if ($left <= 0.001) {
                return true;
            }
        }

        $first = array_key_first($block);
        $last = array_key_last($block);
        $sides = $anchor === $first ? [[$first, -1], [$last, 1]] : [[$last, 1], [$first, -1]];

        foreach ($sides as [$edge, $direction]) {
            $day = $edge;
            for ($i = 0; $i < self::MAX_EXTENSION_DAYS; $i++) {
                $day = $this->shiftWorkday($day, $direction);
                $start = $this->taskStart[$taskId] ?? null;
                if ($day === $avoidDay || ($start !== null && $day < $start)) {
                    break;
                }

                // Extensions must stay contiguous with the block: stop at the first day with no room.
                $took = $this->fill($calendar, $employee, $taskId, $day, $left, $canDisplace);
                if ($took <= 0.001) {
                    break;
                }
                $left -= $took;
                if ($left <= 0.001) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Book up to $want hours of the task on $day; returns hours booked. With
     * $canDisplace, first nudge other tasks' movable hours off the day into their own block.
     *
     * @param  array<string, array<int, float>>  $calendar
     */
    private function fill(array &$calendar, string $employee, int $taskId, string $day, float $want, bool $canDisplace): float
    {
        $room = $this->spare($calendar, $employee, $day);

        if ($room + 0.001 < $want && $canDisplace && ! $this->hasSealedWork($calendar, $day)) {
            foreach ($calendar[$day] ?? [] as $otherTaskId => $otherHours) {
                if ($otherTaskId === $taskId || $room + 0.001 >= $want) {
                    continue;
                }

                $movable = $otherHours - (float) ($this->pinned[$otherTaskId][$employee][$day] ?? 0.0);
                $amount = min($want - $room, $movable);
                if ($amount <= 0.001) {
                    continue;
                }

                $block = $this->groupContaining($calendar, $otherTaskId, $day);
                $trial = $calendar;
                $trial[$day][$otherTaskId] = round($otherHours - $amount, 4);
                if ($trial[$day][$otherTaskId] <= 0.001) {
                    unset($trial[$day][$otherTaskId]);
                }

                if ($this->place($trial, $employee, $otherTaskId, $amount, $block, $day, false, $day)) {
                    $calendar = $trial;
                    $room += $amount;
                }
            }
        }

        $take = min($want, $room);
        if ($take <= 0.001) {
            return 0.0;
        }

        $calendar[$day][$taskId] = round(($calendar[$day][$taskId] ?? 0.0) + $take, 4);

        return $take;
    }

    /**
     * @param  array<string, array<int, float>>  $calendar
     */
    private function spare(array $calendar, string $employee, string $day): float
    {
        if ($this->hasSealedWork($calendar, $day)) {
            return 0.0;
        }

        $cap = EmployeeAvailabilityHours::resolveDailyCapForEmployee($this->capIndex, $employee, $day, true);
        if ($cap === null) {
            return 0.0;
        }

        $employeeId = (int) (EmployeeNames::findByAnyName($employee)?->id ?? 0);
        $training = (float) ($this->training[$employeeId][$day] ?? 0.0);

        return max(0.0, $cap - $training - array_sum($calendar[$day] ?? []));
    }

    /**
     * @param  array<string, array<int, float>>  $calendar
     */
    private function hasSealedWork(array $calendar, string $day): bool
    {
        foreach (array_keys($calendar[$day] ?? []) as $taskId) {
            if (isset($this->sealedTasks[$taskId])) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<string, array<int, float>>  $calendar
     * @return array<int, int> taskId => number of bars
     */
    private function barCounts(array $calendar): array
    {
        $counts = [];
        $taskIds = [];
        foreach ($calendar as $tasks) {
            foreach ($tasks as $taskId => $hours) {
                if ($hours > 0.001) {
                    $taskIds[$taskId] = true;
                }
            }
        }

        foreach (array_keys($taskIds) as $taskId) {
            $counts[$taskId] = count($this->groups($calendar, $taskId));
        }

        return $counts;
    }

    /**
     * Same grouping as the histogram bars (HistogramFromAssignments): weekends do not break a bar.
     *
     * @param  array<string, array<int, float>>  $calendar
     * @return list<array<string, float>>
     */
    private function groups(array $calendar, int $taskId): array
    {
        $days = [];
        foreach ($calendar as $day => $tasks) {
            if (($tasks[$taskId] ?? 0.0) > 0.001) {
                $days[$day] = $tasks[$taskId];
            }
        }
        ksort($days);

        $groups = [];
        $current = [];
        $previous = null;
        foreach ($days as $day => $hours) {
            if ($previous !== null && $this->shiftWorkday($previous, 1) !== $day) {
                $groups[] = $current;
                $current = [];
            }
            $current[$day] = $hours;
            $previous = $day;
        }
        if ($current !== []) {
            $groups[] = $current;
        }

        return $groups;
    }

    /**
     * @param  array<string, array<int, float>>  $calendar
     * @return array<string, float>
     */
    private function groupContaining(array $calendar, int $taskId, string $day): array
    {
        foreach ($this->groups($calendar, $taskId) as $group) {
            if (isset($group[$day])) {
                return $group;
            }
        }

        return [$day => 0.0];
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     */
    private function buildCalendar(array $assignmentDetails): void
    {
        foreach ($assignmentDetails as $detail) {
            $taskId = (int) ($detail['task_id'] ?? 0);
            if ($taskId <= 0) {
                continue;
            }
            if (! empty($detail['sealed'])) {
                $this->sealedTasks[$taskId] = true;
            }

            foreach ($detail['assignments'] ?? [] as $row) {
                $employee = $this->canonical((string) ($row['employee'] ?? ''));
                $day = $this->normalizeDate((string) ($row['date'] ?? ''));
                $hours = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
                if ($employee === '' || $day === null || $hours <= 0.001) {
                    continue;
                }

                $this->calendar[$employee][$day][$taskId] = round(
                    ($this->calendar[$employee][$day][$taskId] ?? 0.0) + $hours,
                    4,
                );
            }
        }

        foreach ($this->calendar as $employee => $days) {
            ksort($days);
            $this->calendar[$employee] = $days;
        }
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     */
    private function indexCapacity(array $assignmentDetails): void
    {
        $allDays = [];
        foreach ($this->calendar as $days) {
            $allDays[] = array_key_first($days);
            $allDays[] = array_key_last($days);
        }
        sort($allDays);

        // Pad the range so extension days just outside the scheduled window resolve too.
        $padStart = Carbon::parse($allDays[0])->subDays(7)->toDateString();
        $padEnd = Carbon::parse(end($allDays))->addDays(7)->toDateString();
        $this->capIndex = EmployeeAvailabilityHours::buildCapIndexForAssignments([
            ...$assignmentDetails,
            ['assignments' => [['employee' => '', 'date' => $padStart], ['employee' => '', 'date' => $padEnd]]],
        ]);
        $this->training = TrainingCapacityLocks::buildHoursByEmployeeId([$padStart, $padEnd]);
    }

    /**
     * @param  array<int, array<string, array<string, float>>>  $pinned
     * @return array<int, array<string, array<string, float>>>
     */
    private function canonicalPinned(array $pinned): array
    {
        $result = [];
        foreach ($pinned as $taskId => $byEmployee) {
            foreach ($byEmployee as $employee => $hoursByDay) {
                $result[(int) $taskId][$this->canonical((string) $employee)] = $hoursByDay;
            }
        }

        return $result;
    }

    private function workdayDistance(string $from, string $to): int
    {
        return abs(Carbon::parse($from)->diffInWeekdays(Carbon::parse($to), false));
    }

    private function shiftWorkday(string $day, int $direction): string
    {
        $cursor = Carbon::parse($day);
        do {
            $cursor->addDays($direction);
        } while ($cursor->isWeekend());

        return $cursor->toDateString();
    }

    private function canonical(string $name): string
    {
        $name = trim($name);

        return $name === '' ? '' : (EmployeeNames::canonicalize($name) ?? $name);
    }

    private function normalizeDate(string $value): ?string
    {
        if (preg_match('/^(\d{4}-\d{2}-\d{2})/', trim($value), $matches)) {
            return $matches[1];
        }

        try {
            return trim($value) === '' ? null : Carbon::parse($value)->toDateString();
        } catch (\Throwable) {
            return null;
        }
    }
}
