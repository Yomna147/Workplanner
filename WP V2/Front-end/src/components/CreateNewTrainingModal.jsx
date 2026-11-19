import { useEffect, useMemo, useRef, useState } from 'react';
import DisplayDateInput from './DisplayDateInput';
import TrainingDaySegmentPicker from './TrainingDaySegmentPicker';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { getApiErrorMessage, getApiErrorDetails } from '../utils/apiErrors';
import { employeeDisplayName, employeeTeamName } from '../utils/employeeNames';
import { compareTeamNames, sortEmployeesByTeamThenName } from '../utils/teamOrder';
import {
  TRAINING_DEFAULT_DURATION,
  TRAINING_DEFAULT_HOURS_PER_DAY,
  TRAINING_PRIORITY_OPTIONS,
  TRAINING_STATUS_OPTIONS,
  TRAINING_URGENCY_OPTIONS,
  applyTrainingSingleDaySlot,
  buildTrainingConflictWarnings,
  employeeChipColor,
  employeeInitials,
  linkedPriorityForUrgency,
  linkedUrgencyForPriority,
  occupiedTrainingDaySegments,
  firstFreeTrainingDaySegment,
} from '../utils/trainingForm';
import {
  buildSessionDefaultsFromCourse,
  buildTrainingCourseOptions,
  findTrainingCourseById,
  isEmployeeAssignedToCourse,
} from '../utils/trainingCourses';
import {
  TRAINING_URGENCY_DATE_HINTS,
} from '../utils/trainingGapNotifications';
import { persistTrainingRecord, formatTrainingCreatedAt, trainingFreedProjectHours } from '../utils/trainingSaveGuard';
import { useTrainingOccupiedSlotGate } from '../hooks/useTrainingOccupiedSlotGate.jsx';
import {
  applyTrainingAutoSchedule,
  buildTrainingDateDisabledChecker,
} from '../utils/trainingScheduleLogic';
import { toStorageDate } from '../utils/dateFormat';

function todayYmd() {
  return toStorageDate(new Date());
}

/** Keep only today-or-later dates for create suggestions/prefills. */
function futureOrEmptyDate(value, { allowPast = false } = {}) {
  const day = String(value || '').slice(0, 10);
  if (!day) {
    return '';
  }
  if (allowPast || day >= todayYmd()) {
    return day;
  }
  return '';
}

function emptyTrainingForm(defaults = {}, { allowPastDates = false } = {}) {
  const start = futureOrEmptyDate(
    defaults.start_date || defaults.end_date || '',
    { allowPast: allowPastDates },
  );
  return applyTrainingSingleDaySlot({
    title: defaults.title || '',
    training_course_id: defaults.training_course_id || '',
    course_link: '',
    description: '',
    duration: TRAINING_DEFAULT_DURATION,
    hours_per_day: TRAINING_DEFAULT_HOURS_PER_DAY,
    status: 'not_started',
    priority: 'P2',
    urgency: 'U1',
    start_date: start,
    end_date: start,
    employee_ids: (defaults.employee_ids || []).map(String),
    confirm_override: false,
  }, start || null);
}

function normalizeInitialValues(initialValues = {}) {
  if (!initialValues) {
    return {};
  }

  const employeeIds = initialValues.employee_ids ?? initialValues.employeeIds ?? [];
  const isEdit = Boolean(initialValues.id || initialValues.created_at);
  const start = futureOrEmptyDate(
    initialValues.start_date || initialValues.startDate || '',
    { allowPast: isEdit },
  );
  const end = futureOrEmptyDate(
    initialValues.end_date || initialValues.endDate || start,
    { allowPast: isEdit },
  );

  return {
    id: initialValues.id || null,
    created_at: initialValues.created_at || null,
    start_date: start,
    end_date: end || start,
    employee_ids: employeeIds.map(String),
  };
}

function groupEmployeesForPicker(employees = []) {
  const byTeam = new Map();
  employees.forEach((employee) => {
    const teamName = employeeTeamName(employee) || 'No team';
    if (!byTeam.has(teamName)) {
      byTeam.set(teamName, []);
    }
    byTeam.get(teamName).push(employee);
  });

  return [...byTeam.entries()]
    .sort(([left], [right]) => compareTeamNames(left, right))
    .map(([teamName, members]) => ({
      teamName,
      members: sortEmployeesByTeamThenName(members),
    }));
}

