<?php

namespace App\Support;

use App\Models\ProjectTask;
use Carbon\Carbon;
use Illuminate\Support\Collection;

class TaskSyncConflict
{
    public const CODE = 'TASK_SYNC_CONFLICT';

    /**
     * @param  Collection<int|string, ProjectTask>  $serverTasks
     * @param  list<array<string, mixed>>  $incomingTasks
     * @param  list<array<string, mixed>>  $baselineTasks
     * @param  list<int|string>  $dirtyTaskIds
     * @param  array<string|int, string>  $resolutions
     * @param  list<string>  $trackableFields
     * @return array{
     *   overlaps: list<array<string, mixed>>,
     *   delete_ids: list<int>,
     *   update_rows: list<array<string, mixed>>,
     *   create_rows: list<array<string, mixed>>,
     *   restore_rows: list<array<string, mixed>>,
     *   preserved: list<array<string, mixed>>,
     *   skipped_stale: int
     * }
     */
    public static function plan(
        Collection $serverTasks,
        array $incomingTasks,
        array $baselineTasks,
        array $dirtyTaskIds,
        array $resolutions,
        bool $hasBaseline,
        bool $hasDirtyList,
        array $trackableFields,
        callable $normalizeValue,
        callable $normalizeTask,
    ): array {
        $baselineById = [];
        foreach ($baselineTasks as $row) {
            if (! is_array($row)) {
                continue;
            }
            $id = (int) ($row['id'] ?? 0);
            if ($id > 0) {
                $baselineById[$id] = $row;
            }
        }

        $dirty = [];
        foreach ($dirtyTaskIds as $id) {
            $dirty[(int) $id] = true;
        }

        $incomingById = [];
        $createRows = [];
        foreach ($incomingTasks as $row) {
            if (! is_array($row)) {
                continue;
            }
            $id = (int) ($row['id'] ?? 0);
            if ($id > 0) {
                $incomingById[$id] = $row;
                continue;
            }
            $createRows[] = $row;
        }

        $overlaps = [];
        $deleteIds = [];
        $updateRows = [];
        $restoreRows = [];
        $preserved = [];
        $skippedStale = 0;

        foreach ($serverTasks as $task) {
            if (! $task instanceof ProjectTask) {
                continue;
            }
            $id = (int) $task->id;
            if (isset($incomingById[$id]) || isset($baselineById[$id])) {
                continue;
            }
            $preserved[] = self::taskSummary($task, $normalizeTask, 'added');
        }

        if ($hasBaseline) {
            foreach ($baselineById as $id => $baseline) {
                if (isset($incomingById[$id])) {
                    continue;
                }

                $server = self::findTask($serverTasks, $id);
                if (! $server instanceof ProjectTask) {
                    continue;
                }

                $serverChanged = ! self::timestampsMatch(
                    $server->updated_at,
                    $baseline['updated_at'] ?? null,
                );
                $resolution = self::resolutionFor($resolutions, $id);

                if ($serverChanged && $resolution === null) {
                    $overlaps[] = self::overlapPayload(
                        'delete',
                        $id,
                        null,
                        $server,
                        [],
                        $normalizeTask,
                    );
                    continue;
                }

                if ($resolution === 'server') {
                    continue;
                }

                $deleteIds[] = $id;
            }
        }

        foreach ($incomingById as $id => $row) {
            $server = self::findTask($serverTasks, $id);
            $clientChanged = ! $hasDirtyList || isset($dirty[$id]);
            $resolution = self::resolutionFor($resolutions, $id);

            if (! $server instanceof ProjectTask) {
                if (! $clientChanged) {
                    continue;
                }

                if ($resolution === 'server') {
                    continue;
                }

                if ($hasDirtyList && $resolution === null && $hasBaseline) {
                    $overlaps[] = self::overlapPayload(
                        'deleted_on_server',
                        $id,
                        $row,
                        null,
                        [],
                        $normalizeTask,
                    );
                    continue;
                }

                if ($resolution === 'client' || ! $hasDirtyList) {
                    $restoreRows[] = $row;
                }
                continue;
            }

            $expectedUpdatedAt = $row['updated_at']
                ?? ($baselineById[$id]['updated_at'] ?? null);
            $serverChanged = $hasDirtyList
                && $expectedUpdatedAt !== null
                && ! self::timestampsMatch($server->updated_at, $expectedUpdatedAt);

            $payload = self::payloadWithoutMeta($row);
            $fieldChanges = self::diffFields($trackableFields, $server, $payload, $normalizeValue);

            if (! $clientChanged) {
                if ($serverChanged || $fieldChanges !== []) {
                    $skippedStale++;
                }
                continue;
            }

            if ($fieldChanges === []) {
                continue;
            }

            if ($serverChanged && $resolution === null) {
                $overlaps[] = self::overlapPayload(
                    'update',
                    $id,
                    $row,
                    $server,
                    $fieldChanges,
                    $normalizeTask,
                );
                continue;
            }

            if ($resolution === 'server') {
                continue;
            }

            $updateRows[] = $row;
        }

        return [
            'overlaps' => $overlaps,
            'delete_ids' => array_values(array_unique($deleteIds)),
            'update_rows' => $updateRows,
            'create_rows' => $createRows,
            'restore_rows' => $restoreRows,
            'preserved' => $preserved,
            'skipped_stale' => $skippedStale,
        ];
    }

