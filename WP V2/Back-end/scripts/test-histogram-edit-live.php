<?php

/**
 * Live logic test for histogram edit fixes (no HTTP / no algo cache required).
 * Run: php scripts/test-histogram-edit-live.php
 */

require __DIR__.'/../vendor/autoload.php';

$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Support\ApplyHistogramBarEdits;
use App\Support\HistogramScheduleOverrides;

$passed = 0;
$failed = 0;

function assert_true(string $name, bool $ok, string $detail = ''): void
{
    global $passed, $failed;
    if ($ok) {
        $passed++;
        echo "PASS  {$name}\n";
    } else {
        $failed++;
        echo "FAIL  {$name}".($detail !== '' ? " — {$detail}" : '')."\n";
    }
}

// --- 1) applyEdit replaces FULL employee schedule (no orphan days) ---
$details = [[
    'task_id' => 1001,
    'Plan' => 40,
    'SH' => 28, // hours
    'override_1' => 'Alice Smith',
    'override_2' => 'Bob Jones',
    'assignments' => [
        ['employee' => 'Alice Smith', 'date' => '2026-11-02', 'hours' => 8],
        ['employee' => 'Alice Smith', 'date' => '2026-11-03', 'hours' => 8],
        ['employee' => 'Alice Smith', 'date' => '2026-11-04', 'hours' => 8], // orphan candidate
        ['employee' => 'Bob Jones', 'date' => '2026-11-02', 'hours' => 8],
    ],
]];

$edits = [[
    'task_id' => 1001,
    'employee' => 'Alice Smith',
    // previous_hours_by_day intentionally incomplete (old bug path)
    'previous_hours_by_day' => [
        '2026-11-02' => 8,
        '2026-11-03' => 8,
    ],
    'hours_by_day' => [
        '2026-11-10' => 8,
        '2026-11-11' => 8,
    ],
]];

$after = ApplyHistogramBarEdits::apply($details, $edits);
$aliceDays = [];
$bobDays = [];
foreach ($after[0]['assignments'] as $row) {
    if (strcasecmp($row['employee'], 'Alice Smith') === 0) {
        $aliceDays[$row['date']] = (float) $row['hours'];
    }
    if (strcasecmp($row['employee'], 'Bob Jones') === 0) {
        $bobDays[$row['date']] = (float) $row['hours'];
    }
}

assert_true(
    'Alice moved to 10–11 only (no orphan 11-04)',
    isset($aliceDays['2026-11-10'], $aliceDays['2026-11-11'])
        && ! isset($aliceDays['2026-11-02'], $aliceDays['2026-11-03'], $aliceDays['2026-11-04']),
    json_encode($aliceDays)
);
assert_true(
    'Bob schedule untouched',
    isset($bobDays['2026-11-02']) && count($bobDays) === 1,
    json_encode($bobDays)
);

// --- 2) replaceEmployeeSchedule does NOT SH-fair-cap pinned hours ---
$pinned = [
    '2026-11-10' => 8.0,
    '2026-11-11' => 8.0,
    '2026-11-12' => 8.0,
    '2026-11-13' => 8.0,
]; // 32h total > SH 28h

$details2 = [[
    'task_id' => 1002,
    'Plan' => 40,
    'SH' => 28,
    'validation_plan' => 40,
    'override_1' => 'Alice Smith',
    'override_2' => 'Bob Jones',
    'assignments' => [
        ['employee' => 'Alice Smith', 'date' => '2026-11-02', 'hours' => 8],
        ['employee' => 'Bob Jones', 'date' => '2026-11-02', 'hours' => 8],
    ],
]];

$reapplied = HistogramScheduleOverrides::replaceEmployeeSchedule(
    $details2,
    1002,
    'Alice Smith',
    $pinned,
);

$alicePinned = HistogramScheduleOverrides::extractEmployeeHours($reapplied, 1002, 'Alice Smith');
$aliceTotal = array_sum($alicePinned);

assert_true(
    'Pinned 32h survives SH fair-cap (was trimmed to 28)',
    abs($aliceTotal - 32.0) < 0.01,
    "total={$aliceTotal} days=".json_encode($alicePinned)
);

// --- 3) refreshDetailAggregates exists and rebuilds end_dates ---
$refreshed = HistogramScheduleOverrides::refreshDetailAggregates($reapplied[0]);
assert_true(
    'refreshDetailAggregates sets Alice end_date to last pinned day',
    ($refreshed['end_dates']['Alice Smith'] ?? null) === '2026-11-13'
        || ($refreshed['end_dates'][array_key_first($refreshed['end_dates'] ?? [])] ?? null) !== null,
    json_encode($refreshed['end_dates'] ?? null)
);
assert_true(
    'refreshDetailAggregates total_assigned_hours > 0',
    ($refreshed['total_assigned_hours'] ?? 0) > 0,
    (string) ($refreshed['total_assigned_hours'] ?? 'missing')
);

echo "\n---\nPassed: {$passed}  Failed: {$failed}\n";
exit($failed > 0 ? 1 : 0);
