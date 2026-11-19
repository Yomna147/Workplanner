/** Historical earliest — only used when explicitly requesting all years. */
export const TT_REPORTS_EARLIEST = "2017-01-01";

export function getCurrentYearStart() {
  return `${new Date().getFullYear()}-01-01`;
}

export function getTodayYmd(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getCurrentMonthStartYmd(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/** First day of last month through today. */
export function getLastAndCurrentMonthRange(now = new Date()) {
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const start = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-01`;
  return {
    start,
    end: getTodayYmd(now),
    currentMonthStart: getCurrentMonthStartYmd(now),
  };
}

function ymd(year, monthIndex, day = 1) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** One slice per calendar month from startYmd through endYmd (inclusive). */
export function buildMonthSlices(startYmd, endYmd = getTodayYmd()) {
  const start = String(startYmd || '').slice(0, 10);
  const end = String(endYmd || getTodayYmd()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    return [];
  }

  const cursor = new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, 1);
  const last = new Date(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, 1);
  const slices = [];

  while (cursor <= last) {
    const year = cursor.getFullYear();
    const monthIndex = cursor.getMonth();
    const sliceStart = ymd(year, monthIndex, 1);
    const next = new Date(year, monthIndex + 1, 1);
    const sliceEnd = cursor.getTime() === last.getTime()
      ? end
      : ymd(next.getFullYear(), next.getMonth(), 1);
    const label = cursor.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    slices.push({ label, startDate: sliceStart, endDate: sliceEnd });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return slices;
}

export function formatMonthWindowLabel(startYmd, endYmd) {
  const start = String(startYmd || '').slice(0, 7);
  const end = String(endYmd || '').slice(0, 7);
  const format = (value) => {
    if (!/^\d{4}-\d{2}$/.test(value)) return '';
    const date = new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, 1);
    return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  };
  const startLabel = format(start);
  const endLabel = format(end);
  if (startLabel && endLabel && startLabel !== endLabel) {
    const sameYear = start.slice(0, 4) === end.slice(0, 4);
    if (sameYear) {
      const startMonth = new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, 1)
        .toLocaleDateString('en-GB', { month: 'short' });
      return `${startMonth} – ${endLabel}`;
    }
    return `${startLabel} – ${endLabel}`;
  }
  return endLabel || startLabel || 'Last 2 months';
}

/** Year-sized slices from start date through today (default: current year only). */
export function buildYearSlices(earliest = getCurrentYearStart()) {
  const startYear = parseInt(String(earliest).slice(0, 4), 10);
  const endYear = new Date().getFullYear();
  const today = getTodayYmd();
  const slices = [];

  for (let year = startYear; year <= endYear; year++) {
    const startDate = `${year}-01-01`;
    const endDate = year === endYear ? today : `${year + 1}-01-01`;
    slices.push({ label: String(year), startDate, endDate });
  }

  return slices;
}
