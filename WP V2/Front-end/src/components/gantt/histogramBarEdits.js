import {
  employeeMatchesName,
  employeeNameKey,
  resolveHistogramAssigneeName,
} from '../../utils/employeeNames';
import {
  addDays,
  areConsecutiveWorkdays,
  barHoursOnDay,
  dayCapacityForRow,
  dayLabel,
  isEmployeeHolidayDay,
  isWeekend,
} from './ganttUtils';
import { HISTOGRAM_DAY_PARTITIONS, HISTOGRAM_DEFAULT_WORK_DAY_HOURS } from './histogramLayout';

function roundHours(value) {
  return Math.round(value * 4) / 4;
}

function barMatchesMovingAssignment(movingBar, other) {
  if (!movingBar || !other) {
    return false;
  }

  if (other.id === movingBar.id) {
    return true;
  }

  return String(other.task_id) === String(movingBar.task_id)
    && employeeNameKey(other.employee) === employeeNameKey(movingBar.employee);
}

function rowBarsForCapacity(layoutContext = {}) {
  return layoutContext.sourceRowBars ?? layoutContext.rowBars ?? [];
}

function hoursBookedOnRowDay(rowBars = [], day, excludeBar = null, extraBookedByDay = {}) {
  const fromBars = (rowBars ?? []).reduce((sum, other) => {
    if (excludeBar && barMatchesMovingAssignment(excludeBar, other)) {
      return sum;
    }
    return sum + barHoursOnDay(other, day);
  }, 0);

  return roundHours(fromBars + (Number(extraBookedByDay[day]) || 0));
}

function dayCapacityForLayoutContext(rowName, day, layoutContext = {}) {
  if (!rowName || !day) {
    return null;
  }

  return dayCapacityForRow(
    rowName,
    day,
    layoutContext.availabilityHours,
    layoutContext.employeeHolidays,
    layoutContext.employees,
  );
}

function remainingCapacityOnRowDay(
  rowName,
  day,
  rowBars = [],
  layoutContext = {},
  excludeBar = null,
  extraBookedByDay = {},
) {
  const capacity = dayCapacityForLayoutContext(rowName, day, layoutContext);
  if (capacity == null) {
    return HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
  }

  const booked = hoursBookedOnRowDay(rowBars, day, excludeBar, extraBookedByDay);
  return Math.max(0, roundHours(capacity - booked));
}

function findSpillDayForOverflow(
  startDay,
  layoutContext,
  bar,
  plannedHoursByDay,
  overflow,
) {
  const rowName = layoutContext.rowName;
  const rowBars = rowBarsForCapacity(layoutContext);
  let cursor = startDay;

  for (let guard = 0; guard < 42 && overflow > 0.001; guard += 1) {
    cursor = firstAssignableWorkdayOnOrAfter(addDays(cursor, 1), layoutContext);
    if (!cursor) {
      return null;
    }

    const room = remainingCapacityOnRowDay(
      rowName,
      cursor,
      rowBars,
      layoutContext,
      bar,
      plannedHoursByDay,
    );
    const placed = Math.min(overflow, room);
    if (placed > 0.001) {
      return { day: cursor, placed: roundHours(placed) };
    }
  }

  return null;
}

function describeShiftBlockReason(bar, dayDelta, layoutContext, movingDays = []) {
  const rowName = layoutContext.rowName;
  const rowBars = rowBarsForCapacity(layoutContext);
  const dayColumns = layoutContext.dayColumns ?? [];

  for (const day of movingDays) {
    const newDay = shiftDayByWorkdays(day, dayDelta, dayColumns, layoutContext);
    if (!newDay) {
      continue;
    }

    const movingHours = barHoursOnDay(bar, day);
    const capacity = dayCapacityForLayoutContext(rowName, newDay, layoutContext);
    const booked = hoursBookedOnRowDay(rowBars, newDay, bar);
    const room = capacity == null
      ? HISTOGRAM_DEFAULT_WORK_DAY_HOURS
      : Math.max(0, roundHours(capacity - booked));

    if (movingHours > room + 0.001) {
      if (capacity != null && booked > 0.001) {
        return `Only ${room.toFixed(1)}h free on ${dayLabel(newDay)} (${booked.toFixed(1)}h / ${capacity.toFixed(1)}h used)`;
      }
      return `No room on ${dayLabel(newDay)}`;
    }
  }

  return 'Cannot move here';
}

function canPlaceHoursOnRowDay(
  hours,
  day,
  bar,
  rowBars = [],
  layoutContext = {},
  extraBookedByDay = {},
) {
  const needed = roundHours(hours);
  if (needed <= 0.001) {
    return true;
  }

  const rowName = layoutContext.rowName;
  if (!rowName) {
    return !(rowBars ?? []).some((other) => (
      other.id !== bar?.id && barHoursOnDay(other, day) > 0.001
    ));
  }

  return remainingCapacityOnRowDay(
    rowName,
    day,
    rowBars,
    layoutContext,
    bar,
    extraBookedByDay,
  ) + 0.001 >= needed;
}

export function clearBarResizeEdgeState(bar) {
  if (!bar || bar._resizeEdge == null) {
    return bar;
  }

  const { _resizeEdge, ...rest } = bar;
  return rest;
}

function sanitizeBarAfterScheduleMove(bar) {
  return clearBarResizeEdgeState(bar);
}

export function isHistogramBarEditable(bar) {
  return Boolean(bar) && !bar.done;
}

/** Sorted weekday keys with positive hours on the bar. */
export function getBarActiveDays(bar) {
  if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
    return [];
  }

  return Object.entries(bar.hours_by_day)
    .filter(([day, hours]) => (Number(hours) || 0) > 0.001 && !isWeekend(day))
    .map(([day]) => day)
    .sort();
}

/** Workday under the visual centre of a bar (or dragged segment). */
export function resolveBarCenterWorkday(bar, layoutContext = {}, segment = null) {
  const dayColumns = layoutContext.dayColumns ?? [];
  let days;
  if (segment) {
    const runs = runsForSegment(bar, segment, dayColumns);
    days = runs.flatMap((run) => getRunActiveDays(bar, run)).sort();
  } else {
    days = getBarActiveDays(bar);
  }

  if (!days.length) {
    return null;
  }

  if (days.length === 1) {
    return days[0];
  }

  const workdays = assignableDayColumns(dayColumns, layoutContext);
  const indices = days
    .map((day) => workdays.indexOf(day))
    .filter((index) => index >= 0);

  if (indices.length) {
    const centerIndex = indices[Math.floor(indices.length / 2)];
    return workdays[centerIndex];
  }

  return days[Math.floor(days.length / 2)];
}

export function getBarTypicalDayHours(bar) {
  const days = getBarActiveDays(bar);
  if (!days.length) {
    return HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
  }

  const total = days.reduce((sum, day) => sum + barHoursOnDay(bar, day), 0);
  return roundHours(total / days.length) || HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
}

/**
 * Hours this bar may occupy on a day while resizing: leftover row capacity
 * plus hours it already owns. Returns 0 when the day is fully booked.
 */
function getResizeFullDayHours(bar, day, layoutContext = {}) {
  const { rowName } = layoutContext;
  if (rowName && day) {
    const remaining = remainingCapacityOnRowDay(
      rowName,
      day,
      rowBarsForCapacity(layoutContext),
      layoutContext,
      bar,
    );
    const existing = barHoursOnDay(bar, day);
    const allowed = roundHours(remaining + existing);
    if (allowed > 0.001) {
      return allowed;
    }
    return 0;
  }
  return getBarTypicalDayHours(bar);
}

function hoursForFilledQuarters(fullDayHours, filledQuarters) {
  const quarters = Math.max(0, Math.min(HISTOGRAM_DAY_PARTITIONS, Math.round(Number(filledQuarters) || 0)));
  if (quarters <= 0) {
    return 0;
  }
  if (quarters >= HISTOGRAM_DAY_PARTITIONS) {
    return roundHours(fullDayHours);
  }
  return roundHours(fullDayHours * (quarters / HISTOGRAM_DAY_PARTITIONS));
}

export function isAssignableWorkday(day, layoutContext = {}) {
  if (!day || isWeekend(day)) {
    return false;
  }

  const { rowName, employeeHolidays, employees } = layoutContext;
  if (rowName && isEmployeeHolidayDay(rowName, day, employeeHolidays, employees)) {
    return false;
  }

  return true;
}

function firstAssignableWorkdayOnOrAfter(ymd, layoutContext) {
  let cursor = ymd;
  for (let guard = 0; guard < 21; guard += 1) {
    if (isAssignableWorkday(cursor, layoutContext)) {
      return cursor;
    }
    cursor = addDays(cursor, 1);
  }
  return ymd;
}

