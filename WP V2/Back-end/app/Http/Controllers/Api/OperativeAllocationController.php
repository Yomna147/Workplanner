<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Models\Team;
use App\Support\EmployeeOrder;
use App\Support\EmployeeNames;
use App\Support\OperativeAllocationNrms;
use App\Support\TeamOrder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class OperativeAllocationController extends Controller
{
    public function index(): JsonResponse
    {
        $employees = Employee::with(['team', 'nrms'])->get()
            ->sort(fn (Employee $a, Employee $b) => EmployeeOrder::compare($a, $b))
            ->values();

        $teams = Team::all()
            ->sort(fn (Team $a, Team $b) => TeamOrder::compare($a->name, $b->name))
            ->values();
        $nrms = OperativeAllocationNrms::ordered();

        return response()->json([
            'data' => [
                'employees' => $employees,
                'teams' => $teams,
                'nrms' => $nrms,
            ],
        ]);
    }

    public function sync(Request $request): JsonResponse
    {
        $teamsData = $request->all();

        if (! is_array($teamsData)) {
            return response()->json(['message' => 'Invalid payload.'], 422);
        }

        foreach ($teamsData as $teamData) {
            if (! isset($teamData['members']) || ! is_array($teamData['members'])) {
                continue;
            }

            foreach ($teamData['members'] as $index => $memberData) {
                $teamId = $memberData['team_id'] ?? null;
                $employeeId = $memberData['id'] ?? null;
                $isPersisted = $employeeId && is_numeric($employeeId) && Employee::where('id', $employeeId)->exists();

                if ($isPersisted) {
                    $employee = Employee::findOrFail($employeeId);
                    $previousName = EmployeeNames::displayName($employee);

                    $employee->update([
                        'first_name' => $memberData['first_name'] ?? '',
                        'last_name' => $memberData['last_name'] ?? null,
                        'team_id' => $teamId,
                        'position' => $index + 1,
                    ]);

                    $employee->refresh();
                    EmployeeNames::renameInTasks(
                        $previousName,
                        EmployeeNames::displayName($employee),
                    );
                } else {
                    $employee = Employee::create([
                        'first_name' => $memberData['first_name'] ?? '',
                        'last_name' => $memberData['last_name'] ?? null,
                        'team_id' => $teamId,
                        'position' => $index + 1,
                    ]);
                }

                $nrmsSyncData = [];
                foreach ($memberData['nrms'] ?? [] as $nrmData) {
                    if (empty($nrmData['id'])) {
                        continue;
                    }

                    $pivot = $nrmData['pivot'] ?? [];
                    $oap = array_key_exists('OAP', $pivot)
                        ? ($pivot['OAP'] === null || $pivot['OAP'] === '' ? '' : $pivot['OAP'])
                        : '';

                    $row = [
                        'OAP' => $oap,
                        'performance_percentage' => array_key_exists('performance_percentage', $pivot)
                            ? (($pivot['performance_percentage'] === null || $pivot['performance_percentage'] === '')
                                ? null
                                : $pivot['performance_percentage'])
                            : null,
                    ];

                    $nrmsSyncData[$nrmData['id']] = $row;
                }

                if ($nrmsSyncData !== [] || $isPersisted) {
                    $employee->nrms()->sync($nrmsSyncData);
                }
            }
        }

        return response()->json(['message' => 'Data saved successfully']);
    }

    public function destroyEmployees(Request $request): JsonResponse
    {
        $employeeIds = $request->input('employee_ids', []);

        if (! is_array($employeeIds) || $employeeIds === []) {
            return response()->json(['message' => 'No employees selected for deletion.'], 400);
        }

        $validIds = array_values(array_filter($employeeIds, fn ($id) => is_numeric($id)));

        if ($validIds === []) {
            return response()->json(['message' => 'No valid employee ids provided.'], 400);
        }

        Employee::destroy($validIds);

        return response()->json(['message' => 'Employees deleted successfully']);
    }
}
