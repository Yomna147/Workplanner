/**
 * Run: npx --yes vite-node src/components/gantt/__tests__/consolidateBarsCases.mjs
 */
import {
  consolidateTaskEmployeeBars,
  getDayTaskSlots,
  buildDayColumns,
} from '../ganttUtils.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
}

const dayColumns = buildDayColumns('2026-08-01', '2026-08-31');
const ctx = { dayColumns, rowName: 'Mohamed Khaled', availabilityHours: {}, employeeHolidays: {}, employees: [] };

test('consolidate merges gapped fragments for same task + employee', () => {
  const merged = consolidateTaskEmployeeBars([
    {
      id: 'task-1-Mohamed-0',
      task_id: 1,
      employee: 'Mohamed Khaled',
      hours_by_day: { '2026-08-03': 2 },
      hours: 2,
      start: '2026-08-03',
      end: '2026-08-03',
    },
    {
      id: 'task-1-Mohamed-1',
      task_id: 1,
      employee: 'Mohamed Khaled',
      hours_by_day: { '2026-08-04': 8, '2026-08-05': 8 },
      hours: 16,
      start: '2026-08-04',
      end: '2026-08-05',
    },
  ]);

  assert(merged.length === 1, `expected 1 bar, got ${merged.length}`);
  assert(merged[0].hours_by_day['2026-08-03'] === 2, 'keeps first fragment hours');
  assert(merged[0].hours_by_day['2026-08-04'] === 8, 'keeps second fragment hours');
});

test('consolidated row leaves solo task left-aligned on shared day', () => {
  const rowBars = consolidateTaskEmployeeBars([
    {
      id: 'task-1-Mohamed-0',
      task_id: 1,
      employee: 'Mohamed Khaled',
      hours_by_day: { '2026-08-03': 2 },
      hours: 2,
      start: '2026-08-03',
      end: '2026-08-03',
    },
    {
      id: 'task-1-Mohamed-1',
      task_id: 1,
      employee: 'Mohamed Khaled',
      hours_by_day: { '2026-08-03': 6, '2026-08-04': 8 },
      hours: 14,
      start: '2026-08-03',
      end: '2026-08-04',
    },
  ]);

  const bar = rowBars[0];
  const slots = getDayTaskSlots(rowBars, '2026-08-03', ctx);
  const slot = slots.get(bar.id);
  assert(slot?.startSeg === 0, `expected left align, got startSeg=${slot?.startSeg}`);
  assert(slot?.hours === 8, `expected summed hours 8, got ${slot?.hours}`);
});

console.log(`\n${passed} passed`);
