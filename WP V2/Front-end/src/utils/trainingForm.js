import { employeeDisplayName } from './employeeNames';
import { toYmd } from './dateFormat';
import { mergeTrainingHoursIntoDailyHours, overlappingTrainingsOnDay } from './trainingOccupancy';
import { isEmployeeHolidayDay } from '../components/gantt/ganttUtils';

/**
 * Duration presets are total course hours (not hours/day).
 * Assignments default to a single 2h histogram slot on one day.
 */
export const TRAINING_DURATION_CUSTOM = 'Custom';
export const TRAINING_DEFAULT_DURATION = '1-2 hours';
export const TRAINING_DEFAULT_HOURS_PER_DAY = 2;
export const TRAINING_DEFAULT_TOTAL_HOURS = 2;
export const TRAINING_DAY_SEGMENT_COUNT = 4;

/** Histogram day column split into four 2h sections (0–3). */
export const TRAINING_DAY_SEGMENT_OPTIONS = [
  { value: 0, label: 'Section 1', title: 'First section of the workday (2 h)' },
  { value: 1, label: 'Section 2', title: 'Second section of the workday (2 h)' },
  { value: 2, label: 'Section 3', title: 'Third section of the workday (2 h)' },
  { value: 3, label: 'Section 4', title: 'Fourth section of the workday (2 h)' },
];

export function normalizeTrainingDaySegment(value, fallback = 0) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const segment = Math.floor(Number(value));
  if (!Number.isFinite(segment)) {
    return fallback;
  }
  return Math.max(0, Math.min(TRAINING_DAY_SEGMENT_COUNT - 1, segment));
}

export function trainingDaySegmentLabel(value) {
  const segment = normalizeTrainingDaySegment(value, 0);
  return TRAINING_DAY_SEGMENT_OPTIONS.find((option) => option.value === segment)?.label
    ?? `Section ${segment + 1}`;
}

/** How many day-band sections a course occupies for the given hours / AVA. */
export function trainingDaySegmentCount(hoursPerDay, dayCapacity = 8) {
  const hours = Number(hoursPerDay);
  const capacity = Number(dayCapacity) > 0 ? Number(dayCapacity) : 8;
  if (!Number.isFinite(hours) || hours <= 0) {
    return 1;
  }
  if (hours >= capacity - 0.05) {
    return TRAINING_DAY_SEGMENT_COUNT;
  }
  return Math.max(
    1,
    Math.min(
      TRAINING_DAY_SEGMENT_COUNT,
      Math.round((hours / capacity) * TRAINING_DAY_SEGMENT_COUNT) || 1,
    ),
  );
}

/** Inclusive start / exclusive end band indexes for a training on one day. */
export function trainingDaySegmentSpan(training, dayCapacity = 8) {
  const startSeg = normalizeTrainingDaySegment(training?.day_segment, 0);
  const hours = Number(training?.hours_per_day);
  const resolvedHours = Number.isFinite(hours) && hours > 0
    ? hours
    : TRAINING_DEFAULT_HOURS_PER_DAY;
  const numSeg = Math.max(
    1,
    Math.min(
      trainingDaySegmentCount(resolvedHours, dayCapacity),
      TRAINING_DAY_SEGMENT_COUNT - startSeg,
    ),
  );
  return { startSeg, numSeg, endSeg: startSeg + numSeg };
}

export function trainingDaySegmentsOverlap(a, b) {
  if (!a || !b) {
    return false;
  }
  return a.startSeg < b.endSeg && b.startSeg < a.endSeg;
}

