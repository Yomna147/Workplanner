/**
 * Task editor draft → histogram bar live preview.
 * Run: npx --yes vite-node src/components/gantt/__tests__/taskEditorLivePreviewCases.mjs
 */
import {
  applyHistogramBarToTask,
  applyTaskDraftToBar,
  applyTaskDraftToTaskBars,
} from '../taskEditorLivePreview.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function barHoursTotal(bar) {
  return Object.values(bar.hours_by_day || {}).reduce((sum, hours) => sum + (Number(hours) || 0), 0);
}

function maxDayHours(bar) {
  return Math.max(0, ...Object.values(bar.hours_by_day || {}).map((hours) => Number(hours) || 0));
}

const bar = {
  id: 'bar-1',
  task_id: 10,
  employee: 'Alex',
  doc_supply: '2026-07-07',
  completion: '2026-07-09',
  start: '2026-07-07',
  end: '2026-07-09',
  hours_by_day: {
    '2026-07-07': 8,
    '2026-07-08': 8,
    '2026-07-09': 8,
  },
  hours: 24,
  plan: '24',
};

const baselineTask = {
  id: 10,
  doc_supply: '2026-07-07',
  completion: '2026-07-09',
  est: '24',
  hrs_per: '100',
  adj: '',
  plan: '24',
};

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

test('adj reduction scales bar hours down', () => {
  const draft = {
    ...baselineTask,
    adj: '-8',
    plan: '16',
  };
  const next = applyTaskDraftToBar(bar, draft, { baseline: baselineTask });
  assert(Math.abs(barHoursTotal(next) - 16) < 0.01, `expected 16h total, got ${barHoursTotal(next)}`);
  assert(next.hours === 16, `expected bar.hours 16, got ${next.hours}`);
});

test('hrs_per reduction scales bar hours down', () => {
  const draft = {
    ...baselineTask,
    hrs_per: '50',
    red: '12',
    plan: '12',
  };
  const next = applyTaskDraftToBar(bar, draft, { baseline: baselineTask });
  assert(Math.abs(barHoursTotal(next) - 12) < 0.01, `expected 12h total, got ${barHoursTotal(next)}`);
});

test('progress-only change does not alter bar hours', () => {
  const draft = {
    ...baselineTask,
    progress_per: '25',
    act: '6',
  };
  const next = applyTaskDraftToBar(bar, draft, { baseline: baselineTask });
  assert(Math.abs(barHoursTotal(next) - 24) < 0.01, 'hours should stay 24');
});

test('doc_supply shift preserves total hours', () => {
  const draft = {
    ...baselineTask,
    doc_supply: '2026-07-08',
    completion: '2026-07-10',
  };
  const next = applyTaskDraftToBar(bar, draft, { baseline: baselineTask });
  assert(Math.abs(barHoursTotal(next) - 24) < 0.01, `expected 24h total, got ${barHoursTotal(next)}`);
  assert(next.hours_by_day['2026-07-08'] === 8, 'hours should move with start date');
  assert(!next.hours_by_day['2026-07-07'], 'old start day should be empty');
});

test('completion-only change trims trailing hours without reshaping', () => {
  const shapedBar = {
    ...bar,
    hours_by_day: {
      '2026-07-07': 8,
      '2026-07-08': 4,
      '2026-07-09': 8,
    },
    hours: 20,
  };
  const draft = {
    ...baselineTask,
    completion: '2026-07-08',
  };
  const next = applyTaskDraftToBar(shapedBar, draft, { baseline: baselineTask });
  assert(next.hours_by_day['2026-07-07'] === 8, 'first day hours preserved');
  assert(next.hours_by_day['2026-07-08'] === 4, 'partial day preserved');
  assert(!next.hours_by_day['2026-07-09'], 'trimmed day should be removed');
  assert(Math.abs(barHoursTotal(next) - 12) < 0.01, `expected 12h total, got ${barHoursTotal(next)}`);
});

test('override-only change moves bar to new operative without reshaping hours', () => {
  const algoBar = {
    ...bar,
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Alex',
    override_2: '',
    override_3: '',
  };
  const baseline = {
    ...baselineTask,
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Alex',
    override_2: '',
    override_3: '',
  };
  const draft = {
    ...baseline,
    override_1: 'Charlie',
  };
  const next = applyTaskDraftToBar(algoBar, draft, { baseline });
  assert(next.employee === 'Charlie', `expected Charlie, got ${next.employee}`);
  assert(Math.abs(barHoursTotal(next) - 24) < 0.01, 'hours should stay 24 on override-only edit');
  assert(next.hours_by_day['2026-07-07'] === 8, 'schedule should be unchanged');
});