function lastAssignableWorkdayOnOrBefore(ymd, layoutContext) {
  let cursor = ymd;
  for (let guard = 0; guard < 21; guard += 1) {
    if (isAssignableWorkday(cursor, layoutContext)) {
      return cursor;
    }
    cursor = addDays(cursor, -1);
  }
  return ymd;
}

function totalHoursFromMap(hoursByDay) {
  return roundHours(
    Object.values(hoursByDay).reduce((sum, hours) => sum + (Number(hours) || 0), 0),
  );
}

/** Contiguous weekday runs from active days (gaps keep split bars separate). */
export function getBarContiguousRuns(bar) {
  const days = getBarActiveDays(bar);
  if (!days.length) {
    return [];
  }

  const runs = [{ start: days[0], end: days[0] }];
  for (let index = 1; index < days.length; index += 1) {
    const previousDay = days[index - 1];
    const day = days[index];
    const currentRun = runs[runs.length - 1];

    if (areConsecutiveWorkdays(previousDay, day)) {
      currentRun.end = day;
      continue;
    }

    runs.push({ start: day, end: day });
  }

  return runs;
}

function mergeBarHoursSchedules(left, right) {
  const hoursByDay = { ...(left?.hours_by_day || {}) };
  Object.entries(right?.hours_by_day || {}).forEach(([day, hours]) => {
    hoursByDay[day] = roundHours((Number(hoursByDay[day]) || 0) + (Number(hours) || 0));
  });

  const activeDays = getBarActiveDays({ hours_by_day: hoursByDay });
  return {
    ...left,
    hours_by_day: hoursByDay,
    hours: totalHoursFromMap(hoursByDay),
    start: activeDays[0] ?? left?.start,
    end: activeDays.at(-1) ?? left?.end,
    doc_supply: left?.doc_supply || right?.doc_supply || activeDays[0],
    completion: left?.completion || right?.completion || activeDays.at(-1),
  };
}

/** Merge split fragments for the same task + operative before a cross-row move. */
export function consolidateBarFragmentsForReassign(bar, rowBars = []) {
  if (!bar) {
    return bar;
  }

  const taskId = String(bar.task_id ?? '');
  const employeeKey = employeeNameKey(bar.employee);
  const siblings = (rowBars ?? []).filter((candidate) => (
    candidate.id !== bar.id
    && !candidate._suppressedByBarEdit
    && String(candidate.task_id ?? '') === taskId
    && employeeNameKey(candidate.employee) === employeeKey
  ));

  if (!siblings.length) {
    return bar;
  }

  return siblings.reduce(
    (merged, sibling) => mergeBarHoursSchedules(merged, sibling),
    bar,
  );
}

function isTargetRowFreeOnDay(day, bar, targetRowBars = [], layoutContext = {}) {
  const barHours = barHoursOnDay(bar, day);
  if (barHours <= 0.001) {
    return true;
  }

  return canPlaceHoursOnRowDay(barHours, day, bar, targetRowBars, layoutContext);
}

function scheduleFitsTargetRow(bar, targetRowName, targetRowBars = [], layoutContext = {}) {
  const targetContext = {
    ...layoutContext,
    rowName: targetRowName,
    rowBars: targetRowBars,
  };

  return getBarActiveDays(bar).every((day) => (
    isAssignableWorkday(day, targetContext)
    && isTargetRowFreeOnDay(day, bar, targetRowBars, targetContext)
  ));
}

function hasInternalScheduleGaps(bar) {
  const activeDays = getBarActiveDays(bar);
  if (activeDays.length < 2) {
    return false;
  }

  for (let index = 0; index < activeDays.length - 1; index += 1) {
    let cursor = addDays(activeDays[index], 1);
    while (cursor < activeDays[index + 1]) {
      return true;
    }
  }

  return false;
}

/**
 * Compact a gapped schedule toward the earliest active day by shifting later
 * parts left — no new hours are added on gap days.
 */
export function reconnectBarScheduleForReassign(
  bar,
  targetRowName,
  targetRowBars = [],
  layoutContext = {},
) {
  const activeDays = getBarActiveDays(bar);
  if (activeDays.length < 2) {
    return bar;
  }

  const targetContext = {
    ...layoutContext,
    rowName: targetRowName,
  };
  const dayHourPairs = activeDays.map((day) => [
    day,
    roundHours(Number(bar.hours_by_day?.[day]) || 0),
  ]);

  const targetSlots = [];
  const plannedHoursByDay = {};
  let cursor = activeDays[0];
  let guard = 0;
  while (targetSlots.length < dayHourPairs.length && guard < 366) {
    guard += 1;
    const [, hoursToPlace] = dayHourPairs[targetSlots.length];
    if (
      isAssignableWorkday(cursor, targetContext)
      && canPlaceHoursOnRowDay(
        hoursToPlace,
        cursor,
        bar,
        targetRowBars,
        targetContext,
        plannedHoursByDay,
      )
    ) {
      targetSlots.push(cursor);
      plannedHoursByDay[cursor] = roundHours((plannedHoursByDay[cursor] || 0) + hoursToPlace);
    }
    cursor = addDays(cursor, 1);
  }

  if (targetSlots.length < dayHourPairs.length) {
    return bar;
  }

  const alreadyCompact = dayHourPairs.every(([day], index) => day === targetSlots[index]);
  if (alreadyCompact) {
    return bar;
  }

  const hoursByDay = {};
  dayHourPairs.forEach(([, hours], index) => {
    hoursByDay[targetSlots[index]] = hours;
  });

  const nextDays = getBarActiveDays({ ...bar, hours_by_day: hoursByDay });
  return {
    ...bar,
    hours_by_day: hoursByDay,
    hours: totalHoursFromMap(hoursByDay),
    start: nextDays[0] ?? bar.start,
    end: nextDays.at(-1) ?? bar.end,
    doc_supply: nextDays[0] ?? bar.doc_supply,
    completion: nextDays.at(-1) ?? bar.completion,
  };
}

export function prepareBarScheduleForReassign(
  bar,
  sourceRowBars = [],
  targetRowName,
  targetRowBars = [],
  layoutContext = {},
) {
  const consolidated = consolidateBarFragmentsForReassign(bar, sourceRowBars);
  if (
    scheduleFitsTargetRow(consolidated, targetRowName, targetRowBars, layoutContext)
    && !hasInternalScheduleGaps(consolidated)
  ) {
    return consolidated;
  }

  return reconnectBarScheduleForReassign(
    consolidated,
    targetRowName,
    targetRowBars,
    layoutContext,
  );
}

function getRunActiveDays(bar, run) {
  if (!run) {
    return [];
  }

  return getBarActiveDays(bar).filter((day) => day >= run.start && day <= run.end);
}

function getSiblingBars(bar, siblingBars = []) {
  if (!bar?.id) {
    return [];
  }

  // Same task + same employee only (other segments for this operative).
  // Never treat other employees' assignments for the same task as siblings.
  const employee = String(bar.employee || '').trim().toLowerCase();

  return siblingBars.filter((candidate) => {
    if (candidate.id === bar.id) {
      return false;
    }
    if (String(candidate.task_id) !== String(bar.task_id)) {
      return false;
    }
    return String(candidate.employee || '').trim().toLowerCase() === employee;
  });
}

/**
 * Same-task sibling fragments that must not be merged by resize.
 * Other tasks on the row are not a hard wall — leftover capacity can be used,
 * and fully booked days are skipped instead of blocking the stretch.
 */
function getResizeCompetitorBars(bar, layoutContext = {}) {
  const siblingBars = layoutContext.siblingBars ?? [];
  const competitors = getSiblingBars(bar, siblingBars);
  const seen = new Set([bar.id]);
  return competitors.filter((candidate) => {
    if (seen.has(candidate.id)) {
      return false;
    }
    seen.add(candidate.id);
    return true;
  });
}

function dayIsOwnedByBar(bar, day) {
  return getBarActiveDays(bar).includes(day);
}

function timelineBounds(layoutContext) {
  const dayColumns = layoutContext.dayColumns ?? [];
  if (!dayColumns.length) {
    return { min: null, max: null };
  }

  return {
    min: firstAssignableWorkdayOnOrAfter(dayColumns[0], layoutContext),
    max: lastAssignableWorkdayOnOrBefore(dayColumns.at(-1), layoutContext),
  };
}

export function clampSnapDayToTimeline(snapDay, layoutContext = {}) {
  const { min, max } = timelineBounds(layoutContext);
  if (!snapDay || !min || !max) {
    return snapDay;
  }

  if (snapDay < min) {
    return min;
  }
  if (snapDay > max) {
    return max;
  }
  return snapDay;
}

