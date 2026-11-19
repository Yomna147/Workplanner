<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Employee;
use App\Models\EmployeeTraining;
use App\Models\TrainingCourse;
use App\Models\User;
use App\Services\ActivityLogService;
use App\Support\EmployeeTaskAssignment;
use App\Support\TrainingActivityLog;
use App\Support\TrainingOccupiedSlotChecker;
use App\Support\TrainingProjectHourDisplacement;
use Carbon\Carbon;
use Illuminate\Database\QueryException;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class TrainingController extends Controller
{
    private const DURATIONS = ['1-2 hours', '2-4 hours', 'Half day', 'Full day', 'Multi-day', 'Custom'];

    private const STATUSES = ['not_started', 'scheduled', 'in_progress', 'almost_complete', 'completed'];

    private const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

    private const URGENCIES = ['U0', 'U1', 'U2', 'U3'];

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'employee_id' => 'nullable|integer|exists:employees,id',
            'start' => 'nullable|date',
            'end' => 'nullable|date',
        ]);

        $query = EmployeeTraining::query()
            ->with(['employee:id,first_name,last_name,team_id', 'employee.team:id,name', 'trainingCourse:id,title'])
            ->orderByDesc('start_date')
            ->orderBy('title');

        if (! empty($validated['employee_id'])) {
            $query->where('employee_id', $validated['employee_id']);
        }

        if (! empty($validated['start']) && ! empty($validated['end'])) {
            $query->whereDate('start_date', '<=', $validated['end'])
                ->whereDate('end_date', '>=', $validated['start']);
        }

        return response()->json([
            'data' => $this->dedupeAssignments($query->get()),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'employee_id' => 'required|integer|exists:employees,id',
            'training_course_id' => 'nullable|integer|exists:training_courses,id',
            'title' => 'required|string|max:255',
            'course_link' => 'nullable|url|max:2048',
            'description' => 'nullable|string|max:5000',
            'duration' => ['nullable', 'string', Rule::in(self::DURATIONS)],
            'status' => ['nullable', 'string', Rule::in(self::STATUSES)],
            'priority' => ['nullable', 'string', Rule::in(self::PRIORITIES)],
            'urgency' => ['nullable', 'string', Rule::in(self::URGENCIES)],
            'confirm_override' => 'nullable|boolean',
            'start_date' => 'required|date',
            'end_date' => 'required|date|after_or_equal:start_date',
            'hours_per_day' => 'required|numeric|min:0.25|max:24',
            'day_segment' => 'nullable|integer|min:0|max:3',
            'notes' => 'nullable|string|max:2000',
            'override_conflicts' => 'nullable|array',
            'override_conflicts.*.message' => 'nullable|string|max:2000',
            'override_conflicts.*.tasks' => 'nullable|array',
            'override_conflicts.*.tasks.*.task_name' => 'nullable|string|max:255',
            'override_conflicts.*.tasks.*.project_name' => 'nullable|string|max:255',
            'override_conflicts.*.trainings' => 'nullable|array',
            'override_conflicts.*.trainings.*' => 'nullable|string|max:255',
        ]);

        $this->authorizeTrainingWrite($request, (int) $validated['employee_id']);

        $validated = $this->applyCourseDefaults($validated);
        if (! array_key_exists('day_segment', $validated) || $validated['day_segment'] === null) {
            $validated['day_segment'] = 0;
        }
        $clientOverrideConflicts = TrainingActivityLog::normalizeOverrideConflicts(
            is_array($validated['override_conflicts'] ?? null) ? $validated['override_conflicts'] : [],
        );
        unset($validated['override_conflicts']);

        if ($this->findDuplicateAssignment($validated)) {
            return response()->json([
                'message' => 'This operative is already assigned to this training course.',
            ], 422);
        }

        $conflicts = $this->mergeOverrideConflictsForAudit(
            $this->assertOccupiedSlotAllowed($validated),
            $clientOverrideConflicts,
            (bool) ($validated['confirm_override'] ?? false),
        );

        $assignedByUserId = $request->user()?->id;
        if ($assignedByUserId && ! User::query()->whereKey($assignedByUserId)->exists()) {
            $assignedByUserId = null;
        }

        $actorName = $request->user()?->name ?? 'System';

        try {
            $training = DB::transaction(function () use ($request, $validated, $assignedByUserId, $conflicts, $actorName) {
                $training = EmployeeTraining::create([
                    ...$validated,
                    'assigned_by_user_id' => $assignedByUserId,
                    'assigned_by_name' => $request->user()?->name,
                    'duration' => $validated['duration'] ?? '1-2 hours',
                    'status' => $validated['status'] ?? 'not_started',
                    'priority' => $validated['priority'] ?? 'P2',
                    'urgency' => $validated['urgency'] ?? 'U1',
                    'confirm_override' => (bool) ($validated['confirm_override'] ?? false),
                ]);

                $training->load(['employee:id,first_name,last_name,team_id', 'employee.team:id,name', 'trainingCourse:id,title']);
                $employeeName = trim(($training->employee->first_name ?? '').' '.($training->employee->last_name ?? ''));
                $overrideNote = TrainingActivityLog::summarizeOverrideNote(
                    $conflicts,
                    (bool) $training->confirm_override,
                    $training->title ?: 'Untitled course',
                    $actorName,
                    $employeeName,
                );
                $createdChanges = TrainingActivityLog::createdChanges($training);
                $action = $overrideNote !== '' ? 'overridden' : 'created';

                ActivityLogService::log(
                    $request,
                    'Trainings',
                    $action,
                    TrainingActivityLog::summarizeCreated($training, $employeeName, $overrideNote, $createdChanges, $actorName),
                    EmployeeTraining::class,
                    $training->id,
                    $createdChanges,
                    [
                        'employee_id' => $training->employee_id,
                        'training_course_id' => $training->training_course_id,
                        'start_date' => $training->start_date->toDateString(),
                        'end_date' => $training->end_date->toDateString(),
                        'status' => $training->status,
                        'duration' => $training->duration,
                        'hours_per_day' => $training->hours_per_day,
                        'confirm_override' => $training->confirm_override,
                        'overridden_tasks' => $this->overriddenTaskMeta($conflicts),
                        'overridden_trainings' => $this->overriddenTrainingMeta($conflicts),
                        'override_before' => TrainingActivityLog::summarizeOverrideBeforeLabels($conflicts),
                        'override_after' => $training->title ?: 'Untitled course',
                        'override_by' => $actorName,
                    ],
                );

                return $training;
            });
        } catch (QueryException $e) {
            if ($this->isDuplicateTrainingConstraint($e)) {
                return response()->json([
                    'message' => 'This operative is already assigned to this training course.',
                ], 422);
            }

            throw $e;
        }

        $displacement = ['changed' => false, 'hours_freed' => 0.0, 'suggest_algorithm_rerun' => false];
        if ((bool) $training->confirm_override) {
            $displacement = TrainingProjectHourDisplacement::applyForTraining($training, $conflicts, $request);
        }

        return response()->json([
            'data' => $training,
            'project_hours_displaced' => $displacement['hours_freed'] ?? 0,
            'suggest_algorithm_rerun' => (bool) ($displacement['suggest_algorithm_rerun'] ?? false),
            'message' => ! empty($displacement['suggest_algorithm_rerun'])
                ? 'Training saved. Project hours on those days were reduced to make room — re-run the algorithm so remaining work is rescheduled.'
                : null,
        ], 201);
    }

    public function update(Request $request, EmployeeTraining $training): JsonResponse
    {
        $validated = $request->validate([
            'employee_id' => 'sometimes|required|integer|exists:employees,id',
            'training_course_id' => 'nullable|integer|exists:training_courses,id',
            'title' => 'sometimes|required|string|max:255',
            'course_link' => 'nullable|url|max:2048',
            'description' => 'nullable|string|max:5000',
            'duration' => ['nullable', 'string', Rule::in(self::DURATIONS)],
            'status' => ['nullable', 'string', Rule::in(self::STATUSES)],
            'priority' => ['nullable', 'string', Rule::in(self::PRIORITIES)],
            'urgency' => ['nullable', 'string', Rule::in(self::URGENCIES)],
            'confirm_override' => 'nullable|boolean',
            'start_date' => 'sometimes|required|date',
            'end_date' => 'sometimes|required|date|after_or_equal:start_date',
            'hours_per_day' => 'sometimes|required|numeric|min:0.25|max:24',
            'day_segment' => 'nullable|integer|min:0|max:3',
            'notes' => 'nullable|string|max:2000',
            'override_conflicts' => 'nullable|array',
            'override_conflicts.*.message' => 'nullable|string|max:2000',
            'override_conflicts.*.tasks' => 'nullable|array',
            'override_conflicts.*.tasks.*.task_name' => 'nullable|string|max:255',
            'override_conflicts.*.tasks.*.project_name' => 'nullable|string|max:255',
            'override_conflicts.*.trainings' => 'nullable|array',
            'override_conflicts.*.trainings.*' => 'nullable|string|max:255',
        ]);

        $employeeId = (int) ($validated['employee_id'] ?? $training->employee_id);
        $this->authorizeTrainingWrite($request, $employeeId);
        $validated = $this->restrictOwnTrainingFields($request, $validated);
        $validated = $this->applyCourseDefaults($validated, $training);
        $clientOverrideConflicts = TrainingActivityLog::normalizeOverrideConflicts(
            is_array($validated['override_conflicts'] ?? null) ? $validated['override_conflicts'] : [],
        );
        unset($validated['override_conflicts']);

        $title = (string) ($validated['title'] ?? $training->title);
        $startDate = isset($validated['start_date'])
            ? Carbon::parse($validated['start_date'])->toDateString()
            : $training->start_date->toDateString();
        $endDate = isset($validated['end_date'])
            ? Carbon::parse($validated['end_date'])->toDateString()
            : $training->end_date->toDateString();

        if ($this->duplicateAssignmentExists([
            'employee_id' => $employeeId,
            'training_course_id' => $validated['training_course_id'] ?? $training->training_course_id,
            'title' => $title,
            'start_date' => $startDate,
            'end_date' => $endDate,
        ], $training->id)) {
            return response()->json([
                'message' => 'This operative is already assigned to this training course.',
            ], 422);
        }

        $conflicts = $this->mergeOverrideConflictsForAudit(
            $this->assertOccupiedSlotAllowed($validated, $training),
            $clientOverrideConflicts,
            (bool) ($validated['confirm_override'] ?? $training->confirm_override),
        );

        $before = TrainingActivityLog::snapshot($training);
        $actorName = $request->user()?->name ?? 'System';

        $training = DB::transaction(function () use ($request, $training, $validated, $before, $conflicts, $actorName) {
            $training->update($validated);
            $training = $training->fresh(['employee:id,first_name,last_name,team_id', 'employee.team:id,name', 'trainingCourse:id,title']);

            $changes = TrainingActivityLog::diff($before, TrainingActivityLog::snapshot($training));
            $employeeName = trim(($training->employee->first_name ?? '').' '.($training->employee->last_name ?? ''));
            $overrideNote = TrainingActivityLog::summarizeOverrideNote(
                $conflicts,
                (bool) $training->confirm_override,
                $training->title ?: 'Untitled course',
                $actorName,
                $employeeName,
            );

            if ($changes !== [] || $overrideNote !== '') {
                $action = TrainingActivityLog::resolveUpdateAction($changes, $overrideNote);
                ActivityLogService::log(
                    $request,
                    'Trainings',
                    $action,
                    TrainingActivityLog::summarizeUpdated($training, $employeeName, $changes, $overrideNote, $actorName),
                    EmployeeTraining::class,
                    $training->id,
                    $changes !== [] ? $changes : null,
                    [
                        'employee_id' => $training->employee_id,
                        'training_course_id' => $training->training_course_id,
                        'start_date' => $training->start_date->toDateString(),
                        'end_date' => $training->end_date->toDateString(),
                        'status' => $training->status,
                        'duration' => $training->duration,
                        'hours_per_day' => $training->hours_per_day,
                        'confirm_override' => $training->confirm_override,
                        'overridden_tasks' => $this->overriddenTaskMeta($conflicts),
                        'overridden_trainings' => $this->overriddenTrainingMeta($conflicts),
                        'override_before' => TrainingActivityLog::summarizeOverrideBeforeLabels($conflicts),
                        'override_after' => $training->title ?: 'Untitled course',
                        'override_by' => $actorName,
                    ],
                );
            }

            return $training;
        });

        $displacement = ['changed' => false, 'hours_freed' => 0.0, 'suggest_algorithm_rerun' => false];
        if ((bool) $training->confirm_override) {
            $displacement = TrainingProjectHourDisplacement::applyForTraining($training, $conflicts, $request);
        }

        return response()->json([
            'data' => $training,
            'project_hours_displaced' => $displacement['hours_freed'] ?? 0,
            'suggest_algorithm_rerun' => (bool) ($displacement['suggest_algorithm_rerun'] ?? false),
            'message' => ! empty($displacement['suggest_algorithm_rerun'])
                ? 'Training saved. Project hours on those days were reduced to make room — re-run the algorithm so remaining work is rescheduled.'
                : null,
        ]);
    }

    public function destroy(Request $request, EmployeeTraining $training): JsonResponse
    {
        if (
            ! $request->user()?->canPageAction('Trainings', 'delete')
            && ! $request->user()?->canPageAction('Resource Histogram', 'delete_trainings')
        ) {
            return response()->json([
                'message' => 'You do not have permission to delete training assignments.',
            ], 403);
        }

        $training->load(['employee:id,first_name,last_name']);
        $employeeName = trim(($training->employee->first_name ?? '').' '.($training->employee->last_name ?? ''));
        $actorName = $request->user()?->name ?? 'System';
        $trainingId = $training->id;
        $title = $training->title;

        $training->delete();

        ActivityLogService::log(
            $request,
            'Trainings',
            'deleted',
            TrainingActivityLog::summarizeDeleted($title, $employeeName, $actorName),
            EmployeeTraining::class,
            $trainingId,
        );

        return response()->json(['message' => 'Training deleted.']);
    }

    /**
     * @param  array{employee_id:int,title?:string,start_date?:string,end_date?:string,training_course_id?:int|null}  $data
     */
    private function findDuplicateAssignment(array $data, ?int $ignoreId = null): ?EmployeeTraining
    {
        $employeeId = (int) $data['employee_id'];
        $courseId = $data['training_course_id'] ?? null;

        $query = EmployeeTraining::query()->where('employee_id', $employeeId);

        if ($courseId) {
            $query->where('training_course_id', $courseId);
        } else {
            $query
                ->where('title', (string) ($data['title'] ?? ''))
                ->whereDate('start_date', Carbon::parse($data['start_date'] ?? '')->toDateString())
                ->whereDate('end_date', Carbon::parse($data['end_date'] ?? '')->toDateString());
        }

        if ($ignoreId) {
            $query->where('id', '!=', $ignoreId);
        }

        return $query->first();
    }

    /**
     * @param  array{employee_id:int,title:string,start_date:string,end_date:string}  $data
     */
    private function duplicateAssignmentExists(array $data, ?int $ignoreId = null): bool
    {
        return $this->findDuplicateAssignment($data, $ignoreId) !== null;
    }

    /**
     * @param  iterable<int, EmployeeTraining>  $trainings
     * @return \Illuminate\Support\Collection<int, EmployeeTraining>
     */
    private function dedupeAssignments(iterable $trainings)
    {
        $seen = [];
        $deduped = [];

        foreach (collect($trainings)->sortBy('id') as $training) {
            $key = implode('|', [
                $training->employee_id,
                $training->title,
                $training->start_date->toDateString(),
                $training->end_date->toDateString(),
            ]);

            if (isset($seen[$key])) {
                continue;
            }

            $seen[$key] = true;
            $deduped[] = $training;
        }

        return collect($deduped)->values();
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return list<array<string, mixed>>
     */
    private function assertOccupiedSlotAllowed(array $payload, ?EmployeeTraining $existing = null): array
    {
        $employeeId = (int) ($payload['employee_id'] ?? $existing?->employee_id);
        $startDate = isset($payload['start_date'])
            ? Carbon::parse($payload['start_date'])->toDateString()
            : $existing?->start_date?->toDateString();
        $endDate = isset($payload['end_date'])
            ? Carbon::parse($payload['end_date'])->toDateString()
            : $existing?->end_date?->toDateString();
        $hoursPerDay = (float) ($payload['hours_per_day'] ?? $existing?->hours_per_day ?? 8);
        $daySegment = array_key_exists('day_segment', $payload)
            ? (int) $payload['day_segment']
            : (int) ($existing?->day_segment ?? 0);
        $confirmOverride = array_key_exists('confirm_override', $payload)
            ? (bool) $payload['confirm_override']
            : (bool) ($existing?->confirm_override ?? false);

        if ($existing) {
            $scheduleChanged = array_key_exists('employee_id', $payload)
                || array_key_exists('start_date', $payload)
                || array_key_exists('end_date', $payload)
                || array_key_exists('hours_per_day', $payload)
                || array_key_exists('day_segment', $payload);
            $overrideJustConfirmed = array_key_exists('confirm_override', $payload)
                && (bool) $payload['confirm_override']
                && ! (bool) ($existing->confirm_override ?? false);

            if (! $scheduleChanged && ! $overrideJustConfirmed) {
                return [];
            }
        }

        if (! $startDate || ! $endDate) {
            return [];
        }

        $holidayDays = TrainingOccupiedSlotChecker::holidayDaysFor($employeeId, $startDate, $endDate);
        if ($holidayDays !== []) {
            $employee = Employee::query()->find($employeeId);
            $employeeName = trim(($employee?->first_name ?? '').' '.($employee?->last_name ?? ''));
            if ($employeeName === '') {
                $employeeName = 'This operative';
            }
            $dayText = count($holidayDays) === 1
                ? Carbon::parse($holidayDays[0])->format('D j M Y')
                : Carbon::parse($holidayDays[0])->format('D j M Y').' (+'.(count($holidayDays) - 1).' more)';

            throw new HttpResponseException(response()->json([
                'message' => "{$employeeName} is on holiday (H) on {$dayText}. Training cannot be booked on holiday days.",
                'code' => 'TRAINING_HOLIDAY_SLOT',
                'conflicts' => [[
                    'employee_id' => $employeeId,
                    'employee_name' => $employeeName,
                    'kind' => 'holiday',
                    'holiday' => true,
                    'days' => $holidayDays,
                    'tasks' => [],
                    'trainings' => [],
                    'message' => "{$employeeName} is on holiday or unavailable on {$dayText}.",
                ]],
            ], 422));
        }

        $conflicts = TrainingOccupiedSlotChecker::conflictsFor(
            $employeeId,
            $startDate,
            $endDate,
            $hoursPerDay,
            $existing?->id,
            $daySegment,
        );

        if ($conflicts !== [] && ! $confirmOverride) {
            $hasTraining = collect($conflicts)->contains(
                static fn (array $conflict): bool => ($conflict['kind'] ?? '') === 'training',
            );

            throw new HttpResponseException(response()->json([
                'message' => $hasTraining
                    ? 'Confirm override to schedule over existing training or planned work. Project hours on those days may be reduced to make room for training; existing courses are kept unless you remove them.'
                    : 'Confirm override to schedule training over existing planned work. Project hours on those days are reduced to make room for training; project tasks are kept.',
                'code' => 'TRAINING_OCCUPIED_SLOT',
                'conflicts' => $conflicts,
            ], 422));
        }

        return $conflicts;
    }

    /**
     * Prefer detected conflicts; keep client-reported conflicts when override was confirmed.
     *
     * @param  list<array<string, mixed>>  $serverConflicts
     * @param  list<array<string, mixed>>  $clientConflicts
     * @return list<array<string, mixed>>
     */
    private function mergeOverrideConflictsForAudit(
        array $serverConflicts,
        array $clientConflicts,
        bool $confirmOverride,
    ): array {
        $server = TrainingActivityLog::normalizeOverrideConflicts($serverConflicts);
        $client = TrainingActivityLog::normalizeOverrideConflicts($clientConflicts);

        if ($server !== []) {
            return $this->enrichConflictsWithClientTaskLabels($server, $client);
        }

        if ($confirmOverride && $client !== []) {
            return $client;
        }

        if ($confirmOverride) {
            return [[
                'tasks' => [],
                'trainings' => [],
                'message' => 'existing planned work',
            ]];
        }

        return [];
    }

    /**
     * Keep server conflict detection, but fill missing task/project labels from the client
     * when histogram bars were available in the UI.
     *
     * @param  list<array<string, mixed>>  $server
     * @param  list<array<string, mixed>>  $client
     * @return list<array<string, mixed>>
     */
    private function enrichConflictsWithClientTaskLabels(array $server, array $client): array
    {
        if ($client === []) {
            return $server;
        }

        $clientTasks = [];
        $clientTrainings = [];
        foreach ($client as $conflict) {
            foreach (($conflict['tasks'] ?? []) as $task) {
                if (! is_array($task)) {
                    continue;
                }
                $name = trim((string) ($task['task_name'] ?? ''));
                $project = trim((string) ($task['project_name'] ?? ''));
                if ($name === '' && $project === '') {
                    continue;
                }
                $key = $project.'|'.$name;
                $clientTasks[$key] = [
                    'task_id' => $task['task_id'] ?? null,
                    'task_name' => $name !== '' ? $name : 'Untitled task',
                    'project_name' => $project,
                ];
            }
            foreach (($conflict['trainings'] ?? []) as $title) {
                $trimmed = trim((string) $title);
                if ($trimmed !== '') {
                    $clientTrainings[$trimmed] = $trimmed;
                }
            }
        }

        if ($clientTasks === [] && $clientTrainings === []) {
            return $server;
        }

        return array_map(static function (array $conflict) use ($clientTasks, $clientTrainings): array {
            $tasks = is_array($conflict['tasks'] ?? null) ? $conflict['tasks'] : [];
            $hasNamedTask = false;
            foreach ($tasks as $task) {
                if (! is_array($task)) {
                    continue;
                }
                if (trim((string) ($task['project_name'] ?? '')) !== ''
                    || trim((string) ($task['task_name'] ?? '')) !== '') {
                    $hasNamedTask = true;
                    break;
                }
            }

            if (! $hasNamedTask && $clientTasks !== []) {
                $conflict['tasks'] = array_values($clientTasks);
            }

            $trainings = is_array($conflict['trainings'] ?? null) ? $conflict['trainings'] : [];
            if ($trainings === [] && $clientTrainings !== []) {
                $conflict['trainings'] = array_values($clientTrainings);
            }

            return $conflict;
        }, $server);
    }

    /**
     * @param  list<array<string, mixed>>  $conflicts
     * @return list<array<string, mixed>>
     */
    private function overriddenTaskMeta(array $conflicts): array
    {
        $tasks = [];
        foreach ($conflicts as $conflict) {
            foreach (($conflict['tasks'] ?? []) as $task) {
                $tasks[] = $task;
            }
        }

        return $tasks;
    }

    /**
     * @param  list<array<string, mixed>>  $conflicts
     * @return list<string>
     */
    private function overriddenTrainingMeta(array $conflicts): array
    {
        $titles = [];
        foreach ($conflicts as $conflict) {
            foreach (($conflict['trainings'] ?? []) as $title) {
                $trimmed = trim((string) $title);
                if ($trimmed !== '' && ! in_array($trimmed, $titles, true)) {
                    $titles[] = $trimmed;
                }
            }
        }

        return $titles;
    }

    private function isDuplicateTrainingConstraint(QueryException $e): bool
    {
        $message = $e->getMessage();

        return str_contains($message, 'employee_trainings_session_unique')
            || str_contains($message, 'employee_trainings_course_operative_unique')
            || (str_contains($message, 'Duplicate entry') && str_contains($message, 'employee_trainings'));
    }

    /**
     * @param  array<string, mixed>  $validated
     * @return array<string, mixed>
     */
    private function applyCourseDefaults(array $validated, ?EmployeeTraining $existing = null): array
    {
        $courseId = $validated['training_course_id'] ?? $existing?->training_course_id;
        if (! $courseId) {
            return $validated;
        }

        $course = TrainingCourse::query()->find($courseId);
        if (! $course) {
            return $validated;
        }

        if (empty($validated['title']) && $existing) {
            $validated['title'] = $existing->title;
        }

        if (empty($validated['title'])) {
            $validated['title'] = $course->title;
        }

        foreach (['course_link', 'description', 'duration', 'priority', 'urgency'] as $field) {
            if (! array_key_exists($field, $validated) || $validated[$field] === null || $validated[$field] === '') {
                if ($existing && $existing->{$field}) {
                    continue;
                }
                $validated[$field] = $course->{$field};
            }
        }

        if (
            (! array_key_exists('hours_per_day', $validated) || $validated['hours_per_day'] === null)
            && ! $existing?->hours_per_day
        ) {
            // Assignment slots default to 2h; do not inherit catalogue "total course hours".
            $validated['hours_per_day'] = 2;
        }

        $validated['training_course_id'] = $course->id;

        return $validated;
    }

    /**
     * Operatives may change status, or reschedule dates/hours from the overdue prompt.
     * They cannot change course details, priority, or urgency.
     *
     * @param  array<string, mixed>  $validated
     * @return array<string, mixed>
     */
    private function restrictOwnTrainingFields(Request $request, array $validated): array
    {
        if ($request->user()?->canPageAction('Trainings', 'assign')) {
            return $validated;
        }

        $allowed = [
            'status',
            'start_date',
            'end_date',
            'day_segment',
            'hours_per_day',
            'confirm_override',
        ];

        return array_intersect_key($validated, array_flip($allowed));
    }

    private function authorizeTrainingWrite(Request $request, int $employeeId): void
    {
        $user = $request->user();
        if (! $user) {
            abort(401);
        }

        if ($user->canPageAction('Trainings', 'assign')) {
            return;
        }

        if ($user->canPageAction('DL Input Hours', 'edit_own_trainings')) {
            $employee = Employee::query()->find($employeeId);
            if ($employee && $this->userMatchesEmployee($user, $employee)) {
                return;
            }
        }

        abort(403, 'You do not have permission to change this training.');
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
}
