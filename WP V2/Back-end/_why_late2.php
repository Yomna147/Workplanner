<?php
require __DIR__ . '/vendor/autoload.php';
$app = require __DIR__ . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;
use App\Support\AlgorithmCache;
use App\Support\HistogramScheduleOverrides;
use App\Support\AlgorithmSealedAssignments;

$emps = ['Shaimaa Mohamed', 'Nora Keshk', 'Mostafa', 'Nora'];

echo "=== PROJECT ===\n";
print_r(DB::table('projects')->whereIn('id', [2658, 2778])->orWhere('name', 'like', '%Sennybridge%')->get()->toArray());

echo "\n=== TASK 12122 ===\n";
print_r(DB::table('project_tasks')->where('id', 12122)->first());

$extIds = DB::table('project_tasks as t')
    ->join('parts as p', 'p.id', '=', 't.part_id')
    ->whereIn('p.project_id', [2658, 2778])
    ->where('t.task_name', 'like', '%2.5%External%')
    ->pluck('t.id')
    ->all();
echo "\nExternal walls task ids: " . json_encode($extIds) . "\n";

$all2658 = DB::table('project_tasks as t')
    ->join('parts as p', 'p.id', '=', 't.part_id')
    ->whereIn('p.project_id', [2658, 2778])
    ->where('t.task_name', 'like', '%2.5%')
    ->get(['t.id', 't.task_name', 't.doc_supply', 't.progress_left_hours', 't.progress_plan', 't.override_1', 't.override_2', 't.override_3', 't.override_share_1', 't.override_share_2', 't.override_share_3', 't.pri', 'p.project_id']);
foreach ($all2658 as $row) {
    echo json_encode($row) . "\n";
}

$cached = AlgorithmCache::get();
$details = is_array($cached['assignmentDetails'] ?? null) ? $cached['assignmentDetails'] : [];
echo "\nCache assignmentDetails count: " . count($details) . "\n";

$partTaskIds = DB::table('project_tasks as t')
    ->join('parts as p', 'p.id', '=', 't.part_id')
    ->whereIn('p.project_id', [2658, 2778])
    ->pluck('t.id')
    ->map(fn ($id) => (int) $id)
    ->all();
$idSet = array_fill_keys(array_merge($partTaskIds, [12122, 12170, 12278]), true);

foreach ($details as $d) {
    $tid = (int) ($d['task_id'] ?? 0);
    if (! isset($idSet[$tid])) {
        continue;
    }
  $byEmp = [];
    foreach ($d['assignments'] ?? [] as $a) {
        $n = (string) ($a['employee_name'] ?? $a['employee'] ?? '?');
        $day = substr((string) ($a['date'] ?? $a['day'] ?? ''), 0, 10);
        if ($day === '') {
            continue;
        }
        if (! isset($byEmp[$n])) {
            $byEmp[$n] = ['first' => $day, 'last' => $day, 'hours' => 0.0, 'nov' => []];
        }
        $h = (float) ($a['hours'] ?? 0);
        $byEmp[$n]['hours'] += $h;
        if ($day < $byEmp[$n]['first']) {
            $byEmp[$n]['first'] = $day;
        }
        if ($day > $byEmp[$n]['last']) {
            $byEmp[$n]['last'] = $day;
        }
        if ($day >= '2026-11-15' && $day <= '2026-12-15') {
            $byEmp[$n]['nov'][$day] = ($byEmp[$n]['nov'][$day] ?? 0) + $h;
        }
    }
    $name = $d['task_name'] ?? '';
    echo "\n--- Cache task $tid ($name) ---\n";
    foreach ($byEmp as $en => $info) {
        if (! array_intersect([$en], $emps) && ! str_contains($en, 'Shaimaa') && ! str_contains($en, 'Nora') && ! str_contains($en, 'Mostafa')) {
            continue;
        }
        echo "$en: first={$info['first']} last={$info['last']} total_h={$info['hours']} nov_dec=" . json_encode($info['nov']) . "\n";
    }
    if ($byEmp === []) {
        echo "(no assignments)\n";
    }
}

echo "\n=== Histogram overrides (2658 tasks) ===\n";
$pins = HistogramScheduleOverrides::pinnedSchedules();
foreach ($pins as $taskId => $pin) {
    if (! isset($idSet[(int) $taskId])) {
        continue;
    }
    echo "task $taskId pin: " . json_encode($pin) . "\n";
}

echo "\n=== Sealed assignments sample ===\n";
try {
    $sealed = DB::table('algorithm_sealed_assignments')->whereIn('task_id', array_keys($idSet))->limit(20)->get();
    foreach ($sealed as $s) {
        echo json_encode($s) . "\n";
    }
} catch (Throwable $e) {
    echo $e->getMessage() . "\n";
}

echo "\n=== AVA Shaimaa Nov 2026 ===\n";
$shId = DB::table('employees')->where('name', 'like', '%Shaimaa%')->value('id');
echo "Shaimaa id=$shId\n";
if ($shId) {
    $rows = DB::table('employee_availabilities')
        ->where('employee_id', $shId)
        ->whereBetween('date', ['2026-11-17', '2026-12-05'])
        ->orderBy('date')
        ->get(['date', 'total_ava', 'total']);
    foreach ($rows as $r) {
        $hol = ($r->total_ava === '00:00' || $r->total_ava === '0' || $r->total === '00:00') ? ' H' : '';
        echo "{$r->date} ava={$r->total_ava}{$hol}\n";
    }
}

echo "\n=== Task pri order (sample around 12122) ===\n";
$pri = DB::table('project_tasks')->whereIn('id', array_merge($partTaskIds, [12122]))->orderBy('pri')->get(['id', 'task_name', 'pri', 'doc_supply']);
foreach ($pri as $p) {
    if ((int) $p->id === 12122 || str_contains($p->task_name, '2.5')) {
        echo "id={$p->id} pri={$p->pri} doc_supply={$p->doc_supply} {$p->task_name}\n";
    }
}