test('override reassign suppresses duplicate operative row', () => {
  const barAlex = {
    ...bar,
    id: 'bar-alex',
    employee: 'Alex',
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Alex',
    override_2: 'Bob',
  };
  const barBob = {
    ...bar,
    id: 'bar-bob',
    employee: 'Bob',
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Alex',
    override_2: 'Bob',
    hours_by_day: { '2026-07-07': 4 },
    hours: 4,
  };
  const baseline = {
    ...baselineTask,
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Alex',
    override_2: 'Bob',
  };
  const draft = {
    ...baseline,
    override_1: 'Bob',
  };
  const nextBars = applyTaskDraftToTaskBars([barAlex, barBob], draft, baseline);
  const moved = nextBars.find((entry) => entry.id === 'bar-alex');
  const sibling = nextBars.find((entry) => entry.id === 'bar-bob');
  assert(moved.employee === 'Bob', `expected Bob, got ${moved.employee}`);
  assert(sibling._suppressedByBarEdit === 'bar-alex', 'duplicate Bob row should be suppressed');
});

test('override_2 change moves Algorithm-2 bar without reshaping hours', () => {
  const barBob = {
    ...bar,
    employee: 'Bob',
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    algorithm_3: '',
    override_1: 'Alex',
    override_2: 'Bob',
    override_3: '',
  };
  const baseline = {
    ...baselineTask,
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Alex',
    override_2: 'Bob',
    override_3: '',
  };
  const draft = {
    ...baseline,
    override_2: 'Dana',
  };
  const next = applyTaskDraftToBar(barBob, draft, { baseline });
  assert(next.employee === 'Dana', `expected Dana, got ${next.employee}`);
  assert(Math.abs(barHoursTotal(next) - 24) < 0.01, 'hours should stay 24');
});

test('override_3 change moves Algorithm-3 bar', () => {
  const barCarol = {
    ...bar,
    employee: 'Carol',
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    algorithm_3: 'Carol',
    override_1: 'Alex',
    override_2: 'Bob',
    override_3: 'Carol',
  };
  const baseline = {
    ...baselineTask,
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    algorithm_3: 'Carol',
    override_1: 'Alex',
    override_2: 'Bob',
    override_3: 'Carol',
  };
  const draft = {
    ...baseline,
    override_3: 'Eve',
  };
  const next = applyTaskDraftToBar(barCarol, draft, { baseline });
  assert(next.employee === 'Eve', `expected Eve, got ${next.employee}`);
});

test('clearing override reverts bar to algorithm assignee', () => {
  const barDana = {
    ...bar,
    employee: 'Dana',
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    algorithm_3: '',
    override_1: 'Alex',
    override_2: 'Dana',
    override_3: '',
  };
  const baseline = {
    ...baselineTask,
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Alex',
    override_2: 'Dana',
    override_3: '',
  };
  const draft = {
    ...baseline,
    override_2: '',
  };
  const next = applyTaskDraftToBar(barDana, draft, { baseline });
  assert(next.employee === 'Bob', `expected Bob, got ${next.employee}`);
});

test('override change re-lays out previously suppressed sibling bars', () => {
  const barAlexOnBob = {
    ...bar,
    id: 'bar-alex',
    employee: 'Bob',
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Bob',
    override_2: 'Bob',
  };
  const barBobAllocation = {
    ...bar,
    id: 'bar-bob',
    employee: 'Bob',
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Bob',
    override_2: 'Bob',
    hours_by_day: { '2026-07-07': 4 },
    hours: 4,
  };
  const baseline = {
    ...baselineTask,
    algorithm_1: 'Alex',
    algorithm_2: 'Bob',
    override_1: 'Bob',
    override_2: 'Bob',
  };
  const draft = {
    ...baseline,
    override_1: 'Alex',
    override_2: 'Bob',
  };
  const nextBars = applyTaskDraftToTaskBars(
    [barAlexOnBob, barBobAllocation],
    draft,
    baseline,
    { resetSuppressed: true },
  );
  const moved = nextBars.find((entry) => entry.id === 'bar-alex');
  const sibling = nextBars.find((entry) => entry.id === 'bar-bob');
  assert(moved.employee === 'Alex', `expected Alex, got ${moved.employee}`);
  assert(!sibling._suppressedByBarEdit, 'sibling should be visible again after override reset');
  assert(sibling.hours === 4, `expected 4h on Bob, got ${sibling.hours}`);
});

test('adj edit that scales bars to Plan does not double-count Adj on bar sync', () => {
  const draft = {
    ...baselineTask,
    adj: '3',
    plan: '27',
  };
  const scaledBar = applyTaskDraftToBar(bar, draft, { baseline: baselineTask });
  const relatedBars = [{ ...scaledBar }];
  const previousRelatedBars = [{ ...bar }];
  const next = applyHistogramBarToTask(draft, scaledBar, bar, {
    relatedBars,
    previousRelatedBars,
  });
  assert(String(next.adj) === '3', `expected Adj to stay 3, got ${next.adj}`);
  assert(String(next.plan) === '27', `expected Plan to stay 27, got ${next.plan}`);
  assert(
    Math.abs(barHoursTotal(scaledBar) - 27) < 0.01,
    `expected bars at 27h, got ${barHoursTotal(scaledBar)}`,
  );
});

