import api from '../api/client';
import {
  buildDailyHoursFromBars,
  filterLiteralHistogramBars,
} from '../components/gantt/ganttUtils';
import { buildTrainingConflictWarnings, buildTrainingSavePayload } from './trainingForm';
import { isUnsavedTrainingRow } from './trainingCourses';
import { showSaveNotifications } from './taskSyncNotifications';

export function buildTrainingConflictContext(histogram, employees = [], trainings = []) {
  if (!histogram) {
    return null;
  }

  const bars = filterLiteralHistogramBars(Array.isArray(histogram.bars) ? histogram.bars : []);

  return {
    employees: Array.isArray(histogram.employees) && histogram.employees.length > 0
      ? histogram.employees
      : employees,
    dailyHours: buildDailyHoursFromBars(bars),
    availabilityHours: histogram.availability_hours ?? {},
    employeeHolidays: histogram.employee_holidays ?? {},
    bars,
    trainings: Array.isArray(trainings) ? trainings : [],
  };
}

export function getTrainingOccupiedSlotConflicts(training, context) {
  if (!context || !training?.employee_id) {
    return [];
  }

  const hoursPerDay = Number(training.hours_per_day);
  const resolvedHours = Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay : 8;

  return buildTrainingConflictWarnings({
    employeeIds: [String(training.employee_id)],
    employees: context.employees,
    startDate: training.start_date,
    endDate: training.end_date,
    hoursPerDay: resolvedHours,
    daySegment: training.day_segment ?? 0,
    dailyHours: context.dailyHours,
    availabilityHours: context.availabilityHours,
    employeeHolidays: context.employeeHolidays,
    bars: context.bars,
    trainings: context.trainings || [],
    ignoreTrainingId: training.id,
  });
}

export function trainingScheduleFieldsChanged(training, previous) {
  if (!previous) {
    return true;
  }

  return String(training.employee_id) !== String(previous.employee_id)
    || String(training.start_date).slice(0, 10) !== String(previous.start_date).slice(0, 10)
    || String(training.end_date).slice(0, 10) !== String(previous.end_date).slice(0, 10)
    || Number(training.hours_per_day) !== Number(previous.hours_per_day)
    || Number(training.day_segment ?? 0) !== Number(previous.day_segment ?? 0);
}

/** Sum of project hours freed by training override saves (0 when training-on-training only). */
export function trainingFreedProjectHours(result) {
  const rows = Array.isArray(result) ? result : (result ? [result] : []);
  return rows.reduce((sum, row) => sum + (Number(row?.project_hours_displaced) || 0), 0);
}

export function isTrainingVsTrainingConflict(conflict) {
  if (!conflict || conflict.holiday || conflict.kind === 'holiday') {
    return false;
  }
  // Only hard-block when kind is training (training alone leaves no free slot).
  // Project+training days that can free a slot via override stay kind "project".
  return conflict.kind === 'training';
}

export function assertTrainingOverrideAllowed({
  training,
  context,
  confirmOverride = false,
  previous = null,
}) {
  if (!trainingScheduleFieldsChanged(training, previous)) {
    return { conflicts: [], needsOverride: false };
  }

  const allConflicts = getTrainingOccupiedSlotConflicts(training, context);
  const holidayConflicts = allConflicts.filter((entry) => entry.holiday || entry.kind === 'holiday');
  if (holidayConflicts.length > 0) {
    const error = new Error(
      holidayConflicts[0]?.message
        || 'Training cannot be booked on a holiday (H) day.',
    );
    error.code = 'TRAINING_HOLIDAY_SLOT';
    error.conflicts = holidayConflicts;
    throw error;
  }

  const conflicts = allConflicts.filter((entry) => !entry.holiday && entry.kind !== 'holiday');
  if (conflicts.length > 0 && !confirmOverride) {
    const hasTraining = conflicts.some(isTrainingVsTrainingConflict);
    const error = new Error(
      hasTraining
        ? 'Confirm override to schedule over existing training or planned work.'
        : 'Confirm override to schedule training over existing planned work.',
    );
    error.code = 'TRAINING_OCCUPIED_SLOT';
    error.conflicts = conflicts;
    throw error;
  }

  return {
    conflicts,
    needsOverride: conflicts.length > 0,
  };
}