    public static function timestampsMatch(mixed $left, mixed $right): bool
    {
        if (self::isBlankTimestamp($left) && self::isBlankTimestamp($right)) {
            return true;
        }
        if (self::isBlankTimestamp($left) || self::isBlankTimestamp($right)) {
            return false;
        }

        try {
            return Carbon::parse($left)->timestamp === Carbon::parse($right)->timestamp;
        } catch (\Throwable) {
            return (string) $left === (string) $right;
        }
    }

    public static function resolutionFor(array $resolutions, int $id): ?string
    {
        $value = $resolutions[(string) $id] ?? $resolutions[$id] ?? null;
        if ($value === 'ignore') {
            $value = 'server';
        }

        return in_array($value, ['client', 'server'], true) ? $value : null;
    }

    public static function payloadWithoutMeta(array $row): array
    {
        return collect($row)
            ->except(['id', 'updated_at', 'created_at', 'part_id', 'part_name'])
            ->all();
    }

    private static function findTask(Collection $serverTasks, int $id): ?ProjectTask
    {
        $task = $serverTasks->get($id) ?? $serverTasks->get((string) $id);
        if ($task instanceof ProjectTask) {
            return $task;
        }

        $match = $serverTasks->first(
            fn ($candidate) => $candidate instanceof ProjectTask && (int) $candidate->id === $id,
        );

        return $match instanceof ProjectTask ? $match : null;
    }

    private static function isBlankTimestamp(mixed $value): bool
    {
        return $value === null || $value === '';
    }

    /**
     * @param  list<string>  $fields
     * @param  array<string, mixed>  $after
     * @return array<string, array{yours: mixed, saved: mixed}>
     */
    private static function diffFields(
        array $fields,
        ProjectTask $before,
        array $after,
        callable $normalizeValue,
    ): array {
        $changes = [];

        foreach ($fields as $field) {
            $oldValue = $before->getAttribute($field);
            $newValue = $after[$field] ?? null;

            if ($normalizeValue($oldValue) !== $normalizeValue($newValue)) {
                $changes[$field] = [
                    'yours' => $newValue,
                    'saved' => $oldValue,
                ];
            }
        }

        return $changes;
    }

    /**
     * @param  array<string, mixed>|null  $clientRow
     * @param  array<string, array{yours: mixed, saved: mixed}>  $changedFields
     * @return array<string, mixed>
     */
    private static function overlapPayload(
        string $type,
        int $id,
        ?array $clientRow,
        ?ProjectTask $server,
        array $changedFields,
        callable $normalizeTask,
    ): array {
        $taskName = $clientRow['task_name']
            ?? $server?->task_name
            ?? '(untitled)';

        return [
            'id' => $id,
            'task_name' => $taskName,
            'type' => $type,
            'changed_fields' => $changedFields,
            'yours' => $clientRow ? self::conflictView($clientRow) : null,
            'saved' => $server instanceof ProjectTask
                ? self::conflictView($normalizeTask($server))
                : null,
        ];
    }

    /**
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    private static function conflictView(array $row): array
    {
        return [
            'id' => $row['id'] ?? null,
            'task_name' => $row['task_name'] ?? '',
            'plan' => $row['plan'] ?? '',
            'est' => $row['est'] ?? '',
            'pri' => $row['pri'] ?? '',
            'owner' => $row['owner'] ?? '',
            'doc_supply' => $row['doc_supply'] ?? '',
            'completion' => $row['completion'] ?? '',
            'progress_per' => $row['progress_per'] ?? '',
            'done' => $row['done'] ?? false,
        ];
    }

    /**
     * @return array{id: int, task_name: string, reason: string}
     */
    private static function taskSummary(ProjectTask $task, callable $normalizeTask, string $reason): array
    {
        $row = $normalizeTask($task);

        return [
            'id' => (int) $task->id,
            'task_name' => (string) ($row['task_name'] ?? $task->task_name ?? '(untitled)'),
            'reason' => $reason,
        ];
    }
}
