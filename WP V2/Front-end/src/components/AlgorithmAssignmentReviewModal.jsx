import { Fragment, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import ProjectColorSelect from './ProjectColorSelect';
import { getApiErrorMessage } from '../utils/apiErrors';
import { formatDisplayDate } from '../utils/dateFormat';
import { formatPriorityValue } from '../utils/priorityFormat';
import { displayProjectColor } from '../utils/projectColor';

function formatHours(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toFixed(2);
}

function assigneeSummary(task) {
  return [task.algorithm_1, task.algorithm_2, task.algorithm_3]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

function buildSummary(task) {
  const parts = [
    task.part_name,
    task.plan != null && String(task.plan).trim() !== '' ? `Plan ${formatHours(task.plan)}h` : null,
    task.day_count != null ? `${task.day_count} day${Number(task.day_count) === 1 ? '' : 's'}` : null,
    task.total_hours != null ? `${formatHours(task.total_hours)}h assigned` : null,
    assigneeSummary(task) || null,
  ].filter(Boolean);

  return parts.join(' · ') || '—';
}

function groupRowsByProject(rows) {
  const groups = [];

  rows.forEach((row) => {
    const projectId = String(row.project_id ?? '');
    const lastGroup = groups[groups.length - 1];

    if (!lastGroup || lastGroup.projectId !== projectId) {
      groups.push({
        projectId,
        projectName: row.project_name || '—',
        projectColor: row.project_color,
        tasks: [row],
      });
      return;
    }

    lastGroup.tasks.push(row);
  });

  return groups;
}

export default function AlgorithmAssignmentReviewModal({
  open,
  onClose,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [cacheMissing, setCacheMissing] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [projectFilterId, setProjectFilterId] = useState('');

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError('');
      setRows([]);
      setCacheMissing(false);
      setExpandedTaskId(null);
      setProjectFilterId('');

      try {
        const { data: response } = await api.get('/algorithm/assignments');
        if (cancelled) return;

        setRows(Array.isArray(response?.data) ? response.data : []);
        setCacheMissing(Boolean(response?.algorithm_cache_missing));
      } catch (err) {
        if (cancelled) return;
        setError(getApiErrorMessage(err, 'Unable to load algorithm assignments.'));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const projectOptions = useMemo(() => {
    const byProject = new Map();
    rows.forEach((row) => {
      const id = String(row.project_id ?? '');
      if (!id) return;
      if (!byProject.has(id)) {
        byProject.set(id, {
          id,
          name: row.project_name || `Project #${id}`,
          color: row.project_color,
        });
      }
    });
    return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (!projectFilterId) return rows;
    return rows.filter((row) => String(row.project_id) === String(projectFilterId));
  }, [rows, projectFilterId]);

  const projectGroups = useMemo(
    () => groupRowsByProject(visibleRows),
    [visibleRows],
  );

  const showProjectColumn = !projectFilterId;
  const columnCount = showProjectColumn ? 5 : 4;

  const emptyMessage = cacheMissing
    ? 'No algorithm assignments found. Run the algorithm first, then open this review again.'
    : 'No assignment rows found in the algorithm cache.';

  return (
    <Modal
      open={open}
      title="Algorithm assignment review"
      onClose={onClose}
      size="wide"
    >
      <div className="activity-log-modal algorithm-review-modal">
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        {!loading && !error && rows.length > 0 ? (
          <div className="activity-log-toolbar algorithm-review-toolbar">
            <p className="activity-log-description">
              Review algorithm hours by task and day from the current run.
            </p>
            <div className="activity-log-filters">
              <label className="activity-log-filter">
                <span>Project</span>
                <ProjectColorSelect
                  projects={projectOptions}
                  value={projectFilterId}
                  onChange={(nextValue) => {
                    setProjectFilterId(nextValue);
                    setExpandedTaskId(null);
                  }}
                  placeholder={`All projects (${projectOptions.length})`}
                />
              </label>
              {projectFilterId ? (
                <button
                  type="button"
                  className="activity-log-details-toggle algorithm-review-clear-filter"
                  onClick={() => {
                    setProjectFilterId('');
                    setExpandedTaskId(null);
                  }}
                >
                  All projects
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {loading ? (
          <p className="muted">Loading algorithm assignments...</p>
        ) : null}

        {!loading && !error && (cacheMissing || visibleRows.length === 0) ? (
          <p className="muted">{emptyMessage}</p>
        ) : null}

        {!loading && !error && visibleRows.length > 0 ? (
          <div className="activity-log-table-wrap">
            <table className="activity-log-table algorithm-review-table">
              <thead>
                <tr>
                  {showProjectColumn ? <th>Project</th> : null}
                  <th>Task</th>
                  <th>Pri</th>
                  <th>Summary</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {projectGroups.map((group) => {
                  const expandedDetailRows = group.tasks.filter(
                    (groupTask) => expandedTaskId === groupTask.task_id,
                  ).length;
                  const projectRowSpan = group.tasks.length + expandedDetailRows;

                  return group.tasks.map((task, taskIndex) => {
                    const isExpanded = expandedTaskId === task.task_id;
                    const isFirstInGroup = taskIndex === 0;
                    const hasAssignments = (task.assignments || []).length > 0;

                    return (
                      <Fragment key={task.task_id}>
                        <tr className="activity-log-row">
                          {showProjectColumn && isFirstInGroup ? (
                            <td
                              className="algorithm-review-project-cell"
                              rowSpan={projectRowSpan}
                            >
                              <span className="algorithm-review-project-label">
                                <span
                                  className="algorithm-review-project-swatch"
                                  style={{ backgroundColor: displayProjectColor({ color: group.projectColor }) }}
                                  aria-hidden="true"
                                />
                                <span>{group.projectName}</span>
                              </span>
                            </td>
                          ) : null}
                          <td className="algorithm-review-task-cell">{task.task_name || '—'}</td>
                          <td className="algorithm-review-pri-cell">
                            {formatPriorityValue(task.pri) || '—'}
                          </td>
                          <td className="activity-log-summary">
                            <span className="activity-log-summary-text">{buildSummary(task)}</span>
                          </td>
                          <td className="activity-log-details-cell">
                            {hasAssignments ? (
                              <button
                                type="button"
                                className={`activity-log-details-toggle${isExpanded ? ' is-open' : ''}`}
                                onClick={() => setExpandedTaskId(isExpanded ? null : task.task_id)}
                                aria-expanded={isExpanded}
                              >
                                {isExpanded ? 'Hide breakdown' : 'View breakdown'}
                              </button>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                        {isExpanded && hasAssignments ? (
                          <tr className="activity-log-details-row">
                            <td colSpan={columnCount - (showProjectColumn ? 1 : 0)}>
                              <div className="activity-log-change-body">
                                <section className="activity-log-change-group">
                                  <h4 className="activity-log-change-group-title">
                                    Daily breakdown · {task.task_name || 'Task'}
                                  </h4>
                                  <ul className="activity-log-simple-list algorithm-review-breakdown-list">
                                    {task.assignments.map((entry, entryIndex) => (
                                      <li key={`${task.task_id}-${entry.date}-${entry.employee}-${entryIndex}`}>
                                        <strong>{formatDisplayDate(entry.date) || entry.date}</strong>
                                        {' · '}
                                        {entry.employee}
                                        {' · '}
                                        {formatHours(entry.hours)}h
                                      </li>
                                    ))}
                                  </ul>
                                </section>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
