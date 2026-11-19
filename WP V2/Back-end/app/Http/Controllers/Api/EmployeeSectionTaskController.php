<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Models\ProjectTask;
use App\Models\User;
use App\Support\EmployeeNames;
use App\Support\EmployeeTaskAssignment;
use App\Support\ProjectStatusSync;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class EmployeeSectionTaskController extends Controller
{
    /** @var list<string> */
    private const SECTION_HOUR_FIELDS = [
        'sec_hrs_02',
        'sec_hrs_03',
        'sec_hrs_04',
        'sec_hrs_05',
        'sec_hrs_06',
        'sec_hrs_07',
        'sec_hrs_extra',
        'sec_hrs_total',
        'dl_sec_hrs_approved',
    ];

    public function index(Request $request, Employee $employee): JsonResponse
    {
        $this->authorizeEmployeeAccess($request, $employee);

        $employee->loadMissing('team');

        $tasks = ProjectTask::query()
            ->with([
                'part.project' => function ($query) {
                    $query->with('team')->withCount([
                        'tasks',
                        'tasks as open_tasks_count' => function ($taskQuery) {
                            $taskQuery->where(function ($inner) {
                                $inner->where('done', false)->orWhereNull('done');
                            });
                        },
                    ]);
                },
            ])
            ->orderBy('id')
            ->get()
            ->filter(fn (ProjectTask $task) => EmployeeTaskAssignment::taskAssignedToEmployee($task, $employee))
            ->values();

        $projects = [];

        foreach ($tasks as $task) {
            $project = $task->part?->project;
            if (! $project || ! ProjectStatusSync::isActiveForUserEntry($project)) {
                continue;
            }

            $projectId = (string) $project->id;
            if (! isset($projects[$projectId])) {
                $projects[$projectId] = [
                    'project' => [
                        'id' => $project->id,
                        'name' => $project->name,
                        'color' => $project->color,
                        'status' => $project->status,
                        'tasks_count' => (int) $project->tasks_count,
                        'open_tasks_count' => (int) $project->open_tasks_count,
                        'team' => $project->team ? [
                            'id' => $project->team->id,
                            'name' => $project->team->name,
                        ] : null,
                    ],
                    'tasks' => [],
                ];
            }

            $taskData = $task->toArray();
            EmployeeNames::normalizeTaskPayload($taskData);
            $taskData['part_id'] = $task->part_id;
            $taskData['part_name'] = $task->part?->name;

            if (! $this->userCanApproveSectionHours($request->user())) {
                $taskData = $this->sanitizeTaskForOperativeView($taskData);
            }

            $projects[$projectId]['tasks'][] = $taskData;
        }

        $data = collect($projects)
            ->sortBy(fn (array $group) => mb_strtolower((string) ($group['project']['name'] ?? '')))
            ->values()
            ->all();

        return response()->json(['data' => $data]);
    }

    public function sync(Request $request, Employee $employee): JsonResponse
    {
        $this->authorizeEmployeeAccess($request, $employee);

        $canApprove = $this->userCanApproveSectionHours($request->user());

        $validated = $request->validate([
            'tasks' => 'required|array|min:1',
            'tasks.*.id' => 'required|integer|exists:project_tasks,id',
            'tasks.*.sec_hrs_02' => 'nullable|string|max:50',
            'tasks.*.sec_hrs_03' => 'nullable|string|max:50',
            'tasks.*.sec_hrs_04' => 'nullable|string|max:50',
            'tasks.*.sec_hrs_05' => 'nullable|string|max:50',
            'tasks.*.sec_hrs_06' => 'nullable|string|max:50',
            'tasks.*.sec_hrs_07' => 'nullable|string|max:50',
            'tasks.*.sec_hrs_extra' => 'nullable|string|max:50',
            'tasks.*.sec_hrs_total' => 'nullable|string|max:50',
            'tasks.*.dl_sec_hrs_approved' => 'nullable|boolean',
        ]);

        $saved = DB::transaction(function () use ($validated, $employee, $canApprove) {
            $updated = [];

            foreach ($validated['tasks'] as $row) {
                /** @var ProjectTask $task */
                $task = ProjectTask::query()->findOrFail($row['id']);

                if (! EmployeeTaskAssignment::taskAssignedToEmployee($task, $employee)) {
                    continue;
                }

                $payload = collect($row)->only(self::SECTION_HOUR_FIELDS)->all();

                if ($canApprove && ! $request->user()?->is_admin) {
                    foreach ([
                        'sec_hrs_02',
                        'sec_hrs_03',
                        'sec_hrs_04',
                        'sec_hrs_05',
                        'sec_hrs_06',
                        'sec_hrs_07',
                        'sec_hrs_extra',
                        'sec_hrs_total',
                    ] as $field) {
                        unset($payload[$field]);
                    }
                }

                if (! $canApprove) {
                    unset($payload['dl_sec_hrs_approved']);

                    if ($task->dl_sec_hrs_approved) {
                        foreach ([
                            'sec_hrs_02',
                            'sec_hrs_03',
                            'sec_hrs_04',
                            'sec_hrs_05',
                            'sec_hrs_06',
                            'sec_hrs_07',
                            'sec_hrs_extra',
                            'sec_hrs_total',
                        ] as $field) {
                            unset($payload[$field]);
                        }
                    }
                }

                if ($payload === []) {
                    continue;
                }

                $task->update($payload);
                $task->loadMissing('part');
                $taskData = $task->fresh(['part'])->toArray();
                EmployeeNames::normalizeTaskPayload($taskData);
                $taskData['part_id'] = $task->part_id;
                $taskData['part_name'] = $task->part?->name;
                $updated[] = $taskData;
            }

            return $updated;
        });

        return response()->json(['data' => $saved]);
    }

    private function authorizeEmployeeAccess(Request $request, Employee $employee): void
    {
        $user = $request->user();
        if (! $user) {
            abort(401);
        }

        if ($user->is_admin || $this->userCanViewAllEmployees($user)) {
            return;
        }

        if (! $this->userMatchesEmployee($user, $employee)) {
            abort(403, 'You can only view your own assigned tasks.');
        }
    }

    private function userCanViewAllEmployees(?User $user): bool
    {
        return (bool) $user?->canPageAction('Project Progress', 'view_all_employees');
    }

    private function userCanApproveSectionHours(?User $user): bool
    {
        return (bool) $user?->canPageAction('Project Progress', 'approve_hours');
    }

    private function userMatchesEmployee(User $user, Employee $employee): bool
    {
        $labels = array_filter([
            $user->name,
            trim(((string) ($user->first_name ?? '')).' '.((string) ($user->last_name ?? ''))),
            $user->first_name,
            $user->login_name,
        ]);

        foreach ($labels as $label) {
            if (EmployeeTaskAssignment::assigneeMatchesEmployee($label, $employee)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array<string, mixed>  $taskData
     * @return array<string, mixed>
     */
    private function sanitizeTaskForOperativeView(array $taskData): array
    {
        foreach ([
            'dl_sec_hrs_02',
            'dl_sec_hrs_03',
            'dl_sec_hrs_04',
            'dl_sec_hrs_05',
            'dl_sec_hrs_06',
            'dl',
        ] as $field) {
            unset($taskData[$field]);
        }

        // Legacy rows may still have DL budget hours stored in sec_hrs_02–06.
        $legacyDlBudgetPresent = array_filter([
            $taskData['sec_hrs_02'] ?? null,
            $taskData['sec_hrs_03'] ?? null,
            $taskData['sec_hrs_04'] ?? null,
            $taskData['sec_hrs_05'] ?? null,
            $taskData['sec_hrs_06'] ?? null,
        ], fn ($value) => trim((string) $value) !== '');

        if ($legacyDlBudgetPresent !== [] && empty($taskData['dl_sec_hrs_approved'])) {
            foreach (['sec_hrs_02', 'sec_hrs_03', 'sec_hrs_04', 'sec_hrs_05', 'sec_hrs_06'] as $field) {
                $taskData[$field] = null;
            }

            $tpsTotal = 0;
            $hasTpsValue = false;

            foreach (['sec_hrs_07', 'sec_hrs_extra'] as $field) {
                $value = trim((string) ($taskData[$field] ?? ''));
                if ($value === '') {
                    continue;
                }

                $hasTpsValue = true;
                $tpsTotal += (float) $value;
            }

            $taskData['sec_hrs_total'] = $hasTpsValue
                ? (string) (round($tpsTotal * 100) / 100)
                : null;
        }

        return $taskData;
    }
}
