<?php

namespace App\Support;

use Carbon\Carbon;
use Illuminate\Support\Facades\Log;

class ApplyHistogramBarEdits
{
    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  array<int, array<string, mixed>>  $edits
     * @return array<int, array<string, mixed>>
     */
    public static function apply(array $assignmentDetails, array $edits): array
    {
        foreach ($edits as $edit) {
            $assignmentDetails = self::applyEdit($assignmentDetails, $edit);
        }

        // Cap any leftover overloads (prior algo/edit bugs, or race with other tasks)
        // so a save can clear Habiba-style 9h/8h days instead of only rejecting.
        $assignmentDetails = self::trimEmployeeDayOverloads($assignmentDetails);

        $overloads = self::findEmployeeDayOverloads($assignmentDetails);
        if ($overloads !== []) {
            Log::warning('Histogram schedule exceeds employee availability', [
                'overload_count' => count($overloads),
                'sample' => array_slice($overloads, 0, 5),
            ]);
        }

        return $assignmentDetails;
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     */
    public static function assertNoEmployeeDayOverload(array $assignmentDetails): void
    {
        $overload = self::findEmployeeDayOverloads($assignmentDetails);
        if ($overload === []) {
            return;
        }

        $first = $overload[0];
        throw new \InvalidArgumentException(sprintf(
            '%s is double-booked on %s (%.1fh scheduled, %.1fh available). Adjust the histogram or algorithm assignments.',
            $first['employee'],
            $first['date'],
            $first['total'],
            $first['cap'],
        ));
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  array<int, string>  $taskStartById  task_id => Y-m-d doc_supply
     */
    public static function assertNoAssignmentsBeforeTaskStart(
        array $assignmentDetails,
        array $taskStartById,
    ): void {
        foreach ($assignmentDetails as $taskDetail) {
            $taskId = (int) ($taskDetail['task_id'] ?? 0);
            $taskStart = $taskStartById[$taskId] ?? null;
            if ($taskStart === null || $taskStart === '') {
                continue;
            }

            foreach ($taskDetail['assignments'] ?? [] as $assignment) {
                $date = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;
                if ($date === null || $hours <= 0.001) {
                    continue;
                }

                if ($date < $taskStart) {
                    $employee = EmployeeNames::canonicalize((string) ($assignment['employee'] ?? ''))
                        ?? trim((string) ($assignment['employee'] ?? ''));
                    throw new \InvalidArgumentException(sprintf(
                        '%s cannot be scheduled on %s before the task start date (%s).',
                        $employee !== '' ? $employee : 'An operative',
                        $date,
                        $taskStart,
                    ));
                }
            }
        }
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return list<array{employee: string, date: string, total: float, cap: float}>
     */
    public static function findEmployeeDayOverloads(array $assignmentDetails): array
    {
        $capIndex = EmployeeAvailabilityHours::buildCapIndexForAssignments($assignmentDetails);
        $totals = [];

        foreach ($assignmentDetails as $taskDetail) {
            foreach ($taskDetail['assignments'] ?? [] as $assignment) {
                $employee = EmployeeNames::canonicalize((string) ($assignment['employee'] ?? ''))
                    ?? trim((string) ($assignment['employee'] ?? ''));
                $date = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;

                if ($employee === '' || $date === null || $hours <= 0) {
                    continue;
                }

                if (! isset($totals[$employee])) {
                    $totals[$employee] = [];
                }

                $totals[$employee][$date] = round(($totals[$employee][$date] ?? 0) + $hours, 4);
            }
        }

        $overloads = [];
        foreach ($totals as $employee => $byDate) {
            foreach ($byDate as $date => $total) {
                $cap = EmployeeAvailabilityHours::resolveDailyCapForEmployee(
                    $capIndex,
                    $employee,
                    $date,
                    false,
                );
                if ($cap === null) {
                    continue;
                }

                if ($total > $cap + 0.001) {
                    $overloads[] = [
                        'employee' => $employee,
                        'date' => $date,
                        'total' => $total,
                        'cap' => $cap,
                    ];
                }
            }
        }

        usort($overloads, static function (array $left, array $right) {
            $dateCmp = strcmp($left['date'], $right['date']);
            if ($dateCmp !== 0) {
                return $dateCmp;
            }

            return strcasecmp($left['employee'], $right['employee']);
        });

        return $overloads;
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  array<string, mixed>  $edit
     * @return array<int, array<string, mixed>>
     */
    private static function applyEdit(array $assignmentDetails, array $edit): array
    {
        $taskId = (int) ($edit['task_id'] ?? 0);
        if ($taskId <= 0) {
            return $assignmentDetails;
        }

        $employee = trim((string) ($edit['employee'] ?? ''));
        if ($employee === '') {
            return $assignmentDetails;
        }

        $previousEmployee = trim((string) ($edit['previous_employee'] ?? ''));
        $previousDays = self::normalizedDayKeys($edit['previous_hours_by_day'] ?? []);
        $nextHoursByDay = self::normalizedHoursByDay($edit['hours_by_day'] ?? []);
        $affectedDays = array_values(array_unique([
            ...$previousDays,
            ...array_keys($nextHoursByDay),
        ]));

        if ($affectedDays === []) {
            return $assignmentDetails;
        }

        $employeesToClear = array_values(array_unique(array_filter([
            $employee,
            $previousEmployee !== '' && strcasecmp($previousEmployee, $employee) !== 0
                ? $previousEmployee
                : null,
        ])));

        foreach ($assignmentDetails as $index => $taskDetail) {
            if ((int) ($taskDetail['task_id'] ?? 0) !== $taskId) {
                continue;
            }

            $assignments = is_array($taskDetail['assignments'] ?? null)
                ? $taskDetail['assignments']
                : [];

            // Replace the full schedule for touched employees on this task.
            // Clearing only "affected days" left orphan hours when previous_hours_by_day
            // was incomplete (fragments / view clipping), so edits looked like they
            // snapped back after save.
            $assignments = array_values(array_filter(
                $assignments,
                static function (array $assignment) use ($employeesToClear) {
                    foreach ($employeesToClear as $employeeName) {
                        if (self::assignmentEmployeeMatches($assignment, $employeeName)) {
                            return false;
                        }
                    }

                    return true;
                },
            ));

            foreach ($nextHoursByDay as $day => $hours) {
                $assignments[] = [
                    'employee' => self::resolveAssignmentEmployeeName($employee),
                    'date' => $day,
                    'hours' => round($hours, 4),
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

            // Cap this edit against AVA + other tasks before returning (same rules as overrides).
            return self::capTaskEmployeeHoursToDailyRoom(
                $assignmentDetails,
                $taskId,
                self::resolveAssignmentEmployeeName($employee),
                array_keys($nextHoursByDay),
            );
        }

        return $assignmentDetails;
    }

    /**
     * Trim hours that exceed an employee's daily AVA across all tasks.
     * Lower-priority tasks (higher Pri) are trimmed first; equal Pri prefers larger rows.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @return array<int, array<string, mixed>>
     */
    public static function trimEmployeeDayOverloads(array $assignmentDetails): array
    {
        if ($assignmentDetails === []) {
            return $assignmentDetails;
        }

        $guard = 0;
        while ($guard++ < 500) {
            $overloads = self::findEmployeeDayOverloads($assignmentDetails);
            if ($overloads === []) {
                break;
            }

            $overload = $overloads[0];
            $employee = (string) ($overload['employee'] ?? '');
            $date = (string) ($overload['date'] ?? '');
            $excess = (float) ($overload['total'] ?? 0.0) - (float) ($overload['cap'] ?? 0.0);
            if ($employee === '' || $date === '' || $excess <= 0.0001) {
                break;
            }

            $candidates = [];
            foreach ($assignmentDetails as $taskIdx => $taskDetail) {
                foreach ($taskDetail['assignments'] ?? [] as $rowIdx => $row) {
                    if (! is_array($row) || ! self::assignmentEmployeeMatches($row, $employee)) {
                        continue;
                    }
                    $rowDate = self::normalizeDate((string) ($row['date'] ?? ''));
                    $hours = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
                    if ($rowDate !== $date || $hours <= 0.0001) {
                        continue;
                    }
                    $candidates[] = [
                        'task_idx' => $taskIdx,
                        'row_idx' => $rowIdx,
                        'pri' => is_numeric($taskDetail['Pri'] ?? null)
                            ? (float) $taskDetail['Pri']
                            : PHP_FLOAT_MAX,
                        'hours' => $hours,
                    ];
                }
            }

            if ($candidates === []) {
                break;
            }

            usort($candidates, static function (array $a, array $b) {
                $priCmp = $b['pri'] <=> $a['pri']; // higher Pri (lower priority) first
                if ($priCmp !== 0) {
                    return $priCmp;
                }

                return $b['hours'] <=> $a['hours'];
            });

            $left = $excess;
            foreach ($candidates as $candidate) {
                if ($left <= 0.0001) {
                    break;
                }
                $taskIdx = $candidate['task_idx'];
                $rowIdx = $candidate['row_idx'];
                if (! isset($assignmentDetails[$taskIdx]['assignments'][$rowIdx])) {
                    continue;
                }
                $row = $assignmentDetails[$taskIdx]['assignments'][$rowIdx];
                $hours = is_numeric($row['hours'] ?? null) ? (float) $row['hours'] : 0.0;
                if ($hours <= 0.0001) {
                    continue;
                }
                $trim = min($left, $hours);
                $newHours = round($hours - $trim, 4);
                if ($newHours <= 0.0001) {
                    unset($assignmentDetails[$taskIdx]['assignments'][$rowIdx]);
                } else {
                    $assignmentDetails[$taskIdx]['assignments'][$rowIdx]['hours'] = $newHours;
                }
                $left = round($left - $trim, 4);
            }

            foreach ($assignmentDetails as $taskIdx => $taskDetail) {
                if (! is_array($taskDetail['assignments'] ?? null)) {
                    continue;
                }
                $assignmentDetails[$taskIdx]['assignments'] = array_values($taskDetail['assignments']);
            }
        }

        return $assignmentDetails;
    }

    /**
     * Cap one employee’s hours on the given days so they fit AVA minus other tasks.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  list<string>  $days
     * @return array<int, array<string, mixed>>
     */
    private static function capTaskEmployeeHoursToDailyRoom(
        array $assignmentDetails,
        int $taskId,
        string $employee,
        array $days,
    ): array {
        if ($taskId <= 0 || $employee === '' || $days === []) {
            return $assignmentDetails;
        }

        $capIndex = EmployeeAvailabilityHours::buildCapIndexForAssignments($assignmentDetails);
        $usedElsewhere = [];

        foreach ($assignmentDetails as $taskDetail) {
            if ((int) ($taskDetail['task_id'] ?? 0) === $taskId) {
                continue;
            }
            foreach ($taskDetail['assignments'] ?? [] as $assignment) {
                if (! is_array($assignment) || ! self::assignmentEmployeeMatches($assignment, $employee)) {
                    continue;
                }
                $day = self::normalizeDate((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;
                if ($day === null || $hours <= 0.001 || ! in_array($day, $days, true)) {
                    continue;
                }
                $usedElsewhere[$day] = ($usedElsewhere[$day] ?? 0.0) + $hours;
            }
        }

        foreach ($assignmentDetails as $index => $taskDetail) {
            if ((int) ($taskDetail['task_id'] ?? 0) !== $taskId) {
                continue;
            }

            $assignments = is_array($taskDetail['assignments'] ?? null)
                ? $taskDetail['assignments']
                : [];

            foreach ($assignments as $rowIdx => $assignment) {
                if (! is_array($assignment) || ! self::assignmentEmployeeMatches($assignment, $employee)) {
                    continue;
                }
                $day = self::normalizeDate((string) ($assignment['date'] ?? ''));
                if ($day === null || ! in_array($day, $days, true)) {
                    continue;
                }

                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;
                $cap = EmployeeAvailabilityHours::resolveDailyCapForEmployee(
                    $capIndex,
                    $employee,
                    $day,
                    false,
                );
                $maxHours = max(0.0, $cap ?? EmployeeAvailabilityHours::DEFAULT_WORKDAY_HOURS);
                $allowed = max(0.0, $maxHours - ($usedElsewhere[$day] ?? 0.0));
                $capped = round(min($hours, $allowed), 4);

                if ($capped <= 0.001) {
                    unset($assignments[$rowIdx]);
                } elseif (abs($capped - $hours) > 0.0001) {
                    $assignments[$rowIdx]['hours'] = $capped;
                }
            }

            $assignmentDetails[$index]['assignments'] = array_values($assignments);

            return $assignmentDetails;
        }

        return $assignmentDetails;
    }

    private static function assignmentEmployeeMatches(array $assignment, string $employee): bool
    {
        $assignmentEmployee = trim((string) ($assignment['employee'] ?? ''));
        if ($assignmentEmployee === '') {
            return false;
        }

        $left = EmployeeNames::canonicalize($assignmentEmployee) ?? $assignmentEmployee;
        $right = EmployeeNames::canonicalize($employee) ?? $employee;

        return strcasecmp($left, $right) === 0;
    }

    private static function resolveAssignmentEmployeeName(string $employee): string
    {
        return EmployeeNames::canonicalize($employee) ?? $employee;
    }

    /**
     * @param  array<string|int, mixed>  $hoursByDay
     * @return array<string, float>
     */
    private static function normalizedHoursByDay(array $hoursByDay): array
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

            $normalized[$ymd] = $value;
        }

        ksort($normalized);

        return $normalized;
    }

    /**
     * @param  array<string|int, mixed>  $hoursByDay
     * @return list<string>
     */
    private static function normalizedDayKeys(array $hoursByDay): array
    {
        $days = [];

        foreach (array_keys($hoursByDay) as $day) {
            $ymd = self::normalizeDate(is_string($day) ? $day : (string) $day);
            if ($ymd !== null) {
                $days[] = $ymd;
            }
        }

        return $days;
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