/** Day-section indexes already taken by other trainings for this operative/date. */
export function occupiedTrainingDaySegments({
  trainings = [],
  employeeId,
  day,
  hoursPerDay = TRAINING_DEFAULT_HOURS_PER_DAY,
  dayCapacity = 8,
  ignoreTrainingId = null,
  proposedSegment = null,
} = {}) {
  const excludeIds = ignoreTrainingId != null ? [ignoreTrainingId] : [];
  const overlapping = overlappingTrainingsOnDay(trainings, employeeId, day, { excludeIds });
  const occupied = new Set();

  overlapping.forEach((row) => {
    const span = trainingDaySegmentSpan(row, dayCapacity);
    for (let index = span.startSeg; index < span.endSeg; index += 1) {
      occupied.add(index);
    }
  });

  if (proposedSegment != null) {
    const proposed = trainingDaySegmentSpan(
      { day_segment: proposedSegment, hours_per_day: hoursPerDay },
      dayCapacity,
    );
    for (let index = proposed.startSeg; index < proposed.endSeg; index += 1) {
      if (occupied.has(index)) {
        return { occupied, overlaps: true, proposed };
      }
    }
    return { occupied, overlaps: false, proposed };
  }

  return { occupied, overlaps: false, proposed: null };
}

/**
 * First day-section index that fits hoursPerDay for every selected operative
 * without overlapping existing trainings on that day.
 */
export function firstFreeTrainingDaySegment({
  trainings = [],
  employeeIds = [],
  day,
  hoursPerDay = TRAINING_DEFAULT_HOURS_PER_DAY,
  dayCapacity = 8,
  ignoreTrainingId = null,
} = {}) {
  const ids = (employeeIds || []).map(String).filter(Boolean);
  if (!day || ids.length === 0) {
    return 0;
  }

  for (let segment = 0; segment < TRAINING_DAY_SEGMENT_COUNT; segment += 1) {
    const freeForAll = ids.every((employeeId) => {
      const result = occupiedTrainingDaySegments({
        trainings,
        employeeId,
        day,
        hoursPerDay,
        dayCapacity,
        ignoreTrainingId,
        proposedSegment: segment,
      });
      return !result.overlaps;
    });
    if (freeForAll) {
      return segment;
    }
  }

  return 0;
}

export const TRAINING_DURATION_PRESET_OPTIONS = [
  { value: '1-2 hours', label: '2 h', totalHours: 2 },
  { value: 'Half day', label: '4 h (half day)', totalHours: 4 },
  { value: 'Full day', label: '8 h (full day)', totalHours: 8 },
  { value: 'Multi-day', label: '16 h (multi-day)', totalHours: 16 },
];

/** Legacy duration values kept for existing records — hidden from new-training dropdowns. */
export const TRAINING_DURATION_LEGACY_PRESETS = {
  '2-4 hours': { label: '4 h', totalHours: 4 },
};

export const TRAINING_DURATION_OPTIONS = [
  ...TRAINING_DURATION_PRESET_OPTIONS,
  { value: TRAINING_DURATION_CUSTOM, label: 'Custom' },
];

/** Hours booked per weekday when deriving duration from a date span. */
export const TRAINING_HOURS_PER_WORKING_DAY = 8;

export function isCustomTrainingDuration(duration) {
  return duration === TRAINING_DURATION_CUSTOM;
}

export function isPresetTrainingDuration(duration) {
  return TRAINING_DURATION_PRESET_OPTIONS.some((option) => option.value === duration)
    || Object.prototype.hasOwnProperty.call(TRAINING_DURATION_LEGACY_PRESETS, duration);
}

function resolveDurationPreset(duration) {
  const preset = TRAINING_DURATION_PRESET_OPTIONS.find((option) => option.value === duration);
  if (preset) {
    return preset;
  }

  const legacy = TRAINING_DURATION_LEGACY_PRESETS[duration];
  if (legacy) {
    return { value: duration, ...legacy };
  }

  return null;
}

export function durationToTotalHours(duration, training = null) {
  if (isCustomTrainingDuration(duration)) {
    const stored = Number(training?.total_hours);
    if (Number.isFinite(stored) && stored > 0) {
      return clampTrainingTotalHours(stored);
    }
  }
  const match = resolveDurationPreset(duration);
  return match?.totalHours ?? 8;
}

/** @deprecated Prefer durationToTotalHours — kept for single-day callers. */
export function durationToHoursPerDay(duration) {
  return durationToTotalHours(duration);
}

export function clampTrainingHoursPerDay(value, fallback = 8) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(24, Math.max(0.25, Math.round(num * 100) / 100));
}

export function clampTrainingTotalHours(value, fallback = 8) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(80, Math.max(0.25, Math.round(num * 100) / 100));
}

