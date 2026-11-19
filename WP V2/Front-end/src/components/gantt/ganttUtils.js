import { formatHistogramDateHeader } from '../../utils/dateFormat';
import { buildEmployeeNameKeyMap, employeeDisplayName, employeeMatchesName, employeeNameKey, employeeTeamName } from '../../utils/employeeNames';
import { displayProjectColor } from '../../utils/projectColor';
import { getProjectEffectiveStatus, projectHasOpenTasks, projectIsDone, sortLegendItemsAsc } from '../../utils/projectSort';
import { compareTeamNames, sortEmployeesByTeamThenName } from '../../utils/teamOrder';
import { parseTaskProgressPercent } from '../../utils/taskCalculations';
import {
  HISTOGRAM_BAR_LABEL_MIN_HORIZONTAL_PX,
  HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX,
  HISTOGRAM_COMPACT_LABEL_MAX_SPAN_DAYS,
  HISTOGRAM_DAY_PARTITIONS,
  HISTOGRAM_DEFAULT_WORK_DAY_HOURS,
  HISTOGRAM_FIXED_DAY_PARTITIONS,
  HISTOGRAM_FLAG_SIZE,
  HISTOGRAM_MAX_VIEW_DAYS,
  HISTOGRAM_DAY_WIDTH,
  HISTOGRAM_WEEKEND_DAY_WIDTH,
} from './histogramLayout';

export {
  HISTOGRAM_DAY_PARTITIONS,
  HISTOGRAM_DEFAULT_WORK_DAY_HOURS,
  HISTOGRAM_MAX_VIEW_DAYS,
};

function ymdToDate(ymd) {
  if (!ymd) return null;
  const match = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateToYmd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseYmd(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateToYmd(date);
}

export function addDays(ymd, days) {
  const date = ymdToDate(ymd);
  if (!date) return ymd;
  date.setDate(date.getDate() + days);
  return dateToYmd(date);
}

export function histogramMaxEndFromStart(startYmd, maxDays = HISTOGRAM_MAX_VIEW_DAYS) {
  if (!startYmd) {
    return startYmd;
  }
  return addDays(startYmd, maxDays - 1);
}

/** Clamp end date so the grid never spans more than the day-view maximum. */
export function clampHistogramDateRange(startYmd, endYmd, maxDays = HISTOGRAM_MAX_VIEW_DAYS) {
  if (!startYmd || !endYmd) {
    return { start: startYmd, end: endYmd };
  }

  if (startYmd > endYmd) {
    return { start: startYmd, end: startYmd };
  }

  const maxEnd = histogramMaxEndFromStart(startYmd, maxDays);
  return {
    start: startYmd,
    end: endYmd > maxEnd ? maxEnd : endYmd,
  };
}

/**
 * Keep start/end valid: repair inverted ranges and cap to the max day window.
 * @param {'start'|'end'} changed - which field the user edited when start > end
 */
export function normalizeHistogramDateSelection(startYmd, endYmd, changed = 'end') {
  if (!startYmd && !endYmd) {
    return { start: '', end: '' };
  }

  let start = startYmd || endYmd || '';
  let end = endYmd || startYmd || '';

  if (!start || !end) {
    return { start, end };
  }

  if (start > end) {
    if (changed === 'start') {
      end = start;
    } else {
      start = end;
    }
  }

  return clampHistogramDateRange(start, end);
}

/** Loaded assignment / availability bounds from a histogram payload. */
export function resolveHistogramDataEnvelope(payload) {
  if (payload?.range?.start && payload?.range?.end) {
    return {
      start: String(payload.range.start).slice(0, 10),
      end: String(payload.range.end).slice(0, 10),
    };
  }

  let min = null;
  let max = null;

  (payload?.bars ?? []).forEach((bar) => {
    if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
      return;
    }

    Object.entries(bar.hours_by_day).forEach(([day, hours]) => {
      if ((Number(hours) || 0) <= 0.001) {
        return;
      }
      if (!min || day < min) {
        min = day;
      }
      if (!max || day > max) {
        max = day;
      }
    });
  });

  if (!min || !max) {
    return null;
  }

  return { start: min, end: max };
}

export function viewRangeNeedsEnvelopeRefetch(viewRange, dataEnvelope) {
  if (!viewRange?.start || !viewRange?.end || !dataEnvelope?.start || !dataEnvelope?.end) {
    return false;
  }

  return (
    viewRange.start < dataEnvelope.start
    || viewRange.end > dataEnvelope.end
  );
}

/**
 * Widen the histogram date filter so scheduled task bars are visible.
 * Keeps the current window when possible; otherwise shifts to include the task.
 */
export function expandViewRangeToInclude(viewRange, envelope, { paddingDays = 7 } = {}) {
  if (!viewRange?.start || !viewRange?.end) {
    return { start: viewRange?.start ?? '', end: viewRange?.end ?? '', changed: false };
  }

  if (!envelope?.start && !envelope?.end) {
    return { start: viewRange.start, end: viewRange.end, changed: false };
  }

  const paddedStart = envelope.start ? addDays(envelope.start, -paddingDays) : viewRange.start;
  const paddedEnd = envelope.end ? addDays(envelope.end, paddingDays) : viewRange.end;
  const needsStart = paddedStart < viewRange.start;
  const needsEnd = paddedEnd > viewRange.end;

  if (!needsStart && !needsEnd) {
    return { start: viewRange.start, end: viewRange.end, changed: false };
  }

  let start = needsStart ? paddedStart : viewRange.start;
  let end = needsEnd ? paddedEnd : viewRange.end;
  let normalized = normalizeHistogramDateSelection(start, end, 'end');

  if (envelope.end && normalized.end < envelope.end) {
    normalized = normalizeHistogramDateSelection(
      addDays(envelope.end, -(HISTOGRAM_MAX_VIEW_DAYS - 1)),
      envelope.end,
      'end',
    );
  } else if (envelope.start && normalized.start > envelope.start) {
    normalized = normalizeHistogramDateSelection(
      envelope.start,
      addDays(envelope.start, HISTOGRAM_MAX_VIEW_DAYS - 1),
      'end',
    );
  }

  return {
    start: normalized.start,
    end: normalized.end,
    changed: normalized.start !== viewRange.start || normalized.end !== viewRange.end,
  };
}

/** Default visible date window for the histogram (1 week past → 7 weeks ahead). */
export function defaultHistogramDateRange() {
  const today = dateToYmd(new Date());

  return {
    start: addDays(today, -7),
    end: addDays(today, 51),
  };
}

export function daysBetweenInclusive(startYmd, endYmd) {
  const start = ymdToDate(startYmd);
  const end = ymdToDate(endYmd);
  if (!start || !end) return 1;
  const diff = Math.round((end - start) / 86400000);
  return Math.max(1, diff + 1);
}

export function buildDayColumns(startYmd, endYmd, maxDays = HISTOGRAM_MAX_VIEW_DAYS) {
  const columns = [];
  let current = startYmd;
  let guard = 0;
  const span = daysBetweenInclusive(startYmd, endYmd);
  const cap = Math.min(Math.max(span, 1), maxDays);

  while (current <= endYmd && guard < cap) {
    columns.push(current);
    current = addDays(current, 1);
    guard += 1;
  }

  return columns;
}

/** Build one timeline column per calendar day in the visible range. */
export function buildHistogramTimeline(startYmd, endYmd) {
  const days = buildDayColumns(startYmd, endYmd);
  const columns = days.map((day) => ({
    key: day,
    start: day,
    end: day,
    day,
    unit: 'day',
    width: histogramDayColumnWidth(day),
  }));

  const timelineWidth = columns.reduce((sum, column) => sum + column.width, 0);

  return {
    columns,
    columnWidth: HISTOGRAM_DAY_WIDTH,
    timelineWidth,
  };
}

export function timelineDayColumns(timeline) {
  return (timeline?.columns ?? []).map((column) => column.day || column.start);
}

export function isBarActiveInColumn(bar, column) {
  const dayYmd = column?.day || column?.start;
  return isBarActiveOnDay(bar, dayYmd);
}

export function rowHasBarInColumn(bars, column) {
  return (bars ?? []).some((bar) => isBarActiveInColumn(bar, column));
}

export function dayLabel(ymd) {
  return formatHistogramDateHeader(ymd) || ymd;
}

