/**
 * Run: npx --yes vite-node src/components/gantt/__tests__/trainingDaySegmentCases.mjs
 */
import {
  buildHistogramTimeline,
  histogramColumnLeft,
  histogramColumnWidthAt,
  timelineDayColumns,
} from '../ganttUtils.js';
import { buildTrainingBarSegments } from '../trainingBarEdits.js';
import { HISTOGRAM_DAY_PARTITIONS } from '../histogramLayout.js';

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

const ROW = 'Kostadin Radulov';
const DAY = '2026-09-24'; // Thursday
const timeline = buildHistogramTimeline('2026-09-21', '2026-09-27');
const dayColumns = timelineDayColumns(timeline);
const dayIndex = dayColumns.indexOf(DAY);

function taskBar(hours, id = 'task-1') {
  return {
    id,
    task_id: id,
    employee: ROW,
    hours_by_day: { [DAY]: hours },
    hours,
    start: DAY,
    end: DAY,
  };
}

function training(id, daySegment, hoursPerDay = 2) {
  return {
    id,
    employee_id: 41,
    title: `Course ${id}`,
    start_date: DAY,
    end_date: DAY,
    hours_per_day: hoursPerDay,
    day_segment: daySegment,
  };
}

/** Band index a partial-day training segment was drawn at. */
function drawnSection(segment) {
  const segmentWidth = histogramColumnWidthAt(timeline, dayIndex) / HISTOGRAM_DAY_PARTITIONS;
  return Math.round((segment.left - histogramColumnLeft(timeline, dayIndex) - 1) / segmentWidth);
}

function layout(trainings, rowBars = []) {
  return buildTrainingBarSegments(trainings, timeline, dayColumns, {
    rowName: ROW,
    rowBars,
    dailyHours: {},
    availabilityHours: {},
    employeeHolidays: {},
    employees: [],
  });
}

test('saved section is drawn on an empty day', () => {
  for (let section = 0; section < HISTOGRAM_DAY_PARTITIONS; section += 1) {
    const [segment] = layout([training(1, section)]);
    assert(drawnSection(segment) === section, `section ${section} drawn at ${drawnSection(segment)}`);
  }
});

test('saved section is drawn even when project bars occupy it (6h task day)', () => {
  for (let section = 0; section < HISTOGRAM_DAY_PARTITIONS; section += 1) {
    const [segment] = layout([training(1, section)], [taskBar(6)]);
    assert(
      drawnSection(segment) === section,
      `section ${section} drawn at ${drawnSection(segment)} over a 6h task`,
    );
  }
});

test('saved section is drawn on a fully booked day', () => {
  const [segment] = layout([training(1, 2)], [taskBar(8)]);
  assert(drawnSection(segment) === 2, `expected section 2, got ${drawnSection(segment)}`);
});

test('two trainings sharing a section (override) stay visible side by side', () => {
  const segments = layout([training(1, 1), training(2, 1)], [taskBar(6)]);
  assert(segments.length === 2, `expected 2 segments, got ${segments.length}`);
  const [first, second] = segments;
  assert(drawnSection(first) === 1, `first training should keep section 1, got ${drawnSection(first)}`);
  assert(drawnSection(second) !== 1, 'second training must not be drawn on top of the first');
});

test('trainings in different sections each keep their own section', () => {
  const segments = layout([training(1, 0), training(2, 3)], [taskBar(4)]);
  const sections = segments.map(drawnSection).sort();
  assert(sections.join(',') === '0,3', `expected sections 0,3, got ${sections.join(',')}`);
});

console.log(`\n${passed} passed`);