export function durationPresetForTotalHours(hours) {
  const target = Number(hours);
  if (!Number.isFinite(target)) {
    return null;
  }
  return TRAINING_DURATION_PRESET_OPTIONS.find((option) => option.totalHours === target)?.value ?? null;
}

/** Dropdown value for duration — preset when explicitly chosen, otherwise Custom for manual hours. */
export function resolveTrainingDurationSelectValue(training) {
  if (isCustomTrainingDuration(training?.duration)) {
    return TRAINING_DURATION_CUSTOM;
  }
  if (isPresetTrainingDuration(training?.duration)) {
    return training.duration;
  }
  const preset = durationPresetForTotalHours(trainingTotalHours(training));
  return preset || TRAINING_DURATION_PRESET_OPTIONS[0].value;
}

/** Human label for tables and summaries — hours for custom, preset label otherwise. */
export function trainingDurationDisplayLabel(training) {
  if (isCustomTrainingDuration(training?.duration)) {
    return formatTrainingTotalHours(training) || 'Custom';
  }
  const preset = TRAINING_DURATION_PRESET_OPTIONS.find((option) => option.value === training?.duration)
    || resolveDurationPreset(training?.duration);
  if (preset) {
    return preset.label;
  }
  return formatTrainingTotalHours(training) || String(training?.duration || '');
}

/** @deprecated Prefer durationPresetForTotalHours */
export function durationPresetForHours(hours) {
  return durationPresetForTotalHours(hours);
}

/** Inclusive Mon–Fri count between training start/end dates. */
export function trainingWorkingDayCount(training) {
  const start = String(training?.start_date || '').slice(0, 10);
  const end = String(training?.end_date || start).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    return 0;
  }

  let count = 0;
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cursor <= last) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      count += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/** Working days required to cover a total hour amount (8h per weekday by default). */
export function workingDaysFromTotalHours(totalHours) {
  const total = clampTrainingTotalHours(totalHours);
  return Math.max(1, Math.ceil(total / TRAINING_HOURS_PER_WORKING_DAY));
}

/** Total hours for a weekday span (weekends excluded). */
export function totalHoursFromWorkingDayCount(workingDays) {
  const days = Math.max(1, Number(workingDays) || 1);
  return clampTrainingTotalHours(days * TRAINING_HOURS_PER_WORKING_DAY);
}

/**
 * Inclusive end date after counting `workingDayCount` weekdays from `startYmd`.
 * A count of 1 returns the same day when it is a weekday.
 */
export function addWorkingDaysFromYmd(startYmd, workingDayCount) {
  const start = toYmd(startYmd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return start;
  }

  const days = Math.max(1, Number(workingDayCount) || 1);
  let remaining = days - 1;
  const cursor = new Date(`${start}T00:00:00`);

  if (Number.isNaN(cursor.getTime())) {
    return start;
  }

  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + 1);
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6) {
      remaining -= 1;
    }
  }

  return toYmd(cursor);
}

/**
 * Force a single-day assignment. Keeps an existing positive hours_per_day
 * (e.g. reschedule of a 1h course) and defaults new rows to 2h.
 */
export function applyTrainingSingleDaySlot(training, dateYmd = null) {
  const day = toYmd(dateYmd ?? training?.start_date ?? training?.end_date ?? '');
  const existingHours = Number(training?.hours_per_day);
  const hours = Number.isFinite(existingHours) && existingHours > 0
    ? clampTrainingHoursPerDay(existingHours)
    : TRAINING_DEFAULT_HOURS_PER_DAY;
  const next = {
    ...training,
    duration: training?.duration || TRAINING_DEFAULT_DURATION,
    hours_per_day: hours,
    total_hours: hours,
    day_segment: normalizeTrainingDaySegment(training?.day_segment, 0),
  };

  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    next.start_date = day;
    next.end_date = day;
  }

  return next;
}

/** Derive daily booking from total duration hours and scheduled working days. */
export function hoursPerDayFromTotal(totalHours, training = {}) {
  const total = clampTrainingTotalHours(
    totalHours,
    trainingTotalHours(training),
  );
  const days = Math.max(1, trainingWorkingDayCount(training) || 1);
  return clampTrainingHoursPerDay(total / days);
}

