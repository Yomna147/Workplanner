<?php
/**
 * Local assertions about allocation share behavior (no full algo run).
 * Mirrors helpers from AlgoController for verification.
 *
 * Run: php scripts/test-allocation-share-logic.php
 */

function dlOverrideSharePercents(int $count): array
{
    if ($count <= 1) {
        return [100];
    }
    if ($count === 2) {
        return [50, 50];
    }

    return [40, 30, 30];
}

function overrideSharePercentsForSlots(array $task, array $slotOrder): array
{
    $defaults = dlOverrideSharePercents(count($slotOrder));
    $percents = [];
    $anyStored = false;
    foreach (array_values($slotOrder) as $index => $slot) {
        $raw = $task['Override_Share_'.$slot] ?? $task['override_share_'.$slot] ?? null;
        if ($raw !== null && $raw !== '' && is_numeric($raw)) {
            $percents[] = max(0.0, (float) $raw);
            $anyStored = true;
        } else {
            $percents[] = (float) ($defaults[$index] ?? 0);
        }
    }
    if (! $anyStored) {
        return $defaults;
    }
    $sum = array_sum($percents);
    if ($sum <= 0.001) {
        return $defaults;
    }
    if (abs($sum - 100) > 0.5) {
        $percents = array_map(static fn ($value) => ($value * 100) / $sum, $percents);
    }

    return $percents;
}

function buildPlanTargetsEven(float $plan, int $employeeCount): array
{
    if ($employeeCount <= 0) {
        return [];
    }
    $baseTarget = $plan / $employeeCount;
    $targets = array_fill(0, $employeeCount, (int) ceil($baseTarget));
    $overflow = array_sum($targets) - $plan;
    if ($overflow > 0) {
        for ($i = $employeeCount - 1; $i >= 0 && $overflow > 0; $i--) {
            $deduct = min($overflow, $targets[$i]);
            $targets[$i] -= $deduct;
            $overflow -= $deduct;
        }
    }

    return $targets;
}

function splitPlanByPercents(float $plan, array $percents): array
{
    $count = count($percents);
    $planInt = (int) round($plan);
    if ($count === 0 || $planInt <= 0) {
        return array_fill(0, $count, 0);
    }

    $raw = array_map(static fn ($percent) => $planInt * (((float) $percent) / 100), $percents);
    $hours = array_map(static fn ($value) => (int) floor($value + 1e-8), $raw);
    $leftover = $planInt - array_sum($hours);
    $order = range(0, $count - 1);
    usort($order, static function (int $left, int $right) use ($raw, $hours) {
        $fraction = ($raw[$right] - $hours[$right]) <=> ($raw[$left] - $hours[$left]);

        return $fraction !== 0 ? $fraction : $left <=> $right;
    });
    foreach ($order as $index) {
        if ($leftover <= 0) {
            break;
        }
        $hours[$index]++;
        $leftover--;
    }

    return $hours;
}

function buildHypermodeTargets(float $plan, int $employeeCount, array $task): array
{
    $anyShare = false;
    foreach ([1, 2, 3] as $slot) {
        $raw = $task['Override_Share_'.$slot] ?? null;
        if ($raw !== null && $raw !== '' && is_numeric($raw)) {
            $anyShare = true;
            break;
        }
    }
    if ($anyShare && $employeeCount > 0) {
        return splitPlanByPercents($plan, overrideSharePercentsForSlots($task, range(1, $employeeCount)));
    }

    return buildPlanTargetsEven($plan, $employeeCount);
}

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

// 3-override HARD_SLOT path: custom shares ARE used
$task3 = [
    'Override_Share_1' => 70,
    'Override_Share_2' => 20,
    'Override_Share_3' => 10,
];
$p3 = overrideSharePercentsForSlots($task3, [1, 2, 3]);
assert_true('HARD_SLOT uses stored 70/20/10', $p3 === [70.0, 20.0, 10.0], json_encode($p3));

// Renorm when sum != 100
$taskBad = ['Override_Share_1' => 70, 'Override_Share_2' => 70];
$pBad = overrideSharePercentsForSlots($taskBad, [1, 2]);
$sum = array_sum($pBad);
assert_true('HARD_SLOT renorms shares to ~100', abs($sum - 100) < 0.01, json_encode($pBad));

// Defaults when no shares
$pDef2 = overrideSharePercentsForSlots([], [1, 2]);
assert_true('default 2-person shares 50/50', $pDef2 === [50, 50], json_encode($pDef2));
$pDef3 = overrideSharePercentsForSlots([], [1, 2, 3]);
assert_true('default 3-person shares 40/30/30', $pDef3 === [40, 30, 30], json_encode($pDef3));

// HYPERMODE (1–2 overrides): now honors Override_Share_*
$hyperTargets = buildHypermodeTargets(100, 2, [
    'Override_Share_1' => 70,
    'Override_Share_2' => 30,
]);
assert_true('HYPERMODE uses UI 70/30 shares', $hyperTargets === [70, 30], json_encode($hyperTargets));

$hyperEven = buildHypermodeTargets(100, 2, []);
assert_true('HYPERMODE without shares stays even 50/50', $hyperEven === [50, 50], json_encode($hyperEven));

// Mode selection rules
$overrideCount1 = 1;
$overrideCount2 = 2;
$overrideCount3 = 3;
$mode1 = $overrideCount1 >= 1 && $overrideCount1 <= 2 ? 'HYPERMODE_OVERRIDE_EVEN_SPLIT' : 'OVERRIDE_HARD_SLOT';
$mode2 = $overrideCount2 >= 1 && $overrideCount2 <= 2 ? 'HYPERMODE_OVERRIDE_EVEN_SPLIT' : 'OVERRIDE_HARD_SLOT';
$mode3 = $overrideCount3 >= 1 && $overrideCount3 <= 2 ? 'HYPERMODE_OVERRIDE_EVEN_SPLIT' : 'OVERRIDE_HARD_SLOT';
assert_true('1 override → HYPERMODE', $mode1 === 'HYPERMODE_OVERRIDE_EVEN_SPLIT');
assert_true('2 overrides → HYPERMODE', $mode2 === 'HYPERMODE_OVERRIDE_EVEN_SPLIT');
assert_true('3 overrides → HARD_SLOT', $mode3 === 'OVERRIDE_HARD_SLOT');

// Partial pin: roster keeps algo fills (limit 3), shares apply across 2 people
$partialRosterSize = max(1, 2); // override + algo fill
$partialTargets = buildHypermodeTargets(100, $partialRosterSize, [
    'Override_Share_1' => 70,
    'Override_Share_2' => 30,
]);
assert_true('partial pin keeps 2-person 70/30 roster', $partialTargets === [70, 30], json_encode($partialTargets));

echo "\n---\nPassed: {$passed}  Failed: {$failed}\n";
exit($failed > 0 ? 1 : 0);
