import {
  addDays,
  buildDayColumns,
  buildGapOnlyDayCell,
  dayCapacityForRow,
  isTrainingGapDayCell,
  lookupDayHoursForRow,
  parseYmd,
  sumEmployeeGapHoursInRange,
  trainingGapHoursFromCell,
} from '../components/gantt/ganttUtils';
import { employeeDisplayName, employeeTeamName } from './employeeNames';
import { formatDisplayDate } from './dateFormat';
import { compareTeamNames, isNrmSectionOperative } from './teamOrder';
import { trainingOverlapsViewRange } from './trainingGroups';
import {
  GAP_NOTIFY_DISMISS_KEY,
  GAP_NOTIFY_TOAST_RANGES_KEY,
  gapNotifyReadIdsStorageKey,
  notifyGapReadStateChanged,
} from './trainingGapNotifyStorage';

export const TRAINING_GAP_NOTIFY_WEEKS = 3;
export const TRAINING_GAP_NOTIFY_MIN_HOURS = 8;

const DISMISS_STORAGE_KEY = GAP_NOTIFY_DISMISS_KEY;
const TOAST_RANGE_STORAGE_KEY = GAP_NOTIFY_TOAST_RANGES_KEY;

export function nextWeeksDateRange(weeks = TRAINING_GAP_NOTIFY_WEEKS) {
  const today = parseYmd(new Date());
  return {
    start: today,
    end: addDays(today, weeks * 7 - 1),
  };
}

/** Prefer /employees records (team object, names) while keeping histogram ids. */
export function mergeHistogramEmployees(histogramEmployees = [], employees = []) {
  const byId = new Map(
    (employees ?? []).map((employee) => [String(employee.id), employee]),
  );
  const source = (histogramEmployees?.length ? histogramEmployees : employees) ?? [];

  return source.map((entry) => {
    const full = byId.get(String(entry.id));
    return full ? { ...entry, ...full } : entry;
  });
}

function countOpenSlotDaysInWindows({
  rowName,
  gapWindows,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
}) {
  if (!Array.isArray(gapWindows) || gapWindows.length === 0) {
    return 0;
  }

  return gapWindows.reduce((total, gapWindow) => {
    const daysInWindow = buildDayColumns(gapWindow.start_date, gapWindow.end_date).filter((day) => {
      const cell = buildGapOnlyDayCell({
        rowName,
        day,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        employees,
      });
      return isTrainingGapDayCell(cell);
    }).length;
    return total + daysInWindow;
  }, 0);
}

