<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Support\EmployeeNames;
use App\Support\TeamOrder;
use Illuminate\Http\JsonResponse;

class UserController extends Controller
{
    public function options(): JsonResponse
    {
        $options = Employee::with('team')
            ->get()
            ->map(fn (Employee $employee) => [
                'id' => $employee->id,
                'name' => EmployeeNames::displayName($employee),
                'first_name' => $employee->first_name,
                'last_name' => $employee->last_name,
                'team' => $employee->team?->name,
            ])
            ->sort(fn (array $a, array $b) => $this->compareByTeam($a, $b))
            ->values();

        return response()->json(['data' => $options]);
    }

    private function compareByTeam(array $a, array $b): int
    {
        $teamCmp = TeamOrder::compare((string) ($a['team'] ?? ''), (string) ($b['team'] ?? ''));
        if ($teamCmp !== 0) {
            return $teamCmp;
        }

        $first = strcasecmp((string) ($a['first_name'] ?? ''), (string) ($b['first_name'] ?? ''));
        if ($first !== 0) {
            return $first;
        }

        return strcasecmp((string) ($a['last_name'] ?? ''), (string) ($b['last_name'] ?? ''));
    }
}
