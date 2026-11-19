import {
  addDays,
  buildGapOnlyDayCell,
  getDayTaskSlots,
  histogramColumnLeft,
  histogramColumnWidthAt,
  isEmployeeHolidayDay,
  isTrainingGapDayCell,
  isWeekend,
  lookupDayHoursForRow,
  timelineDayColumns,
} from './ganttUtils';
import { formatDisplayDate } from '../../utils/dateFormat';
import { formatTrainingTotalHours, normalizeTrainingDaySegment } from '../../utils/trainingForm';
import {
  HISTOGRAM_DAY_PARTITIONS,
  HISTOGRAM_DEFAULT_WORK_DAY_HOURS,
} from './histogramLayout';

/** Weekend AVA > 0 means the operative works that calendar weekend day. */
function employeeWorksWeekendDay(rowName, day, availabilityHours = {}, employees = []) {
  if (!rowName || !day || !isWeekend(day)) {
    return false;
  }
  const hours = lookupDayHoursForRow(availabilityHours, rowName, day, employees);
  return (Number(hours) || 0) > 0.001;
}

function normalizeYmd(value) {
  if (!value) {
    return '';
  }
  return String(value).slice(0, 10);
}

function dayIndexInColumns(day, dayColumns = []) {
  return dayColumns.indexOf(day);
}

function indexDelta(fromDay, toDay, dayColumns = []) {
  const fromIndex = dayIndexInColumns(fromDay, dayColumns);
  const toIndex = dayIndexInColumns(toDay, dayColumns);
  if (fromIndex < 0 || toIndex < 0) {
    return 0;
  }
  return toIndex - fromIndex;
}

export function trainingScheduleKey(training) {
  const start = normalizeYmd(training?.start_date);
  const end = normalizeYmd(training?.end_date) || start;
  return `${start}::${end}`;
}

export function trainingSchedulesEqual(left, right) {
  return trainingScheduleKey(left) === trainingScheduleKey(right);
}

export function formatTrainingScheduleTooltip(training) {
  const title = String(training?.title || 'Training').trim();
  const start = formatDisplayDate(training?.start_date);
  const end = formatDisplayDate(training?.end_date);
  const totalHours = formatTrainingTotalHours(training);

  let when = '—';
  if (start && end && start !== end) {
    when = `${start} → ${end}`;
  } else if (start || end) {
    when = start || end;
  }

  return [title, when, totalHours].filter(Boolean).join(' · ');
}

/** Normalize training titles for narrow-bar display (strip decorative brackets). */
export function trainingBarLabelText(label) {
  const raw = String(label || 'Training').trim() || 'Training';
  const stripped = raw.replace(/^\[+|\]+$/g, '').trim();
  return stripped || raw;
}

/** Fit as much of the training title as the available width allows. */
export function trainingBarDisplayLabel(label, width, labelMaxWidth) {
  const text = trainingBarLabelText(label);
  const safeWidth = Math.max(0, Number(width) || 0);
  const budgetWidth = Math.max(safeWidth, Math.max(0, Number(labelMaxWidth) || 0));
  const maxChars = Math.max(1, Math.floor((budgetWidth + 6) / 3.8));

  if (maxChars >= text.length) {
    return text;
  }

  return text.slice(0, maxChars);
}

export function shiftTrainingSchedule(training, dayDelta) {
  const start = normalizeYmd(training?.start_date);
  const end = normalizeYmd(training?.end_date) || start;
  if (!start || !Number.isFinite(dayDelta) || dayDelta === 0) {
    return null;
  }

  return {
    start_date: addDays(start, dayDelta),
    end_date: addDays(end, dayDelta),
  };
}

export function resizeTrainingScheduleStart(training, snapDay) {
  const start = normalizeYmd(training?.start_date);
  const end = normalizeYmd(training?.end_date) || start;
  const nextStart = normalizeYmd(snapDay);
  if (!nextStart) {
    return null;
  }
  if (!end || nextStart > end) {
    return { start_date: nextStart, end_date: nextStart };
  }
  return { start_date: nextStart, end_date: end };
}

