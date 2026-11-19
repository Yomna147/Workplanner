/**
 * Case checks for training duration/hours save derivation + payload rules.
 * Mirrors Front-end/src/utils/trainingForm.js (pure helpers only).
 * Run: node scripts/check-training-save.mjs
 */

const TRAINING_DURATION_OPTIONS = [
  { value: '1-2 hours', totalHours: 2 },
  { value: 'Half day', totalHours: 4 },
  { value: 'Full day', totalHours: 8 },
  { value: 'Multi-day', totalHours: 16 },
];

const TRAINING_DURATION_LEGACY_HOURS = {
  '2-4 hours': 4,
};

function durationToTotalHours(duration) {
  if (TRAINING_DURATION_LEGACY_HOURS[duration] != null) {
    return TRAINING_DURATION_LEGACY_HOURS[duration];
  }
  return TRAINING_DURATION_OPTIONS.find((option) => option.value === duration)?.totalHours ?? 8;
}

function isValidDuration(duration) {
  return TRAINING_DURATION_OPTIONS.some((option) => option.value === duration)
    || Object.prototype.hasOwnProperty.call(TRAINING_DURATION_LEGACY_HOURS, duration);
}

function clampTrainingHoursPerDay(value, fallback = 8) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(24, Math.max(0.25, Math.round(num * 100) / 100));
}

function clampTrainingTotalHours(value, fallback = 8) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(80, Math.max(0.25, Math.round(num * 100) / 100));
}

