import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import api from '../../api/client';
import ProjectTaskGrid from '../ProjectTaskGrid';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { dlTaskSections, taskSections } from '../../constants/projectTaskFields';
import { isDlUser } from '../../utils/userPermissions';
import { useDraggablePanel } from '../../hooks/useDraggablePanel';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { useTaskSyncConflictModal } from '../../hooks/useTaskSyncConflictModal';
import { isTaskSyncCancelled } from '../../utils/taskSync';
import { showTaskSyncNotifications } from '../../utils/taskSyncNotifications';
import { formatHoursDisplay } from '../../utils/formatHoursDisplay';
import { applyDlTaskFieldChange, applyPdeTaskFieldChange, normalizeTaskForSave, recalculatePdeDerivedFields } from '../../utils/taskCalculations';
import { deriveTaskOverridesFromRelatedBars } from '../../utils/taskOverrides';
import { formatDisplayDate, toStorageDate } from '../../utils/dateFormat';
import { applyDlMirrorOnChange, applyDlMirrorValuesToPde, isDlMirrorLocked } from '../../utils/dlMirrorFields';
import { buildTaskNameOptions, getRapForTaskName } from '../../utils/nrmTasks';
import { applyDoneCheckboxChange } from '../../utils/pdeDoneEffects';
import { taskHasPlanHours } from '../../utils/algorithm';
import {
  collectTeamOapNrmNumbers,
  filterTasksForTeamOapSections,
  resolveTeamIdForAssignee,
} from '../../utils/teamOapTasks';
import { applyHistogramBarToTask, taskDraftAffectsHistogram } from './taskEditorLivePreview';
import { revealTaskEditorSelection } from './taskEditorPanelLayout';
import './histogram-detail-panel.css';

function prepareTask(task, nrms) {
  return recalculatePdeDerivedFields(applyDlMirrorValuesToPde(task), { nrms });
}

function stampDlDoneMirrors(task) {
  let next = applyDlMirrorOnChange(task, 'done', task.done);
  next = applyDlMirrorOnChange(next, 'progress_per', next.progress_per);
  next = applyDlMirrorOnChange(next, 'owner', next.owner);
  return applyDlMirrorOnChange(next, 'project_completion_date', next.project_completion_date);
}

