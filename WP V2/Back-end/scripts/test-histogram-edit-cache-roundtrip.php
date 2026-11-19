<?php

/**
 * Live round-trip against local AlgorithmCache (if present).
 * Run: php scripts/test-histogram-edit-cache-roundtrip.php
 */

require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Support\AlgorithmCache;
use App\Support\ApplyHistogramBarEdits;
use App\Support\HistogramScheduleOverrides;
use Illuminate\Http\Request;

$request = Request::create('/');
$cached = AlgorithmCache::get($request);

if (! is_array($cached) || empty($cached['assignmentDetails'])) {
    echo "SKIP  No local algorithm cache — run algorithm first for full round-trip.\n";
    echo "Logic unit tests already cover the fix path.\n";
    exit(0);
}

$details = $cached['assignmentDetails'];
echo 'Cache tasks: '.count($details).PHP_EOL;

$picked = null;
foreach ($details as $detail) {
    $assignments = is_array($detail['assignments'] ?? null) ? $detail['assignments'] : [];
    if (count($assignments) < 2) {
        continue;
    }
    $byEmp = [];
    foreach ($assignments as $row) {
        $emp = trim((string) ($row['employee'] ?? ''));
        $day = trim((string) ($row['date'] ?? ''));
        $hours = (float) ($row['hours'] ?? 0);
        if ($emp === '' || $day === '' || $hours <= 0) {
            continue;
        }
        $byEmp[$emp][$day] = ($byEmp[$emp][$day] ?? 0) + $hours;
    }
    foreach ($byEmp as $emp => $days) {
        if (count($days) >= 2) {
            $picked = [
                'task_id' => (int) ($detail['task_id'] ?? 0),
                'employee' => $emp,
                'hours_by_day' => $days,
                'sh' => $detail['SH'] ?? null,
                'overrides' => [
                    $detail['override_1'] ?? null,
                    $detail['override_2'] ?? null,
                ],
            ];
            break 2;
        }
    }
}

if (! $picked) {
    echo "SKIP  No multi-day assignment found in cache.\n";
    exit(0);
}

echo 'Picked task_id='.$picked['task_id'].' employee='.$picked['employee']
    .' days='.count($picked['hours_by_day'])
    .' SH='.json_encode($picked['sh']).PHP_EOL;

// Shift into a quiet future window so AVA collisions don't dominate the test.
$firstDay = array_key_first($picked['hours_by_day']);
$anchor = date('Y-m-d', strtotime('next monday +8 weeks'));
$shifted = [];
$offset = 0;
foreach ($picked['hours_by_day'] as $hours) {
    // Skip weekends
    do {
        $candidate = date('Y-m-d', strtotime($anchor." +{$offset} days"));
        $offset++;
        $dow = (int) date('N', strtotime($candidate));
    } while ($dow >= 6);
    $shifted[$candidate] = min(8.0, (float) $hours);
}

$beforeTotal = array_sum($picked['hours_by_day']);
$targetTotal = array_sum($shifted);
$edits = [[
    'task_id' => $picked['task_id'],
    'employee' => $picked['employee'],
    'previous_hours_by_day' => $picked['hours_by_day'],
    'hours_by_day' => $shifted,
]];

$afterApply = ApplyHistogramBarEdits::apply($details, $edits);
$afterHours = HistogramScheduleOverrides::extractEmployeeHours(
    $afterApply,
    $picked['task_id'],
    $picked['employee'],
);
$afterTotal = array_sum($afterHours);

echo 'Shifted to '.array_key_first($shifted).' … target='.$targetTotal.PHP_EOL;
echo 'After apply total='.$afterTotal.' (was '.$beforeTotal.') days='.count($afterHours).PHP_EOL;

// Old bug: SH fair-cap on reapply trimmed pins. New: reapply must keep apply result.
$reapplied = HistogramScheduleOverrides::replaceEmployeeSchedule(
    $afterApply,
    $picked['task_id'],
    $picked['employee'],
    $afterHours,
);
$reHours = HistogramScheduleOverrides::extractEmployeeHours(
    $reapplied,
    $picked['task_id'],
    $picked['employee'],
);
$reTotal = array_sum($reHours);

echo 'After reapply total='.$reTotal.' days='.count($reHours).PHP_EOL;

// Also force a "would have been capped" pin: 2 overrides + SH hours smaller than pin.
$forced = $afterApply;
$forced[0]['SH'] = max(1.0, $afterTotal * 0.5);
$forced[0]['override_1'] = $picked['employee'];
$forced[0]['override_2'] = 'Other Person';
$forcedPin = HistogramScheduleOverrides::replaceEmployeeSchedule(
    $forced,
    $picked['task_id'],
    $picked['employee'],
    $afterHours,
);
$forcedHours = HistogramScheduleOverrides::extractEmployeeHours(
    $forcedPin,
    $picked['task_id'],
    $picked['employee'],
);
$forcedTotal = array_sum($forcedHours);
echo 'Forced SH-cap scenario total='.$forcedTotal.' (must stay ~'.$afterTotal.')'.PHP_EOL;

$passReapply = abs($reTotal - $afterTotal) < 0.05;
$passNoFairCap = abs($forcedTotal - $afterTotal) < 0.05;
$passMoved = $afterTotal > 0.5 && empty(array_intersect(array_keys($afterHours), array_keys($picked['hours_by_day'])));

if ($passReapply && $passNoFairCap && $passMoved) {
    echo "PASS  Live cache round-trip: moved, reapply kept hours, SH fair-cap no longer trims pins\n";
    exit(0);
}

echo "FAIL  reapply_ok=".($passReapply?'Y':'N')
    .' faircap_ok='.($passNoFairCap?'Y':'N')
    .' moved_ok='.($passMoved?'Y':'N')."\n";
exit(1);
