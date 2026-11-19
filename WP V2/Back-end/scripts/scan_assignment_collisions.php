<?php

require __DIR__.'/../vendor/autoload.php';

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\HistogramScheduleOverride;
use App\Models\ProjectTask;
use App\Support\AlgorithmCache;
use App\Support\ApplyHistogramBarEdits;

$details = AlgorithmCache::get()['assignmentDetails'] ?? [];

echo 'Cached tasks: '.count($details).PHP_EOL;
$overloads = ApplyHistogramBarEdits::findEmployeeDayOverloads($details);
echo 'Employee/day overloads (over available hours): '.count($overloads).PHP_EOL;

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
        if (! isset($multi[$key])) {
            $multi[$key] = [];
        }
        $multi[$key][] = (int) ($td['task_id'] ?? 0);
    }
}
$sharedDays = array_filter($multi, fn (array $tasks) => count(array_unique($tasks)) >= 2);
echo 'Employee-days with 2+ different tasks: '.count($sharedDays).PHP_EOL;

$dates = ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];
$focusEmployees = ['Abdelrahman Hakiem', 'Mostafa', 'Mina Tarek', 'Todor Tanev', 'Khaled Maged', 'Nour El Khatib', 'Nora Keshk'];

foreach ($dates as $date) {
    echo PHP_EOL."=== {$date} ===".PHP_EOL;
    $rows = [];
    foreach ($details as $taskDetail) {
        foreach ($taskDetail['assignments'] ?? [] as $assignment) {
            $day = substr((string) ($assignment['date'] ?? ''), 0, 10);
            if ($day !== $date) {
                continue;
            }
            $hours = (float) ($assignment['hours'] ?? 0);
            if ($hours <= 0) {
                continue;
            }
            $rows[] = [
                'employee' => trim((string) ($assignment['employee'] ?? '')),
                'task_id' => (int) ($taskDetail['task_id'] ?? 0),
                'hours' => $hours,
                'mode' => (string) ($taskDetail['mode'] ?? ''),
            ];
        }
    }

    $totals = [];
    foreach ($rows as $row) {
        $totals[$row['employee']] = ($totals[$row['employee']] ?? 0) + $row['hours'];
    }

    foreach ($focusEmployees as $employee) {
        $employeeRows = array_values(array_filter(
            $rows,
            fn (array $row) => strcasecmp($row['employee'], $employee) === 0,
        ));
        if ($employeeRows === []) {
            continue;
        }
        $total = $totals[$employee] ?? 0;
        echo "{$employee}: {$total}h across ".count($employeeRows)." assignment row(s)".PHP_EOL;
        foreach ($employeeRows as $row) {
            $task = ProjectTask::find($row['task_id']);
            $name = $task?->task_name ?? 'task#'.$row['task_id'];
            echo "  - {$row['task_id']} {$name}: {$row['hours']}h ({$row['mode']})".PHP_EOL;
        }
    }
}

echo PHP_EOL.'Histogram schedule overrides: '.HistogramScheduleOverride::count().PHP_EOL;
foreach (HistogramScheduleOverride::all() as $override) {
    $hoursByDay = is_array($override->hours_by_day) ? $override->hours_by_day : [];
    $total = array_sum(array_map('floatval', $hoursByDay));
    echo "  task {$override->task_id} | {$override->employee} | ".count($hoursByDay)." days | {$total}h total".PHP_EOL;
}
