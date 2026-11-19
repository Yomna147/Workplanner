<?php

namespace App\Support;

use App\Models\Employee;
use App\Models\ProjectTask;

class EmployeeTaskAssignment
{
    public static function taskAssignedToEmployee(ProjectTask|array $task, Employee $employee): bool
    {
        foreach (EmployeeNames::ASSIGNEE_FIELDS as $field) {
            $assignee = is_array($task) ? ($task[$field] ?? null) : $task->getAttribute($field);
            if (self::assigneeMatchesEmployee($assignee, $employee)) {
                return true;
            }
        }

        return false;
    }

    public static function assigneeMatchesEmployee(?string $assignee, Employee $employee): bool
    {
        $assignee = trim((string) ($assignee ?? ''));
        if ($assignee === '') {
            return false;
        }

        $labels = [
            EmployeeNames::displayName($employee->first_name, $employee->last_name),
            trim((string) ($employee->first_name ?? '')),
            trim((string) ($employee->last_name ?? '')),
            trim((string) ($employee->name ?? '')),
        ];

        foreach (EmployeeNames::aliasMap()[EmployeeNames::displayName($employee->first_name, $employee->last_name)] ?? [] as $alias) {
            $labels[] = $alias;
        }

        foreach (array_unique(array_filter($labels)) as $label) {
            if (EmployeeNames::namesMatch($assignee, $label)) {
                return true;
            }
        }

        return false;
    }
}