export function isWeekend(ymd) {
  const date = ymdToDate(ymd);
  if (!date) return false;
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function histogramDayColumnWidth(dayYmd) {
  return isWeekend(dayYmd) ? HISTOGRAM_WEEKEND_DAY_WIDTH : HISTOGRAM_DAY_WIDTH;
}

export function histogramColumnWidthAt(timeline, index) {
  const column = timeline?.columns?.[index];
  if (!column) {
    return HISTOGRAM_DAY_WIDTH;
  }

  if (typeof column.width === 'number' && column.width > 0) {
    return column.width;
  }

  return histogramDayColumnWidth(column.day || column.start);
}

export function histogramColumnLeft(timeline, index) {
  let left = 0;
  for (let i = 0; i < index; i += 1) {
    left += histogramColumnWidthAt(timeline, i);
  }
  return left;
}

export function histogramSpanWidth(timeline, startIndex, endIndexExclusive) {
  let width = 0;
  for (let i = startIndex; i < endIndexExclusive; i += 1) {
    width += histogramColumnWidthAt(timeline, i);
  }
  return width;
}

export function histogramMonthSpanWidth(timeline, startIndex, dayCount) {
  return histogramSpanWidth(timeline, startIndex, startIndex + dayCount);
}

export function histogramTimelineWidth(timeline) {
  if (typeof timeline?.timelineWidth === 'number' && timeline.timelineWidth > 0) {
    return timeline.timelineWidth;
  }

  return histogramSpanWidth(timeline, 0, timeline?.columns?.length ?? 0);
}

export function getTimelineDayIndexFromPointer(timelineElement, clientX, timeline) {
  if (!timelineElement || !timeline?.columns?.length) {
    return 0;
  }

  const x = getPointerXInTimelineForIndex(timelineElement, clientX);
  let offset = 0;

  for (let index = 0; index < timeline.columns.length; index += 1) {
    const width = histogramColumnWidthAt(timeline, index);
    if (x < offset + width) {
      return index;
    }
    offset += width;
  }

  return timeline.columns.length - 1;
}

/**
 * Resize snap index: a day becomes the target once the pointer reaches that
 * column's horizontal midpoint, so the bar stretches as soon as the mouse
 * hits the middle of the next day (not only at the far edge).
 */
export function getTimelineDayIndexFromPointerMidpoint(timelineElement, clientX, timeline) {
  if (!timelineElement || !timeline?.columns?.length) {
    return 0;
  }

  const x = getPointerXInTimelineForIndex(timelineElement, clientX);
  let offset = 0;
  let selected = 0;

  for (let index = 0; index < timeline.columns.length; index += 1) {
    const width = histogramColumnWidthAt(timeline, index);
    const midpoint = offset + (width / 2);
    if (x >= midpoint) {
      selected = index;
    } else {
      break;
    }
    offset += width;
  }

  return selected;
}

/**
 * Resize snap within a day: 4 quarter checkpoints (0, ¼, ½, ¾, full).
 * Returns the day column index and how many quarters are filled from the
 * start of that day (0–4).
 */
export function getTimelineQuarterSnapFromPointer(timelineElement, clientX, timeline) {
  if (!timelineElement || !timeline?.columns?.length) {
    return { dayIndex: 0, filledQuarters: HISTOGRAM_DAY_PARTITIONS };
  }

  const x = getPointerXInTimelineForIndex(timelineElement, clientX);
  let offset = 0;

  for (let index = 0; index < timeline.columns.length; index += 1) {
    const width = histogramColumnWidthAt(timeline, index);
    if (x < offset + width || index === timeline.columns.length - 1) {
      const local = Math.max(0, Math.min(width, x - offset));
      const fraction = width > 0 ? local / width : 1;
      const filledQuarters = Math.max(
        0,
        Math.min(
          HISTOGRAM_DAY_PARTITIONS,
          Math.round(fraction * HISTOGRAM_DAY_PARTITIONS),
        ),
      );
      return { dayIndex: index, filledQuarters };
    }
    offset += width;
  }

  return {
    dayIndex: timeline.columns.length - 1,
    filledQuarters: HISTOGRAM_DAY_PARTITIONS,
  };
}

function getPointerXInTimelineForIndex(timelineElement, clientX) {
  if (!timelineElement) {
    return 0;
  }

  const scroller = timelineElement.closest('.histogram-timeline-scroll, .histogram-sync-scroll-main');
  const scrollLeft = scroller?.scrollLeft ?? 0;

  if (scroller) {
    const scrollerRect = scroller.getBoundingClientRect();
    const row = timelineElement.closest('.resource-histogram-resource-block');
    const label = row?.querySelector(
      ':scope > .resource-histogram-name-col, :scope > .resource-gantt-label-col',
    );

    if (label) {
      const labelWidth = label.getBoundingClientRect().width;
      return scrollLeft + (clientX - scrollerRect.left) - labelWidth;
    }
  }

  const rect = timelineElement.getBoundingClientRect();
  return clientX - rect.left + scrollLeft;
}

/** True when every calendar day between the dates is a weekend. */
function areConnectedAcrossWeekendsOnly(startYmd, endYmd) {
  const start = parseYmd(startYmd);
  const end = parseYmd(endYmd);
  if (!start || !end) {
    return false;
  }
  if (end <= start) {
    return true;
  }

  let cursor = start;
  while (cursor < end) {
    cursor = addDays(cursor, 1);
    if (!isWeekend(cursor)) {
      return false;
    }
  }

  return true;
}

/**
 * True when the operative has weekend capacity (AVA) or scheduled hours on Sat/Sun.
 */
export function employeeWorksOnWeekends(
  rowName,
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
  bars = [],
) {
  if (!rowName) {
    return false;
  }

  const employee = employees.find((entry) => employeeMatchesName(entry, rowName));

  for (const [key, days] of Object.entries(availabilityHours ?? {})) {
    if (!days || typeof days !== 'object') {
      continue;
    }
    const matches = employee
      ? employeeMatchesName(employee, key)
      : employeeMatchesName({ name: rowName, first_name: rowName }, key);
    if (!matches) {
      continue;
    }

    for (const [day, hours] of Object.entries(days)) {
      if (!isWeekend(day)) {
        continue;
      }
      if (isEmployeeHolidayDay(rowName, day, employeeHolidays, employees)) {
        continue;
      }
      if ((Number(hours) || 0) > 0.001) {
        return true;
      }
    }
  }

  for (const bar of bars ?? []) {
    for (const [day, hours] of Object.entries(bar?.hours_by_day ?? {})) {
      if (isWeekend(day) && (Number(hours) || 0) > 0.001) {
        return true;
      }
    }
  }

  return false;
}

/** True when end is the same as or the next weekday after start (weekends are skipped). */
export function areConsecutiveWorkdays(startYmd, endYmd) {
  const start = parseYmd(startYmd);
  const end = parseYmd(endYmd);
  if (!start || !end) {
    return false;
  }
  if (end <= start) {
    return true;
  }

  let cursor = start;
  while (cursor < end) {
    cursor = addDays(cursor, 1);
    if (isWeekend(cursor)) {
      continue;
    }
    return cursor === end;
  }

  return true;
}

function mergeHistogramBarPair(left, right) {
  const hoursByDay = { ...(left.hours_by_day || {}) };
  Object.entries(right.hours_by_day || {}).forEach(([day, hours]) => {
    hoursByDay[day] = round((Number(hoursByDay[day]) || 0) + (Number(hours) || 0), 4);
  });

  const start = [left.start, right.start].filter(Boolean).sort()[0] ?? left.start;
  const end = [left.end, right.end].filter(Boolean).sort().at(-1) ?? right.end;

  const { _resizeEdge, ...leftRest } = left;
  return {
    ...leftRest,
    start,
    end,
    doc_supply: left.doc_supply || right.doc_supply || start,
    completion: left.completion || right.completion || end,
    hours: round((Number(left.hours) || 0) + (Number(right.hours) || 0), 4),
    hours_by_day: hoursByDay,
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function barRangeStart(bar) {
  const days = Object.keys(bar?.hours_by_day || {}).sort();
  return bar?.start || days[0] || bar?.doc_supply || '';
}

function barRangeEnd(bar) {
  const days = Object.keys(bar?.hours_by_day || {}).sort();
  return bar?.end || days.at(-1) || bar?.completion || '';
}

function getBarActiveDayList(bar) {
  if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
    return [];
  }

  return Object.entries(bar.hours_by_day)
    .filter(([day, hours]) => (Number(hours) || 0) > 0.001 && !isWeekend(day))
    .map(([day]) => day)
    .sort();
}

function barSchedulesOverlapOrTouch(left, right, mergeContext = {}) {
  const leftDays = getBarActiveDayList(left);
  const rightDays = getBarActiveDayList(right);
  if (!leftDays.length || !rightDays.length) {
    return true;
  }

  const leftStart = leftDays[0];
  const leftEnd = leftDays.at(-1);
  const rightStart = rightDays[0];
  const rightEnd = rightDays.at(-1);

  if (leftStart <= rightEnd && rightStart <= leftEnd) {
    return true;
  }

  const worksWeekends = employeeWorksOnWeekends(
    mergeContext.rowName,
    mergeContext.availabilityHours,
    mergeContext.employeeHolidays,
    mergeContext.employees,
    mergeContext.bars,
  );

  const bridgeWeekendGap = worksWeekends
    && (
      areConnectedAcrossWeekendsOnly(leftEnd, rightStart)
      || areConnectedAcrossWeekendsOnly(rightEnd, leftStart)
    );

  return areConsecutiveWorkdays(leftEnd, rightStart)
    || areConsecutiveWorkdays(rightEnd, leftStart)
    || bridgeWeekendGap;
}

function histogramBarGroupKey(bar) {
  const employee = String(bar?.employee || '').trim();
  return `${bar?.task_id}::${employeeNameKey(employee) || employee}`;
}

/** Exported for drag preview / commit logic that keys by task + operative. */
export { histogramBarGroupKey };

function shouldAlignPartialStartRight(barIds, layoutContext = {}, options = {}) {
  if (options.alignPartialStartRight === true) {
    return true;
  }
  if (options.alignPartialStartRight === false) {
    return false;
  }
  const resizeStartBarId = layoutContext.resizeStartBarId;
  if (!resizeStartBarId) {
    return false;
  }
  return (barIds ?? []).some((barId) => String(barId) === String(resizeStartBarId));
}

/** Merge only overlapping/touching bars for the same employee + task (keep gapped splits separate). */
export function mergeAdjacentTaskBars(bars, mergeContext = {}) {
  if (!bars?.length) {
    return [];
  }

  const context = {
    ...mergeContext,
    bars: mergeContext.bars ?? bars,
  };

  const byGroup = new Map();
  bars.forEach((bar) => {
    const key = histogramBarGroupKey(bar);
    if (!byGroup.has(key)) {
      byGroup.set(key, []);
    }
    byGroup.get(key).push(bar);
  });

  const merged = [];
  byGroup.forEach((groupBars) => {
    const sorted = [...groupBars].sort(
      (a, b) => String(barRangeStart(a)).localeCompare(String(barRangeStart(b))),
    );

    let chain = null;
    sorted.forEach((bar) => {
      const normalized = {
        ...bar,
        hours_by_day: { ...(bar.hours_by_day || {}) },
      };

      if (!chain) {
        chain = normalized;
        return;
      }

      if (barSchedulesOverlapOrTouch(chain, normalized, context)) {
        chain = mergeHistogramBarPair(chain, normalized);
        return;
      }

      merged.push(chain);
      chain = normalized;
    });

    if (chain) {
      merged.push(chain);
    }
  });

  return merged.sort((a, b) => String(barRangeStart(a)).localeCompare(String(barRangeStart(b))));
}

/** Merge every fragment for the same task + operative (gaps stay in hours_by_day). */
export function consolidateTaskEmployeeBars(bars, mergeContext = {}) {
  if (!bars?.length) {
    return [];
  }

  const byGroup = new Map();
  bars.forEach((bar) => {
    const key = histogramBarGroupKey(bar);
    const normalized = {
      ...bar,
      hours_by_day: { ...(bar.hours_by_day || {}) },
    };

    if (!byGroup.has(key)) {
      byGroup.set(key, normalized);
      return;
    }

    byGroup.set(key, mergeHistogramBarPair(byGroup.get(key), normalized));
  });

  return [...byGroup.values()].sort(
    (a, b) => String(barRangeStart(a)).localeCompare(String(barRangeStart(b))),
  );
}

export function barMetrics(bar, rangeStart, dayWidth) {
  const start = parseYmd(bar.start) || rangeStart;
  const end = parseYmd(bar.end) || start;
  const startOffset = daysBetweenInclusive(rangeStart, start) - 1;
  const spanDays = daysBetweenInclusive(start, end);
  const left = startOffset * dayWidth;
  const width = Math.max(dayWidth * 0.6, spanDays * dayWidth - 4);

  return { left, width, spanDays };
}

export function getBarLabel(bar) {
  const taskName = String(bar?.task_name || '').trim();
  return taskName || 'Untitled task';
}

export function getBarInclusiveSpanDays(bar) {
  const start = parseYmd(bar?.doc_supply || bar?.start);
  const end = parseYmd(bar?.completion || bar?.end) || start;
  if (!start || !end) {
    return 0;
  }

  return daysBetweenInclusive(start, end);
}

/** Short label (NRM number) for narrow task bar segments. */
export function getBarCompactLabel(bar) {
  if (bar?.task_name) {
    return String(bar.task_name);
  }

  const fromName = extractNrmNumberFromTaskName(bar?.task_name);
  if (fromName) {
    return fromName;
  }

  const firstToken = String(bar?.task_name || '').trim().match(/^([^\s]+)/);
  return firstToken?.[1] || getBarLabel(bar);
}

export function barLabelMinWidth(label, fontSizePx = 9) {
  return barLabelMinWidths(label, fontSizePx).horizMin;
}

export function barLabelMinWidths(label, fontSizePx = 9) {
  const len = Math.max(1, String(label || '').trim().length);
  const charWidth = fontSizePx * 0.62;
  const horizMin = Math.max(
    HISTOGRAM_BAR_LABEL_MIN_HORIZONTAL_PX,
    Math.ceil(len * charWidth + 10),
  );
  const vertMin = Math.max(HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX, fontSizePx + 5);
  return { horizMin, vertMin };
}

function pickBarSegmentLabelPresentation(text, segmentWidthPx, fontSizePx, preferCompact) {
  const widths = barLabelMinWidths(text, fontSizePx);

  return {
    text,
    compact: preferCompact,
    vertical: false,
    minWidth: widths.horizMin,
  };
}

/** Prefer horizontal labels; fall back to compact label when narrow. */
export function resolveBarSegmentLabel(bar, segmentWidthPx, fontSizePx = 9, options = {}) {
  const { allowLabelExpansion = true } = options;
  const fullLabel = getBarLabel(bar);
  const compactLabel = getBarCompactLabel(bar);
  const fullWidths = barLabelMinWidths(fullLabel, fontSizePx);
  const compactWidths = barLabelMinWidths(compactLabel, fontSizePx);
  const spanDays = getBarInclusiveSpanDays(bar);
  const isSingleDay = spanDays <= HISTOGRAM_COMPACT_LABEL_MAX_SPAN_DAYS;

  if (segmentWidthPx >= fullWidths.horizMin) {
    return {
      text: fullLabel,
      compact: false,
      vertical: false,
      minWidth: allowLabelExpansion ? fullWidths.horizMin : segmentWidthPx,
    };
  }

  if (!allowLabelExpansion || segmentWidthPx < compactWidths.horizMin) {
    return {
      text: compactLabel,
      compact: true,
      vertical: false,
      minWidth: segmentWidthPx,
    };
  }

  return pickBarSegmentLabelPresentation(compactLabel, segmentWidthPx, fontSizePx, isSingleDay);
}

export function barHoursOnDay(bar, dayYmd) {
  if (!bar?.hours_by_day || !dayYmd || !Object.prototype.hasOwnProperty.call(bar.hours_by_day, dayYmd)) {
    return 0;
  }

  return Number(bar.hours_by_day[dayYmd]) || 0;
}

function roundToHalf(value) {
  return Math.round(value * 2) / 2;
}

function clampDaySegment(startSeg, numSeg) {
  const partitions = HISTOGRAM_DAY_PARTITIONS;
  const start = Math.max(0, Math.min(partitions, Number(startSeg) || 0));
  const num = Math.max(0, Math.min(partitions - start, Number(numSeg) || 0));
  return { startSeg: start, numSeg: num };
}

function normalizeCollisionLayout(layout) {
  const partitions = HISTOGRAM_DAY_PARTITIONS;
  const entries = [...layout.entries()];
  if (entries.length === 0) {
    return layout;
  }

  let total = 0;
  entries.forEach(([, value]) => {
    total += value.numSeg;
  });

  if (total <= partitions + 0.001) {
    return layout;
  }

  const normalized = new Map();
  let startSeg = 0;
  entries.forEach(([taskKey, value], index) => {
    const isLast = index === entries.length - 1;
    const scaled = isLast
      ? partitions - startSeg
      : roundToHalf((value.numSeg / total) * partitions);
    const numSeg = Math.max(
      value.numSeg > 0 ? 0.5 : 0,
      Math.min(scaled, partitions - startSeg),
    );
    normalized.set(taskKey, { startSeg, numSeg });
    startSeg += numSeg;
  });

  return normalized;
}

function adjacentCalendarDayStrings(ymd) {
  return {
    prev: addDays(ymd, -1),
    next: addDays(ymd, 1),
  };
}

/** True when this assignment has hours on a later weekday (skips weekends). */
function hasBarHoursOnLaterWorkday(rowBars, dayYmd, barKey) {
  let cursor = addDays(dayYmd, 1);
  for (let guard = 0; guard < 14; guard += 1) {
    if (!isWeekend(cursor) && sumBarHoursOnDay(rowBars, cursor, barKey) > 0.001) {
      return true;
    }
    cursor = addDays(cursor, 1);
  }
  return false;
}

/** True when this assignment has hours on an earlier weekday (skips weekends). */
function hasBarHoursOnEarlierWorkday(rowBars, dayYmd, barKey) {
  let cursor = addDays(dayYmd, -1);
  for (let guard = 0; guard < 14; guard += 1) {
    if (!isWeekend(cursor) && sumBarHoursOnDay(rowBars, cursor, barKey) > 0.001) {
      return true;
    }
    cursor = addDays(cursor, -1);
  }
  return false;
}

function calendarDayDiff(aYmd, bYmd) {
  if (!aYmd || !bYmd) {
    return null;
  }
  const a = ymdToDate(aYmd);
  const b = ymdToDate(bYmd);
  if (!a || !b) {
    return null;
  }
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function sumBarHoursOnDay(rowBars, dayYmd, barKey) {
  return (rowBars ?? [])
    .filter((bar) => (
      String(bar.id) === String(barKey)
      || histogramBarGroupKey(bar) === String(barKey)
    ))
    .reduce((sum, bar) => sum + barHoursOnDay(bar, dayYmd), 0);
}

function contextualHoursForBar(rowBars, centerDay, barId) {
  const { prev, next } = adjacentCalendarDayStrings(centerDay);
  let sum = sumBarHoursOnDay(rowBars, centerDay, barId);
  if (prev) {
    sum += sumBarHoursOnDay(rowBars, prev, barId);
  }
  if (next) {
    sum += sumBarHoursOnDay(rowBars, next, barId);
  }
  return sum;
}

function nearestOffsetsForBar(rowBars, centerDay, barId) {
  const days = new Set();
  (rowBars ?? []).forEach((bar) => {
    const start = parseYmd(bar.start);
    const end = parseYmd(bar.end) || start;
    if (!start || !end) {
      return;
    }
    let current = start;
    let guard = 0;
    while (current <= end && guard < 400) {
      days.add(current);
      current = addDays(current, 1);
      guard += 1;
    }
  });

  let prevGap = null;
  let nextGap = null;
  days.forEach((day) => {
    const gap = calendarDayDiff(centerDay, day);
    if (gap == null || gap === 0) {
      return;
    }
    if (sumBarHoursOnDay(rowBars, day, barId) <= 0) {
      return;
    }
    if (gap < 0) {
      const distance = Math.abs(gap);
      if (prevGap == null || distance < prevGap) {
        prevGap = distance;
      }
    } else if (nextGap == null || gap < nextGap) {
      nextGap = gap;
    }
  });

  return { prevGap, nextGap };
}

function continuitySidePreference(prevGap, nextGap) {
  if (prevGap != null && nextGap == null) {
    return -1;
  }
  if (nextGap != null && prevGap == null) {
    return 1;
  }
  if (prevGap != null && nextGap != null) {
    if (prevGap < nextGap) {
      return -1;
    }
    if (nextGap < prevGap) {
      return 1;
    }
  }
  return 0;
}

/**
 * Split a shared day into proportional bands (0.5-band steps), sized vs day AVA capacity.
 * Total width reflects booked hours / capacity — spare capacity stays empty in the column.
 */
function collisionDayBandLayoutFixed(hoursPerTask, dayCapacity) {
  const partitions = HISTOGRAM_DAY_PARTITIONS;
  const step = 0.5;
  const capacity = layoutDayCapacity(dayCapacity);
  const rows = hoursPerTask
    .map((row) => ({
      taskKey: row.taskKey,
      totalHours: Math.max(0, Number(row.totalHours) || 0),
    }))
    .filter((row) => row.totalHours > 0)
    .sort((a, b) => a.totalHours - b.totalHours);
  const layout = new Map();
  const n = rows.length;

  if (n === 0) {
    return layout;
  }

  if (n === 1) {
    layout.set(
      rows[0].taskKey,
      soloDayBandLayout(rows[0].totalHours, capacity),
    );
    return layout;
  }

  const totalHours = rows.reduce((sum, row) => sum + row.totalHours, 0);
  const maxSegTotal = Math.min(
    partitions,
    roundToHalf((totalHours / capacity) * partitions),
  );

  if (totalHours <= 0) {
    const totalHalfUnits = Math.max(n, Math.round(maxSegTotal * 2));
    const parts = Array(n).fill(0);
    for (let i = 0; i < totalHalfUnits; i += 1) {
      parts[i % n] += 1;
    }
    let startSeg = 0;
    rows.forEach((row, index) => {
      const numSeg = (parts[index] || 0) / 2;
      layout.set(row.taskKey, { startSeg, numSeg });
      startSeg += numSeg;
    });
    return layout;
  }

  if (n === 2) {
    const h0 = rows[0].totalHours;
    const h1 = rows[1].totalHours;
    const loRow = h0 <= h1 ? rows[0] : rows[1];
    const hiRow = h0 <= h1 ? rows[1] : rows[0];
    const hLo = Math.min(h0, h1);
    const hHi = Math.max(h0, h1);
    let pLo = roundToHalf((hLo / capacity) * partitions);
    let pHi = roundToHalf((hHi / capacity) * partitions);
    if (hLo > 0) {
      pLo = Math.max(step, pLo);
    }
    if (hHi > 0) {
      pHi = Math.max(step, pHi);
    }

    const combined = roundToHalf(pLo + pHi);
    if (combined > maxSegTotal + 0.001 && combined > 0) {
      pLo = roundToHalf((pLo / combined) * maxSegTotal);
      pHi = roundToHalf(Math.max(hHi > 0 ? step : 0, maxSegTotal - pLo));
    }

    layout.set(loRow.taskKey, { startSeg: 0, numSeg: pLo });
    layout.set(hiRow.taskKey, { startSeg: pLo, numSeg: pHi });
    return layout;
  }

  const totalHalfUnits = Math.max(
    rows.length,
    Math.round(maxSegTotal * 2),
  );
  const weighted = rows.map((row) => ({
    ...row,
    rawUnits: (row.totalHours / capacity) * totalHalfUnits,
  }));
  let parts = weighted.map((row) => Math.floor(row.rawUnits));
  const minUnits = weighted.map((row) => (row.totalHours > 0 ? 1 : 0));

  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] >= minUnits[i]) {
      continue;
    }
    let donor = -1;
    let donorUnits = -1;
    for (let j = 0; j < parts.length; j += 1) {
      if (j === i) {
        continue;
      }
      if (parts[j] > Math.max(minUnits[j], 0) && parts[j] > donorUnits) {
        donor = j;
        donorUnits = parts[j];
      }
    }
    if (donor >= 0) {
      parts[donor] -= 1;
      parts[i] += 1;
    }
  }

  let sumParts = parts.reduce((sum, value) => sum + value, 0);
  let need = totalHalfUnits - sumParts;
  const order = weighted
    .map((row, index) => ({ index, frac: row.rawUnits - Math.floor(row.rawUnits) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < need; k += 1) {
    parts[order[k % order.length].index] += 1;
  }

  sumParts = parts.reduce((sum, value) => sum + value, 0);
  while (sumParts > totalHalfUnits) {
    let donor = -1;
    let best = -1;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] > minUnits[i] && parts[i] > best) {
        best = parts[i];
        donor = i;
      }
    }
    if (donor < 0) {
      break;
    }
    parts[donor] -= 1;
    sumParts -= 1;
  }
  while (sumParts < totalHalfUnits) {
    let receiver = 0;
    let least = Infinity;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] < least) {
        least = parts[i];
        receiver = i;
      }
    }
    parts[receiver] += 1;
    sumParts += 1;
  }

  let startSeg = 0;
  rows.forEach((row, index) => {
    const numSeg = Math.max(0, (parts[index] || 0) / 2);
    layout.set(row.taskKey, { startSeg, numSeg });
    startSeg += numSeg;
  });

  return layout;
}

