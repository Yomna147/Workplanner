/**
 * Runnable cases for resize-end / resize-start push of ALL later/earlier tasks.
 * Run: npx --yes vite-node src/components/gantt/__tests__/resizePushCases.mjs
 */
import {
  evaluateResizeWithPush,
  getBarActiveDays,
  shiftBarScheduleByWorkdays,
} from '../histogramBarEdits.js';
import { buildDayColumns } from '../ganttUtils.js';
import { HISTOGRAM_DAY_PARTITIONS } from '../histogramLayout.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildBar(id, taskId, hoursByDay, extra = {}) {
  const days = Object.keys(hoursByDay).sort();
  return {
    id,
    task_id: taskId,
    task_name: `Task ${taskId}`,
    employee: 'Alex',
    start: days[0],
    end: days.at(-1),
    hours_by_day: hoursByDay,
    hours: Object.values(hoursByDay).reduce((sum, h) => sum + h, 0),
    ...extra,
  };
}

const dayColumns = buildDayColumns('2026-07-01', '2026-07-31');

function layout(rowBars) {
  return {
    dayColumns,
    rowName: 'Alex',
    availabilityHours: {},
    employeeHolidays: {},
    employees: [],
    rowBars,
    sourceRowBars: rowBars,
  };
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

test('shiftBarScheduleByWorkdays +1 skips weekend', () => {
  const bar = buildBar('a', 1, { '2026-07-10': 8 });
  const next = shiftBarScheduleByWorkdays(bar, 1, layout([]));
  assert(next.start === '2026-07-13', `expected Monday, got ${next.start}`);
  assert(next.hours_by_day['2026-07-13'] === 8, 'hours preserved');
});

test('end-grow into adjacent later task pushes it forward by drag amount', () => {
  const early = buildBar('early', 1, {
    '2026-07-06': 8,
    '2026-07-07': 8,
  });
  const later = buildBar('later', 2, {
    '2026-07-08': 8,
    '2026-07-09': 8,
  });
  const ctx = layout([later]);
  const result = evaluateResizeWithPush(
    early,
    'resize-end',
    '2026-07-09',
    ctx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );

  // Drag amount: Tue→Thu = +2 workdays
  assert(result.resizedBar.end === '2026-07-09', `expected end 2026-07-09, got ${result.resizedBar.end}`);
  assert(result.pushedBars.length === 1, `expected 1 pushed bar, got ${result.pushedBars.length}`);
  const pushed = result.pushedBars[0].nextBar;
  assert(pushed.start === '2026-07-10', `expected later start Fri (+2), got ${pushed.start}`);
  assert(pushed.end === '2026-07-13', `expected later end Mon (+2), got ${pushed.end}`);
  assert(result.previewByBarId[later.id], 'preview includes pushed bar');
});

test('end-grow also pushes later tasks after a gap by the same drag amount', () => {
  const early = buildBar('early', 1, {
    '2026-07-06': 8,
    '2026-07-07': 8,
  });
  const adjacent = buildBar('adjacent', 2, {
    '2026-07-08': 8,
  });
  const afterGap = buildBar('gap', 3, {
    '2026-07-14': 8,
    '2026-07-15': 8,
  });
  const ctx = layout([adjacent, afterGap]);
  const result = evaluateResizeWithPush(
    early,
    'resize-end',
    '2026-07-08',
    ctx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );

  // Drag amount: Tue→Wed = +1 — both later tasks move +1, not only the next one
  assert(result.pushedBars.length === 2, `expected both later tasks pushed, got ${result.pushedBars.length}`);
  const byId = Object.fromEntries(
    result.pushedBars.map((entry) => [entry.nextBar.id, entry.nextBar]),
  );
  assert(byId.adjacent.start === '2026-07-09', `adjacent +1 → Thu, got ${byId.adjacent.start}`);
  assert(byId.gap.start === '2026-07-15', `gap task +1 → Wed, got ${byId.gap.start}`);
  assert(byId.gap.end === '2026-07-16', `gap task end +1 → Thu, got ${byId.gap.end}`);
});

test('all later overlapping tasks shift by the same drag delta only', () => {
  const early = buildBar('early', 1, { '2026-07-06': 8 });
  const mid = buildBar('mid', 2, {
    '2026-07-07': 4,
    '2026-07-08': 4,
  });
  const late = buildBar('late', 3, {
    '2026-07-08': 4,
    '2026-07-09': 4,
  });
  const ctx = layout([mid, late]);
  const result = evaluateResizeWithPush(
    early,
    'resize-end',
    '2026-07-08',
    ctx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );

  // Drag: Mon→Wed = +2
  assert(result.pushedBars.length === 2, `expected 2 pushed, got ${result.pushedBars.length}`);
  const byId = Object.fromEntries(
    result.pushedBars.map((entry) => [entry.nextBar.id, entry.nextBar]),
  );
  assert(byId.mid.start === '2026-07-09', `mid +2 start expected 2026-07-09, got ${byId.mid.start}`);
  assert(byId.late.start === '2026-07-10', `late +2 start expected 2026-07-10, got ${byId.late.start}`);
});

test('start-grow pushes all earlier tasks backward by drag amount', () => {
  const earlier = buildBar('earlier', 1, {
    '2026-07-06': 8,
    '2026-07-07': 8,
  });
  const midGap = buildBar('midGap', 3, {
    '2026-07-03': 8,
    '2026-07-06': 4,
  });
  const late = buildBar('late', 2, {
    '2026-07-08': 8,
    '2026-07-09': 8,
  });
  const ctx = layout([earlier, midGap]);
  const result = evaluateResizeWithPush(
    late,
    'resize-start',
    '2026-07-06',
    ctx,
    null,
    0,
  );

  // Drag: Wed→Mon = −2 — both earlier tasks move −2
  assert(result.resizedBar.start === '2026-07-06', `expected start 2026-07-06, got ${result.resizedBar.start}`);
  assert(result.pushedBars.length === 2, `expected 2 earlier tasks pushed, got ${result.pushedBars.length}`);
  const byId = Object.fromEntries(
    result.pushedBars.map((entry) => [entry.nextBar.id, entry.nextBar]),
  );
  assert(byId.earlier.start === '2026-07-02', `earlier −2 start, got ${byId.earlier.start}`);
  assert(byId.earlier.end === '2026-07-03', `earlier −2 end, got ${byId.earlier.end}`);
  assert(byId.midGap.start === '2026-07-01', `midGap −2 start, got ${byId.midGap.start}`);
  assert(byId.midGap.end === '2026-07-02', `midGap −2 end, got ${byId.midGap.end}`);
});

test('extension that would push past the timeline is capped to drag that fits', () => {
  const shortColumns = buildDayColumns('2026-07-20', '2026-07-24');
  const early = buildBar('early', 1, {
    '2026-07-20': 8,
    '2026-07-21': 8,
  });
  const later = buildBar('later', 2, {
    '2026-07-22': 8,
    '2026-07-23': 8,
    '2026-07-24': 8,
  });
  const ctx = {
    dayColumns: shortColumns,
    rowName: 'Alex',
    availabilityHours: {},
    employeeHolidays: {},
    employees: [],
    rowBars: [later],
    sourceRowBars: [later],
  };

  const result = evaluateResizeWithPush(
    early,
    'resize-end',
    '2026-07-24',
    ctx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );

  assert(
    result.pushedBars.length === 0 || result.resizedBar.end < '2026-07-24',
    'resize must be capped so later tasks stay on timeline',
  );

  if (result.pushedBars.length > 0) {
    const pushedEnd = result.pushedBars[0].nextBar.end;
    assert(
      pushedEnd <= '2026-07-24',
      `pushed bar must not leave timeline, got end ${pushedEnd}`,
    );
  } else {
    assert(
      !getBarActiveDays(result.resizedBar).includes('2026-07-24')
      || getBarActiveDays(result.resizedBar).at(-1) <= '2026-07-21',
      'without push room, displace claim should not stick',
    );
  }
});

test('shrink does not push', () => {
  const early = buildBar('early', 1, {
    '2026-07-06': 8,
    '2026-07-07': 8,
    '2026-07-08': 8,
  });
  const later = buildBar('later', 2, {
    '2026-07-09': 8,
  });
  const ctx = layout([later]);
  const result = evaluateResizeWithPush(
    early,
    'resize-end',
    '2026-07-07',
    ctx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );

  assert(result.pushedBars.length === 0, 'shrink must not push');
  assert(result.resizedBar.end === '2026-07-07', `expected shrunk end, got ${result.resizedBar.end}`);
});

test('tasks entirely before the bar are not pushed on end-grow', () => {
  const before = buildBar('before', 1, {
    '2026-07-01': 8,
    '2026-07-02': 8,
  });
  const early = buildBar('early', 2, {
    '2026-07-06': 8,
    '2026-07-07': 8,
  });
  const later = buildBar('later', 3, {
    '2026-07-08': 8,
  });
  const ctx = layout([before, later]);
  const result = evaluateResizeWithPush(
    early,
    'resize-end',
    '2026-07-08',
    ctx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );

  assert(result.pushedBars.length === 1, `expected only later pushed, got ${result.pushedBars.length}`);
  assert(result.pushedBars[0].nextBar.id === 'later', 'before-bar must stay');
  assert(!result.previewByBarId[before.id], 'before task must not move on end-grow');
});

if (process.exitCode) {
  console.error(`\n${passed} passed before failures`);
} else {
  console.log(`\nAll ${passed} tests passed`);
}
