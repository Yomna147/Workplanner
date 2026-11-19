/**
 * Runnable cases for task-bar start-handle resize (LTR across weekends/weeks).
 * Run: npx --yes vite-node src/components/gantt/__tests__/resizeStartCases.mjs
 */
import { resizeBarToSnapDay, getBarActiveDays } from '../histogramBarEdits.js';
import { getDayTaskSlots, buildDayColumns } from '../ganttUtils.js';
import { HISTOGRAM_DAY_PARTITIONS } from '../histogramLayout.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildBar(hoursByDay, extra = {}) {
  const days = Object.keys(hoursByDay).sort();
  return {
    id: 'bar-1',
    task_id: 10,
    employee: 'Alex',
    start: days[0],
    end: days.at(-1),
    hours_by_day: hoursByDay,
    hours: Object.values(hoursByDay).reduce((sum, h) => sum + h, 0),
    ...extra,
  };
}

/** Mon 2026-07-06 .. Fri 2026-07-17 (spans one weekend). */
function multiWeekBar() {
  const hoursByDay = {};
  [
    '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10',
    '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
  ].forEach((day) => {
    hoursByDay[day] = 8;
  });
  return buildBar(hoursByDay);
}

function layout(dayColumns) {
  return { dayColumns, rowName: 'Alex', availabilityHours: {}, employeeHolidays: {}, employees: [] };
}

const dayColumns = buildDayColumns('2026-07-01', '2026-07-31');
const ctx = layout(dayColumns);

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

test('start resize mid-week keeps end fixed (LTR)', () => {
  const bar = multiWeekBar();
  const next = resizeBarToSnapDay(bar, 'resize-start', '2026-07-08', ctx, null, 0);
  assert(next.start === '2026-07-08', `expected start 2026-07-08, got ${next.start}`);
  assert(next.end === '2026-07-17', `expected end unchanged 2026-07-17, got ${next.end}`);
  assert(!getBarActiveDays(next).includes('2026-07-06'), 'Mon should be removed');
  assert(!getBarActiveDays(next).includes('2026-07-07'), 'Tue should be removed');
});

test('start resize onto Saturday does not jump to next Monday', () => {
  const bar = multiWeekBar();
  const next = resizeBarToSnapDay(bar, 'resize-start', '2026-07-11', ctx, null, null);
  assert(next.start === '2026-07-10', `expected stay on Friday 2026-07-10, got ${next.start}`);
  assert(next.end === '2026-07-17', `expected end unchanged, got ${next.end}`);
  assert(getBarActiveDays(next).includes('2026-07-10'), 'Friday should remain');
  assert(getBarActiveDays(next).includes('2026-07-13'), 'next Monday should remain');
});

test('start resize onto Sunday stays on Friday (no week jump)', () => {
  const bar = multiWeekBar();
  const next = resizeBarToSnapDay(bar, 'resize-start', '2026-07-12', ctx, null, null);
  assert(next.start === '2026-07-10', `expected Friday, got ${next.start}`);
  assert(next.end === '2026-07-17', `expected end unchanged, got ${next.end}`);
});

test('start resize past Friday quarters does not jump to Monday', () => {
  const bar = multiWeekBar();
  const next = resizeBarToSnapDay(
    bar,
    'resize-start',
    '2026-07-10',
    ctx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );
  assert(next.start === '2026-07-10', `expected remain Friday, got ${next.start}`);
  assert(next.end === '2026-07-17', `expected end unchanged, got ${next.end}`);
});

test('start resize onto next Monday moves start LTR across weekend', () => {
  const bar = multiWeekBar();
  const next = resizeBarToSnapDay(bar, 'resize-start', '2026-07-13', ctx, null, 0);
  assert(next.start === '2026-07-13', `expected Monday start, got ${next.start}`);
  assert(next.end === '2026-07-17', `expected end unchanged, got ${next.end}`);
  assert(!getBarActiveDays(next).includes('2026-07-10'), 'prior Friday should be gone');
});

test('start resize left across weekend extends to prior Friday', () => {
  const hoursByDay = {
    '2026-07-13': 8,
    '2026-07-14': 8,
    '2026-07-15': 8,
  };
  const bar = buildBar(hoursByDay);
  const next = resizeBarToSnapDay(bar, 'resize-start', '2026-07-11', ctx, null, null);
  assert(next.start === '2026-07-10', `expected prior Friday, got ${next.start}`);
  assert(next.end === '2026-07-15', `expected end unchanged, got ${next.end}`);
});

