/**
 * Local smoke tests for Person + Hours Share allocation utils.
 * Run: node scripts/test-allocation-logic.mjs
 */
import {
  buildAllocationSlots,
  displayHourShares,
  redistributeHourShares,
  hasManualAllocation,
  clearAllocationOverridePatch,
  unpinAllocationSlotPatch,
  algorithmNames,
  estimateAlgoHours,
  sharesFromHours,
  equalHourShares,
  nextAllocationSlot,
  sharePatchFromValues,
  storedHourShares,
} from '../src/utils/dlQuickUpdate.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Baseline display / slots ---
{
  const task = {
    algorithm_1: 'Mostafa',
    algorithm_2: 'Abdelrahman Hakiem',
    plan: 100,
  };
  const slots = buildAllocationSlots(task);
  assert('grey slots from algo only', slots.length === 2 && slots.every((s) => s.source === 'algo'));
  assert('algo display shares 50/50 (BE-aligned)', eq(displayHourShares(task, 2), [50, 50]), String(displayHourShares(task, 2)));
  assert('no Reset when pure algo', hasManualAllocation(task) === false);
}

{
  const hours = estimateAlgoHours(['A', 'B', 'C'], 100);
  assert('algo 3-way estimate even split hours', eq(hours, [34, 34, 32]), String(hours));
  assert('algo 3-way display equalHourShares 40/30/30', eq(equalHourShares(3), [40, 30, 30]));
}

// --- Redistribute ---
{
  const next = redistributeHourShares([50, 50], 0, 70);
  assert('50/50 → edit 70 → 70/30', eq(next, [70, 30]), String(next));
}
{
  const next = redistributeHourShares([40, 30, 30], 0, 50);
  assert('3-way redistribute totals 100', next.reduce((s, n) => s + n, 0) === 100, String(next));
}
{
  const next = redistributeHourShares([100], 0, 40);
  assert('single slot always 100', eq(next, [100]), String(next));
}

// --- Pinning / mixed ---
{
  const task = {
    algorithm_1: 'Nora Keshk',
    algorithm_2: 'Abdelrahman Shakra',
    override_1: 'Nora Keshk',
    override_share_1: '70',
    override_share_2: '30',
    plan: 44,
  };
  const slots = buildAllocationSlots(task);
  assert('mixed orange+grey after one pin', slots[0].source === 'manual' && slots[1].source === 'algo', JSON.stringify(slots.map((s) => s.source)));
  assert('stored shares used when present', eq(displayHourShares(task, 2), [70, 30]));
  assert('Reset shown when shares/override set', hasManualAllocation(task) === true);
}

// --- Reset patch ---
{
  const patch = clearAllocationOverridePatch();
  assert('reset clears overrides', patch.override_1 === '' && patch.override_2 === '' && patch.override_3 === '');
  assert('reset clears shares', patch.override_share_1 === '' && patch.override_share_2 === '' && patch.override_share_3 === '');
}

// --- + Add equal shares ---
{
  assert('add 2nd person equal 50/50', eq(equalHourShares(2), [50, 50]));
  assert('add 3rd person 40/30/30', eq(equalHourShares(3), [40, 30, 30]));
  const task = { algorithm_1: 'A', algorithm_2: 'B' };
  assert('next free slot is 3', nextAllocationSlot(task) === 3);
  const full = { algorithm_1: 'A', algorithm_2: 'B', algorithm_3: 'C' };
  assert('full roster no free slot', nextAllocationSlot(full) === null);
}

// --- Unpin clears shares when last pin removed ---
{
  const task = {
    algorithm_1: 'A',
    algorithm_2: 'B',
    override_1: 'A',
    override_share_1: '70',
    override_share_2: '30',
  };
  const patch = unpinAllocationSlotPatch(task, 1);
  assert('unpin last pin clears override', patch.override_1 === '');
  assert('unpin last pin clears shares', patch.override_share_1 === '' && patch.override_share_2 === '' && patch.override_share_3 === '');
  const after = { ...task, ...patch };
  assert('after unpin no manual allocation', hasManualAllocation(after) === false);
  assert('after unpin display returns 50/50', eq(displayHourShares(after, 2), [50, 50]));
}

{
  const task = {
    override_1: 'A',
    override_2: 'B',
    override_share_1: '70',
    override_share_2: '30',
  };
  const patch = unpinAllocationSlotPatch(task, 1);
  assert('delete manual-only emp clears that override', patch.override_1 === '');
  assert('delete manual-only emp re-equalizes remaining shares', patch.override_share_1 === '100' && patch.override_share_2 === '' && patch.override_share_3 === '');
  const after = { ...task, ...patch };
  assert('after delete only B remains', buildAllocationSlots(after).length === 1 && buildAllocationSlots(after)[0].name === 'B');
}

{
  const task = {
    algorithm_1: 'A',
    algorithm_2: 'B',
    override_1: 'C',
    override_share_1: '70',
    override_share_2: '30',
  };
  const patch = unpinAllocationSlotPatch(task, 1);
  assert('X with algo underneath resets override', patch.override_1 === '');
  assert('X reset to algo clears shares when last pin', patch.override_share_1 === '' && patch.override_share_2 === '');
  const after = { ...task, ...patch };
  const slots = buildAllocationSlots(after);
  assert('after reset shows algorithm A again', slots[0].name === 'A' && slots[0].source === 'algo');
}

{
  const task = {
    algorithm_1: 'A',
    algorithm_2: 'B',
    algorithm_3: 'C',
  };
  const patch = unpinAllocationSlotPatch(task, 2);
  assert('X on algo chip clears algorithm', patch.algorithm_2 === '');
  assert('X on algo chip does not touch overrides', patch.override_2 === undefined);
  const after = { ...task, ...patch };
  const slots = buildAllocationSlots(after);
  assert('after algo delete two remain', slots.length === 2 && slots[0].name === 'A' && slots[1].name === 'C');
}

// --- Partial stored shares renorm to ~100 ---
{
  const task = { override_share_1: '70', algorithm_1: 'A', algorithm_2: 'B' };
  const shares = storedHourShares(task, 2);
  assert('partial stored shares renorm to ~100', Math.abs(shares.reduce((s, n) => s + n, 0) - 100) <= 1, String(shares));
}

// --- sharePatchFromValues index packing ---
{
  const patch = sharePatchFromValues([70, 30]);
  assert('share patch packs by display index', patch.override_share_1 === '70' && patch.override_share_2 === '30' && patch.override_share_3 === '');
}

// --- FE/BE even alignment ---
{
  const fe = sharesFromHours(estimateAlgoHours(['A', 'B'], 100));
  assert('FE algo hours even → 50/50 display', eq(fe, [50, 50]), String(fe));
  assert('FE matches BE even default', eq(equalHourShares(2), [50, 50]));
}

console.log('\n---');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log(` - ${f.name}: ${f.detail}`));
  process.exit(1);
}
process.exit(0);