function trainingWorkingDayCount(training) {
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
    if (day !== 0 && day !== 6) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function hoursPerDayFromTotal(totalHours, training = {}) {
  const total = clampTrainingTotalHours(totalHours, durationToTotalHours(training?.duration));
  const days = Math.max(1, trainingWorkingDayCount(training) || 1);
  return clampTrainingHoursPerDay(total / days);
}

function syncTrainingHoursFromDuration(training) {
  const next = { ...training };
  next.hours_per_day = hoursPerDayFromTotal(durationToTotalHours(next.duration), next);
  return next;
}

function normalizeTrainingCourseUrl(url) {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function getTrainingSaveValidationError(training) {
  if (!String(training?.title ?? '').trim()) return 'Training title is required.';
  const start = String(training?.start_date ?? '').slice(0, 10);
  const end = String(training?.end_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return 'Start and end dates are required.';
  }
  if (end < start) return 'End date must be on or after the start date.';
  if (training?.duration && !isValidDuration(training.duration)) {
    return 'Duration is not a valid option.';
  }
  const hoursPerDay = Number(training?.hours_per_day);
  if (!Number.isFinite(hoursPerDay) || hoursPerDay < 0.25 || hoursPerDay > 24) {
    return 'Hours per day must be between 0.25 and 24.';
  }
  return null;
}

function buildTrainingSavePayload(training, overrides = {}) {
  const merged = syncTrainingHoursFromDuration({ ...training, ...overrides });
  const validationError = getTrainingSaveValidationError(merged);
  if (validationError) {
    const error = new Error(validationError);
    error.code = 'TRAINING_VALIDATION';
    throw error;
  }
  const rawLink = String(merged.course_link ?? '').trim();
  const description = String(merged.description ?? '').trim();
  return {
    title: String(merged.title ?? '').trim(),
    course_link: rawLink ? normalizeTrainingCourseUrl(rawLink) : null,
    description: description || null,
    duration: merged.duration,
    status: merged.status,
    priority: merged.priority,
    urgency: merged.urgency,
    start_date: String(merged.start_date).slice(0, 10),
    end_date: String(merged.end_date).slice(0, 10),
    hours_per_day: merged.hours_per_day,
  };
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}`);
}

function nearlyEqual(a, b, eps = 0.011) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

console.log('\nTraining save case checks\n');

assert(trainingWorkingDayCount({ start_date: '2026-07-20', end_date: '2026-07-20' }) === 1, 'Mon single day = 1');
assert(trainingWorkingDayCount({ start_date: '2026-07-18', end_date: '2026-07-19' }) === 0, 'Sat–Sun = 0 working days');
assert(trainingWorkingDayCount({ start_date: '2026-07-20', end_date: '2026-07-24' }) === 5, 'Mon–Fri = 5');
assert(trainingWorkingDayCount({ start_date: '2026-07-24', end_date: '2026-07-20' }) === 0, 'end < start = 0');

assert(durationToTotalHours('1-2 hours') === 2, '1-2 hours total = 2');
assert(durationToTotalHours('2-4 hours') === 4, 'legacy 2-4 hours total = 4');
assert(durationToTotalHours('Half day') === 4, 'Half day total = 4');
assert(durationToTotalHours('Full day') === 8, 'Full day total = 8');
assert(durationToTotalHours('Multi-day') === 16, 'Multi-day total = 16');

assert(
  nearlyEqual(hoursPerDayFromTotal(16, { start_date: '2026-07-20', end_date: '2026-07-21', duration: 'Multi-day' }), 8),
  'Multi-day over 2 days → 8 h/day',
);
assert(
  nearlyEqual(hoursPerDayFromTotal(16, { start_date: '2026-07-20', end_date: '2026-07-22', duration: 'Multi-day' }), 5.33),
  'Multi-day over 3 days → ~5.33 h/day',
);
assert(
  nearlyEqual(hoursPerDayFromTotal(8, { start_date: '2026-07-20', end_date: '2026-07-24', duration: 'Full day' }), 1.6),
  'Full day (8 total) over 5 days → 1.6 h/day',
);
assert(
  nearlyEqual(hoursPerDayFromTotal(8, { start_date: '2026-07-20', end_date: '2026-07-20', duration: 'Full day' }), 8),
  'Full day single day → 8 h/day',
);
assert(
  nearlyEqual(hoursPerDayFromTotal(16, { start_date: '2026-07-18', end_date: '2026-07-19', duration: 'Multi-day' }), 16),
  'Weekend-only range falls back to 1 day divisor → 16 h/day',
);

const beforeResize = {
  title: 'BIM',
  duration: 'Multi-day',
  status: 'scheduled',
  priority: 'P2',
  urgency: 'U1',
  start_date: '2026-07-20',
  end_date: '2026-07-21',
  hours_per_day: 8,
  course_link: '',
  description: '',
};
const afterResize = syncTrainingHoursFromDuration({
  ...beforeResize,
  end_date: '2026-07-23',
});
assert(nearlyEqual(afterResize.hours_per_day, 4), 'Resize Multi-day 2→4 days syncs to 4 h/day');

const payload = buildTrainingSavePayload({
  ...beforeResize,
  end_date: '2026-07-23',
  course_link: 'learn.example.com/course',
  description: '  notes  ',
});
assert(nearlyEqual(payload.hours_per_day, 4), 'Save payload recomputes hours_per_day');
assert(payload.course_link === 'https://learn.example.com/course', 'course_link gets https://');
assert(payload.description === 'notes', 'description trimmed');
assert(payload.start_date === '2026-07-20' && payload.end_date === '2026-07-23', 'dates preserved');

assert(
  getTrainingSaveValidationError({ ...beforeResize, title: '' }) === 'Training title is required.',
  'Empty title rejected',
);
assert(
  getTrainingSaveValidationError({ ...beforeResize, end_date: '2026-07-19' })
    === 'End date must be on or after the start date.',
  'end < start rejected',
);
assert(
  getTrainingSaveValidationError({ ...beforeResize, start_date: '', end_date: '' })
    === 'Start and end dates are required.',
  'Missing dates rejected',
);
assert(
  getTrainingSaveValidationError({ ...beforeResize, duration: 'All week' })
    === 'Duration is not a valid option.',
  'Invalid duration rejected',
);

let threw = false;
try {
  buildTrainingSavePayload({ ...beforeResize, title: '   ' });
} catch (err) {
  threw = err?.code === 'TRAINING_VALIDATION';
}
assert(threw, 'buildTrainingSavePayload throws TRAINING_VALIDATION on bad title');

const halfPayload = buildTrainingSavePayload({
  ...beforeResize,
  duration: 'Half day',
  start_date: '2026-07-20',
  end_date: '2026-07-20',
  hours_per_day: 99,
});
assert(halfPayload.duration === 'Half day', 'Half day preset preserved on save');
assert(nearlyEqual(halfPayload.hours_per_day, 4), 'Half day single day → 4 h/day');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
