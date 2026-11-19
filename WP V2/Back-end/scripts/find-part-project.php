<?php
require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$part = App\Models\Part::with('project')->find(712);
echo json_encode([
    'part_id' => $part?->id,
    'part_name' => $part?->name,
    'project_id' => $part?->project_id,
    'project_name' => $part?->project?->name,
], JSON_PRETTY_PRINT), PHP_EOL;
