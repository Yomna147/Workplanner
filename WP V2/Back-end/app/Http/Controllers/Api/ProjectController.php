<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Controllers\Api\ResourceHistogramController;
use App\Models\Project;
use App\Services\ActivityLogService;
use App\Services\ProjectCreatePrefillService;
use App\Services\ProjectPpRebalanceService;
use App\Support\AlgorithmCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Throwable;

class ProjectController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $ppSubquery = DB::table('project_tasks')
            ->join('parts', 'parts.id', '=', 'project_tasks.part_id')
            ->whereNotNull('project_tasks.pp')
            ->where('project_tasks.pp', '!=', '')
            ->groupBy('parts.project_id')
            ->select([
                'parts.project_id',
                DB::raw('MAX(CAST(project_tasks.pp AS DECIMAL(10,2))) as min_pp'),
            ]);

        $tasksCountSql = <<<'SQL'
(SELECT COUNT(*)
 FROM project_tasks
 INNER JOIN parts ON parts.id = project_tasks.part_id
 WHERE parts.project_id = projects.id)
SQL;

        $openTasksCountSql = <<<'SQL'
(SELECT COUNT(*)
 FROM project_tasks
 INNER JOIN parts ON parts.id = project_tasks.part_id
 WHERE parts.project_id = projects.id
   AND (project_tasks.done = 0 OR project_tasks.done IS NULL))
