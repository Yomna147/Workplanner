<?php

namespace App\Services;

use App\Models\Part;
use App\Models\Project;
use Illuminate\Support\Arr;
use Illuminate\Validation\ValidationException;

class ProjectCopyService
{
    private const ALL_TASK_FIELDS = [
        'task_name',
        'est',
        'hrs_per',
        'red',
        'dl',
        'rfi',
        'pd',
        'buf',
        'adj',
        'plan',
        'doc_supply',
        'con',
        'completion',
        'pp',
        'rap',
        'pri',
        'hbs',
        'ats',
        'ots',
        'dd',
        'sp',
        'algorithm_1',
        'algorithm_2',
        'algorithm_3',
        'override_1',
        'override_2',
        'override_3',
        'override_share_1',
        'override_share_2',
        'override_share_3',
        'progress_updated',
        'progress_per',
        'progress_left_hours',
        'progress_plan',
        'act',
        'pre',
        'duration_left',
        'done',
        'owner',
        'project_completion_date',
    ];

    private const ALLOCATION_FIELDS = [
        'task_name',
        'doc_supply',
        'completion',
        'rap',
        'algorithm_1',
        'algorithm_2',
        'algorithm_3',
        'override_1',
        'override_2',
        'override_3',
        'override_share_1',
        'override_share_2',
        'override_share_3',
    ];

    private const WITHOUT_DATA_FIELDS = [
        'task_name',
        'doc_supply',
        'completion',
        'rap',
    ];

    public function copy(array $payload): array
    {
        $type = $payload['type'];
        $sourceProject = Project::findOrFail($payload['source_project_id']);
        $sourcePart = $this->resolveSourcePart($sourceProject, $payload['source_part_id'] ?? null);

        if (! $sourcePart) {
            throw ValidationException::withMessages([
                'source_part_id' => 'No part found to copy from.',
            ]);
        }

        $overrides = $this->buildOverrides($payload);

        if ($type === 'duplicate_part') {
            return $this->duplicatePart($sourceProject, $sourcePart, $payload['part_name'], $overrides);
        }

        $targetProject = $this->createOrFindProject(
            $payload['project_name'],
            $payload['color'] ?? null,
            $sourceProject,
        );

        if ($targetProject->parts()->where('name', $payload['part_name'])->exists()) {
            throw ValidationException::withMessages([
                'part_name' => "A part named '{$payload['part_name']}' already exists for this project.",
            ]);
        }

        $targetPart = $targetProject->parts()->create(['name' => $payload['part_name']]);
        $this->copyTasks($sourcePart, $targetPart, $type, $overrides);

        return [
            'message' => 'Copy completed successfully.',
            'type' => $type,
            'project' => $targetProject->load('team'),
            'part' => $targetPart,
        ];
    }

    private function duplicatePart(
        Project $project,
        Part $sourcePart,
        string $partName,
        array $overrides,
    ): array {
        if ($project->parts()->where('name', $partName)->exists()) {
            throw ValidationException::withMessages([
                'part_name' => "A part named '{$partName}' already exists for this project.",
            ]);
        }

        $targetPart = $project->parts()->create(['name' => $partName]);
        $this->copyTasks($sourcePart, $targetPart, 'with_all_data', $overrides);

        return [
            'message' => 'Part duplicated successfully.',
            'type' => 'duplicate_part',
            'project' => $project->load('team'),
            'part' => $targetPart,
        ];
    }

    private function resolveSourcePart(Project $project, ?int $partId): ?Part
    {
        if ($partId) {
            return $project->parts()->where('id', $partId)->first();
        }

        return $project->parts()->orderBy('id')->first();
    }

    private function buildOverrides(array $payload): array
    {
        return array_filter([
            'doc_supply' => $payload['start_date'] ?? null,
            'completion' => $payload['end_date'] ?? null,
            'pp' => isset($payload['pp']) ? (string) $payload['pp'] : null,
        ], fn ($value) => $value !== null && $value !== '');
    }

    private function createOrFindProject(string $name, ?string $color, Project $sourceProject): Project
    {
        $existing = Project::where('name', $name)->first();
        if ($existing) {
            return $existing;
        }

        return Project::create([
            'name' => $name,
            'color' => $color ?: $sourceProject->color ?: '#3B82F6',
            'status' => $sourceProject->status,
            'description' => $sourceProject->description,
            'team_id' => $sourceProject->team_id,
            'have_all_docs' => $sourceProject->have_all_docs,
        ]);
    }

    private function copyTasks(Part $sourcePart, Part $targetPart, string $type, array $overrides): void
    {
        $fields = match ($type) {
            'with_allocation' => self::ALLOCATION_FIELDS,
            'without_data' => self::WITHOUT_DATA_FIELDS,
            default => self::ALL_TASK_FIELDS,
        };

        foreach ($sourcePart->tasks as $task) {
            $data = Arr::only($task->toArray(), $fields);
            $data = array_merge($data, $overrides);
            $data['pri'] = $this->calculatePri($data);
            $data['done'] = false;

            if ($type === 'with_allocation' || $type === 'without_data') {
                $data = $this->stripProgressAndHours($data);
            }

            $targetPart->tasks()->create($data);
        }
    }

    private function stripProgressAndHours(array $data): array
    {
        foreach ([
            'est', 'hrs_per', 'red', 'dl', 'plan', 'pd', 'buf', 'adj',
            'progress_updated', 'progress_per', 'progress_left_hours', 'progress_plan',
            'act', 'pre', 'duration_left', 'owner', 'project_completion_date',
        ] as $field) {
            unset($data[$field]);
        }

        return $data;
    }

    private function calculatePri(array $data): ?string
    {
        $rap = is_numeric($data['rap'] ?? null) ? (float) $data['rap'] : 0;
        $pp = is_numeric($data['pp'] ?? null) ? (float) $data['pp'] : 0;

        if ($rap === 0.0 && $pp === 0.0) {
            return $data['pri'] ?? null;
        }

        return (string) ($rap + $pp);
    }
}
