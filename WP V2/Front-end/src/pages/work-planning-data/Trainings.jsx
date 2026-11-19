import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { showSaveNotifications } from '../../utils/taskSyncNotifications';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { scrollHistogramToDay } from '../../components/gantt/SyncedHorizontalScroll';
import HistogramChartRefreshOverlay from '../../components/gantt/HistogramChartRefreshOverlay';
import PageHeader from '../../components/PageHeader';
import TrainingsGapHistogramView from '../../components/gantt/TrainingsGapHistogramView';
import CreateNewTrainingModal from '../../components/CreateNewTrainingModal';
import DeleteConfirmModal from '../../components/DeleteConfirmModal';
import TrainingGapNotifyBanner from '../../components/TrainingGapNotifyBanner';
import { resolveTrainingLogNavigationTarget } from '../../utils/trainingActivityLog';
import {
  dlTrainingUrl,
  trainingOpenDestination,
  trainingOpenTitle,
  trainingRosterParams,
} from '../../utils/trainingNavigation';
import ActivityLogModal from '../../components/ActivityLogModal';
import TrainingEmployeeGrid, { applyTrainingFieldChange } from '../../components/TrainingEmployeeGrid';
import TrainingCourseCatalogModal from '../../components/TrainingCourseCatalogModal';
import { trainingRosterSections } from '../../constants/trainingFields';
import { TrainingsPageSkeleton, TaskGridSkeleton } from '../../components/PageSkeleton';
import {
  buildDailyHoursFromBars,
  buildEmployeeBarIndex,
  defaultHistogramDateRange,
  filterHistogramByTeam,
  filterLiteralHistogramBars,
  sumEmployeeGapHoursInRange,
} from '../../components/gantt/ganttUtils';
import TrainingsGapDetailPanel from '../../components/gantt/TrainingsGapDetailPanel';
import TrainingsGapSessionList from '../../components/gantt/TrainingsGapSessionList';
import { employeeDisplayName, employeeTeamName } from '../../utils/employeeNames';
import { findEmployeeById, isTrainee } from '../../utils/employeeTrainee';
import { buildAllocationOrderedEmployeeIds } from '../../utils/teamOrder';
import { formatDisplayDate, toStorageDate } from '../../utils/dateFormat';
import {
  TRAINING_DEFAULT_HOURS_PER_DAY,
  TRAINING_STATUS_OPTIONS,
  applyTrainingSingleDaySlot,
  linkedUrgencyForPriority,
  normalizeTrainingRecord,
  normalizeTrainingRecords,
  tryOpenTrainingCourseLink,
} from '../../utils/trainingForm';
import {
  formatTrainingSessionLabel,
  annotateTrainingSessionLegend,
  buildTrainingSessionLegendLookup,
  groupTrainingsBySession,
  trainingOverlapsViewRange,
  trainingSessionKey,
} from '../../utils/trainingGroups';
import {
  buildTrainingDeleteModalCopy,
  resolveTrainingAssignmentDeleteTarget,
  resolveTrainingSessionDeleteTarget,
} from '../../utils/trainingDeleteConfirm';
import {
  buildGapNotificationFingerprint,
  buildTrainingGapOpportunities,
  countUnreadGapNotifications,
  dismissGapNotification,
  isGapNotificationDismissed,
  markGapNotificationsRead,
  mergeHistogramEmployees,
  nextWeeksDateRange,
  TRAINING_GAP_NOTIFY_MIN_HOURS,
} from '../../utils/trainingGapNotifications';
import { subscribeGapReadStateChanged } from '../../utils/trainingGapNotifyStorage';
import {
  canEditNotifications,
  canPageAction,
  canViewNotifications,
  isDlUser,
} from '../../utils/userPermissions';
import { useTrainingOccupiedSlotGate } from '../../hooks/useTrainingOccupiedSlotGate.jsx';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import {
  getTrainingOccupiedSlotConflicts,
  persistTrainingRecord,
  trainingFreedProjectHours,
  trainingScheduleFieldsChanged,
} from '../../utils/trainingSaveGuard';
import {
  buildSessionDefaultsFromCourse,
  buildTraineeOptions,
  buildTrainingCourseOptions,
  emptyTraineeRow,
  findTrainingCourseById,
  getTraineeOptionsForRow,
  isEmployeeAssignedToCourse,
  isUnsavedTrainingRow,
  resolveCourseIdForSession,
  sessionMatchesCourse,
} from '../../utils/trainingCourses';
import {
  applyTrainingAutoSchedule,
  buildTrainingDateDisabledChecker,
  pruneInvalidTrainingDates,
} from '../../utils/trainingScheduleLogic';
import { mergeTrainingHoursIntoDailyHours } from '../../utils/trainingOccupancy';