/**
 * Size each task's bands as (taskHours / dayCapacity) × 4 partitions (0.5-band steps).
 * When several tasks share a day, total width can be less than four bands if planned hours are below AVA.
 */
/** Size bars when day AVA is missing — use default work-day hours, not assigned hours. */
function layoutDayCapacity(dayCapacity) {
  if (typeof dayCapacity === 'number' && dayCapacity > 0) {
    return dayCapacity;
  }
  return HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
}

function collisionDayBandLayoutFromAva(hoursPerTask, dayCapacity) {
  if (HISTOGRAM_FIXED_DAY_PARTITIONS) {
    return collisionDayBandLayoutFixed(hoursPerTask, dayCapacity);
  }

  const totalHours = hoursPerTask.reduce(
    (sum, row) => sum + Math.max(0, Number(row.totalHours) || 0),
    0,
  );
  const capacity = layoutDayCapacity(dayCapacity);
  const partitions = HISTOGRAM_DAY_PARTITIONS;
  const step = 0.5;

  const rows = hoursPerTask
    .map((row) => ({
      taskKey: row.taskKey,
      totalHours: Math.max(0, Number(row.totalHours) || 0),
    }))
    .filter((row) => row.totalHours > 0);

  const layout = new Map();
  if (rows.length === 0) {
    return layout;
  }

  if (rows.length === 1) {
    layout.set(rows[0].taskKey, soloDayBandLayout(rows[0].totalHours, capacity));
    return layout;
  }

  const sized = rows.map((row) => ({
    taskKey: row.taskKey,
    totalHours: row.totalHours,
    numSeg: Math.max(step, roundToHalf((row.totalHours / capacity) * partitions)),
  }));

  let totalSeg = sized.reduce((sum, row) => sum + row.numSeg, 0);
  if (totalSeg > partitions) {
    sized.forEach((row) => {
      row.numSeg = Math.max(step, roundToHalf((row.numSeg / totalSeg) * partitions));
    });
    totalSeg = sized.reduce((sum, row) => sum + row.numSeg, 0);
    const remainder = roundToHalf(partitions - totalSeg);
    if (Math.abs(remainder) > 0.001) {
      const target = sized.reduce((best, row) => (
        row.totalHours > best.totalHours ? row : best
      ));
      target.numSeg = roundToHalf(Math.max(step, target.numSeg + remainder));
    }
  }

  let startSeg = 0;
  sized.forEach((row) => {
    layout.set(row.taskKey, { startSeg, numSeg: row.numSeg });
    startSeg += row.numSeg;
  });

  return layout;
}

/** Single-task day width from assigned hours vs day capacity (proportional bands). */
function soloDayBandLayout(hoursOnDay, dayCapacity) {
  const hours = Math.max(0, Number(hoursOnDay) || 0);

  if (hours <= 0) {
    return { startSeg: 0, numSeg: 1 };
  }

  const capacity = layoutDayCapacity(dayCapacity);
  // Snap to whole quarter bands (1–4) so resize matches the day-split grid.
  const numSeg = Math.max(
    1,
    Math.min(
      HISTOGRAM_DAY_PARTITIONS,
      Math.round((hours / capacity) * HISTOGRAM_DAY_PARTITIONS) || 1,
    ),
  );

  return { startSeg: 0, numSeg };
}

function repackTaskSegmentsByDayContinuity(rowBars, centerDay, segmentLayout, contextualHoursByTask) {
  const { prev, next } = adjacentCalendarDayStrings(centerDay);
  const entries = [];

  segmentLayout.forEach((value, taskKey) => {
    const contextualHours = contextualHoursByTask.get(taskKey) ?? 0;
    const hasNext = next ? sumBarHoursOnDay(rowBars, next, taskKey) > 0 : false;
    const hasPrev = prev ? sumBarHoursOnDay(rowBars, prev, taskKey) > 0 : false;
    const { prevGap, nextGap } = nearestOffsetsForBar(rowBars, centerDay, taskKey);
    const sidePref = continuitySidePreference(prevGap, nextGap);
    entries.push({
      taskKey,
      numSeg: value.numSeg,
      hasNext,
      hasPrev,
      contextualHours,
      prevGap,
      nextGap,
      sidePref,
    });
  });

  entries.sort((a, b) => {
    if (a.sidePref !== b.sidePref) {
      return a.sidePref - b.sidePref;
    }
    const minA = Math.min(a.prevGap ?? Infinity, a.nextGap ?? Infinity);
    const minB = Math.min(b.prevGap ?? Infinity, b.nextGap ?? Infinity);
    if (minA !== minB) {
      return minA - minB;
    }
    const nextA = a.hasNext ? 1 : 0;
    const nextB = b.hasNext ? 1 : 0;
    if (nextA !== nextB) {
      return nextA - nextB;
    }
    const prevA = a.hasPrev ? 1 : 0;
    const prevB = b.hasPrev ? 1 : 0;
    if (prevA !== prevB) {
      return prevB - prevA;
    }
    if (a.contextualHours !== b.contextualHours) {
      return a.contextualHours - b.contextualHours;
    }
    return String(a.taskKey).localeCompare(String(b.taskKey));
  });

  let startSeg = 0;
  const packed = new Map();
  entries.forEach((entry) => {
    const remaining = Math.max(0, HISTOGRAM_DAY_PARTITIONS - startSeg);
    const numSeg = Math.min(entry.numSeg, remaining);
    if (numSeg <= 0) {
      return;
    }
    packed.set(entry.taskKey, { startSeg, numSeg });
    startSeg += numSeg;
  });

  return packed;
}

