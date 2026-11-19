<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Support\EmployeeOrder;
use App\Support\EmployeeNames;
use App\Support\EmployeeTrainee;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class EmployeeController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $query = Employee::with(['team', 'nrms'])->orderBy('first_name');

        if ($request->boolean('with_availabilities')) {
            $from = $request->input('availability_from');
            $to = $request->input('availability_to');

            $query->with(['availabilities' => function ($q) use ($from, $to) {
                $q->whereNotNull('date')->orderBy('date');
                if ($from) {
                    $q->where('date', '>=', $from);
                }
                if ($to) {
                    $q->where('date', '<=', $to);
                }
            }]);
        }

        if ($request->filled('team_id')) {
            $teamId = $request->input('team_id');
            if ($teamId === 'none') {
                $query->whereNull('team_id');
            } else {
                $query->where('team_id', (int) $teamId);
            }
        }

        $employees = $query->get()
            ->sort(fn (Employee $a, Employee $b) => EmployeeOrder::compare($a, $b))
            ->values()
            ->map(function (Employee $employee) {
                $data = $employee->toArray();
                unset($data['nrms']);
                $data['is_trainee'] = EmployeeTrainee::isTrainee($employee);

                return $data;
            });

        return response()->json(['data' => $employees]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'first_name' => 'required|string|max:255',
            'last_name' => 'nullable|string|max:255',
            'email' => 'nullable|email|max:255',
            'position' => 'nullable|integer|min:1|max:10',
            'team_id' => 'nullable|exists:teams,id',
        ]);

        $employee = Employee::create($validated);

        return response()->json(['data' => $employee->load('team')], 201);
    }

    public function show(Employee $employee): JsonResponse
    {
        return response()->json(['data' => $employee->load('team')]);
    }

    public function update(Request $request, Employee $employee): JsonResponse
    {
        $validated = $request->validate([
            'first_name' => 'sometimes|required|string|max:255',
            'last_name' => 'nullable|string|max:255',
            'email' => 'nullable|email|max:255',
            'position' => 'nullable|integer|min:1|max:10',
            'team_id' => 'nullable|exists:teams,id',
        ]);

        $previousName = EmployeeNames::displayName($employee);
        $employee->update($validated);
        $employee->refresh();

        EmployeeNames::renameInTasks(
            $previousName,
            EmployeeNames::displayName($employee),
        );

        return response()->json(['data' => $employee->fresh('team')]);
    }

    public function destroy(Employee $employee): JsonResponse
    {
        $employee->delete();

        return response()->json(['message' => 'Employee deleted']);
    }
}
