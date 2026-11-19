<?php

declare(strict_types=1);

use App\Http\Controllers\Api\AlgoController;
use App\Models\Employee;
use App\Models\ProjectTask;
use App\Support\AlgorithmTaskMapper;
use Carbon\Carbon;
use Illuminate\Http\Request;

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$taskId = 11904;
$task = ProjectTask::query()->with('part.project')->find($taskId);
$legacy = AlgorithmTaskMapper::toLegacy($task->toArray());

$windowStart = Carbon::parse($task->doc_supply)->startOfDay();
$windowEnd = Carbon::parse($task->completion)->addDays(30)->endOfDay();

echo "Task window: {$windowStart->toDateString()} -> {$windowEnd->toDateString()}\n\n";

$overrides = ['Kostadin Radulov', 'Abdelsattar Alfarra', 'Mohamed Khaled'];
$withNrm = Employee::query()
    ->whereHas('nrms', fn ($q) => $q->where('number', '1.1'))
    ->with(['nrms' => fn ($q) => $q->where('number', '1.1')])
    ->get();

foreach ($withNrm as $employee) {
    $avail = $employee->availabilities()
        ->whereBetween('date', [$windowStart->toDateString(), $windowEnd->toDateString()])
        ->orderBy('date')
        ->get();

    $bookable = 0;
    $totalHours = 0.0;
    foreach ($avail as $row) {
        $raw = $row->total_ava ?? $row->total ?? '00:00';
        $hours = is_numeric($raw) ? (float) $raw : 0.0;
        if (is_string($raw) && str_contains($raw, ':')) {
            [$h, $m] = explode(':', $raw);
            $hours = (float) $h + ((float) $m / 60);
        }
        if ($hours > 0) {
            $bookable++;
            $totalHours += $hours;
        }
    }

    echo sprintf(
        "%s%s | bookable days: %d | total hours: %.1f\n",
        $employee->first_name,
        in_array($employee->first_name, $overrides, true) ? ' (override)' : '',
        $bookable,
        $totalHours,
    );
}

echo "\nRunning full algorithm...\n";
$controller = app(AlgoController::class);
$controller->runalgori(Request::create('/api/algorithm/run', 'POST'));

$cached = \App\Support\AlgorithmCache::get(Request::create('/api/algorithm/run', 'POST'));
$detail = collect($cached['assignmentDetails'] ?? [])->first(fn ($r) => (int) ($r['task_id'] ?? 0) === $taskId);
$assigned = array_sum(array_column($detail['assignments'] ?? [], 'hours'));
echo "\nTask 11904 assigned: {$assigned}h\n";
echo "Gap assist active: " . json_encode($detail['gap_assist_extra_employees'] ?? ($detail['_gap_assist_active'] ?? false)) . "\n";
echo "AL: " . json_encode(collect($cached['filteredTasks'] ?? [])->firstWhere('id', $taskId)['AL'] ?? null) . "\n";