/**
 * Latest assignable end day for this run without crossing competitor days
 * the bar does not already own (siblings, other tasks, overlapping fragments).
 */
function maxResizeEndBeforeBars(run, bar, competitorBars, layoutContext) {
  if (!run || !competitorBars?.length) {
    return null;
  }

  let limit = null;
  competitorBars.forEach((competitor) => {
    getBarActiveDays(competitor).forEach((day) => {
      if (dayIsOwnedByBar(bar, day)) {
        return;
      }
      if (day < run.start) {
        return;
      }

      const candidate = lastAssignableWorkdayOnOrBefore(addDays(day, -1), layoutContext);
      if (candidate < run.start) {
        return;
      }
      if (!limit || candidate < limit) {
        limit = candidate;
      }
    });
  });

  return limit;
}

/**
 * Earliest assignable start day for this run without crossing competitor days
 * the bar does not already own.
 */
function minResizeStartAfterBars(run, bar, competitorBars, layoutContext) {
  if (!run || !competitorBars?.length) {
    return null;
  }

  let limit = null;
  competitorBars.forEach((competitor) => {
    getBarActiveDays(competitor).forEach((day) => {
      if (dayIsOwnedByBar(bar, day)) {
        return;
      }
      if (day > run.end) {
        return;
      }

      const candidate = firstAssignableWorkdayOnOrAfter(addDays(day, 1), layoutContext);
      if (candidate > run.end) {
        return;
      }
      if (!limit || candidate > limit) {
        limit = candidate;
      }
    });
  });

  return limit;
}

function findRunIndex(runs, run) {
  if (!run || !runs?.length) {
    return -1;
  }

  return runs.findIndex((candidate) => candidate.start === run.start && candidate.end === run.end);
}

/** Prevent resize-end from bridging into a later run on the same bar record. */
function maxResizeEndBeforeOwnLaterRuns(run, bar, layoutContext) {
  const runs = getBarContiguousRuns(bar);
  const runIndex = findRunIndex(runs, run);
  if (runIndex < 0 || runIndex >= runs.length - 1) {
    return null;
  }

  const nextRun = runs[runIndex + 1];
  return lastAssignableWorkdayOnOrBefore(addDays(nextRun.start, -1), layoutContext);
}

/** Prevent resize-start from bridging into an earlier run on the same bar record. */
function minResizeStartBeforeOwnEarlierRuns(run, bar, layoutContext) {
  const runs = getBarContiguousRuns(bar);
  const runIndex = findRunIndex(runs, run);
  if (runIndex <= 0) {
    return null;
  }

  const previousRun = runs[runIndex - 1];
  return firstAssignableWorkdayOnOrAfter(addDays(previousRun.end, 1), layoutContext);
}

function placeResizeHours(desired, allowed) {
  const cap = Number(allowed) || 0;
  if (cap <= 0.001) {
    return 0;
  }
  const hours = desired == null ? cap : roundHours(desired);
  return Math.max(0, roundHours(Math.min(hours, cap)));
}

function replaceRunRange(bar, run, newStart, newEnd, layoutContext, edgeHours = {}) {
  const hoursByDay = { ...(bar.hours_by_day || {}) };

  getRunActiveDays(bar, run).forEach((day) => {
    delete hoursByDay[day];
  });

  const rangeStart = newStart <= newEnd ? newStart : newEnd;
  const rangeEnd = newStart <= newEnd ? newEnd : newStart;
  let cursor = rangeStart;

  while (cursor <= rangeEnd) {
    if (isAssignableWorkday(cursor, layoutContext)) {
      const isOnlyDay = rangeStart === rangeEnd;
      const isStartEdge = cursor === rangeStart;
      const isEndEdge = cursor === rangeEnd;
      const fullDayHours = getResizeFullDayHours(bar, cursor, layoutContext);

      let placed = 0;
      if (isOnlyDay) {
        placed = placeResizeHours(edgeHours.endHours ?? edgeHours.startHours, fullDayHours);
      } else if (isStartEdge && edgeHours.startHours != null) {
        placed = placeResizeHours(edgeHours.startHours, fullDayHours);
      } else if (isEndEdge && edgeHours.endHours != null) {
        placed = placeResizeHours(edgeHours.endHours, fullDayHours);
      } else {
        const existing = barHoursOnDay(bar, cursor);
        placed = existing > 0.001 ? existing : fullDayHours;
      }

      if (placed > 0.001) {
        hoursByDay[cursor] = placed;
      }
    }
    cursor = addDays(cursor, 1);
  }

  const activeDays = Object.keys(hoursByDay)
    .filter((day) => (Number(hoursByDay[day]) || 0) > 0.001)
    .sort();

  if (!activeDays.length) {
    return null;
  }

  return {
    ...bar,
    start: activeDays[0],
    end: activeDays.at(-1),
    hours_by_day: hoursByDay,
    hours: totalHoursFromMap(hoursByDay),
    // Lets day-band layout right-align a lone partial start day (LTR shrink).
    _resizeEdge: edgeHours._resizeEdge ?? bar._resizeEdge ?? null,
  };
}

function findRunIndexForSegment(runs, segment, dayColumns) {
  if (!segment || !dayColumns?.length || !runs.length) {
    return -1;
  }

  const endIndex = Math.min(segment.endIndex ?? dayColumns.length, dayColumns.length) - 1;
  const startIndex = Math.max(0, segment.startIndex ?? 0);
  const segStart = dayColumns[startIndex];
  const segEnd = dayColumns[endIndex];
  if (!segStart || !segEnd) {
    return -1;
  }

  return runs.findIndex((run) => run.start <= segEnd && run.end >= segStart);
}

/**
 * Preview or commit a resize anchored to a snapped timeline day.
 * Optional filledQuarters (0–4) snaps the edge within the day in quarter steps.
 * @param {'resize-start'|'resize-end'} mode
 */
