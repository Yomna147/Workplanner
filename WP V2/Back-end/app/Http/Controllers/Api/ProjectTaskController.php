<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Part;
use App\Models\ProjectTask;
use App\Services\ActivityLogService;
use App\Services\EmailNotificationService;
use App\Support\DlMirrorFields;
use App\Support\EmployeeNames;
use App\Support\HistogramScheduleOverrides;
use App\Support\PlanActivityLog;
use App\Support\ProjectStatusSync;
use App\Support\ReleaseAssignmentsAfterDone;
use App\Support\TaskSyncConflict;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ProjectTaskController extends Controller
{
    public function __construct(
        private EmailNotificationService $emailNotifications,
    ) {}

    private function taskRules(): array
    {
        return [
            'task_name' => 'nullable|string|max:255',
            'est' => 'nullable|string|max:50',
            'hrs_per' => 'nullable|string|max:50',
            'red' => 'nullable|string|max:50',
            'dl' => 'nullable|string|max:50',
            'rfi' => 'nullable|string|max:50',
            'pd' => 'nullable|string|max:50',
            'buf' => 'nullable|string|max:50',
            'adj' => 'nullable|string|max:50',
            'plan' => 'nullable|string|max:50',
            'doc_supply' => 'nullable|string|max:50',
            'con' => 'nullable|string|max:50',
            'completion' => 'nullable|string|max:50',
            'pp' => 'nullable|string|max:50',
            'rap' => 'nullable|string|max:50',
            'pri' => 'nullable|string|max:50',
            'hbs' => 'nullable|numeric|min:0|max:100',
            'ats' => 'nullable|string|max:50',
            'ots' => 'nullable|string|max:50',
            'dd' => 'nullable|string|max:50',
            'sp' => 'nullable|string|max:50',
            'ts' => 'nullable|string|max:50',
            'sh' => 'nullable|numeric|min:0|max:100',
            'al' => 'nullable|string|max:50',
            'algorithm_1' => 'nullable|string|max:255',
            'algorithm_2' => 'nullable|string|max:255',
            'algorithm_3' => 'nullable|string|max:255',
            'override_1' => 'nullable|string|max:255',
            'override_2' => 'nullable|string|max:255',
            'override_3' => 'nullable|string|max:255',
            'override_share_1' => 'nullable|string|max:50',
            'override_share_2' => 'nullable|string|max:50',
            'override_share_3' => 'nullable|string|max:50',
            'dl_override_1' => 'nullable|string|max:255',
            'dl_override_2' => 'nullable|string|max:255',
            'dl_override_3' => 'nullable|string|max:255',
            'dl_dl' => 'nullable|string|max:50',
            'dl_rfi' => 'nullable|string|max:50',
            'dl_con' => 'nullable|string|max:50',
            'dl_progress_updated' => 'nullable|string|max:50',
            'dl_progress_per' => 'nullable|string|max:50',
            'dl_done' => 'nullable|string|max:50',
            'dl_owner' => 'nullable|string|max:255',
            'dl_project_completion_date' => 'nullable|string|max:50',
            'progress_updated' => 'nullable|string|max:50',
            'progress_per' => 'nullable|string|max:50',
            'progress_left_hours' => 'nullable|string|max:50',
            'progress_plan' => 'nullable|string|max:50',
            'act' => 'nullable|string|max:50',
            'pre' => 'nullable|string|max:50',
            'duration_left' => 'nullable|string|max:50',
            'done' => 'nullable|boolean',
            'owner' => 'nullable|string|max:255',
            'project_completion_date' => 'nullable|string|max:50',
            'sec_hrs_02' => 'nullable|string|max:50',
            'sec_hrs_03' => 'nullable|string|max:50',
            'sec_hrs_04' => 'nullable|string|max:50',
            'sec_hrs_05' => 'nullable|string|max:50',
            'sec_hrs_06' => 'nullable|string|max:50',
            'sec_hrs_07' => 'nullable|string|max:50',
            'sec_hrs_extra' => 'nullable|string|max:50',
            'sec_hrs_total' => 'nullable|string|max:50',
            'dl_sec_hrs_approved' => 'nullable|boolean',
            'dl_sec_hrs_02' => 'nullable|string|max:50',
            'dl_sec_hrs_03' => 'nullable|string|max:50',
            'dl_sec_hrs_04' => 'nullable|string|max:50',
            'dl_sec_hrs_05' => 'nullable|string|max:50',
            'dl_sec_hrs_06' => 'nullable|string|max:50',
        ];
    }

    /**
     * UI / MySQL may send checkbox-like fields as bool/int. Coerce string-validated
     * fields before Laravel's "must be a string" rule rejects the payload.
     *
     * @param  array<string, mixed>  $task
     * @return array<string, mixed>
     */
    private function coerceTaskStringFields(array $task): array
    {
        foreach ($this->taskRules() as $field => $rule) {
            if (! array_key_exists($field, $task)) {
                continue;
            }
            if (! is_string($rule) || ! str_contains($rule, 'string')) {
                continue;
            }

            $value = $task[$field];
            if ($value === null) {
                continue;
            }
            if (is_string($value)) {
                continue;
            }
            if (is_bool($value)) {
                $task[$field] = $value ? '1' : '0';
                continue;
            }
            if (is_int($value) || is_float($value)) {
                $task[$field] = (string) $value;
                continue;
            }
            if (is_scalar($value)) {
                $task[$field] = (string) $value;
            }
        }

        return $task;
    }

    private function validateTaskPayload(Request $request): array
    {
        $request->merge($this->coerceTaskStringFields($request->all()));

        return $request->validate($this->taskRules());
    }

    private function validateSyncPayload(Request $request): array
    {
        $tasks = $request->input('tasks', []);
        if (is_array($tasks)) {
            $request->merge([
                'tasks' => array_map(
                    fn ($row) => is_array($row) ? $this->coerceTaskStringFields($row) : $row,
                    $tasks,
                ),
            ]);
        }

        return $request->validate($this->syncValidationRules());
    }

    private function syncValidationRules(): array
    {
        $rules = [
            'tasks' => 'required|array',
            'tasks.*.id' => 'nullable|integer',
            'tasks.*.updated_at' => 'nullable',
            'algorithm_run' => 'nullable|boolean',
            'source' => 'nullable|string|in:pde,dl',
            'baseline_task_ids' => 'nullable|array',
            'baseline_task_ids.*' => 'integer',
            'baseline_tasks' => 'nullable|array',
            'baseline_tasks.*.id' => 'required|integer',
            'baseline_tasks.*.updated_at' => 'nullable',
            'dirty_task_ids' => 'nullable|array',
            'dirty_task_ids.*' => 'integer',
            'conflict_resolutions' => 'nullable|array',
            'conflict_resolutions.*' => 'in:client,server,ignore',
        ];

        foreach ($this->taskRules() as $field => $rule) {
            $rules["tasks.*.{$field}"] = $rule;
        }

        return $rules;
    }

  private function normalizeTaskForResponse(ProjectTask $task): array
  {
    $data = DlMirrorFields::applyMirrorValuesToPde($task->toArray());
    EmployeeNames::normalizeTaskPayload($data);

    return $data;
  }

    /** @return list<string> */
    private function trackableTaskFields(): array
    {
        return array_keys($this->taskRules());
    }

    private function normalizeComparableValue(mixed $value): string
    {
        if ($value === null) {
            return '';
        }

        if (is_bool($value)) {
            return $value ? '1' : '0';
        }

        return (string) $value;
    }

    /** @param array<string, mixed> $after */
    private function diffTaskChanges(ProjectTask $before, array $after): array
    {
        $changes = [];

        foreach ($this->trackableTaskFields() as $field) {
            $oldValue = $before->getAttribute($field);
            $newValue = $after[$field] ?? null;

            if ($this->normalizeComparableValue($oldValue) !== $this->normalizeComparableValue($newValue)) {
                $changes[$field] = [
                    'from' => $oldValue,
                    'to' => $newValue,
                ];
            }
        }

        return $changes;
    }

    public function index(Part $part): JsonResponse
    {
        $tasks = $part->tasks()
            ->orderBy('id')
            ->get()
            ->map(fn (ProjectTask $task) => $this->normalizeTaskForResponse($task))
            ->values();

        return response()->json([
            'data' => $tasks,
        ]);
    }

    private function applyAutoOwnerToPayload(array $payload, ?string $ownerName, ?ProjectTask $existingTask = null, bool $algorithmRun = false): array
    {
        if (
            ! $algorithmRun
            && DlMirrorFields::payloadUpdatesDlOwner($payload, $existingTask)
        ) {
            $payloadDlOwner = trim((string) ($payload['dl_owner'] ?? ''));
            $payloadOwner = trim((string) ($payload['owner'] ?? ''));
            $payload['owner'] = $payloadOwner !== '' ? $payloadOwner : $payloadDlOwner;

            return $payload;
        }

        if ($existingTask instanceof ProjectTask && DlMirrorFields::isOwnerLockedByDl($existingTask)) {
            $dlOwner = trim((string) ($existingTask->dl_owner ?? ''));
            $payload['owner'] = $dlOwner !== '' ? $dlOwner : $existingTask->owner;

            return $payload;
        }

        if ($algorithmRun || ! $ownerName) {
            return $payload;
        }

        if (DlMirrorFields::shouldPreserveOwner($existingTask ?? $payload)) {
            return $payload;
        }

        $payloadOwner = trim((string) ($payload['owner'] ?? ''));
        if ($payloadOwner !== '') {
            return $payload;
        }

        $payload['owner'] = $ownerName;

        return $payload;
    }

    public function store(Request $request, Part $part): JsonResponse
    {
        $validated = $this->validateTaskPayload($request);
        EmployeeNames::normalizeTaskPayload($validated);

        $validated = $this->applyAutoOwnerToPayload(
            $validated,
            $request->user()?->name,
            null,
            $request->boolean('algorithm_run'),
        );

        $task = $part->tasks()->create($validated);

        return response()->json(['data' => $this->normalizeTaskForResponse($task)], 201);
    }

    public function update(Request $request, ProjectTask $projectTask): JsonResponse
    {
        $validated = $this->validateTaskPayload($request);
        EmployeeNames::normalizeTaskPayload($validated);
        $algorithmRun = $request->boolean('algorithm_run');

        $validated = $this->applyAutoOwnerToPayload(
            $validated,
            $request->user()?->name,
            $projectTask,
            $algorithmRun,
        );

        $projectTask->update($validated);
        if (! $algorithmRun) {
            HistogramScheduleOverrides::clearForTaskIds([(int) $projectTask->id]);
        }
        $fresh = $projectTask->fresh();
        if ($fresh && $fresh->done) {
            ReleaseAssignmentsAfterDone::apply($request, [$fresh->id]);
        }

        return response()->json(['data' => $this->normalizeTaskForResponse($fresh)]);
    }

    public function destroy(ProjectTask $projectTask): JsonResponse
    {
        $taskId = (int) $projectTask->id;
        $project = $projectTask->part?->project;
        $projectTask->delete();
        HistogramScheduleOverrides::clearForTaskIds([$taskId]);
        ProjectStatusSync::syncFromTasks($project);

        return response()->json(['message' => 'Task deleted']);
    }

    public function sync(Request $request, Part $part): JsonResponse
    {
        $validated = $this->validateSyncPayload($request);
        $algorithmRun = $request->boolean('algorithm_run');
        $ownerName = $request->user()?->name;
        $part->load('project');

        $baselineTasks = $validated['baseline_tasks'] ?? [];
        if ($baselineTasks === [] && ! empty($validated['baseline_task_ids'])) {
            $baselineTasks = array_map(
                fn ($id) => ['id' => (int) $id],
                $validated['baseline_task_ids'],
            );
        }

        $hasBaseline = $request->exists('baseline_tasks') || $request->exists('baseline_task_ids');
        $hasDirtyList = $request->exists('dirty_task_ids');
        $dirtyTaskIds = $validated['dirty_task_ids'] ?? [];
        $resolutions = $validated['conflict_resolutions'] ?? [];

        $logChanges = [
            'created' => [],
            'updated' => [],
            'deleted' => [],
        ];
        $previousById = [];
        $conflictPlan = null;
        $syncMeta = [
            'preserved_count' => 0,
            'skipped_stale_count' => 0,
        ];

        $pinClearIds = [];
        $tasks = DB::transaction(function () use (
            $part,
            $validated,
            $algorithmRun,
            $ownerName,
            $baselineTasks,
            $hasBaseline,
            $hasDirtyList,
            $dirtyTaskIds,
            $resolutions,
            &$logChanges,
            &$previousById,
            &$conflictPlan,
            &$syncMeta,
            &$pinClearIds,
        ) {
            $existingTasks = $part->tasks()
                ->lockForUpdate()
                ->get()
                ->keyBy(fn (ProjectTask $task) => (int) $task->id);

            $plan = TaskSyncConflict::plan(
                $existingTasks,
                $validated['tasks'],
                $baselineTasks,
                $dirtyTaskIds,
                $resolutions,
                $hasBaseline,
                $hasDirtyList,
                $this->trackableTaskFields(),
                fn (mixed $value) => $this->normalizeComparableValue($value),
                fn (ProjectTask $task) => $this->normalizeTaskForResponse($task),
            );

            if ($plan['overlaps'] !== []) {
                $conflictPlan = $plan;

                return [];
            }

            $syncMeta['preserved_count'] = count($plan['preserved']);
            $syncMeta['skipped_stale_count'] = (int) $plan['skipped_stale'];

            $saved = [];

            if ($plan['delete_ids'] !== []) {
                $deletedTasks = $existingTasks
                    ->filter(fn (ProjectTask $task) => in_array((int) $task->id, $plan['delete_ids'], true))
                    ->values();

                $part->tasks()->whereIn('id', $plan['delete_ids'])->delete();

                foreach ($deletedTasks as $deletedTask) {
                    $logChanges['deleted'][] = [
                        'id' => $deletedTask->id,
                        'task_name' => $deletedTask->task_name,
                    ];
                    if (! $algorithmRun) {
                        $pinClearIds[] = (int) $deletedTask->id;
                    }
                }
            }

            $rowsToWrite = [
                ...array_map(
                    fn (array $row) => ['row' => $row, 'restore' => false],
                    $plan['update_rows'],
                ),
                ...array_map(
                    fn (array $row) => ['row' => $row, 'restore' => true],
                    $plan['restore_rows'],
                ),
                ...array_map(
                    fn (array $row) => ['row' => $row, 'restore' => false],
                    $plan['create_rows'],
                ),
            ];

            foreach ($rowsToWrite as $item) {
                $row = $item['row'];
                $payload = TaskSyncConflict::payloadWithoutMeta($row);
                EmployeeNames::normalizeTaskPayload($payload);

                $existingTask = ! empty($row['id']) ? $existingTasks->get((int) $row['id']) : null;

                $payload = $this->applyAutoOwnerToPayload(
                    $payload,
                    $ownerName,
                    $existingTask instanceof ProjectTask ? $existingTask : null,
                    $algorithmRun,
                );

                if ($item['restore'] && ! empty($row['id'])) {
                    $created = $this->restoreTaskWithId($part, (int) $row['id'], $payload);
                    $existingTasks->put($created->id, $created);
                    $logChanges['created'][] = [
                        'id' => $created->id,
                        'task_name' => $created->task_name,
                    ];
                    if (! $algorithmRun) {
                        $pinClearIds[] = (int) $created->id;
                    }
                    $saved[] = $created;
                    continue;
                }

                if (! empty($row['id']) && $existingTask instanceof ProjectTask) {
                    $fieldChanges = $this->diffTaskChanges($existingTask, $payload);
                    if ($fieldChanges !== []) {
                        $previousById[(int) $existingTask->id] = [
                            'progress_per' => $existingTask->progress_per,
                            'plan' => $existingTask->plan,
                            'act' => $existingTask->act,
                            'completion' => $existingTask->completion,
                            'done' => (bool) $existingTask->done,
                            'dl' => $existingTask->dl,
                            'dl_dl' => $existingTask->dl_dl,
                            'rfi' => $existingTask->rfi,
                            'dl_rfi' => $existingTask->dl_rfi,
                            'override_1' => $existingTask->override_1,
                            'override_2' => $existingTask->override_2,
                            'override_3' => $existingTask->override_3,
                            'dl_override_1' => $existingTask->dl_override_1,
                            'dl_override_2' => $existingTask->dl_override_2,
                            'dl_override_3' => $existingTask->dl_override_3,
                            'dl_owner' => $existingTask->dl_owner,
                        ];
                        $logChanges['updated'][] = [
                            'id' => $existingTask->id,
                            'task_name' => $payload['task_name'] ?? $existingTask->task_name,
                            'changes' => $fieldChanges,
                        ];
                    }

                    $existingTask->update($payload);
                    if (! $algorithmRun) {
                        $pinClearIds[] = (int) $existingTask->id;
                    }
                    $saved[] = $existingTask->fresh();
                    continue;
                }

                $created = $part->tasks()->create($payload);
                $existingTasks->put($created->id, $created);
                $logChanges['created'][] = [
                    'id' => $created->id,
                    'task_name' => $created->task_name,
                ];
                $saved[] = $created;
            }

            return $saved;
        });

        if (! $algorithmRun) {
            HistogramScheduleOverrides::clearForTaskIds($pinClearIds);
        }

        if (is_array($conflictPlan) && $conflictPlan['overlaps'] !== []) {
            return response()->json([
                'message' => 'This part was saved by someone else. Choose which overlapping tasks to keep.',
                'code' => TaskSyncConflict::CODE,
                'conflict' => [
                    'preserved' => $conflictPlan['preserved'],
                    'overlaps' => $conflictPlan['overlaps'],
                    'skipped_stale_count' => $conflictPlan['skipped_stale'],
                ],
            ], 409);
        }

        $hasChanges = $logChanges['created'] !== []
            || $logChanges['updated'] !== []
            || $logChanges['deleted'] !== [];

        if ($hasChanges) {
            $createdCount = count($logChanges['created']);
            $updatedCount = count($logChanges['updated']);
            $deletedCount = count($logChanges['deleted']);
            $summaryParts = [];

            if ($createdCount > 0) {
                $summaryParts[] = "{$createdCount} created";
            }
            if ($updatedCount > 0) {
                $summaryParts[] = "{$updatedCount} updated";
            }
            if ($deletedCount > 0) {
                $summaryParts[] = "{$deletedCount} deleted";
            }

            $user = $request->user();
            $user?->loadMissing('role');
            $roleName = trim((string) ($user?->role?->name ?? ''));
            $source = strtolower(trim((string) ($validated['source'] ?? '')));
            $isDlSource = $source === 'dl';
            $area = $isDlSource ? 'dl' : 'pde';
            $action = $algorithmRun ? 'algorithm_run' : 'tasks_sync';
            $taskIds = $isDlSource
                ? PlanActivityLog::dlEditedTaskIdsFromChanges($logChanges)
                : PlanActivityLog::taskIdsFromChanges($logChanges);

            ActivityLogService::log(
                $request,
                $area,
                $action,
                sprintf(
                    '%s / %s: %s',
                    $part->project?->name ?? 'Project',
                    $part->name,
                    implode(', ', $summaryParts),
                ),
                Part::class,
                $part->id,
                $logChanges,
                [
                    'project_id' => $part->project_id,
                    'project_name' => $part->project?->name,
                    'part_id' => $part->id,
                    'part_name' => $part->name,
                    'source' => $isDlSource ? 'dl' : ($source !== '' ? $source : 'pde'),
                    'user_role' => $roleName !== '' ? $roleName : null,
                    'is_dl_user' => strcasecmp($roleName, 'DLs') === 0,
                    'task_ids' => $taskIds,
                ],
            );
        }

        $savedModels = collect($tasks);

        $tasks = $part->tasks()
            ->orderBy('id')
            ->get()
            ->map(fn (ProjectTask $task) => $this->normalizeTaskForResponse($task))
            ->values()
            ->all();

        $notificationResult = [
            'in_app' => [],
            'emails_sent' => 0,
            'triggered_rules' => [],
            'email_errors' => [],
        ];
        if (! $algorithmRun && $hasChanges) {
            $changedIds = collect($logChanges['created'])
                ->merge($logChanges['updated'])
                ->pluck('id')
                ->map(fn ($id) => (int) $id)
                ->filter(fn (int $id) => $id > 0)
                ->unique()
                ->values()
                ->all();

            $notificationTasks = $savedModels
                ->filter(fn (ProjectTask $task) => in_array((int) $task->id, $changedIds, true))
                ->values()
                ->all();

            $notificationResult = $this->emailNotifications->handleTasksSaved(
                $part,
                $notificationTasks,
                $previousById,
                $request->user(),
            );
        }

        if ($part->project) {
            ProjectStatusSync::syncFromTasks($part->project->fresh());
        }

        $doneIds = $savedModels
            ->filter(fn (ProjectTask $task) => (bool) $task->done)
            ->pluck('id')
            ->all();
        if ($doneIds !== []) {
            ReleaseAssignmentsAfterDone::apply($request, $doneIds);
        }

        return response()->json([
            'data' => $tasks,
            'notifications' => $notificationResult,
            'sync' => $syncMeta,
        ]);
    }

    private function restoreTaskWithId(Part $part, int $id, array $payload): ProjectTask
    {
        $task = new ProjectTask();
        $task->setIncrementing(false);
        $task->id = $id;
        $task->part_id = $part->id;
        $task->fill($payload);
        $task->save();

        return $task->fresh() ?? $task;
    }
}
