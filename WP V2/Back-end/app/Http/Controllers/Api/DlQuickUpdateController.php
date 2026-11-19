<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\DlUpdateSubmission;
use App\Models\Project;
use App\Models\ProjectTask;
use App\Services\ActivityLogService;
use App\Support\DlMirrorFields;
use App\Support\DlQuickUpdate;
use App\Support\EmployeeNames;
use App\Support\HistogramScheduleOverrides;
use App\Support\PageAccess;
use App\Support\PlanActivityLog;
use App\Support\ProjectStatusSync;
use App\Support\ReleaseAssignmentsAfterDone;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class DlQuickUpdateController extends Controller
{
    /** @var list<string> */
    private const EDITABLE_FIELDS = [
        'rfi',
        'dl',
        'plan',
        'override_1',
        'override_2',
        'override_3',
        'override_share_1',
        'override_share_2',
        'override_share_3',
        'progress_per',
        'progress_left_hours',
        'progress_updated',
        'done',
        'project_completion_date',
        'owner',
        'dl_dl',
        'dl_rfi',
        'dl_override_1',
        'dl_override_2',
        'dl_override_3',
        'dl_progress_per',
        'dl_progress_updated',
        'dl_done',
        'dl_owner',
        'dl_project_completion_date',
        'dl_sec_hrs_02',
        'dl_sec_hrs_03',
        'dl_sec_hrs_04',
        'dl_sec_hrs_05',
        'dl_sec_hrs_06',
    ];

    public function index(Request $request): JsonResponse
    {
        $this->assertCanView($request);

        $employees = DlQuickUpdate::loadEmployees();
        EmployeeNames::warmEmployeeCache($employees);

        try {
            $tasks = DlQuickUpdate::loadActiveTasks();
            $dlUsers = DlQuickUpdate::loadDlUsers();
            $teamOapNumbers = DlQuickUpdate::teamOapNrmNumbers($employees);
            $nrmTeamIds = DlQuickUpdate::nrmToTeamIds($employees);
            $dlProfiles = DlQuickUpdate::mergeOwnerProfiles(
                $tasks,
                DlQuickUpdate::resolveDlProfiles($employees, $dlUsers),
            );
            $submissions = DlQuickUpdate::latestSubmissionsByDlProject();
            $window = DlQuickUpdate::threeWeekRange();
            $weekStart = $window['week_start'];
            $viewer = $this->viewerContext($request, $employees);
            $oapNumbers = [];
            $sectionKeys = [];
            $singleGroup = null;

            if (! $viewer['can_view_all']) {
                $singleGroup = [
                    'dl_name' => $viewer['dl_name'],
                    'employee_id' => $viewer['employee_id'] ?? null,
                    'team_id' => $viewer['team_id'],
                    'team_name' => $viewer['team_name'],
                    'user_id' => $request->user()?->id,
                ];
                $oapNumbers = $viewer['team_id']
                    ? ($teamOapNumbers[$viewer['team_id']] ?? [])
                    : [];
                if ($oapNumbers === []) {
                    $sectionKeys = $viewer['nrm_section_keys'] ?? [];
                }
            }

            $groups = DlQuickUpdate::buildGroupedPayload(
                $tasks,
                $dlProfiles,
                $teamOapNumbers,
                $nrmTeamIds,
                $submissions,
                $employees,
                $weekStart,
                $window['range_start'],
                $window['range_end'],
                $sectionKeys,
                $oapNumbers,
                $singleGroup,
            );

            return response()->json([
                'data' => [
                    'dls' => $groups,
                    'employees' => DlQuickUpdate::employeeOptions($employees),
                    'teams' => DlQuickUpdate::teamOptions($employees, $teamOapNumbers),
                    'week_start' => $weekStart->toDateString(),
                    'range_start' => $window['range_start']->toDateString(),
                    'range_end' => $window['range_end']->toDateString(),
                    'viewer' => $viewer,
                ],
            ]);
        } finally {
            EmployeeNames::clearEmployeeCache();
        }
    }

    public function updateTasks(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['DL Input Hours', 'edit']]);

        $validated = $request->validate([
            'tasks' => 'required|array|min:1',
            'tasks.*.id' => 'required|integer|exists:project_tasks,id',
            'tasks.*.rfi' => 'nullable',
            'tasks.*.dl' => 'nullable|string|max:50',
            'tasks.*.plan' => 'nullable|string|max:50',
            'tasks.*.override_1' => 'nullable|string|max:255',
            'tasks.*.override_2' => 'nullable|string|max:255',
            'tasks.*.override_3' => 'nullable|string|max:255',
            'tasks.*.override_share_1' => 'nullable|string|max:50',
            'tasks.*.override_share_2' => 'nullable|string|max:50',
            'tasks.*.override_share_3' => 'nullable|string|max:50',
            'tasks.*.progress_per' => 'nullable|string|max:50',
            'tasks.*.progress_left_hours' => 'nullable|string|max:50',
            'tasks.*.progress_updated' => 'nullable|string|max:50',
            'tasks.*.done' => 'nullable',
            'tasks.*.project_completion_date' => 'nullable|string|max:50',
            'tasks.*.owner' => 'nullable|string|max:255',
            'tasks.*.dl_sec_hrs_02' => 'nullable|string|max:50',
            'tasks.*.dl_sec_hrs_03' => 'nullable|string|max:50',
            'tasks.*.dl_sec_hrs_04' => 'nullable|string|max:50',
            'tasks.*.dl_sec_hrs_05' => 'nullable|string|max:50',
            'tasks.*.dl_sec_hrs_06' => 'nullable|string|max:50',
        ]);

        $ownerName = $this->ownerNameForUser($request);
        $ids = array_map(fn ($row) => (int) $row['id'], $validated['tasks']);
        $rowsById = [];
        foreach ($validated['tasks'] as $row) {
            $rowsById[(int) $row['id']] = $row;
        }

        $tasks = ProjectTask::query()
            ->with('part.project')
            ->whereIn('id', $ids)
            ->get()
            ->keyBy('id');

        $logByPart = [];
        $pinClearIds = [];

        DB::transaction(function () use ($tasks, $rowsById, $ownerName, &$logByPart, &$pinClearIds) {
            foreach ($rowsById as $id => $row) {
                $task = $tasks->get($id);
                if (! $task) {
                    continue;
                }

                $payload = [];
                foreach (self::EDITABLE_FIELDS as $field) {
                    if (array_key_exists($field, $row)) {
                        $payload[$field] = $row[$field];
                    }
                }

                if (array_key_exists('rfi', $payload)) {
                    $payload['rfi'] = DlMirrorFields::isTruthy($payload['rfi']) ? '1' : '0';
                }
                if (array_key_exists('done', $payload)) {
                    $payload['done'] = DlMirrorFields::isTruthy($payload['done']);
                }

                if ($ownerName !== '' && ! array_key_exists('owner', $payload)) {
                    $payload['owner'] = $ownerName;
                    $payload['dl_owner'] = $ownerName;
                }

                $payload = DlMirrorFields::stampMirrorsForChangedFields($payload, array_keys($payload));
                EmployeeNames::normalizeTaskPayload($payload);

                $changes = $this->diffTask($task, $payload);
                if ($changes === []) {
                    continue;
                }

                $task->update($payload);
                $pinClearIds[] = (int) $task->id;
                $part = $task->part;
                $partId = (int) ($part?->id ?? 0);
                if ($partId <= 0) {
                    continue;
                }

                if (! isset($logByPart[$partId])) {
                    $logByPart[$partId] = [
                        'part' => $part,
                        'updated' => [],
                    ];
                }
                $logByPart[$partId]['updated'][] = [
                    'id' => $task->id,
                    'task_name' => $task->task_name,
                    'changes' => $changes,
                ];
            }
        });

        HistogramScheduleOverrides::clearForTaskIds($pinClearIds);

        foreach ($logByPart as $entry) {
            $part = $entry['part'];
            $updated = $entry['updated'];
            if ($updated === []) {
                continue;
            }

            $logChanges = [
                'created' => [],
                'updated' => $updated,
                'deleted' => [],
            ];

            ActivityLogService::log(
                $request,
                'dl',
                'tasks_sync',
                sprintf(
                    '%s / %s: %d updated (DL Quick Update)',
                    $part->project?->name ?? 'Project',
                    $part->name ?? 'Part',
                    count($updated),
                ),
                $part ? $part::class : null,
                $part?->id,
                $logChanges,
                [
                    'project_id' => $part?->project_id,
                    'project_name' => $part?->project?->name,
                    'part_id' => $part?->id,
                    'part_name' => $part?->name,
                    'source' => 'dl',
                    'quick_update' => true,
                    'task_ids' => PlanActivityLog::dlEditedTaskIdsFromChanges($logChanges),
                ],
            );

            if ($part?->project) {
                ProjectStatusSync::syncFromTasks($part->project->fresh());
            }
        }

        $fresh = ProjectTask::query()
            ->whereIn('id', $ids)
            ->get();

        $doneIds = $fresh
            ->filter(fn (ProjectTask $task) => (bool) $task->done)
            ->pluck('id')
            ->all();
        if ($doneIds !== []) {
            ReleaseAssignmentsAfterDone::apply($request, $doneIds);
        }

        return response()->json([
            'data' => $fresh
                ->map(fn (ProjectTask $task) => DlMirrorFields::applyMirrorValuesToPde($task->toArray()))
                ->values(),
            'updated_count' => array_sum(array_map(fn ($entry) => count($entry['updated']), $logByPart)),
        ]);
    }

    public function submit(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['DL Input Hours', 'edit']]);

        $validated = $request->validate([
            'dl_name' => 'nullable|string|max:255',
            'project_id' => 'required|integer|exists:projects,id',
            'note' => 'nullable|string|max:500',
            'task_count' => 'nullable|integer|min:0',
        ]);

        $viewer = $this->viewerContext($request, DlQuickUpdate::loadEmployees());
        $dlName = trim((string) ($validated['dl_name'] ?? ''));
        if ($dlName === '') {
            $dlName = (string) ($viewer['dl_name'] ?? $request->user()?->name ?? 'DL');
        }

        if (! $viewer['can_view_all'] && ! EmployeeNames::namesMatch($dlName, (string) $viewer['dl_name'])) {
            abort(403, 'You can only submit updates for your own DL list.');
        }

        $project = Project::query()->findOrFail($validated['project_id']);
        $taskCount = (int) ($validated['task_count'] ?? $project->tasks()->count());

        $submission = DlUpdateSubmission::create([
            'user_id' => $request->user()?->id,
            'dl_name' => $dlName,
            'project_id' => $project->id,
            'submitted_at' => now(),
            'task_count' => $taskCount,
            'note' => $validated['note'] ?? null,
            'meta' => [
                'source' => 'dl_quick_update',
            ],
        ]);

        ActivityLogService::log(
            $request,
            'dl',
            'quick_update_submit',
            sprintf('%s submitted DL Quick Update for %s', $dlName, $project->name),
            Project::class,
            $project->id,
            null,
            [
                'project_id' => $project->id,
                'project_name' => $project->name,
                'dl_name' => $dlName,
                'source' => 'dl',
            ],
        );

        return response()->json([
            'data' => [
                'id' => $submission->id,
                'dl_name' => $submission->dl_name,
                'project_id' => $submission->project_id,
                'submitted_at' => optional($submission->submitted_at)?->toIso8601String(),
                'task_count' => $submission->task_count,
                'update_status' => DlQuickUpdate::STATUS_SUBMITTED,
            ],
        ], 201);
    }

    private function assertCanView(Request $request): void
    {
        $user = $request->user();
        if (! $user) {
            abort(401);
        }

        if ($user->is_admin
            || $user->canViewPage('Dashboard')
            || $user->canViewPage('DL Input Hours')
            || $user->canViewPage('Resource Histogram')
        ) {
            return;
        }

        abort(403, 'You do not have permission to view DL Quick Update.');
    }

    /**
     * @return array{dl_name: string, employee_id: int|null, is_dl: bool, can_edit: bool, can_view_all: bool, scope: string, team_id: int|null, team_name: string, nrm_section_keys: list<string>}
     */
    private function viewerContext(Request $request, $employees): array
    {
        $user = $request->user();
        $user?->loadMissing('role');
        $isDl = strcasecmp(trim((string) ($user?->role?->name ?? '')), 'DLs') === 0;
        $canEdit = $user?->is_admin || $user?->canPageAction('DL Input Hours', 'edit');
        $canViewAll = (bool) $user?->is_admin;

        EmployeeNames::warmEmployeeCache($employees);
        $dlName = trim((string) ($user?->name ?? ''));
        $matched = null;
        foreach ([
            $user?->name,
            trim(trim((string) ($user?->first_name ?? '')).' '.trim((string) ($user?->last_name ?? ''))),
            $user?->first_name,
            $user?->login_name,
        ] as $label) {
            $match = EmployeeNames::findByAnyName($label);
            if ($match) {
                $matched = $match;
                $matched->loadMissing('team');
                $dlName = EmployeeNames::displayName($match);
                break;
            }
        }

        $teamName = $matched?->team?->name ?? '';
        $teamId = $matched?->team_id ? (int) $matched->team_id : null;

        return [
            'dl_name' => $dlName,
            'employee_id' => $matched?->id,
            'is_dl' => $isDl,
            'can_edit' => (bool) $canEdit,
            'can_view_all' => (bool) $canViewAll,
            'scope' => $canViewAll ? 'all' : 'team',
            'team_id' => $teamId,
            'team_name' => $teamName,
            'nrm_section_keys' => DlQuickUpdate::nrmSectionKeysFromTeamName($teamName),
        ];
    }

    private function ownerNameForUser(Request $request): string
    {
        $employees = DlQuickUpdate::loadEmployees();
        $context = $this->viewerContext($request, $employees);

        return trim((string) ($context['dl_name'] ?? ''));
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, array{from: mixed, to: mixed}>
     */
    private function diffTask(ProjectTask $task, array $payload): array
    {
        $changes = [];
        foreach ($payload as $field => $value) {
            $old = $task->getAttribute($field);
            $oldNorm = $this->normalizeComparable($old);
            $newNorm = $this->normalizeComparable($value);
            if ($oldNorm !== $newNorm) {
                $changes[$field] = [
                    'from' => $old,
                    'to' => $value,
                ];
            }
        }

        return $changes;
    }

    private function normalizeComparable(mixed $value): string
    {
        if ($value === null) {
            return '';
        }
        if (is_bool($value)) {
            return $value ? '1' : '0';
        }

        return trim((string) $value);
    }
}
