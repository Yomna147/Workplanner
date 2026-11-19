<?php

declare(strict_types=1);

use App\Models\Employee;
use App\Models\Nrm;
use App\Models\ProjectTask;
use App\Support\AlgorithmTaskEligibility;
use App\Support\AlgorithmTaskMapper;
use Carbon\Carbon;

require __DIR__ . '/../vendor/autoload.php';
$app = require __DIR__ . '/../bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

$taskId = (int) ($argv[1] ?? 11904);
$task = ProjectTask::query()->with(['part.project'])->find($taskId);
if (! $task) {
    fwrite(STDERR, "Task {$taskId} not found\n");
    exit(1);
}

$legacy = AlgorithmTaskMapper::toLegacy($task->toArray() + [
    'project_id' => $task->part?->project_id,
    'project_name' => $task->part?->project?->name,
]);

echo "=== Task context ===\n";
echo json_encode([
    'project_id' => $task->part?->project_id,
    'project_name' => $task->part?->project?->name,
    'task_id' => $task->id,
    'task_name' => $task->task_name,
    'plan' => $task->plan,
    'pri' => $task->pri,
    'doc_supply' => (string) $task->doc_supply,
    'completion' => (string) $task->completion,
    'done' => (bool) $task->done,
    'al' => $task->al,
    'ots' => $task->ots,
    'override_1' => $task->override_1,
    'override_2' => $task->override_2,
    'override_3' => $task->override_3,
], JSON_PRETTY_PRINT) . "\n\n";

$nrms = Nrm::query()->orderBy('number')->get();
$skip = AlgorithmTaskEligibility::skipReason($legacy, $nrms);
echo "Eligibility skip reason: " . ($skip ?? 'eligible') . "\n\n";

preg_match('/^\d+\.\d+/', $task->task_name, $m);
$nrmNumber = $m[0] ?? null;
echo "NRM number: {$nrmNumber}\n\n";

$windowStart = Carbon::parse($task->doc_supply)->startOfDay();
$windowEnd = Carbon::parse($task->completion)->addDays(30)->endOfDay();

$overrideNames = array_filter([
    $task->override_1,
    $task->override_2,
    $task->override_3,
]);

foreach ($overrideNames as $name) {
    $employee = Employee::query()
        ->where('first_name', $name)
        ->with(['nrms' => fn ($q) => $q->where('number', $nrmNumber)])
        ->first();

    echo "=== Operative: {$name} ===\n";
    if (! $employee) {
        echo "NOT FOUND in employees table\n\n";
        continue;
    }

    $nrm = $employee->nrms->first();
    echo json_encode([
        'employee_id' => $employee->id,
        'team_id' => $employee->team_id,
        'has_nrm_1_1' => $nrm !== null,
        'oap' => $nrm?->pivot?->OAP,
        'performance' => $nrm?->pivot?->performance_percentage,
    ], JSON_PRETTY_PRINT) . "\n";

    $avail = $employee->availabilities()
        ->whereBetween('date', [$windowStart->toDateString(), $windowEnd->toDateString()])
        ->orderBy('date')
        ->get();

    $bookableDays = 0;
    $totalHours = 0.0;
    $rows = [];
    foreach ($avail as $row) {
        $hours = is_numeric($row->total_ava) ? (float) $row->total_ava : 0.0;
        if ($hours > 0) {
            $bookableDays++;
            $totalHours += $hours;
        }
        if (count($rows) < 20 || $hours > 0) {
            $rows[] = [
                'date' => Carbon::parse($row->date)->toDateString(),
                'hours' => $hours,
            ];
        }
    }

    echo "Bookable days in window: {$bookableDays}\n";
    echo "Total hours in window: " . round($totalHours, 2) . "\n";
    echo "First 15 availability rows:\n";
    foreach (array_slice($rows, 0, 15) as $row) {
        echo "  {$row['date']}: {$row['hours']}h\n";
    }
    echo "\n";
}

// All employees with NRM 1.1
echo "=== All operatives with NRM {$nrmNumber} ===\n";
$withNrm = Employee::query()
    ->whereHas('nrms', fn ($q) => $q->where('number', $nrmNumber))
    ->with(['nrms' => fn ($q) => $q->where('number', $nrmNumber)])
    ->get();

foreach ($withNrm as $employee) {
    $nrm = $employee->nrms->first();
    $avail = $employee->availabilities()
        ->whereBetween('date', [$windowStart->toDateString(), $windowEnd->toDateString()])
        ->get();
    $bookable = $avail->filter(fn ($a) => (float) ($a->total_ava ?? 0) > 0)->count();
    echo sprintf(
        "%s | OAP %s | perf %s | %d bookable days\n",
        $employee->first_name,
        $nrm?->pivot?->OAP ?? '-',
        $nrm?->pivot?->performance_percentage ?? '-',
        $bookable,
    );
}
