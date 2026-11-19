<?php

declare(strict_types=1);

use App\Http\Controllers\Api\AlgoController;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$user = User::query()->first();
if (! $user) {
    fwrite(STDERR, "No user found\n");
    exit(1);
}
Auth::login($user);

$controller = app(AlgoController::class);
$request = Request::create('/api/algorithm/run/init', 'POST');

echo "Init...\n";
$init = $controller->runInit($request);
$initData = json_decode($init->getContent(), true);
$total = (int) ($initData['total_tasks'] ?? 0);
echo "Total tasks: {$total}\n";

$step = 0;
while (true) {
    $step++;
    $response = $controller->runStep($request);
    $data = json_decode($response->getContent(), true);
    $status = $response->getStatusCode();
    $processed = (int) ($data['processed_tasks'] ?? 0);
    $batch = (int) ($data['step_batch_count'] ?? 0);
    $project = (string) ($data['project_name'] ?? '-');
    echo "Step {$step} | HTTP {$status} | processed {$processed}/{$total} | batch {$batch} | {$project}\n";
    if ($status !== 200) {
        echo json_encode($data, JSON_PRETTY_PRINT) . "\n";
        exit(1);
    }
    if (! empty($data['done'])) {
        echo "Done. Assigned task rows: " . count($data['assignmentDetails'] ?? []) . "\n";
        break;
    }
}
