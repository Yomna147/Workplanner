<?php

namespace App\Support;

use App\Models\Employee;
use App\Models\EmployeeAvailability;
use App\Models\Nrm;
use App\Models\ProjectTask;
use Carbon\Carbon;
use Illuminate\Support\Collection;

class TrainingSampleGapPlanner
{
    private const DEFAULT_WORK_DAY_HOURS = 8.0;

    private const GAP_EPSILON = 0.05;

    /** @var array<string, mixed> */
    private array $context = [];

    /**
     * @param  list<string>  $employeeNames
     * @return array{start_date: string, end_date: string}|null
     */
    public function findSharedGapWindow(
        array $employeeNames,
        int $weekdaySpan,
        Carbon $searchStart,
        Carbon $searchEnd,
        bool $searchBackward = false,
        ?string $mustIncludeDay = null,
    ): ?array {
        $weekdaySpan = max(1, $weekdaySpan);
        $names = array_values(array_filter(array_map('strval', $employeeNames)));
        if ($names === []) {
            return null;
        }

        $weekdays = $this->collectWeekdays($searchStart, $searchEnd);
        if ($searchBackward) {
            $weekdays = array_reverse($weekdays);
        }

        for ($index = 0; $index <= count($weekdays) - $weekdaySpan; $index += 1) {
            $window = array_slice($weekdays, $index, $weekdaySpan);
            if ($mustIncludeDay !== null && ! in_array($mustIncludeDay, $window, true)) {
                continue;
            }

            $matches = true;

            foreach ($window as $day) {
                foreach ($names as $name) {
                    if ($this->gapHoursForEmployee($name, $day) <= self::GAP_EPSILON) {
                        $matches = false;
                        break 2;
                    }
                }
            }

            if ($matches) {
                return [
                    'start_date' => $window[0],
                    'end_date' => $window[count($window) - 1],
                ];
            }
        }

        if ($mustIncludeDay !== null) {
            return $this->findLooseSharedGapDay($names, [$mustIncludeDay]);
        }

        return $this->findLooseSharedGapDay($names, $weekdays);
    }

    /**
     * @param  list<string>  $employeeNames
     * @return array{start_date: string, end_date: string}|null
     */
    public function findNearestSharedGapWindow(
        array $employeeNames,
        int $weekdaySpan,
        Carbon $searchStart,
        Carbon $searchEnd,
        Carbon $anchorDay,
    ): ?array {
        $weekdaySpan = max(1, $weekdaySpan);
        $names = array_values(array_filter(array_map('strval', $employeeNames)));
        if ($names === []) {
            return null;
        }

        $weekdays = $this->collectWeekdays($searchStart, $searchEnd);
        $best = null;
        $bestDistance = PHP_INT_MAX;

        for ($index = 0; $index <= count($weekdays) - $weekdaySpan; $index += 1) {
            $window = array_slice($weekdays, $index, $weekdaySpan);
            $matches = true;

            foreach ($window as $day) {
                foreach ($names as $name) {
                    if ($this->gapHoursForEmployee($name, $day) <= self::GAP_EPSILON) {
                        $matches = false;
                        break 2;
                    }
                }
            }

            if (! $matches) {
                continue;
            }

            $windowStart = Carbon::parse($window[0]);
            $windowEnd = Carbon::parse($window[count($window) - 1]);
            $distance = 0;
            if ($anchorDay->lt($windowStart)) {
                $distance = $windowStart->diffInDays($anchorDay);
            } elseif ($anchorDay->gt($windowEnd)) {
                $distance = $anchorDay->diffInDays($windowEnd);
            }

            if ($distance < $bestDistance) {
                $bestDistance = $distance;
                $best = [
                    'start_date' => $window[0],
                    'end_date' => $window[count($window) - 1],
                ];
            }
        }

        return $best ?? $this->findLooseSharedGapDay($names, $weekdays);
    }

    /**
     * @param  list<string>  $employeeNames
     * @return array{start_date: string, end_date: string}|null
     */
    private function findLooseSharedGapDay(array $employeeNames, array $weekdays): ?array
    {
        foreach ($weekdays as $day) {
            $matches = true;
            foreach ($employeeNames as $name) {
                if ($this->gapHoursForEmployee($name, $day) <= self::GAP_EPSILON) {
                    $matches = false;
                    break;
                }
            }

            if ($matches) {
                return [
                    'start_date' => $day,
                    'end_date' => $day,
                ];
            }
        }

        return null;
    }

    public function gapHoursForEmployee(string $employeeName, string $dayYmd): float
    {
        $day = Carbon::parse($dayYmd)->startOfDay();
        if ($day->isWeekend()) {
            return 0.0;
        }

        if ($this->isEmployeeHoliday($employeeName, $dayYmd)) {
            return 0.0;
        }

        $booked = $this->context['daily_hours'][$employeeName][$dayYmd] ?? 0.0;
        $capacity = $this->dayCapacity($employeeName, $dayYmd);
        if ($capacity === null) {
            return 0.0;
        }

        return max(0.0, $capacity - $booked);
    }