SQL;

        $query = Project::query()
            ->with('team')
            ->leftJoinSub($ppSubquery, 'pp_summary', 'pp_summary.project_id', '=', 'projects.id')
            ->select('projects.*', 'pp_summary.min_pp')
            ->selectRaw("{$tasksCountSql} as tasks_count")
            ->selectRaw("{$openTasksCountSql} as open_tasks_count");

        if (! $request->boolean('all')) {
            $query
                ->where('projects.status', '!=', 'completed')
                ->where(function ($query) {
                    $query->whereHas('tasks', function ($taskQuery) {
                        $taskQuery->where('done', false);
                    })->orWhereDoesntHave('tasks');
                });
        }

        $projects = $query
            ->orderByDesc('projects.created_at')
            ->orderByRaw('pp_summary.min_pp IS NULL')
            ->orderByDesc(DB::raw('CAST(pp_summary.min_pp AS DECIMAL(10,2))'))
            ->orderBy('projects.name')
            ->get();

        return response()->json(['data' => $projects]);
    }

    /**
     * Lookup quotation + dates from Drive Quotation forms, Sales Tool, and Outlook OC emails.
     */
    public function createPrefill(Request $request, ProjectCreatePrefillService $prefill): JsonResponse
    {
        @set_time_limit(120);

        $validated = $request->validate([
            'q' => 'required|string|max:255',
            'profile' => 'nullable|in:deals,leads',
        ]);

        try {
            $payload = $prefill->lookup(
                query: $validated['q'],
                outlookProfile: $validated['profile'] ?? 'deals',
            );

            return response()->json(['data' => $payload]);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => 'Unable to look up project quotation/dates: '.$e->getMessage(),
            ], 502);
        }
    }

    public function ttComparison(Request $request): JsonResponse
    {
        $query = Project::query()
            ->with(['parts.tasks'])
            ->orderBy('name');

        if (! $request->boolean('all')) {
            $query
                ->where('status', '!=', 'completed')
                ->where(function ($builder) {
                    $builder->whereHas('tasks', function ($taskQuery) {
                        $taskQuery->where('done', false);
                    })->orWhereDoesntHave('tasks');
                });
        }

        $projects = $query->get()->map(function (Project $project) {
            return [
                'id' => $project->id,
                'ProjectName' => $project->name,
                'Color' => $project->color,
                'parts' => $project->parts->map(function ($part) {
                    return [
                        'id' => $part->id,
                        'name' => $part->name,
                        'subs' => $part->tasks->map(function ($task) {
                            return [
                                'id' => $task->id,
                                'TaskName' => $task->task_name,
                                'Plan' => $task->plan,
                                'Done' => $task->done ? 1 : 0,
                            ];
                        })->values(),
                    ];
                })->values(),
            ];
        })->values();

        return response()->json(['data' => $projects]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'required|string|max:255',
            'color' => 'nullable|string|max:7',
            'status' => 'nullable|in:active,completed,on_hold',
            'description' => 'nullable|string',
            'team_id' => 'nullable|exists:teams,id',
            'have_all_docs' => 'nullable|boolean',
        ]);

        $project = Project::create($validated);

        return response()->json(['data' => $project->load('team')], 201);
    }

    public function storeWithTasks(Request $request, ProjectPpRebalanceService $ppRebalance): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'required|string|max:255',
            'color' => 'nullable|string|max:7',
            'status' => 'nullable|in:active,completed,on_hold',
            'description' => 'nullable|string',
            'team_id' => 'nullable|exists:teams,id',
            'have_all_docs' => 'nullable|boolean',
            'part_name' => 'required|string|max:255',
            'pp' => 'nullable|string|max:50',
            'doc_supply' => 'nullable|string|max:50',
            'completion' => 'nullable|string|max:50',
            'tasks' => 'required|array|min:1',
            'tasks.*.task_name' => 'required|string|max:255',
            'tasks.*.est' => 'nullable|string|max:50',
            'tasks.*.dl' => 'nullable|string|max:50',
            'tasks.*.plan' => 'nullable|string|max:50',
            'tasks.*.rap' => 'nullable|string|max:50',
            'tasks.*.pp' => 'nullable|string|max:50',
            'tasks.*.pri' => 'nullable|string|max:50',
            'tasks.*.doc_supply' => 'nullable|string|max:50',
            'tasks.*.completion' => 'nullable|string|max:50',
        ]);

        $result = DB::transaction(function () use ($validated) {
            $project = Project::create([
                'name' => $validated['name'],
                'color' => $validated['color'] ?? '#3B82F6',
                'status' => $validated['status'] ?? 'active',
                'description' => $validated['description'] ?? null,
                'team_id' => $validated['team_id'] ?? null,
                'have_all_docs' => $validated['have_all_docs'] ?? true,
            ]);

            $part = $project->parts()->create(['name' => $validated['part_name']]);

            $defaultPp = $validated['pp'] ?? null;
            $defaultStart = $validated['doc_supply'] ?? null;
            $defaultEnd = $validated['completion'] ?? null;
            $tasks = [];

            foreach ($validated['tasks'] as $row) {
                $pp = $row['pp'] ?? $defaultPp;
                $rap = $row['rap'] ?? null;
                $pri = $row['pri'] ?? null;
                if ($pri === null && ($rap !== null || $pp !== null)) {
                    $pri = (string) ((float) ($rap ?? 0) + (float) ($pp ?? 0));
                }

                $tasks[] = $part->tasks()->create([
                    'task_name' => $row['task_name'],
                    'est' => $row['est'] ?? null,
                    'dl' => $row['dl'] ?? null,
                    'plan' => $row['plan'] ?? $row['est'] ?? null,
                    'rap' => $rap,
                    'pp' => $pp,
                    'pri' => $pri,
                    'doc_supply' => $row['doc_supply'] ?? $defaultStart,
                    'completion' => $row['completion'] ?? $defaultEnd,
                ]);
            }

            return [
                'project' => $project->load('team'),
                'part' => $part,
                'tasks' => $tasks,
            ];
        });

        if (($validated['status'] ?? 'active') === 'active') {
            $ppRebalance->rebalance(
                $result['project']->id,
                $validated['pp'] ?? null,
                false,
            );

            $result['tasks'] = $result['part']->tasks()
                ->orderBy('id')
                ->get()
                ->all();
        }

        return response()->json(['data' => $result], 201);
    }

    public function rebalancePp(Request $request, ProjectPpRebalanceService $ppRebalance): JsonResponse
    {
        $validated = $request->validate([
            'project_id' => 'nullable|integer|exists:projects,id',
            'requested_pp' => 'nullable|string|max:50',
            'normalize_only' => 'nullable|boolean',
        ]);

        $applied = $ppRebalance->rebalance(
            isset($validated['project_id']) ? (int) $validated['project_id'] : null,
            $validated['requested_pp'] ?? null,
            $request->boolean('normalize_only'),
        );

        return response()->json([
            'data' => $applied,
        ]);
    }

    public function show(Project $project): JsonResponse
    {
        return response()->json(['data' => $project->load('team')]);
    }

    public function update(Request $request, Project $project): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'sometimes|required|string|max:255',
            'color' => 'nullable|string|max:7',
            'status' => 'nullable|in:active,completed,on_hold',
            'description' => 'nullable|string',
            'team_id' => 'nullable|exists:teams,id',
            'have_all_docs' => 'nullable|boolean',
        ]);

        $before = $project->only(array_keys($validated));
        $project->update($validated);
        $fresh = $project->fresh('team');

        $changes = [];
        foreach ($validated as $field => $newValue) {
            $oldValue = $before[$field] ?? null;
            if ((string) ($oldValue ?? '') !== (string) ($newValue ?? '')) {
                $changes[$field] = ['from' => $oldValue, 'to' => $newValue];
            }
        }

        if ($changes !== []) {
            ActivityLogService::log(
                $request,
                'pde',
                'project_update',
                "Updated project {$fresh->name}",
                Project::class,
                $fresh->id,
                $changes,
                ['project_id' => $fresh->id, 'project_name' => $fresh->name],
            );
        }

        if (array_key_exists('have_all_docs', $validated)
            || array_key_exists('color', $validated)
            || array_key_exists('name', $validated)
            || array_key_exists('status', $validated)
        ) {
            ResourceHistogramController::clearFullPayloadCache($request);
        }

        return response()->json(['data' => $fresh]);
    }

    public function destroy(Request $request, Project $project): JsonResponse
    {
        $meta = [
            'project_id' => $project->id,
            'project_name' => $project->name,
        ];

        ActivityLogService::log(
            $request,
            'pde',
            'project_delete',
            "Deleted project {$project->name}",
            Project::class,
            $project->id,
            ['name' => $project->name],
            $meta,
        );

        $partIds = $project->parts()->pluck('id');
        $taskIds = $partIds->isNotEmpty()
            ? DB::table('project_tasks')->whereIn('part_id', $partIds)->pluck('id')->all()
            : [];

        AlgorithmCache::forgetAssignmentsForTaskIds($taskIds, $request);

        DB::transaction(function () use ($project, $partIds) {
            if ($partIds->isNotEmpty()) {
                DB::table('project_tasks')->whereIn('part_id', $partIds)->delete();
                DB::table('parts')->whereIn('id', $partIds)->delete();
            }

            $project->delete();
        });

        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json(['message' => 'Project deleted']);
    }
}
