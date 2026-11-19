<?php

declare(strict_types=1);

use App\Support\AlgorithmCache;
use Illuminate\Http\Request;

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

$taskId = (int) ($argv[1] ?? 11904);
$request = Request::create('/api/algorithm/run', 'POST');
$cached = AlgorithmCache::get($request);
$details = $cached['assignmentDetails'] ?? [];
$filtered = $cached['filteredTasks'] ?? [];

$target = collect($details)->first(fn ($row) => (int) ($row['task_id'] ?? 0) === $taskId);
$targetTask = collect($filtered)->first(fn ($row) => (int) ($row['id'] ?? 0) === $taskId);

if (! $target) {
    fwrite(STDERR, "Task {$taskId} not in algorithm cache. Run algorithm first.\n");
    exit(1);
}

$targetPri = (float) ($target['Pri'] ?? $targetTask['Pri'] ?? INF);
$employees = ['Kostadin Radulov', 'Abdelsattar Alfarra', 'Mohamed Khaled'];

echo "=== Target task ===\n";
echo json_encode([
    'task_id' => $taskId,
    'task_name' => $target['task_name'] ?? $targetTask['TaskName'] ?? null,
    'Pri' => $targetPri,
    'Plan' => $target['Plan'] ?? $targetTask['Plan'] ?? null,
    'mode' => $target['mode'] ?? null,
    'assignments' => count($target['assignments'] ?? []),
    'hours' => round(array_sum(array_column($target['assignments'] ?? [], 'hours')), 2),
], JSON_PRETTY_PRINT) . "\n\n";

echo "=== Higher-priority tasks using same overrides (processed before) ===\n";
$competing = [];
foreach ($details as $row) {
    $pri = (float) ($row['Pri'] ?? INF);
    if ($pri >= $targetPri) {
        continue;
    }
    foreach ($row['assignments'] ?? [] as $assignment) {
        $emp = (string) ($assignment['employee'] ?? '');
        if (! in_array($emp, $employees, true)) {
            continue;
        }
        $competing[] = [
            'task_id' => $row['task_id'] ?? null,
            'task_name' => $row['task_name'] ?? null,
            'Pri' => $pri,
            'employee' => $emp,
            'date' => $assignment['date'] ?? null,
            'hours' => (float) ($assignment['hours'] ?? 0),
        ];
    }
}

usort($competing, fn ($a, $b) => [$a['Pri'], $a['date']] <=> [$b['Pri'], $b['date']]);

$byTask = [];
foreach ($competing as $row) {
    $key = (string) ($row['task_id'] ?? '');
    $byTask[$key]['task_name'] = $row['task_name'];
    $byTask[$key]['Pri'] = $row['Pri'];
    $byTask[$key]['hours'] = ($byTask[$key]['hours'] ?? 0) + $row['hours'];
}
uasort($byTask, fn ($a, $b) => $a['Pri'] <=> $b['Pri']);

foreach (array_slice($byTask, 0, 25, true) as $id => $info) {
    echo sprintf(
        "Pri %s | task %s | %s | %.1fh total on overrides\n",
        $info['Pri'],
        $id,
        $info['task_name'] ?? '-',
        $info['hours'],
    );
}

echo "\n=== Override employee hours consumed before target task (by date) ===\n";
$byEmpDate = [];
foreach ($competing as $row) {
    $key = $row['employee'] . '|' . $row['date'];
    $byEmpDate[$key] = ($byEmpDate[$key] ?? 0) + $row['hours'];
}
ksort($byEmpDate);
foreach ($byEmpDate as $key => $hours) {
    if (str_starts_with($key, 'Kostadin') || str_starts_with($key, 'Abdelsattar') || str_starts_with($key, 'Mohamed')) {
        [$emp, $date] = explode('|', $key, 2);
        if ($date >= '2026-07-22' && $date <= '2026-09-05') {
            echo sprintf("%s | %s | %.1fh consumed earlier\n", $date, $emp, $hours);
        }
    }
}

echo "\n=== Target task assignments ===\n";
foreach ($target['assignments'] ?? [] as $row) {
    echo sprintf(
        "%s | %s | %.2fh\n",
        $row['date'] ?? '-',
        $row['employee'] ?? '-',
        (float) ($row['hours'] ?? 0),
    );
}

$plan = (float) ($target['Plan'] ?? $targetTask['Plan'] ?? 0);
$assigned = array_sum(array_map(fn ($r) => (float) ($r['hours'] ?? 0), $target['assignments'] ?? []));
echo "\nPlan: {$plan}h | Assigned: " . round($assigned, 2) . "h | Shortfall: " . round($plan - $assigned, 2) . "h\n";
