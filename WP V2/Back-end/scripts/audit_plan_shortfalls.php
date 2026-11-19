<?php

declare(strict_types=1);

use App\Http\Controllers\Api\AlgoController;
use App\Support\AlgorithmCache;
use Illuminate\Http\Request;

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$controller = app(AlgoController::class);
$controller->runalgori(Request::create('/api/algorithm/run', 'POST'));

$cached = AlgorithmCache::get(Request::create('/api/algorithm/run', 'POST'));
$details = $cached['assignmentDetails'] ?? [];
$tasks = collect($cached['filteredTasks'] ?? [])->keyBy('id');

$shortfalls = [];
foreach ($details as $row) {
    $taskId = (int) ($row['task_id'] ?? 0);
    $plan = (float) ($row['validation_plan'] ?? $row['Plan'] ?? $tasks->get($taskId)['Plan'] ?? 0);
    $assigned = array_sum(array_map(fn ($a) => (float) ($a['hours'] ?? 0), $row['assignments'] ?? []));
    $remaining = round($plan - $assigned, 2);
    if ($plan > 0 && $remaining > 0.01) {
        $shortfalls[] = [
            'task_id' => $taskId,
            'name' => $row['task_name'] ?? null,
            'plan' => $plan,
            'assigned' => round($assigned, 2),
            'shortfall' => $remaining,
            'mode' => $row['mode'] ?? null,
        ];
    }
}

usort($shortfalls, fn ($a, $b) => $b['shortfall'] <=> $a['shortfall']);

echo 'Tasks with plan shortfall: ' . count($shortfalls) . PHP_EOL;
foreach (array_slice($shortfalls, 0, 15) as $item) {
    echo sprintf(
        "task %d | %s | plan %.1f | assigned %.1f | short %.1fh | %s\n",
        $item['task_id'],
        $item['name'] ?? '-',
        $item['plan'],
        $item['assigned'],
        $item['shortfall'],
        $item['mode'] ?? '-',
    );
}
