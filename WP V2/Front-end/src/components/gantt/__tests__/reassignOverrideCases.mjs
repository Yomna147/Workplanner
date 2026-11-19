/**
 * Algorithm N → Override N mapping for bar reassign → task editor.
 * Run: npx --yes vite-node src/components/gantt/__tests__/reassignOverrideCases.mjs
 */
import {
  applyAssigneeOverrideForReassign,
  findAssigneeOverrideSlot,
} from '../histogramBarEdits.js';
import { applyHistogramBarToTask } from '../taskEditorLivePreview.js';

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

test('Algorithm 1 maps to Override 1', () => {
  const slot = findAssigneeOverrideSlot({
    employee: 'Alice',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: '',
    override_1: '',
    override_2: '',
    override_3: '',
  }, 'Alice');
  assert(slot === 'override_1', `expected override_1, got ${slot}`);
});

test('Algorithm 2 maps to Override 2', () => {
  const slot = findAssigneeOverrideSlot({
    employee: 'Bob',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: '',
    override_1: '',
    override_2: '',
    override_3: '',
  }, 'Bob');
  assert(slot === 'override_2', `expected override_2, got ${slot}`);
});

test('Algorithm 3 maps to Override 3', () => {
  const slot = findAssigneeOverrideSlot({
    employee: 'Carol',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: 'Carol',
    override_1: 'Alice',
    override_2: 'Bob',
    override_3: '',
  }, 'Carol');
  assert(slot === 'override_3', `expected override_3, got ${slot}`);
});

test('Algorithm wins over a mismatched existing override', () => {
  const slot = findAssigneeOverrideSlot({
    employee: 'Bob',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: '',
    override_1: 'Bob',
    override_2: '',
    override_3: '',
  }, 'Bob');
  assert(slot === 'override_2', `expected override_2 from algorithm, got ${slot}`);
});

test('reassign Algorithm-2 emp writes Override 2', () => {
  const bar = {
    id: 'b1',
    task_id: 1,
    employee: 'Bob',
    override_1: 'Alice',
    override_2: '',
    override_3: '',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: '',
    hours_by_day: { '2026-07-08': 8 },
    hours: 8,
    start: '2026-07-08',
    end: '2026-07-08',
  };
  const next = applyAssigneeOverrideForReassign(bar, 'Dana');
  assert(next.override_1 === 'Alice', 'override_1 stays Alice');
  assert(next.override_2 === 'Dana', `override_2=${next.override_2}`);
  assert(next.employee === 'Dana', `employee=${next.employee}`);
});

test('task editor reflects Algorithm-2 reassign on Override 2', () => {
  const previousBar = {
    id: 'b1',
    task_id: 1,
    employee: 'Bob',
    override_1: 'Alice',
    override_2: '',
    override_3: '',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: '',
    hours_by_day: { '2026-07-08': 8 },
    hours: 8,
    start: '2026-07-08',
    end: '2026-07-08',
  };
  const nextBar = applyAssigneeOverrideForReassign(previousBar, 'Dana');
  const task = {
    id: 1,
    override_1: 'Alice',
    override_2: '',
    override_3: '',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: '',
    doc_supply: '2026-07-08',
    completion: '2026-07-08',
  };

  const nextTask = applyHistogramBarToTask(task, nextBar, previousBar, {
    relatedBars: [nextBar],
    previousRelatedBars: [previousBar],
    recalculate: false,
  });

  // override_1 matching algorithm_1 is normalized to '' ("use algorithm").
  assert(
    !nextTask.override_1 || nextTask.override_1 === 'Alice',
    `override_1=${nextTask.override_1}`,
  );
  assert(nextTask.override_2 === 'Dana', `override_2=${nextTask.override_2}`);
});

test('task editor reflects Algorithm-3 reassign on Override 3', () => {
  const previousBar = {
    id: 'b1',
    task_id: 1,
    employee: 'Carol',
    override_1: 'Alice',
    override_2: 'Bob',
    override_3: '',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: 'Carol',
    hours_by_day: { '2026-07-08': 8 },
    hours: 8,
    start: '2026-07-08',
    end: '2026-07-08',
  };
  const nextBar = applyAssigneeOverrideForReassign(previousBar, 'Eve');
  const task = {
    id: 1,
    override_1: 'Alice',
    override_2: 'Bob',
    override_3: '',
    algorithm_1: 'Alice',
    algorithm_2: 'Bob',
    algorithm_3: 'Carol',
    doc_supply: '2026-07-08',
    completion: '2026-07-08',
  };

  const nextTask = applyHistogramBarToTask(task, nextBar, previousBar, {
    relatedBars: [nextBar],
    previousRelatedBars: [previousBar],
    recalculate: false,
  });

  assert(
    !nextTask.override_1 || nextTask.override_1 === 'Alice',
    `override_1=${nextTask.override_1}`,
  );
  assert(
    !nextTask.override_2 || nextTask.override_2 === 'Bob',
    `override_2=${nextTask.override_2}`,
  );
  assert(nextTask.override_3 === 'Eve', `override_3=${nextTask.override_3}`);
});

console.log(`\n${passed} passed`);
