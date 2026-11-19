/** Display pattern: "22 May 2026" */
export const DISPLAY_DATE_FORMAT = 'd MMMM yyyy';

const DISPLAY_OPTS = { day: 'numeric', month: 'long', year: 'numeric' };
const COMPACT_DISPLAY_OPTS = { day: 'numeric', month: 'short', year: 'numeric' };
const HISTOGRAM_HEADER_OPTS = { day: 'numeric', month: 'short' };

export function parseToLocalDate(value) {
  if (value == null || value === '') return null;

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const [y, m, d] = raw.slice(0, 10).split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Format any date value for display: "22 May 2026" */
export function formatDisplayDate(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', DISPLAY_OPTS);
}

/** Compact grid label e.g. "22 Jul 2026" */
export function formatCompactDisplayDate(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', COMPACT_DISPLAY_OPTS);
}

/** Compact label for histogram day columns e.g. "22 May" */
export function formatHistogramDateHeader(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', HISTOGRAM_HEADER_OPTS);
}

/** Day row label e.g. "5 Mon"; weekends show the day number only (narrow columns). */
export function formatHistogramDayHeader(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const day = date.getDate();
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return String(day);
  }
  const weekday = date.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${day} ${weekday}`;
}

/** Week view day row label e.g. "5-Mon" */
export function formatHistogramWeekDayHeader(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const day = date.getDate();
  const weekday = date.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${day}-${weekday}`;
}

/** Month column label e.g. "June 2026" */
export function formatHistogramMonthColumnHeader(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Month row label e.g. "May" */
export function formatHistogramMonthHeader(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { month: 'long' });
}

/**
 * Group consecutive day columns into month bands for the histogram header.
 * @param {string[]} dayColumns YYYY-MM-DD strings in order
 */
export function buildHistogramMonthSpans(dayColumns) {
  if (!dayColumns?.length) {
    return [];
  }

  const spans = [];
  let spanStart = 0;
  let currentKey = null;

  const pushSpan = (startIndex, endIndex) => {
    const firstDay = dayColumns[startIndex];
    spans.push({
      key: `${firstDay}-${startIndex}`,
      startIndex,
      dayCount: endIndex - startIndex,
      monthKey: currentKey,
      label: formatHistogramMonthHeader(firstDay),
      shadeIndex: spans.length,
    });
  };

  dayColumns.forEach((day, index) => {
    const date = parseToLocalDate(day);
    const monthKey = date
      ? `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`
      : day.slice(0, 7);

    if (currentKey === null) {
      currentKey = monthKey;
      spanStart = index;
      return;
    }

    if (monthKey !== currentKey) {
      pushSpan(spanStart, index);
      currentKey = monthKey;
      spanStart = index;
    }
  });

  pushSpan(spanStart, dayColumns.length);

  return spans;
}

export function formatTodayDisplay() {
  return formatDisplayDate(new Date());
}

export function toStorageDate(value) {
  const date = value instanceof Date ? value : parseToLocalDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Normalize API date values (ISO or Y-m-d) to YYYY-MM-DD. */
export function toYmd(value) {
  if (value == null || value === '') {
    return '';
  }
  if (value instanceof Date) {
    return toStorageDate(value);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  return toStorageDate(raw);
}
