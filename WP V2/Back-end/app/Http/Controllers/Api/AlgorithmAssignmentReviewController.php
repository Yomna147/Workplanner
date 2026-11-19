<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ProjectTask;
use App\Support\AlgorithmCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AlgorithmAssignmentReviewController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        if (! $this->userCanReviewAssignments($request->user())) {
            return response()->json(['message' => 'Forbidden'], 403);
        }

        $validated = $request->validate([
            'project_id' => 'nullable|integer|exists:projects,id',
            'part_id' => 'nullable|integer|exists:parts,id',
        ]);

        $cachedData = AlgorithmCache::get($request);
        $assignmentDetails = is_array($cachedData['assignmentDetails'] ?? null)
            ? $cachedData['assignmentDetails']
            : [];

        if ($assignmentDetails === []) {
            return response()->json([
                'data' => [],
                'algorithm_cache_missing' => true,
                'message' => 'No algorithm assignments found. Run the algorithm first.',
            ]);
        }

        $taskIds = collect($assignmentDetails)
            ->pluck('task_id')
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        $tasksQuery = ProjectTask::query()
            ->select([
                'id',
                'part_id',
                'task_name',
                'plan',
                'pri',
                'algorithm_1',
                'algorithm_2',
                'algorithm_3',
            ])
            ->with([
                'part:id,project_id,name',
                'part.project:id,name,color',
            ])
            ->whereIn('id', $taskIds);

        if (! empty($validated['part_id'])) {
            $tasksQuery->where('part_id', $validated['part_id']);
        } elseif (! empty($validated['project_id'])) {
            $tasksQuery->whereHas(
                'part',
                fn ($query) => $query->where('project_id', $validated['project_id']),
            );
        }

        $tasksById = $tasksQuery->get()->keyBy('id');
        $allowedTaskIds = $tasksById->keys()->all();

        $rows = [];
        foreach ($assignmentDetails as $detail) {
            $taskId = (int) ($detail['task_id'] ?? 0);
            if (! in_array($taskId, $allowedTaskIds, true)) {
                continue;
            }

            /** @var ProjectTask|null $task */
            $task = $tasksById->get($taskId);
            if (! $task) {
                continue;
            }

            $assignments = is_array($detail['assignments'] ?? null) ? $detail['assignments'] : [];
            $normalizedAssignments = [];
            $byDate = [];
            $totalHours = 0.0;

            foreach ($assignments as $assignment) {
                if (! is_array($assignment)) {
                    continue;
                }

                $employee = trim((string) ($assignment['employee'] ?? ''));
                $date = trim((string) ($assignment['date'] ?? ''));
                $hours = is_numeric($assignment['hours'] ?? null) ? (float) $assignment['hours'] : 0.0;

                if ($employee === '' || $date === '' || $hours <= 0) {
                    continue;
                }

                $roundedHours = round($hours, 4);
                $totalHours += $roundedHours;
                $normalizedAssignments[] = [
                    'employee' => $employee,
                    'date' => $date,
                    'hours' => $roundedHours,
                ];

                if (! isset($byDate[$date])) {
                    $byDate[$date] = [];
                }

                $byDate[$date][] = [
                    'employee' => $employee,
                    'hours' => $roundedHours,
                ];
            }

            if ($normalizedAssignments === []) {
                continue;
            }

            usort(
                $normalizedAssignments,
                fn (array $left, array $right) => [$left['date'], $left['employee']] <=> [$right['date'], $right['employee']],
            );

            ksort($byDate);

            $rows[] = [
                'task_id' => $taskId,
                'task_name' => $task->task_name ?? (string) ($detail['task_name'] ?? ''),
                'part_id' => $task->part_id,
                'part_name' => $task->part?->name,
                'project_id' => $task->part?->project_id,
                'project_name' => $task->part?->project?->name,
                'project_color' => $task->part?->project?->color,
                'plan' => $task->plan ?? ($detail['Plan'] ?? null),
                'pri' => $task->pri,
                'algorithm_1' => $task->algorithm_1,
                'algorithm_2' => $task->algorithm_2,
                'algorithm_3' => $task->algorithm_3,
                'total_hours' => round($totalHours, 4),
                'day_count' => count($byDate),
                'assignments' => $normalizedAssignments,
                'by_date' => collect($byDate)
                    ->map(
                        fn (array $entries, string $date) => [
                            'date' => $date,
                            'total_hours' => round(collect($entries)->sum('hours'), 4),
                            'entries' => $entries,
                        ],
                    )
                    ->values()
                    ->all(),
            ];
        }

        usort($rows, function (array $left, array $right) {
            $projectCompare = strcmp((string) ($left['project_name'] ?? ''), (string) ($right['project_name'] ?? ''));
            if ($projectCompare !== 0) {
                return $projectCompare;
            }

            $priCompare = $this->comparePri($left['pri'] ?? null, $right['pri'] ?? null);
            if ($priCompare !== 0) {
                return $priCompare;
            }

            $partCompare = strcmp((string) ($left['part_name'] ?? ''), (string) ($right['part_name'] ?? ''));
            if ($partCompare !== 0) {
                return $partCompare;
            }

            return strcmp((string) ($left['task_name'] ?? ''), (string) ($right['task_name'] ?? ''));
        });

        return response()->json([
            'data' => $rows,
            'algorithm_cache_missing' => false,
            'project_id' => ! empty($validated['project_id']) ? (int) $validated['project_id'] : null,
            'task_count' => count($rows),
        ]);
    }

    private function userCanReviewAssignments($user): bool
    {
        if (! $user) {
            return false;
        }

        $candidates = array_filter([
            strtolower(trim((string) ($user->name ?? ''))),
            strtolower(trim((string) ($user->login_name ?? ''))),
            strtolower(trim(((string) ($user->first_name ?? '')).' '.((string) ($user->last_name ?? '')))),
        ]);

        foreach ($candidates as $candidate) {
            if ($candidate !== ''
                && str_contains($candidate, 'mohamed')
                && str_contains($candidate, 'khal')) {
                return true;
            }
        }

        return false;
    }

    private function comparePri(mixed $left, mixed $right): int
    {
        $leftValue = is_numeric($left) ? (float) $left : null;
        $rightValue = is_numeric($right) ? (float) $right : null;

        if ($leftValue === null && $rightValue === null) {
            return 0;
        }

        if ($leftValue === null) {
            return 1;
        }

        if ($rightValue === null) {
            return -1;
        }

        return $leftValue <=> $rightValue;
    }
}