export function normalizeTrainingHoursPerDay(value, duration, training = {}) {
  const total = trainingTotalHours({ ...training, duration });
  if (training?.start_date || training?.end_date) {
    return hoursPerDayFromTotal(total, { ...training, duration });
  }
  if (value != null && value !== '') {
    return clampTrainingHoursPerDay(value, total);
  }
  return total;
}

/** Apply a user-entered total-hours value and move the end date to match. */
export function applyTrainingTotalHoursChange(training, totalHours) {
  const total = clampTrainingTotalHours(totalHours);
  const start = toYmd(training?.start_date);

  let next = {
    ...training,
    duration: TRAINING_DURATION_CUSTOM,
    total_hours: total,
  };

  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const daysNeeded = workingDaysFromTotalHours(total);
    next.end_date = addWorkingDaysFromYmd(start, daysNeeded);
  }

  return syncTrainingHoursFromDuration(next);
}

/** Sync duration from start/end (weekdays × 8h). Weekends are excluded. */
export function syncTrainingScheduleFromDates(training) {
  let next = { ...training };
  const start = toYmd(next.start_date);
  let end = toYmd(next.end_date || start);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return syncTrainingHoursFromDuration(next);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    end = start;
    next.end_date = start;
  }

  const workingDays = trainingWorkingDayCount({ ...next, start_date: start, end_date: end });
  if (workingDays <= 0) {
    return syncTrainingHoursFromDuration(next);
  }

  const total = totalHoursFromWorkingDayCount(workingDays);

  return syncTrainingHoursFromDuration({
    ...next,
    start_date: start,
    end_date: end,
    duration: TRAINING_DURATION_CUSTOM,
    total_hours: total,
  });
}

/** Sync hours_per_day from the duration total and current dates. */
export function syncTrainingHoursFromDuration(training) {
  const next = { ...training };
  const total = trainingTotalHours(next);
  next.hours_per_day = hoursPerDayFromTotal(total, next);
  if (isCustomTrainingDuration(next.duration)) {
    next.total_hours = total;
  } else {
    delete next.total_hours;
  }
  return next;
}

/** Client-side checks that mirror backend TrainingController rules. */
export function getTrainingSaveValidationError(training) {
  if (!String(training?.title ?? '').trim()) {
    return 'Training title is required.';
  }

  const start = String(training?.start_date ?? '').slice(0, 10);
  const end = String(training?.end_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return 'A training date is required.';
  }
  if (end < start) {
    return 'End date must be on or after the start date.';
  }

  if (
    training?.duration
    && !isPresetTrainingDuration(training.duration)
    && !isCustomTrainingDuration(training.duration)
  ) {
    return 'Duration is not a valid option.';
  }

  const hoursPerDay = Number(training?.hours_per_day);
  const totalHours = trainingTotalHours(training);
  if (!Number.isFinite(totalHours) || totalHours < 0.25 || totalHours > 80) {
    return 'Total training hours must be between 0.25 and 80.';
  }
  if (!Number.isFinite(hoursPerDay) || hoursPerDay < 0.25 || hoursPerDay > 24) {
    return 'Training hours could not be calculated for the selected dates.';
  }

  return null;
}

/**
 * Build a POST/PUT payload for a single-day training assignment.
 * Preserves an existing hours_per_day on update/reschedule; new rows default to 2h.
 */
