import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDisplayDate, toStorageDate } from '../../utils/dateFormat';
import { formatHoursDisplay } from '../../utils/formatHoursDisplay';
import { formatPriorityValue } from '../../utils/priorityFormat';
import { closestGapWindowInRange } from '../../utils/trainingGapNotifications';
import {
  TRAINING_PRIORITY_OPTIONS,
  TRAINING_PROGRESS_OPTIONS,
  TRAINING_STATUS_OPTIONS,
  formatTrainingTotalHours,
  openTrainingCourseLink,
  trainingDaySegmentLabel,
  trainingPriorityLabel,
  trainingStatusLabel,
} from '../../utils/trainingForm';
import { recalculateProgressLeft, parseTaskProgressPercent } from '../../utils/taskCalculations';
import { syncTaskDoneAndProgress } from '../../utils/pdeDoneEffects';
import { sumEmployeeGapHoursInRange } from './ganttUtils';
import './histogram-detail-panel.css';

const AUTOSAVE_MS = 1200;

function taskPlanHours(task) {
  const plan = Number(task?.plan ?? task?.progress_plan);
  if (Number.isFinite(plan) && plan > 0) {
    return plan;
  }
  return assignedHoursForBar(task);
}

function taskProgressLeftHours(task) {
  const plan = taskPlanHours(task);
  const derived = recalculateProgressLeft({
    plan,
    progress_per: parseTaskProgressPercent(task),
    progress_left_hours: task?.progress_left_hours,
  });
  const left = Number(derived.progress_left_hours);
  if (Number.isFinite(left)) {
    return left;
  }
  return Math.max(0, Math.round(plan * (1 - parseTaskProgressPercent(task) / 100)));
}