export function resizeTrainingScheduleEnd(training, snapDay) {
  const start = normalizeYmd(training?.start_date);
  const end = normalizeYmd(training?.end_date) || start;
  const nextEnd = normalizeYmd(snapDay);
  if (!nextEnd) {
    return null;
  }
  if (!start || nextEnd < start) {
    return { start_date: nextEnd, end_date: nextEnd };
  }
  return { start_date: start, end_date: nextEnd };
}

export function applyTrainingScheduleChange(training, mode, snapDay, context = {}) {
  const { anchorSnapDay, dayColumns = [] } = context;
  if (!training || !snapDay) {
    return null;
  }

  if (mode === 'drag') {
    const anchorDay = anchorSnapDay || normalizeYmd(training.start_date);
    const delta = indexDelta(anchorDay, snapDay, dayColumns);
    return shiftTrainingSchedule(training, delta);
  }

  if (mode === 'resize-start') {
    return resizeTrainingScheduleStart(training, snapDay);
  }

  if (mode === 'resize-end') {
    return resizeTrainingScheduleEnd(training, snapDay);
  }

  return null;
}

export function mergeTrainingSchedulePreview(training, schedule) {
  if (!training || !schedule) {
    return training;
  }

  return {
    ...training,
    start_date: schedule.start_date,
    end_date: schedule.end_date,
  };
}

function splitContiguousDayIndices(indices = []) {
  if (indices.length === 0) {
    return [];
  }

  const runs = [];
  let run = [indices[0]];

  for (let index = 1; index < indices.length; index += 1) {
    if (indices[index] === indices[index - 1] + 1) {
      run.push(indices[index]);
    } else {
      runs.push(run);
      run = [indices[index]];
    }
  }

  runs.push(run);
  return runs;
}

function layoutDayCapacity(dayCapacity) {
  const capacity = Number(dayCapacity);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
  }
  return capacity;
}

/** Map training hours_per_day to band count (1–4). */
function trainingBandCountForDay(training, day, rowName, availabilityHours, employees) {
  const hours = Number(training?.hours_per_day);
  if (!Number.isFinite(hours) || hours <= 0) {
    return HISTOGRAM_DAY_PARTITIONS;
  }

  const capacity = layoutDayCapacity(
    lookupDayHoursForRow(availabilityHours, rowName, day, employees),
  );

  if (hours >= capacity - 0.05) {
    return HISTOGRAM_DAY_PARTITIONS;
  }

  return Math.max(
    1,
    Math.min(
      HISTOGRAM_DAY_PARTITIONS,
      Math.round((hours / capacity) * HISTOGRAM_DAY_PARTITIONS) || 1,
    ),
  );
}

function bandRangeFits(startSeg, numSeg, occupiedMask) {
  for (let index = startSeg; index < startSeg + numSeg; index += 1) {
    if (index < 0 || index >= HISTOGRAM_DAY_PARTITIONS || occupiedMask[index]) {
      return false;
    }
  }
  return true;
}

function occupiedMaskFromBookedHours(booked, capacity) {
  const mask = Array(HISTOGRAM_DAY_PARTITIONS).fill(false);
  const safeBooked = Number(booked) || 0;
  const safeCapacity = layoutDayCapacity(capacity);
  if (safeBooked <= 0.05) {
    return mask;
  }

  const occupiedSegs = Math.min(
    HISTOGRAM_DAY_PARTITIONS,
    Math.max(1, Math.round((safeBooked / safeCapacity) * HISTOGRAM_DAY_PARTITIONS)),
  );
  for (let index = 0; index < occupiedSegs; index += 1) {
    mask[index] = true;
  }
  return mask;
}

