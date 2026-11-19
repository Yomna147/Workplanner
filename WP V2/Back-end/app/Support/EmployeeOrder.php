<?php

namespace App\Support;

use App\Models\Employee;

class EmployeeOrder
{
    /** Same team → position → name order as the Operatives Allocation (OAP) table. */
    public static function compare(Employee $a, Employee $b): int
    {
        $teamCmp = TeamOrder::compare($a->team?->name, $b->team?->name);
        if ($teamCmp !== 0) {
            return $teamCmp;
        }

        $posA = $a->position ?? PHP_INT_MAX;
        $posB = $b->position ?? PHP_INT_MAX;
        if ($posA !== $posB) {
            return $posA <=> $posB;
        }

        return strcasecmp(EmployeeNames::displayName($a), EmployeeNames::displayName($b));
    }
}
