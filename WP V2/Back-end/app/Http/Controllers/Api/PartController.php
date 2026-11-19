<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Api\ResourceHistogramController;
use App\Http\Controllers\Controller;
use App\Models\Part;
use App\Models\Project;
use App\Services\ActivityLogService;
use App\Support\AlgorithmCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class PartController extends Controller
{
    public function index(Project $project): JsonResponse
    {
        $parts = $project->parts()
            ->withCount('tasks')
            ->orderBy('name')
            ->get();

        return response()->json(['data' => $parts]);
    }

    public function store(Request $request, Project $project): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'required|string|max:255',
        ]);

        $duplicate = $project->parts()->where('name', $validated['name'])->exists();
        if ($duplicate) {
            return response()->json([
                'message' => "A part named '{$validated['name']}' already exists for this project.",
            ], 409);
        }

        $part = $project->parts()->create($validated);

        ActivityLogService::log(
            $request,
            'pde',
            'part_create',
            "Created part {$part->name} in {$project->name}",
            Part::class,
            $part->id,
            ['name' => $part->name],
            [
                'project_id' => $project->id,
                'project_name' => $project->name,
                'part_id' => $part->id,
                'part_name' => $part->name,
            ],
        );

        return response()->json(['data' => $part], 201);
    }

    public function destroy(Request $request, Part $part): JsonResponse
    {
        $part->load('project');
        $meta = [
            'project_id' => $part->project_id,
            'project_name' => $part->project?->name,
            'part_id' => $part->id,
            'part_name' => $part->name,
        ];

        ActivityLogService::log(
            $request,
            'pde',
            'part_delete',
            "Deleted part {$part->name} from {$part->project?->name}",
            Part::class,
            $part->id,
            ['name' => $part->name],
            $meta,
        );

        $taskIds = $part->tasks()->pluck('id')->all();
        AlgorithmCache::forgetAssignmentsForTaskIds($taskIds, $request);

        DB::transaction(function () use ($part) {
            $part->tasks()->delete();
            $part->delete();
        });

        ResourceHistogramController::clearFullPayloadCache($request);

        return response()->json(['message' => 'Part deleted successfully.']);
    }
}
