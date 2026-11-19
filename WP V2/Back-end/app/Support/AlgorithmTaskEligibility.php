<?php

namespace App\Support;

use App\Models\Nrm;
use App\Models\ProjectTask;
use Illuminate\Support\Collection;

class AlgorithmTaskEligibility
{
    /**
     * @return list<array<string, mixed>>
     */
    public static function loadReviewableTasks(): array
    {
        OrphanProjectData::purge();

        return ProjectTask::query()
            ->where(function ($query) {
                $query->where('done', false)->orWhereNull('done');
            })
            ->whereHas('part.project')
            ->whereNotNull('plan')
            ->where('plan', '!=', '')
            ->whereNotNull('doc_supply')
            ->where('doc_supply', '!=', '')
            ->whereNotNull('completion')
            ->where('completion', '!=', '')
            ->with(['part:id,project_id', 'part.project:id,name'])
            ->orderBy('pri')
            ->orderBy('created_at')
            ->orderBy('id')
            ->get()
            ->map(function (ProjectTask $task) {
                $data = $task->toArray();
                $data['project_id'] = $task->part?->project_id;
                $data['project_name'] = $task->part?->project?->name;

                return AlgorithmTaskMapper::toLegacy($data);
            })
            ->values()
            ->all();
    }

    /**
     * @param  list<array<string, mixed>>  $tasks
     * @param  Collection<int, Nrm>  $nrms
     * @return array{0: list<array<string, mixed>>, 1: list<array<string, mixed>>}
     */
    public static function partition(array $tasks, Collection $nrms): array
    {
        $eligible = [];
        $skipped = [];

        foreach ($tasks as $task) {
            $reason = self::skipReason($task, $nrms);
            if ($reason !== null) {
                $skipped[] = self::toSkippedEntry($task, $reason);
                continue;
            }

            $eligible[] = $task;
        }

        return [$eligible, $skipped];
    }

    /**
     * @param  array<string, mixed>  $task
     */
    public static function skipReason(array $task, Collection $nrms): ?string
    {
        $taskName = trim((string) ($task['TaskName'] ?? ''));
        if ($taskName === '') {
            return 'Missing task name';
        }

        if (! empty($task['Done'])) {
            return 'Task is marked done';
        }

        $plan = $task['Plan'] ?? null;
        if (! is_numeric($plan) || (float) $plan <= 0) {
            return 'Missing or invalid Plan hours';
        }

        if (empty($task['Doc_Supply']) || ! self::isValidDate($task['Doc_Supply'])) {
            return 'Missing or invalid Doc Supply date';
        }

        if (empty($task['Completion']) || ! self::isValidDate($task['Completion'])) {
            return 'Missing or invalid Completion date';
        }

        if (! preg_match('/^\d+\.\d+/', $taskName)) {
            return 'Task name must start with an NRM number (e.g. 2.1)';
        }

        if (self::resolveNrmByTaskName($taskName, $nrms) === null) {
            return 'Task name does not match a known NRM section';
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $task
     * @return array{id: mixed, task_name: string, project_id: mixed, project_name: string, reason: string}
     */
    public static function toSkippedEntry(array $task, string $reason): array
    {
        return [
            'id' => $task['id'] ?? null,
            'task_name' => (string) ($task['TaskName'] ?? ''),
            'project_id' => $task['project_id'] ?? null,
            'project_name' => (string) ($task['project_name'] ?? 'Unknown project'),
            'reason' => $reason,
        ];
    }

    /**
     * @param  Collection<int, Nrm>  $nrms
     */
    public static function resolveNrmByTaskName(string $taskName, Collection $nrms): ?Nrm
    {
        $taskName = NrmCatalog::normalizeTaskNamePrefix(trim($taskName));
        if ($taskName === '') {
            return null;
        }

        $taskLower = strtolower($taskName);
        $withoutPrefix = strtolower(trim((string) preg_replace('/^\d+(?:\.\d+)?\s*[-–—]\s*/u', '', $taskName)));

        foreach ($nrms as $nrm) {
            $name = strtolower(trim((string) ($nrm->name ?? '')));
            $scName = strtolower(trim((string) ($nrm->sc_name ?? '')));

            if ($name !== '' && (str_contains($taskLower, $name) || ($withoutPrefix !== '' && str_contains($withoutPrefix, $name)))) {
                return $nrm;
            }

            if ($scName !== '' && (str_contains($taskLower, $scName) || ($withoutPrefix !== '' && str_contains($withoutPrefix, $scName)))) {
                return $nrm;
            }
        }

        return null;
    }

    private static function isValidDate(mixed $value): bool
    {
        if ($value === null || $value === '') {
            return false;
        }

        return strtotime((string) $value) !== false;
    }

    public static function hasAlgorithmAssignment(ProjectTask|array $task): bool
    {
        foreach (['algorithm_1', 'algorithm_2', 'algorithm_3'] as $field) {
            $value = $task instanceof ProjectTask
                ? $task->{$field}
                : ($task[$field] ?? null);

            if (trim((string) ($value ?? '')) !== '') {
                return true;
            }
        }

        return false;
    }
}