export function getDayTaskSlots(rowBars, dayYmd, layoutContext = {}, options = {}) {
  const { soloFullWidth = false } = options;
  const {
    rowName,
    availabilityHours = {},
    employeeHolidays = {},
    employees = [],
  } = layoutContext;

  const grouped = new Map();
  (rowBars ?? [])
    .filter((bar) => isBarActiveOnDay(bar, dayYmd, layoutContext))
    .forEach((bar) => {
      const hours = barHoursOnDay(bar, dayYmd);
      if (hours <= 0) {
        return;
      }
      const groupKey = histogramBarGroupKey(bar);
      const entry = grouped.get(groupKey);
      if (!entry) {
        grouped.set(groupKey, { bar, hours, barIds: [bar.id] });
        return;
      }
      entry.hours += hours;
      entry.barIds.push(bar.id);
    });

  const items = [...grouped.values()]
    .sort((a, b) => String(a.bar.id).localeCompare(String(b.bar.id)));

  if (items.length === 0) {
    return new Map();
  }

  const totalHours = items.reduce((sum, item) => sum + item.hours, 0);
  const dayCapacity = rowName
    ? dayCapacityForRow(rowName, dayYmd, availabilityHours, employeeHolidays, employees)
    : null;
  const capacity = layoutDayCapacity(dayCapacity);
  const slots = new Map();

  if (items.length === 1) {
    const { bar, hours, barIds } = items[0];
    let layout = soloFullWidth
      ? { startSeg: 0, numSeg: HISTOGRAM_DAY_PARTITIONS }
      : soloDayBandLayout(hours, capacity);

    // Right-align only during an active start-edge resize preview — never after
    // whole-bar drag/reassign (solo days always start at segment 0).
    const groupKey = histogramBarGroupKey(bar);
    const isStartEdgePartial = !hasBarHoursOnEarlierWorkday(rowBars, dayYmd, groupKey);
    const forceStartEdge = shouldAlignPartialStartRight(barIds, layoutContext, options);
    if (
      !soloFullWidth
      && layout.numSeg < HISTOGRAM_DAY_PARTITIONS
      && isStartEdgePartial
      && forceStartEdge
    ) {
      layout = {
        startSeg: HISTOGRAM_DAY_PARTITIONS - layout.numSeg,
        numSeg: layout.numSeg,
      };
    }

    const slot = {
      startSeg: layout.startSeg,
      numSeg: layout.numSeg,
      hours,
      totalHours,
      taskCount: 1,
      isSolo: true,
    };
    if (!shouldAlignPartialStartRight(barIds, layoutContext, options)) {
      slot.startSeg = 0;
    }
    barIds.forEach((barId) => slots.set(barId, slot));
    return slots;
  }

  const contextualHoursByTask = new Map(
    items.map(({ bar }) => [histogramBarGroupKey(bar), contextualHoursForBar(rowBars, dayYmd, bar.id)]),
  );
  const rawLayout = collisionDayBandLayoutFromAva(
    items.map(({ bar, hours }) => ({ taskKey: histogramBarGroupKey(bar), totalHours: hours })),
    capacity,
  );
  const packedLayout = repackTaskSegmentsByDayContinuity(
    rowBars,
    dayYmd,
    rawLayout,
    contextualHoursByTask,
  );

  items.forEach(({ bar, hours, barIds }) => {
    const groupKey = histogramBarGroupKey(bar);
    const layout = packedLayout.get(groupKey) ?? { startSeg: 0, numSeg: 1 };
    const { startSeg, numSeg } = clampDaySegment(layout.startSeg, layout.numSeg);
    if (numSeg <= 0) {
      return;
    }
    const slot = {
      startSeg,
      numSeg,
      hours,
      totalHours,
      taskCount: items.length,
      isSolo: false,
    };
    barIds.forEach((barId) => slots.set(barId, slot));
  });

  return slots;
}

function barSegmentFromLayout(piece, timeline, showLabel, layoutContext = {}) {
  const span = piece.endIndex - piece.startIndex;
  const partitions = HISTOGRAM_DAY_PARTITIONS;
  let { startSeg, numSeg } = clampDaySegment(piece.startSeg, piece.numSeg);
  const endBounds = clampDaySegment(
    piece.endStartSeg ?? piece.startSeg,
    piece.endNumSeg ?? piece.numSeg,
  );

  const isSoloBand = (piece.taskCount ?? 1) === 1;
  if (isSoloBand && !layoutContext.resizeStartBarId) {
    startSeg = 0;
  }

  if (span > 1) {
    const startDayWidth = histogramColumnWidthAt(timeline, piece.startIndex);
    const lastDayIndex = piece.endIndex - 1;
    const endDayWidth = histogramColumnWidthAt(timeline, lastDayIndex);
    const startSegWidth = startDayWidth / partitions;
    const endSegWidth = endDayWidth / partitions;
    const leftPad = numSeg >= partitions ? 2 : 1;
    const endTrim = endBounds.numSeg >= partitions ? 2 : 1;
    const left = histogramColumnLeft(timeline, piece.startIndex) + startSeg * startSegWidth + leftPad;
    const endSegEnd = endBounds.startSeg + endBounds.numSeg;
    const right = histogramColumnLeft(timeline, lastDayIndex) + endSegEnd * endSegWidth - endTrim;
    const width = Math.max(HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX, right - left);

    return {
      left,
      width,
      showLabel,
      startIndex: piece.startIndex,
      endIndex: piece.endIndex,
      taskCount: piece.taskCount,
      startSeg,
      numSeg,
      endStartSeg: endBounds.startSeg,
      endNumSeg: endBounds.numSeg,
    };
  }

  const dayWidth = histogramColumnWidthAt(timeline, piece.startIndex);
  const segmentWidth = dayWidth / partitions;
  const pad = piece.taskCount === 1 && numSeg >= partitions ? 2 : piece.taskCount === 1 ? 1 : 0;
  const widthTrim = piece.taskCount === 1 ? (numSeg >= partitions ? 4 : 2) : 1;
  const left = histogramColumnLeft(timeline, piece.startIndex) + startSeg * segmentWidth + pad;
  const proportionalWidth = numSeg * segmentWidth * span - widthTrim;
  const isSoloPartialBand = piece.taskCount === 1 && numSeg < partitions;
  const width = isSoloPartialBand
    ? Math.max(2, proportionalWidth)
    : Math.max(HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX, proportionalWidth);

  return {
    left,
    width,
    showLabel,
    startIndex: piece.startIndex,
    endIndex: piece.endIndex,
    taskCount: piece.taskCount,
    startSeg,
    numSeg,
  };
}

function areAdjacentBarPieceIndices(previous, piece, dayColumns = [], layoutContext = {}) {
  if (!previous) {
    return false;
  }
  if (previous.endIndex === piece.startIndex) {
    return true;
  }
  if (previous.endIndex >= piece.startIndex || !dayColumns?.length) {
    return false;
  }

  let hasWeekendBetween = false;
  for (let index = previous.endIndex; index < piece.startIndex; index += 1) {
    const day = dayColumns[index];
    if (!day) {
      continue;
    }
    if (!isWeekend(day)) {
      return false;
    }
    hasWeekendBetween = true;
  }

  if (!hasWeekendBetween) {
    return false;
  }

  return employeeWorksOnWeekends(
    layoutContext.rowName,
    layoutContext.availabilityHours,
    layoutContext.employeeHolidays,
    layoutContext.employees,
    layoutContext.bars,
  );
}

function pushMergedBarPiece(merged, piece) {
  merged.push({
    ...piece,
    endStartSeg: piece.startSeg,
    endNumSeg: piece.numSeg,
  });
}

function extendMergedBarPiece(previous, piece) {
  previous.endIndex = piece.endIndex;
  previous.endStartSeg = piece.startSeg;
  previous.endNumSeg = piece.numSeg;
}

/**
 * Task bars align to weekday columns and the 4-part day bands.
 * Multiple tasks on one day share the day proportionally by hours.
 */
export function getBarSegmentsForRow(bar, rowBars, dayColumns, timeline, layoutContext = {}, options = {}) {
  if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object' || !dayColumns?.length) {
    return [];
  }

  const pieces = [];
  dayColumns.forEach((day, index) => {
    if (!isBarActiveOnDay(bar, day, layoutContext)) {
      return;
    }

    const slots = options.daySlotsCache?.get(day)
      ?? getDayTaskSlots(rowBars, day, layoutContext, options);
    const slot = slots.get(bar.id);
    if (!slot) {
      return;
    }

    pieces.push({
      startIndex: index,
      endIndex: index + 1,
      startSeg: slot.startSeg,
      numSeg: slot.numSeg,
      taskCount: slot.taskCount,
    });
  });

  const merged = [];
  pieces.forEach((piece) => {
    const previous = merged[merged.length - 1];
    const isAdjacent = areAdjacentBarPieceIndices(previous, piece, dayColumns, {
      ...layoutContext,
      bars: rowBars,
    });

    if (isAdjacent) {
      extendMergedBarPiece(previous, piece);
      return;
    }
    pushMergedBarPiece(merged, piece);
  });

  return merged.map((piece) => barSegmentFromLayout(piece, timeline, true, layoutContext));
}

export function getBarSegmentsForTimeline(bar, rowBars, timeline, layoutContext = {}, options = {}) {
  if (!timeline?.columns?.length) {
    return [];
  }

  return getBarSegmentsForRow(
    bar,
    rowBars,
    timelineDayColumns(timeline),
    timeline,
    layoutContext,
    options,
  );
}

/**
 * One continuous bar per contiguous weekday run (split at weekends).
 */
export function getContinuousBarSegmentsForTimeline(bar, rowBars, timeline, layoutContext = {}) {
  if (!timeline?.columns?.length) {
    return [];
  }

  const dayColumns = timelineDayColumns(timeline);

  const runs = [];
  let runStart = null;

  dayColumns.forEach((day, index) => {
    if (!isBarActiveOnDay(bar, day, layoutContext)) {
      if (runStart != null) {
        runs.push({ startIndex: runStart, endIndex: index });
        runStart = null;
      }
      return;
    }
    if (runStart == null) {
      runStart = index;
    }
  });

  if (runStart != null) {
    runs.push({ startIndex: runStart, endIndex: dayColumns.length });
  }

  return runs.map((run) => {
    const span = run.endIndex - run.startIndex;

    return {
      left: histogramColumnLeft(timeline, run.startIndex),
      width: Math.max(4, histogramSpanWidth(timeline, run.startIndex, run.endIndex)),
      showLabel: true,
      startIndex: run.startIndex,
      endIndex: run.endIndex,
      taskCount: 1,
      startSeg: 0,
      numSeg: HISTOGRAM_DAY_PARTITIONS,
    };
  });
}

/** Precompute per-day band layout once per operative row (avoids O(bars × days) slot work). */
export function buildRowDaySlotsCache(rowBars, dayColumns, layoutContext = {}, options = {}) {
  const cache = new Map();

  (dayColumns ?? []).forEach((day) => {
    if (isWeekend(day)) {
      return;
    }
    if (layoutContext.rowName && isEmployeeHolidayDay(
      layoutContext.rowName,
      day,
      layoutContext.employeeHolidays,
      layoutContext.employees,
    )) {
      return;
    }
    cache.set(day, getDayTaskSlots(rowBars, day, layoutContext, options));
  });

  return cache;
}

export function resolveBarSegmentsForTimeline(
  bar,
  rowBars,
  timeline,
  layoutContext = {},
  useDaySplitBands = false,
  daySlotsCache = null,
) {
  if (!useDaySplitBands) {
    return getContinuousBarSegmentsForTimeline(bar, rowBars, timeline, layoutContext);
  }

  return getBarSegmentsForTimeline(bar, rowBars, timeline, layoutContext, {
    soloFullWidth: false,
    daySlotsCache,
  });
}

/** @deprecated Use getBarSegmentsForRow when row bars are available. */
export function getBarSegments(bar, dayColumns, timeline) {
  return getBarSegmentsForRow(bar, [bar], dayColumns, timeline);
}

export function isBarActiveOnDay(bar, dayYmd, layoutContext = null) {
  if (!bar?.hours_by_day || !dayYmd) {
    return false;
  }

  const hours = Number(bar.hours_by_day[dayYmd]) || 0;
  if (hours <= 0.001 || isWeekend(dayYmd)) {
    return false;
  }

  if (layoutContext?.rowName && isEmployeeHolidayDay(
    layoutContext.rowName,
    dayYmd,
    layoutContext.employeeHolidays,
    layoutContext.employees,
  )) {
    return false;
  }

  return true;
}

export function rowHasBarOnDay(bars, dayYmd, layoutContext = null) {
  return (bars ?? []).some((bar) => isBarActiveOnDay(bar, dayYmd, layoutContext));
}

/** True when the operative has no task and no holiday on each of the next N calendar days from startYmd. */
export function isEmployeeFreeNextDays({
  rowName,
  bars,
  employeeHolidays = {},
  employees = [],
  days = 3,
  startYmd = null,
}) {
  const anchor = startYmd || dateToYmd(new Date());
  if (!anchor || !rowName || days < 1) {
    return false;
  }

  // Always scope to this operative — callers may pass all-project bars (e.g. project filter view).
  const employeeBars = (bars ?? []).filter((bar) => (
    employeeMatchesName({ name: rowName, first_name: rowName }, bar.employee)
    || (employees ?? []).some((employee) => (
      employeeMatchesName(employee, rowName) && employeeMatchesName(employee, bar.employee)
    ))
  ));

  for (let offset = 0; offset < days; offset += 1) {
    const day = addDays(anchor, offset);
    if (!day) {
      return false;
    }
    if (rowHasBarOnDay(employeeBars, day, {
      rowName,
      employeeHolidays,
      employees,
    })) {
      return false;
    }
    if (!isWeekend(day) && isEmployeeHolidayDay(rowName, day, employeeHolidays, employees)) {
      return false;
    }
  }

  return true;
}

export const HISTOGRAM_DEFAULT_DAY_CAPACITY_H = 8;

/** Weekday with reduced AVA (e.g. 4h) — shown as split H | hours in the day cell. */
export function isHalfWorkingDayHours(avaHours, fullDayHours = HISTOGRAM_DEFAULT_DAY_CAPACITY_H) {
  const hours = Number(avaHours);
  const full = Number(fullDayHours) || HISTOGRAM_DEFAULT_DAY_CAPACITY_H;
  if (!Number.isFinite(hours) || hours <= 0.05) {
    return false;
  }
  return hours < full - 0.05;
}

export function formatHistogramAvaLabel(hours) {
  const value = Number(hours);
  if (!Number.isFinite(value)) {
    return '';
  }
  if (Math.abs(value - Math.round(value)) < 0.05) {
    return String(Math.round(value));
  }
  return value.toFixed(1);
}

