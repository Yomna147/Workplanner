import { employeeDisplayName } from './employeeNames';
import {
  dayCapacityForRow,
  isEmployeeHolidayDay,
  isWeekend,
  lookupDayHoursForRow,
} from '../components/gantt/ganttUtils';
import {
  TRAINING_DEFAULT_DURATION,
  TRAINING_DEFAULT_HOURS_PER_DAY,
  applyTrainingSingleDaySlot,
  firstFreeTrainingDaySegment,
  linkedPriorityForUrgency,
  linkedUrgencyForPriority,
} from './trainingForm';
import {
  TRAINING_URGENCY_DATE_HINTS,
  suggestTrainingDatesForUrgency,
} from './trainingGapNotifications';
import { mergeTrainingHoursIntoDailyHours, overlappingTrainingsOnDay } from './trainingOccupancy';

export function employeeHasAvailabilityOnDay(
  employee,
  day,
  availabilityHours,
  employeeHolidays,
  employees,
) {
  if (!employee || !day) {
    return true;
  }
  if (isWeekend(day)) {
    return false;
  }

  const name = employeeDisplayName(employee);
  if (isEmployeeHolidayDay(name, day, employeeHolidays, employees)) {
    return false;
  }

  const capacity = dayCapacityForRow(name, day, availabilityHours, employeeHolidays, employees);
  if (capacity == null || capacity <= 0.05) {
    return false;
  }
  return true;
}

export function dayHasEnoughTrainingGap(
  employee,
  day,
  hoursPerDay,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
) {
  if (!employeeHasAvailabilityOnDay(
    employee,
    day,
    availabilityHours,
    employeeHolidays,
    employees,
  )) {
    return false;
  }

  const name = employeeDisplayName(employee);
  const booked = lookupDayHoursForRow(dailyHours, name, day, employees) ?? 0;
  const capacity = dayCapacityForRow(name, day, availabilityHours, employeeHolidays, employees);
  if (capacity == null) {
    return false;
  }
  const gap = Math.max(0, capacity - booked);
  return gap >= Math.max(0.25, Number(hoursPerDay) || 1) - 0.05;
}

export function isDateDisabledForSelectedEmployees(
  day,
  employeeIds,
  employees,
  availabilityHours,
  employeeHolidays,
  {
    dailyHours = {},
    hoursPerDay = 1,
    requireFreeGap = true,
  } = {},
) {
  if (!day || !employeeIds?.length) {
    return false;
  }

  return employeeIds.some((employeeId) => {
    const employee = employees.find((entry) => String(entry.id) === String(employeeId));
    if (!employee) {
      return false;
    }
    if (requireFreeGap) {
      return !dayHasEnoughTrainingGap(
        employee,
        day,
        hoursPerDay,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        employees,
      );
    }
    return !employeeHasAvailabilityOnDay(
      employee,
      day,
      availabilityHours,
      employeeHolidays,
      employees,
    );
  });
}

function todayYmdLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Dates that cannot be picked for training.
 * Past days, weekends and holidays are always blocked.
 * Days with no free AVA slot after existing training are blocked.
 * Project-occupied days with a free training slot stay selectable; full project days
 * stay selectable so the project-hour override confirm flow can run.
 */
export function buildTrainingDateDisabledChecker({
  employeeIds = [],
  employees = [],
  urgency = 'U1',
  hoursPerDay = 8,
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  trainings = [],
  ignoreTrainingId = null,
  allowPastDates = false,
  /** When true, also block days without enough free gap (legacy). Default false = allow project override. */
  requireFreeGap = false,
}) {
  const today = todayYmdLocal();
  const mustHaveFreeGap = requireFreeGap || false;
  // urgency kept for callers; free-gap blocking is opt-in so project override remains possible.
  void urgency;

  const excludeIds = ignoreTrainingId != null ? [ignoreTrainingId] : [];
  const occupancyHours = mergeTrainingHoursIntoDailyHours(
    dailyHours,
    trainings,
    employees,
    {
      excludeIds,
      employeeHolidays,
    },
  );

  return (day) => {
    if (!day) {
      return true;
    }
    if (!allowPastDates && String(day).slice(0, 10) < today) {
      return true;
    }
    if (isWeekend(day)) {
      return true;
    }

    if (!employeeIds?.length) {
      return false;
    }

    // Block days where existing training alone leaves no free slot (project override cannot help).
    const noFreeTrainingSlot = employeeIds.some((employeeId) => {
      const overlapping = overlappingTrainingsOnDay(trainings, employeeId, day, { excludeIds });
      if (overlapping.length === 0) {
        return false;
      }
      const employee = employees.find((entry) => String(entry.id) === String(employeeId));
      if (!employee) {
        return false;
      }
      const name = employeeDisplayName(employee);
      if (isEmployeeHolidayDay(name, day, employeeHolidays, employees)) {
        return true;
      }
      const avaRaw = lookupDayHoursForRow(availabilityHours, name, day, employees);
      const ava = avaRaw == null ? 8 : Number(avaRaw);
      const trainingOnlyHours = overlapping.reduce((sum, row) => {
        const hours = Number(row.hours_per_day);
        return sum + (Number.isFinite(hours) && hours > 0 ? hours : 2);
      }, 0);
      const gapAfterProjectOverride = Math.max(0, ava - trainingOnlyHours);
      return gapAfterProjectOverride < hoursPerDay - 0.05;
    });
    if (noFreeTrainingSlot) {
      return true;
    }

    return isDateDisabledForSelectedEmployees(
      day,
      employeeIds,
      employees,
      availabilityHours,
      employeeHolidays,
      {
        dailyHours: mustHaveFreeGap ? occupancyHours : dailyHours,
        hoursPerDay,
        requireFreeGap: mustHaveFreeGap,
      },
    );
  };
}

