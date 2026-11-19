<?php
/**
 * Verify allocation fixes against local AlgoController helpers + DB sample.
 * Run: php scripts/reproduce-live-allocation-failures.php
 */
require __DIR__.'/../vendor/autoload.php';
$app = require __DIR__.'/../bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

use App\Http\Controllers\Api\AlgoController;
use App\Models\ProjectTask;
use Illuminate\Support\Collection;

$passed = 0;
$failed = 0;

function check(string $name, bool $ok, string $detail = ''): void
{
    global $passed, $failed;
    $status = $ok ? 'FIXED' : 'STILL_BROKEN';
    if ($ok) {
        $passed++;
    } else {
        $failed++;
    }
    echo str_pad($status, 14)." {$name}".($detail !== '' ? " — {$detail}" : '')."\n";
}

$controller = app(AlgoController::class);
$ref = new ReflectionClass($controller);

$call = static function (string $method, array $args) use ($ref, $controller) {
    $m = $ref->getMethod($method);
    $m->setAccessible(true);

    return $m->invokeArgs($controller, $args);
};

$employees2 = collect([
    (object) ['id' => 1, 'first_name' => 'Nora', 'last_name' => 'Keshk'],
    (object) ['id' => 2, 'first_name' => 'Abdelrahman', 'last_name' => 'Shakra'],
]);

$taskHyper = [
    'Override_1' => 'Nora Keshk',
    'Override_2' => 'Abdelrahman Shakra',
    'Override_Share_1' => 70,
    'Override_Share_2' => 30,
    'SH' => null,
];
$hyperTargets = $call('buildHypermodeOverrideFairTargets', [100.0, $employees2, $taskHyper]);
check(
    '1–2 pins: HYPERMODE honors UI 70/30',
    $hyperTargets === [70, 30],
    json_encode($hyperTargets)
);

$partialEmployees = collect([
    (object) ['id' => 1, 'first_name' => 'Nora', 'last_name' => 'Keshk'],
    (object) ['id' => 2, 'first_name' => 'Mostafa', 'last_name' => ''],
]);
$partialTargets = $call('buildHypermodeOverrideFairTargets', [100.0, $partialEmployees, [
    'Override_1' => 'Nora Keshk',
    'Override_Share_1' => 70,
    'Override_Share_2' => 30,
]]);
check(
    'Partial pin roster (2 people) keeps 70/30',
    $partialTargets === [70, 30],
    json_encode($partialTargets)
);

$task3 = [
    'Override_Share_1' => 70,
    'Override_Share_2' => 20,
    'Override_Share_3' => 10,
];
$p3 = $call('overrideSharePercentsForSlots', [$task3, [1, 2, 3]]);
check('Control: 3 overrides HARD_SLOT uses 70/20/10', $p3 === [70.0, 20.0, 10.0], json_encode($p3));

$even = $call('buildPlanTargetsForEmployees', [100.0, $employees2, []]);
check('No-share default remains even 50/50', $even === [50, 50], json_encode($even));

$sample = ProjectTask::query()
    ->whereNotNull('algorithm_1')
    ->where('algorithm_1', '!=', '')
    ->whereNotNull('algorithm_2')
    ->where('algorithm_2', '!=', '')
    ->where(function ($q) {
        $q->whereNull('override_3')->orWhere('override_3', '');
    })
    ->where('plan', '>', 10)
    ->orderByDesc('id')
    ->first();

if ($sample) {
    $dbTask = [
        'Override_1' => $sample->algorithm_1,
        'Override_2' => $sample->algorithm_2,
        'Override_Share_1' => 70,
        'Override_Share_2' => 30,
        'SH' => null,
        'plan' => (float) $sample->plan,
    ];
    $dbTargets = $call('buildHypermodeOverrideFairTargets', [
        (float) $sample->plan,
        $employees2,
        $dbTask,
    ]);
    $expected = $call('splitPlanByPercents', [(float) $sample->plan, [70.0, 30.0]]);
    check(
        "DB task #{$sample->id}: 70/30 pins → share-based hours",
        $dbTargets === $expected,
        'targets='.json_encode($dbTargets).' expected='.json_encode($expected)
    );
} else {
    check('DB sample task with 2 algo names', false, 'no matching project_tasks row');
}

echo "\n---\nFixed: {$passed}  Still broken: {$failed}\n";
exit($failed > 0 ? 1 : 0);