export function resizeBarToSnapDay(bar, mode, snapDay, layoutContext = {}, segment = null, filledQuarters = null) {
  const runs = getBarContiguousRuns(bar);
  const dayColumns = layoutContext.dayColumns ?? [];
  const clampedSnapDay = clampSnapDayToTimeline(snapDay, layoutContext);
  if (!runs.length || !clampedSnapDay) {
    return bar;
  }

  const competitors = getResizeCompetitorBars(bar, layoutContext);
  const { min: timelineMin, max: timelineMax } = timelineBounds(layoutContext);
  const quarters = filledQuarters == null
    ? null
    : Math.max(0, Math.min(HISTOGRAM_DAY_PARTITIONS, Math.round(Number(filledQuarters) || 0)));

  if (mode === 'resize-start') {
    const runIndex = Math.max(0, findRunIndexForSegment(runs, segment, dayColumns));
    const run = runs[runIndex];
    let newStart;
    let startHours = null;

    if (isAssignableWorkday(clampedSnapDay, layoutContext)) {
      const fullDayHours = getResizeFullDayHours(bar, clampedSnapDay, layoutContext);
      if (quarters == null || quarters <= 0) {
        newStart = clampedSnapDay;
        startHours = fullDayHours;
      } else if (quarters >= HISTOGRAM_DAY_PARTITIONS) {
        // Past the end of this day → start on the next workday only when that
        // day is the next calendar workday. Do not jump across a weekend to
        // next week's Monday (that drops the whole prior week in one step).
        const nextCalendarDay = addDays(clampedSnapDay, 1);
        if (isAssignableWorkday(nextCalendarDay, layoutContext)) {
          newStart = nextCalendarDay;
          startHours = getResizeFullDayHours(bar, newStart, layoutContext);
        } else {
          newStart = clampedSnapDay;
          startHours = hoursForFilledQuarters(fullDayHours, 1);
        }
      } else {
        newStart = clampedSnapDay;
        startHours = hoursForFilledQuarters(
          fullDayHours,
          HISTOGRAM_DAY_PARTITIONS - quarters,
        );
      }
    } else if (clampedSnapDay < run.start) {
      // Weekend left of the run: take the last workday before the weekend
      // (Mon←Sun → Friday), but do not jump further back than the immediate
      // prior workday gap across this weekend.
      const before = lastAssignableWorkdayOnOrBefore(clampedSnapDay, layoutContext);
      const prevWorkday = lastAssignableWorkdayOnOrBefore(addDays(run.start, -1), layoutContext);
      newStart = before && prevWorkday && before <= prevWorkday
        ? before
        : run.start;
      startHours = getResizeFullDayHours(bar, newStart, layoutContext);
    } else {
      // Weekend inside / after the run start (e.g. Fri→Sat while the bar also
      // continues next week). Stay on the last workday before this weekend —
      // do not jump to next Monday until the pointer is actually on Monday.
      // Otherwise the left edge leaps a week and the bar appears to shrink
      // from the right remnant instead of left-to-right.
      const before = lastAssignableWorkdayOnOrBefore(clampedSnapDay, layoutContext);
      newStart = before && before >= run.start
        ? before
        : run.start;
      startHours = getResizeFullDayHours(bar, newStart, layoutContext);
    }
    const minStart = minResizeStartAfterBars(run, bar, competitors, layoutContext);
    const minStartBeforeOwnRun = minResizeStartBeforeOwnEarlierRuns(run, bar, layoutContext);
    const cappedMinStart = [minStart, minStartBeforeOwnRun].filter(Boolean).reduce(
      (max, candidate) => (max && max > candidate ? max : candidate),
      null,
    );
    if (cappedMinStart && newStart < cappedMinStart) {
      newStart = cappedMinStart;
      startHours = getResizeFullDayHours(bar, newStart, layoutContext);
    }
    if (timelineMin && newStart < timelineMin) {
      newStart = timelineMin;
      startHours = getResizeFullDayHours(bar, newStart, layoutContext);
    }
    if (newStart > run.end) {
      newStart = run.end;
      startHours = getResizeFullDayHours(bar, newStart, layoutContext);
    }
    return replaceRunRange(bar, run, newStart, run.end, layoutContext, {
      startHours: startHours ?? getResizeFullDayHours(bar, newStart, layoutContext),
      _resizeEdge: 'start',
    }) ?? bar;
  }

  if (mode === 'resize-end') {
    const matchedIndex = findRunIndexForSegment(runs, segment, dayColumns);
    const runIndex = matchedIndex >= 0 ? matchedIndex : runs.length - 1;
    const run = runs[runIndex];
    let newEnd;
    let endHours = null;

    if (isAssignableWorkday(clampedSnapDay, layoutContext)) {
      const fullDayHours = getResizeFullDayHours(bar, clampedSnapDay, layoutContext);
      if (quarters == null || quarters >= HISTOGRAM_DAY_PARTITIONS) {
        newEnd = clampedSnapDay;
        endHours = fullDayHours;
      } else if (quarters <= 0) {
        // Before the first quarter → end on the previous workday.
        newEnd = lastAssignableWorkdayOnOrBefore(addDays(clampedSnapDay, -1), layoutContext);
        endHours = getResizeFullDayHours(bar, newEnd, layoutContext);
      } else {
        newEnd = clampedSnapDay;
        endHours = hoursForFilledQuarters(fullDayHours, quarters);
      }
    } else if (clampedSnapDay > run.end) {
      // Weekend right of the run: fill through the last workday before that
      // weekend (Thu→Sat/Sun → Friday). Do not jump to next week's Monday
      // until the pointer is actually on Monday.
      const before = lastAssignableWorkdayOnOrBefore(clampedSnapDay, layoutContext);
      const nextWorkday = firstAssignableWorkdayOnOrAfter(addDays(run.end, 1), layoutContext);
      if (before && nextWorkday && nextWorkday <= before && nextWorkday > run.end) {
        newEnd = before;
      } else {
        newEnd = run.end;
      }
      endHours = getResizeFullDayHours(bar, newEnd, layoutContext);
    } else {
      newEnd = lastAssignableWorkdayOnOrBefore(clampedSnapDay, layoutContext);
      endHours = getResizeFullDayHours(bar, newEnd, layoutContext);
    }
    const maxEnd = maxResizeEndBeforeBars(run, bar, competitors, layoutContext);
    const maxEndBeforeOwnRun = maxResizeEndBeforeOwnLaterRuns(run, bar, layoutContext);
    const cappedMaxEnd = [maxEnd, maxEndBeforeOwnRun].filter(Boolean).reduce(
      (min, candidate) => (min && min < candidate ? min : candidate),
      null,
    );
    if (cappedMaxEnd && newEnd > cappedMaxEnd) {
      newEnd = cappedMaxEnd;
      endHours = getResizeFullDayHours(bar, newEnd, layoutContext);
    }
    if (timelineMax && newEnd > timelineMax) {
      newEnd = timelineMax;
      endHours = getResizeFullDayHours(bar, newEnd, layoutContext);
    }
    if (newEnd < run.start) {
      newEnd = run.start;
      endHours = getResizeFullDayHours(bar, newEnd, layoutContext);
    }
    return replaceRunRange(bar, run, run.start, newEnd, layoutContext, {
      endHours: endHours ?? getResizeFullDayHours(bar, newEnd, layoutContext),
      _resizeEdge: 'end',
    }) ?? bar;
  }

  return bar;
}

/** Layout context that ignores other-task booked hours so resize can claim full AVA. */
function displaceResizeLayoutContext(layoutContext = {}) {
  return {
    ...layoutContext,
    rowBars: [],
    sourceRowBars: [],
  };
}

function otherTaskBarsOnRow(bar, layoutContext = {}) {
  const rowBars = layoutContext.rowBars?.length
    ? layoutContext.rowBars
    : (layoutContext.sourceRowBars ?? []);

  return (rowBars ?? []).filter((candidate) => {
    if (!candidate || candidate._suppressedByBarEdit) {
      return false;
    }
    if (barMatchesMovingAssignment(bar, candidate)) {
      return false;
    }
    return getBarActiveDays(candidate).length > 0;
  });
}

/**
 * Other-task bars that sit after (end-grow) or before (start-grow) the resized bar
 * and should all shift by the drag workday delta — including tasks after a gap.
 */
function barsToPushOnResizeGrow(bar, mode, layoutContext = {}) {
  const oldDays = getBarActiveDays(bar);
  if (!oldDays.length) {
    return [];
  }

  const oldStart = oldDays[0];
  const oldEnd = oldDays.at(-1);
  const otherBars = otherTaskBarsOnRow(bar, layoutContext);

  const candidates = otherBars.filter((candidate) => {
    const days = getBarActiveDays(candidate);
    if (!days.length) {
      return false;
    }
    if (mode === 'resize-end') {
      // Anything with presence after the original end moves forward.
      return days.at(-1) > oldEnd;
    }
    // Anything with presence before the original start moves backward.
    return days[0] < oldStart;
  });

  return candidates.sort((left, right) => {
    const leftStart = getBarActiveDays(left)[0] || '';
    const rightStart = getBarActiveDays(right)[0] || '';
    return mode === 'resize-end'
      ? leftStart.localeCompare(rightStart)
      : rightStart.localeCompare(leftStart);
  });
}

/**
 * Shift a bar's schedule by workdays only (weekends/holidays via assignable columns).
 * No capacity competition — used when displacing other tasks on resize.
 * Returns null when any day would leave the timeline.
 */
export function shiftBarScheduleByWorkdays(bar, dayDelta, layoutContext = {}) {
  if (!bar || !Number.isFinite(dayDelta) || dayDelta === 0) {
    return bar;
  }

  const dayColumns = layoutContext.dayColumns ?? [];
  const hoursByDay = {};

  for (const day of getBarActiveDays(bar)) {
    const newDay = shiftDayByWorkdays(day, dayDelta, dayColumns, layoutContext);
    if (!newDay) {
      return null;
    }
    hoursByDay[newDay] = roundHours(
      (Number(hoursByDay[newDay]) || 0) + barHoursOnDay(bar, day),
    );
  }

  return rebuildBarFromHours(bar, hoursByDay);
}

function maxWorkdayDeltaThatFits(bars, desiredDelta, layoutContext = {}) {
  if (!desiredDelta || !bars?.length) {
    return desiredDelta || 0;
  }

  const workdays = assignableDayColumns(layoutContext.dayColumns ?? [], layoutContext);
  if (!workdays.length) {
    return 0;
  }

  // Same delta for every bar — bound by the bar closest to the timeline edge.
  if (desiredDelta > 0) {
    let maxRoom = desiredDelta;
    for (const bar of bars) {
      const end = getBarActiveDays(bar).at(-1);
      const fromIndex = workdays.indexOf(end);
      if (fromIndex < 0) {
        return 0;
      }
      maxRoom = Math.min(maxRoom, (workdays.length - 1) - fromIndex);
      if (maxRoom <= 0) {
        return 0;
      }
    }
    return maxRoom;
  }

  let minRoom = desiredDelta; // negative
  for (const bar of bars) {
    const start = getBarActiveDays(bar)[0];
    const fromIndex = workdays.indexOf(start);
    if (fromIndex < 0) {
      return 0;
    }
    // Most-negative allowed delta for this bar is -fromIndex.
    minRoom = Math.max(minRoom, -fromIndex);
    if (minRoom >= 0) {
      return 0;
    }
  }
  return minRoom;
}

