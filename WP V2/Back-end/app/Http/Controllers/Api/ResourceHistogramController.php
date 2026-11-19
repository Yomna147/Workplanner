<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Employee;
use App\Models\EmployeeAvailability;
use App\Models\Nrm;
use App\Models\Part;
use App\Models\Project;
use App\Models\ProjectTask;
use App\Models\Team;
use App\Services\ActivityLogService;
use App\Support\AlgorithmCache;
use App\Support\ApplyHistogramBarEdits;
use App\Support\HistogramActivityLog;
use App\Support\HistogramScheduleOverrides;
use App\Support\EmployeeOrder;
use App\Support\DlLogScope;
use App\Support\EmployeeNames;
use App\Support\EmployeeTrainee;
use App\Support\HistogramFromAssignments;
use App\Support\OrphanProjectData;
use App\Support\PlanActivityLog;
use App\Support\ReleaseAssignmentsAfterDone;
use App\Support\TrainingProjectHourDisplacement;
use App\Support\TeamOrder;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

class ResourceHistogramController extends Controller
{
    private const META_CACHE_TTL_SECONDS = 300;

    private const EMPLOYEES_CACHE_KEY = 'resource_histogram_employees_v4';

    private const TEAMS_CACHE_KEY = 'resource_histogram_teams_v2';

    private const NRMS_CACHE_KEY = 'resource_histogram_nrms_v2';

    private const FULL_PAYLOAD_CACHE_PREFIX = 'resource_histogram_full_v12';

