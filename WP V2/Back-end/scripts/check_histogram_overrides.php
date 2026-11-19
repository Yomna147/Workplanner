<?php
require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$taskId = (int) ($argv[1] ?? 11904);
$rows = App\Models\HistogramScheduleOverride::query()->where('task_id', $taskId)->get();
foreach ($rows as $row) {
    $total = array_sum(array_map('floatval', $row->hours_by_day ?? []));
    echo $row->employee . " | total={$total}h | " . json_encode($row->hours_by_day) . PHP_EOL;
}
echo 'override count=' . $rows->count() . PHP_EOL;