/**
 * Resize a bar and shift all later (or earlier) other-task bars on the same row
 * by the same workday delta as the edge drag when lengthening.
 *
 * @param {object} [pushCache] Mutable cache from the active pointer gesture:
 *   reuse shifted neighbors when the workday delta is unchanged.
 */
export function evaluateResizeWithPush(
  bar,
  mode,
  snapDay,
  layoutContext = {},
  segment = null,
  filledQuarters = null,
  pushCache = null,
) {
  const normalResized = resizeBarToSnapDay(
    bar,
    mode,
    snapDay,
    layoutContext,
    segment,
    filledQuarters,
  );

  const emptyResult = (resizedBar) => ({
    resizedBar,
    pushedBars: [],
    previewByBarId: resizedBar?.id ? { [resizedBar.id]: resizedBar } : {},
    pushDelta: 0,
  });

  if (!bar || (mode !== 'resize-end' && mode !== 'resize-start')) {
    return emptyResult(normalResized);
  }

  const dayColumns = layoutContext.dayColumns ?? [];
  const displaceContext = displaceResizeLayoutContext(layoutContext);
  const desiredResized = resizeBarToSnapDay(
    bar,
    mode,
    snapDay,
    displaceContext,
    segment,
    filledQuarters,
  );

  const oldDays = getBarActiveDays(bar);
  const desiredDays = getBarActiveDays(desiredResized);
  if (!oldDays.length || !desiredDays.length) {
    return emptyResult(normalResized);
  }

  const oldStart = oldDays[0];
  const oldEnd = oldDays.at(-1);
  const desiredStart = desiredDays[0];
  const desiredEnd = desiredDays.at(-1);

  // Drag amount only — workday delta of the moved edge (shrink = no push).
  let desiredDelta = 0;
  if (mode === 'resize-end') {
    desiredDelta = workdayIndexDelta(oldEnd, desiredEnd, dayColumns, layoutContext);
    if (desiredDelta <= 0) {
      return emptyResult(normalResized);
    }
  } else {
    desiredDelta = workdayIndexDelta(oldStart, desiredStart, dayColumns, layoutContext);
    if (desiredDelta >= 0) {
      return emptyResult(normalResized);
    }
  }

  const toPush = barsToPushOnResizeGrow(bar, mode, layoutContext);
  if (!toPush.length) {
    return emptyResult(normalResized);
  }

  // Cap to the largest delta that keeps every pushed bar on the timeline.
  // Resized edge is capped to match so we only move by what actually fits.
  const cappedDelta = maxWorkdayDeltaThatFits(toPush, desiredDelta, layoutContext);
  if (!cappedDelta) {
    return emptyResult(normalResized);
  }

  let resizedBar = desiredResized;
  if (cappedDelta !== desiredDelta) {
    if (mode === 'resize-end') {
      const cappedEnd = shiftDayByWorkdays(oldEnd, cappedDelta, dayColumns, layoutContext);
      if (!cappedEnd) {
        return emptyResult(normalResized);
      }
      resizedBar = resizeBarToSnapDay(
        bar,
        mode,
        cappedEnd,
        displaceContext,
        segment,
        HISTOGRAM_DAY_PARTITIONS,
      );
    } else {
      const cappedStart = shiftDayByWorkdays(oldStart, cappedDelta, dayColumns, layoutContext);
      if (!cappedStart) {
        return emptyResult(normalResized);
      }
      resizedBar = resizeBarToSnapDay(
        bar,
        mode,
        cappedStart,
        displaceContext,
        segment,
        0,
      );
    }
  }

  // Reuse neighbor shifts while the pointer only changes within-day quarters.
  if (
    pushCache
    && pushCache.barId === bar.id
    && pushCache.mode === mode
    && pushCache.pushDelta === cappedDelta
    && Array.isArray(pushCache.pushedBars)
    && pushCache.pushedBars.length
  ) {
    const previewByBarId = { [resizedBar.id]: resizedBar };
    pushCache.pushedBars.forEach(({ nextBar }) => {
      if (nextBar?.id) {
        previewByBarId[nextBar.id] = nextBar;
      }
    });
    return {
      resizedBar,
      pushedBars: pushCache.pushedBars,
      previewByBarId,
      pushDelta: cappedDelta,
    };
  }

  const pushedBars = [];
  const previewByBarId = { [resizedBar.id]: resizedBar };

  toPush.forEach((previousBar) => {
    const nextBar = shiftBarScheduleByWorkdays(previousBar, cappedDelta, layoutContext);
    if (!nextBar || barsHaveSameSchedule(previousBar, nextBar)) {
      return;
    }
    pushedBars.push({ previousBar, nextBar });
    previewByBarId[nextBar.id] = nextBar;
  });

  if (!pushedBars.length) {
    return emptyResult(normalResized);
  }

  if (pushCache) {
    pushCache.barId = bar.id;
    pushCache.mode = mode;
    pushCache.pushDelta = cappedDelta;
    pushCache.pushedBars = pushedBars;
  }

  return {
    resizedBar,
    pushedBars,
    previewByBarId,
    pushDelta: cappedDelta,
  };
}

export function barsHaveSameSchedule(left, right) {
  if (!left || !right) {
    return left === right;
  }

  const leftDays = getBarActiveDays(left);
  const rightDays = getBarActiveDays(right);
  if (leftDays.length !== rightDays.length) {
    return false;
  }

  return leftDays.every((day, index) => {
    if (day !== rightDays[index]) {
      return false;
    }
    return Math.abs(barHoursOnDay(left, day) - barHoursOnDay(right, day)) < 0.01;
  });
}

export function formatBarResizeTooltip(bar) {
  const days = getBarActiveDays(bar);
  if (!days.length) {
    return '';
  }

  const start = days[0];
  const end = days.at(-1);
  const hours = days.reduce((sum, day) => sum + barHoursOnDay(bar, day), 0);
  const dayCount = days.length;

  return `${dayLabel(start)} → ${dayLabel(end)} · ${dayCount} day${dayCount === 1 ? '' : 's'} · ${hours.toFixed(1)}h`;
}

/** Structured payload for the dark task-edit hover card. */
export function buildBarEditTooltip(bar, options = {}) {
  const {
    reassigning = false,
    targetRowName = '',
    blocked = false,
    blockReason = null,
  } = options;
  const days = getBarActiveDays(bar);
  const start = days[0];
  const end = days.at(-1);
  const hours = days.reduce((sum, day) => sum + barHoursOnDay(bar, day), 0);
  const dayCount = days.length;
  const when = start && end
    ? (start === end ? dayLabel(start) : `${dayLabel(start)} → ${dayLabel(end)}`)
    : null;
  const summary = days.length
    ? `${dayCount} day${dayCount === 1 ? '' : 's'} · ${hours.toFixed(1)}h`
    : null;

  return {
    title: bar?.task_name || bar?.project_name || 'Task',
    color: blocked ? '#ef4444' : (bar?.color || null),
    operative: String(bar?.employee || '').trim() || null,
    when,
    summary,
    reassignTo: reassigning && targetRowName && !blocked ? targetRowName : null,
    blocked,
    blockReason: blocked ? (blockReason || 'Cannot drop here') : null,
  };
}

export function describeBarResizeChange(previousBar, nextBar) {
  const prevDays = getBarActiveDays(previousBar);
  const nextDays = getBarActiveDays(nextBar);
  const taskName = nextBar?.task_name || previousBar?.task_name || 'Task';

  if (!prevDays.length || !nextDays.length) {
    return `${taskName} schedule updated`;
  }

  const prevStart = prevDays[0];
  const prevEnd = prevDays.at(-1);
  const nextStart = nextDays[0];
  const nextEnd = nextDays.at(-1);

  if (prevStart === nextStart && prevEnd !== nextEnd) {
    return `${taskName}: end ${dayLabel(prevEnd)} → ${dayLabel(nextEnd)}`;
  }

  if (prevEnd === nextEnd && prevStart !== nextStart) {
    return `${taskName}: start ${dayLabel(prevStart)} → ${dayLabel(nextStart)}`;
  }

  return `${taskName}: ${dayLabel(prevStart)}–${dayLabel(prevEnd)} → ${dayLabel(nextStart)}–${dayLabel(nextEnd)}`;
}

function assignableDayColumns(dayColumns = [], layoutContext = {}) {
  return (dayColumns ?? []).filter((day) => isAssignableWorkday(day, layoutContext));
}