    private const FULL_PAYLOAD_CACHE_TTL_SECONDS = 600;

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'project_id' => 'nullable|integer|exists:projects,id',
            'part_id' => 'nullable|integer|exists:parts,id',
            'start' => 'nullable|date',
            'end' => 'nullable|date',
        ]);

        if (! empty($validated['start']) && ! empty($validated['end'])
            && $validated['end'] < $validated['start']) {
            return response()->json([
                'message' => 'End date must be on or after start date.',
            ], 422);
        }

        OrphanProjectData::purge($request);
        ReleaseAssignmentsAfterDone::apply($request);
        TrainingProjectHourDisplacement::repairOverbookedOverrides($request);

        $isFullLoad = empty($validated['start']) && empty($validated['end']);
        $fullPayloadCacheKey = self::fullPayloadCacheKey($request);
        if ($isFullLoad) {
            $cached = Cache::get($fullPayloadCacheKey);
            if ($this->canServeCachedFullPayload($cached, $request)) {
                return response()->json(['data' => $this->applyLiveProjectColors($cached)]);
            }
        }

        $employees = Cache::remember(
            self::EMPLOYEES_CACHE_KEY,
            self::META_CACHE_TTL_SECONDS,
            fn () => $this->jsonList($this->loadHistogramEmployees()),
        );
        $employees = $this->jsonList($employees);
        if ($employees === []) {
            Cache::forget(self::EMPLOYEES_CACHE_KEY);
            $employees = $this->jsonList($this->loadHistogramEmployees());
        }

        $teams = Cache::remember(
            self::TEAMS_CACHE_KEY,
            self::META_CACHE_TTL_SECONDS,
            fn () => $this->jsonList(
                Team::query()
                    ->orderBy('name')
                    ->get(['id', 'name'])
                    ->sort(fn (Team $a, Team $b) => TeamOrder::compare($a->name, $b->name))
                    ->values(),
            ),
        );
        $teams = $this->jsonList($teams);

        $nrms = $this->loadCachedNrms();

        $filterStart = ! empty($validated['start'])
            ? Carbon::parse($validated['start'])->startOfDay()
            : null;
        $filterEnd = ! empty($validated['end'])
            ? Carbon::parse($validated['end'])->startOfDay()
            : null;

        $cachedData = AlgorithmCache::get($request);
        $assignmentDetails = is_array($cachedData['assignmentDetails'] ?? null)
            ? $cachedData['assignmentDetails']
            : [];
        $algorithmCacheMissing = $assignmentDetails === [];

        $taskIdsFromCache = collect($assignmentDetails)
            ->pluck('task_id')
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        $tasksById = collect();
        if ($taskIdsFromCache !== []) {
            $existingTaskIds = ProjectTask::query()
                ->whereIn('id', $taskIdsFromCache)
                ->whereHas('part.project')
                ->pluck('id')
                ->map(fn ($id) => (int) $id)
                ->all();

            $missingTaskIds = array_values(array_diff($taskIdsFromCache, $existingTaskIds));
            if ($missingTaskIds !== []) {
                AlgorithmCache::forgetAssignmentsForTaskIds($missingTaskIds, $request);
                $assignmentDetails = array_values(array_filter(
                    $assignmentDetails,
                    fn ($detail) => ! in_array((int) ($detail['task_id'] ?? 0), $missingTaskIds, true),
                ));
                $taskIdsFromCache = $existingTaskIds;
                $algorithmCacheMissing = $assignmentDetails === [];
            }

            if ($taskIdsFromCache !== []) {
                $tasksQuery = ProjectTask::query()
                    ->select([
                        'id',
                        'part_id',
                        'task_name',
                        'doc_supply',
                        'completion',
                        'plan',
                        'est',
                        'progress_per',
                        'done',
                        'act',
                        'duration_left',
                        'con',
                        'ats',
                        'sp',
                        'pp',
                        'pri',
                        'algorithm_1',
                        'algorithm_2',
                        'algorithm_3',
                        'override_1',
                        'override_2',
                        'override_3',
                    ])
                    ->with([
                        'part:id,project_id,name',
                        'part.project:id,name,color,team_id,status',
                        'part.project.team:id,name',
                    ])
                    ->whereIn('id', $taskIdsFromCache)
                    ->whereHas('part.project');

                if (! empty($validated['part_id'])) {
                    $tasksQuery->where('part_id', $validated['part_id']);
                } elseif (! empty($validated['project_id'])) {
                    $tasksQuery->whereHas('part', fn ($query) => $query->where('project_id', $validated['project_id']));
                }

                // Do not filter tasks by doc_supply/completion here. Assignment
                // hours may land in the view even when PDE dates are outside it;
                // bars are clipped later via filterBarsByDateRange (hours-based).

                $tasksById = $tasksQuery->orderBy('id')->get()->keyBy('id');
            }
        }

        if ($algorithmCacheMissing || $assignmentDetails === []) {
            $bars = [];
        } else {
            EmployeeNames::warmEmployeeCache();
            try {
                $bars = $this->buildHistogramBars($assignmentDetails, $tasksById, $nrms);
            } finally {
                EmployeeNames::clearEmployeeCache();
            }
        }

        if ($filterStart && $filterEnd) {
            $bars = $this->filterBarsByDateRange($bars, $filterStart, $filterEnd);
            $rangeStart = $filterStart->toDateString();
            $rangeEnd = $filterEnd->toDateString();
        } else {
            [$rangeStart, $rangeEnd] = $this->resolveHistogramEnvelopeRange($bars);
        }

        $rangeStartCarbon = Carbon::parse($rangeStart);
        $rangeEndCarbon = Carbon::parse($rangeEnd);
        [$availabilityHours, $employeeHolidays] = $this->buildAvailabilityData(
            $rangeStartCarbon,
            $rangeEndCarbon,
        );

        $assignedProjectIds = collect($bars)
            ->pluck('project_id')
            ->filter()
            ->unique()
            ->values()
            ->all();

        $projectsQuery = Project::query()
            ->withCount([
                'tasks as tasks_count',
                'tasks as open_tasks_count' => function ($taskQuery) {
                    $taskQuery->where(function ($query) {
                        $query->where('done', false)->orWhereNull('done');
                    });
                },
            ])
            ->orderByDesc('created_at')
            ->orderBy('name');

        if ($assignedProjectIds !== []) {
            $projectsQuery->whereIn('id', $assignedProjectIds);
        } else {
            $projectsQuery->whereRaw('1 = 0');
        }

        $projects = $projectsQuery
            ->get(['id', 'name', 'color', 'status', 'have_all_docs', 'created_at'])
            ->values();

        $data = $this->applyLiveProjectColors([
            'range' => [
                'start' => $rangeStart,
                'end' => $rangeEnd,
            ],
            'employees' => $employees,
            'teams' => $teams,
            'bars' => $this->jsonList($bars),
            'availability_hours' => $availabilityHours,
            'employee_holidays' => $employeeHolidays,
            'projects' => $this->jsonList($projects),
            'algorithm_cache_missing' => $algorithmCacheMissing,
        ]);

        $shouldCacheFullPayload = $isFullLoad
            && $data['employees'] !== []
            && ($data['bars'] !== [] || $assignmentDetails === []);
        if ($shouldCacheFullPayload) {
            Cache::put(
                $fullPayloadCacheKey,
                $data,
                now()->addSeconds(self::FULL_PAYLOAD_CACHE_TTL_SECONDS),
            );
        }

        return response()->json([
            'data' => $data,
        ]);
    }

    public function saveBarEdits(Request $request): JsonResponse
    {
        if (! $this->userCanEditHistogramBars($request->user())) {
            return response()->json([
                'message' => 'You do not have permission to edit histogram task bars.',
            ], 403);
        }

        $validated = $request->validate([
            'edits' => 'required|array|min:1|max:500',
            'edits.*.bar_id' => 'required|string|max:255',
            'edits.*.task_id' => 'required|integer|min:1|exists:project_tasks,id',
            'edits.*.employee' => 'required|string|max:255',
            'edits.*.previous_employee' => 'nullable|string|max:255',
            'edits.*.task_name' => 'nullable|string|max:255',
            'edits.*.project_name' => 'nullable|string|max:255',
            'edits.*.previous_hours_by_day' => 'nullable|array',
            'edits.*.previous_hours_by_day.*' => 'numeric|min:0|max:24',
            'edits.*.hours_by_day' => 'required|array',
            'edits.*.hours_by_day.*' => 'numeric|min:0|max:24',
        ]);

        $lock = Cache::lock('algorithm-cache-write', 30);
        $lockAcquired = false;

        try {
            $lock->block(15);
            $lockAcquired = true;

            $cachedData = AlgorithmCache::get($request);
            $assignmentDetails = is_array($cachedData['assignmentDetails'] ?? null)
                ? $cachedData['assignmentDetails']
                : [];

            if ($assignmentDetails === []) {
                return response()->json([
                    'message' => 'No algorithm assignments to update. Run the algorithm first.',
                ], 422);
            }

            EmployeeNames::warmEmployeeCache();

            $updatedDetails = ApplyHistogramBarEdits::apply(
                $assignmentDetails,
                $validated['edits'],
            );

            $taskIds = collect($updatedDetails)
                ->pluck('task_id')
                ->map(fn ($id) => (int) $id)
                ->filter(fn ($id) => $id > 0)
                ->unique()
                ->values()
                ->all();

            $taskStartById = $taskIds === []
                ? []
                : ProjectTask::query()
                    ->whereIn('id', $taskIds)
                    ->get(['id', 'doc_supply'])
                    ->mapWithKeys(function (ProjectTask $task) {
                        if (empty($task->doc_supply)) {
                            return [];
                        }

                        return [
                            (int) $task->id => Carbon::parse($task->doc_supply)->toDateString(),
                        ];
                    })
                    ->all();

            ApplyHistogramBarEdits::assertNoAssignmentsBeforeTaskStart($updatedDetails, $taskStartById);
            ApplyHistogramBarEdits::assertNoEmployeeDayOverload($updatedDetails);

            \Illuminate\Support\Facades\DB::transaction(function () use (
                $updatedDetails,
                $validated,
                $cachedData,
                $request,
            ) {
                HistogramScheduleOverrides::persistFromEdits(
                    $updatedDetails,
                    $validated['edits'],
                );
                // Keep durable overrides in sync when apply/trim clipped other tasks
                // on overloaded days (e.g. Habiba 9h → 8h).
                HistogramScheduleOverrides::syncExistingFromAssignments($updatedDetails);

                $taskIds = collect($validated['edits'])
                    ->pluck('task_id')
                    ->map(fn ($id) => (int) $id)
                    ->filter(fn ($id) => $id > 0)
                    ->unique()
                    ->values()
                    ->all();

                $tasksById = $taskIds === []
                    ? collect()
                    : ProjectTask::query()->whereIn('id', $taskIds)->get()->keyBy('id');

                foreach ($validated['edits'] as $edit) {
                    $previousEmployee = trim((string) ($edit['previous_employee'] ?? ''));
                    $nextEmployee = trim((string) ($edit['employee'] ?? ''));
                    if ($previousEmployee === '' || $nextEmployee === '') {
                        continue;
                    }

                    $task = $tasksById->get((int) ($edit['task_id'] ?? 0));
                    if (! $task) {
                        continue;
                    }

                    EmployeeNames::applyHistogramReassignOverride($task, $previousEmployee, $nextEmployee);
                }

                AlgorithmCache::put([
                    ...$cachedData,
                    'assignmentDetails' => $updatedDetails,
                ], $request);
            });

            self::clearFullPayloadCache($request);

            $editCount = count($validated['edits']);
            $logPayload = HistogramActivityLog::buildSavePayload($validated['edits']);
            $activityLog = ActivityLogService::log(
                $request,
                'histogram',
                'save_bar_edits',
                $logPayload['summary'],
                null,
                null,
                $logPayload['changes'],
                ['edit_count' => $editCount],
            );

            return response()->json([
                'message' => 'Histogram task bar changes saved.',
                'updated' => $editCount,
                'activity_log' => self::formatHistogramActivityLog($activityLog),
            ]);
        } catch (\InvalidArgumentException $e) {
            return response()->json([
                'message' => $e->getMessage(),
            ], 422);
        } catch (\Illuminate\Contracts\Cache\LockTimeoutException $e) {
            return response()->json([
                'message' => 'Another histogram save is in progress. Please try again in a moment.',
            ], 423);
        } catch (\Throwable $e) {
            report($e);

            return response()->json([
                'message' => 'Unable to save histogram task bar changes.',
                'error' => config('app.debug') ? $e->getMessage() : 'An unexpected error occurred while saving.',
            ], 500);
        } finally {
            if ($lockAcquired) {
                $lock->release();
            }
            EmployeeNames::clearEmployeeCache();
        }
    }

    public function activityLogs(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'limit' => 'nullable|integer|min:1|max:200',
            'section' => 'nullable|string|in:histogram,trainings,dl',
        ]);

        $limit = $validated['limit'] ?? 100;
        $section = $validated['section'] ?? 'histogram';
        $scope = DlLogScope::forUser($request->user());
        $fetchLimit = $scope ? min(200, max($limit * 4, $limit)) : $limit;

        try {
            if ($section === 'trainings') {
                $logs = ActivityLog::query()
                    ->where('area', 'Trainings')
                    ->orderByDesc('created_at')
                    ->limit($fetchLimit)
                    ->get();

                if ($scope) {
                    $logs = $logs
                        ->filter(fn (ActivityLog $log) => DlLogScope::trainingLogMatches($log, $scope))
                        ->take($limit)
                        ->values();
                }

                return response()->json([
                    'data' => $logs
                        ->map(fn (ActivityLog $log) => self::formatTrainingActivityLog($log))
                        ->values(),
                ]);
            }

            if ($section === 'dl') {
                return response()->json([
                    'data' => $this->loadDlPlanActivityLogs($limit, $scope),
                ]);
            }

            $logs = ActivityLog::query()
                ->where(function ($query) {
                    $query->where(function ($inner) {
                        $inner->where('area', 'histogram')
                            ->whereIn('action', ['save_bar_edits', 'training_project_override']);
                    })->orWhere(function ($inner) {
                        $inner->where('area', 'Trainings')
                            ->where('action', 'overridden');
                    });
                })
                ->orderByDesc('created_at')
                ->limit($fetchLimit)
                ->get();

            if ($scope) {
                $tasksById = DlLogScope::tasksById(DlLogScope::collectTaskIds($logs));
                $logs = $logs
                    ->filter(fn (ActivityLog $log) => self::histogramLogIncludesTrainingOverride($log))
                    ->map(function (ActivityLog $log) use ($scope, $tasksById) {
                        if ($log->area === 'Trainings' || $log->action === 'training_project_override') {
                            return DlLogScope::trainingLogMatches($log, $scope) ? $log : null;
                        }

                        return DlLogScope::restrictHistogramLog($log, $scope, $tasksById);
                    })
                    ->filter()
                    ->take($limit)
                    ->values();
            } else {
                $logs = $logs
                    ->filter(fn (ActivityLog $log) => self::histogramLogIncludesTrainingOverride($log))
                    ->take($limit)
                    ->values();
            }

            return response()->json([
                'data' => $logs
                    ->map(fn (ActivityLog $log) => self::formatHistogramActivityLog($log))
                    ->values(),
            ]);
        } finally {
            if ($scope) {
                EmployeeNames::clearEmployeeCache();
            }
        }
    }

    public function revertActivityLog(Request $request, ActivityLog $activityLog): JsonResponse
    {
        if (! $this->userCanEditHistogramBars($request->user())) {
            return response()->json([
                'message' => 'You do not have permission to edit histogram task bars.',
            ], 403);
        }

        if ($activityLog->area !== 'histogram' || $activityLog->action !== 'save_bar_edits') {
            return response()->json([
                'message' => 'Only saved histogram schedule edits can be undone from this log.',
            ], 422);
        }

        if (self::activityLogIsReverted($activityLog)) {
            return response()->json([
                'message' => 'This change has already been undone.',
            ], 422);
        }

        $logsToRevert = ActivityLog::query()
            ->where('area', 'histogram')
            ->where('action', 'save_bar_edits')
            ->where('created_at', '>=', $activityLog->created_at)
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->get()
            ->filter(fn (ActivityLog $log) => ! self::activityLogIsReverted($log))
            ->values();

        foreach ($logsToRevert as $log) {
            $reversible = $log->changes['reversible_edits'] ?? null;
            if (! is_array($reversible) || $reversible === []) {
                return response()->json([
                    'message' => 'One or more later saved edits cannot be undone (missing restore data). Save new edits after this update to enable undo.',
                ], 422);
            }
        }

        $lock = Cache::lock('algorithm-cache-write', 30);
        $lockAcquired = false;

        try {
            $lock->block(15);
            $lockAcquired = true;

            $cachedData = AlgorithmCache::get($request);
            $assignmentDetails = is_array($cachedData['assignmentDetails'] ?? null)
                ? $cachedData['assignmentDetails']
                : [];

            if ($assignmentDetails === []) {
                return response()->json([
                    'message' => 'No algorithm assignments to update. Run the algorithm first.',
                ], 422);
            }

            EmployeeNames::warmEmployeeCache();

            $revertedIds = [];

            \Illuminate\Support\Facades\DB::transaction(function () use (
                $logsToRevert,
                &$assignmentDetails,
                &$revertedIds,
                $cachedData,
                $request,
            ) {
                foreach ($logsToRevert as $log) {
                    $reversibleEdits = $log->changes['reversible_edits'] ?? [];
                    $revertEdits = array_map(
                        static fn (array $edit) => HistogramActivityLog::buildRevertEdit($edit),
                        $reversibleEdits,
                    );

                    $assignmentDetails = ApplyHistogramBarEdits::apply(
                        $assignmentDetails,
                        $revertEdits,
                    );

                    HistogramScheduleOverrides::persistFromEdits(
                        $assignmentDetails,
                        $revertEdits,
                    );
                    HistogramScheduleOverrides::syncExistingFromAssignments($assignmentDetails);

                    $taskIds = collect($revertEdits)
                        ->pluck('task_id')
                        ->map(fn ($id) => (int) $id)
                        ->filter(fn ($id) => $id > 0)
                        ->unique()
                        ->values()
                        ->all();

                    $tasksById = $taskIds === []
                        ? collect()
                        : ProjectTask::query()->whereIn('id', $taskIds)->get()->keyBy('id');

                    foreach ($reversibleEdits as $edit) {
                        $previousEmployee = trim((string) ($edit['previous_employee'] ?? ''));
                        $nextEmployee = trim((string) ($edit['employee'] ?? ''));
                        if ($previousEmployee === '' || $nextEmployee === '') {
                            continue;
                        }

                        $task = $tasksById->get((int) ($edit['task_id'] ?? 0));
                        if (! $task) {
                            continue;
                        }

                        // Swap back: current assignee → original assignee.
                        EmployeeNames::applyHistogramReassignOverride($task, $nextEmployee, $previousEmployee);
                    }

                    $meta = is_array($log->meta) ? $log->meta : [];
                    $meta['reverted_at'] = now()->toIso8601String();
                    $meta['reverted_by_user_id'] = $request->user()?->id;
                    $meta['reverted_by_user_name'] = $request->user()?->name ?? 'System';
                    $log->meta = $meta;
                    $log->save();

                    $revertedIds[] = $log->id;
                }

                ApplyHistogramBarEdits::assertNoEmployeeDayOverload($assignmentDetails);

                AlgorithmCache::put([
                    ...$cachedData,
                    'assignmentDetails' => $assignmentDetails,
                ], $request);
            });

            self::clearFullPayloadCache($request);

            return response()->json([
                'message' => count($revertedIds) === 1
                    ? 'Saved histogram change undone.'
                    : sprintf('Undid %d saved histogram changes.', count($revertedIds)),
                'reverted_ids' => $revertedIds,
            ]);
        } catch (\InvalidArgumentException $e) {
            return response()->json([
                'message' => $e->getMessage(),
            ], 422);
        } catch (\Illuminate\Contracts\Cache\LockTimeoutException $e) {
            return response()->json([
                'message' => 'Another histogram save is in progress. Please try again in a moment.',
            ], 423);
        } catch (\Throwable $e) {
            report($e);

            return response()->json([
                'message' => 'Unable to undo saved histogram changes.',
                'error' => config('app.debug') ? $e->getMessage() : 'An unexpected error occurred while undoing.',
            ], 500);
        } finally {
            if ($lockAcquired) {
                $lock->release();
            }
            EmployeeNames::clearEmployeeCache();
        }
    }

    /**
     * Projects-tab history includes bar edits and training overrides that
     * reduced project hours. Pure training-on-training overrides stay on the
     * Trainings tab only.
     */
    private static function histogramLogIncludesTrainingOverride(ActivityLog $log): bool
    {
        if ($log->area === 'histogram' && $log->action === 'save_bar_edits') {
            return true;
        }

        if ($log->area === 'histogram' && $log->action === 'training_project_override') {
            return true;
        }

        if ($log->area !== 'Trainings' || $log->action !== 'overridden') {
            return false;
        }

        $meta = is_array($log->meta) ? $log->meta : [];
        $tasks = $meta['overridden_tasks'] ?? [];

        return is_array($tasks) && $tasks !== [];
    }

    /**
     * @return array<string, mixed>
     */
    private static function formatTrainingActivityLog(ActivityLog $log): array
    {
        $meta = is_array($log->meta) ? $log->meta : [];

        return [
            'id' => $log->id,
            'action' => $log->action,
            'summary' => $log->summary,
            'user_name' => $log->user_name,
            'created_at' => optional($log->created_at)?->toIso8601String(),
            'changes' => is_array($log->changes) ? $log->changes : null,
            'subject_type' => $log->subject_type,
            'subject_id' => $log->subject_id,
            'meta' => $meta !== [] ? $meta : null,
            'confirm_override' => (bool) ($meta['confirm_override'] ?? false),
            'overridden_tasks' => is_array($meta['overridden_tasks'] ?? null) ? $meta['overridden_tasks'] : [],
            'overridden_trainings' => is_array($meta['overridden_trainings'] ?? null) ? $meta['overridden_trainings'] : [],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function formatHistogramActivityLog(ActivityLog $log): array
    {
        if ($log->area === 'Trainings' || $log->action === 'training_project_override') {
            $meta = is_array($log->meta) ? $log->meta : [];
            $tasks = is_array($meta['overridden_tasks'] ?? null) ? $meta['overridden_tasks'] : [];
            $taskSummaries = [];
            foreach ($tasks as $task) {
                if (! is_array($task)) {
                    continue;
                }
                $name = trim((string) ($task['task_name'] ?? ''));
                $project = trim((string) ($task['project_name'] ?? ''));
                if ($name === '') {
                    continue;
                }
                $taskSummaries[] = $project !== '' ? "{$name} — {$project}" : $name;
            }

            return [
                'id' => $log->id,
                'user_id' => $log->user_id,
                'user_name' => $log->user_name,
                'summary' => $log->summary,
                'edit_summaries' => $taskSummaries !== []
                    ? array_map(static fn (string $label) => "Training overrode: {$label}", $taskSummaries)
                    : [trim((string) $log->summary)],
                'edit_count' => max(1, count($taskSummaries)),
                'can_undo' => false,
                'undone' => false,
                'reverted_at' => null,
                'reverted_by_user_name' => null,
                'created_at' => optional($log->created_at)?->toIso8601String(),
                'kind' => 'training_project_override',
                'action' => 'training_project_override',
            ];
        }

        $changes = is_array($log->changes) ? $log->changes : [];
        $meta = is_array($log->meta) ? $log->meta : [];
        $summaries = [];
        foreach (($changes['edits'] ?? []) as $edit) {
            if (! is_array($edit)) {
                continue;
            }
            $text = trim((string) ($edit['summary'] ?? ''));
            if ($text !== '') {
                $summaries[] = $text;
            }
        }

        return [
            'id' => $log->id,
            'user_id' => $log->user_id,
            'user_name' => $log->user_name,
            'summary' => $log->summary,
            'edit_summaries' => $summaries,
            'edit_count' => (int) ($meta['edit_count'] ?? count($changes['edits'] ?? [])),
            'can_undo' => is_array($changes['reversible_edits'] ?? null)
                && $changes['reversible_edits'] !== []
                && ! self::activityLogIsReverted($log),
            'undone' => self::activityLogIsReverted($log),
            'reverted_at' => $meta['reverted_at'] ?? null,
            'reverted_by_user_name' => $meta['reverted_by_user_name'] ?? null,
            'created_at' => optional($log->created_at)?->toIso8601String(),
            'kind' => 'bar_edit',
            'action' => $log->action,
        ];
    }

    /**
     * @return \Illuminate\Support\Collection<int, array<string, mixed>>
     */
    private function loadDlPlanActivityLogs(int $limit, ?array $scope = null)
    {
        $fetchLimit = min(200, max(($scope ? $limit * 4 : $limit * 2), $limit));

        $logs = ActivityLog::query()
            ->where(function ($query) {
                $query->where('area', 'dl')
                    ->orWhere('area', 'pde');
            })
            ->where('action', 'tasks_sync')
            ->orderByDesc('created_at')
            ->limit($fetchLimit)
            ->get()
            ->filter(fn (ActivityLog $log) => $this->isDlPlanActivityLog($log))
            ->values();

        if ($scope) {
            $tasksById = DlLogScope::tasksById(DlLogScope::collectTaskIds($logs));
            $logs = $logs
                ->map(fn (ActivityLog $log) => DlLogScope::restrictDlPlanLog($log, $scope, $tasksById))
                ->filter()
                ->values();
        }

        return $logs
            ->take($limit)
            ->values()
            ->map(fn (ActivityLog $log) => self::formatDlPlanActivityLog($log));
    }

    private function isDlPlanActivityLog(ActivityLog $log): bool
    {
        $meta = is_array($log->meta) ? $log->meta : [];
        $changes = is_array($log->changes) ? $log->changes : [];
        $hasDlFieldEdits = PlanActivityLog::looksLikeDlPlanEdit($changes);

        // Only surface saves that actually changed DL plan fields (hours / mirrors).
        // Algorithm-only or owner-stamp-only syncs must not mark histogram bars.
        if (! $hasDlFieldEdits) {
            return false;
        }

        if ($log->area === 'dl' || ($meta['source'] ?? '') === 'dl') {
            return true;
        }

        return $log->area === 'pde';
    }

    /**
     * @return array<string, mixed>
     */
    private static function formatDlPlanActivityLog(ActivityLog $log): array
    {
        $changes = is_array($log->changes) ? $log->changes : [];
        $meta = is_array($log->meta) ? $log->meta : [];

        return [
            'id' => $log->id,
            'user_id' => $log->user_id,
            'user_name' => $log->user_name,
            'area' => $log->area,
            'action' => $log->action,
            'summary' => $log->summary,
            'changes' => $changes !== [] ? $changes : null,
            'meta' => $meta !== [] ? $meta : null,
            'task_ids' => PlanActivityLog::taskIdsFromLog($meta, $changes),
            'created_at' => optional($log->created_at)?->toIso8601String(),
        ];
    }

    private static function activityLogIsReverted(ActivityLog $log): bool
    {
        $meta = is_array($log->meta) ? $log->meta : [];

        return ! empty($meta['reverted_at']);
    }

    public static function clearFullPayloadCache(?Request $request = null): void
    {
        Cache::forget(self::fullPayloadCacheKey($request));
    }

    /**
     * Histogram bars snapshot project colour at cache time. Always paint from
     * the live projects table so a colour change does not need an algorithm rerun.
     *
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    private function applyLiveProjectColors(array $data): array
    {
        $bars = $this->jsonList($data['bars'] ?? []);
        $projects = $this->jsonList($data['projects'] ?? []);

        $ids = [];
        foreach ($projects as $project) {
            $id = (int) ($project['id'] ?? 0);
            if ($id > 0) {
                $ids[$id] = true;
            }
        }
        foreach ($bars as $bar) {
            $id = (int) ($bar['project_id'] ?? 0);
            if ($id > 0) {
                $ids[$id] = true;
            }
        }

        if ($ids === []) {
            $data['bars'] = $bars;
            $data['projects'] = $projects;

            return $data;
        }

        $colors = Project::query()
            ->whereIn('id', array_keys($ids))
            ->pluck('color', 'id');

        $data['bars'] = array_map(function ($bar) use ($colors) {
            $id = (int) ($bar['project_id'] ?? 0);
            if ($id > 0 && $colors->has($id)) {
                $bar['color'] = $colors->get($id) ?: '#3B82F6';
            }

            return $bar;
        }, $bars);

        $data['projects'] = array_map(function ($project) use ($colors) {
            $id = (int) ($project['id'] ?? 0);
            if ($id > 0 && $colors->has($id)) {
                $project['color'] = $colors->get($id) ?: '#3B82F6';
            }

            return $project;
        }, $projects);

        return $data;
    }

    private static function fullPayloadCacheKey(?Request $request = null): string
    {
        // Shared across users — histogram data comes from shared AlgorithmCache.
        return self::FULL_PAYLOAD_CACHE_PREFIX.':shared';
    }

    /**
     * @param  mixed  $cached
     */
    private function canServeCachedFullPayload(mixed $cached, Request $request): bool
    {
        if (! is_array($cached) || $this->jsonList($cached['employees'] ?? null) === []) {
            return false;
        }

        if (empty($cached['algorithm_cache_missing'])) {
            return true;
        }

        $live = AlgorithmCache::get($request);
        $liveDetails = is_array($live['assignmentDetails'] ?? null)
            ? $live['assignmentDetails']
            : [];

        return $liveDetails === [];
    }

    /**
     * @return \Illuminate\Support\Collection<int, object>
     */
    private function loadCachedNrms(): \Illuminate\Support\Collection
    {
        $cached = Cache::remember(
            self::NRMS_CACHE_KEY,
            self::META_CACHE_TTL_SECONDS,
            fn () => $this->jsonList(
                Nrm::query()->orderBy('number')->get(['id', 'number', 'name', 'sc_name']),
            ),
        );

        $rows = $this->jsonList($cached);
        if ($rows === []) {
            Cache::forget(self::NRMS_CACHE_KEY);
            $rows = $this->jsonList(
                Nrm::query()->orderBy('number')->get(['id', 'number', 'name', 'sc_name']),
            );
        }

        return collect($rows)->map(fn ($row) => (object) $row);
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     * @param  \Illuminate\Support\Collection<int, ProjectTask>  $tasksById
     * @param  \Illuminate\Support\Collection<int, object>  $nrms
     * @return array<int, array<string, mixed>>
     */
    private function buildHistogramBars(array $assignmentDetails, $tasksById, $nrms): array
    {
        try {
            return HistogramFromAssignments::build($assignmentDetails, $tasksById, $nrms)['bars'];
        } catch (\Throwable $e) {
            report($e);
            Cache::forget(self::NRMS_CACHE_KEY);
        }

        $freshNrms = collect($this->jsonList(
            Nrm::query()->orderBy('number')->get(['id', 'number', 'name', 'sc_name']),
        ))->map(fn ($row) => (object) $row);

        try {
            return HistogramFromAssignments::build($assignmentDetails, $tasksById, $freshNrms)['bars'];
        } catch (\Throwable $retry) {
            report($retry);

            return [];
        }
    }

    /**
     * @return \Illuminate\Support\Collection<int, array<string, mixed>>
     */
    private function loadHistogramEmployees()
    {
        return Employee::query()
            ->with(['team:id,name', 'nrms'])
            ->get(['id', 'first_name', 'last_name', 'team_id', 'position'])
            ->sort(fn (Employee $employeeA, Employee $employeeB) => EmployeeOrder::compare($employeeA, $employeeB))
            ->values()
            ->map(fn (Employee $employee) => [
                'id' => $employee->id,
                'name' => $employee->name,
                'first_name' => $employee->first_name,
                'last_name' => $employee->last_name,
                'team_id' => $employee->team_id,
                'position' => $employee->position,
                'team' => $employee->team?->name,
                'has_oap' => $employee->nrms->contains(
                    fn ($nrm) => ($oap = trim((string) ($nrm->pivot->OAP ?? ''))) !== ''
                        && $oap !== 'Chk',
                ),
                'is_trainee' => EmployeeTrainee::isTrainee($employee),
            ])
            ->values();
    }

    /**
     * JSON-encode lists as sequential arrays (object-keyed collections break .map in the SPA).
     *
     * @param  mixed  $value
     * @return array<int, mixed>
     */
    private function jsonList(mixed $value): array
    {
        if (is_object($value) && get_class($value) === '__PHP_Incomplete_Class') {
            return [];
        }
        if ($value instanceof \Illuminate\Contracts\Support\Arrayable) {
            $value = $value->toArray();
        } elseif ($value instanceof \Illuminate\Support\Collection) {
            $value = $value->values()->all();
        } elseif (is_object($value)) {
            $decoded = json_decode(json_encode($value), true);
            $value = is_array($decoded) ? $decoded : [];
        }

        if (! is_array($value)) {
            return [];
        }

        if ($value === []) {
            return [];
        }

        if (array_is_list($value)) {
            $first = $value[0];
            if (is_array($first) || is_object($first)) {
                return array_values($value);
            }

            return $value;
        }

        $first = reset($value);
        if (is_array($first) || is_object($first)) {
            return array_values($value);
        }

        return [$value];
    }

    private function filterBarsByDateRange(array $bars, Carbon $filterStart, Carbon $filterEnd): array
    {
        $startYmd = $filterStart->toDateString();
        $endYmd = $filterEnd->toDateString();

        $filtered = [];

        foreach ($bars as $bar) {
            if (empty($bar['hours_by_day']) || ! is_array($bar['hours_by_day'])) {
                continue;
            }

            if ($bar['end'] < $startYmd || $bar['start'] > $endYmd) {
                continue;
            }

            $bar['start'] = max($bar['start'], $startYmd);
            $bar['end'] = min($bar['end'], $endYmd);

            if (! empty($bar['hours_by_day']) && is_array($bar['hours_by_day'])) {
                $clipped = [];
                foreach ($bar['hours_by_day'] as $day => $hours) {
                    if ($day >= $bar['start'] && $day <= $bar['end']) {
                        $clipped[$day] = $hours;
                    }
                }
                $bar['hours_by_day'] = $clipped;
                $bar['hours'] = round(array_sum($clipped), 4);
                if ($bar['hours'] <= 0) {
                    continue;
                }
            } else {
                continue;
            }

            $filtered[] = $bar;
        }

        return $filtered;
    }

    /**
     * Default timeline envelope for full loads (matches frontend defaultHistogramDateRange).
     *
     * @param  array<int, array<string, mixed>>  $bars
     * @return array{0: string, 1: string}
     */
    private function resolveHistogramEnvelopeRange(array $bars): array
    {
        $envelopeStart = Carbon::today()->subDays(7)->toDateString();
        $envelopeEnd = Carbon::today()->addDays(82)->toDateString();

        if ($bars !== []) {
            $barStart = collect($bars)->min('start');
            $barEnd = collect($bars)->max('end');
            if (is_string($barStart) && $barStart < $envelopeStart) {
                $envelopeStart = $barStart;
            }
            if (is_string($barEnd) && $barEnd > $envelopeEnd) {
                $envelopeEnd = $barEnd;
            }
        }

        return [$envelopeStart, $envelopeEnd];
    }

    /**
     * @return array{0: array<string, array<string, float>>, 1: array<string, array<string, bool>>}
     */
    private function buildAvailabilityData(Carbon $rangeStart, Carbon $rangeEnd): array
    {
        $availabilityHours = [];
        $employeeHolidays = [];

        $rows = EmployeeAvailability::query()
            ->with('employee:id,first_name,last_name')
            ->whereBetween('date', [$rangeStart->toDateString(), $rangeEnd->toDateString()])
            ->orderBy('date')
            ->get(['id', 'employee_id', 'date', 'total', 'total_ava']);

        foreach ($rows as $row) {
            $employee = $row->employee;
            if (! $employee) {
                continue;
            }

            $name = EmployeeNames::displayName($employee);
            if ($name === '') {
                continue;
            }

            $day = $row->date->toDateString();
            $hours = $this->parseTimeToHours($row->total_ava ?? $row->total ?? '00:00');

            if (! isset($availabilityHours[$name])) {
                $availabilityHours[$name] = [];
            }
            $availabilityHours[$name][$day] = $hours;

            if ($row->date->isWeekend()) {
                continue;
            }

            $totalHours = $this->parseTimeToHours($row->total ?? '00:00');
            $avaTotalHours = $this->parseTimeToHours($row->total_ava ?? '00:00');

            if ($totalHours > 0 || $avaTotalHours > 0) {
                continue;
            }

            if (! isset($employeeHolidays[$name])) {
                $employeeHolidays[$name] = [];
            }
            $employeeHolidays[$name][$day] = true;
        }

        return [$availabilityHours, $employeeHolidays];
    }

    private function userCanEditHistogramBars($user): bool
    {
        if (! $user) {
            return false;
        }

        return $user->canPageAction('Resource Histogram', 'edit_bars');
    }

    private function parseTimeToHours(?string $value): float
    {
        if ($value === null || trim($value) === '') {
            return 0.0;
        }

        $parts = explode(':', trim($value));
        $hours = (float) ($parts[0] ?? 0);
        $minutes = (float) ($parts[1] ?? 0);
        $seconds = (float) ($parts[2] ?? 0);

        return $hours + ($minutes / 60) + ($seconds / 3600);
    }
}
