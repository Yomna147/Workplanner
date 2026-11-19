<?php

namespace App\Support;

use App\Models\Employee;

class EmployeeTrainee
{
    public static function isTrainee(?Employee $employee): bool
    {
        if (! $employee) {
            return false;
        }

        foreach ($employee->nrms as $nrm) {
            $performance = self::parsePerformanceNumber($nrm->pivot->performance_percentage ?? null);
            if ($performance !== null && $performance < 100) {
                return true;
            }
        }

        return false;
    }

    public static function parsePerformanceNumber(mixed $value): ?float
    {
        $raw = trim(str_replace('%', '', (string) ($value ?? '')));
        if ($raw === '' || ! is_numeric($raw)) {
            return null;
        }

        return (float) $raw;
    }
}
