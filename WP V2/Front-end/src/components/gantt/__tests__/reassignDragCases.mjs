/**
 * Drag between operatives: validate, compose shift+reassign, blocked drops.
 * Run: npx --yes vite-node src/components/gantt/__tests__/reassignDragCases.mjs
 */
import {
  applyAssigneeOverrideForReassign,
  evaluateBarDrag,
  getBarActiveDays,
  prepareBarScheduleForReassign,
  validateReassignBarToRow,
} from '../histogramBarEdits.js';
import { getDayTaskSlots, buildDayColumns } from '../ganttUtils.js';

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
    task_name: 'Install',
    employee: 'Alex',
    algorithm_1: 'Alex',
    override_1: '',
    start: days[0],
    end: days.at(-1),
    hours_by_day: hoursByDay,
    hours: Object.values(hoursByDay).reduce((sum, h) => sum + h, 0),
    ...extra,
  };
}

const dayColumns = buildDayColumns('2026-07-01', '2026-07-31');
const baseCtx = {
  dayColumns,
  rowName: 'Alex',
  availabilityHours: {},
  employeeHolidays: {},
  employees: [],
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

test('validate allows empty target row', () => {
  const bar = buildBar({ '2026-07-06': 8, '2026-07-07': 8 });
  const result = validateReassignBarToRow(bar, 'Blake', [], [], baseCtx);
  assert(result.ok, `expected ok, got ${result.reason}`);
  assert(result.assignee === 'Blake', `expected Blake, got ${result.assignee}`);
});

test('validate blocks occupied target day when no spare capacity', () => {
  const bar = buildBar({ '2026-07-06': 8 });
  const other = buildBar({ '2026-07-06': 4 }, {
    id: 'bar-2',
    task_id: 99,
    task_name: 'Survey',
    employee: 'Blake',
  });
  const result = validateReassignBarToRow(bar, 'Blake', [other], [], baseCtx);
  assert(!result.ok, 'expected blocked');
  assert(/Over capacity|Busy/i.test(result.reason), `unexpected reason: ${result.reason}`);
});

test('validate allows partial day when spare capacity remains', () => {
  const bar = buildBar({ '2026-07-06': 4 });
  const other = buildBar({ '2026-07-06': 4 }, {
    id: 'bar-2',
    task_id: 99,
    task_name: 'Survey',
    employee: 'Blake',
  });
  const result = validateReassignBarToRow(bar, 'Blake', [other], [], baseCtx);
  assert(result.ok, `expected ok, got ${result.reason}`);
});

test('validate blocks holiday on target', () => {
  const bar = buildBar({ '2026-07-06': 8 });
  const ctx = {
    ...baseCtx,
    employeeHolidays: {
      Blake: { '2026-07-06': true },
    },
  };
  const result = validateReassignBarToRow(bar, 'Blake', [], [], ctx);
  assert(!result.ok, 'expected holiday block');
  assert(/Holiday/i.test(result.reason), `unexpected reason: ${result.reason}`);
});

test('evaluateBarDrag reassigns and shifts together', () => {
  const bar = buildBar({ '2026-07-06': 8, '2026-07-07': 8 });
  const result = evaluateBarDrag(bar, '2026-07-09', baseCtx, {
    anchorSnapDay: '2026-07-06',
    sourceRowName: 'Alex',
    targetRowName: 'Blake',
    targetRowBars: [],
    employees: [],
  });
  assert(result.reassigning, 'expected reassigning');
  assert(!result.blocked, `unexpected block: ${result.blockReason}`);
  assert(result.commitBar, 'expected commitBar');
  assert(result.commitBar.employee === 'Blake', `got ${result.commitBar.employee}`);
  assert(result.commitBar.override_1 === 'Blake', 'expected override_1 = Blake');
  const days = getBarActiveDays(result.commitBar);
  assert(days[0] === '2026-07-08', `expected start 2026-07-08, got ${days[0]}`);
  assert(days[1] === '2026-07-09', `expected end 2026-07-09, got ${days[1]}`);
});

test('evaluateBarDrag blocked drop returns null commitBar', () => {
  const bar = buildBar({ '2026-07-06': 8 });
  const other = buildBar({ '2026-07-06': 8 }, {
    id: 'bar-2',
    task_id: 2,
    task_name: 'Other',
    employee: 'Blake',
  });
  const result = evaluateBarDrag(bar, '2026-07-06', baseCtx, {
    anchorSnapDay: '2026-07-06',
    sourceRowName: 'Alex',
    targetRowName: 'Blake',
    targetRowBars: [other],
    employees: [],
  });
  assert(result.blocked, 'expected blocked');
  assert(result.commitBar == null, 'commitBar should be null');
  assert(result.previewBar.employee === 'Blake', 'ghost still shows target assignee');
  assert(result.shiftedBar.employee === 'Alex', 'shiftedBar keeps source assignee');
});

test('evaluateBarDrag same-row still shifts across weekend', () => {
  const bar = buildBar({ '2026-07-10': 8 });
  const result = evaluateBarDrag(bar, '2026-07-12', baseCtx, {
    anchorSnapDay: '2026-07-10',
    sourceRowName: 'Alex',
    targetRowName: 'Alex',
    targetRowBars: [],
    employees: [],
  });
  assert(!result.reassigning, 'should not reassign');
  assert(!result.blocked, 'should not block');
  assert(getBarActiveDays(result.commitBar)[0] === '2026-07-13', 'Fri→Mon workday snap');
});

test('applyAssigneeOverride still maps Algorithm 1 → Override 1 after compose', () => {
  const bar = buildBar({ '2026-07-06': 8 }, { algorithm_1: 'Alex', algorithm_2: 'Blake' });
  const next = applyAssigneeOverrideForReassign(bar, 'Casey');
  assert(next.override_1 === 'Casey', `expected override_1, got ${next.override_1}`);
  assert(next.employee === 'Casey');
});

test('reassign compacts internal gaps toward earliest day without adding hours', () => {
  const bar = buildBar({
    '2026-07-06': 8,
    '2026-07-07': 8,
    '2026-07-09': 8,
    '2026-07-10': 8,
  });
  const next = prepareBarScheduleForReassign(bar, [], 'Blake', [], baseCtx);
  const days = getBarActiveDays(next);
  assert(days.join(',') === '2026-07-06,2026-07-07,2026-07-08,2026-07-09', `unexpected days ${days.join(',')}`);
  assert(next.hours === 32, `hours should stay 32, got ${next.hours}`);
  assert(!days.includes('2026-07-10'), 'later part should shift left, not extend span');
});

test('reassign merges sibling fragments then compacts toward earliest day', () => {
  const left = buildBar({ '2026-07-06': 8, '2026-07-07': 8 }, { id: 'bar-left' });
  const right = buildBar({ '2026-07-09': 8, '2026-07-10': 8 }, { id: 'bar-right' });
  const next = prepareBarScheduleForReassign(left, [left, right], 'Blake', [], baseCtx);
  const days = getBarActiveDays(next);
  assert(days.join(',') === '2026-07-06,2026-07-07,2026-07-08,2026-07-09', `unexpected days ${days.join(',')}`);
  assert(next.hours === 32, `expected 32h total, got ${next.hours}`);
});

test('reassign keeps gap when target row is busy on a needed slot', () => {
  const bar = buildBar({
    '2026-07-06': 8,
    '2026-07-07': 8,
    '2026-07-09': 8,
  });
  const blocker = buildBar({ '2026-07-08': 8 }, {
    id: 'bar-2',
    task_id: 99,
    task_name: 'Survey',
    employee: 'Blake',
  });
  const next = prepareBarScheduleForReassign(bar, [], 'Blake', [blocker], baseCtx);
  const days = getBarActiveDays(next);
  assert(!days.includes('2026-07-08'), 'gap day should stay empty when target is busy');
  assert(days.length === 3, `expected 3 active days, got ${days.length}`);
});

test('reassign clears resize edge and left-aligns on free day', () => {
  const bar = buildBar({
    '2026-07-06': 6,
    '2026-07-07': 8,
  }, { _resizeEdge: 'start' });
  const result = evaluateBarDrag(bar, '2026-07-13', baseCtx, {
    anchorSnapDay: '2026-07-06',
    sourceRowName: 'Alex',
    targetRowName: 'Blake',
    targetRowBars: [],
    sourceRowBars: [bar],
    employees: [],
  });
  assert(result.commitBar, 'expected commitBar');
  assert(result.commitBar._resizeEdge == null, 'resize edge should be cleared');
  const slots = getDayTaskSlots([result.commitBar], '2026-07-13', {
    ...baseCtx,
    rowName: 'Blake',
    resizeStartBarId: null,
  });
  const slot = slots.get(result.commitBar.id);
  assert(slot?.startSeg === 0, `expected left-aligned free day, got startSeg=${slot?.startSeg}`);
});

console.log(`\n${passed} passed`);