export const HISTOGRAM_READING_TOOLTIPS = {
  filledSections:
    'Colored bar width on each day shows planned hours relative to that operative\'s day capacity from User Availability (AVA). The filled band at the bottom of each day cell shows the same breakdown.',
  emptyCapacity:
    'Unused hours in a workday — the gap between total planned hours and that operative\'s AVA total for the day. Hover the light segment in a day cell for the exact amount.',
  projectAllocations:
    'When multiple projects share a day, each colored segment in the day band shows that project\'s share of planned hours. Hover a segment for hours per project.',
  docSupplyStart: 'Doc supply date — when documentation is expected for the task (start flag).',
  completionEnd: 'Completion date — when the task is scheduled to finish (end flag).',
  employeeHoliday:
    'Weekday marked as holiday in User Availability — shown as H in the day cell (even when planned hours exist in data).',
  halfWorkingDay:
    'Working half day — User Availability is under a full day (for example 4h). The cell splits as H | hours so the holiday half and remaining working hours are both visible.',
  daySplit:
    'Each weekday column is divided into four equal fixed bands (toggle Day split to show grid lines). Solo tasks span bands proportional to planned hours vs day AVA. When two or more tasks share a day they appear side by side in those bands, each sized by its hours vs day capacity (unused AVA stays empty).',
  scheduledTraining:
    'Scheduled training — black bar with a thick yellow border on the Resource Histogram (Trainings page uses session colors).',
  scheduledTrainingOverride:
    'Training override — dashed red border when training was scheduled over existing planned project hours.',
  dueSoonBorder:
    'Dashed red border — task completion date is within the next 3 days and progress is under 100%.',
  overdueBorder:
    'Solid red border — task completion date is today or past and progress is under 100%.',
  openTaskEditor:
    'Click a colored task bar to open the Task Editor panel for that task.',
  openPersonalSummary:
    'Click an operative name on the left to open Personal summary (projects, tasks, and training gap).',
  operativeFreeDot:
    'Blue dot — operative has no tasks or holidays scheduled for the next 3 calendar days.',
  dlPlanEdit:
    'Amber outline and dot — this task was last saved on the DL page. Hover for who changed it, when, and what they changed. Use Edits Log History → Plan (DL) to highlight a specific save.',
};

export function isEmployeeHolidayDay(rowName, day, employeeHolidays = {}, employees = []) {
  if (isWeekend(day) || !rowName || !day) {
    return false;
  }

  if (employeeHolidays?.[rowName]?.[day]) {
    return true;
  }

  const employee = employees.find((entry) => employeeMatchesName(entry, rowName));
  if (employee) {
    const canonical = employeeDisplayName(employee);
    if (employeeHolidays?.[canonical]?.[day]) {
      return true;
    }
  }

  return Object.entries(employeeHolidays ?? {}).some(([name, days]) => {
    if (!days?.[day]) {
      return false;
    }
    if (employee) {
      return employeeMatchesName(employee, name);
    }
    return employeeMatchesName({ name, first_name: name }, rowName);
  });
}

export function lookupDayHoursForRow(lookup, rowName, day, employees = []) {
  if (!lookup || !rowName || !day) {
    return null;
  }

  const readDay = (days) => {
    if (!days || !Object.prototype.hasOwnProperty.call(days, day)) {
      return null;
    }
    const num = Number(days[day]);
    return Number.isNaN(num) ? 0 : num;
  };

  const direct = readDay(lookup[rowName]);
  if (direct != null) {
    return direct;
  }

  const employee = employees.find((entry) => employeeMatchesName(entry, rowName));
  for (const [key, days] of Object.entries(lookup)) {
    const matches = employee
      ? employeeMatchesName(employee, key)
      : employeeMatchesName({ name: rowName, first_name: rowName }, key);
    if (!matches) {
      continue;
    }
    const value = readDay(days);
    if (value != null) {
      return value;
    }
    // Name matched but this day is absent from the map — keep searching
    // aliases. Missing days stay null so callers can use the 8h default.
  }

  return null;
}

export function dayCapacityForRow(rowName, day, availabilityHours, employeeHolidays = {}, employees = []) {
  if (isEmployeeHolidayDay(rowName, day, employeeHolidays, employees)) {
    return null;
  }

  const availability = lookupDayHoursForRow(availabilityHours, rowName, day, employees);
  if (availability == null) {
    return HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
  }

  return Math.max(0, availability);
}

export function buildFilledSectionHoverTitle({ rowName, day, booked, capacity }) {
  return `Filled section: ${booked.toFixed(1)}h planned of ${capacity.toFixed(1)}h day capacity — ${rowName}, ${dayLabel(day)}`;
}

export function buildEmptyCapacityHoverTitle({
  rowName,
  day,
  emptyCapacity,
  capacity,
  hasTasks = true,
}) {
  if (!hasTasks) {
    return `Empty capacity: ${capacity.toFixed(1)}h available (no tasks scheduled) — ${rowName}, ${dayLabel(day)}`;
  }
  return `Empty capacity: ${emptyCapacity.toFixed(1)}h still available of ${capacity.toFixed(1)}h day capacity — ${rowName}, ${dayLabel(day)}`;
}

export function buildProjectAllocationHoverTitle({
  projectName,
  hours,
  capacity,
  rowName,
  day,
  bar = null,
}) {
  const lines = [
    `Project: ${projectName}`,
    `Project allocation: ${hours.toFixed(1)}h of ${capacity.toFixed(1)}h day capacity`,
    `Assigned hours (this task/day): ${hours.toFixed(1)}h`,
    `${rowName}, ${dayLabel(day)}`,
  ];
  lines.push(...buildBarScheduleHoverLines(bar));
  return lines.filter(Boolean).join('\n');
}

function formatBarDateLabel(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = parseYmd(value);
    return parsed ? dayLabel(parsed) : String(value);
  } catch {
    return String(value);
  }
}

export function buildBarScheduleHoverLines(bar) {
  if (!bar) {
    return [];
  }

  const lines = [];
  const start = formatBarDateLabel(bar.doc_supply || bar.start);
  const end = formatBarDateLabel(bar.completion || bar.end);
  if (start) {
    lines.push(`Scheduled start: ${start}`);
  }
  if (end) {
    lines.push(`Scheduled end: ${end}`);
  }
  const assigned = Number(bar.hours);
  if (Number.isFinite(assigned) && assigned > 0) {
    lines.push(`Assigned hours (whole task): ${assigned.toFixed(1)}h`);
  }
  return lines;
}

export function buildDayCapacitySegments({
  rowName,
  day,
  bars = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
}) {
  if (isWeekend(day)) {
    return [];
  }

  if (isEmployeeHolidayDay(rowName, day, employeeHolidays, employees)) {
    return [];
  }

  const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
  const capacity = dayCapacityForRow(rowName, day, availabilityHours, employeeHolidays, employees);
  if (capacity == null) {
    return [];
  }
  const emptyCapacity = Math.max(0, capacity - booked);
  const segments = [];
  const taskHours = (bars ?? [])
    .map((bar) => ({ bar, hours: barHoursOnDay(bar, day) }))
    .filter((item) => item.hours > 0)
    .sort((a, b) => String(a.bar.id).localeCompare(String(b.bar.id)));

  const filledPercent = capacity > 0 ? Math.min(100, (booked / capacity) * 100) : 0;
  const filledTitle = booked > 0.05
    ? buildFilledSectionHoverTitle({ rowName, day, booked, capacity })
    : null;

  taskHours.forEach(({ bar, hours }) => {
    const percent = capacity > 0 ? (hours / capacity) * 100 : 0;
    if (percent <= 0.05) {
      return;
    }
    const taskName = bar.task_name || 'Untitled task';
    const projectName = bar.project_name || 'Unknown project';
    segments.push({
      kind: 'allocation',
      percent,
      color: bar.color || '#3b82f6',
      title: [
        `Project: ${projectName}`,
        `${taskName}: ${hours.toFixed(1)}h of ${capacity.toFixed(1)}h day capacity`,
        ...buildBarScheduleHoverLines(bar),
        `${rowName}, ${dayLabel(day)}`,
      ].join('\n'),
    });
  });

  if (booked > 0.05 && taskHours.length === 0) {
    segments.push({
      kind: 'filled',
      percent: filledPercent,
      color: '#3b82f6',
      title: filledTitle,
    });
  }

  if (emptyCapacity > 0.05) {
    segments.push({
      kind: 'empty',
      percent: capacity > 0 ? (emptyCapacity / capacity) * 100 : 0,
      title: buildEmptyCapacityHoverTitle({
        rowName,
        day,
        emptyCapacity,
        capacity,
        hasTasks: booked > 0.05,
      }),
    });
  }

  return segments;
}

/** Gap-only cell for training mini histogram (empty capacity vs AVA, no task bars). */
export function buildGapOnlyDayCell({
  rowName,
  day,
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
}) {
  if (isWeekend(day)) {
    return { kind: 'weekend', gapHours: 0, title: `${dayLabel(day)} — Weekend` };
  }

  if (isEmployeeHolidayDay(rowName, day, employeeHolidays, employees)) {
    return { kind: 'holiday', gapHours: 0, title: `${dayLabel(day)} — ${rowName}\nHoliday` };
  }

  const capacity = dayCapacityForRow(rowName, day, availabilityHours, employeeHolidays, employees);
  const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
  if (capacity == null) {
    return { kind: 'none', gapHours: 0, title: null };
  }

  if (capacity <= 0.05) {
    return { kind: 'holiday', gapHours: 0, title: `${dayLabel(day)} — ${rowName}\nHoliday` };
  }

  const gapHours = Math.max(0, capacity - booked);

  if (gapHours <= 0.05) {
    return {
      kind: 'full',
      gapHours: 0,
      gapPercent: 0,
      title: `${dayLabel(day)} — ${rowName}\nFully booked (${booked.toFixed(1)}h / ${capacity.toFixed(1)}h)`,
    };
  }

  return {
    kind: 'gap',
    gapHours,
    gapPercent: capacity > 0 ? (gapHours / capacity) * 100 : 0,
    title: buildEmptyCapacityHoverTitle({
      rowName,
      day,
      emptyCapacity: gapHours,
      capacity,
      hasTasks: booked > 0.05,
    }),
  };
}

export function trainingGapHoursFromCell(cell) {
  if (cell?.kind === 'gap') {
    return Number(cell.gapHours) || 0;
  }
  return 0;
}

export function isTrainingGapDayCell(cell, minHours = 0.05) {
  return trainingGapHoursFromCell(cell) > minHours;
}

export function sumEmployeeGapHoursInRange({
  rowName,
  startYmd,
  endYmd,
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
}) {
  if (!rowName || !startYmd || !endYmd) {
    return 0;
  }

  let total = 0;
  buildDayColumns(startYmd, endYmd).forEach((day) => {
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

  return Math.round(total * 10) / 10;
}

export function buildDayCellHoverTitle({
  rowName,
  day,
  bars = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
}) {
  if (isWeekend(day)) {
    return `${dayLabel(day)} — Weekend (no planned work)`;
  }

  const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
  const isHoliday = isEmployeeHolidayDay(rowName, day, employeeHolidays, employees);

  if (isHoliday && booked <= 0.05) {
    return `${dayLabel(day)} — ${rowName}\nHoliday (total and AVA total are 0)`;
  }

  const capacity = dayCapacityForRow(rowName, day, availabilityHours, employeeHolidays, employees);
  const emptyCapacity = capacity == null ? 0 : Math.max(0, capacity - booked);

  const lines = [`${dayLabel(day)} — ${rowName}`];
  const projectHours = new Map();

  (bars ?? []).forEach((bar) => {
    const hours = barHoursOnDay(bar, day);
    if (hours <= 0) {
      return;
    }
    const projectName = bar.project_name || 'Unknown project';
    projectHours.set(projectName, (projectHours.get(projectName) || 0) + hours);
  });

  if (booked > 0.05) {
    if (capacity != null) {
      lines.push(`Filled section: ${booked.toFixed(1)}h planned of ${capacity.toFixed(1)}h day capacity`);
    } else {
      lines.push(`Filled section: ${booked.toFixed(1)}h planned`);
    }
    if (projectHours.size > 0) {
      lines.push('Project allocations:');
      [...projectHours.entries()]
        .sort((a, b) => b[1] - a[1])
        .forEach(([projectName, hours]) => {
          lines.push(`  • ${projectName}: ${hours.toFixed(1)}h`);
        });
    }
    if (emptyCapacity > 0.05) {
      lines.push(`Empty capacity: ${emptyCapacity.toFixed(1)}h still available`);
    } else if (capacity != null && booked > capacity + 0.05) {
      lines.push(`Over capacity by ${(booked - capacity).toFixed(1)}h`);
    }
  } else if (capacity != null) {
    lines.push(`Empty capacity: ${capacity.toFixed(1)}h available (no tasks scheduled)`);
  }

  return lines.join('\n');
}

export function totalBarAssignedHours(bar) {
  if (Number.isFinite(Number(bar?.hours)) && Number(bar.hours) > 0) {
    return Number(bar.hours);
  }

  if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
    return 0;
  }

  return Object.values(bar.hours_by_day)
    .reduce((sum, hours) => sum + (Number(hours) || 0), 0);
}

function isBarProgressComplete(bar) {
  return parseBarProgressPercent(bar) >= 100;
}

/** Task completion % for histogram bar overlays (0–100). */
export function parseBarProgressPercent(bar) {
  return parseTaskProgressPercent(bar);
}

/** Progress fill width in px for one segment of a task bar (fills left-to-right across all segments). */
export function resolveBarSegmentProgressOverlayWidthPx(
  bar,
  segmentWidthPx,
  segmentOffsetPx = 0,
  totalScheduledWidthPx = segmentWidthPx,
) {
  const progressPercent = parseBarProgressPercent(bar);
  const segmentWidth = Number(segmentWidthPx) || 0;
  const totalWidth = Number(totalScheduledWidthPx) || segmentWidth;
  const offset = Number(segmentOffsetPx) || 0;

  if (progressPercent <= 0 || segmentWidth <= 0 || totalWidth <= 0) {
    return 0;
  }

  const totalProgressWidth = (progressPercent / 100) * totalWidth;
  if (offset >= totalProgressWidth) {
    return 0;
  }

  return Math.min(segmentWidth, totalProgressWidth - offset);
}

/** @deprecated Use buildBarSegmentProgressOverlayWidths for multi-segment bars. */
export function resolveBarProgressOverlayWidthPx(bar, segmentWidthPx) {
  return resolveBarSegmentProgressOverlayWidthPx(bar, segmentWidthPx, 0, segmentWidthPx);
}

export function buildBarSegmentProgressOverlayWidths(bar, segments = []) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  const totalScheduledWidth = segments.reduce(
    (sum, segment) => sum + (Number(segment?.width) || 0),
    0,
  );
  let offset = 0;

  return segments.map((segment) => {
    const width = resolveBarSegmentProgressOverlayWidthPx(
      bar,
      segment.width,
      offset,
      totalScheduledWidth,
    );
    offset += Number(segment?.width) || 0;
    return width;
  });
}

