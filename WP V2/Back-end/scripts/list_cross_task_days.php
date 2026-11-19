<?php

require __DIR__.'/../vendor/autoload.php';

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Support\AlgorithmCache;

$details = AlgorithmCache::get()['assignmentDetails'] ?? [];
$multi = [];

foreach ($details as $td) {
    foreach ($td['assignments'] ?? [] as $a) {
        $emp = trim((string) ($a['employee'] ?? ''));
        $date = substr((string) ($a['date'] ?? ''), 0, 10);
        $hrs = (float) ($a['hours'] ?? 0);
        if ($emp === '' || $date === '' || $hrs <= 0) {
            continue;
        }
        $key = $emp.'|'.$date;
        $taskId = (int) ($td['task_id'] ?? 0);
        if (! isset($multi[$key][$taskId])) {
            $multi[$key][$taskId] = [
                'pri' => $td['Pri'] ?? null,
                'hrs' => 0.0,
                'name' => $td['task_name'] ?? '',
            ];
        }
        $multi[$key][$taskId]['hrs'] += $hrs;
    }
}

$count = 0;
foreach ($multi as $key => $tasks) {
    if (count($tasks) < 2) {
        continue;
    }
    $count++;
    echo $key.PHP_EOL;
    foreach ($tasks as $tid => $info) {
        echo sprintf(
            "  task %d | pri %s | %.1fh | %s\n",
            $tid,
            $info['pri'] ?? '-',
            $info['hrs'],
            $info['name'],
        );
    }
    echo PHP_EOL;
}

echo "Total employee-days with 2+ tasks: {$count}\n";
