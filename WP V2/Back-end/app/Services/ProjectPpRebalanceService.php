<?php

namespace App\Services;

use App\Models\Part;
use App\Models\Project;
use App\Models\ProjectTask;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class ProjectPpRebalanceService
{
    /**
     * @return list<array{project_id: int, name: string, pp: float|null}>
     */
    public function listActiveProjectsOrdered(): array
    {
        $projects = Project::query()
            ->where('status', '!=', 'on_hold')
            ->where('status', '!=', 'completed')
            ->withCount([
                'tasks as tasks_count',
                'tasks as open_tasks_count' => fn ($query) => $query->where('done', false),
            ])
            ->get()
            ->filter(fn (Project $project) => $this->isActiveForPpRebalance($project))
            ->map(function (Project $project) {
                $pp = $this->resolveProjectEffectivePp($project->id);

                return [
                    'project_id' => (int) $project->id,
                    'name' => (string) ($project->name ?? ''),
                    'pp' => $pp,
                ];
            })
            ->sort(function (array $a, array $b) {
                $aPp = $a['pp'];
                $bPp = $b['pp'];

                if ($aPp !== null && $bPp !== null && $aPp !== $bPp) {
                    return $aPp <=> $bPp;
                }
                if ($aPp !== null && $bPp === null) {
                    return -1;
                }
                if ($aPp === null && $bPp !== null) {
                    return 1;
                }

                return $a['project_id'] <=> $b['project_id'];
            })
            ->values()
            ->all();

        return $projects;
    }

    /**
     * @return array<int, string> project_id => even pp string
     */
    public function computeAssignments(
        ?int $targetProjectId = null,
        mixed $requestedPp = null,
        bool $normalizeOnly = false,
    ): array {
        $projects = $this->listActiveProjectsOrdered();
        $orderedIds = array_map(
            static fn (array $entry) => $entry['project_id'],
            $projects,
        );

        $parsedRequest = $this->parsePp($requestedPp);

        if ($normalizeOnly) {
            return $this->assignEvenPps($orderedIds);
        }

        if ($targetProjectId === null) {
            return $this->assignEvenPps($orderedIds);
        }

        if ($parsedRequest === null) {
            $orderedIds = array_values(array_filter(
                $orderedIds,
                static fn (int $projectId) => $projectId !== $targetProjectId,
            ));
            $orderedIds[] = $targetProjectId;

            return $this->assignEvenPps($orderedIds);
        }

        $otherIds = [];
        foreach ($projects as $entry) {
            if ($entry['project_id'] !== $targetProjectId) {
                $otherIds[] = $entry['project_id'];
            }
        }

        return $this->assignEvenPps(
            $this->insertAtRequestedEvenRank($otherIds, $targetProjectId, $parsedRequest),
        );
    }

    /**
     * @param  array<int, string>  $assignments
     * @return list<array{project_id: int, pp: string}>
     */
    public function applyAssignments(array $assignments): array
    {
        $applied = [];

        DB::transaction(function () use ($assignments, &$applied) {
            foreach ($assignments as $projectId => $newPp) {
                $partIds = Part::query()
                    ->where('project_id', $projectId)
                    ->pluck('id');

                if ($partIds->isEmpty()) {
                    continue;
                }

                $tasks = ProjectTask::query()
                    ->whereIn('part_id', $partIds)
                    ->get();

                foreach ($tasks as $task) {
                    $rap = (float) ($task->rap ?? 0);
                    $task->pp = $newPp;
                    $task->pri = $this->formatPri($rap + (float) $newPp);
                    $task->save();
                }

                $applied[] = [
                    'project_id' => (int) $projectId,
                    'pp' => (string) $newPp,
                ];
            }
        });

        return $applied;
    }

    public function rebalance(
        ?int $targetProjectId = null,
        mixed $requestedPp = null,
        bool $normalizeOnly = false,
    ): array {
        $assignments = $this->computeAssignments($targetProjectId, $requestedPp, $normalizeOnly);

        return $this->applyAssignments($assignments);
    }

    public function nextEvenPpForNewProject(): string
    {
        $projects = $this->listActiveProjectsOrdered();
        $maxPp = null;

        foreach ($projects as $entry) {
            if ($entry['pp'] === null) {
                continue;
            }
            if ($maxPp === null || $entry['pp'] > $maxPp) {
                $maxPp = $entry['pp'];
            }
        }

        if ($maxPp === null) {
            return '2';
        }

        $rounded = (int) round($maxPp);

        return (string) ($rounded % 2 === 0 ? $rounded + 2 : $rounded + 1);
    }

    private function isActiveForPpRebalance(Project $project): bool
    {
        $total = (int) ($project->tasks_count ?? 0);
        if ($total === 0) {
            return true;
        }

        return (int) ($project->open_tasks_count ?? 0) > 0;
    }

    private function resolveProjectEffectivePp(int $projectId): ?float
    {
        $max = ProjectTask::query()
            ->whereHas('part', fn ($query) => $query->where('project_id', $projectId))
            ->whereNotNull('pp')
            ->where('pp', '!=', '')
            ->selectRaw('MAX(CAST(pp AS DECIMAL(12,4))) as max_pp')
            ->value('max_pp');

        return $this->parsePp($max);
    }

    private function parsePp(mixed $value): ?float
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (! is_numeric($value)) {
            return null;
        }

        $num = (float) $value;

        return is_finite($num) ? $num : null;
    }

    /**
     * Place the edited project at the even-rank implied by the number they typed
     * (1–2 → first, 3–4 → second, 5–6 → third, …). Other projects keep their
     * current relative order, then compact to 2, 4, 6….
     *
     * @param  list<int>  $otherIds
     * @return list<int>
     */
    private function insertAtRequestedEvenRank(array $otherIds, int $targetProjectId, float $requestedPp): array
    {
        $rank = (int) ceil($requestedPp / 2);
        if ($rank < 1) {
            $rank = 1;
        }

        $insertIndex = min($rank - 1, count($otherIds));
        $nextOrder = array_values($otherIds);
        array_splice($nextOrder, $insertIndex, 0, [$targetProjectId]);

        return $nextOrder;
    }

    /**
     * @param  list<int>  $projectIds
     * @return array<int, string>
     */
    private function assignEvenPps(array $projectIds): array
    {
        $assignments = [];

        foreach (array_values(array_unique($projectIds)) as $index => $projectId) {
            $assignments[$projectId] = (string) (($index + 1) * 2);
        }

        return $assignments;
    }

    private function formatPri(float $value): string
    {
        $rounded = round($value, 2);

        if (abs($rounded - (int) $rounded) < 0.00001) {
            return (string) (int) $rounded;
        }

        return rtrim(rtrim(number_format($rounded, 2, '.', ''), '0'), '.');
    }
}
