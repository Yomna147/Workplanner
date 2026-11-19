import { employeeDisplayName, employeeMatchesName } from './employeeNames';
import { isUnsavedTrainingRow } from './trainingCourses';

const FALLBACK_TRAINING_HOURS_PER_DAY = 2;

function isWeekendYmd(day) {
  const match = String(day || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const weekday = date.getDay();
  return weekday === 0 || weekday === 6;
}

function isHolidayYmd(name, day, employeeHolidays = {}) {
  if (!name || !day) {
    return false;
  }
  if (employeeHolidays?.[name]?.[day]) {
    return true;
  }
  return Object.entries(employeeHolidays || {}).some(([rowName, days]) => (
    Boolean(days?.[day]) && rowName === name
  ));
}

function cloneDailyHours(dailyHours = {}) {
  const next = {};
  Object.entries(dailyHours || {}).forEach(([name, days]) => {
    next[name] = { ...(days || {}) };
  });
  return next;
}

function addHours(map, name, day, hours) {
  if (!name || !day || !Number.isFinite(hours) || hours <= 0) {
    return;
  }
  if (!map[name]) {
    map[name] = {};
  }
  map[name][day] = Math.round(((Number(map[name][day]) || 0) + hours) * 100) / 100;
}

function eachWorkingDay(startDate, endDate, visit) {
  const start = String(startDate || '').slice(0, 10);
  const end = String(endDate || start).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    return;
  }

  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 400) {
    if (!isWeekendYmd(cursor)) {
      visit(cursor);
    }
    const [year, month, day] = cursor.split('-').map(Number);
    const next = new Date(year, month - 1, day + 1);
    const y = next.getFullYear();
    const m = String(next.getMonth() + 1).padStart(2, '0');
    const d = String(next.getDate()).padStart(2, '0');
    cursor = `${y}-${m}-${d}`;
    guard += 1;
  }
}

function resolveTrainingEmployee(training, employees = []) {
  return employees.find((entry) => String(entry.id) === String(training?.employee_id))
    || training?.employee
    || null;
}

function resolveTrainingEmployeeName(training, employees = []) {
  const employee = resolveTrainingEmployee(training, employees);
  return employeeDisplayName(employee)
    || String(training?.employee_name || '').trim();
}

function resolveTrainingHoursPerDay(training) {
  const explicit = Number(training?.hours_per_day);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return FALLBACK_TRAINING_HOURS_PER_DAY;
}

/** Write hours under the canonical name and any existing dailyHours keys for that person. */
function addHoursForEmployee(map, employee, canonicalName, day, hours, employees = []) {
  const names = new Set();
  if (canonicalName) {
    names.add(canonicalName);
  }
  if (employee) {
    Object.keys(map).forEach((key) => {
      if (employeeMatchesName(employee, key)) {
        names.add(key);
      }
    });
  } else if (canonicalName) {
    Object.keys(map).forEach((key) => {
      if (employeeMatchesName({ name: canonicalName, first_name: canonicalName }, key)) {
        names.add(key);
      }
    });
  }
  // Always stamp the canonical display name used by Gap view rows.
  if (canonicalName) {
    names.add(canonicalName);
  }
  names.forEach((name) => addHours(map, name, day, hours));
  void employees;
}

/**
 * Add existing training hours onto project dailyHours so gap, date pickers,
 * and override checks treat booked training as occupied time.
 */
export function mergeTrainingHoursIntoDailyHours(
  dailyHours = {},
  trainings = [],
  employees = [],
  { excludeIds = [], employeeHolidays = {} } = {},
) {
  const excluded = new Set(
    (excludeIds || [])
      .map((id) => String(id ?? '').trim())
      .filter((id) => id && !id.startsWith('new-')),
  );
  const next = cloneDailyHours(dailyHours);

  (trainings || []).forEach((training) => {
    if (!training) {
      return;
    }
    if (training.id != null && excluded.has(String(training.id))) {
      return;
    }
    if (isUnsavedTrainingRow(training)) {
      return;
    }

    const employee = resolveTrainingEmployee(training, employees);
    const name = resolveTrainingEmployeeName(training, employees);
    const hours = resolveTrainingHoursPerDay(training);
    if (!name || !Number.isFinite(hours) || hours <= 0) {
      return;
    }

    eachWorkingDay(training.start_date, training.end_date, (day) => {
      if (isHolidayYmd(name, day, employeeHolidays)) {
        return;
      }
      if (employee && isHolidayYmd(employeeDisplayName(employee), day, employeeHolidays)) {
        return;
      }
      addHoursForEmployee(next, employee, name, day, hours, employees);
    });
  });

  return next;
}

export function overlappingTrainingsOnDay(trainings = [], employeeId, day, { excludeIds = [] } = {}) {
  const excluded = new Set((excludeIds || []).map((id) => String(id)));
  const ymd = String(day || '').slice(0, 10);
  if (!ymd || employeeId == null || employeeId === '') {
    return [];
  }

  return (trainings || []).filter((training) => {
    if (!training || (training.id != null && excluded.has(String(training.id)))) {
      return false;
    }
    if (String(training.employee_id) !== String(employeeId)) {
      return false;
    }
    const start = String(training.start_date || '').slice(0, 10);
    const end = String(training.end_date || start).slice(0, 10);
    return start && ymd >= start && ymd <= end;
  });
}