export function buildTrainingSavePayload(training, overrides = {}) {
  const merged = { ...training, ...overrides };
  const day = String(merged.start_date || merged.end_date || '').slice(0, 10);
  const existingHours = Number(
    Object.prototype.hasOwnProperty.call(overrides, 'hours_per_day')
      ? overrides.hours_per_day
      : merged.hours_per_day,
  );
  const hoursPerDay = Number.isFinite(existingHours) && existingHours > 0
    ? clampTrainingHoursPerDay(existingHours)
    : TRAINING_DEFAULT_HOURS_PER_DAY;

  const synced = applyTrainingSingleDaySlot({
    ...merged,
    hours_per_day: hoursPerDay,
    duration: merged.duration || TRAINING_DEFAULT_DURATION,
  }, day || null);

  const validationError = getTrainingSaveValidationError(synced);
  if (validationError) {
    const error = new Error(validationError);
    error.code = 'TRAINING_VALIDATION';
    throw error;
  }

  const rawLink = String(synced.course_link ?? '').trim();
  const description = String(synced.description ?? '').trim();

  const payload = {
    title: String(synced.title ?? '').trim(),
    training_course_id: synced.training_course_id ? Number(synced.training_course_id) : null,
    course_link: rawLink ? normalizeTrainingCourseUrl(rawLink) : null,
    description: description || null,
    duration: synced.duration || TRAINING_DEFAULT_DURATION,
    status: synced.status,
    priority: synced.priority,
    urgency: synced.urgency,
    start_date: String(synced.start_date).slice(0, 10),
    end_date: String(synced.end_date).slice(0, 10),
    hours_per_day: hoursPerDay,
    day_segment: normalizeTrainingDaySegment(synced.day_segment, 0),
  };

  if (overrides.employee_id != null && overrides.employee_id !== '') {
    payload.employee_id = Number(overrides.employee_id);
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'confirm_override')) {
    payload.confirm_override = Boolean(overrides.confirm_override);
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'notes')) {
    payload.notes = overrides.notes;
  }
  if (Array.isArray(overrides.override_conflicts) && overrides.override_conflicts.length > 0) {
    payload.override_conflicts = overrides.override_conflicts.map((conflict) => ({
      message: String(conflict?.message || ''),
      tasks: Array.isArray(conflict?.tasks)
        ? conflict.tasks.map((task) => (
          typeof task === 'string'
            ? { task_name: task, project_name: '' }
            : {
              task_name: String(task?.task_name || task?.name || ''),
              project_name: String(task?.project_name || task?.project || ''),
            }
        )).filter((task) => task.task_name)
        : [],
      trainings: Array.isArray(conflict?.trainings)
        ? conflict.trainings.map((title) => (
          typeof title === 'string' ? title : String(title?.title || title?.name || '')
        )).filter(Boolean)
        : [],
    }));
  }

  return payload;
}

/** Total training hours from the duration preset (authoritative). */
export function trainingTotalHours(training) {
  if (isCustomTrainingDuration(training?.duration)) {
    const stored = Number(training?.total_hours);
    if (Number.isFinite(stored) && stored > 0) {
      return stored;
    }
    const perDay = Number(training?.hours_per_day);
    const days = trainingWorkingDayCount(training);
    if (Number.isFinite(perDay) && perDay > 0 && days > 0) {
      return Math.round(perDay * days * 100) / 100;
    }
  }

  if (isPresetTrainingDuration(training?.duration)) {
    return durationToTotalHours(training.duration, training);
  }

  const perDay = Number(training?.hours_per_day);
  const days = trainingWorkingDayCount(training);
  if (Number.isFinite(perDay) && perDay > 0 && days > 0) {
    return Math.round(perDay * days * 100) / 100;
  }
  if (Number.isFinite(perDay) && perDay > 0) {
    return Math.round(perDay * 100) / 100;
  }
  return durationToTotalHours(training?.duration, training);
}

export function formatTrainingTotalHours(training, { suffix = ' h' } = {}) {
  const total = trainingTotalHours(training);
  if (!Number.isFinite(total) || total <= 0) {
    return '';
  }
  const label = Number.isInteger(total) ? String(total) : String(total);
  return `${label}${suffix}`;
}

export const TRAINING_STATUS_OPTIONS = [
  { value: 'not_started', label: 'Not started' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'almost_complete', label: 'Almost complete' },
  { value: 'completed', label: 'Completed' },
];

/** Status → progress % used in employee panels and assignee cards. */
export const TRAINING_STATUS_PROGRESS = {
  not_started: 0,
  scheduled: 25,
  in_progress: 50,
  almost_complete: 75,
  completed: 100,
};