function readNavbarHeight() {
  if (typeof document === 'undefined') {
    return 64;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--app-navbar-height')
    .trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 64;
}

function defaultPanelSize() {
  if (typeof window === 'undefined') {
    return { width: 1100, height: 420 };
  }
  const contentHeight = window.innerHeight - readNavbarHeight();
  return {
    width: Math.round(window.innerWidth * 0.75),
    height: Math.min(520, Math.round(contentHeight * 0.55)),
  };
}

const DRAFT_DEBOUNCE_MS = 280;
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Fields that reshape histogram bars. These only push to the chart when the
 * cell commits (blur / Enter / select change) — never while typing.
 */
const HISTOGRAM_COMMIT_KEYS = new Set([
  'override_1',
  'override_2',
  'override_3',
  'doc_supply',
  'completion',
  'adj',
  'dl',
  'buf',
  'hrs_per',
  'red',
  'plan',
  'est',
]);

function resolvePanelPosition() {
  return { x: 12, y: 12 };
}

const HistogramTaskEditorPanel = forwardRef(function HistogramTaskEditorPanel({
  bar,
  taskBars = null,
  anchorRect = null,
  employees = [],
  isBarEditPreview = false,
  onClose,
  onFilterProject,
  onDraftChange,
  onPdeAutoSaved,
  onSelectionChange,
  readOnly = false,
}, ref) {
  const { user } = useAuth();
  const dlEditor = isDlUser(user);
  const toast = useToast();
  const { syncPartTasksWithConflict, taskSyncConflictModal } = useTaskSyncConflictModal();
  const [task, setTask] = useState(null);
  const [baselineTask, setBaselineTask] = useState(null);
  const [partTasks, setPartTasks] = useState([]);
  const [allocationEmployees, setAllocationEmployees] = useState([]);
  const [nrms, setNrms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoSaveState, setAutoSaveState] = useState('idle');
  const [error, setError] = useState('');
  const taskRef = useRef(task);
  const partTasksRef = useRef(partTasks);
  const gridTasksRef = useRef([]);
  const baselineRef = useRef(null);
  const baselineByTaskIdRef = useRef(new Map());
  const syncingFromBarRef = useRef(false);
  const lastBarSyncKeyRef = useRef('');
  const barInitializedRef = useRef(false);
  const pendingBarSyncDirtyRef = useRef(false);
  const skipUnmountPersistRef = useRef(false);
  const prevBarRef = useRef(null);
  const prevRelatedBarsRef = useRef(null);
  const draftTimerRef = useRef(null);
  const skipBarToTaskAdjSyncRef = useRef(false);
  const skipOverrideDeriveRef = useRef(false);
  const wasBarEditPreviewRef = useRef(false);
  const dirtyPdeRef = useRef(false);
  const lastDraftForUndoRef = useRef(null);
  const onDraftChangeRef = useRef(onDraftChange);
  const savingPdeRef = useRef(false);
  const panelRef = useRef(null);

  taskRef.current = task;
  partTasksRef.current = partTasks;
  baselineRef.current = baselineTask;
  onDraftChangeRef.current = onDraftChange;

  const navbarHeight = useMemo(() => readNavbarHeight(), []);
  const initialPosition = useMemo(() => resolvePanelPosition(), []);
  const defaultSize = useMemo(() => defaultPanelSize(), []);
  const { position, setPosition, dragHandleProps } = useDraggablePanel(initialPosition);
  const { size, setSize, getResizeHandleProps } = useResizablePanel({
    position,
    setPosition,
    initialWidth: defaultSize.width,
    initialHeight: defaultSize.height,
    minWidth: 520,
    minHeight: 280,
    storageKey: 'histogram-task-editor-size-v2',
    topInset: navbarHeight,
  });
  const positionRef = useRef(position);
  const sizeRef = useRef(size);
  positionRef.current = position;
  sizeRef.current = size;
  const [selectedRows, setSelectedRows] = useState([]);

  const relatedBars = useMemo(() => {
    if (Array.isArray(taskBars) && taskBars.length > 0) {
      return taskBars;
    }
    return bar ? [bar] : [];
  }, [taskBars, bar]);

  const relatedBarsSyncKey = useMemo(
    () => relatedBars.map((entry) => (
      [
        entry.id,
        entry.start,
        entry.end,
        entry.hours,
        JSON.stringify(entry.hours_by_day || {}),
      ].join(':')
    )).join('||'),
    [relatedBars],
  );

  const headerHours = useMemo(() => {
    const plan = Number(task?.plan);
    if (Number.isFinite(plan) && plan > 0) {
      return plan;
    }
    const fromBars = relatedBars.reduce((sum, entry) => {
      if (entry._suppressedByBarEdit) {
        return sum;
      }
      return sum + (Number(entry.hours) || 0);
    }, 0);
    if (fromBars > 0.001) {
      return fromBars;
    }
    return Number(bar?.hours) || 0;
  }, [bar?.hours, relatedBars, task?.plan]);

  const partId = bar?.part_id ?? task?.part_id ?? null;
  const taskId = bar?.task_id ?? bar?.id;

  const persistPde = useCallback(async () => {
    if (readOnly) {
      return null;
    }
    const resolvedPartId = partId || taskRef.current?.part_id || null;
    if (!resolvedPartId || !taskRef.current) {
      setAutoSaveState('error');
      setError('Unable to save — missing part id for this task.');
      return null;
    }

    if (savingPdeRef.current) {
      return null;
    }

    savingPdeRef.current = true;
    setAutoSaveState('saving');
    try {
      const updated = normalizeTaskForSave({
        ...taskRef.current,
        done: Boolean(taskRef.current.done),
      });
      const rows = partTasksRef.current.length > 0
        ? partTasksRef.current
        : [taskRef.current];
      const merged = rows.map((row) => (
        String(row.id) === String(updated.id)
          ? updated
          : normalizeTaskForSave({ ...row, done: Boolean(row.done) })
      ));
      const response = await syncPartTasksWithConflict(api, resolvedPartId, {
        tasks: merged,
        baselineTasks: rows,
        extra: { source: dlEditor ? 'dl' : 'pde' },
      });
      showTaskSyncNotifications(toast, response.data?.notifications);
      const savedTasks = (response.data?.data ?? []).map((row) => prepareTask(row, nrms));
      const saved = savedTasks.find((row) => String(row.id) === String(taskId));
      const nextTask = saved ? { ...saved } : { ...taskRef.current };
      if (savedTasks.length > 0) {
        setPartTasks(savedTasks);
        partTasksRef.current = savedTasks;
        savedTasks.forEach((row) => {
          baselineByTaskIdRef.current.set(String(row.id), { ...row });
        });
      }
      setTask(nextTask);
      setBaselineTask({ ...nextTask });
      dirtyPdeRef.current = false;
      setAutoSaveState('saved');
      setError('');
      onPdeAutoSaved?.(nextTask, { partId: resolvedPartId });
      return nextTask;
    } catch (err) {
      if (isTaskSyncCancelled(err)) {
        setAutoSaveState('unsaved');
        return null;
      }
      setAutoSaveState('error');
      setError(getApiErrorMessage(err, 'Unable to save task changes.'));
      throw err;
    } finally {
      savingPdeRef.current = false;
    }
  }, [dlEditor, nrms, onPdeAutoSaved, partId, readOnly, syncPartTasksWithConflict, taskId, toast]);

  const markPdeDirty = useCallback(() => {
    dirtyPdeRef.current = true;
    setAutoSaveState((current) => (current === 'saving' ? current : 'unsaved'));
  }, []);

  const flushDraft = useCallback(() => {
    if (draftTimerRef.current) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (taskRef.current) {
      onDraftChangeRef.current?.(taskRef.current, baselineRef.current, {
        previousTask: lastDraftForUndoRef.current,
      });
      lastDraftForUndoRef.current = { ...taskRef.current };
    }
  }, []);

  const flushAndSavePde = useCallback(async () => {
    flushDraft();
    if (!dirtyPdeRef.current) {
      return null;
    }
    return persistPde();
  }, [flushDraft, persistPde]);

  const cancelPendingDraft = useCallback(() => {
    if (draftTimerRef.current) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  const handleDismissClose = useCallback(() => {
    skipUnmountPersistRef.current = true;
    dirtyPdeRef.current = false;
    cancelPendingDraft();
    // Do not flushDraft — closing must not push unsaved field edits onto the chart.
    onClose?.();
  }, [cancelPendingDraft, onClose]);

  const handleRequestClose = useCallback(() => {
    handleDismissClose();
  }, [handleDismissClose]);

  const handleSaveClick = useCallback(() => {
    flushAndSavePde().catch(() => {});
  }, [flushAndSavePde]);

  useImperativeHandle(ref, () => ({
    flushDraft,
    getTask: () => (taskRef.current ? { ...taskRef.current } : null),
    applyTask: (nextTask) => {
      if (!nextTask) {
        return;
      }
      syncingFromBarRef.current = true;
      setTask({ ...nextTask });
      setBaselineTask({ ...nextTask });
      lastDraftForUndoRef.current = { ...nextTask };
      onDraftChangeRef.current?.(nextTask, nextTask, { fromBar: true });
      queueMicrotask(() => {
        syncingFromBarRef.current = false;
      });
      markPdeDirty();
    },
    savePdeNow: () => flushAndSavePde(),
    isDirty: () => dirtyPdeRef.current,
    revealTask: (taskId) => revealTaskEditorSelection({
      taskId,
      panelElement: panelRef.current,
      position: positionRef.current,
      size: sizeRef.current,
      setPosition,
      setSize,
      overlayTop: navbarHeight,
      minWidth: 520,
      minHeight: 280,
    }),
  }), [flushAndSavePde, flushDraft, markPdeDirty, navbarHeight, setPosition, setSize]);

  useEffect(() => {
    if (!partId || !taskId) {
      setLoading(false);
      setError('This task cannot be edited — missing part or task id.');
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');
    setAutoSaveState('idle');
    dirtyPdeRef.current = false;
    skipUnmountPersistRef.current = false;
    pendingBarSyncDirtyRef.current = false;
    onDraftChangeRef.current?.(null, null);

    (async () => {
      try {
        const [tasksRes, nrmsRes, allocationRes] = await Promise.all([
          api.get(`/parts/${partId}/tasks`),
          api.get('/nrms'),
          api.get('/operatives-allocation').catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        const loadedNrms = nrmsRes.data?.data ?? [];
        const loadedTasks = (tasksRes.data?.data ?? []).map((row) => prepareTask(row, loadedNrms));
        const loadedAllocationEmployees = allocationRes?.data?.data?.employees ?? [];
        const match = loadedTasks.find((row) => String(row.id) === String(taskId));
        setNrms(loadedNrms);
        setAllocationEmployees(loadedAllocationEmployees);
        setPartTasks(loadedTasks);
        baselineByTaskIdRef.current = new Map(
          loadedTasks.map((row) => [String(row.id), { ...row }]),
        );
        if (match) {
          // Show the same row Project Data Entry shows. Do not infer Adj,
          // Plan, or overrides from the histogram bars just because the panel opened.
          const prepared = { ...match };
          barInitializedRef.current = false;
          lastBarSyncKeyRef.current = '';
          prevBarRef.current = null;
          prevRelatedBarsRef.current = null;
          skipOverrideDeriveRef.current = true;
          lastDraftForUndoRef.current = { ...prepared };
          setTask(prepared);
          setBaselineTask({ ...prepared });
          baselineByTaskIdRef.current.set(String(prepared.id), { ...prepared });
          onDraftChangeRef.current?.(prepared, prepared, { initialize: true });
        } else {
          setTask(null);
          setBaselineTask(null);
          setError('Task not found in project data.');
        }
      } catch (err) {
        if (!cancelled) {
          setError(getApiErrorMessage(err, 'Unable to load task for editing.'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      onDraftChangeRef.current?.(null, null);
    };
    // Load once per task open — avoid reloading on every relatedBars / callback identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId, taskId]);

  useEffect(() => {
    if (!taskRef.current || loading || syncingFromBarRef.current) {
      return;
    }
    if (!relatedBars.length) {
      return;
    }

    // The first pass after open is the PDE row. Deriving overrides here would
    // replace that row with whoever currently has a bar, before the user edits.
    if (skipOverrideDeriveRef.current) {
      skipOverrideDeriveRef.current = false;
      return;
    }

    const derived = deriveTaskOverridesFromRelatedBars(taskRef.current, relatedBars);
    // Merge override slots only — preserve in-progress PDE edits on other fields.
    const next = {
      ...taskRef.current,
      override_1: derived.override_1 ?? '',
      override_2: derived.override_2 ?? '',
      override_3: derived.override_3 ?? '',
    };
    const changed = ['1', '2', '3'].some((slot) => (
      String(next[`override_${slot}`] ?? '') !== String(taskRef.current[`override_${slot}`] ?? '')
    ));
    if (!changed) {
      return;
    }

    syncingFromBarRef.current = true;
    setTask(next);
    setPartTasks((current) => {
      if (!current.length) {
        return current;
      }
      const updated = current.map((row) => (
        String(row.id) === String(next.id) ? next : row
      ));
      partTasksRef.current = updated;
      return updated;
    });
    // Do not advance PDE baseline when dirty — only reflect overrides in the grid.
    if (!dirtyPdeRef.current) {
      setBaselineTask({ ...next });
      baselineByTaskIdRef.current.set(String(next.id), { ...next });
    }
    lastDraftForUndoRef.current = { ...next };
    onDraftChangeRef.current?.(next, baselineRef.current, { fromBar: true });
    queueMicrotask(() => {
      syncingFromBarRef.current = false;
    });
  }, [loading, relatedBarsSyncKey]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        handleDismissClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDismissClose]);

  useEffect(() => {
    if (isBarEditPreview || !pendingBarSyncDirtyRef.current) {
      return;
    }
    pendingBarSyncDirtyRef.current = false;
    markPdeDirty();
  }, [isBarEditPreview, markPdeDirty]);

  const scheduleDraftChange = useCallback((nextTask, previousTask, options = {}) => {
    // Only push to the histogram when the cell has committed (blur / Enter /
    // select) or when Save flushes — never mid-keystroke.
    const pushToHistogram = options.pushToHistogram !== false;
    const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : DRAFT_DEBOUNCE_MS;
    if (draftTimerRef.current) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    markPdeDirty();

    if (!pushToHistogram) {
      return;
    }

    const taskKey = String(nextTask.id);
    const emitDraft = () => {
      const rowBaseline = baselineByTaskIdRef.current.get(taskKey) ?? baselineRef.current;
      if (taskDraftAffectsHistogram(nextTask, rowBaseline)) {
        // Task editor pushed bars (plan/adj/schedule) — do not treat the resulting
        // bar hour delta as a resize and stack it onto Adj again.
        skipBarToTaskAdjSyncRef.current = true;
      }
      onDraftChangeRef.current?.(nextTask, rowBaseline, { previousTask });
      baselineByTaskIdRef.current.set(taskKey, { ...nextTask });
      if (String(taskId) === taskKey) {
        lastDraftForUndoRef.current = { ...nextTask };
      }
    };

    if (options.immediate) {
      emitDraft();
      return;
    }

    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      emitDraft();
    }, delayMs);
  }, [markPdeDirty, taskId]);

  useEffect(() => () => {
    if (draftTimerRef.current) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!taskRef.current || !bar) {
      return;
    }

    // Hour totals change when the view window expands and clipped days appear.
    // That is not a resize. Only a live bar drag, or the commit right after one,
    // should move Adj.
    const applyHourDelta = isBarEditPreview || wasBarEditPreviewRef.current;
    wasBarEditPreviewRef.current = isBarEditPreview;

    const syncKey = [
      bar.id,
      bar.start,
      bar.end,
      bar.hours,
      bar.doc_supply,
      bar.completion,
      bar.employee,
      bar.override_1,
      bar.override_2,
      bar.override_3,
      bar.task_name,
      bar.progress_per,
      bar.done,
      relatedBarsSyncKey,
    ].join('|');

    if (!barInitializedRef.current) {
      lastBarSyncKeyRef.current = syncKey;
      prevBarRef.current = bar;
      prevRelatedBarsRef.current = relatedBars.map((entry) => ({ ...entry }));
      barInitializedRef.current = true;
      return;
    }

    if (syncKey === lastBarSyncKeyRef.current) {
      return;
    }

    if (skipBarToTaskAdjSyncRef.current) {
      skipBarToTaskAdjSyncRef.current = false;
      lastBarSyncKeyRef.current = syncKey;
      prevBarRef.current = bar;
      prevRelatedBarsRef.current = relatedBars.map((entry) => ({ ...entry }));
      return;
    }

    lastBarSyncKeyRef.current = syncKey;

    const previousRelatedBars = prevRelatedBarsRef.current;
    const nextTask = applyHistogramBarToTask(
      taskRef.current,
      bar,
      prevBarRef.current,
      {
        relatedBars,
        previousRelatedBars,
        nrms,
        applyHourDelta,
      },
    );
    prevBarRef.current = bar;
    prevRelatedBarsRef.current = relatedBars.map((entry) => ({ ...entry }));
    if (nextTask === taskRef.current) {
      return;
    }

    syncingFromBarRef.current = true;
    setTask(nextTask);
    setPartTasks((current) => {
      if (!current.length) {
        return current;
      }
      const next = current.map((row) => (
        String(row.id) === String(nextTask.id) ? nextTask : row
      ));
      partTasksRef.current = next;
      return next;
    });
    setBaselineTask({ ...nextTask });
    baselineByTaskIdRef.current.set(String(nextTask.id), { ...nextTask });
    lastDraftForUndoRef.current = { ...nextTask };
    onDraftChangeRef.current?.(nextTask, nextTask, { fromBar: true });
    // Opening the editor (and the view-range expand that follows) syncs the
    // bar into the form and moves the baseline with it. That is not an edit.
    // Only a live bar drag/resize should mark the panel unsaved.
    if (isBarEditPreview) {
      pendingBarSyncDirtyRef.current = true;
    }
    queueMicrotask(() => {
      syncingFromBarRef.current = false;
    });
  }, [
    bar,
    relatedBars,
    relatedBarsSyncKey,
    nrms,
    isBarEditPreview,
  ]);

  const handleChange = useCallback((rowIndex, key, value, rowIndices) => {
    if (syncingFromBarRef.current) {
      return;
    }

    const indices = Array.isArray(rowIndices) && rowIndices.length > 0
      ? rowIndices
      : [rowIndex];

    const visibleRows = gridTasksRef.current;
    const targetIds = new Set(
      indices
        .map((index) => visibleRows[index]?.id)
        .filter((id) => id != null)
        .map(String),
    );

    const rows = partTasksRef.current.length > 0
      ? partTasksRef.current
      : (taskRef.current ? [taskRef.current] : []);
    const previousRowsById = new Map(
      rows
        .filter((row) => targetIds.has(String(row.id)))
        .map((row) => [String(row.id), { ...row }]),
    );
    const nextRows = rows.map((row) => {
      if (!targetIds.has(String(row.id))) {
        return row;
      }
      if (key === 'done') {
        const next = applyDoneCheckboxChange(row, Boolean(value), { user, employees });
        return dlEditor ? stampDlDoneMirrors(next) : next;
      }
      let result = dlEditor
        ? applyDlTaskFieldChange(row, key, value)
        : applyPdeTaskFieldChange(row, key, value, { getRapForTaskName, nrms });
      if (key !== 'progress_updated') {
        result = { ...result, progress_updated: toStorageDate(new Date()) };
      }
      return result;
    });

    partTasksRef.current = nextRows;
    setPartTasks(nextRows);

    // Typing stays local until the cell commits (blur/Enter). ProjectTaskGrid
    // only calls onChange on commit when instantCommit is off, so this path is
    // already "leave field". Push histogram for schedule/hour keys; other
    // fields wait for Save (flushDraft).
    const pushToHistogram = HISTOGRAM_COMMIT_KEYS.has(key)
      || (dlEditor && String(key).startsWith('dl_sec_hrs_'));

    targetIds.forEach((id) => {
      const updated = nextRows.find((row) => String(row.id) === id);
      const previous = previousRowsById.get(id);
      if (!updated || !previous) {
        return;
      }
      if (String(id) === String(taskId)) {
        setTask(updated);
      }
      scheduleDraftChange(updated, previous, {
        immediate: pushToHistogram,
        pushToHistogram,
      });
    });
  }, [dlEditor, employees, nrms, scheduleDraftChange, taskId, user]);

  const taskNameOptions = useMemo(() => buildTaskNameOptions(nrms), [nrms]);

  const editorTeamId = useMemo(
    () => resolveTeamIdForAssignee(allocationEmployees, bar?.employee),
    [allocationEmployees, bar?.employee],
  );

  const teamOapNrmNumbers = useMemo(
    () => collectTeamOapNrmNumbers(allocationEmployees, editorTeamId),
    [allocationEmployees, editorTeamId],
  );

  const gridTasks = useMemo(() => {
    const visible = filterTasksForTeamOapSections(partTasks, teamOapNrmNumbers, taskId);
    if (visible.length > 0) {
      return visible.map((row) => (
        task && String(row.id) === String(task.id) ? task : row
      ));
    }
    return task ? [task] : [];
  }, [partTasks, task, taskId, teamOapNrmNumbers]);

  gridTasksRef.current = gridTasks;

  const handleToggleAllDone = useCallback((checked) => {
    if (readOnly) {
      return;
    }
    const visibleIds = new Set(gridTasks.map((row) => String(row.id)));
    setPartTasks((current) => {
      const nextRows = current.map((row) => {
        if (!visibleIds.has(String(row.id))) {
          return row;
        }
        return dlEditor
          ? stampDlDoneMirrors(applyDoneCheckboxChange(row, checked, { user, employees }))
          : applyDoneCheckboxChange(row, checked, { user, employees });
      });
      partTasksRef.current = nextRows;
      const focused = nextRows.find((row) => String(row.id) === String(taskId));
      if (focused) {
        const previousTask = taskRef.current ? { ...taskRef.current } : null;
        setTask(focused);
        if (previousTask) {
          scheduleDraftChange(focused, previousTask);
        }
      }
      return nextRows;
    });
    markPdeDirty();
  }, [dlEditor, employees, gridTasks, readOnly, scheduleDraftChange, markPdeDirty, taskId, user]);

  const doneSelectionState = useMemo(() => {
    if (gridTasks.length === 0) {
      return { allDoneChecked: false, someDoneChecked: false };
    }
    const doneCount = gridTasks.filter((row) => row.done).length;
    return {
      allDoneChecked: doneCount === gridTasks.length,
      someDoneChecked: doneCount > 0 && doneCount < gridTasks.length,
    };
  }, [gridTasks]);

  const lastSyncedGridSelectionRef = useRef({ taskId: null, index: -1 });

  const handleSelectedRowsChange = useCallback((updater) => {
    setSelectedRows((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      const ids = next
        .map((index) => gridTasksRef.current[index]?.id ?? gridTasks[index]?.id)
        .filter((id) => id != null)
        .map(String);
      onSelectionChange?.(ids);
      return next;
    });
  }, [gridTasks, onSelectionChange]);

  useEffect(() => {
    const index = gridTasks.findIndex((row) => String(row.id) === String(taskId));
    if (index < 0) {
      return;
    }

    const syncedTaskId = String(taskId);
    const indexMoved = lastSyncedGridSelectionRef.current.taskId !== syncedTaskId
      || lastSyncedGridSelectionRef.current.index !== index;

    setSelectedRows((current) => {
      if (current.length > 1 && current.includes(index)) {
        return current;
      }
      if (current.length === 1 && current[0] === index) {
        return current;
      }
      return [index];
    });

    if (indexMoved) {
      lastSyncedGridSelectionRef.current = { taskId: syncedTaskId, index };
      onSelectionChange?.([syncedTaskId]);
    }
  }, [gridTasks, onSelectionChange, taskId]);

  useEffect(() => {
    lastSyncedGridSelectionRef.current = { taskId: null, index: -1 };
  }, [taskId]);

  useEffect(() => () => {
    onSelectionChange?.([]);
  }, [onSelectionChange]);

  const saveStatusLabel = {
    idle: '',
    unsaved: 'Unsaved changes',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Save failed',
  }[autoSaveState] || '';

  const canSave = autoSaveState === 'unsaved' || autoSaveState === 'error';
  const isSaving = autoSaveState === 'saving';

  if (!bar) {
    return null;
  }

  return (
    <div
      className="histogram-crm-detail-overlay histogram-task-editor-overlay"
      role="presentation"
    >
      <aside
        ref={panelRef}
        className={`histogram-crm-detail-panel histogram-task-editor-panel${dlEditor ? ' dl-page' : ''}`}
        style={{
          left: position.x,
          top: position.y,
          width: size.width,
          height: size.height,
        }}
        aria-label="Task editor"
      >
        <div className="histogram-task-editor-top">
          <div
            className="histogram-task-editor-drag-handle"
            {...dragHandleProps}
            title="Drag to move panel"
          >
            <span className="histogram-task-editor-drag-grip" aria-hidden="true">⋮⋮</span>
            <h2 className="histogram-task-editor-panel-title">Task Editor</h2>
            <div className="histogram-crm-detail-subtitle histogram-task-editor-subtitle">
              <span
                className="histogram-crm-detail-color"
                style={{ backgroundColor: bar.color || '#3B82F6' }}
                aria-hidden
              />
              <span className="histogram-task-editor-subtitle-text">
                <strong>{task?.task_name || bar.task_name || 'Untitled task'}</strong>
                {' · '}
                {bar.project_name || 'Unknown project'}
                {bar.part_name ? ` · ${bar.part_name}` : ''}
                {bar.employee ? ` · ${bar.employee}` : ''}
                {' · '}
                {formatDisplayDate(task?.doc_supply) || '—'}
                {' → '}
                {formatDisplayDate(task?.completion) || '—'}
                {' · '}
                {formatHoursDisplay(headerHours, { suffix: ' h total' })}
              </span>
            </div>
          </div>
          <div className="histogram-task-editor-top-actions">
            {saveStatusLabel ? (
              <span
                className={`histogram-task-editor-save-status is-${autoSaveState}`}
                title={dlEditor
                  ? 'Task field changes save to DL Input Hours when you click Save.'
                  : 'Task field changes save to Project Data Entry when you click Save.'}
              >
                {saveStatusLabel}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSaveClick}
              disabled={isSaving || !canSave}
              title={dlEditor ? 'Save task fields to DL Input Hours' : 'Save task fields to Project Data Entry'}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
            {bar.project_id && onFilterProject ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onFilterProject(String(bar.project_id))}
              >
                Filter project
              </button>
            ) : null}
            <button
              type="button"
              className="histogram-crm-detail-close"
              onClick={(event) => {
                event.stopPropagation();
                handleRequestClose();
              }}
              aria-label="Close task editor"
            >
              ×
            </button>
          </div>
        </div>

        {error ? (
          <div className="alert alert-error histogram-task-editor-error" role="alert">
            {error}
          </div>
        ) : null}

        {loading ? (
          <p className="histogram-task-editor-loading muted">Loading task data…</p>
        ) : gridTasks.length > 0 ? (
          <div className="histogram-task-editor-grid-wrap">
            <ProjectTaskGrid
              tasks={gridTasks}
              employees={employees}
              onChange={handleChange}
              selectedRows={selectedRows}
              onSelectedRowsChange={handleSelectedRowsChange}
              sections={dlEditor ? dlTaskSections : taskSections}
              pageClassName={dlEditor ? 'pde-page dl-page' : 'pde-page'}
              inactiveRowPredicate={taskHasPlanHours}
              lockedFieldPredicate={(task, fieldKey) => (
                readOnly || (!dlEditor && isDlMirrorLocked(task, fieldKey))
              )}
              applyDlPlanReduction={dlEditor}
              preferDlOwner={dlEditor}
              suppressAlgorithmDuplicateOverrides
              suppressBulkHint
              taskNameOptions={taskNameOptions}
              onToggleAllDone={handleToggleAllDone}
              allDoneChecked={doneSelectionState.allDoneChecked}
              someDoneChecked={doneSelectionState.someDoneChecked}
              taskNameDoubleClickToEdit
              scrollClassName="pde-table-shell project-task-scroll histogram-task-editor-scroll"
              tableClassName="project-task-table histogram-task-editor-table"
            />
          </div>
        ) : null}

        <p className="trainings-gap-detail-close-hint">
          The histogram updates when you leave a schedule/hours field or click <strong>Save</strong>.
          Close with <strong>×</strong> / <strong>Esc</strong> discards unsaved
          {dlEditor ? ' DL' : ' PDE'} field changes.
          Toolbar <strong>Save</strong> / <strong>Undo</strong> still handle bar schedules.
        </p>

        {RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            className={`histogram-task-editor-resize-handle is-${edge}`}
            title="Drag to resize"
            aria-hidden="true"
            {...getResizeHandleProps(edge)}
          />
        ))}
      </aside>
      {taskSyncConflictModal}
    </div>
  );
});

export default memo(HistogramTaskEditorPanel);
