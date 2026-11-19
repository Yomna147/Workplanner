import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { getApiErrorMessage } from '../../utils/apiErrors';
import Modal from '../Modal';
import { describeBarChange } from './histogramBarEdits';
import { planLogTaskChanges, planLogTaskIds, uniquePlanLogUserNames } from '../../utils/planActivityLog';
import { trainingActivityChangeEntries, trainingActivityDisplaySummary, trainingOverrideReplacedLabels, resolveTrainingLogNavigationTarget, resolveTrainingLogDisplayAction } from '../../utils/trainingActivityLog';

import DlQuickUpdateList from '../DlQuickUpdateList';

const TAB_PROJECTS = 'projects';
const TAB_PLAN = 'plan';
const TAB_QUICK = 'quick';
const TAB_TRAININGS = 'trainings';

function formatLogTime(timestamp) {
  if (!timestamp) {
    return '';
  }
  try {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleString([], {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatActionLabel(action) {
  if (!action) {
    return 'Edit';
  }

  return String(action)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function actionToneClass(action) {
  const normalized = String(action || '').toLowerCase();
  if (normalized === 'overridden' || normalized === 'overwrote') {
    return ' is-overridden';
  }
  if (normalized === 'rescheduled') {
    return ' is-rescheduled';
  }
  if (normalized === 'deleted') {
    return ' is-deleted';
  }
  return '';
}

function describeHistoryEntry(entry) {
  if (!entry) {
    return 'Edit';
  }
  if (entry.kind === 'training_project_override' || entry.action === 'training_project_override') {
    return entry.summary || 'Training overrode project hours';
  }
  if (entry.type === 'task') {
    const name = entry.nextTask?.task_name
      || entry.previousTask?.task_name
      || `Task ${entry.taskId || ''}`.trim();
    return `Task editor: ${name}`;
  }
  if (entry.summary) {
    return entry.summary;
  }
  if (entry.source === 'saved' && Array.isArray(entry.editSummaries) && entry.editSummaries.length) {
    return entry.editSummaries[0];
  }
  return describeBarChange(entry.previousBar, entry.nextBar) || 'Bar schedule edit';
}

export default function HistogramEditLogModal({
  open,
  onClose,
  entries = [],
  onUndoEntry,
  onUndoAllSession = null,
  busy = false,
  loading = false,
  sessionUndoCount = 0,
  planLogs = [],
  planLogsLoading = false,
  planUserFilter = '',
  onPlanUserFilterChange,
  focusedPlanLogId = null,
  onShowPlanLog,
  onTrainingLogClick = null,
  initialTab = null,
}) {
  const [pendingId, setPendingId] = useState(null);
  const [undoingAll, setUndoingAll] = useState(false);
  const [logTab, setLogTab] = useState(TAB_PROJECTS);
  const [trainingLogs, setTrainingLogs] = useState([]);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [trainingError, setTrainingError] = useState('');

  const [expandedPlanLogId, setExpandedPlanLogId] = useState(null);

  useEffect(() => {
    if (!open) {
      setPendingId(null);
      setUndoingAll(false);
      setLogTab(TAB_PROJECTS);
      setExpandedPlanLogId(null);
      return;
    }

    if (initialTab === TAB_QUICK || initialTab === TAB_PLAN || initialTab === TAB_TRAININGS || initialTab === TAB_PROJECTS) {
      setLogTab(initialTab);
    }

    if (focusedPlanLogId && initialTab !== TAB_QUICK) {
      setLogTab(TAB_PLAN);
      setExpandedPlanLogId(focusedPlanLogId);
    }
  }, [open, focusedPlanLogId, initialTab]);

  useEffect(() => {
    if (!open || logTab !== TAB_TRAININGS) {
      return undefined;
    }

    let cancelled = false;

    const loadTrainingLogs = async () => {
      setTrainingLoading(true);
      setTrainingError('');
      try {
        const response = await api.get('/resource-histogram/activity-logs', {
          params: { section: 'trainings', limit: 100 },
        });
        if (!cancelled) {
          setTrainingLogs(Array.isArray(response.data?.data) ? response.data.data : []);
        }
      } catch (err) {
        if (!cancelled) {
          setTrainingError(getApiErrorMessage(err, 'Unable to load training log.'));
          setTrainingLogs([]);
        }
      } finally {
        if (!cancelled) {
          setTrainingLoading(false);
        }
      }
    };

    loadTrainingLogs();

    return () => {
      cancelled = true;
    };
  }, [open, logTab]);

  const rows = useMemo(() => {
    return [...(entries || [])].sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      if (bTime !== aTime) {
        return bTime - aTime;
      }
      return String(b.id).localeCompare(String(a.id));
    });
  }, [entries]);

  const latestActiveId = useMemo(() => {
    for (const entry of rows) {
      if (!entry?.undone) {
        return entry.id;
      }
    }
    return null;
  }, [rows]);

  const activeCount = useMemo(
    () => (entries || []).filter((entry) => !entry.undone).length,
    [entries],
  );

  const handleUndo = async (entry) => {
    if (!entry || entry.undone || busy || pendingId || undoingAll) {
      return;
    }
    setPendingId(entry.id);
    try {
      await onUndoEntry?.(entry);
    } finally {
      setPendingId(null);
    }
  };

  const handleUndoAll = async () => {
    if (!onUndoAllSession || busy || pendingId || undoingAll || sessionUndoCount <= 0) {
      return;
    }
    setUndoingAll(true);
    try {
      await onUndoAllSession();
    } finally {
      setUndoingAll(false);
    }
  };

  const showProjects = logTab === TAB_PROJECTS;
  const showPlan = logTab === TAB_PLAN;
  const showQuick = logTab === TAB_QUICK;
  const showTrainings = logTab === TAB_TRAININGS;
  const planUserNames = useMemo(() => uniquePlanLogUserNames(planLogs), [planLogs]);
  const visiblePlanLogs = useMemo(() => {
    if (!planUserFilter) {
      return planLogs;
    }
    return planLogs.filter((log) => String(log.user_name || '') === planUserFilter);
  }, [planLogs, planUserFilter]);

  return (
    <Modal
      open={open}
      title="Edits Log History"
      onClose={onClose}
      size={showQuick ? 'xwide' : 'compact'}
    >
      <div className={`histogram-edit-log-modal${showQuick ? ' histogram-edit-log-modal--quick' : ''}`}>
        <div
          className="trainings-view-toggle histogram-edit-log-tabs"
          role="tablist"
          aria-label="Edit log section"
          data-active-view={logTab}
        >
          <button
            type="button"
            role="tab"
            aria-selected={showProjects}
            className={`btn btn-secondary btn-sm trainings-view-tab${showProjects ? ' is-active' : ''}`}
            onClick={() => setLogTab(TAB_PROJECTS)}
          >
            Projects
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showPlan}
            className={`btn btn-secondary btn-sm trainings-view-tab${showPlan ? ' is-active' : ''}`}
            onClick={() => setLogTab(TAB_PLAN)}
          >
            Plan (DL)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showQuick}
            className={`btn btn-secondary btn-sm trainings-view-tab${showQuick ? ' is-active' : ''}`}
            onClick={() => setLogTab(TAB_QUICK)}
          >
            Quick Update
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showTrainings}
            className={`btn btn-secondary btn-sm trainings-view-tab${showTrainings ? ' is-active' : ''}`}
            onClick={() => setLogTab(TAB_TRAININGS)}
          >
            Trainings
          </button>
        </div>

        {showQuick ? null : (
          <p className="histogram-edit-log-intro">
            {showProjects ? (
              <>
                Saved and unsaved project schedule changes
                {activeCount > 0 ? ` (${activeCount} active)` : ''}, including training overrides that reduced project hours.
                Undo restores the schedule to before that change and discards later edits. Training overrides are read-only here.
              </>
            ) : showPlan ? (
              'DL plan edits from DL Project Data Update. Each entry shows who saved, when, and which task fields changed. Show on histogram highlights those task bars.'
            ) : (
              'Training create, update, override, and delete history. Overrides that replaced project hours are listed here and also under Projects. These entries are read-only here.'
            )}
          </p>
        )}

        {showPlan && planUserNames.length > 0 ? (
          <label className="histogram-edit-log-user-filter">
            DL
            <select
              value={planUserFilter}
              onChange={(event) => onPlanUserFilterChange?.(event.target.value)}
            >
              <option value="">All DLs</option>
              {planUserNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="histogram-edit-log-scroll">
          {showProjects ? (
            loading ? (
              <p className="muted histogram-edit-log-empty">Loading log…</p>
            ) : rows.length === 0 ? (
              <p className="muted histogram-edit-log-empty">No edits yet.</p>
            ) : (
              <ul className="histogram-edit-log-list">
                {rows.map((entry) => {
                  const isLatest = entry.id === latestActiveId;
                  const isTrainingOverride = entry.kind === 'training_project_override'
                    || entry.action === 'training_project_override';
                  const canUndo = !entry.undone
                    && entry.canUndo !== false
                    && !isTrainingOverride
                    && !busy
                    && !pendingId
                    && !undoingAll;
                  const isUndoing = pendingId === entry.id;
                  return (
                    <li
                      key={entry.id}
                      className={[
                        'histogram-edit-log-item',
                        entry.undone ? 'is-undone' : '',
                        isLatest ? 'is-latest' : '',
                        isTrainingOverride ? 'histogram-edit-log-item--training-override' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <div className="histogram-edit-log-item-main">
                        <div className="histogram-edit-log-item-title-row">
                          <strong className={isTrainingOverride ? 'histogram-edit-log-training-summary' : undefined}>
                            {describeHistoryEntry(entry)}
                          </strong>
                          <span
                            className={[
                              'histogram-edit-log-badge',
                              isTrainingOverride
                                ? 'is-overridden'
                                : entry.source === 'saved'
                                  ? 'is-saved'
                                  : 'is-unsaved',
                            ].join(' ')}
                          >
                            {isTrainingOverride
                              ? 'Training override'
                              : entry.source === 'saved'
                                ? 'Saved'
                                : 'Unsaved'}
                          </span>
                        </div>
                        <span className="histogram-edit-log-meta">
                          {entry.userName ? `${entry.userName} · ` : null}
                          {formatLogTime(entry.createdAt)}
                          {entry.undone ? ' · Undone' : null}
                          {!entry.undone && isLatest && !isTrainingOverride ? ' · Latest' : null}
                          {entry.source === 'saved' && entry.canUndo === false && !entry.undone && !isTrainingOverride
                            ? ' · Undo unavailable'
                            : null}
                          {isTrainingOverride ? ' · Read-only' : null}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm histogram-edit-log-undo"
                        disabled={!canUndo}
                        title={
                          isTrainingOverride
                            ? 'Training overrides cannot be undone from this log'
                            : entry.undone
                              ? 'Already undone'
                              : entry.canUndo === false
                                ? 'This older saved edit cannot be undone'
                                : 'Undo this change and discard later edits'
                        }
                        onClick={() => handleUndo(entry)}
                      >
                        {isUndoing ? 'Undoing…' : 'Undo'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : showPlan ? (
            planLogsLoading ? (
              <p className="muted histogram-edit-log-empty">Loading DL plan log…</p>
            ) : visiblePlanLogs.length === 0 ? (
              <p className="muted histogram-edit-log-empty">No DL plan changes recorded yet.</p>
            ) : (
              <ul className="histogram-edit-log-list">
                {visiblePlanLogs.map((log) => {
                  const taskChanges = planLogTaskChanges(log);
                  const taskIds = planLogTaskIds(log);
                  const isExpanded = String(expandedPlanLogId) === String(log.id);
                  const isFocused = String(focusedPlanLogId) === String(log.id);
                  return (
                    <li
                      key={log.id}
                      className={[
                        'histogram-edit-log-item',
                        'histogram-edit-log-item--plan',
                        isFocused ? 'is-latest' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <div className="histogram-edit-log-item-main">
                        <div className="histogram-edit-log-item-title-row">
                          <strong>{log.summary || formatActionLabel(log.action)}</strong>
                          <span className="histogram-edit-log-badge is-saved">
                            {isFocused ? 'Showing' : 'DL'}
                          </span>
                        </div>
                        <span className="histogram-edit-log-meta">
                          {log.user_name ? `${log.user_name} · ` : null}
                          {formatLogTime(log.created_at)}
                          {taskIds.length > 0 ? ` · ${taskIds.length} task${taskIds.length === 1 ? '' : 's'}` : null}
                        </span>
                        {isExpanded && taskChanges.length > 0 ? (
                          <ul className="histogram-edit-log-changes">
                            {taskChanges.map((task) => (
                              <li key={`${log.id}-${task.kind}-${task.id}`}>
                                <strong>{task.taskName}</strong>
                                {task.kind !== 'updated' ? ` · ${task.kind}` : null}
                                {task.fields.map((field) => (
                                  <div key={`${log.id}-${task.id}-${field.field}`}>
                                    {field.label}
                                    {': '}
                                    {field.from}
                                    {' → '}
                                    {field.to}
                                  </div>
                                ))}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <div className="histogram-edit-log-item-actions">
                        {taskChanges.length > 0 ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setExpandedPlanLogId(isExpanded ? null : log.id)}
                          >
                            {isExpanded ? 'Hide' : 'Details'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm histogram-edit-log-undo"
                          disabled={taskIds.length === 0}
                          title={taskIds.length === 0
                            ? 'No tasks to highlight'
                            : 'Highlight these tasks on the histogram'}
                          onClick={() => onShowPlanLog?.(log)}
                        >
                          Show
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )
          ) : showQuick ? (
            <DlQuickUpdateList compact className="dl-weekly-confirm-quick-update" />
          ) : trainingError ? (
            <div className="alert alert-error" role="alert">{trainingError}</div>
          ) : trainingLoading ? (
            <p className="muted histogram-edit-log-empty">Loading training log…</p>
          ) : trainingLogs.length === 0 ? (
            <p className="muted histogram-edit-log-empty">No training changes recorded yet.</p>
          ) : (
            <ul className="histogram-edit-log-list">
              {trainingLogs.map((log) => {
                const fieldChanges = trainingActivityChangeEntries(log.changes);
                const replacedLabels = trainingOverrideReplacedLabels(log);
                const displaySummary = trainingActivityDisplaySummary(log, {
                  hasFieldList: fieldChanges.length > 0 || replacedLabels.length > 0,
                });
                const displayAction = resolveTrainingLogDisplayAction(log);
                const clickable = typeof onTrainingLogClick === 'function'
                  && resolveTrainingLogNavigationTarget(log).kind !== 'none';
                return (
                  <li
                    key={log.id}
                    className={[
                      'histogram-edit-log-item',
                      'histogram-edit-log-item--training',
                      clickable ? 'is-clickable' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={clickable ? () => onTrainingLogClick(log) : undefined}
                    onKeyDown={clickable ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onTrainingLogClick(log);
                      }
                    } : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    title={clickable ? 'Open related training' : undefined}
                  >
                    <div className="histogram-edit-log-item-main">
                      <div className="histogram-edit-log-item-title-row">
                        <span className={`histogram-edit-log-badge${actionToneClass(displayAction) || ' is-saved'}`}>
                          {formatActionLabel(displayAction)}
                        </span>
                      </div>
                      <p className="histogram-edit-log-training-summary">
                        {displaySummary || log.summary || formatActionLabel(log.action)}
                      </p>
                      <span className="histogram-edit-log-meta">
                        {log.user_name ? `${log.user_name} · ` : null}
                        {formatLogTime(log.created_at)}
                        {replacedLabels.length > 0
                          ? ` · ${replacedLabels.length} replaced`
                          : null}
                      </span>
                      {replacedLabels.length > 0 ? (
                        <div className="activity-log-override-replaced">
                          <strong className="activity-log-change-group-title">Replaced</strong>
                          <ul className="histogram-edit-log-changes">
                            {replacedLabels.map((label) => (
                              <li key={`${log.id}-replaced-${label}`}>{label}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {fieldChanges.length > 0 ? (
                        <ul className="histogram-edit-log-changes activity-log-training-change-list">
                          {fieldChanges.map((entry) => (
                            <li key={`${log.id}-${entry.field}`} className="activity-log-training-change-item">
                              <div className="activity-log-field-change">
                                <div className="activity-log-field-name">{entry.label}</div>
                                <div className="activity-log-field-before-after">
                                  <div className="activity-log-value-block activity-log-value-block--before">
                                    <span className="activity-log-value-label">Before</span>
                                    <span className="activity-log-value-text">{entry.from}</span>
                                  </div>
                                  <div className="activity-log-value-block activity-log-value-block--after">
                                    <span className="activity-log-value-label">After</span>
                                    <span className="activity-log-value-text">{entry.to}</span>
                                  </div>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="histogram-edit-log-footer">
          {showProjects && onUndoAllSession ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleUndoAll}
              disabled={busy || Boolean(pendingId) || undoingAll || sessionUndoCount <= 0}
              title="Undo all unsaved edits made since this page was opened"
            >
              {undoingAll ? 'Undoing…' : `Undo all recent (${sessionUndoCount})`}
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={Boolean(pendingId) || undoingAll}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
