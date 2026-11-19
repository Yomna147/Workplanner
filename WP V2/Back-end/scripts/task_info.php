<?php
require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$taskId = (int) ($argv[1] ?? 11904);
$t = App\Models\ProjectTask::find($taskId);
echo json_encode([
    'DD' => $t->dd,
    'Hbs' => $t->hbs,
    'hrsPer' => $t->hrs_per,
    'doc_supply' => $t->doc_supply,
    'completion' => $t->completion,
    'override1' => $t->override_1,
    'override2' => $t->override_2,
    'override3' => $t->override_3,
    'AL' => $t->al,
    'SH' => $t->sh,
], JSON_PRETTY_PRINT) . "\n";
