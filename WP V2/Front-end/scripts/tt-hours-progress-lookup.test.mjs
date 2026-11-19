import assert from 'node:assert/strict';
import {
  buildTtHoursProgressIndex,
  enrichProgressProjectGroups,
  resolveTtLoggedHoursForTask,
} from '../src/utils/ttHoursProgressLookup.js';
import { normalizeTtHoursCache } from '../src/utils/ttHoursCache.js';

const sampleCache = normalizeTtHoursCache({
  version: 4,
  fetchedAt: Date.now(),
  dateRange: { start: '2026-08-01', end: '2026-09-14' },
  summaries: [{
    projectId: 901,
    wpProjectId: 42,
    wpMatchStatus: 'matched',
    projectName: '901 Client',
    wpProjectName: '901 Client WP',
    jobNumber: '901',
    totalTtHours: 12.5,
    taskRows: [{
      taskName: '4.1 - Bill of Quantities',
      ttHours: 7.5,
      planHours: 10,
      variance: -2.5,
      employeeHours: [{ userId: 3, name: 'John Smith', hours: 7.5 }],
    }, {
      taskName: '3.0 - Measurements',
      ttHours: 5,
      planHours: 8,
      variance: -3,
      employeeHours: [{ userId: 3, name: 'John Smith', hours: 5 }],
    }],
    employeeRows: [{ userId: 3, name: 'John Smith', hours: 12.5 }],
  }],
});

assert.ok(sampleCache, 'cache normalizes');
assert.equal(sampleCache.summaries[0].taskRows.length, 2);
assert.equal(sampleCache.summaries[0].wpProjectId, 42);

const index = buildTtHoursProgressIndex(sampleCache.summaries);
assert.equal(index.size, 1);

const employee = { id: 1, first_name: 'John', last_name: 'Smith' };
const hours = resolveTtLoggedHoursForTask({
  index,
  wpProjectId: 42,
  taskName: '4.1 Bill of Quantities',
  employee,
});
assert.equal(hours, 7.5);

const enriched = enrichProgressProjectGroups([
  {
    project: { id: 42, name: '901 Client WP' },
    tasks: [{ id: 1, task_name: '4.1 - Bill of Quantities' }],
  },
], index, employee);

assert.equal(enriched[0].tasks[0].tt_hours_logged, '7.5');

console.log('tt-hours-progress-lookup.test.mjs: ok');
