<?php

namespace App\Support;

use App\Models\ProjectTask;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/**
 * Keeps algorithm assignments for done tasks / completed projects so a later
 * run cannot reuse those operative-days, and the histogram can still show them.
 */
class AlgorithmSealedAssignments
{
    public const CACHE_KEY = 'cachedData:sealedAssignments';

    /**
     * Snapshot sealed assignment rows from the live algorithm cache plus any
     * previously sealed rows that are still done/completed.
     *
     * @return array<int, array<string, mixed>>
     */
    public static function snapshot(?Request $request = null): array
    {
        $cached = AlgorithmCache::get($request);
        $fromMain = is_array($cached['assignmentDetails'] ?? null)
            ? $cached['assignmentDetails']
            : [];
        $fromStored = self::storedDetails();

        $merged = self::mergeByTaskId($fromStored, $fromMain);
        $sealed = self::filterSealedDetails($merged);
        self::put($sealed);

        return $sealed;
    }

    /**
     * Persist the sealed subset of a full assignment-details payload.
     *
     * @param  array<int, array<string, mixed>>  $assignmentDetails
     */
    public static function persistFromAssignmentDetails(array $assignmentDetails): void
    {
        $merged = self::mergeByTaskId(self::storedDetails(), $assignmentDetails);
        self::put(self::filterSealedDetails($merged));
    }

    /**
     * @param  array<int, int|string>  $taskIds
     */
    public static function forgetForTaskIds(array $taskIds): void
    {
        $ids = array_fill_keys(
            collect($taskIds)
                ->map(fn ($id) => (int) $id)
                ->filter(fn ($id) => $id > 0)
                ->unique()
                ->all(),
            true,
        );

        if ($ids === []) {
            return;
        }

        $stored = self::storedDetails();
        if ($stored === []) {
            return;
        }

        $filtered = array_values(array_filter(
            $stored,
            fn ($detail) => ! isset($ids[(int) ($detail['task_id'] ?? 0)]),
        ));

        if (count($filtered) === count($stored)) {
            return;
        }

        self::put($filtered);
    }

    /**
     * Drop sealed hours after a done task's completion date.
     *
     * @param  \Illuminate\Support\Collection<int, ProjectTask>  $doneTasks
     */
    public static function clipStoredForDoneTasks($doneTasks): bool
    {
        if ($doneTasks->isEmpty()) {
            return false;
        }

        $stored = self::storedDetails();
        if ($stored === []) {
            return false;
        }

        [$clipped, $changed] = ReleaseAssignmentsAfterDone::clipAssignmentDetails($stored, $doneTasks);
        if (! $changed) {
            return false;
        }

        self::put(self::filterSealedDetails($clipped));

        return true;
    }

    /**
     * @param  array<int, array<string, mixed>>  $details
     * @return array<int, array<string, mixed>>
     */
    public static function filterSealedDetails(array $details): array
    {
        if ($details === []) {
            return [];
        }

        $taskIds = collect($details)
            ->map(fn ($detail) => (int) ($detail['task_id'] ?? 0))
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        $sealedIds = self::sealedTaskIdSet($taskIds);
        if ($sealedIds === []) {
            return [];
        }

        $tasks = ProjectTask::query()
            ->whereIn('id', array_keys($sealedIds))
            ->get(['id', 'done', 'project_completion_date', 'dl_project_completion_date'])
            ->keyBy('id');

        $filtered = [];
        foreach ($details as $detail) {
            $taskId = (int) ($detail['task_id'] ?? 0);
            if ($taskId <= 0 || ! isset($sealedIds[$taskId])) {
                continue;
            }

            $assignments = is_array($detail['assignments'] ?? null) ? $detail['assignments'] : [];
            $task = $tasks->get($taskId);
            if ($task) {
                $assignments = ReleaseAssignmentsAfterDone::clipTaskAssignments($task, $assignments);
            }
            if ($assignments === []) {
                continue;
            }

            $detail['assignments'] = $assignments;
            $detail['sealed'] = true;
            $filtered[] = $detail;
        }

        return $filtered;
    }

    /**
     * @param  list<int>  $taskIds
     * @return array<int, true>
     */
    public static function sealedTaskIdSet(array $taskIds): array
    {
        $ids = array_values(array_unique(array_filter(
            array_map('intval', $taskIds),
            fn ($id) => $id > 0,
        )));

        if ($ids === []) {
            return [];
        }

        return ProjectTask::query()
            ->whereIn('id', $ids)
            ->whereHas('part.project')
            ->where(function ($query) {
                $query->where('done', true)
                    ->orWhereHas('part.project', function ($projectQuery) {
                        $projectQuery->where('status', 'completed');
                    });
            })
            ->pluck('id')
            ->mapWithKeys(fn ($id) => [(int) $id => true])
            ->all();
    }

    /**
     * @param  array<int, array<string, mixed>>  $base
     * @param  array<int, array<string, mixed>>  $overlay
     * @return array<int, array<string, mixed>>
     */
    public static function mergeByTaskId(array $base, array $overlay): array
    {
        $byId = [];

        foreach ([$base, $overlay] as $source) {
            foreach ($source as $detail) {
                $taskId = (int) ($detail['task_id'] ?? 0);
                if ($taskId <= 0) {
                    continue;
                }

                $byId[$taskId] = $detail;
            }
        }

        return array_values($byId);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private static function storedDetails(): array
    {
        $stored = Cache::get(self::CACHE_KEY);

        return is_array($stored['assignmentDetails'] ?? null)
            ? $stored['assignmentDetails']
            : [];
    }

    /**
     * @param  array<int, array<string, mixed>>  $details
     */
    private static function put(array $details): void
    {
        Cache::forever(self::CACHE_KEY, [
            'assignmentDetails' => array_values($details),
        ]);
    }
}
