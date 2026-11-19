<?php

require __DIR__.'/../vendor/autoload.php';

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Support\AlgorithmCache;

$details = AlgorithmCache::get()['assignmentDetails'] ?? [];
$focus = ['Kostadin Radulov', 'Abdelsattar Alfarra', 'Mohamed Khaled', 'Mina Tarek', 'Mostafa'];

foreach ($focus as $employee) {
    echo PHP_EOL."=== {$employee} ===".PHP_EOL;
    $rows = [];
    foreach ($details as $td) {
        foreach ($td['assignments'] ?? [] as $a) {
            if (strcasecmp(trim((string) ($a['employee'] ?? '')), $employee) !== 0) {
                continue;
            }
            $hrs = (float) ($a['hours'] ?? 0);
            $date = substr((string) ($a['date'] ?? ''), 0, 10);
            if ($hrs <= 0 || $date === '') {
                continue;
            }
            $rows[] = [
                'date' => $date,
                'hours' => $hrs,
                'task_id' => (int) ($td['task_id'] ?? 0),
                'pri' => $td['Pri'] ?? null,
                'name' => $td['task_name'] ?? '',
            ];
        }
    }
    usort($rows, fn ($a, $b) => $a['date'] <=> $b['date']);
    $prev = null;
    foreach ($rows as $r) {
        $gap = '';
        if ($prev) {
            $diff = (strtotime($r['date']) - strtotime($prev['date'])) / 86400;
            if ($diff > 1) {
                $gap = "  <-- {$diff} day gap from prev";
            }
        }
        $partial = $r['hours'] < 7.99 ? ' (partial day)' : '';
        echo "{$r['date']} | {$r['hours']}h | task {$r['task_id']} pri {$r['pri']} | {$r['name']}{$partial}{$gap}".PHP_EOL;
        $prev = $r;
    }
}