function workdayIndexDelta(fromDay, toDay, dayColumns = [], layoutContext = {}) {
  const workdays = assignableDayColumns(dayColumns, layoutContext);
  const fromIndex = workdays.indexOf(fromDay);
  const toIndex = workdays.indexOf(toDay);
  if (fromIndex < 0 || toIndex < 0) {
    return 0;
  }
  return toIndex - fromIndex;
}

/** Snap a pointer day onto a workday, preferring the drag direction. */
function snapDragDayToWorkday(snapDay, anchorDay, layoutContext = {}) {
  if (isAssignableWorkday(snapDay, layoutContext)) {
    return snapDay;
  }

  const movingForward = String(snapDay || '') >= String(anchorDay || '');
  if (movingForward) {
    return firstAssignableWorkdayOnOrAfter(snapDay, layoutContext)
      || lastAssignableWorkdayOnOrBefore(snapDay, layoutContext)
      || snapDay;
  }

  return lastAssignableWorkdayOnOrBefore(snapDay, layoutContext)
    || firstAssignableWorkdayOnOrAfter(snapDay, layoutContext)
    || snapDay;
}

function shiftDayByWorkdays(day, workdayDelta, dayColumns = [], layoutContext = {}) {
  const workdays = assignableDayColumns(dayColumns, layoutContext);
  const fromIndex = workdays.indexOf(day);
  if (fromIndex < 0) {
    return null;
  }
  const toIndex = fromIndex + workdayDelta;
  if (toIndex < 0 || toIndex >= workdays.length) {
    return null;
  }
  return workdays[toIndex];
}

function rebuildBarFromHours(bar, hoursByDay) {
  const activeDays = Object.keys(hoursByDay)
    .filter((day) => (Number(hoursByDay[day]) || 0) > 0.001)
    .sort();

  if (!activeDays.length) {
    return null;
  }

  const { _resizeEdge, ...rest } = bar;
  return {
    ...rest,
    start: activeDays[0],
    end: activeDays.at(-1),
    hours_by_day: hoursByDay,
    hours: totalHoursFromMap(hoursByDay),
  };
}

function runsForSegment(bar, segment, dayColumns) {
  const runs = getBarContiguousRuns(bar);
  if (!segment || !runs.length) {
    return runs;
  }

  const runIndex = findRunIndexForSegment(runs, segment, dayColumns);
  return runIndex >= 0 ? [runs[runIndex]] : runs;
}

function quarterHoursForDay(bar, day, layoutContext = {}) {
  return hoursForFilledQuarters(getResizeFullDayHours(bar, day, layoutContext), 1) || 0.25;
}

function placeOverflowHours(hoursByDay, fromDay, hours, bar, layoutContext) {
  let remaining = roundHours(hours);
  if (remaining <= 0.001) {
    return hoursByDay;
  }

  const rowBars = rowBarsForCapacity(layoutContext);
  const plannedHoursByDay = { ...hoursByDay };
  const next = { ...hoursByDay };
  let cursor = fromDay;

  for (let guard = 0; guard < 42 && remaining > 0.001; guard += 1) {
    if (!cursor) {
      break;
    }

    if (isAssignableWorkday(cursor, layoutContext)) {
      const room = remainingCapacityOnRowDay(
        layoutContext.rowName,
        cursor,
        rowBars,
        layoutContext,
        bar,
        plannedHoursByDay,
      );
      const placed = Math.min(remaining, room);
      if (placed > 0.001) {
        next[cursor] = roundHours((Number(next[cursor]) || 0) + placed);
        plannedHoursByDay[cursor] = roundHours((Number(plannedHoursByDay[cursor]) || 0) + placed);
        remaining = roundHours(remaining - placed);
      }
    }

    if (remaining > 0.001) {
      cursor = firstAssignableWorkdayOnOrAfter(addDays(cursor, 1), layoutContext);
    }
  }

  return remaining <= 0.001 ? next : null;
}

function trimHoursFromScheduleStart(hoursByDay, qHours) {
  const days = Object.keys(hoursByDay)
    .filter((day) => (Number(hoursByDay[day]) || 0) > 0.001)
    .sort();
  if (!days.length) {
    return { hoursByDay, removed: 0 };
  }

  let remaining = roundHours(qHours);
  const next = { ...hoursByDay };

  for (const day of days) {
    if (remaining <= 0.001) {
      break;
    }
    const current = barHoursOnDay({ hours_by_day: next }, day);
    const take = Math.min(current, remaining);
    const left = roundHours(current - take);
    if (left <= 0.001) {
      delete next[day];
    } else {
      next[day] = left;
    }
    remaining = roundHours(remaining - take);
  }

  return { hoursByDay: next, removed: roundHours(qHours - remaining) };
}

function trimHoursFromScheduleEnd(hoursByDay, qHours) {
  const days = Object.keys(hoursByDay)
    .filter((day) => (Number(hoursByDay[day]) || 0) > 0.001)
    .sort();
  if (!days.length) {
    return { hoursByDay, removed: 0 };
  }

  let remaining = roundHours(qHours);
  const next = { ...hoursByDay };

  for (let index = days.length - 1; index >= 0 && remaining > 0.001; index -= 1) {
    const day = days[index];
    const current = barHoursOnDay({ hours_by_day: next }, day);
    const take = Math.min(current, remaining);
    const left = roundHours(current - take);
    if (left <= 0.001) {
      delete next[day];
    } else {
      next[day] = left;
    }
    remaining = roundHours(remaining - take);
  }

  return { hoursByDay: next, removed: roundHours(qHours - remaining) };
}

function prependOverflowHours(hoursByDay, hours, bar, layoutContext) {
  let remaining = roundHours(hours);
  if (remaining <= 0.001) {
    return hoursByDay;
  }

  const days = Object.keys(hoursByDay)
    .filter((day) => (Number(hoursByDay[day]) || 0) > 0.001)
    .sort();
  const firstDay = days[0];
  let cursor = firstDay
    ? lastAssignableWorkdayOnOrBefore(addDays(firstDay, -1), layoutContext)
    : firstAssignableWorkdayOnOrAfter(layoutContext.dayColumns?.[0], layoutContext);

  const rowBars = rowBarsForCapacity(layoutContext);
  const plannedHoursByDay = { ...hoursByDay };
  const next = { ...hoursByDay };

  for (let guard = 0; guard < 42 && remaining > 0.001; guard += 1) {
    if (!cursor) {
      break;
    }

    if (isAssignableWorkday(cursor, layoutContext)) {
      const room = remainingCapacityOnRowDay(
        layoutContext.rowName,
        cursor,
        rowBars,
        layoutContext,
        bar,
        plannedHoursByDay,
      );
      const placed = Math.min(remaining, room);
      if (placed > 0.001) {
        next[cursor] = roundHours((Number(next[cursor]) || 0) + placed);
        plannedHoursByDay[cursor] = roundHours((Number(plannedHoursByDay[cursor]) || 0) + placed);
        remaining = roundHours(remaining - placed);
      }
    }

    if (remaining > 0.001) {
      cursor = lastAssignableWorkdayOnOrBefore(addDays(cursor, -1), layoutContext);
    }
  }

  return remaining <= 0.001 ? next : null;
}

function nudgeBarForwardOneQuarter(bar, layoutContext = {}) {
  const days = getBarActiveDays(bar);
  if (!days.length) {
    return bar;
  }

  const firstDay = days[0];
  const lastDay = days.at(-1);
  const qHours = quarterHoursForDay(bar, firstDay, layoutContext);
  const trimmed = trimHoursFromScheduleStart({ ...(bar.hours_by_day || {}) }, qHours);
  if (trimmed.removed <= 0.001) {
    return bar;
  }

  const placed = placeOverflowHours(
    trimmed.hoursByDay,
    lastDay,
    trimmed.removed,
    bar,
    layoutContext,
  );
  if (!placed) {
    return bar;
  }

  return rebuildBarFromHours(bar, placed) ?? bar;
}

function nudgeBarBackwardOneQuarter(bar, layoutContext = {}) {
  const days = getBarActiveDays(bar);
  if (!days.length) {
    return bar;
  }

  const firstDay = days[0];
  const lastDay = days.at(-1);
  const qHours = quarterHoursForDay(bar, lastDay, layoutContext);
  const trimmed = trimHoursFromScheduleEnd({ ...(bar.hours_by_day || {}) }, qHours);
  if (trimmed.removed <= 0.001) {
    return bar;
  }

  const placed = prependOverflowHours(
    trimmed.hoursByDay,
    trimmed.removed,
    bar,
    layoutContext,
  );
  if (!placed) {
    return bar;
  }

  return rebuildBarFromHours(bar, placed) ?? bar;
}