/** Match old WP histogram:
 * - overdue (solid red): completion date is today or past, and progress < 100%
 * - approaching (dashed red): completion within the next 3 days, and progress < 100%
 */
export function resolveBarCompletionBorderState(bar, todayYmd = dateToYmd(new Date())) {
  if (!bar || isBarProgressComplete(bar)) {
    return null;
  }

  // Task completion date only (not the assignment span end).
  const completion = parseYmd(bar.completion);
  if (!completion) {
    return null;
  }

  const today = parseYmd(todayYmd) || dateToYmd(new Date());
  const daysUntilCompletion = calendarDayDiff(today, completion);
  if (daysUntilCompletion == null) {
    return null;
  }

  if (daysUntilCompletion <= 0) {
    return 'overdue';
  }

  if (daysUntilCompletion <= 3) {
    return 'approaching';
  }

  return null;
}

export function resolveHoveredDayFromBarPointer(event, segment, dayColumns = []) {
  if (!event?.currentTarget || !segment || !dayColumns.length) {
    return null;
  }

  const startIndex = segment.startIndex ?? 0;
  const endIndex = segment.endIndex ?? dayColumns.length;
  const span = Math.max(1, endIndex - startIndex);
  const barRect = event.currentTarget.getBoundingClientRect();
  const relativeX = event.clientX - barRect.left;
  const ratio = barRect.width > 0 ? relativeX / barRect.width : 0;
  const offset = Math.min(span - 1, Math.max(0, Math.floor(ratio * span)));
  return dayColumns[startIndex + offset] ?? dayColumns[startIndex] ?? null;
}

export function buildBarHoverTitle(bar) {
  const projectName = bar?.project_name || 'Unknown project';
  const taskName = bar?.task_name || 'Untitled task';
  const lines = [
    `Project: ${projectName}`,
    `Task: ${taskName}`,
  ];

  const totalHours = totalBarAssignedHours(bar);
  if (totalHours > 0) {
    lines.push(`Assigned hours (whole task): ${totalHours.toFixed(1)}h`);
  }

  lines.push('Hover a day on the bar to see hours planned for that day.');

  return lines.join('\n');
}

export function buildBarSegmentHoverTitle({
  bar,
  segment,
  dayColumns = [],
  hoveredDay = null,
}) {
  const projectName = bar?.project_name || 'Unknown project';
  const taskName = bar?.task_name || 'Untitled task';
  const lines = [
    `Project: ${projectName}`,
    `Task: ${taskName}`,
  ];

  const day = hoveredDay
    ?? dayColumns[segment?.startIndex ?? 0]
    ?? null;
  const dayHours = day ? barHoursOnDay(bar, day) : 0;

  if (day && dayHours > 0.001) {
    lines.push(`Hours on ${dayLabel(day)}: ${dayHours.toFixed(1)}h`);
  } else if (day) {
    lines.push(`Hours on ${dayLabel(day)}: none planned`);
  }

  const totalHours = totalBarAssignedHours(bar);
  if (totalHours > 0.001) {
    lines.push(`Assigned hours (whole task): ${totalHours.toFixed(1)}h`);
  }

  return lines.join('\n');
}

export function extractNrmNumberFromTaskName(taskName) {
  const match = String(taskName || '').trim().match(/^(\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

export function groupBarsByEmployee(bars, employees) {
  return buildHistogramRows(bars, employees).map(({ name, bars: employeeBars }) => ({
    name,
    bars: employeeBars,
  }));
}

/** Index bars by employee id (or display name) in one pass — avoids O(rows × bars) scans. */
export function buildEmployeeBarIndex(bars, employees) {
  const index = new Map();
  const nameLookup = buildEmployeeNameKeyMap(employees);

  (bars ?? []).forEach((bar) => {
    const assignee = String(bar.employee || '').trim() || 'Unassigned';
    const key = nameLookup.get(employeeNameKey(assignee)) ?? assignee;

    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push(bar);
  });

  return index;
}

function collectBarsForEmployee(employee, bars, barIndex) {
  if (barIndex) {
    const key = String(employee.id ?? employeeDisplayName(employee));
    return barIndex.get(key) ?? [];
  }

  return (bars ?? []).filter((bar) => employeeMatchesName(employee, bar.employee));
}

function lookupHasDataForEmployee(lookup, employee) {
  return Object.entries(lookup ?? {}).some(([key, days]) => {
    if (!employeeMatchesName(employee, key)) {
      return false;
    }

    return Object.values(days ?? {}).some((hours) => Number(hours) > 0);
  });
}

function lookupHasHolidayForEmployee(employeeHolidays, employee) {
  return Object.entries(employeeHolidays ?? {}).some(([key, days]) => {
    if (!employeeMatchesName(employee, key)) {
      return false;
    }

    return Boolean(days) && Object.keys(days).length > 0;
  });
}

function lookupHasHolidayForName(employeeHolidays, name) {
  const days = employeeHolidays?.[name];
  return Boolean(days) && Object.keys(days).length > 0;
}

function lookupHasDataForName(lookup, name) {
  const days = lookup?.[name];
  return Boolean(days) && Object.values(days).some((hours) => Number(hours) > 0);
}

function sortHistogramRowsLikeOap(rows = [], employees = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows;
  }

  const rank = new Map(
    sortEmployeesByTeamThenName(normalizeList(employees)).map((employee, index) => [
      employeeDisplayName(employee),
      index,
    ]),
  );

  return [...rows].sort((left, right) => {
    const rankA = rank.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rank.get(right.name) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    return String(left.name).localeCompare(String(right.name));
  });
}

function isBarMatchedToRoster(bar, employees) {
  return (employees ?? []).some((employee) => employeeMatchesName(employee, bar.employee));
}

export function barScheduledWeekdays(bar) {
  if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
    return [];
  }

  return Object.entries(bar.hours_by_day)
    .filter(([day, hours]) => (Number(hours) || 0) > 0.05 && !isWeekend(day))
    .map(([day]) => day)
    .sort();
}

export function formatHistogramCapacityDayLine({
  assigned = 0,
  booked = 0,
  capacity = null,
  isHoliday = false,
} = {}) {
  if (isHoliday) {
    return ' — holiday (no capacity)';
  }

  if (capacity == null) {
    return ` — ${assigned.toFixed(1)}h assigned`;
  }

  const unassigned = Math.max(0, capacity - booked);
  const overBy = booked > capacity + 0.05 ? booked - capacity : 0;
  let text = ` — ${assigned.toFixed(1)}h assigned`;

  if (Math.abs(booked - assigned) > 0.05) {
    text += ` · ${booked.toFixed(1)}h total booked`;
  }

  if (overBy > 0.05) {
    text += ` · ${capacity.toFixed(1)}h AVA · over by ${overBy.toFixed(1)}h`;
  } else {
    text += ` · ${unassigned.toFixed(1)}h unassigned of ${capacity.toFixed(1)}h AVA`;
  }

  return text;
}

export function buildDailyHoursFromBars(bars) {
  const dailyHours = {};

  (bars ?? []).forEach((bar) => {
    const employee = bar.employee || 'Unassigned';

    if (!bar.hours_by_day || typeof bar.hours_by_day !== 'object') {
      return;
    }

    Object.entries(bar.hours_by_day).forEach(([day, hours]) => {
      const value = Number(hours) || 0;
      if (value <= 0) {
        return;
      }
      if (!dailyHours[employee]) {
        dailyHours[employee] = {};
      }
      dailyHours[employee][day] = (dailyHours[employee][day] ?? 0) + value;
    });
  });

  return dailyHours;
}

/** Clip histogram bars to a visible date window (matches backend filterBarsByDateRange). */
export function filterBarsByDateRange(bars, startYmd, endYmd) {
  if (!startYmd || !endYmd) {
    return normalizeList(bars);
  }

  const filtered = [];

  normalizeList(bars).forEach((bar) => {
    if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
      return;
    }

    const days = Object.keys(bar.hours_by_day).filter((day) => (Number(bar.hours_by_day[day]) || 0) > 0.001).sort();
    if (days.length === 0) {
      return;
    }

    const barStart = days[0];
    const barEnd = days[days.length - 1];
    if (!barStart || barEnd < startYmd || barStart > endYmd) {
      return;
    }

    const clipped = {
      ...bar,
      start: barStart > startYmd ? barStart : startYmd,
      end: barEnd < endYmd ? barEnd : endYmd,
    };

    const hoursByDay = {};
    let totalHours = 0;

    Object.entries(clipped.hours_by_day).forEach(([day, hours]) => {
      if (day >= clipped.start && day <= clipped.end) {
        hoursByDay[day] = hours;
        totalHours += Number(hours) || 0;
      }
    });

    clipped.hours_by_day = hoursByDay;
    clipped.hours = Math.round(totalHours * 10000) / 10000;
    if (clipped.hours <= 0) {
      return;
    }

    filtered.push(clipped);
  });

  return filtered;
}

/** Keep only day keys inside [startYmd, endYmd] for nested employee → day → hours maps. */
export function clipEmployeeDayMapToRange(dayMap, startYmd, endYmd) {
  if (!startYmd || !endYmd) {
    return dayMap ?? {};
  }

  const clipped = {};

  Object.entries(dayMap ?? {}).forEach(([employee, byDay]) => {
    const nextDays = {};
    Object.entries(byDay ?? {}).forEach(([day, value]) => {
      if (day >= startYmd && day <= endYmd) {
        nextDays[day] = value;
      }
    });
    if (Object.keys(nextDays).length > 0) {
      clipped[employee] = nextDays;
    }
  });

  return clipped;
}

/** Intersect a requested view range with loaded histogram data bounds. */
export function intersectHistogramRange(viewRange, dataRange) {
  if (!viewRange?.start || !viewRange?.end) {
    return null;
  }

  if (!dataRange?.start || !dataRange?.end) {
    return clampHistogramDateRange(viewRange.start, viewRange.end);
  }

  const start = viewRange.start < dataRange.start ? dataRange.start : viewRange.start;
  const end = viewRange.end > dataRange.end ? dataRange.end : viewRange.end;

  if (start > end) {
    return null;
  }

  return clampHistogramDateRange(start, end);
}

export function barHasAssignee(bar) {
  const employee = String(bar?.employee ?? '').trim();
  return employee !== '' && employee !== 'Unassigned';
}

export function barHasAlgorithmAssignment(bar) {
  return ['algorithm_1', 'algorithm_2', 'algorithm_3'].some(
    (field) => String(bar?.[field] ?? '').trim() !== '',
  );
}

export function barHasLiteralHours(bar) {
  if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
    return false;
  }

  return Object.values(bar.hours_by_day).some((hours) => (Number(hours) || 0) > 0.001);
}

export function filterBarsWithAssignees(bars) {
  return (bars ?? []).filter(barHasAssignee);
}

export function filterLiteralHistogramBars(bars) {
  return filterBarsWithAssignees(bars).filter(barHasLiteralHours);
}

export function buildHistogramProjectLookup(projects = []) {
  return new Map(normalizeList(projects).map((project) => [String(project.id), project]));
}

export function isHistogramProjectCompleted(project) {
  if (!project) {
    return false;
  }

  return getProjectEffectiveStatus(project) === 'completed';
}

/** Completed projects stay visible for this many days after their latest scheduled bar end. */
export const HISTOGRAM_RECENTLY_COMPLETED_DAYS = 30;

/** Latest day with booked hours for a project (ignores PDE completion targets). */
export function getProjectLatestScheduleEndYmd(projectId, bars = []) {
  const id = String(projectId ?? '');
  if (!id) {
    return null;
  }

  let latest = null;

  (bars ?? []).forEach((bar) => {
    if (String(bar?.project_id) !== id) {
      return;
    }

    const hoursByDay = bar?.hours_by_day;
    if (hoursByDay && typeof hoursByDay === 'object') {
      Object.entries(hoursByDay).forEach(([day, hours]) => {
        if (!(Number(hours) > 0.001)) {
          return;
        }
        const ymd = parseYmd(day);
        if (ymd && (!latest || ymd > latest)) {
          latest = ymd;
        }
      });
      return;
    }

    [bar.end, bar.start].forEach((value) => {
      const ymd = parseYmd(value);
      if (ymd && (!latest || ymd > latest)) {
        latest = ymd;
      }
    });
  });

  return latest;
}

