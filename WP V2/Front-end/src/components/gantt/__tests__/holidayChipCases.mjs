/**
 * Run: npx --yes vite-node src/components/gantt/__tests__/holidayChipCases.mjs
 */
import { isBarActiveOnDay, rowHasBarOnDay } from '../ganttUtils.js';

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

const layoutContext = {
  rowName: 'Mohamed Khaled',
  employeeHolidays: {
    'Mohamed Khaled': { '2026-08-11': true },
  },
  employees: [{ id: 1, first_name: 'Mohamed', last_name: 'Khaled', name: 'Mohamed Khaled' }],
};

const barWithHolidayHours = {
  id: 'task-1',
  employee: 'Mohamed Khaled',
  hours_by_day: { '2026-08-11': 4 },
};

test('bars with hours on a holiday are not active for rendering', () => {
  assert(
    !isBarActiveOnDay(barWithHolidayHours, '2026-08-11', layoutContext),
    'expected holiday bar to be inactive for rendering',
  );
});

test('rowHasBarOnDay ignores holiday hours when layout context is provided', () => {
  assert(
    !rowHasBarOnDay([barWithHolidayHours], '2026-08-11', layoutContext),
    'expected no visible bar on holiday',
  );
});

test('rowHasBarOnDay without layout context still sees raw holiday hours', () => {
  assert(
    rowHasBarOnDay([barWithHolidayHours], '2026-08-11'),
    'expected legacy detection without holiday context',
  );
});

console.log(`\n${passed} passed`);