test('multi-day partial start without resize edge is left-aligned on free day', () => {
  const bar = buildBar({
    '2026-07-10': 2,
    '2026-07-13': 8,
  });
  const slots = getDayTaskSlots([bar], '2026-07-10', ctx);
  const slot = slots.get(bar.id);
  assert(slot.startSeg === 0, `expected left align, got startSeg=${slot.startSeg}`);
});

test('Friday partial before Monday continues is right-aligned (LTR)', () => {
  const bar = buildBar({
    '2026-07-10': 2,
    '2026-07-13': 8,
    '2026-07-14': 8,
  });
  const slots = getDayTaskSlots([bar], '2026-07-10', { ...ctx, resizeStartBarId: bar.id });
  const slot = slots.get(bar.id);
  assert(slot, 'expected Friday slot');
  assert(slot.numSeg < HISTOGRAM_DAY_PARTITIONS, 'expected partial Friday');
  assert(
    slot.startSeg === HISTOGRAM_DAY_PARTITIONS - slot.numSeg,
    `expected right-aligned startSeg, got startSeg=${slot.startSeg} numSeg=${slot.numSeg}`,
  );
});

test('single-day start-resize partial is right-aligned via _resizeEdge', () => {
  const bar = buildBar({ '2026-07-08': 8 });
  const next = resizeBarToSnapDay(bar, 'resize-start', '2026-07-08', ctx, null, 2);
  assert(next._resizeEdge === 'start', 'expected _resizeEdge start');
  const slots = getDayTaskSlots([next], '2026-07-08', { ...ctx, resizeStartBarId: next.id });
  const slot = slots.get(next.id);
  assert(slot.numSeg < HISTOGRAM_DAY_PARTITIONS, 'expected partial day');
  assert(
    slot.startSeg === HISTOGRAM_DAY_PARTITIONS - slot.numSeg,
    `expected right-aligned, got startSeg=${slot.startSeg} numSeg=${slot.numSeg}`,
  );
});

test('end-resize partial single day stays left-aligned', () => {
  const bar = buildBar({ '2026-07-08': 8 });
  const next = resizeBarToSnapDay(bar, 'resize-end', '2026-07-08', ctx, null, 2);
  assert(next._resizeEdge === 'end', 'expected _resizeEdge end');
  const slots = getDayTaskSlots([next], '2026-07-08', ctx);
  const slot = slots.get(next.id);
  assert(slot.startSeg === 0, `expected left-aligned end shrink, got startSeg=${slot.startSeg}`);
});

test('stale resize edge on bar does not right-align after drag', () => {
  const bar = buildBar({
    '2026-07-10': 2,
    '2026-07-13': 8,
  }, { _resizeEdge: 'start' });
  const slots = getDayTaskSlots([bar], '2026-07-10', ctx);
  const slot = slots.get(bar.id);
  assert(slot.startSeg === 0, `expected left align despite stale edge, got startSeg=${slot.startSeg}`);
});

test('full-day resize caps at AVA (no remaining+existing double count)', () => {
  // Habiba-style: 1h already on the day, AVA=8 → must become 8h, never 9h.
  const bar = buildBar({ '2026-08-20': 1 }, { employee: 'Habiba A' });
  const avaCtx = {
    ...ctx,
    rowName: 'Habiba A',
    availabilityHours: { 'Habiba A': { '2026-08-20': 8 } },
    rowBars: [bar],
    sourceRowBars: [bar],
  };
  const next = resizeBarToSnapDay(
    bar,
    'resize-end',
    '2026-08-20',
    avaCtx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );
  const hours = Number(next.hours_by_day['2026-08-20']) || 0;
  assert(hours === 8, `expected 8h capped day, got ${hours}`);
});

test('resize does not preserve prior overbook above AVA', () => {
  const bar = buildBar({ '2026-08-20': 9 }, { employee: 'Habiba A' });
  const avaCtx = {
    ...ctx,
    rowName: 'Habiba A',
    availabilityHours: { 'Habiba A': { '2026-08-20': 8 } },
    rowBars: [bar],
    sourceRowBars: [bar],
  };
  const next = resizeBarToSnapDay(
    bar,
    'resize-end',
    '2026-08-20',
    avaCtx,
    null,
    HISTOGRAM_DAY_PARTITIONS,
  );
  const hours = Number(next.hours_by_day['2026-08-20']) || 0;
  assert(hours === 8, `expected overbook clamped to 8h, got ${hours}`);
});

console.log(`\n${passed} passed`);