function ChoiceChips({ options, value, onChange, name }) {
  return (
    <div className="training-choice-chips" role="radiogroup" aria-label={name}>
      {options.map((option) => {
        const emphasis = option.value === 'P0' || option.value === 'P1'
          || option.value === 'U2' || option.value === 'U3';
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={`training-choice-chip${value === option.value ? ' is-selected' : ''}${emphasis ? ' is-emphasis' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default function CreateNewTrainingModal({
  open,
  onClose,
  onSuccess,
  employees = [],
  trainingCourses = [],
  existingTrainings = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  bars = [],
  initialValues = null,
}) {
  const toast = useToast();
  const { user } = useAuth();
  const { runWithOccupiedSlotGuard, modal: occupiedSlotModal, awaitingOverride } = useTrainingOccupiedSlotGate();
  const [form, setForm] = useState(emptyTrainingForm());
  const pickerRef = useRef(null);
  const touchedFieldsRef = useRef(new Set());
  const employeeIdsRef = useRef([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [urgencyDateHint, setUrgencyDateHint] = useState('');
  const [autoChoosePriorityUrgency, setAutoChoosePriorityUrgency] = useState(true);

  const setFormPreservingEmployees = (updater) => {
    setForm((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      const preservedIds = (next?.employee_ids ?? current.employee_ids ?? employeeIdsRef.current ?? [])
        .map(String)
        .filter(Boolean);
      employeeIdsRef.current = preservedIds;
      return {
        ...next,
        employee_ids: preservedIds,
      };
    });
  };

  const courseOptions = useMemo(
    () => buildTrainingCourseOptions(trainingCourses),
    [trainingCourses],
  );

  const initialKey = useMemo(() => {
    if (!initialValues) {
      return '';
    }
    const normalized = normalizeInitialValues(initialValues);
    return JSON.stringify(normalized);
  }, [initialValues]);

  const scheduledTrainings = existingTrainings;

  useEffect(() => {
    if (!open) {
      return;
    }
    const normalized = initialKey ? JSON.parse(initialKey) : {};
    const isEdit = Boolean(normalized.id || normalized.created_at);
    let base = emptyTrainingForm(normalized, { allowPastDates: isEdit });
    touchedFieldsRef.current = new Set(
      Object.entries(normalized)
        .filter(([key, value]) => {
          if (key === 'id' || key === 'created_at') {
            return false;
          }
          return Array.isArray(value) ? value.length > 0 : Boolean(value);
        })
        .map(([key]) => key),
    );
    employeeIdsRef.current = (base.employee_ids || []).map(String);

    // Create flow: never keep/suggest past dates — auto-pick from today when we have trainees.
    if (!isEdit && base.employee_ids.length > 0 && !base.start_date) {
      touchedFieldsRef.current.delete('start_date');
      touchedFieldsRef.current.delete('end_date');
      const { draft, hint } = applyTrainingAutoSchedule({
        draft: base,
        employeeIds: base.employee_ids,
        employees,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        trainings: existingTrainings,
        autoChoose: true,
        urgency: base.urgency,
        priority: base.priority,
      });
      base = draft;
      setUrgencyDateHint(hint || '');
    } else if (!isEdit && base.employee_ids.length > 0 && base.start_date) {
      // Prefill with a suggested day (e.g. notification Assign) — pick first free section.
      const daySegment = firstFreeTrainingDaySegment({
        trainings: existingTrainings,
        employeeIds: base.employee_ids,
        day: base.start_date,
        hoursPerDay: TRAINING_DEFAULT_HOURS_PER_DAY,
      });
      base = applyTrainingSingleDaySlot({
        ...base,
        day_segment: daySegment,
      }, base.start_date);
      setUrgencyDateHint('');
    } else {
      setUrgencyDateHint('');
    }

    setForm(base);
    setError('');
    setAutoChoosePriorityUrgency(true);
    // Only re-init when the modal opens or the intended initial values change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- avoid resetting drafts on histogram refresh
  }, [open, initialKey]);

  useEffect(() => {
    employeeIdsRef.current = (form.employee_ids || []).map(String);
  }, [form.employee_ids]);

  const markTouched = (...keys) => {
    keys.forEach((key) => {
      if (key) {
        touchedFieldsRef.current.add(key);
      }
    });
  };

  const handleCourseChange = (courseId) => {
    setError('');

    const course = findTrainingCourseById(trainingCourses, courseId);
    if (!course) {
      setFormPreservingEmployees((current) => ({
        ...current,
        training_course_id: '',
        title: touchedFieldsRef.current.has('title') ? current.title : '',
        course_link: '',
        description: '',
      }));
      touchedFieldsRef.current.delete('course_link');
      touchedFieldsRef.current.delete('description');
      return;
    }

    const defaults = buildSessionDefaultsFromCourse(course);
    setFormPreservingEmployees((current) => {
      const touched = touchedFieldsRef.current;
      const keep = (key) => (touched.has(key) ? current[key] : defaults[key]);
      const day = current.start_date || current.end_date || '';
      return applyTrainingSingleDaySlot({
        ...current,
        training_course_id: defaults.training_course_id != null
          ? String(defaults.training_course_id)
          : '',
        title: keep('title') || defaults.title,
        course_link: keep('course_link') ?? '',
        description: keep('description') ?? '',
        duration: TRAINING_DEFAULT_DURATION,
        hours_per_day: TRAINING_DEFAULT_HOURS_PER_DAY,
        priority: (touched.has('priority') || touched.has('urgency'))
          ? current.priority
          : defaults.priority,
        urgency: (touched.has('priority') || touched.has('urgency'))
          ? current.urgency
          : defaults.urgency,
        status: keep('status'),
        employee_ids: current.employee_ids,
        start_date: day,
        end_date: day,
      }, day || null);
    });
  };

  const hoursPerDay = TRAINING_DEFAULT_HOURS_PER_DAY;

  const assignedByDisplay = useMemo(() => {
    const names = new Set();
    const addName = (value) => {
      const name = String(value || '').trim();
      if (name) {
        names.add(name);
      }
    };

    addName(initialValues?.assigned_by_name);
    (initialValues?.assignments || []).forEach((row) => addName(row?.assigned_by_name));

    if (names.size > 0) {
      return [...names].join(', ');
    }

    if (initialValues?.id || initialValues?.created_at) {
      return '—';
    }

    return String(user?.name || '').trim() || '—';
  }, [initialValues, user?.name]);

  const handlePriorityChange = (priority) => {
    markTouched('priority', 'urgency');
    if (!autoChoosePriorityUrgency) {
      setFormPreservingEmployees((current) => ({ ...current, priority }));
      return;
    }
    const urgency = linkedUrgencyForPriority(priority);
    applyUrgencyDateSuggestion(urgency, { priority });
  };

  const handleUrgencyChange = (urgency) => {
    markTouched('urgency', 'priority');
    if (!autoChoosePriorityUrgency) {
      setFormPreservingEmployees((current) => ({ ...current, urgency }));
      setUrgencyDateHint(TRAINING_URGENCY_DATE_HINTS[urgency] || '');
      return;
    }
    applyUrgencyDateSuggestion(urgency);
  };

  const handleAutoChoosePriorityUrgencyChange = (checked) => {
    setAutoChoosePriorityUrgency(checked);
    if (!checked) {
      setUrgencyDateHint('Priority and urgency are not linked while auto-choose is off.');
      return;
    }
    applyUrgencyDateSuggestion(form.urgency, { forceAutoChoose: true });
  };

  const buildAutoScheduledForm = (current, urgency, options = {}) => {
    const employeeIds = (options.employeeIds ?? current.employee_ids ?? []).map(String);
    const priority = options.priority ?? linkedPriorityForUrgency(urgency);
    const { draft, hint } = applyTrainingAutoSchedule({
      draft: applyTrainingSingleDaySlot({
        ...current,
        employee_ids: employeeIds,
        duration: TRAINING_DEFAULT_DURATION,
        hours_per_day: TRAINING_DEFAULT_HOURS_PER_DAY,
        priority,
        urgency,
      }),
      employeeIds,
      employees,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      trainings: scheduledTrainings,
      autoChoose: true,
      urgency,
      priority,
    });

    const day = draft.start_date || draft.end_date || '';
    return {
      draft: applyTrainingSingleDaySlot({
        ...draft,
        employee_ids: employeeIds,
      }, day || null),
      hint,
    };
  };

  const applyUrgencyDateSuggestion = (urgency, options = {}) => {
    const shouldAutoChoose = options.forceAutoChoose ?? autoChoosePriorityUrgency;
    if (!shouldAutoChoose) {
      return;
    }
    setFormPreservingEmployees((current) => {
      const { draft, hint } = buildAutoScheduledForm(current, urgency, {
        ...options,
        employeeIds: options.employeeIds ?? current.employee_ids ?? employeeIdsRef.current,
      });
      setUrgencyDateHint(hint);
      return draft;
    });
  };

  const conflicts = useMemo(
    () => {
      if (!open) {
        return [];
      }
      return buildTrainingConflictWarnings({
        employeeIds: form.employee_ids,
        employees,
        startDate: form.start_date,
        endDate: form.end_date,
        hoursPerDay,
        daySegment: form.day_segment ?? 0,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        bars,
        trainings: existingTrainings,
      });
    },
    [
      open,
      form.employee_ids,
      form.start_date,
      form.end_date,
      form.day_segment,
      hoursPerDay,
      employees,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      bars,
      existingTrainings,
    ],
  );

  const occupiedDaySegments = useMemo(() => {
    if (!open || !form.start_date || !(form.employee_ids || []).length) {
      return new Set();
    }
    const occupied = new Set();
    (form.employee_ids || []).forEach((employeeId) => {
      const result = occupiedTrainingDaySegments({
        trainings: existingTrainings,
        employeeId,
        day: form.start_date,
        hoursPerDay,
      });
      result.occupied.forEach((segment) => occupied.add(segment));
    });
    return occupied;
  }, [open, form.start_date, form.employee_ids, existingTrainings, hoursPerDay]);

  const orderedEmployees = useMemo(
    () => sortEmployeesByTeamThenName(employees).filter((entry) => (
      entry?.id != null && String(entry.id) !== ''
    )),
    [employees],
  );

  const selectedEmployees = useMemo(
    () => form.employee_ids.map((id) => {
      const match = orderedEmployees.find((entry) => String(entry.id) === String(id))
        || employees.find((entry) => String(entry.id) === String(id));
      if (match) {
        return match;
      }
      return { id, first_name: `Employee ${id}` };
    }),
    [form.employee_ids, orderedEmployees, employees],
  );

  const selectedCourseRecord = useMemo(() => (
    findTrainingCourseById(trainingCourses, form.training_course_id)
      ?? (form.training_course_id
        ? { id: form.training_course_id, title: form.title }
        : (form.title.trim() ? { title: form.title.trim() } : null))
  ), [trainingCourses, form.training_course_id, form.title]);

  const availableEmployees = useMemo(() => {
    const selected = new Set(form.employee_ids.map(String));
    return orderedEmployees.filter((entry) => {
      const id = String(entry.id);
      if (selected.has(id)) {
        return false;
      }
      if (!selectedCourseRecord) {
        return true;
      }
      return !isEmployeeAssignedToCourse(existingTrainings, id, selectedCourseRecord);
    });
  }, [orderedEmployees, form.employee_ids, selectedCourseRecord, existingTrainings]);

  const groupedAvailableEmployees = useMemo(
    () => groupEmployeesForPicker(availableEmployees),
    [availableEmployees],
  );

  const isTrainingDateDisabled = useMemo(
    () => {
      if (!open) {
        return () => false;
      }
      return buildTrainingDateDisabledChecker({
        employeeIds: form.employee_ids,
        employees,
        urgency: form.urgency,
        hoursPerDay,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        trainings: existingTrainings,
      });
    },
    [
      open,
      form.employee_ids,
      form.urgency,
      employees,
      availabilityHours,
      employeeHolidays,
      dailyHours,
      hoursPerDay,
      existingTrainings,
    ],
  );

  const handleRequestClose = () => {
    if (saving || awaitingOverride) {
      return;
    }
    onClose();
  };

  if (!open) {
    return null;
  }

  const setField = (field, value) => {
    markTouched(field);
    setFormPreservingEmployees((current) => {
      if (field === 'start_date' || field === 'end_date') {
        return applyTrainingSingleDaySlot({ ...current, [field]: value }, value);
      }
      if (field === 'day_segment') {
        return applyTrainingSingleDaySlot({ ...current, day_segment: value }, current.start_date);
      }
      return { ...current, [field]: value };
    });
  };

  const shouldKeepExistingDates = (current) => {
    if (
      touchedFieldsRef.current.has('start_date')
      || touchedFieldsRef.current.has('end_date')
    ) {
      return true;
    }
    const start = String(current.start_date || current.end_date || '').slice(0, 10);
    return Boolean(start && start >= todayYmd());
  };

  const addEmployeeById = (employeeId) => {
    const nextId = String(employeeId || '').trim();
    if (!nextId) {
      return;
    }
    if (selectedCourseRecord && isEmployeeAssignedToCourse(existingTrainings, nextId, selectedCourseRecord)) {
      setError('This operative is already assigned to this training course.');
      return;
    }
    setError('');
    setFormPreservingEmployees((current) => {
      const currentIds = (current.employee_ids || employeeIdsRef.current || []).map(String);
      if (currentIds.includes(nextId)) {
        return current;
      }
      const nextIds = [...currentIds, nextId];
      employeeIdsRef.current = nextIds;
      if (!autoChoosePriorityUrgency || shouldKeepExistingDates(current)) {
        return { ...current, employee_ids: nextIds };
      }
      const { draft, hint } = buildAutoScheduledForm(current, current.urgency, {
        employeeIds: nextIds,
      });
      setUrgencyDateHint(hint);
      return { ...draft, employee_ids: nextIds };
    });
  };

  const removeEmployee = (employeeId) => {
    setFormPreservingEmployees((current) => {
      const nextIds = (current.employee_ids || []).map(String)
        .filter((id) => id !== String(employeeId));
      employeeIdsRef.current = nextIds;
      if (!autoChoosePriorityUrgency || nextIds.length === 0 || shouldKeepExistingDates(current)) {
        if (nextIds.length === 0) {
          setUrgencyDateHint(
            `${TRAINING_URGENCY_DATE_HINTS[current.urgency] || ''} Select an operative to auto-fill dates.`,
          );
        }
        return { ...current, employee_ids: nextIds };
      }
      const { draft, hint } = buildAutoScheduledForm(current, current.urgency, {
        employeeIds: nextIds,
      });
      setUrgencyDateHint(hint);
      return { ...draft, employee_ids: nextIds };
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!form.training_course_id && !form.title.trim()) {
      setError('Select a course from the catalog.');
      return;
    }
    if (!form.title.trim()) {
      setError('Training / consultation name is required.');
      return;
    }
    const selectedIds = (form.employee_ids?.length
      ? form.employee_ids
      : employeeIdsRef.current).map(String).filter(Boolean);
    if (selectedIds.length === 0) {
      setError('Select at least one employee.');
      return;
    }

    const uniqueEmployeeIds = [...new Set(selectedIds)];
    if (uniqueEmployeeIds.length !== (form.employee_ids || []).length) {
      setFormPreservingEmployees((current) => ({ ...current, employee_ids: uniqueEmployeeIds }));
    }
    if (!form.start_date) {
      setError('A training date is required.');
      return;
    }

    if (selectedCourseRecord) {
      const alreadyAssigned = uniqueEmployeeIds.filter((employeeId) => (
        isEmployeeAssignedToCourse(existingTrainings, employeeId, selectedCourseRecord)
      ));
      if (alreadyAssigned.length > 0) {
        setError('One or more operatives are already assigned to this training course.');
        return;
      }
    }

    const holidayConflicts = conflicts.filter((entry) => entry.holiday || entry.kind === 'holiday');
    if (holidayConflicts.length > 0) {
      setError(holidayConflicts[0].message || 'Training cannot be booked on a holiday (H) day.');
      return;
    }

    const overrideConflicts = conflicts.filter((entry) => !entry.holiday && entry.kind !== 'holiday');
    if (overrideConflicts.length > 0 && !form.confirm_override) {
      const hasTraining = overrideConflicts.some((entry) => entry.kind === 'training');
      const hasProject = overrideConflicts.some((entry) => entry.kind === 'project');
      setError(
        hasTraining && hasProject
          ? 'Tick the override box to confirm scheduling over existing training and project hours.'
          : hasTraining
            ? 'Tick the override box to confirm scheduling over existing training.'
            : 'Tick the override box to confirm scheduling over existing project hours.',
      );
      return;
    }

    setError('');

    try {
      const context = {
        employees,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        bars,
        trainings: existingTrainings,
      };
      const rows = uniqueEmployeeIds.map((employeeId) => (
        applyTrainingSingleDaySlot({
          ...form,
          employee_id: Number(employeeId),
        }, form.start_date)
      ));

      const saved = await runWithOccupiedSlotGuard({
        rows,
        context,
        onBusy: setSaving,
        alreadyConfirmed: false,
        save: async (confirmOverride, overrideConflictsList = []) => Promise.all(
          rows.map((row) => {
            const rowConflicts = (Array.isArray(overrideConflictsList) ? overrideConflictsList : [])
              .filter((entry) => String(entry?.employeeId ?? entry?.employee_id ?? '') === String(row.employee_id));
            const rowNeedsOverride = rowConflicts.length > 0;
            return persistTrainingRecord({
              training: row,
              confirmOverride: Boolean(confirmOverride) && rowNeedsOverride,
              context,
              skipClientConflictCheck: true,
              overrideConflicts: (confirmOverride && rowNeedsOverride) ? rowConflicts : [],
            });
          }),
        ),
      });

      onSuccess?.(saved);
      const freed = trainingFreedProjectHours(saved);
      if (freed > 0) {
        toast.success(
          `Training scheduled. Project hours reduced by ${freed.toFixed(1)}h — re-run the algorithm so remaining work is rescheduled.`,
          { duration: 8000 },
        );
      } else {
        toast.success(
          saved.length === 1
            ? 'Training scheduled.'
            : `${saved.length} trainings scheduled.`,
        );
      }
      onClose();
    } catch (err) {
      if (err?.code === 'TRAINING_OVERRIDE_CANCELLED') {
        return;
      }
      const details = getApiErrorDetails(err);
      const message = err?.code === 'TRAINING_HOLIDAY_SLOT' || details.code === 'TRAINING_HOLIDAY_SLOT'
        ? (err.message || details.message || 'Training cannot be booked on a holiday (H) day.')
        : err?.code === 'TRAINING_VALIDATION'
          ? err.message
          : details.code === 'TRAINING_OCCUPIED_SLOT' || details.code === 'TRAINING_TRAINING_CONFLICT'
            ? (details.message || 'Confirm override to schedule over existing training or planned work.')
            : getApiErrorMessage(err, 'Unable to save training.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const modalTitle = form.title.trim()
    || findTrainingCourseById(trainingCourses, form.training_course_id)?.title
    || 'New training';

  return (
    <>
    <div
      className="training-modal-overlay"
      onDoubleClick={handleRequestClose}
      role="presentation"
    >
      <div
        className="training-modal-card"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="training-modal-title"
      >
        <div className="training-modal-header">
          <h2 id="training-modal-title">{modalTitle}</h2>
          <button type="button" className="training-modal-close" onClick={handleRequestClose} aria-label="Close" disabled={saving || awaitingOverride}>
            ×
          </button>
        </div>

        <form className="training-modal-body" onSubmit={handleSubmit}>
          <section className="training-modal-section">
            <h3 className="training-modal-section-title">
              <span className="training-modal-section-icon" aria-hidden="true">🎓</span>
              Training / consultation details
            </h3>

            <label className="training-modal-field">
              <span>Course</span>
              <select
                value={form.training_course_id != null && form.training_course_id !== ''
                  ? String(form.training_course_id)
                  : ''}
                onChange={(e) => handleCourseChange(e.target.value)}
                required
              >
                <option value="">
                  {courseOptions.length === 0 ? 'No courses in catalog' : 'Select a course…'}
                </option>
                {courseOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="training-modal-field">
              <span>Course link</span>
              <input
                type="url"
                value={form.course_link}
                onChange={(e) => setField('course_link', e.target.value)}
                placeholder="https://moodle.example.com/course/view.php?id=42"
              />
            </label>

            <label className="training-modal-field">
              <span>Short description</span>
              <textarea
                rows={3}
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="Introduction to AI applications in QS and MC workflows."
              />
            </label>

            <div className="training-modal-grid-2">
              <div className="training-modal-field training-modal-field--status-row">
                <span>Status</span>
                <div className="training-modal-status-row">
                  <select
                    value={form.status}
                    onChange={(e) => setField('status', e.target.value)}
                    aria-label="Status"
                  >
                    {TRAINING_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <label className="training-modal-auto-choose">
                    <input
                      type="checkbox"
                      checked={autoChoosePriorityUrgency}
                      onChange={(e) => handleAutoChoosePriorityUrgencyChange(e.target.checked)}
                    />
                    <span>Auto-choose priority &amp; urgency</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="training-modal-grid-2">
              <div className="training-modal-field">
                <span>Priority</span>
                <ChoiceChips
                  name="Priority"
                  options={TRAINING_PRIORITY_OPTIONS}
                  value={form.priority}
                  onChange={handlePriorityChange}
                />
              </div>
              <div className="training-modal-field">
                <span>Urgency</span>
                <ChoiceChips
                  name="Urgency"
                  options={TRAINING_URGENCY_OPTIONS}
                  value={form.urgency}
                  onChange={handleUrgencyChange}
                />
                <p className="training-modal-hint training-modal-hint--urgency">
                  {urgencyDateHint || TRAINING_URGENCY_DATE_HINTS[form.urgency]}
                </p>
              </div>
            </div>
          </section>

          <section className="training-modal-section">
            <div className="training-modal-row">
              <span className="training-modal-row-label">Task date</span>
              <div className="training-modal-row-content">
                <div className="training-modal-date-range">
                  <DisplayDateInput
                    value={form.start_date}
                    onChange={(value) => setField('start_date', value)}
                    isDateDisabled={isTrainingDateDisabled}
                    min={todayYmd()}
                  />
                </div>
                <p className="training-modal-hint">
                  Assigns a single 2h slot on one weekday from today onward. Past dates, weekends and holidays are disabled.
                  Days with a free AVA slot stay selectable. If project hours fill the day, confirm override to free a slot. Existing training alone that leaves no free slot cannot be overridden.
                </p>
              </div>
            </div>

            <div className="training-modal-row">
              <span className="training-modal-row-label">Day section</span>
              <div className="training-modal-row-content">
                <TrainingDaySegmentPicker
                  value={form.day_segment}
                  onChange={(segment) => setField('day_segment', segment)}
                  occupiedSegments={occupiedDaySegments}
                />
                <p className="training-modal-hint">
                  Choose which quarter of the workday to book (four 2h sections, same as the histogram day bands).
                  Taken sections are highlighted — saving on a taken section asks for override confirmation.
                </p>
              </div>
            </div>

            <div className="training-modal-row">
              <span className="training-modal-row-label">Employees</span>
              <div className="training-modal-row-content">
                <div className="training-employee-chips">
                  {selectedEmployees.map((employee) => {
                    const name = employeeDisplayName(employee);
                    return (
                      <span key={employee.id} className="training-employee-chip">
                        <span
                          className="training-employee-chip-avatar"
                          style={{ backgroundColor: employeeChipColor(name) }}
                          aria-hidden="true"
                        >
                          {employeeInitials(name)}
                        </span>
                        <span>{name}</span>
                        <button
                          type="button"
                          className="training-employee-chip-remove"
                          onClick={() => removeEmployee(employee.id)}
                          aria-label={`Remove ${name}`}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                  <div className="training-employee-add">
                    <div className="training-employee-picker" ref={pickerRef}>
                      <select
                        className="training-employee-picker-select"
                        value=""
                        onChange={(event) => {
                          const value = event.target.value;
                          event.target.value = '';
                          addEmployeeById(value);
                        }}
                        disabled={orderedEmployees.length === 0}
                        aria-label="Select employee"
                      >
                        <option value="">
                          {orderedEmployees.length === 0
                            ? 'No employees loaded'
                            : availableEmployees.length === 0
                              ? 'All selected'
                              : 'Select employee…'}
                        </option>
                        {groupedAvailableEmployees.map((group) => (
                          <optgroup key={group.teamName} label={group.teamName}>
                            {group.members.map((employee) => (
                              <option key={String(employee.id)} value={String(employee.id)}>
                                {employeeDisplayName(employee)}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {conflicts.length > 0 ? (
              <div
                className={[
                  'training-modal-warnings',
                  conflicts.some((entry) => entry.kind === 'training') ? 'has-training-conflict' : '',
                  conflicts.some((entry) => entry.kind === 'project') ? 'has-project-conflict' : '',
                ].filter(Boolean).join(' ')}
                role="alert"
              >
                <p className="training-modal-warnings-title">Scheduling conflicts</p>
                <ul className="training-modal-warnings-list">
                  {conflicts.map((warning) => {
                    const kind = warning.holiday || warning.kind === 'holiday'
                      ? 'holiday'
                      : warning.kind === 'training'
                        ? 'training'
                        : 'project';
                    const kindLabel = kind === 'holiday'
                      ? 'Holiday'
                      : kind === 'training'
                        ? 'Training'
                        : 'Project';
                    return (
                      <li
                        key={warning.id}
                        className={`training-modal-warning-item is-${kind}`}
                      >
                        <span className="training-modal-warning-icon" aria-hidden="true">!</span>
                        <span className="training-modal-warning-body">
                          <span className={`training-modal-warning-kind is-${kind}`}>
                            {kindLabel}
                          </span>
                          <span>{warning.message}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {conflicts.some((entry) => entry.holiday || entry.kind === 'holiday') ? (
                  <p className="training-modal-hint">
                    Holiday (H) days cannot be overridden. Choose another date.
                  </p>
                ) : (
                  <label
                    className={`training-modal-override${
                      conflicts.some((entry) => entry.kind === 'training')
                        ? ' is-training-override'
                        : ' is-project-override'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(form.confirm_override)}
                      onChange={(event) => setField('confirm_override', event.target.checked)}
                    />
                    <span>
                      {(() => {
                        const hasTraining = conflicts.some((entry) => entry.kind === 'training');
                        const hasProject = conflicts.some((entry) => entry.kind === 'project');
                        if (hasTraining && hasProject) {
                          return 'I confirm override — schedule over existing training and reduce project hours to make room (existing courses are kept).';
                        }
                        if (hasTraining) {
                          return 'I confirm override — schedule over existing training on this day/section (existing courses are kept).';
                        }
                        return 'I confirm override — reduce project hours on those days to make room for training (project tasks are kept).';
                      })()}
                    </span>
                  </label>
                )}
              </div>
            ) : null}
          </section>

          {error ? <div className="alert alert-error" role="alert">{error}</div> : null}

          <div className="training-modal-meta">
            {initialValues?.created_at || initialValues?.id ? (
              <label className="training-modal-field training-modal-field--readonly">
                <span>Created</span>
                <input
                  type="text"
                  value={formatTrainingCreatedAt(initialValues)}
                  readOnly
                  tabIndex={-1}
                />
              </label>
            ) : null}
            <label className="training-modal-field training-modal-field--readonly">
              <span>Assigned by</span>
              <input type="text" value={assignedByDisplay} readOnly tabIndex={-1} />
            </label>
          </div>

          <div className="training-modal-footer">
            <button type="button" className="btn btn-secondary" onClick={handleRequestClose} disabled={saving || awaitingOverride}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || awaitingOverride}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
    {occupiedSlotModal}
    </>
  );
}