/** Progress dropdown options for training assignment status. */
export const TRAINING_PROGRESS_OPTIONS = [
  { value: 'not_started', label: '0% — Not started', compactLabel: '0%' },
  { value: 'scheduled', label: '25% — Scheduled', compactLabel: '25%' },
  { value: 'in_progress', label: '50% — In progress', compactLabel: '50%' },
  { value: 'almost_complete', label: '75% — Almost complete', compactLabel: '75%' },
  { value: 'completed', label: '100% — Completed', compactLabel: '100%' },
];

export function trainingStatusProgressPercent(status) {
  const key = String(status || '').trim();
  if (Object.prototype.hasOwnProperty.call(TRAINING_STATUS_PROGRESS, key)) {
    return TRAINING_STATUS_PROGRESS[key];
  }
  return 0;
}

export function resolveTrainingProgressOverlayWidthPx(training, barWidthPx) {
  const percent = trainingStatusProgressPercent(training?.status);
  const width = Number(barWidthPx) || 0;
  if (percent <= 0 || width <= 0) {
    return 0;
  }
  return (percent / 100) * width;
}

export const TRAINING_PRIORITY_OPTIONS = [
  { value: 'P0', label: 'P0 - Critical' },
  { value: 'P1', label: 'P1 - High' },
  { value: 'P2', label: 'P2 - Medium' },
  { value: 'P3', label: 'P3 - Low' },
];

export const TRAINING_URGENCY_OPTIONS = [
  { value: 'U0', label: 'U0 - No pressure' },
  { value: 'U1', label: 'U1 - Between projects' },
  { value: 'U2', label: 'U2 - Next gap' },
  { value: 'U3', label: 'U3 - Drop everything' },
];

export const TRAINING_PRIORITY_URGENCY_MAP = {
  P0: 'U3',
  P1: 'U2',
  P2: 'U1',
  P3: 'U0',
};

export const TRAINING_URGENCY_PRIORITY_MAP = {
  U3: 'P0',
  U2: 'P1',
  U1: 'P2',
  U0: 'P3',
};