function nudgeBarByQuarterDelta(bar, quarterDelta, layoutContext = {}) {
  if (!bar || !Number.isFinite(quarterDelta) || quarterDelta === 0) {
    return bar;
  }

  const sign = quarterDelta > 0 ? 1 : -1;
  let current = bar;

  for (let step = 0; step < Math.abs(quarterDelta); step += 1) {
    const next = sign > 0
      ? nudgeBarForwardOneQuarter(current, layoutContext)
      : nudgeBarBackwardOneQuarter(current, layoutContext);
    if (barsHaveSameSchedule(current, next)) {
      return bar;
    }
    current = next;
  }

  return current;
}

/** Shift active days by workday delta, preserving duration and per-day hours. */
export function shiftBarByDayDelta(bar, dayDelta, layoutContext = {}, segment = null) {
  if (!bar || !Number.isFinite(dayDelta) || dayDelta === 0) {
    return bar;
  }

  const dayColumns = layoutContext.dayColumns ?? [];
  const targetRuns = runsForSegment(bar, segment, dayColumns);
  if (!targetRuns.length) {
    return bar;
  }

  const hoursByDay = { ...(bar.hours_by_day || {}) };
  const movingDays = targetRuns.flatMap((run) => getRunActiveDays(bar, run));
  const shiftedHours = {};
  const plannedHoursByDay = {};
  const rowBars = rowBarsForCapacity(layoutContext);
  const shiftLayout = { ...layoutContext, rowBars, sourceRowBars: rowBars };

  for (const day of movingDays) {
    // Move by workdays so weekends are skipped (Fri+1 → Mon, not Sat).
    const newDay = shiftDayByWorkdays(day, dayDelta, dayColumns, shiftLayout);
    if (!newDay) {
      return bar;
    }

    const movingHours = barHoursOnDay(bar, day);
    const room = remainingCapacityOnRowDay(
      shiftLayout.rowName,
      newDay,
      rowBars,
      shiftLayout,
      bar,
      plannedHoursByDay,
    );
    let remaining = movingHours;
    let placed = Math.min(remaining, room);
    if (placed <= 0.001) {
      return bar;
    }

    shiftedHours[newDay] = roundHours((shiftedHours[newDay] || 0) + placed);
    plannedHoursByDay[newDay] = roundHours((plannedHoursByDay[newDay] || 0) + placed);
    remaining = roundHours(remaining - placed);

    let spillCursor = newDay;
    while (remaining > 0.001) {
      const spill = findSpillDayForOverflow(
        spillCursor,
        shiftLayout,
        bar,
        plannedHoursByDay,
        remaining,
      );
      if (!spill) {
        return bar;
      }

      shiftedHours[spill.day] = roundHours((shiftedHours[spill.day] || 0) + spill.placed);
      plannedHoursByDay[spill.day] = roundHours((plannedHoursByDay[spill.day] || 0) + spill.placed);
      remaining = roundHours(remaining - spill.placed);
      spillCursor = spill.day;
    }
  }

  movingDays.forEach((day) => {
    delete hoursByDay[day];
  });

  return rebuildBarFromHours(bar, { ...hoursByDay, ...shiftedHours }) ?? bar;
}

const ASSIGNEE_OVERRIDE_SLOTS = [
  { override: 'override_1', algorithm: 'algorithm_1' },
  { override: 'override_2', algorithm: 'algorithm_2' },
  { override: 'override_3', algorithm: 'algorithm_3' },
];

export function assigneeNameMatches(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) {
    return false;
  }
  return employeeNameKey(a) === employeeNameKey(b);
}

/**
 * Map an assignee to override_N from algorithm_N first (Algorithm 1→Override 1, etc.).
 * Falls back to an existing override slot, then override_1.
 */
export function findAssigneeOverrideSlot(bar, assigneeName) {
  if (!bar || !assigneeName) {
    return 'override_1';
  }

  // Primary rule: whoever sits on Algorithm N writes to Override N.
  for (const { override, algorithm } of ASSIGNEE_OVERRIDE_SLOTS) {
    if (assigneeNameMatches(bar[algorithm], assigneeName)) {
      return override;
    }
  }

  // Already present in an override slot (manual override without algorithm match).
  for (const { override } of ASSIGNEE_OVERRIDE_SLOTS) {
    if (assigneeNameMatches(bar[override], assigneeName)) {
      return override;
    }
  }

  return 'override_1';
}

/** Write the new operative into Override N matching Algorithm N for the dragged-from emp. */
export function applyAssigneeOverrideForReassign(bar, nextEmployee) {
  const previousEmployee = String(bar?.employee || '').trim();
  const assignee = String(nextEmployee || '').trim();
  if (!bar || !previousEmployee || !assignee || assigneeNameMatches(previousEmployee, assignee)) {
    return bar;
  }

  const slot = findAssigneeOverrideSlot(bar, previousEmployee);
  return {
    ...bar,
    employee: assignee,
    [slot]: assignee,
  };
}

/**
 * Validate whether a bar can be dropped onto another operative row.
 * @returns {{ ok: boolean, assignee: string|null, reason: string|null }}
 */
export function validateReassignBarToRow(
  bar,
  targetRowName,
  targetRowBars = [],
  employees = [],
  layoutContext = {},
) {
  if (!bar || !targetRowName) {
    return { ok: false, assignee: null, reason: 'No target operative' };
  }

  const targetEmployee = (employees ?? []).find((employee) => (
    employeeMatchesName(employee, targetRowName)
  ));
  const assignee = resolveHistogramAssigneeName(targetEmployee, targetRowName);
  if (!assignee) {
    return { ok: false, assignee: null, reason: 'Unknown operative' };
  }

  if (assigneeNameMatches(bar.employee, assignee)) {
    return { ok: true, assignee, reason: null };
  }

  const targetContext = {
    ...layoutContext,
    rowName: targetRowName,
    rowBars: targetRowBars,
    siblingBars: targetRowBars.filter(
      (candidate) => candidate.id !== bar.id
        && String(candidate.task_id) === String(bar.task_id),
    ),
  };

  const activeDays = getBarActiveDays(bar);
  for (const day of activeDays) {
    if (!isAssignableWorkday(day, targetContext)) {
      const holiday = isEmployeeHolidayDay(
        targetRowName,
        day,
        layoutContext.employeeHolidays,
        employees,
      );
      return {
        ok: false,
        assignee,
        reason: holiday
          ? `Holiday on ${dayLabel(day)}`
          : `Not a workday (${dayLabel(day)})`,
      };
    }

    const barHours = roundHours(barHoursOnDay(bar, day));
    if (barHours <= 0.001) {
      continue;
    }

    if (!canPlaceHoursOnRowDay(barHours, day, bar, targetRowBars, targetContext)) {
      const capacity = dayCapacityForLayoutContext(targetRowName, day, layoutContext);
      const booked = hoursBookedOnRowDay(targetRowBars, day, bar);
      const blocker = targetRowBars.find((other) => (
        other.id !== bar.id && barHoursOnDay(other, day) > 0.001
      ));
      const blockerName = String(blocker?.task_name || blocker?.project_name || 'another task').trim();
      if (capacity != null && booked + barHours > capacity + 0.001) {
        return {
          ok: false,
          assignee,
          reason: `Over capacity on ${dayLabel(day)} (${(booked + barHours).toFixed(1)}h / ${capacity.toFixed(1)}h)`,
        };
      }

      return {
        ok: false,
        assignee,
        reason: `Busy: ${blockerName} on ${dayLabel(day)}`,
      };
    }
  }

  return { ok: true, assignee, reason: null };
}

export function reassignBarToRow(bar, targetRowName, targetRowBars = [], employees = [], layoutContext = {}) {
  const sourceRowBars = layoutContext.sourceRowBars ?? layoutContext.rowBars ?? [];
  const preparedBar = prepareBarScheduleForReassign(
    bar,
    sourceRowBars,
    targetRowName,
    targetRowBars,
    layoutContext,
  );
  const validation = validateReassignBarToRow(
    preparedBar,
    targetRowName,
    targetRowBars,
    employees,
    layoutContext,
  );
  if (!validation.ok || !validation.assignee) {
    return null;
  }

  return applyAssigneeOverrideForReassign(preparedBar, validation.assignee);
}

export function captureHistogramRowRects() {
  return Array.from(
    document.querySelectorAll('.resource-histogram-resource-block[data-histogram-row-name]'),
  ).map((row) => {
    const rect = row.getBoundingClientRect();
    return {
      name: row.getAttribute('data-histogram-row-name') || '',
      top: rect.top,
      bottom: rect.bottom,
    };
  }).filter((entry) => entry.name);
}

