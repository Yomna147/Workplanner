<?php
require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$t = App\Models\ProjectTask::find(12096);
if (! $t) {
    echo "not found\n";
    exit(1);
}

echo json_encode([
    'id' => $t->id,
    'part_id' => $t->part_id,
    'project_id' => $t->project_id ?? null,
    'task_name' => $t->task_name ?? $t->name ?? null,
    'plan' => $t->plan,
    'algorithm_1' => $t->algorithm_1,
    'algorithm_2' => $t->algorithm_2,
    'algorithm_3' => $t->algorithm_3,
    'override_1' => $t->override_1,
    'override_2' => $t->override_2,
    'override_3' => $t->override_3,
    'override_share_1' => $t->override_share_1,
    'override_share_2' => $t->override_share_2,
    'override_share_3' => $t->override_share_3,
], JSON_PRETTY_PRINT), PHP_EOL;