test('open with existing Adj does not stack bar-vs-original delta', () => {
  const originalBar = {
    ...bar,
    hours_by_day: {
      '2026-07-07': 8,
      '2026-07-08': 8,
      '2026-07-09': 8,
    },
    hours: 24,
  };
  const resizedBar = {
    ...bar,
    hours_by_day: {
      '2026-07-07': 8,
      '2026-07-08': 8,
      '2026-07-09': 8,
      '2026-07-10': 8,
    },
    hours: 32,
    end: '2026-07-10',
    completion: '2026-07-10',
  };
  // PDE already has Adj from the prior resize autosave.
  const task = {
    ...baselineTask,
    adj: '8',
    plan: '32',
    completion: '2026-07-10',
  };
  const next = applyHistogramBarToTask(task, resizedBar, null, {
    relatedBars: [resizedBar],
    originalRelatedBars: [originalBar],
  });
  assert(String(next.adj) === '8', `expected Adj to stay 8, got ${next.adj}`);
  assert(String(next.plan) === '32', `expected Plan to stay 32, got ${next.plan}`);
});

test('open seeds Adj only when empty and bars disagree with Plan', () => {
  const originalBar = { ...bar, hours: 24 };
  const resizedBar = {
    ...bar,
    hours_by_day: {
      '2026-07-07': 8,
      '2026-07-08': 8,
      '2026-07-09': 8,
      '2026-07-10': 8,
    },
    hours: 32,
    end: '2026-07-10',
    completion: '2026-07-10',
  };
  const task = {
    ...baselineTask,
    adj: '',
    plan: '24',
  };
  const next = applyHistogramBarToTask(task, resizedBar, null, {
    relatedBars: [resizedBar],
    originalRelatedBars: [originalBar],
  });
  assert(String(next.adj) === '8', `expected seeded Adj 8, got ${next.adj}`);
});

test('plan increase does not overbook a full AVA day', () => {
  const fullDayBar = {
    ...bar,
    hours_by_day: {
      '2026-07-07': 8,
      '2026-07-08': 8,
      '2026-07-09': 8,
    },
    hours: 24,
    completion: '2026-07-17',
  };
  const draft = {
    ...baselineTask,
    adj: '3',
    plan: '27',
    completion: '2026-07-17',
  };
  const next = applyTaskDraftToBar(fullDayBar, draft, { baseline: baselineTask });
  assert(maxDayHours(next) <= 8.001, `expected no day above 8h, got ${maxDayHours(next)}`);
  assert(Math.abs(barHoursTotal(next) - 27) < 0.01, `expected 27h total, got ${barHoursTotal(next)}`);
});

test('revealing clipped days does not change Adj when hour delta is disabled', () => {
  const clipped = {
    ...bar,
    start: '2026-10-01',
    end: '2026-10-01',
    hours_by_day: { '2026-10-01': 4 },
    hours: 4,
  };
  const revealed = {
    ...clipped,
    start: '2026-09-30',
    hours_by_day: { '2026-09-30': 4, '2026-10-01': 4 },
    hours: 8,
  };
  const task = {
    ...baselineTask,
    est: '14',
    hrs_per: '80',
    red: '11',
    adj: '-3',
    plan: '8',
    doc_supply: '2026-09-30',
    completion: '2026-10-02',
  };
  const next = applyHistogramBarToTask(task, revealed, clipped, {
    relatedBars: [revealed],
    previousRelatedBars: [clipped],
    applyHourDelta: false,
  });
  assert(next === task || String(next.adj) === '-3', `expected Adj to stay -3, got ${next.adj}`);
  assert(String(next.plan) === '8', `expected Plan to stay 8, got ${next.plan}`);
});

test('live bar resize still increments Adj', () => {
  const previousBar = { ...bar, hours: 24 };
  const nextBar = {
    ...bar,
    hours_by_day: {
      '2026-07-07': 8,
      '2026-07-08': 8,
      '2026-07-09': 8,
      '2026-07-10': 4,
    },
    hours: 28,
    end: '2026-07-10',
  };
  const task = { ...baselineTask, adj: '', plan: '24' };
  const next = applyHistogramBarToTask(task, nextBar, previousBar, {
    relatedBars: [nextBar],
    previousRelatedBars: [previousBar],
  });
  assert(String(next.adj) === '4', `expected Adj +4, got ${next.adj}`);
});

test('bar resize does not overwrite PDE Doc Supply / Completion', () => {
  const task = {
    ...baselineTask,
    doc_supply: '2026-06-01',
    completion: '2026-08-31',
  };
  const nextBar = {
    ...bar,
    start: '2026-07-08',
    end: '2026-07-10',
    hours_by_day: {
      '2026-07-08': 8,
      '2026-07-09': 8,
      '2026-07-10': 8,
    },
    hours: 24,
    doc_supply: '2026-07-08',
    completion: '2026-07-10',
  };
  const next = applyHistogramBarToTask(task, nextBar, bar, {
    relatedBars: [nextBar],
    previousRelatedBars: [bar],
  });
  assert(next.doc_supply === '2026-06-01', `expected PDE Doc Supply, got ${next.doc_supply}`);
  assert(next.completion === '2026-08-31', `expected PDE Completion, got ${next.completion}`);
});

console.log(`\n${passed} passed`);
