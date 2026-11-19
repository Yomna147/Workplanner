/**
 * Run: npx --yes vite-node src/utils/__tests__/taskOverridesCases.mjs
 */
import { effectiveTaskOverride, normalizeTaskOverrideFields, deriveTaskOverridesFromRelatedBars } from '../taskOverrides.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
    process.exitCode = 1;
  }
}

test('clears override that repeats algorithm assignee', () => {
  const task = {
    algorithm_2: 'Abdelsattar Alfarra',
    override_2: 'Abdelsattar Alfarra',
  };
  const next = normalizeTaskOverrideFields(task);
  assert(next.override_2 === '', `expected empty override_2, got ${next.override_2}`);
});

test('keeps override that differs from algorithm assignee', () => {
  const task = {
    algorithm_2: 'Abdelsattar Alfarra',
    override_2: 'Gabriel Giurca',
  };
  const next = normalizeTaskOverrideFields(task);
  assert(next.override_2 === 'Gabriel Giurca', `got ${next.override_2}`);
});

test('effective override is empty when matching algorithm', () => {
  const task = {
    algorithm_3: 'Gabriel Giurca',
    override_3: 'Gabriel Giurca',
  };
  assert(effectiveTaskOverride(task, '3') === '', 'expected empty effective override');
});

test('treats alias names as the same operative for duplicate detection', () => {
  const task = {
    algorithm_2: 'Abdelsattar Alfarra',
    override_2: 'Abdelsattar',
  };
  assert(effectiveTaskOverride(task, '2') === '', 'expected empty when alias matches algorithm');
});

test('derives overrides from histogram bars when operatives differ from algorithm', () => {
  const task = {
    algorithm_1: 'Gabriel Giurca',
    algorithm_2: 'Abdelsattar Alfarra',
    algorithm_3: 'Gabriel Giurca',
    override_1: '',
    override_2: '',
    override_3: '',
  };
  const bars = [
    { employee: 'Kostadin Radulov', hours: 80, hours_by_day: { '2026-08-07': 8 } },
    { employee: 'Abdelsattar Alfarra', hours: 72, hours_by_day: { '2026-08-07': 8 } },
    { employee: 'Mohamed Khaled', hours: 64, hours_by_day: { '2026-08-07': 8 } },
  ];
  const next = deriveTaskOverridesFromRelatedBars(task, bars);
  assert(next.override_1 === 'Kostadin Radulov', `override_1=${next.override_1}`);
  assert(next.override_2 === '', `override_2=${next.override_2}`);
  assert(next.override_3 === 'Mohamed Khaled', `override_3=${next.override_3}`);
});

test('ignores stale algorithm bar hours when inferring overrides', () => {
  const task = {
    algorithm_1: 'Gabriel Giurca',
    algorithm_2: 'Abdelsattar Alfarra',
    algorithm_3: 'Gabriel Giurca',
    override_1: '',
    override_2: '',
    override_3: 'Mohamed Khaled',
  };
  const bars = [
    { employee: 'Gabriel Giurca', hours: 4, hours_by_day: { '2026-08-07': 4 } },
    { employee: 'Kostadin Radulov', hours: 80, hours_by_day: { '2026-08-07': 8 } },
    { employee: 'Abdelsattar Alfarra', hours: 72, hours_by_day: { '2026-08-07': 8 } },
    { employee: 'Mohamed Khaled', hours: 64, hours_by_day: { '2026-08-07': 8 }, override_3: 'Mohamed Khaled' },
  ];
  const next = deriveTaskOverridesFromRelatedBars(task, bars);
  assert(next.override_1 === 'Kostadin Radulov', `override_1=${next.override_1}`);
  assert(next.override_2 === '', `override_2=${next.override_2}`);
  assert(next.override_3 === 'Mohamed Khaled', `override_3=${next.override_3}`);
});

test('prefers explicit override fields synced onto histogram bars', () => {
  const task = {
    algorithm_1: 'Gabriel Giurca',
    algorithm_2: 'Abdelsattar Alfarra',
    algorithm_3: 'Gabriel Giurca',
    override_1: '',
    override_2: '',
    override_3: '',
  };
  const bars = [
    {
      employee: 'Kostadin Radulov',
      hours: 80,
      hours_by_day: { '2026-08-07': 8 },
      override_1: 'Kostadin Radulov',
      override_3: 'Mohamed Khaled',
    },
    {
      employee: 'Abdelsattar Alfarra',
      hours: 72,
      hours_by_day: { '2026-08-07': 8 },
      override_1: 'Kostadin Radulov',
      override_3: 'Mohamed Khaled',
    },
    {
      employee: 'Mohamed Khaled',
      hours: 64,
      hours_by_day: { '2026-08-07': 8 },
      override_1: 'Kostadin Radulov',
      override_3: 'Mohamed Khaled',
    },
  ];
  const next = deriveTaskOverridesFromRelatedBars(task, bars);
  assert(next.override_1 === 'Kostadin Radulov', `override_1=${next.override_1}`);
  assert(next.override_2 === '', `override_2=${next.override_2}`);
  assert(next.override_3 === 'Mohamed Khaled', `override_3=${next.override_3}`);
});

console.log(`\n${passed} passed`);