export function trainingPriorityLabel(value) {
  return TRAINING_PRIORITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function trainingUrgencyLabel(value) {
  return TRAINING_URGENCY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function linkedUrgencyForPriority(priority) {
  return TRAINING_PRIORITY_URGENCY_MAP[priority] ?? 'U1';
}

export function linkedPriorityForUrgency(urgency) {
  return TRAINING_URGENCY_PRIORITY_MAP[urgency] ?? 'P2';
}

export function trainingStatusLabel(value) {
  return TRAINING_STATUS_OPTIONS.find((option) => option.value === value)?.label
    ?? String(value || '').replace(/_/g, ' ');
}

export function normalizeTrainingCourseUrl(url) {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) {
    return '';
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function openTrainingCourseLink(url) {
  const href = normalizeTrainingCourseUrl(url);
  if (!href) {
    return false;
  }

  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

/** Open the course URL or return a short reason when it cannot open. */
export function tryOpenTrainingCourseLink(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return { ok: false, reason: 'This course has no link yet. Add one under Manage courses.' };
  }
  const opened = openTrainingCourseLink(raw);
  if (!opened) {
    return { ok: false, reason: 'Course link is not a valid URL.' };
  }
  return { ok: true };
}

export function buildTrainingConflictWarnings({
  employeeIds = [],
  employees = [],
  startDate,
  endDate,
  hoursPerDay = 8,
  daySegment = 0,
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  bars = [],
  trainings = [],
  ignoreTrainingId = null,
}) {
  if (!startDate || !endDate || employeeIds.length === 0) {
    return [];
  }

  const occupancyHours = mergeTrainingHoursIntoDailyHours(
    dailyHours,
    trainings,
    employees,
    {
      excludeIds: ignoreTrainingId != null ? [ignoreTrainingId] : [],
      employeeHolidays,
    },
  );
  const warningsByEmployee = new Map();
  const days = [];
  let cursor = startDate;
  let guard = 0;

  while (cursor <= endDate && guard < 120) {
    days.push(cursor);
    const [year, month, day] = cursor.split('-').map(Number);
    const next = new Date(year, month - 1, day + 1);
    const y = next.getFullYear();
    const m = String(next.getMonth() + 1).padStart(2, '0');
    const d = String(next.getDate()).padStart(2, '0');
    cursor = `${y}-${m}-${d}`;
    guard += 1;
  }

  const ensureEntry = (employeeId, name) => {
    const key = String(employeeId);
    if (!warningsByEmployee.has(key)) {
      warningsByEmployee.set(key, {
        id: key,
        employeeId,
        employeeName: name,
        days: [],
        dayLabels: [],
        tasksByKey: new Map(),
        trainingNames: new Set(),
        kinds: new Set(),
        minGap: 8,
        holiday: false,
        segmentConflict: false,
        conflictSection: null,
      });
    }
    return warningsByEmployee.get(key);
  };

  employeeIds.forEach((employeeId) => {
    const employee = employees.find((entry) => String(entry.id) === String(employeeId));
    if (!employee) {
      return;
    }

    const name = employeeDisplayName(employee);

    days.forEach((day) => {
      const weekday = new Date(`${day}T12:00:00`).getDay();
      if (weekday === 0 || weekday === 6) {
        return;
      }

      const dayLabel = new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      const holiday = isEmployeeHolidayDay(name, day, employeeHolidays, employees)
        || Boolean(employeeHolidays?.[name]?.[day]);
      const avaRaw = availabilityHours?.[name]?.[day];
      const ava = avaRaw == null || avaRaw === '' ? 8 : Number(avaRaw);

      if (holiday || ava <= 0.05) {
        const entry = ensureEntry(employeeId, name);
        entry.days.push(day);
        entry.dayLabels.push(dayLabel);
        entry.holiday = true;
        entry.kinds.add('holiday');
        entry.minGap = 0;
        return;
      }

      const overlapping = overlappingTrainingsOnDay(
        trainings,
        employeeId,
        day,
        { excludeIds: ignoreTrainingId != null ? [ignoreTrainingId] : [] },
      );
      const proposedSpan = trainingDaySegmentSpan(
        { day_segment: daySegment, hours_per_day: hoursPerDay },
        ava,
      );
      const segmentOverlaps = overlapping.filter((row) => (
        trainingDaySegmentsOverlap(proposedSpan, trainingDaySegmentSpan(row, ava))
      ));

      // Same day-section already booked by another course → hard block.
      if (segmentOverlaps.length > 0) {
        const entry = ensureEntry(employeeId, name);
        entry.days.push(day);
        entry.dayLabels.push(dayLabel);
        entry.segmentConflict = true;
        entry.conflictSection = trainingDaySegmentLabel(daySegment);
        entry.kinds.add('training');
        segmentOverlaps.forEach((row) => entry.trainingNames.add(row.title || 'Training'));
        entry.minGap = Math.min(
          entry.minGap,
          Math.max(0, ava - Number(occupancyHours?.[name]?.[day] ?? 0)),
        );
        return;
      }

      const booked = Number(occupancyHours?.[name]?.[day] ?? 0);
      if (booked <= 0.05) {
        return;
      }

      const gap = Math.max(0, ava - booked);
      // Free hours left for this course → allow without warning.
      if (gap >= hoursPerDay - 0.05) {
        return;
      }

      const dayTasks = bars
        .filter((bar) => {
          const barEmployee = String(bar.employee || '').trim();
          return barEmployee === name && Number(bar.hours_by_day?.[day] || 0) > 0;
        })
        .map((bar) => ({
          task_name: String(bar.task_name || '').trim() || 'Untitled task',
          project_name: String(bar.project_name || bar.project || '').trim(),
        }));

      const trainingOnlyHours = overlapping.reduce((sum, row) => {
        const hours = Number(row.hours_per_day);
        return sum + (Number.isFinite(hours) && hours > 0 ? hours : 2);
      }, 0);
      // After reducing project hours, would training alone still block this course?
      const gapAfterProjectOverride = Math.max(0, ava - trainingOnlyHours);
      const trainingBlocksSlot = overlapping.length > 0
        && gapAfterProjectOverride < hoursPerDay - 0.05;

      const entry = ensureEntry(employeeId, name);
      entry.days.push(day);
      entry.dayLabels.push(dayLabel);
      if (trainingBlocksSlot) {
        // Only courses that leave no free hours after clearing project work.
        overlapping.forEach((row) => entry.trainingNames.add(row.title || 'Training'));
        entry.kinds.add('training');
      } else {
        // Project override — list project work only (not other trainings on the day).
        dayTasks.forEach((task) => {
          const key = `${task.project_name}|${task.task_name}`;
          entry.tasksByKey.set(key, task);
        });
        entry.kinds.add('project');
      }
      entry.minGap = Math.min(entry.minGap, gap);
      entry.minGapAfterProjectOverride = Math.min(
        entry.minGapAfterProjectOverride ?? 8,
        gapAfterProjectOverride,
      );
    });
  });

  return [...warningsByEmployee.values()].map((entry) => {
    const isTrainingKind = entry.kinds.has('training') && !entry.holiday;
    const tasks = isTrainingKind
      ? []
      : [...(entry.tasksByKey?.values?.() || [])].slice(0, 3);
    const taskLabels = tasks.map((task) => (
      task.project_name
        ? `${task.project_name} — ${task.task_name}`
        : task.task_name
    ));
    const trainingTitles = isTrainingKind || entry.segmentConflict
      ? [...entry.trainingNames].slice(0, 3)
      : [];
    const dayText = entry.dayLabels.length === 1
      ? entry.dayLabels[0]
      : entry.dayLabels.length === 2
        ? entry.dayLabels.join(' and ')
        : `${entry.dayLabels.slice(0, -1).join(', ')} and ${entry.dayLabels.at(-1)}`;

    let occupied = 'planned work';
    if (entry.holiday) {
      occupied = 'a holiday / unavailable day';
    } else if (trainingTitles.length) {
      occupied = `existing training (${trainingTitles.join(', ')})`;
    } else if (taskLabels.length) {
      occupied = `planned work (${taskLabels.join(', ')})`;
    }

    const sectionLabel = entry.conflictSection || trainingDaySegmentLabel(daySegment);

    return {
      id: entry.id,
      employeeId: entry.employeeId,
      employeeName: entry.employeeName,
      days: entry.days,
      dayLabels: entry.dayLabels,
      // Hard-block when day-section overlaps or training alone leaves no free hours.
      kind: entry.holiday
        ? 'holiday'
        : (entry.kinds.has('training') ? 'training' : 'project'),
      holiday: entry.holiday,
      segmentConflict: Boolean(entry.segmentConflict),
      tasks,
      trainings: trainingTitles,
      message: entry.holiday
        ? `${entry.employeeName} is on holiday or unavailable on ${dayText}. Training cannot be booked on (H) days.`
        : entry.segmentConflict
          ? `${entry.employeeName} already has training in ${sectionLabel} on ${dayText} (${trainingTitles.join(', ') || 'existing course'}). Choose another day section.`
          : entry.kinds.has('training')
            ? `${entry.employeeName} has no free slot on ${dayText} — existing training (${trainingTitles.join(', ') || 'course'}) leaves only ${entry.minGap.toFixed(1)}h free even if project hours are reduced.`
            : `${entry.employeeName} already has ${occupied} on ${dayText} — only ${entry.minGap.toFixed(1)}h gap available. Confirm override to reduce project hours and free a slot.`,
    };
  });
}

export function employeeInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase();
  }
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function employeeChipColor(name) {
  const palette = ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4'];
  let hash = 0;
  const text = String(name || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = text.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

/** Normalize one training record from the API for reliable date compares. */
export function normalizeTrainingRecord(training) {
  if (!training || typeof training !== 'object') {
    return training;
  }
  return {
    ...training,
    start_date: toYmd(training.start_date) || training.start_date,
    end_date: toYmd(training.end_date) || training.end_date || toYmd(training.start_date),
    day_segment: normalizeTrainingDaySegment(training.day_segment, 0),
  };
}

export function normalizeTrainingRecords(trainings = []) {
  if (!Array.isArray(trainings)) {
    return [];
  }
  return trainings.map(normalizeTrainingRecord);
}
