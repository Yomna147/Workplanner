import { addDays, parseYmd } from '../components/gantt/ganttUtils';
import { closestGapWindowInRange } from './trainingGapNotifications';
import { addWorkingDaysFromYmd, trainingWorkingDayCount } from './trainingForm';

export const INCOMPLETE_TRAINING_STATUSES = new Set([
  'not_started',
  'scheduled',
  'in_progress',
  'almost_complete',
]);

export function isTrainingIncomplete(training) {
  const status = String(training?.status || '').trim();
  return status !== 'completed' && status !== '';
}

export function findDueIncompleteTrainings(trainings = [], todayYmd = null) {
  const today = todayYmd || parseYmd(new Date());
  const todayStr = String(today).slice(0, 10);

  return (trainings || []).filter((training) => {
    if (!isTrainingIncomplete(training)) {
      return false;
    }

    const start = String(training?.start_date ?? '').slice(0, 10);
    if (!start || start > todayStr) {
      return false;
    }

    return true;
  }).sort((left, right) => (
    String(left.start_date ?? '').localeCompare(String(right.start_date ?? ''))
    || String(left.title ?? '').localeCompare(String(right.title ?? ''))
  ));
}

/** Keep the original slot length (e.g. 1 day / 2h) instead of stretching across the whole gap. */
export function fitGapWindowToTrainingSlot(window, training) {
  if (!window?.start_date) {
    return null;
  }

  const slotDays = Math.max(1, trainingWorkingDayCount(training) || 1);
  const windowDays = Math.max(1, trainingWorkingDayCount({
    start_date: window.start_date,
    end_date: window.end_date || window.start_date,
  }) || 1);
  const days = Math.min(slotDays, windowDays);
  let endDate = addWorkingDaysFromYmd(window.start_date, days);
  if (window.end_date && String(endDate) > String(window.end_date)) {
    endDate = window.end_date;
  }

  return {
    start_date: window.start_date,
    end_date: endDate,
    gapHours: window.gapHours,
  };
}

export function suggestRescheduleWindow({
  training,
  employee,
  employees = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  trainings = [],
  lookaheadDays = 56,
}) {
  if (!employee || !training) {
    return null;
  }

  const today = parseYmd(new Date());
  const endYmd = addDays(today, lookaheadDays);

  const rowName = [employee.first_name, employee.last_name].filter(Boolean).join(' ')
    || employee.name
    || '';

  const otherTrainings = (trainings || []).filter((row) => (
    String(row.id) !== String(training.id)
    && String(row.employee_id) === String(employee.id)
  ));

  const hoursNeeded = Number(training.hours_per_day);
  const window = closestGapWindowInRange({
    rowName,
    startYmd: today,
    endYmd,
    dailyHours,
    availabilityHours,
    employeeHolidays,
    employees,
    fromYmd: today,
    trainings: otherTrainings,
  });

  const fitted = fitGapWindowToTrainingSlot(window, training);
  if (!fitted) {
    return null;
  }

  // Prefer a day that actually has enough free hours for this training's duration.
  if (Number.isFinite(hoursNeeded) && hoursNeeded > 0 && fitted.start_date) {
    fitted.gapHours = Math.min(
      Number(fitted.gapHours) || hoursNeeded,
      hoursNeeded,
    );
  }

  return fitted;
}