function noSuggestionHint(urgency, employeeCount, duration) {
  if (employeeCount > 1) {
    return duration === 'Multi-day'
      ? 'No shared 2+ day free stretch for all selected operatives. Pick dates manually or remove someone.'
      : 'No shared free day for all selected operatives. Pick dates manually or remove someone.';
  }

  return duration === 'Multi-day'
    ? 'No 2+ day free stretch found for Multi-day. Pick dates manually or choose a shorter duration.'
    : 'No suitable dates found for this urgency. Pick dates manually.';
}

/**
 * Auto-fill start/end (and linked priority/urgency) from AVA gaps — same rules as New training modal.
 */
export function applyTrainingAutoSchedule({
  draft,
  employeeIds = [],
  employees = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  trainings = [],
  autoChoose = true,
  urgency: urgencyOverride = null,
  priority: priorityOverride = null,
}) {
  const urgency = urgencyOverride ?? draft?.urgency ?? 'U1';
  const priority = priorityOverride ?? linkedPriorityForUrgency(urgency);
  const duration = TRAINING_DEFAULT_DURATION;
  const syncedDraft = applyTrainingSingleDaySlot({ ...draft, priority, urgency, duration });
  const nextHours = TRAINING_DEFAULT_HOURS_PER_DAY;

  if (!autoChoose) {
    return {
      draft: syncedDraft,
      hint: TRAINING_URGENCY_DATE_HINTS[urgency] || '',
    };
  }

  const selected = employeeIds
    .map((id) => employees.find((entry) => String(entry.id) === String(id)))
    .filter(Boolean);

  if (selected.length === 0) {
    return {
      draft: syncedDraft,
      hint: `${TRAINING_URGENCY_DATE_HINTS[urgency] || ''} Select an operative to auto-fill dates.`,
    };
  }

  const selectedIds = new Set(selected.map((entry) => String(entry.id)));
  const occupancyHours = mergeTrainingHoursIntoDailyHours(
    dailyHours,
    trainings,
    employees,
    {
      excludeIds: draft?.id ? [draft.id] : [],
      employeeHolidays,
    },
  );
  const suggestion = suggestTrainingDatesForUrgency({
    urgency,
    selectedEmployees: selected,
    employees,
    duration,
    hoursPerDay: nextHours,
    dailyHours: occupancyHours,
    availabilityHours,
    employeeHolidays,
    trainings: trainings.filter((row) => {
      const id = String(row.employee_id ?? row.employee?.id ?? '');
      return !id || selectedIds.has(id);
    }),
  });

  if (!suggestion || String(suggestion.start_date || '').slice(0, 10) < todayYmdLocal()) {
    return {
      draft: syncedDraft,
      hint: noSuggestionHint(urgency, selected.length, duration),
    };
  }

  const suggestedDay = String(suggestion.start_date).slice(0, 10);
  const daySegment = firstFreeTrainingDaySegment({
    trainings,
    employeeIds: selected.map((entry) => entry.id),
    day: suggestedDay,
    hoursPerDay: nextHours,
    ignoreTrainingId: draft?.id ?? null,
  });

  return {
    draft: applyTrainingSingleDaySlot({
      ...syncedDraft,
      priority,
      urgency,
      duration,
      start_date: suggestedDay,
      end_date: suggestedDay,
      day_segment: daySegment,
      confirm_override: false,
    }, suggestedDay),
    hint: suggestion.hint,
  };
}

export function applyTrainingAutoScheduleFromPriority({
  draft,
  priority,
  employeeIds,
  employees,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  trainings,
  autoChoose = true,
}) {
  const urgency = linkedUrgencyForPriority(priority);

  return applyTrainingAutoSchedule({
    draft: { ...draft, priority, urgency },
    employeeIds,
    employees,
    dailyHours,
    availabilityHours,
    employeeHolidays,
    trainings,
    autoChoose,
    urgency,
    priority,
  });
}

export function collectRosterEmployeeIds(rows = []) {
  return rows
    .map((row) => row?.employee_id)
    .filter((id) => id != null && id !== '')
    .map(String);
}

export function pruneInvalidTrainingDates(draft, isDateDisabled) {
  if (!draft || typeof isDateDisabled !== 'function') {
    return draft;
  }

  let next = draft;
  if (draft.start_date && isDateDisabled(draft.start_date)) {
    next = { ...next, start_date: '', end_date: '' };
  } else if (draft.start_date) {
    next = { ...next, end_date: draft.start_date };
  } else if (draft.end_date && isDateDisabled(draft.end_date)) {
    next = { ...next, end_date: '' };
  }
  return next;
}
