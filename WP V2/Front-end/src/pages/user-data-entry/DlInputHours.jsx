import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import { dlTaskSections } from '../../constants/projectTaskFields';
import AlgorithmRunningOverlay from '../../components/AlgorithmRunningOverlay';
import AlgorithmSkippedTasksModal from '../../components/AlgorithmSkippedTasksModal';
import ActivityLogModal from '../../components/ActivityLogModal';
import RunAlgorithmAfterSaveModal from '../../components/RunAlgorithmAfterSaveModal';
import ExceedsDlHoursModal from '../../components/ExceedsDlHoursModal';
import DlMyTrainingsPanel, { TRAINEE_EDITABLE_TRAINING_KEYS } from '../../components/DlMyTrainingsPanel';
import { ProjectsPageSkeleton, TaskGridSkeleton } from '../../components/PageSkeleton';
import PageHeader from '../../components/PageHeader';
import ProjectColorSelect from '../../components/ProjectColorSelect';
import ProjectTaskGrid from '../../components/ProjectTaskGrid';
import DlPageLegend from '../../components/DlPageLegend';
import { applyTrainingFieldChange } from '../../components/TrainingEmployeeGrid';
import { useToast } from '../../context/ToastContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { showSaveNotifications } from '../../utils/taskSyncNotifications';
import { useTrainingOccupiedSlotGate } from '../../hooks/useTrainingOccupiedSlotGate.jsx';
import {
  buildTrainingConflictContext,
  persistTrainingRecord,
} from '../../utils/trainingSaveGuard';
import { useAuth } from '../../context/AuthContext';
import {
  mergeAlgorithmResults,
  saveAllAlgorithmResults,
  taskHasPlanHours,
} from '../../utils/algorithm';
import { initialAlgorithmProgress } from '../../utils/algorithmProgress';
import {
  runAlgorithmByProject,
  algorithmRunSleep,
  SHOW_ALGORITHM_SKIPPED_MODAL,
} from '../../utils/algorithmRun';
import { displayProjectColor } from '../../utils/projectColor';
import { filterActiveProjects, formatProjectStatus, sortProjectsForPde } from '../../utils/projectSort';
import { applyDlTaskFieldChange } from '../../utils/taskCalculations';
import { findTasksExceedingDlHours } from '../../utils/taskSectionDetailCalculations';
import { employeeDisplayName, findEmployeeForAuthUser } from '../../utils/employeeNames';
import { canPageAction, canWarnExceedsDlHours, isDlUser } from '../../utils/userPermissions';
import { formatDisplayDate } from '../../utils/dateFormat';
import { useDebouncedProjectColorUpdate } from '../../hooks/useDebouncedProjectColorUpdate';
import { useTaskSyncConflictModal } from '../../hooks/useTaskSyncConflictModal';
import {
  cloneTaskSyncSnapshot,
  isTaskSyncCancelled,
  taskSyncSuccessMessage,
} from '../../utils/taskSync';
import { showTaskSyncNotifications } from '../../utils/taskSyncNotifications';
import {
  TRAINING_PRIORITY_OPTIONS,
  TRAINING_STATUS_OPTIONS,
  TRAINING_URGENCY_OPTIONS,
} from '../../utils/trainingForm';

const DL_VIEW_PROJECTS = 'projects';
const DL_VIEW_TRAININGS = 'trainings';
const DL_PLAN_LOG_PARAMS = { section: 'dl' };

