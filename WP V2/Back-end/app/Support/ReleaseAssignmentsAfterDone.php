<?php

namespace App\Support;

use App\Http\Controllers\Api\ResourceHistogramController;
use App\Models\HistogramScheduleOverride;
use App\Models\ProjectTask;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;

/**
 * When a task is marked done, drop algorithm / histogram hours after the
 * actual completion date so those operative-days are free again.
 */
class ReleaseAssignmentsAfterDone
{
    /**
     * @param  list<int>|null  $taskIds  null = every done task present in the assignment cache
     */
    public static function apply(?Request $request = null, ?array $taskIds = null): bool
    {
        $cached = AlgorithmCache::get($request);
        $details = is_array($cached['assignmentDetails'] ?? null)
            ? $cached['assignmentDetails']
            : [];

        $limitIds = self::normalizeIdList($taskIds ?? []);
        $candidateIds = $limitIds !== []
            ? $limitIds
            : self::taskIdsFromDetails($details);

        $doneTasks = self::loadDoneTasks($candidateIds);
        if ($doneTasks->isEmpty() && $limitIds === []) {
            return false;
        }

        $changed = false;
        if ($details !== [] && $doneTasks->isNotEmpty()) {
            [$clipped, $detailsChanged] = self::clipAssignmentDetails($details, $doneTasks);
            if ($detailsChanged) {
                AlgorithmCache::put([
                    ...(is_array($cached) ? $cached : []),
                    'assignmentDetails' => $clipped,
                ], $request);
                $changed = true;
            }
        }

        if ($doneTasks->isNotEmpty()) {
            if (AlgorithmSealedAssignments::clipStoredForDoneTasks($doneTasks)) {
                $changed = true;
            }
            if (self::clipOverridesForTasks($doneTasks)) {
                $changed = true;
            }
        }

        if ($changed) {
            ResourceHistogramController::clearFullPayloadCache($request);
        }

        return $changed;
    }

    /**
     * @param  array<int, array<string, mixed>>  $details
     * @param  Collection<int, ProjectTask>|null  $doneTasks
     * @return array{0: array<int, array<string, mixed>>, 1: bool}
     */
    public static function clipAssignmentDetails(array $details, ?Collection $doneTasks = null): array
    {
        if ($details === []) {
            return [[], false];
        }

        $doneTasks ??= self::loadDoneTasks(self::taskIdsFromDetails($details));
        if ($doneTasks->isEmpty()) {
            return [$details, false];
        }

        $changed = false;
        $next = [];

        foreach ($details as $detail) {
            $taskId = (int) ($detail['task_id'] ?? 0);
            $task = $taskId > 0 ? $doneTasks->get($taskId) : null;
            $cutoff = $task ? self::cutoffYmd($task) : null;
            if ($cutoff === null) {
                $next[] = $detail;
                continue;
            }

            $assignments = is_array($detail['assignments'] ?? null) ? $detail['assignments'] : [];
            $clipped = self::clipAssignmentRows($assignments, $cutoff);
            if (count($clipped) !== count($assignments)) {
                $changed = true;
            }

            if ($clipped === []) {
                $changed = true;
                continue;
            }

            $detail['assignments'] = $clipped;
            $next[] = $detail;
        }

        return [array_values($next), $changed];
    }

    /**
     * @param  array<int, array<string, mixed>>  $assignments
     * @return array<int, array<string, mixed>>
     */
    public static function clipAssignmentRows(array $assignments, string $keepThroughYmd): array
    {
        $kept = [];
        foreach ($assignments as $row) {
            if (! is_array($row)) {
                continue;
            }
            $date = self::toYmd($row['date'] ?? null);
            if ($date === null || $date <= $keepThroughYmd) {
                $kept[] = $row;
            }
        }

        return array_values($kept);
    }

    public static function clipTaskAssignments(ProjectTask $task, array $assignments): array
    {
        $cutoff = self::cutoffYmd($task);
        if ($cutoff === null) {
            return $assignments;
        }

        return self::clipAssignmentRows($assignments, $cutoff);
    }

    public static function cutoffYmd(ProjectTask $task): ?string
    {
        if (! DlMirrorFields::isTruthy($task->done)) {
            return null;
        }

        return self::toYmd($task->project_completion_date)
            ?: self::toYmd($task->dl_project_completion_date)
            ?: Carbon::now()->toDateString();
    }

    public static function toYmd(mixed $value): ?string
    {
        $raw = trim((string) ($value ?? ''));
        if ($raw === '') {
            return null;
        }

        if (preg_match('/^(\d{4}-\d{2}-\d{2})/', $raw, $matches) === 1) {
            return $matches[1];
        }

        try {
            return Carbon::parse($raw)->toDateString();
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * @param  list<int>  $taskIds
     * @return Collection<int, ProjectTask>
     */
    private static function loadDoneTasks(array $taskIds): Collection
    {
        $ids = self::normalizeIdList($taskIds);
        if ($ids === []) {
            return collect();
        }

        return ProjectTask::query()
            ->whereIn('id', $ids)
            ->where('done', true)
            ->get(['id', 'done', 'project_completion_date', 'dl_project_completion_date'])
            ->keyBy('id');
    }

    /**
     * @param  Collection<int, ProjectTask>  $doneTasks
     */
    private static function clipOverridesForTasks(Collection $doneTasks): bool
    {
        if ($doneTasks->isEmpty()) {
            return false;
        }

        $changed = false;
        $overrides = HistogramScheduleOverride::query()
            ->whereIn('task_id', $doneTasks->keys()->all())
            ->get();

        foreach ($overrides as $override) {
            $task = $doneTasks->get((int) $override->task_id);
            $cutoff = $task ? self::cutoffYmd($task) : null;
            if ($cutoff === null) {
                continue;
            }

            $hours = is_array($override->hours_by_day) ? $override->hours_by_day : [];
            $kept = [];
            foreach ($hours as $day => $value) {
                $ymd = self::toYmd($day);
                if ($ymd === null || $ymd <= $cutoff) {
                    $kept[$day] = $value;
                }
            }

            if ($kept === []) {
                $override->delete();
                $changed = true;
                continue;
            }

            if (count($kept) !== count($hours)) {
                $override->hours_by_day = $kept;
                $override->save();
                $changed = true;
            }
        }

        return $changed;
    }

    /**
     * @param  array<int, array<string, mixed>>  $details
     * @return list<int>
     */
    private static function taskIdsFromDetails(array $details): array
    {
        $ids = [];
        foreach ($details as $detail) {
            $id = (int) ($detail['task_id'] ?? 0);
            if ($id > 0) {
                $ids[] = $id;
            }
        }

        return self::normalizeIdList($ids);
    }

    /**
     * @param  array<int, int|string>  $taskIds
     * @return list<int>
     */
    private static function normalizeIdList(array $taskIds): array
    {
        return array_values(array_unique(array_filter(
            array_map('intval', $taskIds),
            fn ($id) => $id > 0,
        )));
    }
}