    public function warm(Carbon $rangeStart, Carbon $rangeEnd): void
    {
        EmployeeNames::warmEmployeeCache();

        $employees = Employee::query()
            ->orderBy('id')
            ->get(['id', 'first_name', 'last_name', 'team_id']);

        $dailyHours = $this->loadDailyHours($employees);
        [$availabilityHours, $employeeHolidays] = $this->loadAvailabilityData($rangeStart, $rangeEnd, $employees);

        $this->context = [
            'employees' => $employees,
            'daily_hours' => $dailyHours,
            'availability_hours' => $availabilityHours,
            'employee_holidays' => $employeeHolidays,
        ];
    }

    /**
     * @return array<string, array<string, float>>
     */
    private function loadDailyHours(Collection $employees): array
    {
        $assignmentDetails = $this->loadAssignmentDetails();
        if ($assignmentDetails === []) {
            return [];
        }

        $taskIds = collect($assignmentDetails)
            ->pluck('task_id')
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($taskIds === []) {
            return [];
        }

        $tasksById = ProjectTask::query()
            ->select(['id', 'part_id', 'task_name'])
            ->with(['part:id,project_id,name', 'part.project:id,name'])
            ->whereIn('id', $taskIds)
            ->whereHas('part')
            ->get()
            ->keyBy('id');

        $nrms = Nrm::query()->orderBy('number')->get(['id', 'number', 'name', 'sc_name']);

        try {
            $built = HistogramFromAssignments::build($assignmentDetails, $tasksById, $nrms);

            return $built['daily_hours'];
        } catch (\Throwable $e) {
            report($e);

            return [];
        }
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function loadAssignmentDetails(): array
    {
        $cached = AlgorithmCache::get();
        $details = is_array($cached['assignmentDetails'] ?? null)
            ? $cached['assignmentDetails']
            : [];

        return $details !== [] ? $details : [];
    }

    /**
     * @return array{0: array<string, array<string, float>>, 1: array<string, array<string, bool>>}
     */
    private function loadAvailabilityData(Carbon $rangeStart, Carbon $rangeEnd, Collection $employees): array
    {
        $availabilityHours = [];
        $employeeHolidays = [];

        $rows = EmployeeAvailability::query()
            ->with('employee:id,first_name,last_name')
            ->whereBetween('date', [$rangeStart->toDateString(), $rangeEnd->toDateString()])
            ->orderBy('date')
            ->get(['id', 'employee_id', 'date', 'total', 'total_ava']);

        foreach ($rows as $row) {
            $employee = $row->employee;
            if (! $employee) {
                continue;
            }

            $name = EmployeeNames::displayName($employee);
            if ($name === '') {
                continue;
            }

            $day = $row->date->toDateString();
            $hours = $this->parseTimeToHours($row->total_ava ?? $row->total ?? '00:00');

            if (! isset($availabilityHours[$name])) {
                $availabilityHours[$name] = [];
            }
            $availabilityHours[$name][$day] = $hours;

            if ($row->date->isWeekend()) {
                continue;
            }

            $totalHours = $this->parseTimeToHours($row->total ?? '00:00');
            $avaTotalHours = $this->parseTimeToHours($row->total_ava ?? '00:00');

            if ($totalHours > 0 || $avaTotalHours > 0) {
                continue;
            }

            if (! isset($employeeHolidays[$name])) {
                $employeeHolidays[$name] = [];
            }
            $employeeHolidays[$name][$day] = true;
        }

        return [$availabilityHours, $employeeHolidays];
    }

    private function dayCapacity(string $employeeName, string $dayYmd): ?float
    {
        if ($this->isEmployeeHoliday($employeeName, $dayYmd)) {
            return null;
        }

        $availability = $this->context['availability_hours'][$employeeName][$dayYmd] ?? null;
        if ($availability === null) {
            return self::DEFAULT_WORK_DAY_HOURS;
        }

        return max(0.0, (float) $availability);
    }

    private function isEmployeeHoliday(string $employeeName, string $dayYmd): bool
    {
        return (bool) ($this->context['employee_holidays'][$employeeName][$dayYmd] ?? false);
    }

    /**
     * @return list<string>
     */
    private function collectWeekdays(Carbon $searchStart, Carbon $searchEnd): array
    {
        $days = [];
        $cursor = $searchStart->copy()->startOfDay();
        $end = $searchEnd->copy()->startOfDay();

        while ($cursor->lte($end)) {
            if (! $cursor->isWeekend()) {
                $days[] = $cursor->toDateString();
            }
            $cursor->addDay();
        }

        return $days;
    }

    private function parseTimeToHours(?string $value): float
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
}