function collectGapWindowsInRange({
  rowName,
  startYmd,
  endYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  blockedDays = null,
}) {
  const windows = [];
  let current = null;

  // Weekdays only — weekends are transparent so Mon–Fri stays one training window.
  const weekdays = buildDayColumns(startYmd, endYmd).filter((day) => {
    const cell = buildGapOnlyDayCell({
      rowName,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
    return cell.kind !== 'weekend';
  });

  weekdays.forEach((day) => {
    if (blockedDays?.has(String(day))) {
      if (current) {
        windows.push(current);
        current = null;
      }
      return;
    }

    const cell = buildGapOnlyDayCell({
      rowName,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
    const hasGap = isTrainingGapDayCell(cell);

    if (hasGap) {
      if (!current) {
        current = {
          start_date: day,
          end_date: day,
          gapHours: cell.gapHours,
        };
      } else {
        current.end_date = day;
        current.gapHours += cell.gapHours;
      }
      return;
    }

    if (current) {
      windows.push(current);
      current = null;
    }
  });

  if (current) {
    windows.push(current);
  }

  return windows;
}

function gapHoursInWindow({
  rowName,
  startYmd,
  endYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  blockedDays = null,
}) {
  let total = 0;
  buildDayColumns(startYmd, endYmd).forEach((day) => {
    if (blockedDays?.has(String(day))) {
      return;
    }
    const cell = buildGapOnlyDayCell({
      rowName,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
    if (isTrainingGapDayCell(cell)) {
      total += trainingGapHoursFromCell(cell);
    }
  });
  return total;
}

function buildTrainingBlockedDays(trainings = [], startYmd, endYmd) {
  const blocked = new Set();
  (trainings ?? []).forEach((training) => {
    const trainingStart = training?.start_date || training?.start;
    const trainingEnd = training?.end_date || training?.end;
    if (!trainingStart || !trainingEnd) {
      return;
    }
    if (!trainingOverlapsViewRange(training, startYmd, endYmd)) {
      return;
    }
    buildDayColumns(trainingStart, trainingEnd).forEach((day) => {
      if (String(day) >= String(startYmd) && String(day) <= String(endYmd)) {
        blocked.add(String(day));
      }
    });
  });
  return blocked;
}

/**
 * Nearest capacity-gap window usable for training.
 * - Weekday-contiguous (weekends don't split the window)
 * - Prefers windows on/after fromYmd and clips past days out of the result
 * - Excludes days already covered by scheduled trainings
 */
export function closestGapWindowInRange({
  rowName,
  startYmd,
  endYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  fromYmd = null,
  trainings = [],
}) {
  if (!rowName || !startYmd || !endYmd) {
    return null;
  }

  const anchor = fromYmd || parseYmd(new Date());
  const rangeStart = String(anchor) > String(startYmd) ? String(anchor) : String(startYmd);
  if (String(rangeStart) > String(endYmd)) {
    return null;
  }

  const blockedDays = buildTrainingBlockedDays(trainings, rangeStart, endYmd);
  const windows = collectGapWindowsInRange({
    rowName,
    startYmd: rangeStart,
    endYmd,
    dailyHours,
    availabilityHours,
    employeeHolidays,
    employees,
    blockedDays,
  });

  if (windows.length === 0) {
    return null;
  }

  const closest = [...windows].sort((left, right) => (
    String(left.start_date).localeCompare(String(right.start_date))
    || right.gapHours - left.gapHours
  ))[0];

  const clippedStart = String(closest.start_date) < String(rangeStart)
    ? rangeStart
    : closest.start_date;

  const gapHours = gapHoursInWindow({
    rowName,
    startYmd: clippedStart,
    endYmd: closest.end_date,
    dailyHours,
    availabilityHours,
    employeeHolidays,
    employees,
    blockedDays,
  });

  if (gapHours <= 0.05) {
    return null;
  }

  return {
    start_date: clippedStart,
    end_date: closest.end_date,
    gapHours,
  };
}

export const TRAINING_URGENCY_DATE_HINTS = {
  U0: 'Suggests the largest free window in the next 8 weeks (flexible timing).',
  U1: 'Suggests a free window between project work in the next 6 weeks.',
  U2: 'Suggests the soonest upcoming free gap in the next 3 weeks.',
  U3: 'Suggests the earliest available day from today (may need override).',
};

function hasBookedWorkNearDay({
  rowName,
  fromYmd,
  toYmd,
  dailyHours,
  employees,
}) {
  if (!rowName || !fromYmd || !toYmd || String(fromYmd) > String(toYmd)) {
    return false;
  }

  return buildDayColumns(fromYmd, toYmd).some((day) => {
    const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
    return booked > 0.05;
  });
}

function fitSuggestedWindowToDuration(window, duration = '1-2 hours', hoursPerDay = 2) {
  if (!window?.start_date) {
    return null;
  }

  // Multi-day must span at least 2 free weekdays.
  if (duration === 'Multi-day') {
    const dayCount = Number(window.dayCount)
      || (window.start_date === window.end_date ? 1 : 2);
    if (dayCount < 2 || window.start_date === window.end_date) {
      return null;
    }
    return {
      start_date: window.start_date,
      end_date: window.end_date,
      gapHours: window.gapHours,
      dayCount,
    };
  }

  return {
    start_date: window.start_date,
    end_date: window.start_date,
    gapHours: window.minDayGap ?? window.gapHours ?? hoursPerDay,
    dayCount: 1,
  };
}

/**
 * Suggest start/end dates from urgency for one or more operatives.
 * With multiple operatives, only shared free days (enough gap for all) are used.
 *
 * U0 No pressure → largest shared gap (8 weeks)
 * U1 Between projects → shared gap bounded by project work (6 weeks)
 * U2 Next gap → soonest shared gap (3 weeks)
 * U3 Drop everything → earliest shared available weekday (may conflict)
 *
 * Multi-day always spans 2+ consecutive free weekdays.
 */
export function suggestTrainingDatesForUrgency({
  urgency = 'U1',
  employee = null,
  selectedEmployees = null,
  employees = [],
  duration = '1-2 hours',
  hoursPerDay = 2,
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  trainings = [],
}) {
  const targets = (Array.isArray(selectedEmployees) && selectedEmployees.length > 0
    ? selectedEmployees
    : (employee ? [employee] : [])
  ).filter(Boolean);

  if (targets.length === 0) {
    return null;
  }

  const rowNames = targets.map((entry) => employeeDisplayName(entry)).filter(Boolean);
  if (rowNames.length === 0) {
    return null;
  }

  const today = parseYmd(new Date());
  const neededHours = Math.max(0.25, Number(hoursPerDay) || durationToHoursFallback(duration));
  const multiDay = duration === 'Multi-day';
  const minDays = multiDay ? 2 : 1;
  const multiLabel = targets.length > 1 ? ` for ${targets.length} operatives` : '';
  const baseHint = TRAINING_URGENCY_DATE_HINTS[urgency] || TRAINING_URGENCY_DATE_HINTS.U1;
  const hint = targets.length > 1
    ? `${baseHint} Uses shared free days${multiLabel}.`
    : baseHint;

  // Existing training occupancy is expected in dailyHours (merged by callers).
  // Do not hard-block entire training days — a free 2h band must still suggest.
  void trainings;

  if (urgency === 'U3') {
    const earliest = nextSharedTrainingReadyWindow({
      rowNames,
      fromYmd: today,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      minGapHours: neededHours,
      minDays,
      allowConflict: true,
    });
    const fitted = fitSuggestedWindowToDuration(earliest, duration, neededHours);
    if (fitted && String(fitted.start_date).slice(0, 10) >= today) {
      return { ...fitted, urgency, hint, strategy: 'earliest_day' };
    }
    return null;
  }

  const baseWeeks = urgency === 'U0' ? 8 : urgency === 'U1' ? 6 : 3;
  const weeks = multiDay ? Math.max(baseWeeks, 6) : baseWeeks;
  const endYmd = addDays(today, weeks * 7 - 1);
  let windows = collectSharedTrainingReadyWindows({
    rowNames,
    startYmd: today,
    endYmd,
    dailyHours,
    availabilityHours,
    employeeHolidays,
    employees,
    minGapHours: neededHours,
  }).filter((window) => String(window.start_date).slice(0, 10) >= today);

  if (multiDay) {
    windows = windows.filter((window) => (window.dayCount || 0) >= 2);
  }

  if (windows.length === 0 && multiDay) {
    const wideEnd = addDays(today, 8 * 7 - 1);
    windows = collectSharedTrainingReadyWindows({
      rowNames,
      startYmd: today,
      endYmd: wideEnd,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      minGapHours: neededHours,
    }).filter((window) => (
      (window.dayCount || 0) >= 2
      && String(window.start_date).slice(0, 10) >= today
    ));
  }

  if (windows.length === 0) {
    const fallback = nextSharedTrainingReadyWindow({
      rowNames,
      fromYmd: today,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      minGapHours: neededHours,
      minDays,
      allowConflict: false,
      maxDays: Math.max(weeks, 8) * 7,
    });
    const fitted = fitSuggestedWindowToDuration(fallback, duration, neededHours);
    if (fitted && String(fitted.start_date).slice(0, 10) >= today) {
      return {
        ...fitted,
        urgency,
        hint: multiDay
          ? `${hint} Using the soonest ${fitted.dayCount || 2}+ day shared free stretch.`
          : `${hint} Using the next shared free day with enough capacity.`,
        strategy: 'fallback_day',
      };
    }
    return null;
  }

  let chosen = null;

  if (urgency === 'U2') {
    chosen = [...windows].sort((left, right) => (
      String(left.start_date).localeCompare(String(right.start_date))
      || right.dayCount - left.dayCount
      || right.minDayGap - left.minDayGap
    ))[0];
  } else if (urgency === 'U1') {
    const between = windows.filter((window) => (
      rowNames.every((rowName) => {
        const hasBefore = hasBookedWorkNearDay({
          rowName,
          fromYmd: addDays(window.start_date, -14),
          toYmd: addDays(window.start_date, -1),
          dailyHours,
          employees,
        });
        const hasAfter = hasBookedWorkNearDay({
          rowName,
          fromYmd: addDays(window.end_date, 1),
          toYmd: addDays(window.end_date, 14),
          dailyHours,
          employees,
        });
        return hasBefore && hasAfter;
      })
    ));

    const pool = between.length > 0 ? between : windows;
    chosen = [...pool].sort((left, right) => (
      String(left.start_date).localeCompare(String(right.start_date))
      || right.dayCount - left.dayCount
      || right.gapHours - left.gapHours
    ))[0];
  } else {
    chosen = [...windows].sort((left, right) => (
      right.gapHours - left.gapHours
      || right.dayCount - left.dayCount
      || String(left.start_date).localeCompare(String(right.start_date))
    ))[0];
  }

  const fitted = fitSuggestedWindowToDuration(chosen, duration, neededHours);
  if (!fitted || String(fitted.start_date).slice(0, 10) < today) {
    return null;
  }

  return {
    ...fitted,
    urgency,
    hint: multiDay
      ? `${hint} Spans ${fitted.dayCount || 2} shared free days for Multi-day.`
      : hint,
    strategy: urgency === 'U0' ? 'largest_gap' : urgency === 'U1' ? 'between_projects' : 'next_gap',
  };
}

function sharedDayReadiness({
  rowNames,
  day,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  minGapHours = 1,
  allowConflict = false,
}) {
  const threshold = Math.max(0.25, Number(minGapHours) || 1) - 0.05;
  let minGap = Number.POSITIVE_INFINITY;

  for (const rowName of rowNames) {
    const cell = buildGapOnlyDayCell({
      rowName,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });

    if (cell.kind === 'weekend') {
      return { weekend: true, ready: false, gap: 0 };
    }
    if (cell.kind === 'holiday') {
      return { weekend: false, ready: false, gap: 0 };
    }

    if (allowConflict) {
      const capacity = dayCapacityForRow(rowName, day, availabilityHours, employeeHolidays, employees);
      if (capacity == null || capacity <= 0.05) {
        return { weekend: false, ready: false, gap: 0 };
      }
      minGap = Math.min(minGap, trainingGapHoursFromCell(cell) || capacity);
      continue;
    }

    if (!isTrainingGapDayCell(cell, threshold)) {
      return { weekend: false, ready: false, gap: 0 };
    }
    minGap = Math.min(minGap, trainingGapHoursFromCell(cell));
  }

  return {
    weekend: false,
    ready: Number.isFinite(minGap),
    gap: Number.isFinite(minGap) ? minGap : 0,
  };
}

function collectSharedTrainingReadyWindows({
  rowNames,
  startYmd,
  endYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  blockedDays = null,
  minGapHours = 1,
}) {
  const windows = [];
  let current = null;
  const names = rowNames.filter(Boolean);
  if (names.length === 0) {
    return windows;
  }

  const weekdays = buildDayColumns(startYmd, endYmd).filter((day) => {
    const state = sharedDayReadiness({
      rowNames: names,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      minGapHours,
    });
    return !state.weekend;
  });

  weekdays.forEach((day) => {
    if (blockedDays?.has(String(day))) {
      if (current) {
        windows.push(current);
        current = null;
      }
      return;
    }

    const state = sharedDayReadiness({
      rowNames: names,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      minGapHours,
    });

    if (state.ready) {
      if (!current) {
        current = {
          start_date: day,
          end_date: day,
          gapHours: state.gap,
          minDayGap: state.gap,
          dayCount: 1,
        };
      } else {
        current.end_date = day;
        current.gapHours += state.gap;
        current.minDayGap = Math.min(current.minDayGap, state.gap);
        current.dayCount += 1;
      }
      return;
    }

    if (current) {
      windows.push(current);
      current = null;
    }
  });

  if (current) {
    windows.push(current);
  }

  return windows;
}

function nextSharedTrainingReadyWindow({
  rowNames,
  fromYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  minGapHours = 1,
  minDays = 1,
  allowConflict = false,
  maxDays = 56,
}) {
  const names = rowNames.filter(Boolean);
  if (names.length === 0) {
    return null;
  }

  let pending = null;

  for (let offset = 0; offset < maxDays; offset += 1) {
    const day = addDays(fromYmd, offset);
    const state = sharedDayReadiness({
      rowNames: names,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      minGapHours,
      allowConflict,
    });

    if (state.weekend) {
      continue;
    }

    if (state.ready) {
      if (!pending) {
        pending = {
          start_date: day,
          end_date: day,
          gapHours: state.gap,
          minDayGap: state.gap,
          dayCount: 1,
        };
      } else {
        pending.end_date = day;
        pending.gapHours += state.gap;
        pending.minDayGap = Math.min(pending.minDayGap, state.gap);
        pending.dayCount += 1;
      }
      continue;
    }

    if (pending && pending.dayCount >= minDays) {
      return pending;
    }
    pending = null;
  }

  return pending && pending.dayCount >= minDays ? pending : null;
}

function durationToHoursFallback(duration) {
  if (duration === 'Full day' || duration === 'Multi-day') {
    return 8;
  }
  if (duration === 'Half day' || duration === '2-4 hours') {
    return 4;
  }
  if (duration === '1-2 hours') {
    return 2;
  }
  return 2;
}

function findSharedGapWindow({
  rowNames,
  startYmd,
  endYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  minWeekdays = 1,
}) {
  const names = rowNames.filter(Boolean);
  if (names.length === 0) {
    return null;
  }

  const weekdays = buildDayColumns(startYmd, endYmd).filter((day) => {
    const cell = buildGapOnlyDayCell({
      rowName: names[0],
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
    return cell.kind !== 'weekend';
  });

  let best = null;

  for (let index = 0; index <= weekdays.length - minWeekdays; index += 1) {
    for (let span = weekdays.length - index; span >= minWeekdays; span -= 1) {
      const window = weekdays.slice(index, index + span);
      const allHaveGap = window.every((day) => (
        names.every((rowName) => {
          const cell = buildGapOnlyDayCell({
            rowName,
            day,
            dailyHours,
            availabilityHours,
            employeeHolidays,
            employees,
          });
          return isTrainingGapDayCell(cell);
        })
      ));

      if (allHaveGap) {
        return {
          start_date: window[0],
          end_date: window[window.length - 1],
        };
      }
    }
  }

  return best;
}

function sumBookedAndCapacityInRange({
  rowName,
  startYmd,
  endYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
}) {
  let bookedHours = 0;
  let capacityHours = 0;

  buildDayColumns(startYmd, endYmd).forEach((day) => {
    const cell = buildGapOnlyDayCell({
      rowName,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
    if (cell.kind === 'weekend' || cell.kind === 'holiday' || cell.kind === 'none') {
      return;
    }

    const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
    const capacity = dayCapacityForRow(rowName, day, availabilityHours, employeeHolidays, employees) ?? 0;
    bookedHours += booked;
    capacityHours += capacity;
  });

  return { bookedHours, capacityHours };
}

export function buildTrainingGapOpportunities({
  employees = [],
  trainings = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  startYmd,
  endYmd,
  minGapHours = TRAINING_GAP_NOTIFY_MIN_HOURS,
}) {
  if (!startYmd || !endYmd || employees.length === 0) {
    return [];
  }

  const opportunities = [];

  employees.forEach((employee) => {
    if (!isNrmSectionOperative(employee)) {
      return;
    }

    const name = employeeDisplayName(employee);
    if (!name) {
      return;
    }

    const gapHours = sumEmployeeGapHoursInRange({
      rowName: name,
      startYmd,
      endYmd,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });

    if (gapHours < minGapHours) {
      return;
    }

    const gapWindows = collectGapWindowsInRange({
      rowName: name,
      startYmd,
      endYmd,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
    const gapWindow = gapWindows[0] || null;

    const load = sumBookedAndCapacityInRange({
      rowName: name,
      startYmd,
      endYmd,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });

    // Low-load only: scheduled hours must be below plan capacity.
    if (load.bookedHours >= load.capacityHours) {
      return;
    }

    const openSlotDays = countOpenSlotDaysInWindows({
      rowName: name,
      gapWindows,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });

    opportunities.push({
      employeeId: employee.id,
      name,
      teamName: employeeTeamName(employee) || '',
      gapHours,
      gapWindow,
      gapWindows,
      bookedHours: load.bookedHours,
      capacityHours: load.capacityHours,
      openSlotDays,
    });
  });

  return opportunities.sort((left, right) => (
    compareTeamNames(left.teamName || 'No Team', right.teamName || 'No Team')
    || String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' })
  ));
}

export function groupGapOpportunitiesByTeam(opportunities = []) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return [];
  }

  const byTeam = new Map();
  opportunities.forEach((row) => {
    const teamName = row.teamName || 'No Team';
    if (!byTeam.has(teamName)) {
      byTeam.set(teamName, []);
    }
    byTeam.get(teamName).push(row);
  });

  return Array.from(byTeam.entries())
    .sort(([leftTeam], [rightTeam]) => compareTeamNames(leftTeam, rightTeam))
    .map(([teamName, rows]) => ({
      teamName,
      rows: [...rows].sort((left, right) => (
        String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' })
      )),
    }));
}

export function buildSharedGapAssignmentWindow(opportunities, context) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return null;
  }

  const rowNames = opportunities.map((row) => row.name);
  const { start, end } = nextWeeksDateRange();

  const shared = findSharedGapWindow({
    rowNames,
    startYmd: start,
    endYmd: end,
    ...context,
  });

  if (shared) {
    return shared;
  }

  const firstWindow = opportunities.find((row) => row.gapWindow)?.gapWindow;
  if (firstWindow) {
    return {
      start_date: firstWindow.start_date,
      end_date: firstWindow.end_date,
    };
  }

  return { start_date: start, end_date: end };
}

export function buildGapNotificationFingerprint(opportunities, range) {
  return buildGapToastDismissKey(range);
}

export function buildGapToastDismissKey(range) {
  if (!range?.start || !range?.end) {
    return '';
  }
  return `${range.start}|${range.end}`;
}

function readJsonArray(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function writeJsonArray(key, values) {
  try {
    localStorage.setItem(key, JSON.stringify(values.slice(-80)));
  } catch {
    // ignore storage failures
  }
}

function readJsonObject(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

export function isGapNotificationDismissed(fingerprint) {
  if (!fingerprint) {
    return false;
  }

  const stored = readJsonArray(DISMISS_STORAGE_KEY);
  const toastRanges = readJsonArray(TOAST_RANGE_STORAGE_KEY);
  return stored.includes(fingerprint) || toastRanges.includes(fingerprint);
}

export function dismissGapNotification(fingerprint) {
  if (!fingerprint) {
    return;
  }

  writeJsonArray(TOAST_RANGE_STORAGE_KEY, [...readJsonArray(TOAST_RANGE_STORAGE_KEY), fingerprint]);
  writeJsonArray(DISMISS_STORAGE_KEY, [...readJsonArray(DISMISS_STORAGE_KEY), fingerprint]);
}

export function getReadGapNotificationIds(rangeKey, userId = null) {
  if (!rangeKey) {
    return [];
  }
  const stored = readJsonObject(gapNotifyReadIdsStorageKey(userId));
  return Array.isArray(stored[rangeKey]) ? stored[rangeKey].map(String) : [];
}

export function markGapNotificationsRead(rangeKey, employeeIds = [], userId = null) {
  if (!rangeKey) {
    return;
  }
  const storageKey = gapNotifyReadIdsStorageKey(userId);
  const stored = readJsonObject(storageKey);
  const next = new Set([
    ...(Array.isArray(stored[rangeKey]) ? stored[rangeKey].map(String) : []),
    ...employeeIds.map((id) => String(id)).filter(Boolean),
  ]);
  stored[rangeKey] = [...next];
  try {
    localStorage.setItem(storageKey, JSON.stringify(stored));
    notifyGapReadStateChanged();
  } catch {
    // ignore
  }
}

export function countUnreadGapNotifications(opportunities = [], rangeKey, userId = null) {
  const readIds = new Set(getReadGapNotificationIds(rangeKey, userId));
  return (opportunities || []).filter((row) => !readIds.has(String(row.employeeId))).length;
}

function gapWindowsForOpportunity(row) {
  if (Array.isArray(row?.gapWindows) && row.gapWindows.length > 0) {
    return row.gapWindows;
  }
  return row?.gapWindow ? [row.gapWindow] : [];
}

function formatGapHours(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '0';
  }
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

/** Indefinite article before a numeric hours label (a 120h / an 8h). */
export function indefiniteArticleForHoursLabel(hoursLabel) {
  const text = String(hoursLabel ?? '').trim().toLowerCase();
  // Spoken forms that start with a vowel sound: eight, eleven, eighteen, eighty…
  if (/^8/.test(text) || /^11(\D|$)/.test(text) || /^18(\D|$)/.test(text)) {
    return 'an';
  }
  return 'a';
}

function formatGapSlotRange(gapWindow) {
  if (!gapWindow?.start_date) {
    return null;
  }
  const start = formatDisplayDate(gapWindow.start_date) || gapWindow.start_date;
  const end = formatDisplayDate(gapWindow.end_date) || gapWindow.end_date;
  if (start && end && start !== end) {
    return `${start} – ${end}`;
  }
  return start || end;
}

export function formatGapOpportunityMessage(row, { closestOnly = false } = {}) {
  if (!row) {
    return '';
  }

  const booked = formatGapHours(row.bookedHours);
  const capacity = formatGapHours(row.capacityHours);
  const capacityArticle = indefiniteArticleForHoursLabel(capacity);
  const windows = closestOnly && row.gapWindow
    ? [row.gapWindow]
    : gapWindowsForOpportunity(row);
  const slots = windows
    .map((window) => formatGapSlotRange(window))
    .filter(Boolean);
  const slotText = slots.length > 0 ? ` Available slots: ${slots.join('; ')}.` : '';
  return `${row.name} has an upcoming low-load period — ${booked}h scheduled against ${capacityArticle} ${capacity}h plan.${slotText}`;
}

export function pickClosestGapOpportunity(opportunities = [], fromYmd = null) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return null;
  }

  const anchor = fromYmd || parseYmd(new Date());
  let closest = null;

  opportunities.forEach((row) => {
    gapWindowsForOpportunity(row).forEach((window) => {
      if (!window?.start_date) {
        return;
      }
      if (String(window.end_date) < String(anchor)) {
        return;
      }

      if (
        !closest
        || String(window.start_date) < String(closest.gapWindow.start_date)
        || (
          String(window.start_date) === String(closest.gapWindow.start_date)
          && String(row.name).localeCompare(String(closest.name), undefined, { sensitivity: 'base' }) < 0
        )
      ) {
        closest = { ...row, gapWindow: window };
      }
    });
  });

  if (closest) {
    return closest;
  }

  const fallback = opportunities[0];
  const fallbackWindow = gapWindowsForOpportunity(fallback)[0] || fallback.gapWindow || null;
  return fallbackWindow ? { ...fallback, gapWindow: fallbackWindow } : fallback;
}