export function resolveHistogramTimelineRowElement(rowName, fallbackElement = null) {
  if (!rowName || typeof document === 'undefined') {
    return fallbackElement;
  }

  const selector = `.resource-histogram-resource-block[data-histogram-row-name="${CSS.escape(rowName)}"] .resource-gantt-timeline-row`;
  return document.querySelector(selector) || fallbackElement;
}

/**
 * Resolve operative row under pointer (timeline row or name column).
 * Only snaps to a nearby row within maxDistance; avoids jumping to far rows.
 */
export function findHistogramRowNameFromPoint(clientY, options = {}) {
  const alwaysSnapToNearest = Boolean(options.alwaysSnapToNearest);
  const maxDistance = Number.isFinite(options.maxDistance) ? options.maxDistance : 48;
  const rows = Array.isArray(options.rowRects) && options.rowRects.length > 0
    ? options.rowRects
    : captureHistogramRowRects();

  if (!rows.length) {
    return null;
  }

  let nearestName = null;
  let nearestDistance = Infinity;

  rows.forEach((row) => {
    const rowName = row.name || row.getAttribute?.('data-histogram-row-name');
    if (!rowName) {
      return;
    }

    const top = Number.isFinite(row.top) ? row.top : row.getBoundingClientRect?.().top;
    const bottom = Number.isFinite(row.bottom) ? row.bottom : row.getBoundingClientRect?.().bottom;
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
      return;
    }

    if (clientY >= top && clientY <= bottom) {
      nearestName = rowName;
      nearestDistance = 0;
      return;
    }

    const distance = clientY < top
      ? top - clientY
      : clientY - bottom;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestName = rowName;
    }
  });

  if (!alwaysSnapToNearest && nearestDistance > maxDistance) {
    return null;
  }

  return nearestName;
}

/**
 * Evaluate a whole-bar drag: workday shift first, then optional reassign.
 * Returns a preview (always showable) and a commitBar (null when drop is blocked).
 */
export function evaluateBarDrag(bar, snapDay, layoutContext = {}, options = {}) {
  const {
    anchorSnapDay,
    anchorBarCenterDay,
    anchorFilledQuarters = 0,
    filledQuarters = 0,
    sourceRowName,
    targetRowName,
    targetRowBars = [],
    sourceRowBars = layoutContext.sourceRowBars ?? layoutContext.rowBars ?? [],
    employees = [],
    segment = null,
  } = options;

  const dayColumns = layoutContext.dayColumns ?? [];
  const clampedSnapDay = clampSnapDayToTimeline(snapDay, layoutContext);
  if (!bar || !clampedSnapDay || !anchorSnapDay) {
    return {
      previewBar: bar,
      shiftedBar: bar,
      commitBar: null,
      reassigning: false,
      blocked: false,
      blockReason: null,
      targetRowName: sourceRowName || null,
      sourceRowName: sourceRowName || null,
    };
  }

  const sourceContext = {
    ...layoutContext,
    rowName: sourceRowName || layoutContext.rowName,
  };
  const resolvedTarget = targetRowName || sourceRowName || null;
  const reassigning = Boolean(
    resolvedTarget && sourceRowName && resolvedTarget !== sourceRowName,
  );
  const rowBarsForShift = sourceRowBars.length > 0
    ? sourceRowBars
    : (layoutContext.rowBars ?? []);
  const shiftContext = reassigning
    ? {
      ...layoutContext,
      rowName: resolvedTarget,
      rowBars: targetRowBars,
      sourceRowBars: targetRowBars,
    }
    : {
      ...sourceContext,
      rowBars: rowBarsForShift,
      sourceRowBars: rowBarsForShift,
    };

  const centerAnchorDay = anchorBarCenterDay
    || resolveBarCenterWorkday(bar, shiftContext, segment)
    || anchorSnapDay;
  const dragAnchorDay = centerAnchorDay || anchorSnapDay;
  const anchorWorkday = snapDragDayToWorkday(centerAnchorDay, centerAnchorDay, shiftContext);
  const targetWorkday = snapDragDayToWorkday(clampedSnapDay, dragAnchorDay, shiftContext);
  const dayDelta = workdayIndexDelta(
    anchorWorkday,
    targetWorkday,
    dayColumns,
    shiftContext,
  );
  const remainderQuarters = Math.round(Number(filledQuarters) || 0)
    - Math.round(Number(anchorFilledQuarters) || 0);
  const movingDays = getBarActiveDays(bar);
  // Whole-bar drag: segment only sets the grab anchor, not which days move.
  let shiftedBar = sanitizeBarAfterScheduleMove(
    shiftBarByDayDelta(bar, dayDelta, shiftContext, null),
  );
  if (remainderQuarters !== 0) {
    const nudgedBar = sanitizeBarAfterScheduleMove(
      nudgeBarByQuarterDelta(shiftedBar, remainderQuarters, shiftContext),
    );
    if (!barsHaveSameSchedule(shiftedBar, nudgedBar)) {
      shiftedBar = nudgedBar;
    } else if (dayDelta === 0) {
      shiftedBar = bar;
    }
  }
  const shiftUnchanged = barsHaveSameSchedule(bar, shiftedBar)
    && (dayDelta !== 0 || remainderQuarters !== 0);

  if (!reassigning) {
    return {
      previewBar: shiftedBar,
      shiftedBar,
      commitBar: shiftUnchanged ? null : shiftedBar,
      reassigning: false,
      blocked: shiftUnchanged,
      blockReason: shiftUnchanged
        ? describeShiftBlockReason(bar, dayDelta, shiftContext, movingDays)
        : null,
      targetRowName: resolvedTarget,
      sourceRowName: sourceRowName || null,
    };
  }

  const preparedBar = prepareBarScheduleForReassign(
    shiftedBar,
    sourceRowBars,
    resolvedTarget,
    targetRowBars,
    layoutContext,
  );
  const validation = validateReassignBarToRow(
    preparedBar,
    resolvedTarget,
    targetRowBars,
    employees,
    layoutContext,
  );
  const displayAssignee = validation.assignee || resolvedTarget;
  const previewBar = sanitizeBarAfterScheduleMove(
    applyAssigneeOverrideForReassign(preparedBar, displayAssignee),
  );

  if (!validation.ok) {
    return {
      previewBar,
      shiftedBar,
      commitBar: null,
      reassigning: true,
      blocked: true,
      blockReason: validation.reason || 'Cannot reassign here',
      targetRowName: resolvedTarget,
      sourceRowName: sourceRowName || null,
    };
  }

  return {
    previewBar,
    shiftedBar,
    commitBar: previewBar,
    reassigning: true,
    blocked: false,
    blockReason: null,
    targetRowName: resolvedTarget,
    sourceRowName: sourceRowName || null,
  };
}

export function dragBarToSnapDay(bar, snapDay, layoutContext = {}, options = {}) {
  const result = evaluateBarDrag(bar, snapDay, layoutContext, options);
  // Commit-ready bar when valid; otherwise leave the bar unchanged (no sticky fake drop).
  return result.commitBar ?? bar;
}

export function barsHaveSameAssignment(left, right) {
  if (!left || !right) {
    return left === right;
  }

  const leftEmployee = String(left.employee || '');
  const rightEmployee = String(right.employee || '');
  if (employeeNameKey(leftEmployee) !== employeeNameKey(rightEmployee)) {
    return false;
  }

  return barsHaveSameSchedule(left, right);
}

export function formatBarDragTooltip(bar, options = {}) {
  const {
    reassigning = false,
    targetRowName = '',
    blocked = false,
    blockReason = null,
  } = options;
  const schedule = formatBarResizeTooltip(bar);
  if (blocked) {
    return blockReason || 'Cannot drop here';
  }
  if (reassigning && targetRowName) {
    return `Reassign to ${targetRowName}${schedule ? ` · ${schedule}` : ''}`;
  }
  return schedule;
}

export function describeBarChange(previousBar, nextBar, options = {}) {
  const taskName = nextBar?.task_name || previousBar?.task_name || 'Task';
  const prevEmployee = String(previousBar?.employee || '').trim();
  const nextEmployee = String(nextBar?.employee || '').trim();
  const pushedCount = Number(options.pushedCount) || 0;

  let summary;
  if (prevEmployee && nextEmployee && !assigneeNameMatches(prevEmployee, nextEmployee)) {
    const slot = findAssigneeOverrideSlot(previousBar, prevEmployee).replace('override_', '');
    summary = `${taskName}: Override ${slot} ${prevEmployee} → ${nextEmployee}`;
  } else {
    summary = describeBarResizeChange(previousBar, nextBar);
  }

  if (pushedCount > 0) {
    return `${summary} · pushed ${pushedCount} task${pushedCount === 1 ? '' : 's'}`;
  }

  return summary;
}