function InfoBox({ title, children, collapsible = false, minimized = false, onToggleMinimize }) {
  const headingId = collapsible
    ? `histogram-info-${String(title).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
    : undefined;

  return (
    <section className={`histogram-crm-info-box${minimized ? ' is-minimized' : ''}`}>
      {collapsible ? (
        <button
          type="button"
          id={headingId}
          className="histogram-crm-info-box-toggle"
          onClick={onToggleMinimize}
          aria-expanded={!minimized}
        >
          <span className="histogram-crm-info-box-toggle-label">{title}</span>
          <span className="histogram-crm-info-box-toggle-icon" aria-hidden="true">
            {minimized ? '▸' : '▾'}
          </span>
        </button>
      ) : (
        <h4>{title}</h4>
      )}
      {!minimized ? children : null}
    </section>
  );
}

function displayValue(value) {
  const text = String(value ?? '').trim();
  return text || '—';
}

function formatHours(value) {
  return formatHoursDisplay(value, { suffix: ' h' });
}

function parseTaskPri(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function comparePriAsc(left, right) {
  const a = parseTaskPri(left);
  const b = parseTaskPri(right);
  if (a == null && b == null) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  return a - b;
}

const TRAINING_PRIORITY_RANK = Object.fromEntries(
  TRAINING_PRIORITY_OPTIONS.map((option, index) => [option.value, index]),
);

function compareTrainingPriorityAsc(left, right) {
  const a = TRAINING_PRIORITY_RANK[left] ?? Number.POSITIVE_INFINITY;
  const b = TRAINING_PRIORITY_RANK[right] ?? Number.POSITIVE_INFINITY;
  return a - b;
}

/** Hours assigned to this employee on this bar (not full task plan). */
function assignedHoursForBar(bar) {
  if (Number.isFinite(Number(bar?.hours)) && Number(bar.hours) > 0) {
    return Number(bar.hours);
  }
  if (!bar?.hours_by_day || typeof bar.hours_by_day !== 'object') {
    return 0;
  }
  return Object.values(bar.hours_by_day)
    .reduce((sum, hours) => sum + (Number(hours) || 0), 0);
}

/** Date span of this employee's assignment on the bar. */
function assignedRangeForBar(bar) {
  const days = Object.entries(bar?.hours_by_day || {})
    .filter(([, hours]) => (Number(hours) || 0) > 0.001)
    .map(([day]) => day)
    .sort();
  return {
    start: days[0] || bar?.start || '',
    end: days.at(-1) || bar?.end || '',
  };
}

function groupBarsByProject(bars = []) {
  const map = new Map();

  bars.forEach((bar) => {
    const projectKey = String(bar.project_id ?? bar.project_name ?? 'unknown');
    if (!map.has(projectKey)) {
      map.set(projectKey, {
        key: projectKey,
        projectId: bar.project_id ?? null,
        projectName: bar.project_name || 'Unknown project',
        color: bar.color || '#3B82F6',
        tasks: [],
      });
    }
    map.get(projectKey).tasks.push(bar);
  });

  return [...map.values()]
    .map((project) => {
      const tasks = [...project.tasks].sort((left, right) => (
        comparePriAsc(left.pri, right.pri)
        || String(left.task_name || '').localeCompare(String(right.task_name || ''))
        || String(assignedRangeForBar(left).start || '')
          .localeCompare(String(assignedRangeForBar(right).start || ''))
      ));
      const bestPri = tasks.reduce((best, task) => {
        const pri = parseTaskPri(task.pri);
        if (pri == null) {
          return best;
        }
        return best == null || pri < best ? pri : best;
      }, null);
      const bestPp = tasks.reduce((best, task) => {
        const pp = parseTaskPri(task.pp);
        if (pp == null) {
          return best;
        }
        return best == null || pp < best ? pp : best;
      }, null);
      return { ...project, tasks, bestPri, bestPp };
    })
    .sort((left, right) => (
      comparePriAsc(left.bestPp, right.bestPp)
      || comparePriAsc(left.bestPri, right.bestPri)
      || left.projectName.localeCompare(right.projectName)
    ));
}

function sortTrainingsByPriority(trainings = []) {
  return [...trainings].sort((left, right) => (
    compareTrainingPriorityAsc(left.priority, right.priority)
    || String(left.start_date || '').localeCompare(String(right.start_date || ''))
    || String(left.title || '').localeCompare(String(right.title || ''))
  ));
}

function TaskCard({
  task,
  saving = false,
  onSelectTask,
  onQueueProgress,
  onFlushProgress,
}) {
  const assignedRange = assignedRangeForBar(task);
  const assignedHours = assignedHoursForBar(task);
  const planHours = taskPlanHours(task);
  const progressPercent = parseTaskProgressPercent(task);
  const leftHours = taskProgressLeftHours(task);
  const priLabel = formatPriorityValue(task.pri);
  const isComplete = Boolean(task.done) || progressPercent >= 100;
  const taskRef = useRef(task);
  const [draftPercent, setDraftPercent] = useState(() => String(progressPercent));

  taskRef.current = task;

  useEffect(() => {
    setDraftPercent(String(progressPercent));
  }, [task.task_id, task.id, progressPercent, task.done]);

  const buildPatch = useCallback((nextPercent, nextDone = null) => {
    const clamped = Math.min(100, Math.max(0, Math.round(Number(nextPercent) || 0)));
    const synced = syncTaskDoneAndProgress({
      plan: planHours,
      progress_per: String(clamped),
      done: Boolean(taskRef.current?.done),
    }, nextDone == null ? {} : { preferDone: Boolean(nextDone) });
    const derived = recalculateProgressLeft({
      plan: planHours,
      progress_per: synced.progress_per,
    });

    return {
      progress_per: String(synced.progress_per),
      progress_left_hours: derived.progress_left_hours,
      done: Boolean(synced.done),
    };
  }, [planHours]);

  const flushProgress = useCallback((nextPercent, nextDone) => {
    if (!onFlushProgress) {
      return;
    }

    const patch = buildPatch(nextPercent, nextDone);
    setDraftPercent(String(patch.progress_per));
    onFlushProgress(taskRef.current, patch);
  }, [buildPatch, onFlushProgress]);

  const queueProgress = useCallback((nextPercent, nextDone) => {
    if (!onQueueProgress) {
      return;
    }

    onQueueProgress(taskRef.current, buildPatch(nextPercent, nextDone));
  }, [buildPatch, onQueueProgress]);

  const handlePercentChange = useCallback((event) => {
    const raw = event.target.value;
    setDraftPercent(raw);
    queueProgress(raw);
  }, [queueProgress]);

  const handlePercentBlur = useCallback(() => {
    flushProgress(draftPercent);
  }, [draftPercent, flushProgress]);

  return (
    <li className={`histogram-employee-detail-task-card${isComplete ? ' is-complete' : ''}`}>
      <button
        type="button"
        className="histogram-employee-detail-task"
        onClick={() => onSelectTask?.(task)}
        disabled={!onSelectTask}
        title={onSelectTask ? 'Open task editor' : undefined}
      >
        <span className="histogram-employee-detail-task-name">
          {displayValue(task.task_name)}
          {priLabel ? (
            <span className="histogram-employee-detail-pri is-inline">
              Pri {priLabel}
            </span>
          ) : null}
        </span>
        <span className="histogram-employee-detail-task-meta">
          {task.part_name ? `${task.part_name} · ` : ''}
          {formatDisplayDate(assignedRange.start) || assignedRange.start || '—'}
          {' → '}
          {formatDisplayDate(assignedRange.end) || assignedRange.end || '—'}
          {' · '}
          {formatHours(assignedHours)}
          {isComplete ? ' · Done' : ` · ${progressPercent}%`}
        </span>
      </button>

      <div
        className="histogram-employee-detail-task-progress"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <label className="histogram-employee-detail-task-field">
          <span>%</span>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={draftPercent}
            disabled={!onFlushProgress}
            title="Progress percentage complete"
            onChange={handlePercentChange}
            onBlur={handlePercentBlur}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
          />
        </label>

        <label className="histogram-employee-detail-task-field">
          <span>Hrs</span>
          <input
            type="text"
            value={planHours > 0 ? String(Math.round(planHours * 100) / 100) : '—'}
            readOnly
            tabIndex={-1}
            title="Planned / assigned hours for this task"
          />
        </label>

        <label className="histogram-employee-detail-task-field">
          <span>Left</span>
          <input
            type="text"
            value={planHours > 0 || progressPercent > 0
              ? String(leftHours)
              : '—'}
            readOnly
            tabIndex={-1}
            title="Hours remaining at the current progress %"
          />
        </label>

        <label className="histogram-employee-detail-task-done">
          <input
            type="checkbox"
            checked={isComplete}
            disabled={saving || !onFlushProgress}
            title="Mark task as done"
            onChange={(event) => {
              if (event.target.checked) {
                flushProgress(100, true);
              } else {
                flushProgress(progressPercent >= 100 ? 0 : progressPercent, false);
              }
            }}
          />
          <span>Done</span>
        </label>
      </div>
    </li>
  );
}

function TrainingCard({
  training,
  saving = false,
  onUpdateStatus,
  onOpenTraining,
  openTrainingTitle,
  onRemoveTraining,
  removing = false,
  removeBusy = false,
}) {
  const isComplete = training.status === 'completed';
  const statusValue = TRAINING_STATUS_OPTIONS.some((option) => option.value === training.status)
    ? training.status
    : 'not_started';
  const description = String(training.description || '').trim();
  const totalHoursLabel = formatTrainingTotalHours(training);

  return (
    <li className={`histogram-employee-detail-training${isComplete ? ' is-complete' : ''}`}>
      <button
        type="button"
        className="histogram-employee-detail-training-open"
        onClick={() => onOpenTraining?.(training)}
        disabled={!onOpenTraining}
        title={onOpenTraining ? openTrainingTitle : undefined}
      >
        <div className="histogram-employee-detail-training-head">
          <span className="histogram-employee-detail-training-swatch" aria-hidden />
          <strong>{displayValue(training.title)}</strong>
          {training.priority ? (
            <span className="histogram-employee-detail-pri">
              {trainingPriorityLabel(training.priority)}
            </span>
          ) : null}
        </div>

        {description ? (
          <p className="histogram-employee-detail-training-description">{description}</p>
        ) : null}

        <p className="histogram-employee-detail-training-meta">
          {formatDisplayDate(training.start_date) || training.start_date || '—'}
          {' → '}
          {formatDisplayDate(training.end_date) || training.end_date || '—'}
          {totalHoursLabel ? ` · ${totalHoursLabel}` : ''}
          {' · '}
          {trainingDaySegmentLabel(training.day_segment)}
          {' · '}
          {trainingStatusLabel(statusValue) || statusValue}
        </p>
      </button>

      <div
        className="histogram-employee-detail-training-controls"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <label className="histogram-employee-detail-training-progress">
          <span>Progress</span>
          <select
            value={statusValue}
            disabled={saving || !onUpdateStatus}
            onChange={(event) => onUpdateStatus?.(training, event.target.value)}
          >
            {TRAINING_PROGRESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {!isComplete ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={saving || !onUpdateStatus}
            onClick={() => onUpdateStatus?.(training, 'completed')}
          >
            Mark complete
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={saving || !onUpdateStatus}
            onClick={() => onUpdateStatus?.(training, 'in_progress')}
          >
            Reopen
          </button>
        )}

        {training.course_link ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => openTrainingCourseLink(training.course_link)}
          >
            Open course
          </button>
        ) : null}

        {onRemoveTraining ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => onRemoveTraining(training)}
            disabled={removeBusy || saving}
          >
            {removing ? 'Removing...' : 'Remove'}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default memo(function HistogramEmployeeDetailPanel({
  row,
  range,
  dailyHours = {},
  gapDailyHours = null,
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
  rowTrainings = [],
  onClose,
  onFilterProject,
  onSelectTask,
  onTrainingStatusChange,
  onRemoveTraining,
  removingTrainingId = null,
  onTaskProgressChange,
  onOpenTraining,
  openTrainingTitle = 'Open this training',
}) {
  const bookedHours = gapDailyHours ?? dailyHours;
  const [trainingsMinimized, setTrainingsMinimized] = useState(false);
  const [projectsMinimized, setProjectsMinimized] = useState(false);
  const [savingTrainingIds, setSavingTrainingIds] = useState(() => new Set());
  const [savingTaskIds, setSavingTaskIds] = useState(() => new Set());
  const [autoSaveState, setAutoSaveState] = useState('idle');
  const autoSaveClearRef = useRef(null);
  const taskSaveTimersRef = useRef(new Map());
  const pendingTaskPatchesRef = useRef(new Map());

  const projects = useMemo(() => groupBarsByProject(row?.bars), [row?.bars]);
  const sortedTrainings = useMemo(
    () => sortTrainingsByPriority(rowTrainings),
    [rowTrainings],
  );

  const closestGap = useMemo(() => {
    if (!row?.name || !range?.start || !range?.end) {
      return null;
    }
    return closestGapWindowInRange({
      rowName: row.name,
      startYmd: range.start,
      endYmd: range.end,
      dailyHours: bookedHours,
      availabilityHours,
      employeeHolidays,
      employees,
      fromYmd: toStorageDate(new Date()),
      trainings: rowTrainings,
    });
  }, [
    row?.name,
    range?.start,
    range?.end,
    bookedHours,
    availabilityHours,
    employeeHolidays,
    employees,
    rowTrainings,
  ]);

  const totalGapHours = useMemo(() => {
    if (!row?.name || !range?.start || !range?.end) {
      return 0;
    }
    return sumEmployeeGapHoursInRange({
      rowName: row.name,
      startYmd: range.start,
      endYmd: range.end,
      dailyHours: bookedHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
  }, [
    row?.name,
    range?.start,
    range?.end,
    bookedHours,
    availabilityHours,
    employeeHolidays,
    employees,
  ]);

  useEffect(() => () => {
    if (autoSaveClearRef.current) {
      window.clearTimeout(autoSaveClearRef.current);
    }
    const timers = taskSaveTimersRef.current;
    timers.forEach((timerId) => window.clearTimeout(timerId));
    timers.clear();
    const pending = [...pendingTaskPatchesRef.current.values()];
    pendingTaskPatchesRef.current.clear();
    pending.forEach(({ task, patch }) => {
      onTaskProgressChange?.(task, patch);
    });
  }, [onTaskProgressChange]);

  const markAutoSaving = useCallback(() => {
    if (autoSaveClearRef.current) {
      window.clearTimeout(autoSaveClearRef.current);
      autoSaveClearRef.current = null;
    }
    setAutoSaveState('saving');
  }, []);

  const markAutoSavePending = useCallback(() => {
    if (autoSaveClearRef.current) {
      window.clearTimeout(autoSaveClearRef.current);
      autoSaveClearRef.current = null;
    }
    setAutoSaveState((current) => (current === 'saving' ? current : 'pending'));
  }, []);

  const markAutoSaved = useCallback((ok = true) => {
    setAutoSaveState(ok ? 'saved' : 'error');
    if (ok) {
      autoSaveClearRef.current = window.setTimeout(() => {
        setAutoSaveState('idle');
        autoSaveClearRef.current = null;
      }, 2000);
    }
  }, []);

  const handleUpdateStatus = useCallback(async (training, nextStatus) => {
    if (!training?.id || !onTrainingStatusChange || training.status === nextStatus) {
      return;
    }
    const id = String(training.id);
    markAutoSaving();
    setSavingTrainingIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    try {
      await onTrainingStatusChange(training, nextStatus);
      markAutoSaved(true);
    } catch {
      markAutoSaved(false);
    } finally {
      setSavingTrainingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [markAutoSaved, markAutoSaving, onTrainingStatusChange]);

  const handleUpdateTaskProgress = useCallback(async (task, patch) => {
    if (!task || !onTaskProgressChange) {
      return;
    }
    const id = String(task.task_id ?? task.id ?? '');
    if (!id) {
      return;
    }
    markAutoSaving();
    setSavingTaskIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    try {
      await onTaskProgressChange(task, patch);
      markAutoSaved(true);
    } catch {
      markAutoSaved(false);
    } finally {
      setSavingTaskIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, [markAutoSaved, markAutoSaving, onTaskProgressChange]);

  const queueTaskProgressSave = useCallback((task, patch) => {
    if (!task || !onTaskProgressChange) {
      return;
    }
    const id = String(task.task_id ?? task.id ?? '');
    if (!id) {
      return;
    }

    pendingTaskPatchesRef.current.set(id, { task, patch });
    markAutoSavePending();

    const timers = taskSaveTimersRef.current;
    if (timers.has(id)) {
      window.clearTimeout(timers.get(id));
    }

    timers.set(id, window.setTimeout(() => {
      timers.delete(id);
      const pending = pendingTaskPatchesRef.current.get(id);
      pendingTaskPatchesRef.current.delete(id);
      if (pending) {
        handleUpdateTaskProgress(pending.task, pending.patch);
      }
    }, AUTOSAVE_MS));
  }, [handleUpdateTaskProgress, markAutoSavePending, onTaskProgressChange]);

  const flushTaskProgressSave = useCallback((task, patch) => {
    if (!task || !onTaskProgressChange) {
      return;
    }
    const id = String(task.task_id ?? task.id ?? '');
    if (!id) {
      return;
    }

    const timers = taskSaveTimersRef.current;
    if (timers.has(id)) {
      window.clearTimeout(timers.get(id));
      timers.delete(id);
    }
    pendingTaskPatchesRef.current.delete(id);

    handleUpdateTaskProgress(task, patch);
  }, [handleUpdateTaskProgress, onTaskProgressChange]);

  const flushAllPendingTaskProgressSaves = useCallback(() => {
    const timers = taskSaveTimersRef.current;
    timers.forEach((timerId) => window.clearTimeout(timerId));
    timers.clear();

    const pending = [...pendingTaskPatchesRef.current.values()];
    pendingTaskPatchesRef.current.clear();
    pending.forEach(({ task, patch }) => {
      handleUpdateTaskProgress(task, patch);
    });
  }, [handleUpdateTaskProgress]);

  const handleClosePanel = useCallback(() => {
    flushAllPendingTaskProgressSaves();
    onClose?.();
  }, [flushAllPendingTaskProgressSaves, onClose]);

  if (!row) {
    return null;
  }

  const taskCount = projects.reduce((sum, project) => sum + project.tasks.length, 0);

  return (
    <div
      className="histogram-crm-detail-overlay"
      onDoubleClick={handleClosePanel}
      role="presentation"
    >
      <aside
        className="histogram-crm-detail-panel histogram-employee-detail-panel"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-label={`${row.name} assignments`}
      >
        <div className="histogram-crm-detail-top">
          <div className="histogram-employee-detail-heading-block inline-heading">
            <p className="histogram-panel-eyebrow histogram-panel-title inline-heading__title">
              Personal summary
            </p>
            <div className="histogram-employee-detail-heading-meta inline-heading__meta">
              <h2 className="histogram-employee-name">{row.name}</h2>
              {autoSaveState !== 'idle' ? (
                <span
                  className={`histogram-employee-detail-autosave is-${autoSaveState}`}
                  title="Task and training progress auto-saves when you change it"
                >
                  {{
                    pending: 'Auto-save pending…',
                    saving: 'Saving…',
                    saved: 'Saved',
                    error: 'Save failed',
                  }[autoSaveState]}
                </span>
              ) : (
                <span
                  className="histogram-employee-detail-autosave is-idle"
                  title="Task and training progress auto-saves when you change it"
                >
                  Auto-save on
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="histogram-crm-detail-close"
            onClick={handleClosePanel}
            aria-label="Close details panel"
          >
            ×
          </button>
        </div>

        <div className="histogram-crm-detail-subtitle">
          {row.team || row.teamName || 'No team'}
          {' · '}
          {projects.length} project{projects.length === 1 ? '' : 's'}
          {' · '}
          {taskCount} task{taskCount === 1 ? '' : 's'}
          {' · '}
          {rowTrainings.length} training{rowTrainings.length === 1 ? '' : 's'}
        </div>

        <div className="histogram-crm-detail-stages">
          <span className="histogram-crm-stage-pill histogram-crm-stage-pill-active">
            Operative
          </span>
          {totalGapHours > 0.05 ? (
            <span className="histogram-crm-stage-pill">
              {formatHours(totalGapHours)} gap in view
            </span>
          ) : (
            <span className="histogram-crm-stage-pill">No gap in view</span>
          )}
        </div>

        <InfoBox title="Closest gap available for training">
          {closestGap ? (
            <div className="histogram-crm-detail-grid">
              <div>
                <strong>From</strong>
                <span>{formatDisplayDate(closestGap.start_date) || closestGap.start_date}</span>
              </div>
              <div>
                <strong>To</strong>
                <span>{formatDisplayDate(closestGap.end_date) || closestGap.end_date}</span>
              </div>
              <div>
                <strong>Available hours</strong>
                <span>{formatHours(closestGap.gapHours)}</span>
              </div>
            </div>
          ) : (
            <p className="histogram-employee-detail-empty">
              No availability gap found in the current histogram range.
            </p>
          )}
        </InfoBox>

        <InfoBox
          title={`Trainings (${rowTrainings.length})`}
          collapsible
          minimized={trainingsMinimized}
          onToggleMinimize={() => setTrainingsMinimized((current) => !current)}
        >
          {sortedTrainings.length === 0 ? (
            <p className="histogram-employee-detail-empty">
              No trainings scheduled for this operative in the current range.
            </p>
          ) : (
            <ul className="histogram-employee-detail-trainings">
              {sortedTrainings.map((training) => (
                <TrainingCard
                  key={training.id}
                  training={training}
                  saving={savingTrainingIds.has(String(training.id))}
                  onUpdateStatus={onTrainingStatusChange ? handleUpdateStatus : null}
                  onOpenTraining={onOpenTraining}
                  openTrainingTitle={openTrainingTitle}
                  onRemoveTraining={onRemoveTraining}
                  removing={String(removingTrainingId) === String(training.id)}
                  removeBusy={removingTrainingId != null}
                />
              ))}
            </ul>
          )}
        </InfoBox>

        <InfoBox
          title={`Projects & tasks (${taskCount})`}
          collapsible
          minimized={projectsMinimized}
          onToggleMinimize={() => setProjectsMinimized((current) => !current)}
        >
          {projects.length === 0 ? (
            <p className="histogram-employee-detail-empty">
              No scheduled projects or tasks in this range.
            </p>
          ) : (
            <ul className="histogram-employee-detail-projects">
              {projects.map((project) => (
                <li key={project.key} className="histogram-employee-detail-project">
                  <div className="histogram-employee-detail-project-head">
                    <span
                      className="histogram-crm-detail-color"
                      style={{ backgroundColor: project.color }}
                      aria-hidden
                    />
                    <strong>{project.projectName}</strong>
                    {project.bestPp != null ? (
                      <span className="histogram-employee-detail-pri" title="Project PP">
                        PP {formatPriorityValue(project.bestPp) || project.bestPp}
                      </span>
                    ) : null}
                    {project.projectId && onFilterProject ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => onFilterProject(String(project.projectId))}
                      >
                        Filter
                      </button>
                    ) : null}
                  </div>
                  <ul className="histogram-employee-detail-tasks">
                    {project.tasks.map((task) => {
                      const taskKey = String(task.task_id ?? task.id ?? `${task.task_name}-${task.start}`);
                      return (
                        <TaskCard
                          key={taskKey}
                          task={task}
                          saving={savingTaskIds.has(String(task.task_id ?? task.id ?? ''))}
                          onSelectTask={onSelectTask}
                          onQueueProgress={onTaskProgressChange ? queueTaskProgressSave : null}
                          onFlushProgress={onTaskProgressChange ? flushTaskProgressSave : null}
                        />
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </InfoBox>

        <p className="trainings-gap-detail-close-hint">
          Double-click outside the panel to close, or use × above.
        </p>
      </aside>
    </div>
  );
});