export function isProjectCompletedWithinRecentWindow(
  projectId,
  bars = [],
  recentDays = HISTOGRAM_RECENTLY_COMPLETED_DAYS,
) {
  const latestEnd = getProjectLatestScheduleEndYmd(projectId, bars);
  if (!latestEnd) {
    return false;
  }

  const cutoff = addDays(dateToYmd(new Date()), -recentDays);
  return latestEnd >= cutoff;
}

function isHistogramProjectCompletedForFilter(project, bars, projectId, projectLookup = null) {
  const resolved = project ?? projectLookup?.get?.(String(projectId ?? ''));
  if (resolved) {
    return isHistogramProjectCompleted(resolved);
  }

  const id = String(projectId ?? '');
  const projectBars = (bars ?? []).filter((bar) => String(bar?.project_id) === id);
  if (projectBars.length === 0) {
    return false;
  }

  if (projectBars.some((bar) => bar.project_status === 'completed')) {
    return true;
  }

  // If we can't resolve the project-level status, be conservative:
  // do NOT treat "all visible tasks are done" as "whole project is done".
  // This prevents hiding done task bars just because they happen to be the
  // only tasks inside the current visible date window.
  return false;
}

/**
 * When hideCompletedProjects is true, every completed project is hidden.
 * Returns null when the completed filter is off (show all completed).
 */
export function buildHiddenCompletedProjectIdSet(
  projects = [],
  bars = [],
  hideCompletedProjects = true,
) {
  if (!hideCompletedProjects) {
    return null;
  }

  const projectLookup = buildHistogramProjectLookup(projects);
  const projectIds = new Set();

  normalizeList(projects).forEach((project) => {
    if (project?.id != null) {
      projectIds.add(String(project.id));
    }
  });

  (bars ?? []).forEach((bar) => {
    if (bar?.project_id != null) {
      projectIds.add(String(bar.project_id));
    }
  });

  const hidden = new Set();

  projectIds.forEach((projectId) => {
    const project = projectLookup.get(projectId);
    if (isHistogramProjectCompletedForFilter(project, bars, projectId, projectLookup)) {
      hidden.add(projectId);
    }
  });

  return hidden;
}

export function isHistogramBarHiddenByCompletedFilter(bar, hiddenCompletedProjectIds) {
  if (!hiddenCompletedProjectIds || !bar?.project_id) {
    return false;
  }

  return hiddenCompletedProjectIds.has(String(bar.project_id));
}

export function projectHasAllDocs(project) {
  if (!project) {
    return true;
  }

  // Histogram display flag only — does not affect algorithm scheduling.
  const value = project.have_all_docs;
  if (value === false || value === 0 || value === '0') {
    return false;
  }

  return true;
}

export function isHistogramBarFromCompletedProject(bar, projectLookup = null) {
  const project = projectLookup?.get?.(String(bar?.project_id));
  if (project) {
    return isHistogramProjectCompleted(project);
  }

  return bar?.project_status === 'completed';
}

export function filterHistogramBarsByCompletedVisibility(
  bars,
  projects,
  hideCompletedProjects,
  completionReferenceBars = null,
) {
  const hiddenProjectIds = buildHiddenCompletedProjectIdSet(
    projects,
    completionReferenceBars ?? bars,
    hideCompletedProjects,
  );

  if (!hiddenProjectIds) {
    return bars ?? [];
  }

  return (bars ?? []).filter((bar) => !isHistogramBarHiddenByCompletedFilter(bar, hiddenProjectIds));
}

export function isHistogramBarMissingAllDocs(bar, projectLookup = null) {
  const project = projectLookup?.get?.(String(bar?.project_id));
  return !projectHasAllDocs(project);
}

/** Display-only: hide bars when the project is flagged as missing documentation. */
export function filterHistogramBarsByAllDocsVisibility(bars, projects, hideMissingAllDocs) {
  if (!hideMissingAllDocs) {
    return bars ?? [];
  }

  const projectLookup = buildHistogramProjectLookup(projects);
  return (bars ?? []).filter((bar) => !isHistogramBarMissingAllDocs(bar, projectLookup));
}

/** Display-only filters for the histogram chart. Never mutates or removes algorithm allocation data. */
export function filterHistogramBarsForDisplay(bars, projects, {
  hideCompletedProjects = true,
  hideMissingAllDocs = true,
  completionReferenceBars = null,
} = {}) {
  let next = bars ?? [];
  next = filterHistogramBarsByCompletedVisibility(
    next,
    projects,
    hideCompletedProjects,
    completionReferenceBars,
  );
  next = filterHistogramBarsByAllDocsVisibility(next, projects, hideMissingAllDocs);
  return next;
}

export function normalizeList(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  // A single record encoded as an object must not be flattened via Object.values.
  if (
    Object.prototype.hasOwnProperty.call(value, 'id')
    || Object.prototype.hasOwnProperty.call(value, 'has_oap')
    || Object.prototype.hasOwnProperty.call(value, 'hours_by_day')
  ) {
    return [value];
  }

  return Object.values(value).filter((item) => item && typeof item === 'object');
}

function appendOrphanHistogramRows({
  rows,
  knownNames,
  barList,
  employeeList,
  dailyHours,
  availabilityHours,
  employeeHolidays = {},
  onlyWithData,
}) {
  const orphanNames = new Set(
    barList
      .filter((bar) => !isBarMatchedToRoster(bar, employeeList))
      .map((bar) => bar.employee || 'Unassigned'),
  );

  [...orphanNames]
    .sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return a.localeCompare(b);
    })
    .forEach((name) => {
      const employeeBars = barList.filter((bar) => (bar.employee || 'Unassigned') === name);
      const hasData =
        employeeBars.length > 0
        || lookupHasDataForName(dailyHours, name)
        || lookupHasDataForName(availabilityHours, name)
        || lookupHasHolidayForName(employeeHolidays, name);

      if ((onlyWithData && !hasData) || knownNames.has(name)) {
        return;
      }

      rows.push({
        employeeId: null,
        name,
        team: null,
        bars: employeeBars,
        hasData,
      });
      knownNames.add(name);
    });

  if (!onlyWithData) {
    return;
  }

  [dailyHours, availabilityHours].forEach((lookup) => {
    Object.keys(lookup ?? {}).forEach((name) => {
      if (knownNames.has(name)) {
        return;
      }

      const matchesEmployee = employeeList.some((employee) => employeeMatchesName(employee, name));
      if (matchesEmployee) {
        return;
      }

      if (!lookupHasDataForName(lookup, name)) {
        return;
      }

      rows.push({
        employeeId: null,
        name,
        team: null,
        bars: [],
        hasData: true,
      });
      knownNames.add(name);
    });
  });

  Object.keys(employeeHolidays ?? {}).forEach((name) => {
    if (knownNames.has(name)) {
      return;
    }

    const matchesEmployee = employeeList.some((employee) => employeeMatchesName(employee, name));
    if (matchesEmployee) {
      return;
    }

    if (!lookupHasHolidayForName(employeeHolidays, name)) {
      return;
    }

    rows.push({
      employeeId: null,
      name,
      team: null,
      bars: [],
      hasData: true,
    });
    knownNames.add(name);
  });
}

export function isHistogramOapValue(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return false;
  }
  return trimmed !== 'Chk';
}

export function employeeHasAnyOap(employee) {
  if (!employee || typeof employee !== 'object') {
    return false;
  }

  const flag = employee.has_oap;
  if (flag === true || flag === 1 || flag === '1') {
    return true;
  }
  if (flag === false || flag === 0 || flag === '0') {
    return false;
  }

  return (employee.nrms ?? []).some(
    (nrm) => isHistogramOapValue(nrm?.pivot?.OAP),
  );
}

export function buildHistogramTeamGroups({
  employees = [],
  bars = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  onlyWithData = false,
  requireOap = true,
}) {
  const barList = bars ?? [];
  const employeeList = sortEmployeesByTeamThenName(normalizeList(employees));
  const barIndex = buildEmployeeBarIndex(barList, employeeList);
  const rows = [];
  const knownNames = new Set();

  employeeList.forEach((employee) => {
    if (requireOap && !employeeHasAnyOap(employee)) {
      return;
    }

    const name = employeeDisplayName(employee);
    const employeeBars = collectBarsForEmployee(employee, barList, barIndex);
    const hasOap = employeeHasAnyOap(employee);
    const hasData =
      employeeBars.length > 0
      || lookupHasDataForEmployee(dailyHours, employee)
      || lookupHasDataForEmployee(availabilityHours, employee)
      || lookupHasHolidayForEmployee(employeeHolidays, employee);

    if (onlyWithData && !hasData && !hasOap) {
      return;
    }

    rows.push({
      employeeId: employee.id,
      name,
      team: employeeTeamName(employee) || null,
      bars: employeeBars,
      hasData,
    });
    knownNames.add(name);
  });

  appendOrphanHistogramRows({
    rows,
    knownNames,
    barList,
    employeeList,
    dailyHours,
    availabilityHours,
    employeeHolidays,
    onlyWithData,
  });

  const groupMap = new Map();
  rows.forEach((row) => {
    const teamName = row.team || 'No Team';
    if (!groupMap.has(teamName)) {
      groupMap.set(teamName, []);
    }
    groupMap.get(teamName).push(row);
  });

  return [...groupMap.keys()]
    .sort(compareTeamNames)
    .map((teamName) => ({
      teamName,
      rows: sortHistogramRowsLikeOap(groupMap.get(teamName), employeeList),
    }))
    .filter((group) => group.rows.length > 0);
}

export function buildHistogramRows(bars, employees, dailyHours = {}, availabilityHours = {}) {
  const barList = bars ?? [];
  const employeeList = normalizeList(employees);
  const barIndex = buildEmployeeBarIndex(barList, employeeList);
  const rows = [];
  const knownNames = new Set();

  sortEmployeesByTeamThenName(employeeList).forEach((employee) => {
    const name = employeeDisplayName(employee);
    const employeeBars = collectBarsForEmployee(employee, barList, barIndex);
    const hasData =
      employeeBars.length > 0
      || lookupHasDataForEmployee(dailyHours, employee)
      || lookupHasDataForEmployee(availabilityHours, employee);

    if (!hasData) {
      return;
    }

    rows.push({
      employeeId: employee.id,
      name,
      team: employeeTeamName(employee) || null,
      bars: employeeBars,
    });
    knownNames.add(name);
  });

  const orphanNames = new Set(
    barList
      .filter((bar) => !isBarMatchedToRoster(bar, employeeList))
      .map((bar) => bar.employee || 'Unassigned'),
  );

  [...orphanNames]
    .sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return a.localeCompare(b);
    })
    .forEach((name) => {
      const employeeBars = barList.filter((bar) => (bar.employee || 'Unassigned') === name);
      const hasData =
        employeeBars.length > 0
        || lookupHasDataForName(dailyHours, name)
        || lookupHasDataForName(availabilityHours, name);

      if (!hasData || knownNames.has(name)) {
        return;
      }

      rows.push({
        employeeId: null,
        name,
        team: null,
        bars: employeeBars,
      });
      knownNames.add(name);
    });

  [dailyHours, availabilityHours].forEach((lookup) => {
    Object.keys(lookup ?? {}).forEach((name) => {
      if (knownNames.has(name)) {
        return;
      }

      const matchesEmployee = employeeList.some((employee) => employeeMatchesName(employee, name));
      if (matchesEmployee) {
        return;
      }

      if (!lookupHasDataForName(lookup, name)) {
        return;
      }

      rows.push({
        employeeId: null,
        name,
        team: null,
        bars: [],
      });
      knownNames.add(name);
    });
  });

  return rows;
}

function formatHistogramBandLabel(startSeg, numSeg) {
  const start = Number(startSeg) || 0;
  const num = Number(numSeg) || 0;
  if (num <= 0) {
    return '—';
  }

  const startBand = Math.floor(start) + 1;
  const endBand = Math.min(HISTOGRAM_DAY_PARTITIONS, Math.ceil(start + num));
  if (startBand === endBand) {
    return `band ${startBand}`;
  }

  return `bands ${startBand}–${endBand}`;
}

/**
 * Collision days: same operative has 2+ task bars with planned hours on one weekday.
 */