function getOccupiedBandMask(rowBars, day, layoutContext = {}, dailyHours = {}) {
  const {
    rowName,
    availabilityHours = {},
    employees = [],
  } = layoutContext;

  if (rowBars?.length) {
    const slots = getDayTaskSlots(rowBars, day, layoutContext);
    const mask = Array(HISTOGRAM_DAY_PARTITIONS).fill(false);
    const seen = new Set();

    for (const slot of slots.values()) {
      const key = `${slot.startSeg}:${slot.numSeg}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      for (let index = slot.startSeg; index < slot.startSeg + slot.numSeg; index += 1) {
        if (index >= 0 && index < HISTOGRAM_DAY_PARTITIONS) {
          mask[index] = true;
        }
      }
    }

    if (seen.size > 0) {
      return mask;
    }
  }

  const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
  const capacity = lookupDayHoursForRow(availabilityHours, rowName, day, employees);
  return occupiedMaskFromBookedHours(booked, capacity);
}

/** First free day bands for a training, or null when nothing fits the mask. */
function findFreeTrainingBands(numSeg, occupiedMask) {
  const partitions = HISTOGRAM_DAY_PARTITIONS;
  const safeSeg = Math.max(1, Math.min(partitions, Number(numSeg) || 1));

  for (let start = 0; start <= partitions - safeSeg; start += 1) {
    if (bandRangeFits(start, safeSeg, occupiedMask)) {
      return { startSeg: start, numSeg: safeSeg };
    }
  }

  for (let trySeg = safeSeg - 1; trySeg >= 1; trySeg -= 1) {
    for (let start = 0; start <= partitions - trySeg; start += 1) {
      if (bandRangeFits(start, trySeg, occupiedMask)) {
        return { startSeg: start, numSeg: trySeg };
      }
    }
  }

  return null;
}

/**
 * Place training in the first free day bands after task bars (not the far edge).
 * When task bars fill the day, still avoid bands claimed by other trainings so
 * two trainings on one day never draw in the same spot (F-09).
 */
function findTrainingBandPlacement(numSeg, occupiedMask, trainingOccupiedMask = null) {
  const safeSeg = Math.max(1, Math.min(HISTOGRAM_DAY_PARTITIONS, Number(numSeg) || 1));
  return findFreeTrainingBands(safeSeg, occupiedMask)
    ?? (Array.isArray(trainingOccupiedMask)
      ? findFreeTrainingBands(safeSeg, trainingOccupiedMask)
      : null)
    ?? { startSeg: 0, numSeg: safeSeg };
}

function trainingBandLayoutForDay(
  training,
  day,
  rowName,
  availabilityHours,
  employees,
  rowBars = [],
  layoutContext = {},
  dailyHours = {},
  trainingOccupiedMask = null,
) {
  const numSeg = trainingBandCountForDay(training, day, rowName, availabilityHours, employees);

  if (numSeg >= HISTOGRAM_DAY_PARTITIONS) {
    return { startSeg: 0, numSeg: HISTOGRAM_DAY_PARTITIONS };
  }

  let occupiedMask = getOccupiedBandMask(rowBars, day, layoutContext, dailyHours);
  const trainingMask = Array.isArray(trainingOccupiedMask)
    && trainingOccupiedMask.length === HISTOGRAM_DAY_PARTITIONS
    ? trainingOccupiedMask.map(Boolean)
    : null;
  if (trainingMask) {
    occupiedMask = occupiedMask.map((occupied, index) => occupied || trainingMask[index]);
  }

  const hasPreferredSegment = training?.day_segment !== null
    && training?.day_segment !== undefined
    && training?.day_segment !== '';
  if (hasPreferredSegment) {
    const startSeg = normalizeTrainingDaySegment(training.day_segment, 0);
    const clampedSeg = Math.max(1, Math.min(numSeg, HISTOGRAM_DAY_PARTITIONS - startSeg));
    // The saved day section is authoritative: draw it there even over task bars
    // (the training layer sits above them). Only another training holding the
    // same section (shared via override) shifts it, so both stay visible (F-09).
    if (!trainingMask || bandRangeFits(startSeg, clampedSeg, trainingMask)) {
      return { startSeg, numSeg: clampedSeg };
    }
    return findTrainingBandPlacement(clampedSeg, occupiedMask, trainingMask);
  }

  const allFree = occupiedMask.every((occupied) => !occupied);
  if (allFree) {
    return { startSeg: 0, numSeg };
  }

  return findTrainingBandPlacement(numSeg, occupiedMask, trainingMask);
}

function markTrainingBandsOccupied(trainingOccupiedByDay, day, layout) {
  if (!day || !layout) {
    return;
  }
  if (!trainingOccupiedByDay.has(day)) {
    trainingOccupiedByDay.set(day, Array(HISTOGRAM_DAY_PARTITIONS).fill(false));
  }
  const mask = trainingOccupiedByDay.get(day);
  const startSeg = Math.max(0, Number(layout.startSeg) || 0);
  const numSeg = Math.max(1, Number(layout.numSeg) || 1);
  for (let index = startSeg; index < startSeg + numSeg; index += 1) {
    if (index >= 0 && index < HISTOGRAM_DAY_PARTITIONS) {
      mask[index] = true;
    }
  }
}

function segmentGeometryForDay(timeline, dayIndex, layout) {
  const partitions = HISTOGRAM_DAY_PARTITIONS;
  const dayWidth = histogramColumnWidthAt(timeline, dayIndex);
  const segmentWidth = dayWidth / partitions;
  const { startSeg, numSeg } = layout;

  if (numSeg >= partitions) {
    return {
      left: histogramColumnLeft(timeline, dayIndex),
      width: dayWidth,
      isPartialDay: false,
      numSeg,
    };
  }

  const columnLeft = histogramColumnLeft(timeline, dayIndex);
  const pad = 1;
  const widthTrim = 2;
  const left = columnLeft + startSeg * segmentWidth + pad;
  const width = Math.max(2, numSeg * segmentWidth - widthTrim);
  const labelMaxWidth = Math.max(width, columnLeft + dayWidth - left - pad);

  return {
    left,
    width,
    labelMaxWidth,
    isPartialDay: true,
    numSeg,
  };
}

function segmentGeometryForFullSpan(timeline, startIndex, endIndex) {
  const left = histogramColumnLeft(timeline, startIndex);
  let width = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    width += histogramColumnWidthAt(timeline, index);
  }
  return {
    left,
    width,
    isPartialDay: false,
    numSeg: HISTOGRAM_DAY_PARTITIONS,
  };
}

function segmentsFromDayRun(
  timeline,
  startIndex,
  endIndex,
  training,
  extras = {},
  layoutContext = {},
  trainingOccupiedByDay = null,
) {
  const {
    dayColumns = [],
    rowName,
    availabilityHours = {},
    employees = [],
    rowBars = [],
    dailyHours = {},
  } = layoutContext;

  const partitions = HISTOGRAM_DAY_PARTITIONS;
  const label = training.title || 'Training';

  // Multi-day trainings stay as one continuous bar across the full columns.
  if (startIndex < endIndex) {
    if (trainingOccupiedByDay) {
      for (let index = startIndex; index <= endIndex; index += 1) {
        const day = dayColumns[index];
        markTrainingBandsOccupied(trainingOccupiedByDay, day, {
          startSeg: 0,
          numSeg: partitions,
        });
      }
    }
    return [{
      training,
      dayIndex: startIndex,
      ...segmentGeometryForFullSpan(timeline, startIndex, endIndex),
      label,
      ...extras,
    }];
  }

  const day = dayColumns[startIndex];
  const trainingOccupiedMask = trainingOccupiedByDay?.get(day) ?? null;
  const layout = trainingBandLayoutForDay(
    training,
    day,
    rowName,
    availabilityHours,
    employees,
    rowBars,
    layoutContext,
    dailyHours,
    trainingOccupiedMask,
  );

  if (trainingOccupiedByDay) {
    markTrainingBandsOccupied(trainingOccupiedByDay, day, layout);
  }

  if (layout.numSeg >= partitions && layout.startSeg === 0) {
    return [{
      training,
      dayIndex: startIndex,
      ...segmentGeometryForFullSpan(timeline, startIndex, startIndex),
      label,
      ...extras,
    }];
  }

  return [{
    training,
    dayIndex: startIndex,
    ...segmentGeometryForDay(timeline, startIndex, layout),
    label,
    ...extras,
  }];
}

function gapDayIndicesForTraining({
  training,
  dayColumns,
  rowName,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
}) {
  const startYmd = String(training.start_date ?? '').slice(0, 10);
  const endYmd = String(training.end_date ?? '').slice(0, 10) || startYmd;
  if (!startYmd || !rowName) {
    return [];
  }

  const indices = [];
  dayColumns.forEach((day, index) => {
    if (day < startYmd || day > endYmd) {
      return;
    }

    // Weekends are only schedulable when the operative has weekend AVA.
    if (isWeekend(day)) {
      if (!employeeWorksWeekendDay(rowName, day, availabilityHours, employees)) {
        return;
      }
      const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
      const capacity = lookupDayHoursForRow(availabilityHours, rowName, day, employees) ?? 0;
      if (capacity - booked > 0.05) {
        indices.push(index);
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

    if (isTrainingGapDayCell(cell)) {
      indices.push(index);
    }
  });

  return indices;
}

/**
 * Days the training bar should paint. Weekends are omitted unless the
 * operative has AVA that day (working the weekend) so bars do not cross
 * Sat/Sun for Mon–Fri staff.
 */
function scheduleDayIndicesForTraining({
  training,
  dayColumns,
  rowName,
  availabilityHours,
  employeeHolidays = {},
  employees,
}) {
  const startYmd = String(training.start_date ?? '').slice(0, 10);
  const endYmd = String(training.end_date ?? '').slice(0, 10) || startYmd;
  if (!startYmd) {
    return [];
  }

  const indices = [];
  dayColumns.forEach((day, index) => {
    if (day < startYmd || day > endYmd) {
      return;
    }
    if (
      isWeekend(day)
      && !employeeWorksWeekendDay(rowName, day, availabilityHours, employees)
    ) {
      return;
    }
    if (rowName && isEmployeeHolidayDay(rowName, day, employeeHolidays, employees)) {
      return;
    }
    indices.push(index);
  });
  return indices;
}

export function buildTrainingBarSegments(
  trainings = [],
  timeline,
  dayColumns = timelineDayColumns(timeline),
  options = {},
) {
  if (!timeline || dayColumns.length === 0) {
    return [];
  }

  const {
    rowName,
    dailyHours = {},
    availabilityHours = {},
    employeeHolidays = {},
    employees = [],
    rowBars = [],
    clipToFreeTime = false,
    getSegmentMeta,
  } = options;

  const segments = [];
  // Track bands already claimed by earlier trainings so same-day bars do not stack.
  const trainingOccupiedByDay = new Map();

  const orderedTrainings = [...(trainings || [])].sort((left, right) => (
    String(left?.start_date ?? '').localeCompare(String(right?.start_date ?? ''))
    || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
  ));

  orderedTrainings.forEach((training) => {
    const startYmd = String(training.start_date ?? '').slice(0, 10);
    if (!startYmd) {
      return;
    }

    const extras = typeof getSegmentMeta === 'function' ? getSegmentMeta(training) : {};

    if (clipToFreeTime && rowName) {
      const gapIndices = gapDayIndicesForTraining({
        training,
        dayColumns,
        rowName,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        employees,
      });

      // Prefer free-capacity days, but always fall back to the full schedule
      // range so override / fully-booked trainings still render.
      if (gapIndices.length > 0) {
        splitContiguousDayIndices(gapIndices).forEach((run) => {
          segments.push(...segmentsFromDayRun(
            timeline,
            run[0],
            run[run.length - 1],
            training,
            extras,
            {
              dayColumns,
              rowName,
              availabilityHours,
              employeeHolidays,
              employees,
              rowBars,
              dailyHours,
            },
            trainingOccupiedByDay,
          ));
        });
        return;
      }
    }

    const scheduleIndices = scheduleDayIndicesForTraining({
      training,
      dayColumns,
      rowName,
      availabilityHours,
      employeeHolidays,
      employees,
    });

    if (scheduleIndices.length === 0) {
      return;
    }

    const layoutContext = {
      dayColumns,
      rowName,
      availabilityHours,
      employeeHolidays,
      employees,
      rowBars,
      dailyHours,
    };

    splitContiguousDayIndices(scheduleIndices).forEach((run) => {
      segments.push(...segmentsFromDayRun(
        timeline,
        run[0],
        run[run.length - 1],
        training,
        extras,
        layoutContext,
        trainingOccupiedByDay,
      ));
    });
  });

  return segments;
}