function parseYmd(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function formatYmd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function defaultRange() {
  return defaultHistogramDateRange();
}

const DEFAULT_MIN_GAP_HOURS = 1;
const TRAINING_VIEW_GAPS = 'gaps';
const TRAINING_VIEW_ROSTER = 'roster';
const ROSTER_AUTO_SCHEDULE_KEYS = new Set(['employee_id', 'urgency', 'priority']);
const ROSTER_FROZEN_FIELD_KEYS = ['employee_id'];
const DL_ROSTER_EDITABLE_FIELD_KEYS = new Set([
  'employee_id',
  'course_link',
  'description',
  'status',
  'priority',
  'urgency',
]);

function statusLabel(value) {
  return TRAINING_STATUS_OPTIONS.find((opt) => opt.value === value)?.label ?? value;
}

function rosterRowSignature(row) {
  return JSON.stringify({
    id: String(row?.id ?? ''),
    employee_id: String(row?.employee_id ?? ''),
    start_date: String(row?.start_date ?? '').slice(0, 10),
    end_date: String(row?.end_date ?? '').slice(0, 10),
    day_segment: Number(row?.day_segment ?? 0),
    duration: row?.duration ?? '',
    hours_per_day: Number(row?.hours_per_day) || 0,
    status: row?.status ?? '',
    priority: row?.priority ?? '',
    urgency: row?.urgency ?? '',
    description: String(row?.description ?? ''),
    course_link: String(row?.course_link ?? ''),
  });
}

function isRosterRowDirty(row, originals) {
  if (!row?.employee_id) {
    return false;
  }
  if (isUnsavedTrainingRow(row)) {
    return true;
  }
  const original = originals.get(String(row.id));
  if (!original) {
    return true;
  }
  return rosterRowSignature(row) !== rosterRowSignature(original);
}

export default function Trainings() {
  const toast = useToast();
  const { user } = useAuth();
  const canAssignTrainings = canPageAction(user, 'Trainings', 'assign');
  const canDeleteTraining = canPageAction(user, 'Trainings', 'delete');
  const canManageCourses = canPageAction(user, 'Trainings', 'manage_courses');
  const canViewTrainingLog = canPageAction(user, 'Trainings', 'view_activity_log');
  const { runWithOccupiedSlotGuard, modal: occupiedSlotModal } = useTrainingOccupiedSlotGate();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [histogram, setHistogram] = useState(null);
  const [trainings, setTrainings] = useState([]);
  const [teams, setTeams] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState(null);
  const [statusSavingId, setStatusSavingId] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalInitial, setModalInitial] = useState(null);
  const [rosterRows, setRosterRows] = useState([]);
  const [savingRoster, setSavingRoster] = useState(false);
  // Navigation deferred until the planner confirms discarding unsaved roster edits.
  const [pendingRosterDiscard, setPendingRosterDiscard] = useState(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [gapDetailPanel, setGapDetailPanel] = useState(null);
  const [gapNotifyDismissed, setGapNotifyDismissed] = useState(false);
  const [gapNotifyReadTick, setGapNotifyReadTick] = useState(0);
  const [showActivityLogModal, setShowActivityLogModal] = useState(false);
  const [showCourseCatalogModal, setShowCourseCatalogModal] = useState(false);
  const [trainingCourses, setTrainingCourses] = useState([]);
  const [rosterScheduleHint, setRosterScheduleHint] = useState('');
  const [extendMode, setExtendMode] = useState(false);
  const dataCacheRef = useRef({ hasHistogram: false, hasTrainings: false });
  const rosterOriginalRef = useRef(new Map());
  const staticDataLoadedRef = useRef(false);

  const viewMode = searchParams.get('view') === TRAINING_VIEW_ROSTER
    ? TRAINING_VIEW_ROSTER
    : TRAINING_VIEW_GAPS;
  const selectedCourseId = searchParams.get('course') || '';
  const focusedGapSessionKey = searchParams.get('session') || '';
  const focusedTrainingId = searchParams.get('training') || '';

  const defaults = useMemo(() => defaultRange(), []);
  const startDate = searchParams.get('start') || defaults.start;
  const endDate = searchParams.get('end') || defaults.end;
  const teamId = searchParams.get('team') || '';
  const minGapHours = Number(searchParams.get('minGap') || String(DEFAULT_MIN_GAP_HOURS));
  const showTrainingSchedule = searchParams.get('showSchedule') !== '0';

  const viewRange = useMemo(
    () => ({ start: startDate, end: endDate }),
    [startDate, endDate],
  );

  const endDateMax = useMemo(() => {
    const start = parseYmd(startDate);
    if (!start) return '';
    return formatYmd(addDays(start, 365));
  }, [startDate]);

  const updateParam = useCallback(
    (key, value) => {
      const next = new URLSearchParams(searchParams);
      if (value === '' || value == null) {
        next.delete(key);
      } else {
        next.set(key, String(value));
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const updateParams = useCallback(
    (patch = {}) => {
      const next = new URLSearchParams(searchParams);
      Object.entries(patch).forEach(([key, value]) => {
        if (value === '' || value == null) {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      });
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const handleResetFilters = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollHistogramToDay(toStorageDate(new Date()));
      });
    });
  }, [setSearchParams]);

  const upcomingGapRange = useMemo(() => nextWeeksDateRange(), []);

  const loadData = useCallback(async ({ background = false, forceStatic = false } = {}) => {
    if (background) {
      setViewLoading(true);
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const trainingParams = viewMode === TRAINING_VIEW_ROSTER
        ? {}
        : { start: startDate, end: endDate };
      const histStart = startDate <= upcomingGapRange.start ? startDate : upcomingGapRange.start;
      const histEnd = endDate >= upcomingGapRange.end ? endDate : upcomingGapRange.end;
      const loadStatic = forceStatic || !staticDataLoadedRef.current;

      const requests = [
        api.get('/resource-histogram', {
          params: { start: histStart, end: histEnd },
        }),
        api.get('/trainings', { params: trainingParams }),
      ];
      if (loadStatic) {
        requests.push(
          api.get('/teams'),
          api.get('/employees'),
          api.get('/training-courses'),
        );
      }

      const [histRes, trainingRes, teamsRes, employeesRes, coursesRes] = await Promise.all(requests);
      setHistogram(histRes.data?.data ?? null);
      setTrainings(normalizeTrainingRecords(
        Array.isArray(trainingRes.data?.data) ? trainingRes.data.data : [],
      ));
      if (loadStatic) {
        setTeams(Array.isArray(teamsRes.data?.data) ? teamsRes.data.data : []);
        setEmployees(Array.isArray(employeesRes.data?.data) ? employeesRes.data.data : []);
        setTrainingCourses(Array.isArray(coursesRes.data?.data) ? coursesRes.data.data : []);
        staticDataLoadedRef.current = true;
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to load trainings data.'));
    } finally {
      if (background) {
        setViewLoading(false);
      } else {
        setLoading(false);
      }
      setHasLoadedOnce(true);
    }
  }, [viewMode, startDate, endDate, upcomingGapRange.end, upcomingGapRange.start]);

  useEffect(() => {
    dataCacheRef.current.hasHistogram = histogram != null;
    dataCacheRef.current.hasTrainings = trainings.length > 0;
  }, [histogram, trainings.length]);

  useEffect(() => {
    const background = viewMode === TRAINING_VIEW_ROSTER
      ? dataCacheRef.current.hasTrainings
      : dataCacheRef.current.hasHistogram;
    loadData({ background });
  }, [viewMode, startDate, endDate, loadData]);

  const fullHistogramSchedule = useMemo(() => {
    if (!histogram) {
      return null;
    }
    const bars = filterLiteralHistogramBars(Array.isArray(histogram.bars) ? histogram.bars : []);
    return {
      bars,
      dailyHours: buildDailyHoursFromBars(bars),
      availabilityHours: histogram.availability_hours ?? {},
      employeeHolidays: histogram.employee_holidays ?? {},
      employees: Array.isArray(histogram.employees) ? histogram.employees : [],
    };
  }, [histogram]);

  const teamFiltered = useMemo(() => {
    if (!fullHistogramSchedule) {
      return {
        employees: [],
        bars: [],
        dailyHours: {},
        availabilityHours: {},
        employeeHolidays: {},
      };
    }

    return filterHistogramByTeam({
      teamId,
      employees: fullHistogramSchedule.employees,
      bars: fullHistogramSchedule.bars,
      dailyHours: fullHistogramSchedule.dailyHours,
      availabilityHours: fullHistogramSchedule.availabilityHours,
      employeeHolidays: fullHistogramSchedule.employeeHolidays,
    });
  }, [fullHistogramSchedule, teamId]);

  const occupancyDailyHours = useMemo(
    () => mergeTrainingHoursIntoDailyHours(
      teamFiltered.dailyHours,
      trainings,
      employees.length > 0 ? employees : teamFiltered.employees,
      { employeeHolidays: teamFiltered.employeeHolidays },
    ),
    [teamFiltered.dailyHours, teamFiltered.employeeHolidays, teamFiltered.employees, trainings, employees],
  );

  const trainingConflictContext = useMemo(() => {
    if (!fullHistogramSchedule) {
      return null;
    }

    return {
      employees: teamFiltered.employees.length > 0 ? teamFiltered.employees : employees,
      dailyHours: teamFiltered.dailyHours,
      availabilityHours: teamFiltered.availabilityHours,
      employeeHolidays: teamFiltered.employeeHolidays,
      bars: teamFiltered.bars,
      trainings,
    };
  }, [employees, fullHistogramSchedule, teamFiltered, trainings]);

  const rosterScheduleContext = useMemo(() => {
    if (!fullHistogramSchedule) {
      return null;
    }

    return {
      employees,
      dailyHours: fullHistogramSchedule.dailyHours,
      availabilityHours: fullHistogramSchedule.availabilityHours,
      employeeHolidays: fullHistogramSchedule.employeeHolidays,
      bars: fullHistogramSchedule.bars,
      trainings,
    };
  }, [fullHistogramSchedule, employees, trainings]);

  const trainingsByEmployee = useMemo(() => {
    const map = new Map();
    trainings.forEach((training) => {
      const id = String(training.employee_id);
      if (!map.has(id)) {
        map.set(id, []);
      }
      map.get(id).push(training);
    });
    return map;
  }, [trainings]);

  const trainingGroups = useMemo(
    () => annotateTrainingSessionLegend(groupTrainingsBySession(trainings, trainingCourses)),
    [trainings, trainingCourses],
  );

  const trainingGroupsByKey = useMemo(() => {
    const map = new Map();
    trainingGroups.forEach((group) => {
      map.set(group.key, group);
    });
    return map;
  }, [trainingGroups]);

  const gapViewTrainingGroups = useMemo(() => (
    trainingGroups.filter((group) => {
      const sessionStart = String(group.start_date ?? '').slice(0, 10);
      const sessionEnd = String(group.end_date ?? '').slice(0, 10) || sessionStart;
      if (!sessionStart) {
        return false;
      }
      return sessionEnd >= startDate && sessionStart <= endDate;
    })
  ), [trainingGroups, startDate, endDate]);

  const sessionLegendLookup = useMemo(
    () => buildTrainingSessionLegendLookup(gapViewTrainingGroups),
    [gapViewTrainingGroups],
  );

  const focusedGapSessionGroup = useMemo(
    () => gapViewTrainingGroups.find((group) => group.key === focusedGapSessionKey) ?? null,
    [gapViewTrainingGroups, focusedGapSessionKey],
  );

  useEffect(() => {
    if (viewMode !== TRAINING_VIEW_GAPS || gapViewTrainingGroups.length === 0) {
      return;
    }

    const stillValid = focusedGapSessionKey
      && gapViewTrainingGroups.some((group) => group.key === focusedGapSessionKey);
    if (focusedGapSessionKey && !stillValid) {
      updateParam('session', '');
    }
  }, [viewMode, gapViewTrainingGroups, focusedGapSessionKey, updateParam]);

  useEffect(() => {
    if (viewMode !== TRAINING_VIEW_GAPS || !focusedGapSessionGroup?.start_date) {
      return;
    }

    const day = String(focusedGapSessionGroup.start_date).slice(0, 10);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollHistogramToDay(day);
      });
    });
  }, [focusedGapSessionGroup?.key, focusedGapSessionGroup?.start_date, viewMode]);

  useEffect(() => {
    if (viewMode !== TRAINING_VIEW_GAPS) {
      setGapDetailPanel(null);
    }
  }, [viewMode]);

  const courseOptions = useMemo(
    () => buildTrainingCourseOptions(trainingCourses),
    [trainingCourses],
  );

  useEffect(() => {
    if (!selectedCourseId) {
      return;
    }
    const stillListed = courseOptions.some((option) => String(option.value) === String(selectedCourseId));
    if (!stillListed && trainingCourses.length > 0) {
      updateParam('course', '');
    }
  }, [selectedCourseId, courseOptions, trainingCourses.length, updateParam]);

  const selectedCourse = useMemo(() => {
    if (!selectedCourseId) {
      return null;
    }
    // Only treat active catalogue options as selected so inactive/stale IDs
    // do not leave Open course link pointing at an old course.
    const inOptions = courseOptions.some((option) => String(option.value) === String(selectedCourseId));
    if (!inOptions) {
      return null;
    }
    return findTrainingCourseById(trainingCourses, selectedCourseId);
  }, [trainingCourses, selectedCourseId, courseOptions]);

  const selectedTrainingGroup = useMemo(() => {
    if (!selectedCourse) {
      return null;
    }

    const matched = trainingGroups.find((group) => (
      String(group.training_course_id ?? '') === String(selectedCourse.id)
    )) ?? null;

    if (matched) {
      return {
        ...matched,
        title: selectedCourse.title || matched.title,
        course_link: selectedCourse.course_link || matched.course_link,
        description: selectedCourse.description ?? matched.description,
      };
    }

    return {
      key: `course:${selectedCourse.id}`,
      ...buildSessionDefaultsFromCourse(selectedCourse),
      start_date: '',
      end_date: '',
      assignments: [],
    };
  }, [trainingGroups, selectedCourse]);

  const selectedCourseKey = selectedCourse?.id != null ? String(selectedCourse.id) : '';
  const remoteRosterSnapshotRef = useRef({ signature: '', assignments: [] });
  const remoteRosterSignature = useMemo(() => {
    const assignments = selectedTrainingGroup?.assignments ?? [];
    const signature = assignments.map((row) => rosterRowSignature(row)).join('|');
    if (signature !== remoteRosterSnapshotRef.current.signature) {
      remoteRosterSnapshotRef.current = {
        signature,
        assignments: assignments.map((row) => ({ ...row })),
      };
    }
    return signature;
  }, [selectedTrainingGroup]);

  useEffect(() => {
    if (viewMode !== TRAINING_VIEW_ROSTER || !selectedCourseKey) {
      if (viewMode === TRAINING_VIEW_ROSTER && !selectedCourseKey) {
        setRosterRows([]);
        rosterOriginalRef.current = new Map();
        remoteRosterSnapshotRef.current = { signature: '', assignments: [] };
      }
      return;
    }

    const assignments = remoteRosterSnapshotRef.current.assignments;
    setRosterRows(assignments.map((row) => ({ ...row })));
    rosterOriginalRef.current = new Map(
      assignments.map((row) => [String(row.id), { ...row }]),
    );
  }, [viewMode, selectedCourseKey, remoteRosterSignature]);

  useEffect(() => {
    if (viewMode !== TRAINING_VIEW_ROSTER || courseOptions.length === 0 || selectedCourseId) {
      return;
    }

    // Opened for a specific training (e.g. from an operative panel): show that training's course.
    const focusedTraining = focusedTrainingId
      ? trainings.find((row) => String(row.id) === String(focusedTrainingId))
      : null;
    if (focusedTrainingId && !focusedTraining && trainings.length === 0) {
      return;
    }

    const inferredCourseId = focusedTraining
      ? resolveCourseIdForSession(focusedTraining, trainingCourses)
      : (trainingGroups.length > 0
        ? resolveCourseIdForSession(trainingGroups[0], trainingCourses)
        : '');
    if (inferredCourseId && courseOptions.some((option) => option.value === inferredCourseId)) {
      updateParam('course', inferredCourseId);
    }
  }, [
    viewMode,
    courseOptions,
    selectedCourseId,
    focusedTrainingId,
    trainings,
    trainingGroups,
    trainingCourses,
    updateParam,
  ]);

  const setViewMode = useCallback(
    (nextView) => {
      const next = new URLSearchParams(searchParams);
      if (nextView === TRAINING_VIEW_GAPS) {
        next.delete('view');
        next.delete('training');
        next.delete('course');
      } else {
        next.set('view', TRAINING_VIEW_ROSTER);
        next.delete('session');
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const traineeOptions = useMemo(
    () => buildTraineeOptions(employees),
    [employees],
  );

  const sessionDefaults = useMemo(
    () => buildSessionDefaultsFromCourse(selectedCourse),
    [selectedCourse],
  );

  const courseAssignedEmployeeIds = useMemo(() => {
    if (!selectedCourse) {
      return [];
    }
    const rosterAssignmentIds = new Set(
      rosterRows.map((row) => String(row?.id ?? '')).filter(Boolean),
    );
    const blocked = new Set();
    (trainings ?? []).forEach((assignment) => {
      if (!sessionMatchesCourse(assignment, selectedCourse)) {
        return;
      }
      if (assignment.id && rosterAssignmentIds.has(String(assignment.id))) {
        return;
      }
      const employeeId = String(assignment.employee_id ?? '').trim();
      if (employeeId) {
        blocked.add(employeeId);
      }
    });
    return [...blocked];
  }, [rosterRows, selectedCourse, trainings]);

  const employeeOptionsForRow = useCallback(
    (rowIndex, row) => getTraineeOptionsForRow(
      traineeOptions,
      rosterRows,
      rowIndex,
      row?.employee_id,
      courseAssignedEmployeeIds,
    ),
    [courseAssignedEmployeeIds, traineeOptions, rosterRows],
  );

  const handleRosterFieldChange = useCallback((rowIndex, key, value) => {
    const shouldAutoSchedule = ROSTER_AUTO_SCHEDULE_KEYS.has(key);
    let blockedReason = '';

    setRosterRows((current) => {
      if (key === 'employee_id' && value) {
        const duplicate = current.some((row, index) => (
          index !== rowIndex && String(row.employee_id) === String(value)
        ));
        if (duplicate) {
          blockedReason = 'This operative is already assigned to this training course.';
          return current;
        }
        const currentRow = current[rowIndex];
        if (selectedCourse && isEmployeeAssignedToCourse(
          trainings,
          value,
          selectedCourse,
          currentRow?.id,
        )) {
          blockedReason = 'This operative is already assigned to this training course.';
          return current;
        }
      }

      const nextRows = current.map((row, index) => {
        if (index !== rowIndex) {
          return row;
        }

        let next = applyTrainingFieldChange(row, key, value);

        if (key === 'employee_id') {
          const employee = findEmployeeById(employees, value);
          next = {
            ...next,
            employee_id: value ? Number(value) : '',
            employee: employee ?? null,
            employee_name: employeeDisplayName(employee),
          };
        }

        return next;
      });

      if (!shouldAutoSchedule || !rosterScheduleContext) {
        return nextRows;
      }

      const draftRow = nextRows[rowIndex];
      if (!draftRow?.employee_id) {
        queueMicrotask(() => setRosterScheduleHint(''));
        return nextRows;
      }

      // Existing assignments keep their date unless the planner edits the date
      // (or swaps the operative). Priority/urgency alone must not reschedule.
      if (!isUnsavedTrainingRow(draftRow) && key !== 'employee_id') {
        return nextRows;
      }

      let scheduleInput = { ...draftRow };
      if (key === 'priority') {
        scheduleInput = {
          ...scheduleInput,
          priority: value,
          urgency: linkedUrgencyForPriority(value),
        };
      }

      const { draft: scheduled, hint } = applyTrainingAutoSchedule({
        draft: scheduleInput,
        employeeIds: [String(draftRow.employee_id)],
        employees: rosterScheduleContext.employees,
        dailyHours: rosterScheduleContext.dailyHours,
        availabilityHours: rosterScheduleContext.availabilityHours,
        employeeHolidays: rosterScheduleContext.employeeHolidays,
        trainings,
        autoChoose: true,
      });

      queueMicrotask(() => setRosterScheduleHint(hint));

      return nextRows.map((row, index) => (
        index === rowIndex
          ? applyTrainingSingleDaySlot({
            ...row,
            start_date: scheduled.start_date,
            end_date: scheduled.start_date,
            priority: scheduled.priority,
            urgency: scheduled.urgency,
            duration: scheduled.duration,
            hours_per_day: TRAINING_DEFAULT_HOURS_PER_DAY,
            confirm_override: false,
          }, scheduled.start_date)
          : row
      ));
    });

    if (blockedReason) {
      toast.error(blockedReason);
    }
  }, [employees, rosterScheduleContext, selectedCourse, toast, trainings]);

  const dateDisabledCheckerCacheRef = useRef({ context: null, map: new Map() });
  const isDateDisabledForRow = useCallback(
    (rowIndex, row) => {
      if (!rosterScheduleContext || !row?.employee_id) {
        return null;
      }

      const cache = dateDisabledCheckerCacheRef.current;
      if (cache.context !== rosterScheduleContext) {
        cache.context = rosterScheduleContext;
        cache.map = new Map();
      }

      const cacheKey = `${row.employee_id}|${row.urgency ?? 'U1'}`;
      if (!cache.map.has(cacheKey)) {
        cache.map.set(cacheKey, buildTrainingDateDisabledChecker({
          employeeIds: [String(row.employee_id)],
          employees: rosterScheduleContext.employees,
          urgency: row.urgency ?? 'U1',
          hoursPerDay: TRAINING_DEFAULT_HOURS_PER_DAY,
          dailyHours: rosterScheduleContext.dailyHours,
          availabilityHours: rosterScheduleContext.availabilityHours,
          employeeHolidays: rosterScheduleContext.employeeHolidays,
        }));
      }

      return cache.map.get(cacheKey);
    },
    [rosterScheduleContext],
  );

  const scheduleHintForRow = useCallback(
    () => rosterScheduleHint,
    [rosterScheduleHint],
  );

  useEffect(() => {
    if (viewMode !== TRAINING_VIEW_ROSTER || !rosterScheduleContext) {
      return;
    }

    setRosterRows((current) => {
      let changed = false;
      const next = current.map((row) => {
        if (!row?.employee_id || !isUnsavedTrainingRow(row)) {
          return row;
        }
        const checker = buildTrainingDateDisabledChecker({
          employeeIds: [String(row.employee_id)],
          employees: rosterScheduleContext.employees,
          urgency: row.urgency ?? 'U1',
          hoursPerDay: TRAINING_DEFAULT_HOURS_PER_DAY,
          dailyHours: rosterScheduleContext.dailyHours,
          availabilityHours: rosterScheduleContext.availabilityHours,
          employeeHolidays: rosterScheduleContext.employeeHolidays,
        });
        const pruned = pruneInvalidTrainingDates(row, checker);
        if (pruned !== row) {
          changed = true;
        }
        return pruned;
      });
      return changed ? next : current;
    });
  }, [viewMode, rosterScheduleContext]);

  useEffect(() => {
    if (viewMode !== TRAINING_VIEW_ROSTER) {
      setRosterScheduleHint('');
    }
  }, [viewMode, selectedCourseId]);

  const handleAddTraineeRow = useCallback(() => {
    if (!selectedCourse) {
      return;
    }

    setRosterRows((current) => [...current, emptyTraineeRow(sessionDefaults)]);
  }, [selectedCourse, sessionDefaults]);

  const handleSaveRoster = useCallback(async () => {
    if (!selectedTrainingGroup) {
      return;
    }

    const originals = rosterOriginalRef.current;
    const rowsWithEmployee = rosterRows.filter((row) => row.employee_id);
    if (rowsWithEmployee.length === 0) {
      toast.error('Add at least one operative with dates before saving.');
      return;
    }

    // Only persist rows the planner actually changed — never re-save the whole roster.
    const rowsToSave = rowsWithEmployee.filter((row) => isRosterRowDirty(row, originals));
    if (rowsToSave.length === 0) {
      toast.error('No changes to save.');
      return;
    }

    const missingDates = rowsToSave.some((row) => !row.start_date);
    if (missingDates) {
      toast.error('A training date is required for every trainee.');
      return;
    }

    const employeeIds = rowsWithEmployee.map((row) => String(row.employee_id));
    if (new Set(employeeIds).size !== employeeIds.length) {
      toast.error('The same operative cannot be assigned twice to this course.');
      return;
    }

    setSavingRoster(true);
    try {
      const context = trainingConflictContext || rosterScheduleContext;

      const saved = normalizeTrainingRecords(await runWithOccupiedSlotGuard({
        rows: rowsToSave,
        context,
        originalsById: originals,
        save: async (confirmOverride, overrideConflicts = []) => Promise.all(
          rowsToSave.map((row) => {
            const previous = originals.get(String(row.id)) ?? null;
            const ownConflicts = (context && trainingScheduleFieldsChanged(row, previous)
              ? getTrainingOccupiedSlotConflicts(row, context)
              : []
            ).filter((entry) => !entry?.holiday && entry?.kind !== 'holiday');
            const conflictsForRow = (Array.isArray(overrideConflicts) ? overrideConflicts : [])
              .filter((entry) => String(entry?.employeeId ?? entry?.employee_id ?? '') === String(row.employee_id));
            const rowConflicts = conflictsForRow.length > 0 ? conflictsForRow : ownConflicts;
            const rowNeedsOverride = rowConflicts.length > 0;

            return persistTrainingRecord({
              training: row,
              // Never stamp confirm_override / audit conflicts onto untouched siblings.
              confirmOverride: Boolean(confirmOverride) && rowNeedsOverride,
              previous,
              context,
              skipClientConflictCheck: true,
              overrideConflicts: (confirmOverride && rowNeedsOverride) ? rowConflicts : [],
            });
          }),
        ),
      }));

      if (saved[0]?.training_course_id) {
        updateParam('course', String(saved[0].training_course_id));
      }

      setTrainings((prev) => {
        const next = [...prev];
        saved.forEach((item) => {
          const idx = next.findIndex((row) => row.id === item.id);
          if (idx >= 0) {
            next[idx] = item;
          } else {
            next.unshift(item);
          }
        });
        return next;
      });
      setRosterRows((current) => {
        // Map each dirty source row → API result (Promise.all preserves order).
        const bySource = new Map();
        rowsToSave.forEach((source, index) => {
          const result = saved[index];
          if (result) {
            bySource.set(source, result);
          }
        });
        return current.map((row) => bySource.get(row) ?? (
          !isUnsavedTrainingRow(row)
            ? (saved.find((item) => String(item.id) === String(row.id)) ?? row)
            : row
        ));
      });
      saved.forEach((item) => {
        rosterOriginalRef.current.set(String(item.id), { ...item });
      });
      // Drop originals for unsaved drafts that were just created under a new id.
      rowsToSave.forEach((source) => {
        if (isUnsavedTrainingRow(source) && source.id != null) {
          rosterOriginalRef.current.delete(String(source.id));
        }
      });
      const freedHours = trainingFreedProjectHours(saved);
      toast.success(
        freedHours > 0
          ? 'Training assignments saved. Project hours were reduced to make room — re-run the algorithm so remaining work is rescheduled.'
          : 'Training assignments saved.',
        freedHours > 0 ? { duration: 8000 } : undefined,
      );
      setError('');
    } catch (err) {
      if (err?.code === 'TRAINING_OVERRIDE_CANCELLED') {
        return;
      }
      toast.error(err?.code === 'TRAINING_HOLIDAY_SLOT'
        ? err.message
        : err?.code === 'TRAINING_VALIDATION'
          ? err.message
          : getApiErrorMessage(err, 'Failed to save training assignments.'));
    } finally {
      setSavingRoster(false);
    }
  }, [
    rosterRows,
    rosterScheduleContext,
    runWithOccupiedSlotGuard,
    selectedTrainingGroup,
    toast,
    trainingConflictContext,
    updateParam,
  ]);

  const rosterIsDirty = useMemo(() => {
    const originals = rosterOriginalRef.current;
    const currentIds = new Set(
      rosterRows
        .filter((row) => !isUnsavedTrainingRow(row))
        .map((row) => String(row.id)),
    );
    if ([...originals.keys()].some((id) => !currentIds.has(id))) {
      return true;
    }
    return rosterRows.some((row) => isRosterRowDirty(row, originals));
  }, [rosterRows, selectedTrainingGroup]);

  const rosterHasUnsavedChanges = viewMode === TRAINING_VIEW_ROSTER && rosterIsDirty;

  useUnsavedChangesGuard(
    rosterHasUnsavedChanges,
    'You have unsaved training roster changes. Leave without saving?',
  );

  /** Run `action` now, or after confirming that unsaved roster edits will be lost. */
  const runDiscardingRosterChanges = useCallback((action) => {
    if (!rosterHasUnsavedChanges) {
      action();
      return;
    }
    setPendingRosterDiscard(() => action);
  }, [rosterHasUnsavedChanges]);

  const confirmRosterDiscard = useCallback(() => {
    const action = pendingRosterDiscard;
    setPendingRosterDiscard(null);
    action?.();
  }, [pendingRosterDiscard]);

  const gapViewEmployees = useMemo(() => {
    const employeeById = new Map(
      employees.map((employee) => [String(employee.id), employee]),
    );
    const histogramById = new Map(
      teamFiltered.employees.map((employee) => [String(employee.id), employee]),
    );
    const ids = new Set();

    teamFiltered.employees.forEach((employee) => {
      ids.add(String(employee.id));
    });

    trainings.forEach((training) => {
      if (!trainingOverlapsViewRange(training, startDate, endDate)) {
        return;
      }

      const id = String(training.employee_id);
      if (ids.has(id)) {
        return;
      }

      const fullEmployee = employeeById.get(id);
      if (!fullEmployee) {
        return;
      }

      if (teamId && String(fullEmployee.team_id) !== String(teamId)) {
        return;
      }

      ids.add(id);
    });

    return [...ids]
      .map((id) => histogramById.get(id) ?? employeeById.get(id))
      .filter(Boolean);
  }, [
    employees,
    teamFiltered.employees,
    trainings,
    startDate,
    endDate,
    teamId,
  ]);

  const employeeGapRows = useMemo(() => {
    const employeeById = new Map(
      employees.map((employee) => [String(employee.id), employee]),
    );
    const barIndex = buildEmployeeBarIndex(
      teamFiltered.bars ?? [],
      teamFiltered.employees ?? [],
    );

    const gapByEmployeeId = new Map();
    gapViewEmployees.forEach((histEmp) => {
      const fullEmployee = employeeById.get(String(histEmp.id)) ?? histEmp;
      const name = employeeDisplayName(fullEmployee);
      const employeeTrainings = trainingsByEmployee.get(String(histEmp.id)) || [];
      const hasTrainingInRange = employeeTrainings.some((training) => (
        trainingOverlapsViewRange(training, startDate, endDate)
      ));
      const gapHours = sumEmployeeGapHoursInRange({
        rowName: name,
        startYmd: startDate,
        endYmd: endDate,
        dailyHours: occupancyDailyHours,
        availabilityHours: teamFiltered.availabilityHours,
        employeeHolidays: teamFiltered.employeeHolidays,
        employees: teamFiltered.employees,
      });

      if (gapHours < minGapHours && !hasTrainingInRange) {
        return;
      }

      gapByEmployeeId.set(String(histEmp.id), {
        employeeId: histEmp.id,
        name,
        teamId: fullEmployee.team_id ?? histEmp.team_id ?? null,
        teamName: employeeTeamName(fullEmployee) || employeeTeamName(histEmp) || 'No Team',
        gapHours,
        trainings: employeeTrainings,
        bars: barIndex.get(String(histEmp.id))
          ?? barIndex.get(name)
          ?? [],
      });
    });

    const rowEmployees = [...gapByEmployeeId.keys()]
      .map((id) => employeeById.get(id) ?? teamFiltered.employees.find((emp) => String(emp.id) === id))
      .filter(Boolean);

    const orderedIds = buildAllocationOrderedEmployeeIds(teams, rowEmployees);

    return orderedIds
      .map((id) => gapByEmployeeId.get(String(id)))
      .filter(Boolean);
  }, [
    gapViewEmployees,
    occupancyDailyHours,
    teamFiltered.employees,
    teamFiltered.availabilityHours,
    teamFiltered.employeeHolidays,
    teamFiltered.bars,
    startDate,
    endDate,
    minGapHours,
    trainingsByEmployee,
    employees,
    teams,
  ]);

  const totalGapHours = useMemo(
    () => employeeGapRows.reduce((sum, row) => sum + row.gapHours, 0),
    [employeeGapRows],
  );

  const filteredEmployeeGapRows = useMemo(() => {
    if (!focusedGapSessionGroup) {
      return employeeGapRows;
    }

    const assigneeIds = new Set(
      (focusedGapSessionGroup.assignments || [])
        .filter((assignment) => trainingOverlapsViewRange(assignment, startDate, endDate))
        .map((assignment) => String(assignment.employee_id)),
    );
    return employeeGapRows.filter((row) => assigneeIds.has(String(row.employeeId)));
  }, [employeeGapRows, focusedGapSessionGroup, startDate, endDate]);

  const isTraineeRosterRow = useCallback((row) => {
    const employee = findEmployeeById(employees, row?.employee_id);
    return isTrainee(employee);
  }, [employees]);

  const openCreateModal = useCallback((initial = null) => {
    setModalInitial(initial);
    setModalOpen(true);
  }, []);

  const upcomingGapOpportunities = useMemo(() => {
    if (!histogram) {
      return [];
    }

    return buildTrainingGapOpportunities({
      employees: mergeHistogramEmployees(
        gapViewEmployees.length > 0 ? gapViewEmployees : teamFiltered.employees,
        employees,
      ),
      trainings,
      dailyHours: occupancyDailyHours,
      availabilityHours: teamFiltered.availabilityHours,
      employeeHolidays: teamFiltered.employeeHolidays,
      startYmd: upcomingGapRange.start,
      endYmd: upcomingGapRange.end,
      minGapHours: TRAINING_GAP_NOTIFY_MIN_HOURS,
    });
  }, [
    histogram,
    gapViewEmployees,
    employees,
    trainings,
    occupancyDailyHours,
    teamFiltered.availabilityHours,
    teamFiltered.employeeHolidays,
    teamFiltered.employees,
    upcomingGapRange,
  ]);

  const upcomingGapFingerprint = useMemo(
    () => buildGapNotificationFingerprint(upcomingGapOpportunities, upcomingGapRange),
    [upcomingGapOpportunities, upcomingGapRange],
  );

  const rosterUnreadCount = useMemo(
    () => countUnreadGapNotifications(upcomingGapOpportunities, upcomingGapFingerprint, user?.id),
    [upcomingGapOpportunities, upcomingGapFingerprint, gapNotifyReadTick, user?.id],
  );

  const showGapClosestPopup = useMemo(() => {
    if (!canViewNotifications(user)) {
      return false;
    }
    if (loading || viewLoading) {
      return false;
    }
    if (upcomingGapOpportunities.length === 0) {
      return false;
    }
    if (isGapNotificationDismissed(upcomingGapFingerprint)) {
      return false;
    }
    return !gapNotifyDismissed;
  }, [
    user,
    loading,
    viewLoading,
    gapNotifyDismissed,
    upcomingGapOpportunities.length,
    upcomingGapFingerprint,
  ]);

  useEffect(() => {
    setGapNotifyDismissed(isGapNotificationDismissed(upcomingGapFingerprint));
  }, [upcomingGapFingerprint, user?.id]);

  useEffect(() => subscribeGapReadStateChanged(() => {
    setGapNotifyReadTick((value) => value + 1);
  }), []);

  const handleDismissGapNotification = useCallback(() => {
    setGapNotifyDismissed(true);
    dismissGapNotification(upcomingGapFingerprint);
  }, [upcomingGapFingerprint]);

  const handleOpenGapBell = useCallback(() => {
    markGapNotificationsRead(
      upcomingGapFingerprint,
      upcomingGapOpportunities.map((row) => row.employeeId),
      user?.id,
    );
  }, [upcomingGapFingerprint, upcomingGapOpportunities, user?.id]);

  const handleAssignGapOpportunity = useCallback((opportunity) => {
    if (!opportunity) {
      return;
    }

    markGapNotificationsRead(upcomingGapFingerprint, [opportunity.employeeId], user?.id);

    const window = opportunity.gapWindow;
    openCreateModal({
      employeeIds: [String(opportunity.employeeId)],
      startDate: window?.start_date || upcomingGapRange.start,
      endDate: window?.end_date || window?.start_date || upcomingGapRange.start,
    });
  }, [openCreateModal, upcomingGapFingerprint, upcomingGapRange, user?.id]);

  useEffect(() => {
    const gapAssignId = searchParams.get('gapAssign');
    if (!gapAssignId) {
      return;
    }
    if (loading || !hasLoadedOnce) {
      return;
    }
    if (viewMode !== TRAINING_VIEW_GAPS) {
      const next = new URLSearchParams(searchParams);
      next.set('view', TRAINING_VIEW_GAPS);
      setSearchParams(next, { replace: true });
      return;
    }

    const gapStart = searchParams.get('gapStart') || upcomingGapRange.start;
    const gapEnd = searchParams.get('gapEnd') || gapStart || upcomingGapRange.start;
    const next = new URLSearchParams(searchParams);
    next.delete('gapAssign');
    next.delete('gapStart');
    next.delete('gapEnd');
    setSearchParams(next, { replace: true });

    openCreateModal({
      employeeIds: [String(gapAssignId)],
      startDate: gapStart,
      endDate: gapEnd,
    });
  }, [
    hasLoadedOnce,
    loading,
    openCreateModal,
    searchParams,
    setSearchParams,
    upcomingGapRange.end,
    upcomingGapRange.start,
    viewMode,
  ]);

  const handlePrefillEmployee = useCallback(
    (employeeId) => {
      // Gap (+): operative only — modal auto-picks first today-or-later free slot
      // (same path as urgency/Assign auto-schedule), not the (possibly past) view start.
      openCreateModal({
        employeeIds: [String(employeeId)],
      });
    },
    [openCreateModal],
  );

  const handleGapEmployeeClick = useCallback((row) => {
    if (!row) {
      return;
    }

    const employeeTrainings = [...(row.trainings || [])].sort((left, right) => (
      String(right.start_date ?? '').localeCompare(String(left.start_date ?? ''))
      || String(left.title ?? '').localeCompare(String(right.title ?? ''))
    ));

    setGapDetailPanel({
      kind: 'employee',
      row,
      trainings: employeeTrainings,
    });
  }, []);

  // Card in the operative panel: admins/trainers jump to the course roster, DLs to their DL trainings tab.
  const handleOpenTrainingFromGapPanel = useCallback((training) => {
    if (!training || training.id == null || training.id === '') {
      return;
    }

    const destination = trainingOpenDestination(user);
    if (destination === 'roster') {
      const courseId = resolveCourseIdForSession(training, trainingCourses);
      setGapDetailPanel(null);
      updateParams({
        ...trainingRosterParams(training),
        course: courseId || undefined,
        session: undefined,
      });
      return;
    }

    if (destination === 'dl') {
      const employeeId = training.employee_id
        ?? training.employee?.id
        ?? gapDetailPanel?.row?.employeeId;
      if (!employeeId) {
        toast.error('Unable to open this training — missing operative.');
        return;
      }
      navigate(dlTrainingUrl(training, employeeId));
    }
  }, [gapDetailPanel, navigate, toast, trainingCourses, updateParams, user]);

  const handleGapTrainingClick = useCallback((training) => {
    if (!training) {
      return;
    }

    const group = trainingGroupsByKey.get(trainingSessionKey(training));
    if (!group) {
      return;
    }

    setGapDetailPanel({
      kind: 'session',
      group,
    });
  }, [trainingGroupsByKey]);

  const handleGapSessionClick = useCallback((group) => {
    if (!group) {
      return;
    }

    const isActive = focusedGapSessionKey === group.key;
    updateParam('session', isActive ? '' : group.key);
    if (isActive) {
      setGapDetailPanel(null);
      return;
    }

    setGapDetailPanel({
      kind: 'session',
      group,
    });
  }, [focusedGapSessionKey, updateParam]);

  const handleClearGapSessionFilter = useCallback(() => {
    updateParam('session', '');
  }, [updateParam]);

  const handleTrainingScheduleChange = useCallback(async ({
    training,
    start_date,
    end_date,
    employee_id: nextEmployeeId,
  }) => {
    if (!training?.id || !start_date) {
      return;
    }

    const day = String(start_date).slice(0, 10);
    const resolvedEnd = day;

    const reassigning = nextEmployeeId != null
      && Number(nextEmployeeId) !== Number(training.employee_id);

    if (reassigning) {
      const course = findTrainingCourseById(trainingCourses, training.training_course_id)
        ?? (training.training_course_id
          ? { id: training.training_course_id, title: training.title }
          : { title: training.title });
      if (isEmployeeAssignedToCourse(trainings, nextEmployeeId, course, training.id)) {
        toast.error('This operative is already assigned to this training course.');
        return;
      }

      const previous = training;
      const optimistic = applyTrainingSingleDaySlot({
        ...training,
        start_date: day,
        end_date: resolvedEnd,
        employee_id: nextEmployeeId,
      }, day);
      setTrainings((prev) => prev.map((row) => (
        row.id === training.id ? optimistic : row
      )));

      try {
        const saved = normalizeTrainingRecord(await runWithOccupiedSlotGuard({
          rows: [optimistic],
          context: trainingConflictContext,
          originalsById: new Map([[String(training.id), previous]]),
          showSaveFeedback: true,
        successMessage: 'Training reassigned. If project hours were reduced, re-run the algorithm.',
          save: (confirmOverride, overrideConflicts = []) => persistTrainingRecord({
            training,
            overrides: {
              employee_id: nextEmployeeId,
              start_date: day,
              end_date: resolvedEnd,
            },
            confirmOverride,
            previous,
            context: trainingConflictContext,
            skipClientConflictCheck: true,
            overrideConflicts,
          }),
        }));

        setTrainings((prev) => prev.map((row) => (
          row.id === saved.id ? saved : row
        )));
      } catch (err) {
        setTrainings((prev) => prev.map((row) => (
          row.id === training.id ? previous : row
        )));
        if (err?.code === 'TRAINING_OVERRIDE_CANCELLED') {
          return;
        }
        toast.error(err?.code === 'TRAINING_HOLIDAY_SLOT'
          ? err.message
          : err?.code === 'TRAINING_VALIDATION'
            ? err.message
            : getApiErrorMessage(err, 'Failed to reassign training.'));
      }
      return;
    }

    const previous = training;
    const optimistic = applyTrainingSingleDaySlot({
      ...training,
      start_date: day,
      end_date: resolvedEnd,
    }, day);
    setTrainings((prev) => prev.map((row) => (
      row.id === training.id ? optimistic : row
    )));

    try {
      const saved = normalizeTrainingRecord(await runWithOccupiedSlotGuard({
        rows: [optimistic],
        context: trainingConflictContext,
        originalsById: new Map([[String(training.id), previous]]),
        showSaveFeedback: true,
        successMessage: 'Training schedule updated. If project hours were reduced, re-run the algorithm.',
        save: (confirmOverride, overrideConflicts = []) => persistTrainingRecord({
          training,
          overrides: { start_date: day, end_date: resolvedEnd },
          confirmOverride,
          previous,
          context: trainingConflictContext,
          skipClientConflictCheck: true,
          overrideConflicts,
        }),
      }));

      setTrainings((prev) => prev.map((row) => (
        row.id === saved.id ? saved : row
      )));
    } catch (err) {
      setTrainings((prev) => prev.map((row) => (
        row.id === training.id ? previous : row
      )));
      if (err?.code === 'TRAINING_OVERRIDE_CANCELLED') {
        return;
      }
      toast.error(err?.code === 'TRAINING_HOLIDAY_SLOT'
        ? err.message
        : err?.code === 'TRAINING_VALIDATION'
          ? err.message
          : getApiErrorMessage(err, 'Failed to update training schedule.'));
    }
  }, [runWithOccupiedSlotGuard, trainingConflictContext, toast, trainingCourses, trainings]);

  const toggleGapParam = useCallback((key, enabled) => {
    const next = new URLSearchParams(searchParams);
    if (enabled) {
      if (key === 'showSchedule') {
        next.delete('showSchedule');
      } else {
        next.set(key, '1');
      }
    } else if (key === 'showSchedule') {
      next.set('showSchedule', '0');
    } else {
      next.delete(key);
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleOpenTrainingFromLog = useCallback((log) => {
    const target = resolveTrainingLogNavigationTarget(log);
    if (target.kind === 'none') {
      toast.error('This log is not linked to a training assignment.');
      return;
    }

    if (target.deleted && target.kind === 'assignment') {
      const stillExists = trainings.some((row) => String(row.id) === String(target.trainingId));
      if (!stillExists) {
        toast.error('That training assignment was deleted.');
        setShowActivityLogModal(false);
        return;
      }
    }

    if (target.kind === 'course' && target.deleted) {
      toast.error('That training course was deleted.');
      setShowActivityLogModal(false);
      return;
    }

    const matched = target.trainingId
      ? trainings.find((row) => String(row.id) === String(target.trainingId))
      : null;

    const courseId = matched?.training_course_id != null
      ? String(matched.training_course_id)
      : (target.courseId
        || (matched ? resolveCourseIdForSession(
          { training_course_id: matched.training_course_id, title: matched.title },
          trainingCourses,
        ) : ''));

    if (!courseId && !matched) {
      toast.error('Could not find the related training to open.');
      return;
    }

    const start = String(matched?.start_date || target.startDate || '').slice(0, 10);
    const end = String(matched?.end_date || target.endDate || start).slice(0, 10);

    const patch = {
      view: TRAINING_VIEW_ROSTER,
      course: courseId || undefined,
      training: matched?.id != null ? String(matched.id) : (target.trainingId || undefined),
      session: undefined,
    };

    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
      if (!startDate || start < startDate) {
        patch.start = start;
      }
      if (end && (!endDate || end > endDate)) {
        patch.end = end;
      }
    }

    updateParams(patch);
    setShowActivityLogModal(false);
    toast.success(matched
      ? 'Opened the related training assignment.'
      : 'Opened the related training course.');
  }, [
    endDate,
    startDate,
    toast,
    trainingCourses,
    trainings,
    updateParams,
  ]);

  useEffect(() => {
    if (!focusedTrainingId || viewMode !== TRAINING_VIEW_ROSTER) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const row = document.querySelector(
        `.training-roster-panel tr[data-training-id="${CSS.escape(String(focusedTrainingId))}"]`,
      );
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('is-log-focus');
        window.setTimeout(() => row.classList.remove('is-log-focus'), 2600);
      }
    }, 180);

    return () => window.clearTimeout(timer);
  }, [focusedTrainingId, viewMode, rosterRows, selectedCourseId]);

  const handleCloseGapDetailPanel = useCallback(() => {
    setGapDetailPanel(null);
  }, []);

  const removeTrainingsFromState = useCallback((ids) => {
    const idSet = new Set((ids || []).map((id) => String(id)));
    if (idSet.size === 0) {
      return;
    }

    setTrainings((prev) => prev.filter((item) => !idSet.has(String(item.id))));
    setRosterRows((prev) => prev.filter((item) => !idSet.has(String(item.id))));
    setGapDetailPanel((prev) => {
      if (!prev) {
        return prev;
      }
      if (prev.kind === 'employee') {
        const nextTrainings = (prev.trainings || []).filter((item) => !idSet.has(String(item.id)));
        return { ...prev, trainings: nextTrainings };
      }
      if (prev.kind === 'session' || prev.group) {
        const nextAssignments = (prev.group?.assignments || []).filter(
          (item) => !idSet.has(String(item.id)),
        );
        if (nextAssignments.length === 0) {
          return null;
        }
        return {
          ...prev,
          group: {
            ...prev.group,
            assignments: nextAssignments,
          },
        };
      }
      return prev;
    });
  }, []);

  /** Remove one operative's assignment row. */
  const requestRemoveAssignment = useCallback((training) => {
    const target = resolveTrainingAssignmentDeleteTarget(training);
    if (!target) {
      return;
    }
    setDeleteConfirmTarget(target);
  }, []);

  const handleRemoveRosterRow = useCallback((row) => {
    if (!row) {
      return;
    }

    if (isUnsavedTrainingRow(row)) {
      setRosterRows((prev) => prev.filter((item) => item.id !== row.id));
      return;
    }

    requestRemoveAssignment(row);
  }, [requestRemoveAssignment]);

  const requestDeleteTrainingSession = useCallback((groupOrAssignments) => {
    const target = resolveTrainingSessionDeleteTarget(groupOrAssignments);
    if (target) {
      setDeleteConfirmTarget(target);
    }
  }, []);

  const handleCloseDeleteConfirm = useCallback(() => {
    if (deletingId != null) {
      return;
    }
    setDeleteConfirmTarget(null);
  }, [deletingId]);

  const deleteConfirmCopy = useMemo(
    () => buildTrainingDeleteModalCopy(deleteConfirmTarget),
    [deleteConfirmTarget],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirmTarget) {
      return;
    }

    if (deleteConfirmTarget.kind === 'assignment') {
      const { training } = deleteConfirmTarget;
      setDeletingId(training.id);
      try {
        await api.delete(`/trainings/${training.id}`);
        removeTrainingsFromState([training.id]);
        toast.success('Assignment removed.');
        setDeleteConfirmTarget(null);
      } catch (err) {
        toast.error(getApiErrorMessage(err, 'Failed to remove assignment.'));
      } finally {
        setDeletingId(null);
      }
      return;
    }

    if (deleteConfirmTarget.kind === 'session') {
      const { deletable, count, courseId } = deleteConfirmTarget;
      setDeletingId('session');
      try {
        if (courseId) {
          await api.delete(`/training-courses/${courseId}`);
        } else {
          await Promise.all(deletable.map((row) => api.delete(`/trainings/${row.id}`)));
        }
        const ids = deletable.map((row) => row.id);
        removeTrainingsFromState(ids);
        if (courseId) {
          setTrainingCourses((prev) => prev.filter((course) => String(course.id) !== String(courseId)));
          if (String(selectedCourseId) === String(courseId)) {
            updateParam('course', '');
          }
        }
        toast.success(
          courseId
            ? (count === 1 ? 'Course and assignment deleted.' : 'Course and assignments deleted.')
            : (count === 1 ? 'Training assignment deleted.' : 'Training assignments deleted.'),
        );
        setDeleteConfirmTarget(null);
      } catch (err) {
        toast.error(getApiErrorMessage(err, 'Failed to delete training.'));
      } finally {
        setDeletingId(null);
      }
    }
  }, [
    deleteConfirmTarget,
    removeTrainingsFromState,
    selectedCourseId,
    toast,
    updateParam,
  ]);

  const handleTrainingStatusChange = useCallback(async (training, nextStatus) => {
    if (!training?.id || !nextStatus) {
      return;
    }

    const trainingId = training.id;
    const previousStatus = training.status;

    const applyStatus = (list) => list.map((entry) => (
      String(entry.id) === String(trainingId)
        ? { ...entry, status: nextStatus }
        : entry
    ));

    setTrainings((prev) => applyStatus(prev));
    setRosterRows((prev) => applyStatus(prev));
    setGapDetailPanel((prev) => {
      if (!prev) {
        return prev;
      }
      if (prev.kind === 'employee') {
        return {
          ...prev,
          trainings: applyStatus(prev.trainings || []),
        };
      }
      if (prev.group) {
        return {
          ...prev,
          group: {
            ...prev.group,
            assignments: applyStatus(prev.group.assignments || []),
          },
        };
      }
      return prev;
    });

    try {
      setStatusSavingId(trainingId);
      // Status only: re-sending the cached schedule would overwrite a day
      // section / date saved elsewhere since this page loaded.
      const response = await api.put(`/trainings/${trainingId}`, { status: nextStatus });
      showSaveNotifications(response.data?.notifications);
      const saved = normalizeTrainingRecord(response.data?.data);
      if (saved) {
        const mergeSaved = (list) => list.map((entry) => (
          String(entry.id) === String(trainingId) ? { ...entry, ...saved } : entry
        ));
        setTrainings((prev) => mergeSaved(prev));
        setRosterRows((prev) => mergeSaved(prev));
        setGapDetailPanel((prev) => {
          if (!prev) {
            return prev;
          }
          if (prev.kind === 'employee') {
            return {
              ...prev,
              trainings: mergeSaved(prev.trainings || []),
            };
          }
          if (prev.group) {
            return {
              ...prev,
              group: {
                ...prev.group,
                assignments: mergeSaved(prev.group.assignments || []),
              },
            };
          }
          return prev;
        });
      }
      if (nextStatus === 'completed') {
        toast.success('Training marked complete.');
      }
    } catch (err) {
      const revertStatus = (list) => list.map((entry) => (
        String(entry.id) === String(trainingId)
          ? { ...entry, status: previousStatus }
          : entry
      ));
      setTrainings((prev) => revertStatus(prev));
      setRosterRows((prev) => revertStatus(prev));
      setGapDetailPanel((prev) => {
        if (!prev) {
          return prev;
        }
        if (prev.kind === 'employee') {
          return {
            ...prev,
            trainings: revertStatus(prev.trainings || []),
          };
        }
        if (prev.group) {
          return {
            ...prev,
            group: {
              ...prev.group,
              assignments: revertStatus(prev.group.assignments || []),
            },
          };
        }
        return prev;
      });
      toast.error(err?.code === 'TRAINING_VALIDATION'
        ? err.message
        : getApiErrorMessage(err, 'Unable to update training progress.'));
    } finally {
      setStatusSavingId(null);
    }
  }, [toast]);

  /** Delete the whole training session (all assignees). */
  const handleDeleteTrainingSession = requestDeleteTrainingSession;

  const handleModalSuccess = useCallback((created) => {
    const items = normalizeTrainingRecords(Array.isArray(created) ? created : [created]);
    setTrainings((prev) => {
      const next = [...prev];
      items.forEach((item) => {
        const idx = next.findIndex((row) => row.id === item.id);
        if (idx >= 0) next[idx] = item;
        else next.unshift(item);
      });
      return next;
    });
  }, []);

  const handleCatalogSaved = useCallback(async (savedCourse = null) => {
    try {
      const trainingParams = viewMode === TRAINING_VIEW_ROSTER
        ? {}
        : { start: startDate, end: endDate };
      const [coursesRes, trainingRes] = await Promise.all([
        api.get('/training-courses'),
        api.get('/trainings', { params: trainingParams }),
      ]);
      const nextCourses = Array.isArray(coursesRes.data?.data) ? coursesRes.data.data : [];
      setTrainingCourses(nextCourses);
      setTrainings(normalizeTrainingRecords(
        Array.isArray(trainingRes.data?.data) ? trainingRes.data.data : [],
      ));

      const selectCourseId = savedCourse?.id;
      if (selectCourseId && viewMode === TRAINING_VIEW_ROSTER) {
        updateParam('course', String(selectCourseId));
      }
    } catch {
      // Keep current lists; the catalog modal already reloaded its own course list.
    }
  }, [endDate, startDate, updateParam, viewMode]);

  const isInitialLoad = !hasLoadedOnce && loading;
  const rangeRefreshing = viewLoading && viewMode === TRAINING_VIEW_GAPS;
  const rosterRefreshing = viewLoading && viewMode === TRAINING_VIEW_ROSTER;

  if (isInitialLoad) {
    return <TrainingsPageSkeleton />;
  }

  return (
    <div className={`page trainings-page${viewMode === TRAINING_VIEW_ROSTER ? ' trainings-page--roster' : ''}${viewMode === TRAINING_VIEW_GAPS ? ' trainings-page--gaps' : ''}`}>
      <PageHeader
        title="Trainings"
        compact={viewMode === TRAINING_VIEW_GAPS}
        actions={(
          <div className="trainings-header-actions">
            <div
              className="trainings-view-toggle"
              role="tablist"
              aria-label="Trainings view"
              data-active-view={viewMode}
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === TRAINING_VIEW_GAPS}
                className={`btn btn-secondary btn-sm trainings-view-tab${viewMode === TRAINING_VIEW_GAPS ? ' is-active' : ''}`}
                onClick={() => runDiscardingRosterChanges(() => setViewMode(TRAINING_VIEW_GAPS))}
              >
                Gap view
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === TRAINING_VIEW_ROSTER}
                className={`btn btn-secondary btn-sm trainings-view-tab${viewMode === TRAINING_VIEW_ROSTER ? ' is-active' : ''}`}
                onClick={() => setViewMode(TRAINING_VIEW_ROSTER)}
              >
                Training roster
              </button>
            </div>
            <div className="trainings-header-end">
              {canViewTrainingLog ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={() => setShowActivityLogModal(true)}
                >
                  Edits Log History
                </button>
              ) : null}
              {canViewNotifications(user) && upcomingGapOpportunities.length > 0 ? (
                <TrainingGapNotifyBanner
                  opportunities={upcomingGapOpportunities}
                  unreadCount={rosterUnreadCount}
                  onAssignOne={canEditNotifications(user) ? handleAssignGapOpportunity : undefined}
                  onDismiss={handleDismissGapNotification}
                  onOpenBell={handleOpenGapBell}
                  showBell
                  showClosestPopup={showGapClosestPopup}
                />
              ) : null}
              <div
                className={`trainings-header-save-slot${viewMode === TRAINING_VIEW_ROSTER ? ' is-visible' : ''}`}
              >
                {viewMode === TRAINING_VIEW_ROSTER ? (
                  <>
                    {canDeleteTraining ? (
                      <button
                        type="button"
                        className="btn btn-danger btn-compact"
                        onClick={() => handleDeleteTrainingSession(
                          selectedTrainingGroup || (selectedCourse
                            ? { ...selectedCourse, training_course_id: selectedCourse.id, assignments: [] }
                            : null),
                        )}
                        disabled={!selectedCourse || deletingId != null}
                        title="Delete this course and all of its assignments"
                      >
                        {deletingId === 'session' ? 'Deleting...' : 'Delete training'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-save btn-compact"
                      onClick={handleSaveRoster}
                      disabled={!canAssignTrainings || !selectedCourse || rosterRows.length === 0 || savingRoster || !rosterIsDirty}
                    >
                      {savingRoster ? 'Saving...' : 'Save'}
                    </button>
                  </>
                ) : null}
              </div>
              {canAssignTrainings ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => openCreateModal()}
              >
                New training
              </button>
              ) : null}
              {(savingRoster || viewLoading) ? (
                <span className="trainings-header-status" role="status" aria-live="polite">
                  <span className="trainings-header-status-spinner" aria-hidden="true" />
                  {savingRoster ? 'Saving…' : 'Loading…'}
                </span>
              ) : null}
            </div>
          </div>
        )}
      />

      {error && (
        <div className="trainings-error" role="alert">
          {error}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => loadData({ background: hasLoadedOnce, forceStatic: true })}>
            Retry
          </button>
        </div>
      )}

      <section className="trainings-overview card" aria-label="Training report">
        <div className="trainings-overview-stat" key={`stat-a-${viewMode}`}>
          <span className="trainings-overview-label">
            {viewMode === TRAINING_VIEW_ROSTER ? 'Assignments' : 'Gaps'}
          </span>
          <strong>
            {viewMode === TRAINING_VIEW_ROSTER ? (selectedTrainingGroup?.assignments?.length || rosterRows.length) : employeeGapRows.length}
          </strong>
        </div>
        <div className="trainings-overview-stat" key={`stat-b-${viewMode}`}>
          <span className="trainings-overview-label">
            {viewMode === TRAINING_VIEW_ROSTER ? 'Trainees' : 'Gap hours'}
          </span>
          <strong>
            {viewMode === TRAINING_VIEW_ROSTER
              ? rosterRows.filter((row) => row.employee_id).length
              : `${Number(totalGapHours).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`}
          </strong>
        </div>
        <div className="trainings-overview-stat trainings-overview-stat--secondary">
          <span className="trainings-overview-label">Scheduled</span>
          <strong>{trainings.length}</strong>
        </div>
        <div className="trainings-overview-stat trainings-overview-stat--range">
          <span className="trainings-overview-label">
            {viewMode === TRAINING_VIEW_ROSTER ? 'Selected' : 'Range'}
          </span>
          <strong>
            {viewMode === TRAINING_VIEW_ROSTER
              ? (selectedCourse?.title || '—')
              : `${startDate} → ${endDate}`}
          </strong>
        </div>
      </section>

      <div className={`trainings-view-stage${viewLoading ? ' is-refreshing' : ''}`}>
        <div
          key={viewMode}
          className={`trainings-view-panel trainings-view-panel--${viewMode}`}
        >
      {viewMode === TRAINING_VIEW_ROSTER ? (
        <section className="pde-page dl-page trainings-roster-page">
          <div className="card project-picker">
            <div className="project-picker-row pde-controls">
              <div className="pde-controls-group pde-controls-group--filters training-roster-picker-row">
                <label className="project-select-field">
                  Select course
                  <select
                    value={selectedCourseId}
                    onChange={(e) => {
                      const nextCourseId = e.target.value;
                      runDiscardingRosterChanges(() => updateParam('course', nextCourseId));
                    }}
                    disabled={courseOptions.length === 0 || rosterRefreshing}
                  >
                    <option value="">
                      {courseOptions.length === 0 ? 'No courses in catalog' : 'Choose a course…'}
                    </option>
                    {courseOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                {canManageCourses ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setShowCourseCatalogModal(true)}
                  >
                    Manage courses
                  </button>
                ) : null}

                <button
                  type="button"
                  className="btn btn-secondary btn-sm training-open-course-btn"
                  onClick={() => {
                    const link = selectedTrainingGroup?.course_link || selectedCourse?.course_link;
                    const result = tryOpenTrainingCourseLink(link);
                    if (!result.ok) {
                      toast.info(result.reason);
                    }
                  }}
                  disabled={
                    !selectedCourse
                    || !(selectedTrainingGroup?.course_link || selectedCourse?.course_link)
                  }
                  title={
                    (selectedTrainingGroup?.course_link || selectedCourse?.course_link)
                      ? `Open external course page: ${selectedTrainingGroup?.course_link || selectedCourse?.course_link}`
                      : 'Opens the course web link from Manage courses (Moodle / LMS URL)'
                  }
                >
                  Open course link
                </button>
              </div>

              {selectedCourseId ? (
                <div
                  className="pde-controls-toolbar-row pde-controls-toolbar-row--primary"
                  role="toolbar"
                  aria-label="Trainee rows"
                >
                  <div className="pde-action-cluster">
                    <button
                      type="button"
                      className="btn btn-secondary btn-compact"
                      onClick={handleAddTraineeRow}
                      disabled={!canAssignTrainings || !selectedCourse || rosterRefreshing}
                    >
                      Add trainee row
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {selectedTrainingGroup ? (
              <div className="project-meta pde-project-meta training-roster-meta">
                <span><strong>Course:</strong> {selectedCourse?.title || selectedTrainingGroup.title || '—'}</span>
                <span>
                  <strong>Assignments:</strong>{' '}
                  {rosterRows.filter((row) => row.employee_id).length}
                </span>
                <span className="training-roster-schedule-hint">
                  One course → many employees. Each trainee row has its own date, priority and urgency.
                </span>
                {rosterScheduleHint ? (
                  <span className="training-roster-schedule-hint">{rosterScheduleHint}</span>
                ) : null}
              </div>
            ) : null}
          </div>

          {rosterRefreshing && !selectedTrainingGroup ? (
            <TaskGridSkeleton />
          ) : (
            <TrainingEmployeeGrid
              rows={rosterRows}
              onChange={canAssignTrainings ? handleRosterFieldChange : undefined}
              onRemoveAssignment={canDeleteTraining ? handleRemoveRosterRow : undefined}
              removingId={deletingId}
              sections={trainingRosterSections}
              frozenFieldKeys={ROSTER_FROZEN_FIELD_KEYS}
              emptyMessage={selectedCourse
                ? 'No trainees yet — use Add trainee row to assign operatives to this course.'
                : 'Select a course to view and assign trainees.'}
              pageClassName="training-roster-panel"
              simpleHeader
              isTraineeRow={isTraineeRosterRow}
              employeeOptionsForRow={employeeOptionsForRow}
              isDateDisabledForRow={isDateDisabledForRow}
              scheduleHintForRow={scheduleHintForRow}
              editableFieldKeys={isDlUser(user) ? DL_ROSTER_EDITABLE_FIELD_KEYS : null}
              highlightedRowId={focusedTrainingId}
            />
          )}
        </section>
      ) : (
        <div className="trainings-layout trainings-layout-single">
        <section className="trainings-gap-panel card">
          <div className="trainings-gap-panel-head">
            <h2>Capacity gaps by operative</h2>
            <div className="trainings-gap-display-toggles is-temporarily-hidden">
              <button
                type="button"
                className={`btn btn-secondary btn-sm trainings-gap-toggle${showTrainingSchedule ? ' is-active' : ''}`}
                aria-pressed={showTrainingSchedule}
                onClick={() => toggleGapParam('showSchedule', !showTrainingSchedule)}
              >
                Schedule on chart
              </button>
            </div>
          </div>

          <div className="trainings-toolbar">
            <label className="trainings-toolbar-field trainings-toolbar-field--team">
              <span>Team</span>
              <select value={teamId} onChange={(e) => updateParam('team', e.target.value)}>
                <option value="">All teams</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="trainings-toolbar-field trainings-toolbar-field--training">
              <span>Filter course</span>
              <select
                value={focusedGapSessionKey}
                onChange={(e) => updateParam('session', e.target.value)}
                disabled={gapViewTrainingGroups.length === 0 || rangeRefreshing}
                title="Filter Gap view to assignees of one course. The same course can be assigned to many employees with their own dates."
              >
                <option value="">
                  {gapViewTrainingGroups.length === 0 ? 'No courses in range' : 'All courses'}
                </option>
                {gapViewTrainingGroups.map((group) => (
                  <option key={group.key} value={group.key}>
                    {group.legendNumber}. {formatTrainingSessionLabel(group)}
                  </option>
                ))}
              </select>
            </label>
            <div className="trainings-toolbar-dates">
              <label className="trainings-toolbar-field">
                <span>From</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => updateParam('start', e.target.value)}
                />
              </label>
              <label className="trainings-toolbar-field">
                <span>To</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => updateParam('end', e.target.value)}
                  min={startDate || undefined}
                  max={endDateMax}
                />
              </label>
            </div>
            <div className="trainings-toolbar-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleResetFilters}
                title="Clear team filter and restore the default date range (1 week ago → 7 weeks ahead)."
              >
                Reset
              </button>
              <label
                className="trainings-toolbar-extend"
                title={extendMode ? 'Extend mode on — drag or resize training bars' : 'Enable extend mode to drag or resize training bars'}
              >
                <input
                  type="checkbox"
                  checked={extendMode}
                  onChange={(event) => setExtendMode(event.target.checked)}
                  aria-label="Extend mode"
                />
                <span>Extend</span>
              </label>
            </div>
            <label className="trainings-toolbar-field is-temporarily-hidden">
              <span>Min gap (h)</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={minGapHours}
                onChange={(e) => updateParam('minGap', e.target.value)}
              />
            </label>
          </div>

          {focusedGapSessionGroup ? (
            <div className="alert alert-info histogram-bar-filter-banner trainings-gap-session-filter-banner">
              <span>
                Showing employees assigned to
                {' '}
                <strong>{formatTrainingSessionLabel(focusedGapSessionGroup)}</strong>
                {' '}
                only.
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleClearGapSessionFilter}
              >
                Clear
              </button>
            </div>
          ) : null}

          <TrainingsGapSessionList
            groups={gapViewTrainingGroups}
            activeSessionKey={focusedGapSessionKey}
            onSessionClick={handleGapSessionClick}
          />

          {employeeGapRows.length === 0 && !rangeRefreshing ? (
            <p className="trainings-gap-empty">No operatives with gaps or scheduled training in this range.</p>
          ) : filteredEmployeeGapRows.length === 0 && !rangeRefreshing ? (
            <p className="trainings-gap-empty">No assignees for the selected training in this range.</p>
          ) : (
            <div className={`trainings-chart-wrap${rangeRefreshing ? ' is-refreshing' : ''}`}>
              {filteredEmployeeGapRows.length > 0 ? (
                <TrainingsGapHistogramView
                  range={viewRange}
                  rows={filteredEmployeeGapRows}
                  teams={teams}
                  dailyHours={occupancyDailyHours}
                  availabilityHours={teamFiltered.availabilityHours}
                  employeeHolidays={teamFiltered.employeeHolidays}
                  employees={employees.length > 0 ? employees : teamFiltered.employees}
                  sessionLegendLookup={sessionLegendLookup}
                  focusedSessionKey={focusedGapSessionKey}
                  onAddTraining={handlePrefillEmployee}
                  onEmployeeClick={handleGapEmployeeClick}
                  onTrainingClick={handleGapTrainingClick}
                  onTrainingScheduleChange={handleTrainingScheduleChange}
                  showTrainingSchedule={showTrainingSchedule}
                  extendMode={extendMode}
                />
              ) : null}
              <HistogramChartRefreshOverlay active={rangeRefreshing} label="Loading…" />
            </div>
          )}
        </section>
        </div>
      )}
        </div>
      </div>

      <TrainingsGapDetailPanel
        panel={viewMode === TRAINING_VIEW_GAPS ? gapDetailPanel : null}
        statusLabel={statusLabel}
        sessionLegendLookup={sessionLegendLookup}
        onClose={handleCloseGapDetailPanel}
        onRemoveAssignment={canDeleteTraining ? requestRemoveAssignment : undefined}
        onDeleteTraining={canDeleteTraining ? handleDeleteTrainingSession : undefined}
        onUpdateStatus={canAssignTrainings ? handleTrainingStatusChange : undefined}
        onOpenTraining={trainingOpenDestination(user) ? handleOpenTrainingFromGapPanel : undefined}
        openTrainingTitle={trainingOpenTitle(user)}
        deletingId={deletingId}
        statusSavingId={statusSavingId}
      />

      <CreateNewTrainingModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setModalInitial(null);
        }}
        employees={employees.length > 0 ? employees : teamFiltered.employees}
        trainingCourses={trainingCourses}
        existingTrainings={trainings}
        bars={rosterScheduleContext?.bars ?? teamFiltered.bars}
        dailyHours={rosterScheduleContext?.dailyHours ?? teamFiltered.dailyHours}
        availabilityHours={rosterScheduleContext?.availabilityHours ?? teamFiltered.availabilityHours}
        employeeHolidays={rosterScheduleContext?.employeeHolidays ?? teamFiltered.employeeHolidays}
        initialValues={modalInitial}
        onSuccess={handleModalSuccess}
      />

      <DeleteConfirmModal
        open={Boolean(deleteConfirmTarget && deleteConfirmCopy)}
        title={deleteConfirmCopy?.title ?? 'Confirm deletion'}
        message={deleteConfirmCopy?.message ?? ''}
        details={deleteConfirmCopy?.details ?? []}
        warning={deleteConfirmCopy?.warning}
        confirmLabel={deleteConfirmCopy?.confirmLabel ?? 'Delete'}
        onClose={handleCloseDeleteConfirm}
        onConfirm={handleConfirmDelete}
        busy={deletingId != null}
      />

      {canManageCourses ? (
        <TrainingCourseCatalogModal
          open={showCourseCatalogModal}
          onClose={() => setShowCourseCatalogModal(false)}
          onSaved={handleCatalogSaved}
        />
      ) : null}

      {canViewTrainingLog ? (
        <ActivityLogModal
          open={showActivityLogModal}
          onClose={() => setShowActivityLogModal(false)}
          area="Trainings"
          title="Edits Log History"
          emptyMessage="No training changes recorded yet."
          limit={100}
          onLogClick={(log) => runDiscardingRosterChanges(() => handleOpenTrainingFromLog(log))}
        />
      ) : null}

      {occupiedSlotModal}

      <DeleteConfirmModal
        open={pendingRosterDiscard != null}
        title="Discard unsaved roster changes?"
        message="You have training assignment changes that are not saved yet."
        warning="Click Save first to keep them — otherwise they will be lost."
        confirmLabel="Discard changes"
        onClose={() => setPendingRosterDiscard(null)}
        onConfirm={confirmRosterDiscard}
      />
    </div>
  );
}