export function buildHistogramCollisionReport({
  bars = [],
  employees = [],
  startYmd,
  endYmd,
  availabilityHours = {},
  employeeHolidays = {},
}) {
  if (!startYmd || !endYmd) {
    return {
      collisionDays: [],
      tasksByBar: [],
      summary: { dayCount: 0, taskCount: 0, operativeCount: 0 },
    };
  }

  const rows = buildHistogramRows(bars, employees);
  const dayColumns = buildDayColumns(startYmd, endYmd).filter((day) => !isWeekend(day));
  const collisionDays = [];
  const tasksByBarMap = new Map();

  rows.forEach((row) => {
    const layoutContext = {
      rowName: row.name,
      availabilityHours,
      employeeHolidays,
      employees,
    };

    dayColumns.forEach((day) => {
      const tasksOnDay = row.bars
        .map((bar) => ({ bar, hours: barHoursOnDay(bar, day) }))
        .filter((entry) => entry.hours > 0.001)
        .sort((a, b) => b.hours - a.hours);

      if (tasksOnDay.length < 2) {
        return;
      }

      const slots = getDayTaskSlots(row.bars, day, layoutContext);
      const totalHours = tasksOnDay.reduce((sum, entry) => sum + entry.hours, 0);
      const capacity = dayCapacityForRow(
        row.name,
        day,
        availabilityHours,
        employeeHolidays,
        employees,
      );
      const dayAvaHours = capacity == null
        ? null
        : Math.round(capacity * 10) / 10;

      const tasks = tasksOnDay.map(({ bar, hours }) => {
        const slot = slots.get(bar.id);
        const hoursOnDay = Math.round(hours * 10) / 10;
        const taskEntry = {
          barId: bar.id,
          taskId: bar.task_id,
          taskName: getBarLabel(bar),
          projectName: bar.project_name || 'Unknown project',
          partName: bar.part_name || '',
          color: bar.color,
          nrmNumber: bar.nrm_number || extractNrmNumberFromTaskName(bar.task_name),
          hoursOnDay,
          sharePercent: dayAvaHours > 0
            ? Math.round((hours / dayAvaHours) * 100)
            : (totalHours > 0 ? Math.round((hours / totalHours) * 100) : 0),
          startSeg: slot?.startSeg ?? 0,
          numSeg: slot?.numSeg ?? 0,
          bandLabel: formatHistogramBandLabel(slot?.startSeg, slot?.numSeg),
        };

        if (!tasksByBarMap.has(bar.id)) {
          tasksByBarMap.set(bar.id, {
            barId: bar.id,
            taskId: bar.task_id,
            taskName: taskEntry.taskName,
            projectName: taskEntry.projectName,
            partName: taskEntry.partName,
            color: bar.color,
            nrmNumber: taskEntry.nrmNumber,
            employee: row.name,
            team: row.team,
            collisionDays: [],
          });
        }

        tasksByBarMap.get(bar.id).collisionDays.push({
          day,
          dayLabel: dayLabel(day),
          hoursOnDay,
          startSeg: taskEntry.startSeg,
          numSeg: taskEntry.numSeg,
          bandLabel: taskEntry.bandLabel,
          sharedWith: tasksOnDay.length,
          dayAvaHours,
          dayBookedHours: Math.round(totalHours * 10) / 10,
        });

        return taskEntry;
      });

      collisionDays.push({
        key: `${row.name}|${day}`,
        employee: row.name,
        team: row.team,
        day,
        dayLabel: dayLabel(day),
        dayAvaHours,
        dayBookedHours: Math.round(totalHours * 10) / 10,
        taskCount: tasks.length,
        tasks,
      });
    });
  });

  collisionDays.sort((a, b) => a.day.localeCompare(b.day) || a.employee.localeCompare(b.employee));

  const tasksByBar = [...tasksByBarMap.values()].sort(
    (a, b) => a.employee.localeCompare(b.employee) || a.taskName.localeCompare(b.taskName),
  );

  tasksByBar.forEach((entry) => {
    entry.collisionDays.sort((a, b) => a.day.localeCompare(b.day));
  });

  return {
    collisionDays,
    tasksByBar,
    summary: {
      dayCount: collisionDays.length,
      taskCount: tasksByBar.length,
      operativeCount: new Set(collisionDays.map((entry) => entry.employee)).size,
    },
  };
}

/** Lightweight count for toolbar badge — avoids building full collision payloads. */
export function countHistogramCollisionDays({
  bars = [],
  employees = [],
  startYmd,
  endYmd,
}) {
  if (!startYmd || !endYmd) {
    return 0;
  }

  const employeeList = normalizeList(employees);
  const barIndex = buildEmployeeBarIndex(bars, employeeList);
  const dayColumns = buildDayColumns(startYmd, endYmd).filter((day) => !isWeekend(day));
  let dayCount = 0;

  employeeList.forEach((employee) => {
    const rowBars = collectBarsForEmployee(employee, bars, barIndex);
    if (rowBars.length < 2) {
      return;
    }

    dayColumns.forEach((day) => {
      let tasksOnDay = 0;
      for (const bar of rowBars) {
        if (barHoursOnDay(bar, day) > 0.001) {
          tasksOnDay += 1;
          if (tasksOnDay >= 2) {
            dayCount += 1;
            break;
          }
        }
      }
    });
  });

  return dayCount;
}

function pickHoursByNames(lookup, employees) {
  const filtered = {};
  Object.entries(lookup ?? {}).forEach(([name, days]) => {
    const matched = employees.some((employee) => employeeMatchesName(employee, name));
    if (matched) {
      const canonical = employeeDisplayName(
        employees.find((employee) => employeeMatchesName(employee, name)),
      );
      filtered[canonical || name] = days;
    }
  });
  return filtered;
}

function pickHolidaysByNames(employeeHolidays, employees) {
  const filtered = {};
  Object.entries(employeeHolidays ?? {}).forEach(([name, days]) => {
    const matched = employees.some((employee) => employeeMatchesName(employee, name));
    if (matched) {
      const canonical = employeeDisplayName(
        employees.find((employee) => employeeMatchesName(employee, name)),
      );
      filtered[canonical || name] = days;
    }
  });
  return filtered;
}

export function filterHistogramByTeam({
  teamId,
  employees = [],
  bars = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
}) {
  const employeeList = normalizeList(employees);

  if (!teamId) {
    return {
      employees: employeeList,
      bars,
      dailyHours,
      availabilityHours,
      employeeHolidays,
    };
  }

  const teamEmployees = employeeList.filter(
    (employee) => String(employee.team_id) === String(teamId),
  );

  return {
    employees: teamEmployees,
    bars: bars.filter(
      (bar) =>
        bar.employee !== 'Unassigned'
        && teamEmployees.some((employee) => employeeMatchesName(employee, bar.employee)),
    ),
    dailyHours: pickHoursByNames(dailyHours, teamEmployees),
    availabilityHours: pickHoursByNames(availabilityHours, teamEmployees),
    employeeHolidays: pickHolidaysByNames(employeeHolidays, teamEmployees),
  };
}

const HISTOGRAM_FLAG_PARTITIONS = HISTOGRAM_DAY_PARTITIONS;

function allocateHistogramFlagSlot(counters, employee, dayYmd, kind) {
  const key = `${employee}|${dayYmd}|${kind}`;
  const slot = counters.get(key) ?? 0;
  counters.set(key, slot + 1);
  return slot;
}

function getHistogramFlagLeft(timeline, dayYmd, slot, kind) {
  const dayColumns = timelineDayColumns(timeline);
  const dayIndex = dayColumns.indexOf(dayYmd);
  if (dayIndex < 0) {
    return null;
  }

  const slotClamped = Math.min(slot, HISTOGRAM_FLAG_PARTITIONS - 1);
  const dayWidth = histogramColumnWidthAt(timeline, dayIndex);
  const baseLeft = histogramColumnLeft(timeline, dayIndex);
  const flagStep = HISTOGRAM_FLAG_SIZE + 2;

  if (kind === 'start') {
    return baseLeft + 2 + slotClamped * flagStep;
  }

  return baseLeft + dayWidth - HISTOGRAM_FLAG_SIZE - 2 - slotClamped * flagStep;
}

function getHistogramFlagLeftForTimeline(timeline, dateYmd, slot, kind) {
  if (!timeline?.columns?.length || !dateYmd) {
    return null;
  }

  return getHistogramFlagLeft(timeline, dateYmd, slot, kind);
}

export function buildRowHistogramFlags(rowBars, employeeName, dayColumns, dayWidth, options = {}) {
  const timeline = {
    columns: (dayColumns ?? []).map((day) => ({
      key: day,
      start: day,
      end: day,
      day,
      unit: 'day',
      width: histogramDayColumnWidth(day),
    })),
    columnWidth: dayWidth,
    timelineWidth: (dayColumns ?? []).reduce(
      (sum, day) => sum + histogramDayColumnWidth(day),
      0,
    ),
  };
  return buildRowHistogramFlagsForTimeline(rowBars, employeeName, timeline, options);
}

export function buildRowHistogramFlagsForTimeline(rowBars, employeeName, timeline, options = {}) {
  const {
    hideCompleted = false,
    projects = [],
    hiddenCompletedProjectIds = null,
  } = options;
  const projectLookup = buildHistogramProjectLookup(projects);
  const startCounters = new Map();
  const endCounters = new Map();
  const seenFlags = new Set();
  const flags = [];
  const dayColumns = timelineDayColumns(timeline);
  const isDateVisible = (dateYmd) => dayColumns.includes(dateYmd);

  (rowBars ?? []).forEach((bar) => {
    if (hideCompleted && isHistogramBarHiddenByCompletedFilter(bar, hiddenCompletedProjectIds)) {
      return;
    }

    const taskKey = bar.task_id ?? bar.id;
    const startDay = parseYmd(bar.doc_supply || bar.start);
    const endDay = parseYmd(bar.completion || bar.end) || startDay;

    if (startDay && isDateVisible(startDay)) {
      const dedupeKey = `${taskKey}|start|${startDay}`;
      if (!seenFlags.has(dedupeKey)) {
        seenFlags.add(dedupeKey);
        const slot = allocateHistogramFlagSlot(startCounters, employeeName, startDay, 'start');
        const left = getHistogramFlagLeftForTimeline(timeline, startDay, slot, 'start');
        if (left != null) {
          flags.push({
            id: `${bar.id}-start`,
            kind: 'start',
            left,
            color: bar.color || '#3B82F6',
            nrmNumber: bar.nrm_number || extractNrmNumberFromTaskName(bar.task_name),
            taskName: bar.task_name,
            projectName: bar.project_name,
            date: startDay,
          });
        }
      }
    }

    if (endDay && isDateVisible(endDay)) {
      const dedupeKey = `${taskKey}|end|${endDay}`;
      if (!seenFlags.has(dedupeKey)) {
        seenFlags.add(dedupeKey);
        const slot = allocateHistogramFlagSlot(endCounters, employeeName, endDay, 'end');
        const left = getHistogramFlagLeftForTimeline(timeline, endDay, slot, 'end');
        if (left != null) {
          flags.push({
            id: `${bar.id}-end`,
            kind: 'end',
            left,
            color: bar.color || '#3B82F6',
            nrmNumber: bar.nrm_number || extractNrmNumberFromTaskName(bar.task_name),
            taskName: bar.task_name,
            projectName: bar.project_name,
            date: endDay,
          });
        }
      }
    }
  });

  return flags;
}

export function buildProjectLegendItems(bars = [], {
  hideCompletedProjects = true,
  hideMissingAllDocs = true,
  projects = [],
  completionReferenceBars = null,
} = {}) {
  const projectLookup = buildHistogramProjectLookup(projects);
  const hiddenCompletedProjectIds = buildHiddenCompletedProjectIdSet(
    projects,
    completionReferenceBars ?? bars,
    hideCompletedProjects,
  );
  const map = new Map();

  bars.forEach((bar) => {
    if (!bar?.project_id) {
      return;
    }

    const key = String(bar.project_id);
    const existing = map.get(key);
    const barPri = parseLegendPri(bar.pri);
    const barPp = parseLegendPri(bar.pp);
    const project = projectLookup.get(key);

    if (!existing) {
      map.set(key, {
        id: bar.project_id,
        name: bar.project_name || 'Untitled project',
        color: project?.color || bar.color || '#3B82F6',
        hasOpenTasks: !bar.done,
        projectStatus: project?.status ?? bar.project_status ?? null,
        tasksCount: project?.tasks_count,
        openTasksCount: project?.open_tasks_count,
        pri: barPri,
        pp: barPp,
      });
      return;
    }

    if (!bar.done) {
      existing.hasOpenTasks = true;
    }

    if (barPri != null && (existing.pri == null || barPri < existing.pri)) {
      existing.pri = barPri;
    }

    if (barPp != null && (existing.pp == null || barPp < existing.pp)) {
      existing.pp = barPp;
    }
  });

  const items = sortLegendItemsAsc([...map.values()]);
  let filtered = items;

  if (hiddenCompletedProjectIds) {
    filtered = filtered.filter((item) => !hiddenCompletedProjectIds.has(String(item.id)));
  }

  if (hideMissingAllDocs) {
    filtered = filtered.filter((item) => projectHasAllDocs(projectLookup.get(String(item.id))));
  }

  return filtered;
}

export function isLegendItemFromCompletedProject(item, projectLookup = null) {
  const project = projectLookup?.get?.(String(item?.id));
  if (project) {
    return isHistogramProjectCompleted(project);
  }

  if (item?.projectStatus === 'completed') {
    return true;
  }

  return projectIsDone({
    status: item?.projectStatus,
    tasks_count: item?.tasksCount,
    open_tasks_count: item?.openTasksCount,
  });
}

function parseLegendPri(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

export function filterOpenLegendItems(items = []) {
  return items.filter((item) => item.hasOpenTasks);
}

export function buildProjectLegendItemsFromProjects(projects = []) {
  const items = projects
    .filter((project) => projectHasOpenTasks(project))
    .map((project) => ({
      id: project.id,
      name: project.name || 'Untitled project',
      color: displayProjectColor(project),
      hasOpenTasks: true,
      pp: parseLegendPri(project.min_pp),
      pri: null,
    }));

  return sortLegendItemsAsc(items);
}

export function mergeProjectLegendWithTasks(items = [], projectId, tasks = []) {
  if (!projectId || !tasks.length) {
    return items;
  }

  let minPp = null;
  let maxPp = null;
  let hasOpen = false;

  tasks.forEach((task) => {
    const pp = parseLegendPri(task.pp);
    if (pp != null) {
      if (minPp == null || pp < minPp) {
        minPp = pp;
      }
      if (maxPp == null || pp > maxPp) {
        maxPp = pp;
      }
    }
    if (!task.done) {
      hasOpen = true;
    }
  });

  const displayPp = maxPp ?? minPp;

  const key = String(projectId);
  return sortLegendItemsAsc(filterOpenLegendItems(items.map((item) => {
    if (String(item.id) !== key) {
      return item;
    }
    return {
      ...item,
      pp: displayPp ?? item.pp,
      hasOpenTasks: hasOpen,
    };
  })));
}
