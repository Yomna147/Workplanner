<?php

declare(strict_types=1);

use App\Http\Controllers\Api\AlgoController;
use App\Models\Project;
use App\Models\ProjectTask;
use Illuminate\Http\Request;

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

$projectId = (int) ($argv[1] ?? 2652);
$taskPrefix = (string) ($argv[2] ?? '1.1');

$project = Project::query()->with('parts.tasks')->find($projectId);
if (! $project) {
    fwrite(STDERR, "Project {$projectId} not found\n");
    exit(1);
}

$task = ProjectTask::query()
    ->whereHas('part', fn ($q) => $q->where('project_id', $projectId))
    ->where('task_name', 'like', $taskPrefix . '%')
    ->first();

if (! $task) {
    fwrite(STDERR, "Task matching '{$taskPrefix}' not found on project {$projectId}\n");
    exit(1);
}

echo "=== Project ===\n";
echo json_encode([
    'id' => $project->id,
    'name' => $project->name,
    'status' => $project->status,
], JSON_PRETTY_PRINT) . "\n\n";

echo "=== Task (before run) ===\n";
echo json_encode($task->only([
    'id', 'part_id', 'task_name', 'plan', 'est', 'pri', 'pp',
    'doc_supply', 'completion', 'done', 'progress_per',
    'al', 'ots', 'ts', 'sh', 'dd',
    'algorithm_1', 'algorithm_2', 'algorithm_3',
    'override_1', 'override_2', 'override_3',
]), JSON_PRETTY_PRINT) . "\n\n";

$request = Request::create('/api/algorithm/run', 'POST', [], [], [], [
    'HTTP_ACCEPT' => 'application/json',
]);

$controller = app(AlgoController::class);
$response = $controller->runalgori($request);
$payload = json_decode($response->getContent(), true);

if ($response->getStatusCode() !== 200) {
    fwrite(STDERR, "Algorithm failed: " . ($payload['error'] ?? $payload['message'] ?? 'unknown') . "\n");
    exit(1);
}

$filteredTasks = $payload['filteredTasks'] ?? [];
$assignmentDetails = [];
$cached = \App\Support\AlgorithmCache::get($request);
if (is_array($cached['assignmentDetails'] ?? null)) {
    $assignmentDetails = $cached['assignmentDetails'];
}

$taskResult = collect($filteredTasks)->first(fn ($row) => (int) ($row['id'] ?? 0) === (int) $task->id);
$taskDetail = collect($assignmentDetails)->first(fn ($row) => (int) ($row['task_id'] ?? 0) === (int) $task->id);

$skipped = collect($payload['skipped_tasks'] ?? [])->first(fn ($row) => (int) ($row['id'] ?? 0) === (int) $task->id);

echo "=== Algorithm summary ===\n";
echo json_encode([
    'message' => $payload['message'] ?? null,
    'task_count' => $payload['task_count'] ?? count($filteredTasks),
    'skipped_count' => $payload['skipped_count'] ?? 0,
    'task_in_results' => $taskResult !== null,
    'task_skipped' => $skipped,
], JSON_PRETTY_PRINT) . "\n\n";

if ($taskResult) {
    echo "=== Task assignment output ===\n";
    echo json_encode([
        'id' => $taskResult['id'] ?? null,
        'TaskName' => $taskResult['TaskName'] ?? null,
        'Pri' => $taskResult['Pri'] ?? null,
        'Plan' => $taskResult['Plan'] ?? null,
        'Algorithm_1' => $taskResult['Algorithm_1'] ?? null,
        'Algorithm_2' => $taskResult['Algorithm_2'] ?? null,
        'Algorithm_3' => $taskResult['Algorithm_3'] ?? null,
        'TS' => $taskResult['TS'] ?? null,
        'AL' => $taskResult['AL'] ?? null,
        'SH' => $taskResult['SH'] ?? null,
        'DD' => $taskResult['DD'] ?? null,
        'mode' => $taskDetail['mode'] ?? null,
        'adjusted_plan' => $taskDetail['adjusted_plan'] ?? null,
        'performance_subbranch_active' => $taskDetail['performance_subbranch_active'] ?? null,
        'primary_employee' => $taskDetail['primary_employee'] ?? null,
        'secondary_employee' => $taskDetail['secondary_employee'] ?? null,
        'tertiary_employee' => $taskDetail['tertiary_employee'] ?? null,
        'assignment_count' => count($taskDetail['assignments'] ?? []),
        'total_assigned_hours' => round(array_sum(array_map(
            fn ($row) => (float) ($row['hours'] ?? 0),
            $taskDetail['assignments'] ?? [],
        )), 2),
    ], JSON_PRETTY_PRINT) . "\n\n";

    if (! empty($taskDetail['assignments'])) {
        echo "=== Per-day assignments ===\n";
        foreach ($taskDetail['assignments'] as $row) {
            echo sprintf(
                "%s | %s | %.2fh\n",
                $row['date'] ?? '-',
                $row['employee'] ?? '-',
                (float) ($row['hours'] ?? 0),
            );
        }
        echo "\n";

        $byEmployee = [];
        foreach ($taskDetail['assignments'] as $row) {
            $name = (string) ($row['employee'] ?? 'unknown');
            $byEmployee[$name] = ($byEmployee[$name] ?? 0) + (float) ($row['hours'] ?? 0);
        }
        echo "=== Hours by employee ===\n";
        foreach ($byEmployee as $name => $hours) {
            echo sprintf("%s: %.2fh\n", $name, $hours);
        }
        echo "\n";
    }
} else {
    echo "=== Task NOT assigned ===\n";
    if ($skipped) {
        echo json_encode($skipped, JSON_PRETTY_PRINT) . "\n\n";
    }
}

// Reload task from DB after cache (not saved unless save-results called)
$task->refresh();
echo "=== Task DB state after run (cache only, not saved) ===\n";
echo json_encode($task->only([
    'algorithm_1', 'algorithm_2', 'algorithm_3', 'ts', 'al',
]), JSON_PRETTY_PRINT) . "\n";
