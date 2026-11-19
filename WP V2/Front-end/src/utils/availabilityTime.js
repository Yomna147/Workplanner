import { toStorageDate } from './dateFormat';

export function convertTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

export function diff(start, end) {
  if (!start || !end) return false;
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  let diffMinutes = endH * 60 + endM - (startH * 60 + startM);
  if (diffMinutes < 0) diffMinutes += 24 * 60;
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function addTime(originalTime, duration, second, third) {
  const parse = (time) => {
    if (!time) return [0, 0];
    const [h, m] = time.split(':').map(Number);
    return [Number.isNaN(h) ? 0 : h, Number.isNaN(m) ? 0 : m];
  };

  const parts = [originalTime, duration, second, third].map(parse);
  let totalMinutes = parts.reduce((sum, [h, m]) => sum + h * 60 + m, 0);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function computeRowTotal(row) {
  return addTime(
    diff(row.strt1, row.end1),
    diff(row.strt2, row.end2),
    diff(row.strt3, row.end3),
    diff(row.strt4, row.end4),
  );
}

export function formatMonthValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function monthStartEnd(monthValue) {
  const [year, month] = monthValue.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return {
    start: toStorageDate(start),
    end: toStorageDate(end),
  };
}

export function addDaysYmd(ymd, days) {
  const date = new Date(`${ymd}T12:00:00`);
  date.setDate(date.getDate() + days);
  return toStorageDate(date);
}

export function listDaysInRange(startDate, endDate) {
  if (!startDate || !endDate || startDate > endDate) {
    return [];
  }

  const days = [];
  let current = startDate;
  let guard = 0;

  while (current <= endDate && guard < 31) {
    days.push(current);
    current = addDaysYmd(current, 1);
    guard += 1;
  }

  return days;
}

export function dayName(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
}

export function sortAvailabilities(rows) {
  return [...rows].sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });
}

export function sumFilteredMinutes(rows, startDate, endDate) {
  return rows
    .filter((row) => row.date >= startDate && row.date <= endDate)
    .reduce((acc, row) => acc + convertTimeToMinutes(row.total || row.Total || row.total_ava), 0);
}

export function isWeekendDate(dateStr) {
  if (!dateStr) return false;
  const day = new Date(`${dateStr}T12:00:00`).getDay();
  return day === 0 || day === 6;
}

export function formatTotalHours(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** Parse typed time into HH:MM, or null if invalid. */
export function normalizeTimeInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';

  if (/^\d{1,2}:\d{1,2}$/.test(trimmed)) {
    const [hours, minutes] = trimmed.split(':').map(Number);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
    return null;
  }

  if (/^\d{3,4}$/.test(trimmed)) {
    const padded = trimmed.padStart(4, '0');
    const hours = Number(padded.slice(0, 2));
    const minutes = Number(padded.slice(2, 4));
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
    return null;
  }

  return null;
}

/** Display value for editable HH:MM field (empty when unset or midnight placeholder). */
export function formatTimeInputValue(value) {
  if (!value || value === '00:00') return '';
  return String(value).slice(0, 5);
}

/** Quarter-hour slots for dropdown pickers. */
export function buildTimeDropdownOptions(stepMinutes = 15) {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += stepMinutes) {
      options.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  return options;
}

export function getTakenDates(rows, excludeRowId = null) {
  const taken = new Set();
  rows.forEach((row) => {
    if (!row?.date) return;
    if (excludeRowId != null && String(row.id) === String(excludeRowId)) return;
    taken.add(String(row.date).slice(0, 10));
  });
  return taken;
}

export function findNextAvailableDate(fromDate, rangeStart, rangeEnd, takenDates, startAfter = false) {
  if (!fromDate || !rangeStart || !rangeEnd || rangeStart > rangeEnd) {
    return null;
  }

  let current = startAfter ? addDaysYmd(fromDate, 1) : fromDate;
  let guard = 0;

  while (current <= rangeEnd && guard < 366) {
    if (current >= rangeStart && !takenDates.has(current)) {
      return current;
    }
    current = addDaysYmd(current, 1);
    guard += 1;
  }

  return null;
}

export function dedupeAvailabilitiesByDate(rows) {
  const byDate = new Map();
  sortAvailabilities(rows).forEach((row) => {
    const date = String(row.date).slice(0, 10);
    if (!byDate.has(date)) {
      byDate.set(date, { ...row, date });
    }
  });
  return sortAvailabilities([...byDate.values()]);
}