function trainingStatusLabel(value) {
  return TRAINING_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export default function DlInputHours() {
  const toast = useToast();
  const { user } = useAuth();
  const canEditDlHours = canPageAction(user, 'DL Input Hours', 'edit');
  const canWarnExceedsDl = canWarnExceedsDlHours(user);
  const canRunDlAlgorithm = canPageAction(user, 'DL Input Hours', 'run_algorithm');
  const canEditOwnTrainings = canPageAction(user, 'DL Input Hours', 'edit_own_trainings');
  const canAssignTrainings = canPageAction(user, 'Trainings', 'assign');
  const { runWithOccupiedSlotGuard, modal: occupiedSlotModal } = useTrainingOccupiedSlotGate();
  const { syncPartTasksWithConflict, taskSyncConflictModal } = useTaskSyncConflictModal();
  const [searchParams, setSearchParams] = useSearchParams();

  const viewMode = searchParams.get('view') === DL_VIEW_TRAININGS
    ? DL_VIEW_TRAININGS
    : DL_VIEW_PROJECTS;
  const projectFromUrl = searchParams.get('project');
  const employeeFromUrl = searchParams.get('employee') || '';
  const trainingFromUrl = searchParams.get('training') || '';
  const focusedTrainingId = trainingFromUrl ? String(trainingFromUrl) : '';
  const effectiveEmployeeFromUrl = canAssignTrainings ? employeeFromUrl : '';

  const [projects, setProjects] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [parts, setParts] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedPartId, setSelectedPartId] = useState('');
  const [tasks, setTasks] = useState([]);
  const tasksRef = useRef(tasks);
  const tasksBaselineRef = useRef([]);
  const algorithmSavePendingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [partsLoading, setPartsLoading] = useState(false);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [savingTasks, setSavingTasks] = useState(false);
  const [runningAlgorithm, setRunningAlgorithm] = useState(false);
  const [algorithmProgress, setAlgorithmProgress] = useState(initialAlgorithmProgress);
  const [showAlgorithmSkippedModal, setShowAlgorithmSkippedModal] = useState(false);
  const [showRunAlgoAfterSaveModal, setShowRunAlgoAfterSaveModal] = useState(false);
  const [showExceedsDlModal, setShowExceedsDlModal] = useState(false);
  const [showActivityLogModal, setShowActivityLogModal] = useState(false);
  const [exceedsDlTasks, setExceedsDlTasks] = useState([]);
  const [algorithmSkippedTasks, setAlgorithmSkippedTasks] = useState([]);
  const [error, setError] = useState('');
  const [selectedTaskRows, setSelectedTaskRows] = useState([]);
  const [myTrainings, setMyTrainings] = useState([]);
  const [myTrainingsLoading, setMyTrainingsLoading] = useState(false);
  const [savingMyTrainings, setSavingMyTrainings] = useState(false);
  const [myTrainingsAutoSaveState, setMyTrainingsAutoSaveState] = useState('idle');
  const [trainingHistogramContext, setTrainingHistogramContext] = useState(null);
  const myTrainingsRef = useRef([]);
  const myTrainingAutoSaveTimersRef = useRef(new Map());
  const myTrainingsAutoSaveClearRef = useRef(null);
  const [trainingStatusFilter, setTrainingStatusFilter] = useState('');
  const [trainingPriorityFilter, setTrainingPriorityFilter] = useState('');
  const [trainingUrgencyFilter, setTrainingUrgencyFilter] = useState('');
  const [trainingSearchFilter, setTrainingSearchFilter] = useState('');

  const loggedInEmployee = useMemo(
    () => findEmployeeForAuthUser(user, employees),
    [user, employees],
  );

  /** Prefer employee dropdown label so Owner select + dl_owner stay in sync. */
  const ownerName = useMemo(() => {
    if (loggedInEmployee) {
      return employeeDisplayName(loggedInEmployee);
    }
    return String(user?.name ?? '').trim();
  }, [loggedInEmployee, user?.name]);

  const trainingEmployee = useMemo(() => {
    if (!effectiveEmployeeFromUrl) {
      return loggedInEmployee;
    }
    return employees.find((entry) => String(entry.id) === String(effectiveEmployeeFromUrl))
      || loggedInEmployee;
  }, [effectiveEmployeeFromUrl, employees, loggedInEmployee]);

  const viewingOtherOperative = Boolean(
    effectiveEmployeeFromUrl
    && loggedInEmployee?.id
    && String(effectiveEmployeeFromUrl) !== String(loggedInEmployee.id),
  );
  const viewingOwnTrainings = !effectiveEmployeeFromUrl
    || (loggedInEmployee?.id && String(effectiveEmployeeFromUrl) === String(loggedInEmployee.id));
  // A trainee on their own list may only change Status, even when their role can
  // also assign trainings (F-01). Managers editing another operative keep full edit.
  const statusOnlyTrainings = canEditOwnTrainings
    && !user?.is_admin
    && (!canAssignTrainings || Boolean(viewingOwnTrainings));

  const setViewMode = useCallback((nextView) => {
    const next = new URLSearchParams(searchParams);
    if (nextView === DL_VIEW_PROJECTS) {
      next.delete('view');
      next.delete('employee');
      next.delete('training');
    } else {
      next.set('view', DL_VIEW_TRAININGS);
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const setFocusedTraining = useCallback((trainingId) => {
    const next = new URLSearchParams(searchParams);
    if (!trainingId) {
      next.delete('training');
    } else {
      next.set('training', String(trainingId));
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const loadMyTrainings = useCallback(async () => {
    const employeeId = trainingEmployee?.id;
    if (!employeeId) {
      setMyTrainings([]);
      return;
    }

    setMyTrainingsLoading(true);
    try {
      const response = await api.get('/trainings', {
        params: { employee_id: employeeId },
      });
      let rows = Array.isArray(response.data?.data) ? response.data.data : [];

      // Histogram sample (or other deep-linked) training may not exist in the API yet.
      if (focusedTrainingId) {
        const alreadyPresent = rows.some((row) => String(row.id) === focusedTrainingId);
        if (!alreadyPresent) {
          try {
            const raw = window.sessionStorage.getItem('dl-focus-training');
            const staged = raw ? JSON.parse(raw) : null;
            if (
              staged
              && String(staged.id) === focusedTrainingId
              && String(staged.employee_id ?? staged.employee?.id ?? '') === String(employeeId)
            ) {
              rows = [staged, ...rows];
            }
          } catch {
            // ignore
          }
        }
      }

      setMyTrainings(
        [...rows].sort((left, right) => (
          String(right.start_date ?? '').localeCompare(String(left.start_date ?? ''))
          || String(left.title ?? '').localeCompare(String(right.title ?? ''))
        )),
      );
      setError('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load trainings.'));
    } finally {
      setMyTrainingsLoading(false);
    }
  }, [focusedTrainingId, trainingEmployee?.id]);

  useEffect(() => {
    if (canAssignTrainings || !employeeFromUrl) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('employee');
    setSearchParams(next, { replace: true });
  }, [canAssignTrainings, employeeFromUrl, searchParams, setSearchParams]);

  useEffect(() => {
    if (viewMode !== DL_VIEW_TRAININGS) {
      return;
    }
    loadMyTrainings();
  }, [viewMode, loadMyTrainings]);

  useEffect(() => {
    myTrainingsRef.current = myTrainings;
  }, [myTrainings]);

  useEffect(() => () => {
    myTrainingAutoSaveTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    myTrainingAutoSaveTimersRef.current.clear();
    if (myTrainingsAutoSaveClearRef.current) {
      window.clearTimeout(myTrainingsAutoSaveClearRef.current);
    }
  }, []);

  useEffect(() => {
    if (viewMode !== DL_VIEW_TRAININGS) {
      return undefined;
    }

    let cancelled = false;

    const loadHistogram = async () => {
      try {
        const response = await api.get('/resource-histogram');
        if (!cancelled) {
          setTrainingHistogramContext(
            buildTrainingConflictContext(response.data?.data, employees, myTrainingsRef.current),
          );
        }
      } catch {
        if (!cancelled) {
          setTrainingHistogramContext(null);
        }
      }
    };

    loadHistogram();

    return () => {
      cancelled = true;
    };
  }, [employees, viewMode]);

  const persistMyTraining = useCallback(async (rowId) => {
    const row = myTrainingsRef.current.find((entry) => String(entry.id) === String(rowId));
    if (!row) {
      return;
    }

    const previous = { ...row };

    if (myTrainingsAutoSaveClearRef.current) {
      window.clearTimeout(myTrainingsAutoSaveClearRef.current);
      myTrainingsAutoSaveClearRef.current = null;
    }
    setMyTrainingsAutoSaveState('saving');
    setSavingMyTrainings(true);
    try {
      // Status-only trainees: PUT only status so schedule/override side-effects cannot fire.
      if (statusOnlyTrainings) {
        const response = await api.put(`/trainings/${row.id}`, { status: row.status });
        showSaveNotifications(response.data?.notifications);
        const saved = response.data?.data ?? { ...row, status: row.status };
        setMyTrainings((current) => current.map((entry) => (
          String(entry.id) === String(rowId) ? { ...entry, ...saved } : entry
        )));
      } else {
        const saved = await runWithOccupiedSlotGuard({
          rows: [row],
          context: trainingHistogramContext,
          originalsById: new Map([[String(rowId), previous]]),
          save: (confirmOverride, overrideConflicts = []) => persistTrainingRecord({
            training: row,
            confirmOverride,
            previous,
            context: trainingHistogramContext,
            overrideConflicts,
          }),
        });

        if (saved) {
          setMyTrainings((current) => current.map((entry) => (
            String(entry.id) === String(rowId) ? { ...entry, ...saved } : entry
          )));
        }
      }
      setError('');
      setMyTrainingsAutoSaveState('saved');
      myTrainingsAutoSaveClearRef.current = window.setTimeout(() => {
        setMyTrainingsAutoSaveState('idle');
        myTrainingsAutoSaveClearRef.current = null;
      }, 2000);
    } catch (err) {
      setMyTrainingsAutoSaveState('error');
      toast.error(err?.code === 'TRAINING_VALIDATION'
        ? err.message
        : getApiErrorMessage(err, 'Failed to auto-save training.'));
    } finally {
      setSavingMyTrainings(false);
    }
  }, [runWithOccupiedSlotGuard, statusOnlyTrainings, toast, trainingHistogramContext]);

  const scheduleMyTrainingAutoSave = useCallback((rowId) => {
    const key = String(rowId);
    const timers = myTrainingAutoSaveTimersRef.current;
    if (timers.has(key)) {
      window.clearTimeout(timers.get(key));
    }
    setMyTrainingsAutoSaveState((current) => (current === 'saving' ? current : 'pending'));
    timers.set(key, window.setTimeout(() => {
      timers.delete(key);
      persistMyTraining(rowId);
    }, 700));
  }, [persistMyTraining]);

  const handleMyTrainingChange = useCallback((rowId, key, value) => {
    // Operatives/trainees may only change Status — block schedule fields before any state/autosave.
    if (statusOnlyTrainings && !TRAINEE_EDITABLE_TRAINING_KEYS.has(key)) {
      return;
    }
    if ((isDlUser(user) || statusOnlyTrainings) && (
      key === 'start_date'
      || key === 'end_date'
      || key === 'day_segment'
      || key === 'hours_per_day'
      || key === 'duration'
    )) {
      return;
    }
    const existing = myTrainingsRef.current.find((entry) => String(entry.id) === String(rowId));
    setMyTrainings((current) =>
      current.map((row) => (
        String(row.id) === String(rowId)
          ? applyTrainingFieldChange(row, key, value)
          : row
      )),
    );
    if (existing && canEditOwnTrainings) {
      scheduleMyTrainingAutoSave(rowId);
    }
  }, [canEditOwnTrainings, scheduleMyTrainingAutoSave, statusOnlyTrainings, user]);

  const filteredMyTrainings = useMemo(() => {
    const search = trainingSearchFilter.trim().toLowerCase();
    const focusedId = focusedTrainingId;

    const filtered = myTrainings.filter((row) => {
      if (focusedId && String(row.id) !== focusedId) {
        return false;
      }
      if (trainingStatusFilter && row.status !== trainingStatusFilter) {
        return false;
      }
      if (trainingPriorityFilter && row.priority !== trainingPriorityFilter) {
        return false;
      }
      if (trainingUrgencyFilter && row.urgency !== trainingUrgencyFilter) {
        return false;
      }
      if (!search) {
        return true;
      }

      const haystack = [
        row.title,
        row.description,
        row.course_link,
      ].map((value) => String(value ?? '').toLowerCase()).join(' ');

      return haystack.includes(search);
    });

    return filtered;
  }, [
    focusedTrainingId,
    myTrainings,
    trainingPriorityFilter,
    trainingSearchFilter,
    trainingStatusFilter,
    trainingUrgencyFilter,
  ]);

  const hasTrainingFilters = Boolean(
    focusedTrainingId
    || trainingStatusFilter
    || trainingPriorityFilter
    || trainingUrgencyFilter
    || trainingSearchFilter.trim(),
  );

  const resetTrainingFilters = useCallback(() => {
    setTrainingStatusFilter('');
    setTrainingPriorityFilter('');
    setTrainingUrgencyFilter('');
    setTrainingSearchFilter('');
    setFocusedTraining('');
  }, [setFocusedTraining]);

  const handleSaveMyTrainings = useCallback(async () => {
    const rowsToSave = myTrainings;
    if (rowsToSave.length === 0) {
      return;
    }

    setSavingMyTrainings(true);
    try {
      // Operatives/trainees: persist Status only — never re-send schedule/override fields.
      if (statusOnlyTrainings) {
        const saved = await Promise.all(
          rowsToSave.map(async (row) => {
            const response = await api.put(`/trainings/${row.id}`, { status: row.status });
            showSaveNotifications(response.data?.notifications);
            return response.data?.data ?? { ...row, status: row.status };
          }),
        );
        const savedById = new Map(saved.map((row) => [String(row.id), row]));
        setMyTrainings((current) => current.map((row) => (
          savedById.get(String(row.id)) ?? row
        )));
        toast.success('Trainings saved.');
        setError('');
        return;
      }

      const originalsById = new Map(
        rowsToSave.map((row) => [String(row.id), { ...row }]),
      );

      const saved = await runWithOccupiedSlotGuard({
        rows: rowsToSave,
        context: trainingHistogramContext,
        originalsById,
        save: async (confirmOverride, overrideConflicts = []) => Promise.all(
          rowsToSave.map((row) => persistTrainingRecord({
            training: row,
            confirmOverride,
            previous: originalsById.get(String(row.id)) ?? null,
            context: trainingHistogramContext,
            overrideConflicts,
          })),
        ),
      });
      const savedById = new Map(
        saved.map((row) => [String(row.id), row]),
      );
      setMyTrainings((current) => current.map((row) => (
        savedById.get(String(row.id)) ?? row
      )));
      toast.success('Trainings saved.');
      setError('');
    } catch (err) {
      toast.error(err?.code === 'TRAINING_VALIDATION'
        ? err.message
        : getApiErrorMessage(err, 'Failed to save trainings.'));
    } finally {
      setSavingMyTrainings(false);
    }
  }, [myTrainings, runWithOccupiedSlotGuard, statusOnlyTrainings, toast, trainingHistogramContext]);

  const selectedProject = projects.find(
    (project) => String(project.id) === String(selectedProjectId),
  );
  const selectedPart = parts.find((part) => String(part.id) === String(selectedPartId));

  const loadProjects = async () => {
    setLoading(true);
    try {
      const [projectsRes, employeesRes] = await Promise.all([
        api.get('/projects'),
        api.get('/employees'),
      ]);
      setProjects(sortProjectsForPde(filterActiveProjects(projectsRes.data.data)));
      setEmployees(employeesRes.data.data);
      setError('');
    } catch {
      setError('Unable to load projects.');
    } finally {
      setLoading(false);
    }
  };

  const loadParts = async (projectId, preferredPartId = '') => {
    if (!projectId) {
      setParts([]);
      setSelectedPartId('');
      setTasks([]);
      return;
    }

    setPartsLoading(true);
    try {
      const response = await api.get(`/projects/${projectId}/parts`);
      const nextParts = response.data.data;
      setParts(nextParts);
      setError('');

      if (nextParts.length === 0) {
        setSelectedPartId('');
        setTasks([]);
        return;
      }

      const stillValid = preferredPartId
        && nextParts.some((part) => String(part.id) === String(preferredPartId));

      if (stillValid) {
        setSelectedPartId(String(preferredPartId));
        return;
      }

      if (nextParts.length === 1) {
        setSelectedPartId(String(nextParts[0].id));
        return;
      }

      setSelectedPartId('');
      setTasks([]);
    } catch {
      setError('Unable to load parts.');
      setParts([]);
      setSelectedPartId('');
    } finally {
      setPartsLoading(false);
    }
  };

  const loadTasks = async (partId) => {
    if (!partId) {
      setTasks([]);
      tasksBaselineRef.current = [];
      return;
    }

    setTasksLoading(true);
    try {
      const response = await api.get(`/parts/${partId}/tasks`);
      const nextTasks = response.data.data ?? [];
      setTasks(nextTasks);
      tasksBaselineRef.current = cloneTaskSyncSnapshot(nextTasks);
      setError('');
    } catch {
      setError('Unable to load project tasks.');
    } finally {
      setTasksLoading(false);
    }
  };

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (!projectFromUrl || projects.length === 0 || loading) {
      return;
    }

    const match = projects.find(
      (project) => String(project.id) === String(projectFromUrl),
    );
    if (match && String(selectedProjectId) !== String(match.id)) {
      setSelectedProjectId(String(match.id));
    }
  }, [projectFromUrl, projects, loading, selectedProjectId]);

  useEffect(() => {
    loadParts(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    const stillVisible = projects.some(
      (project) => String(project.id) === String(selectedProjectId),
    );
    if (!stillVisible) {
      setSelectedProjectId('');
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    loadTasks(selectedPartId);
    setSelectedTaskRows([]);
  }, [selectedPartId]);

  const applyOwnerToTask = useCallback(
    (task, skipOwnerUpdate = false) => {
      if (skipOwnerUpdate || !ownerName) {
        return task;
      }
      // Stamp owner + dl_owner directly so hour edits always take ownership,
      // even when other derived fields also change in the same update.
      return applyDlTaskFieldChange(task, 'owner', ownerName);
    },
    [ownerName],
  );

  const handleTaskChange = useCallback((rowIndex, key, value, rowIndices, options = {}) => {
    const indices = rowIndices?.length
      ? new Set(rowIndices)
      : new Set([rowIndex]);
    const patch = key && typeof key === 'object' ? key : { [key]: value };
    const patchHasOwner = Object.prototype.hasOwnProperty.call(patch, 'owner');

    setTasks((current) =>
      current.map((task, index) => {
        if (!indices.has(index)) {
          return task;
        }

        let updated = task;
        Object.entries(patch).forEach(([fieldKey, fieldValue]) => {
          updated = applyDlTaskFieldChange(updated, fieldKey, fieldValue);
        });

        if (!options.skipOwnerUpdate && !patchHasOwner) {
          updated = applyOwnerToTask(updated);
        }

        return updated;
      }),
    );
  }, [applyOwnerToTask]);

  const handleSaveTasks = async (options = {}) => {
    if (!selectedPartId) {
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });

    setSavingTasks(true);
    try {
      const savingAlgorithm = Boolean(options.algorithmRun) || algorithmSavePendingRef.current;

      if (savingAlgorithm) {
        await saveAllAlgorithmResults(api);
        algorithmSavePendingRef.current = false;
      }

      const response = await syncPartTasksWithConflict(api, selectedPartId, {
        tasks: tasksRef.current,
        baselineTasks: tasksBaselineRef.current,
        extra: {
          algorithm_run: savingAlgorithm,
          source: 'dl',
        },
      });
      const nextTasks = response.data.data ?? [];
      setTasks(nextTasks);
      tasksBaselineRef.current = cloneTaskSyncSnapshot(nextTasks);
      toast.success(
        taskSyncSuccessMessage(
          response,
          savingAlgorithm
            ? 'Algorithm results saved for all projects.'
            : 'DL updates saved.',
        ),
      );
      showTaskSyncNotifications(toast, response.data.notifications);
      setError('');
    } catch (err) {
      if (isTaskSyncCancelled(err)) {
        return;
      }
      const message = getApiErrorMessage(err, 'Unable to save tasks.');
      toast.error(message);
      setError(message);
    } finally {
      setSavingTasks(false);
    }
  };

  const handleRunAlgorithm = async () => {
    if (!selectedPartId) {
      return;
    }

    const activeTasks = tasks.filter((task) => !task.done);
    if (activeTasks.length === 0) {
      toast.info('No active tasks to run the algorithm on.');
      return;
    }

    setRunningAlgorithm(true);
    setAlgorithmProgress({ percent: 8, stage: 'Preparing tasks…', processedProjects: 0, totalProjects: 0 });
    try {
      setAlgorithmProgress({ percent: 18, stage: 'Saving tasks…', processedProjects: 0, totalProjects: 0 });
      const syncResponse = await syncPartTasksWithConflict(api, selectedPartId, {
        tasks: tasksRef.current,
        baselineTasks: tasksBaselineRef.current,
        extra: {
          algorithm_run: false,
          source: 'dl',
        },
      });
      const syncedTasks = syncResponse.data.data ?? tasksRef.current;
      tasksRef.current = syncedTasks;
      tasksBaselineRef.current = cloneTaskSyncSnapshot(syncedTasks);
      setTasks(syncedTasks);

      setAlgorithmProgress({ percent: 28, stage: 'Initializing algorithm…', processedProjects: 0, totalProjects: 0, processedTasks: 0, totalTasks: 0 });
      const { filteredTasks, processed, totalTasks, skippedTasks } = await runAlgorithmByProject(api, (progress) => {
        setAlgorithmProgress(progress);
      });

      setAlgorithmProgress({
        percent: 92,
        stage: 'Applying results…',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      const mergedTasks = mergeAlgorithmResults(syncedTasks, filteredTasks, employees, {
        usePlanGate: true,
      });
      tasksRef.current = mergedTasks;
      setTasks(mergedTasks);

      setAlgorithmProgress({
        percent: 96,
        stage: 'Saving algorithm results…',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      await saveAllAlgorithmResults(api);
      algorithmSavePendingRef.current = false;
      await loadTasks(selectedPartId);

      setAlgorithmProgress({
        percent: 100,
        stage: 'Complete — assignments applied',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      if (SHOW_ALGORITHM_SKIPPED_MODAL && skippedTasks?.length > 0) {
        setAlgorithmSkippedTasks(skippedTasks);
        setShowAlgorithmSkippedModal(true);
      }
      toast.success(
        `Algorithm finished and saved (${processed} / ${totalTasks} tasks). Review overrides if needed.`,
      );
      setError('');
      await algorithmRunSleep(600);
    } catch (err) {
      if (isTaskSyncCancelled(err)) {
        return;
      }
      const message =
        err.response?.data?.error ||
        err.response?.data?.message ||
        'Unable to run the algorithm.';
      toast.error(message);
      setError(message);
    } finally {
      setRunningAlgorithm(false);
      setAlgorithmProgress(initialAlgorithmProgress());
    }
  };

  const { handleColorChange } = useDebouncedProjectColorUpdate({
    selectedProjectId,
    setProjects,
    toast,
    onError: setError,
  });

  if (loading) {
    return <ProjectsPageSkeleton />;
  }

  return (
    <section className={`pde-page dl-page${viewMode === DL_VIEW_TRAININGS ? ' dl-page--trainings' : ''}`}>
      <PageHeader
        compact
        title="DL Project Data Update"
        actions={(
          <div className="pde-header-actions">
            <div
              className="trainings-view-toggle dl-view-toggle"
              role="tablist"
              aria-label="DL page view"
              data-active-view={viewMode}
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === DL_VIEW_PROJECTS}
                className={`btn btn-secondary btn-sm trainings-view-tab${viewMode === DL_VIEW_PROJECTS ? ' is-active' : ''}`}
                onClick={() => setViewMode(DL_VIEW_PROJECTS)}
              >
                Projects
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === DL_VIEW_TRAININGS}
                className={`btn btn-secondary btn-sm trainings-view-tab${viewMode === DL_VIEW_TRAININGS ? ' is-active' : ''}`}
                onClick={() => setViewMode(DL_VIEW_TRAININGS)}
              >
                My trainings
              </button>
            </div>
            {viewMode === DL_VIEW_TRAININGS ? (
              <>
                <span
                  className={`dl-my-trainings-autosave is-${myTrainingsAutoSaveState}`}
                  title="Training edits auto-save after you pause typing"
                >
                  {{
                    idle: 'Auto-save on',
                    pending: 'Saving…',
                    saving: 'Saving…',
                    saved: 'Saved',
                    error: 'Save failed',
                  }[myTrainingsAutoSaveState] || 'Auto-save on'}
                </span>
                <button
                  type="button"
                  className="btn btn-save btn-compact"
                  onClick={handleSaveMyTrainings}
                  disabled={!canEditOwnTrainings || myTrainings.length === 0 || savingMyTrainings || !trainingEmployee}
                  title="Save all trainings now"
                >
                  {savingMyTrainings ? 'Saving...' : 'Save'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={() => setShowActivityLogModal(true)}
                  title="See which DL changed the plan, when, and what they changed"
                >
                  Edits Log History
                </button>
                <button
                  type="button"
                  className="btn btn-save btn-compact"
                  onClick={() => {
                    if (canWarnExceedsDl) {
                      const overBudget = findTasksExceedingDlHours(tasksRef.current, {
                        compareDlSectionsOnly: true,
                        addedByName: ownerName,
                      });
                      if (overBudget.length > 0) {
                        setExceedsDlTasks(overBudget);
                        setShowExceedsDlModal(true);
                        return;
                      }
                    }
                    if (canRunDlAlgorithm) {
                      setShowRunAlgoAfterSaveModal(true);
                      return;
                    }
                    handleSaveTasks();
                  }}
                  disabled={!canEditDlHours || !selectedPartId || savingTasks || runningAlgorithm}
                  title="Save DL updates. You will be asked whether to run the algorithm."
                >
                  {savingTasks || runningAlgorithm
                    ? (runningAlgorithm ? 'Running...' : 'Saving...')
                    : 'Save'}
                </button>
              </>
            )}
          </div>
        )}
      />

      {error && (
        <div className="alert alert-error pde-alert" role="alert">
          {error}
        </div>
      )}

      {viewMode === DL_VIEW_TRAININGS ? (
        <div className={`trainings-view-stage${myTrainingsLoading ? ' is-refreshing' : ''}`}>
          {!trainingEmployee ? (
            <div className="card dl-my-trainings-alert">
              <p className="muted dl-my-trainings-empty">
                {employeeFromUrl
                  ? 'Unable to find that operative profile for training updates.'
                  : 'Your user account is not linked to an operative profile. Contact an administrator if trainings are missing.'}
              </p>
            </div>
          ) : null}

          {trainingEmployee && myTrainings.length > 0 ? (
            <div className="availability-toolbar card dl-my-trainings-toolbar">
              <div className="availability-toolbar-filters dl-my-trainings-toolbar-filters">
                {viewingOtherOperative ? (
                  <div className="dl-my-trainings-context">
                    Viewing trainings for
                    {' '}
                    <strong>{employeeDisplayName(trainingEmployee)}</strong>
                  </div>
                ) : null}
                <label className="dl-my-trainings-filter--training">
                  Training
                  <select
                    className="dl-my-trainings-filter"
                    value={focusedTrainingId}
                    onChange={(e) => setFocusedTraining(e.target.value)}
                  >
                    <option value="">All trainings</option>
                    {myTrainings.map((row) => (
                      <option key={row.id} value={String(row.id)}>
                        {row.title || 'Untitled'}
                        {row.start_date ? ` (${formatDisplayDate(row.start_date)})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Search
                  <input
                    className="dl-my-trainings-filter"
                    type="search"
                    value={trainingSearchFilter}
                    onChange={(e) => setTrainingSearchFilter(e.target.value)}
                    placeholder="Title, description, link"
                  />
                </label>
                <label>
                  Status
                  <select
                    className="dl-my-trainings-filter"
                    value={trainingStatusFilter}
                    onChange={(e) => setTrainingStatusFilter(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {TRAINING_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select
                    className="dl-my-trainings-filter"
                    value={trainingPriorityFilter}
                    onChange={(e) => setTrainingPriorityFilter(e.target.value)}
                  >
                    <option value="">All priorities</option>
                    {TRAINING_PRIORITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Urgency
                  <select
                    className="dl-my-trainings-filter"
                    value={trainingUrgencyFilter}
                    onChange={(e) => setTrainingUrgencyFilter(e.target.value)}
                  >
                    <option value="">All urgency</option>
                    {TRAINING_URGENCY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {hasTrainingFilters ? (
                <div className="availability-toolbar-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-compact"
                    onClick={resetTrainingFilters}
                  >
                    Clear filters
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {myTrainingsLoading && myTrainings.length === 0 ? (
            <TaskGridSkeleton />
          ) : (
            <DlMyTrainingsPanel
              rows={filteredMyTrainings}
              totalCount={myTrainings.length}
              operativeName={trainingEmployee ? employeeDisplayName(trainingEmployee) : (ownerName || '')}
              onChange={canEditOwnTrainings ? handleMyTrainingChange : undefined}
              readOnly={!canEditOwnTrainings}
              statusOnly={statusOnlyTrainings}
              dateFieldsReadOnly={isDlUser(user) || statusOnlyTrainings}
              statusLabel={trainingStatusLabel}
              focusedTrainingId={focusedTrainingId}
              emptyMessage={trainingEmployee ? 'No trainings scheduled for this operative.' : 'Unable to load trainings without an operative profile.'}
              filteredEmptyMessage="No trainings match the current filters."
            />
          )}
        </div>
      ) : (
        <>
      <div className="card project-picker">
        <div className="project-picker-row pde-controls">
          <div className="pde-controls-group pde-controls-group--filters">
            <label className="project-select-field">
              Select project
              <ProjectColorSelect
                projects={projects}
                value={selectedProjectId}
                onChange={setSelectedProjectId}
              />
            </label>

            {selectedProjectId ? (
              <>
                <label className="project-select-field">
                  Select part
                  <select
                    value={selectedPartId}
                    disabled={partsLoading}
                    onChange={(e) => setSelectedPartId(e.target.value)}
                  >
                    <option value="">
                      {partsLoading ? 'Loading parts...' : '\u00a0'}
                    </option>
                    {parts.map((part) => (
                      <option key={part.id} value={part.id}>
                        {part.name}
                        {part.tasks_count != null ? ` (${part.tasks_count} tasks)` : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="project-color-field">
                  <span className="project-color-label">Project color</span>
                  <input
                    type="color"
                    className="project-color-input"
                    value={displayProjectColor(selectedProject)}
                    onChange={handleColorChange}
                    title="Gantt bar colour for this project"
                  />
                </label>
              </>
            ) : null}
          </div>
        </div>

        {selectedProject && (
          <div className="project-meta pde-project-meta">
            <span>Status: {formatProjectStatus(selectedProject)}</span>
            {selectedPart && <span>Part: {selectedPart.name}</span>}
          </div>
        )}

        {selectedProjectId && !partsLoading && parts.length === 0 && (
          <p className="muted pde-empty-parts">No parts yet. Create a part in Project Data Entry first.</p>
        )}
      </div>

      {selectedPartId && (
        <>
          {tasksLoading ? (
            <TaskGridSkeleton />
          ) : (
            <>
              <DlPageLegend
                trailing={
                  selectedTaskRows.length > 0 ? (
                    <div className="project-task-bulk-hint project-task-bulk-hint--legend" role="status">
                      {selectedTaskRows.length} task{selectedTaskRows.length === 1 ? '' : 's'} selected — edits apply instantly to all selected rows.
                    </div>
                  ) : null
                }
              />
              <ProjectTaskGrid
              key={`dl-tasks-${selectedPartId}`}
              tasks={tasks}
              employees={employees}
              onChange={canEditDlHours ? handleTaskChange : undefined}
              selectedRows={selectedTaskRows}
              onSelectedRowsChange={setSelectedTaskRows}
              sections={dlTaskSections}
              pageClassName="dl-task-panel"
              inactiveRowPredicate={taskHasPlanHours}
              lockedFieldPredicate={canEditDlHours ? undefined : () => true}
              applyDlPlanReduction
              preferDlOwner
            />
            </>
          )}
        </>
      )}

      {occupiedSlotModal}

      <AlgorithmRunningOverlay
        open={runningAlgorithm}
        progress={algorithmProgress.percent}
        stage={algorithmProgress.stage}
        processedProjects={algorithmProgress.processedProjects}
        totalProjects={algorithmProgress.totalProjects}
        processedTasks={algorithmProgress.processedTasks}
        totalTasks={algorithmProgress.totalTasks}
      />

      {SHOW_ALGORITHM_SKIPPED_MODAL ? (
        <AlgorithmSkippedTasksModal
          open={showAlgorithmSkippedModal}
          tasks={algorithmSkippedTasks}
          onClose={() => setShowAlgorithmSkippedModal(false)}
        />
      ) : null}
      <ExceedsDlHoursModal
        open={showExceedsDlModal}
        onClose={() => {
          if (savingTasks || runningAlgorithm) {
            return;
          }
          setShowExceedsDlModal(false);
          setExceedsDlTasks([]);
        }}
        onConfirm={() => {
          setShowExceedsDlModal(false);
          setExceedsDlTasks([]);
          setShowRunAlgoAfterSaveModal(true);
        }}
        busy={savingTasks || runningAlgorithm}
        tasks={exceedsDlTasks}
      />
      <RunAlgorithmAfterSaveModal
        open={showRunAlgoAfterSaveModal}
        onClose={() => setShowRunAlgoAfterSaveModal(false)}
        onSaveOnly={async () => {
          setShowRunAlgoAfterSaveModal(false);
          await handleSaveTasks();
        }}
        onSaveAndRun={async () => {
          setShowRunAlgoAfterSaveModal(false);
          await handleRunAlgorithm();
        }}
        busy={savingTasks || runningAlgorithm}
        contextLabel="DL updates"
      />
      <ActivityLogModal
        open={showActivityLogModal}
        onClose={() => setShowActivityLogModal(false)}
        area="dl"
        endpoint="/resource-histogram/activity-logs"
        extraParams={DL_PLAN_LOG_PARAMS}
        limit={100}
        title="DL plan edits"
        emptyMessage="No DL plan changes recorded yet."
      />
      {taskSyncConflictModal}
        </>
      )}
    </section>
  );
}
