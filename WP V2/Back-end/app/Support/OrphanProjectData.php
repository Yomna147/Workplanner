<?php

namespace App\Support;

use App\Http\Controllers\Api\ResourceHistogramController;
use App\Models\Part;
use App\Models\ProjectTask;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class OrphanProjectData
{
    /**
     * Remove tasks and parts left behind when a project was deleted without
     * cascading (legacy deletes / missing FK enforcement).
     *
     * @return array{tasks: int, parts: int}
     */
    public static function purge(?Request $request = null): array
    {
        $orphanPartIds = Part::query()
            ->whereDoesntHave('project')
            ->pluck('id')
            ->map(fn ($id) => (int) $id)
            ->all();

        $taskIdsOnOrphanParts = $orphanPartIds === []
            ? []
            : ProjectTask::query()
                ->whereIn('part_id', $orphanPartIds)
                ->pluck('id')
                ->map(fn ($id) => (int) $id)
                ->all();

        $tasksWithoutPartIds = ProjectTask::query()
            ->where(function ($query) {
                $query->whereNull('part_id')
                    ->orWhereDoesntHave('part');
            })
            ->pluck('id')
            ->map(fn ($id) => (int) $id)
            ->all();

        $taskIds = array_values(array_unique([...$taskIdsOnOrphanParts, ...$tasksWithoutPartIds]));

        if ($taskIds === [] && $orphanPartIds === []) {
            return ['tasks' => 0, 'parts' => 0];
        }

        AlgorithmCache::forgetAssignmentsForTaskIds($taskIds, $request);

        DB::transaction(function () use ($taskIds, $orphanPartIds) {
            if ($taskIds !== []) {
                ProjectTask::query()->whereIn('id', $taskIds)->delete();
            }

            if ($orphanPartIds !== []) {
                Part::query()->whereIn('id', $orphanPartIds)->delete();
            }
        });

        ResourceHistogramController::clearFullPayloadCache($request);

        return [
            'tasks' => count($taskIds),
            'parts' => count($orphanPartIds),
        ];
    }
}