export function formatTrainingCreatedAt(training) {
  const raw = training?.created_at;
  if (!raw) {
    return '—';
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return String(raw);
  }

  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function rethrowOccupiedSlotApiError(error) {
  const data = error?.response?.data;
  if (error?.response?.status === 422 && data?.code === 'TRAINING_HOLIDAY_SLOT') {
    const wrapped = new Error(
      data.message || 'Training cannot be booked on a holiday (H) day.',
    );
    wrapped.code = 'TRAINING_HOLIDAY_SLOT';
    wrapped.conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    throw wrapped;
  }
  if (error?.response?.status === 422 && data?.code === 'TRAINING_TRAINING_CONFLICT') {
    // Legacy API code — treat as an overridable occupied-slot conflict.
    const wrapped = new Error(
      data.message || 'Confirm override to schedule over existing training or planned work.',
    );
    wrapped.code = 'TRAINING_OCCUPIED_SLOT';
    wrapped.conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    throw wrapped;
  }
  if (error?.response?.status === 422 && data?.code === 'TRAINING_OCCUPIED_SLOT') {
    const wrapped = new Error(
      data.message || 'Confirm override to schedule training over existing planned work or training.',
    );
    wrapped.code = 'TRAINING_OCCUPIED_SLOT';
    wrapped.conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
    throw wrapped;
  }

  throw error;
}

export async function persistTrainingRecord({
  training,
  overrides = {},
  confirmOverride = false,
  previous = null,
  context = null,
  skipClientConflictCheck = false,
  overrideConflicts = null,
}) {
  const merged = { ...training, ...overrides };

  if (context && !skipClientConflictCheck) {
    assertTrainingOverrideAllowed({
      training: merged,
      context,
      confirmOverride,
      previous,
    });
  }

  const conflictsForAudit = Array.isArray(overrideConflicts)
    ? overrideConflicts
    : (confirmOverride && context
      ? getTrainingOccupiedSlotConflicts(merged, context)
        .filter((entry) => !entry.holiday && entry.kind !== 'holiday')
      : []);

  // A stored override only carries over while the slot is unchanged; a moved
  // slot needs a fresh confirmation, and an unchanged one must not re-log (F-02).
  const baseline = previous ?? (isUnsavedTrainingRow(training) ? null : training);
  const keepStoredOverride = Boolean(merged.confirm_override)
    && Boolean(baseline)
    && !trainingScheduleFieldsChanged(merged, baseline);
  const effectiveOverride = Boolean(confirmOverride) || keepStoredOverride;

  const payload = buildTrainingSavePayload(training, {
    ...overrides,
    confirm_override: effectiveOverride,
    ...(confirmOverride && conflictsForAudit.length > 0
      ? { override_conflicts: conflictsForAudit }
      : {}),
  });

  try {
    if (merged.id && !isUnsavedTrainingRow(merged)) {
      const response = await api.put(`/trainings/${merged.id}`, payload);
      showSaveNotifications(response.data?.notifications);
      return {
        ...(response.data?.data ?? {}),
        project_hours_displaced: Number(response.data?.project_hours_displaced) || 0,
        suggest_algorithm_rerun: Boolean(response.data?.suggest_algorithm_rerun),
        displacement_message: response.data?.message || null,
      };
    }

    const response = await api.post('/trainings', {
      ...payload,
      employee_id: Number(merged.employee_id),
    });
    if (response.data?.skipped) {
      const duplicateError = new Error('This operative is already assigned to this training course.');
      duplicateError.code = 'TRAINING_VALIDATION';
      throw duplicateError;
    }
    showSaveNotifications(response.data?.notifications);
    return {
      ...(response.data?.data ?? {}),
      project_hours_displaced: Number(response.data?.project_hours_displaced) || 0,
      suggest_algorithm_rerun: Boolean(response.data?.suggest_algorithm_rerun),
      displacement_message: response.data?.message || null,
    };
  } catch (error) {
    if (error?.code === 'TRAINING_HOLIDAY_SLOT'
      || error?.code === 'TRAINING_TRAINING_CONFLICT'
      || error?.code === 'TRAINING_OCCUPIED_SLOT') {
      throw error;
    }
    const data = error?.response?.data;
    if (error?.response?.status === 422 && (
      data?.code === 'TRAINING_HOLIDAY_SLOT'
      || data?.code === 'TRAINING_TRAINING_CONFLICT'
      || data?.code === 'TRAINING_OCCUPIED_SLOT'
    )) {
      rethrowOccupiedSlotApiError(error);
    }
    if (error?.response?.status === 422) {
      const duplicateError = new Error(
        error.response?.data?.message || 'This operative is already assigned to this training course.',
      );
      duplicateError.code = 'TRAINING_VALIDATION';
      throw duplicateError;
    }
    rethrowOccupiedSlotApiError(error);
  }
}

export function collectOccupiedSlotConflicts(rows, context, originalsById = new Map()) {
  const all = [];

  (rows || []).forEach((row) => {
    const previous = originalsById.get(String(row.id)) ?? null;
    if (!trainingScheduleFieldsChanged(row, previous)) {
      return;
    }

    const conflicts = getTrainingOccupiedSlotConflicts(row, context);
    const holiday = conflicts.find((entry) => entry.holiday || entry.kind === 'holiday');
    if (holiday) {
      const error = new Error(
        holiday.message || 'Training cannot be booked on a holiday (H) day.',
      );
      error.code = 'TRAINING_HOLIDAY_SLOT';
      error.conflicts = conflicts.filter((entry) => entry.holiday || entry.kind === 'holiday');
      throw error;
    }

    conflicts.forEach((conflict) => {
      if (conflict.holiday || conflict.kind === 'holiday') {
        return;
      }
      if (!all.some((entry) => entry.id === conflict.id && entry.message === conflict.message)) {
        all.push(conflict);
      }
    });
  });

  return all;
}
