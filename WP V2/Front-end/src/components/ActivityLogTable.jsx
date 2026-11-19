import { Fragment, useState } from 'react';
import { dlTaskSections, taskSections } from '../constants/projectTaskFields';
import {
  formatTrainingActivityTimestamp,
  isTrainingActivityField,
  trainingActivityChangeEntries,
  trainingActivityDisplaySummary,
  trainingActivityFieldLabel,
  trainingActivityFieldValue,
  trainingOverrideReplacedLabels,
  resolveTrainingLogDisplayAction,
} from '../utils/trainingActivityLog';

const fieldLabelMap = [...taskSections, ...dlTaskSections].reduce((map, section) => {
  section.fields.forEach((field) => {
    map[field.key] = field.label;
  });
  return map;
}, {});

const AREA_PAGE_LABELS = {
  pde: 'Project Data Entry',
  algorithm: 'Project Data Entry',
  dl: 'DL Input Hours',
  Trainings: 'Trainings',
  histogram: 'Resource Histogram',
};

function formatAreaPageLabel(area) {
  if (!area) {
    return '—';
  }
  if (AREA_PAGE_LABELS[area]) {
    return AREA_PAGE_LABELS[area];
  }
  return String(area)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatFieldLabel(key) {
  if (fieldLabelMap[key]) {
    return fieldLabelMap[key];
  }

  if (isTrainingActivityField(key)) {
    return trainingActivityFieldLabel(key);
  }

  return String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatActionLabel(action) {
  if (!action) {
    return '—';
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

function formatValue(value, field = '') {
  if (isTrainingActivityField(field)) {
    return trainingActivityFieldValue(field, value);
  }

  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  return String(value);
}

function FieldChangeRow({ field, change, label = null, from = null, to = null }) {
  const resolvedFrom = from != null ? from : formatValue(change?.from, field);
  const resolvedTo = to != null ? to : formatValue(change?.to, field);

  return (
    <div className="activity-log-field-change">
      <div className="activity-log-field-name">{label || formatFieldLabel(field)}</div>
      <div className="activity-log-field-before-after">
        <div className="activity-log-value-block activity-log-value-block--before">
          <span className="activity-log-value-label">Before</span>
          <span className="activity-log-value-text">{resolvedFrom}</span>
        </div>
        <div className="activity-log-value-block activity-log-value-block--after">
          <span className="activity-log-value-label">After</span>
          <span className="activity-log-value-text">{resolvedTo}</span>
        </div>
      </div>
    </div>
  );
}

function renderFieldChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return null;
  }

  const isTraining = Object.keys(changes).some((field) => isTrainingActivityField(field));
  const entries = isTraining
    ? trainingActivityChangeEntries(changes).map((entry) => [entry.field, changes[entry.field]])
    : Object.entries(changes).sort(([left], [right]) => {
      const order = ['start_date', 'end_date'];
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) {
        return 0;
      }
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    });

  return entries.map(([field, change]) => (
    <FieldChangeRow key={field} field={field} change={change} />
  ));
}

function TaskChangeItem({ item }) {
  const fieldEntries = item.changes ? Object.entries(item.changes) : [];

  return (
    <article className="activity-log-task-item">
      <div className="activity-log-task-name">{item.task_name || `Task #${item.id}`}</div>
      {fieldEntries.length > 0 && (
        <div className="activity-log-task-fields">
          {fieldEntries.map(([field, change]) => (
            <FieldChangeRow key={field} field={field} change={change} />
          ))}
        </div>
      )}
    </article>
  );
}

function SimpleTaskList({ items }) {
  return (
    <ul className="activity-log-simple-list">
      {items.map((item) => (
        <li key={item.id}>{item.task_name || `Task #${item.id}`}</li>
      ))}
    </ul>
  );
}

function renderHistogramChanges(changes) {
  if (!Array.isArray(changes?.edits) || changes.edits.length === 0) {
    return null;
  }

  return (
    <section className="activity-log-change-group">
      <h4 className="activity-log-change-group-title">
        Bar edits ({changes.edits.length})
      </h4>
      <ul className="activity-log-simple-list">
        {changes.edits.map((edit, index) => (
          <li key={`${edit.bar_id || edit.task_id || 'edit'}-${index}`}>
            <strong>{edit.task_name || `Task #${edit.task_id}`}</strong>
            {edit.employee ? ` · ${edit.employee}` : ''}
            {edit.project_name ? ` · ${edit.project_name}` : ''}
            {edit.from || edit.to ? (
              <>
                {' · '}
                {edit.from || '—'}
                {' → '}
                {edit.to || '—'}
              </>
            ) : null}
            {edit.summary ? (
              <>
                <br />
                <span className="activity-log-summary-text">{edit.summary}</span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function renderLogChanges(changes, action) {
  if (action === 'save_bar_edits' && Array.isArray(changes?.edits)) {
    return renderHistogramChanges(changes);
  }

  return renderTaskSyncChanges(changes);
}

function renderTaskSyncChanges(changes) {
  if (!changes || typeof changes !== 'object') {
    return null;
  }

  const sections = [];

  if (Array.isArray(changes.created) && changes.created.length > 0) {
    sections.push(
      <section key="created" className="activity-log-change-group">
        <h4 className="activity-log-change-group-title">
          Created ({changes.created.length})
        </h4>
        <SimpleTaskList items={changes.created} />
      </section>,
    );
  }

  if (Array.isArray(changes.updated) && changes.updated.length > 0) {
    sections.push(
      <section key="updated" className="activity-log-change-group">
        <h4 className="activity-log-change-group-title">
          Updated ({changes.updated.length})
        </h4>
        <div className="activity-log-task-list">
          {changes.updated.map((item) => (
            <TaskChangeItem key={`updated-${item.id}`} item={item} />
          ))}
        </div>
      </section>,
    );
  }

  if (Array.isArray(changes.deleted) && changes.deleted.length > 0) {
    sections.push(
      <section key="deleted" className="activity-log-change-group">
        <h4 className="activity-log-change-group-title">
          Deleted ({changes.deleted.length})
        </h4>
        <SimpleTaskList items={changes.deleted} />
      </section>,
    );
  }

  if (sections.length > 0) {
    return sections;
  }

  return (
    <div className="activity-log-task-fields">
      {renderFieldChanges(changes)}
    </div>
  );
}

function formatTimestamp(value) {
  return formatTrainingActivityTimestamp(value);
}

function hasRenderableChanges(changes, action) {
  if (!changes || typeof changes !== 'object') {
    return false;
  }
  if (action === 'save_bar_edits' && Array.isArray(changes.edits)) {
    return changes.edits.length > 0;
  }
  if (Array.isArray(changes.created) && changes.created.length > 0) {
    return true;
  }
  if (Array.isArray(changes.updated) && changes.updated.length > 0) {
    return true;
  }
  if (Array.isArray(changes.deleted) && changes.deleted.length > 0) {
    return true;
  }
  return Object.keys(changes).some((field) => (
    changes[field]
    && typeof changes[field] === 'object'
    && !Array.isArray(changes[field])
    && ('from' in changes[field] || 'to' in changes[field])
  ));
}

function shouldHideChangeDetails(log, summaryOnly) {
  if (!hasRenderableChanges(log?.changes, log?.action)) {
    return true;
  }
  if (summaryOnly && log.summary && log.area !== 'Trainings') {
    return true;
  }
  return false;
}

function isTrainingFieldChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return false;
  }
  return Object.keys(changes).some((field) => isTrainingActivityField(field));
}

export default function ActivityLogTable({
  logs,
  loading,
  emptyMessage = 'No activity recorded yet.',
  summaryOnly = false,
  onLogClick = null,
  showPageColumn = false,
}) {
  const [expandedLogId, setExpandedLogId] = useState(null);

  if (loading) {
    return <p className="muted">Loading activity log...</p>;
  }

  if (!logs.length) {
    return <p className="muted">{emptyMessage}</p>;
  }

  const toggleLogDetails = (logId) => {
    setExpandedLogId((current) => (current === logId ? null : logId));
  };

  const handleRowActivate = (log) => {
    if (typeof onLogClick !== 'function') {
      return;
    }
    onLogClick(log);
  };

  const columnCount = showPageColumn ? 6 : 5;

  return (
    <div className="activity-log-table-wrap">
      <table className={`activity-log-table${showPageColumn ? ' has-page-column' : ''}`}>
        <thead>
          <tr>
            <th>When</th>
            <th>User</th>
            {showPageColumn ? <th>Page</th> : null}
            <th>Action</th>
            <th>Summary</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const hideChangeDetails = shouldHideChangeDetails(log, summaryOnly);
            const trainingChanges = !hideChangeDetails && isTrainingFieldChanges(log.changes);
            const replacedLabels = trainingOverrideReplacedLabels(log);
            const fieldEntries = trainingChanges
              ? trainingActivityChangeEntries(log.changes)
              : [];
            const displaySummary = trainingActivityDisplaySummary(log, {
              hasFieldList: fieldEntries.length > 0 || replacedLabels.length > 0,
            });
            const displayAction = resolveTrainingLogDisplayAction(log);
            const isExpanded = trainingChanges
              || replacedLabels.length > 0
              || expandedLogId === log.id;
            const showDetails = (log.changes && !hideChangeDetails) || replacedLabels.length > 0;
            const clickable = typeof onLogClick === 'function';

            return (
              <Fragment key={log.id}>
                <tr
                  className={`activity-log-row${clickable ? ' is-clickable' : ''}`}
                  onClick={clickable ? () => handleRowActivate(log) : undefined}
                  onKeyDown={clickable ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleRowActivate(log);
                    }
                  } : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  title={clickable ? 'Open related training' : undefined}
                >
                  <td className="activity-log-when">{formatTimestamp(log.created_at)}</td>
                  <td className="activity-log-user">{log.user_name}</td>
                  {showPageColumn ? (
                    <td className="activity-log-page-cell">
                      <span className="activity-log-page-badge">{formatAreaPageLabel(log.area)}</span>
                    </td>
                  ) : null}
                  <td className="activity-log-action-cell">
                    <span className={`activity-log-action${actionToneClass(displayAction)}`}>
                      {formatActionLabel(displayAction)}
                    </span>
                  </td>
                  <td className="activity-log-summary">
                    <span className="activity-log-summary-text">{displaySummary || log.summary}</span>
                  </td>
                  <td className="activity-log-details-cell">
                    {showDetails ? (
                      trainingChanges || replacedLabels.length > 0 ? (
                        <span className="activity-log-details-static">Field changes</span>
                      ) : (
                        <button
                          type="button"
                          className={`activity-log-details-toggle${isExpanded ? ' is-open' : ''}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleLogDetails(log.id);
                          }}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? 'Hide changes' : 'View changes'}
                        </button>
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                {isExpanded && showDetails ? (
                  <tr className="activity-log-details-row">
                    <td colSpan={columnCount}>
                      <div className="activity-log-change-body">
                        {replacedLabels.length > 0 ? (
                          <div className="activity-log-override-replaced">
                            <h4 className="activity-log-change-group-title">Replaced</h4>
                            <ul className="activity-log-simple-list">
                              {replacedLabels.map((label) => (
                                <li key={label}>{label}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {trainingChanges ? (
                          <ul className="activity-log-training-change-list">
                            {fieldEntries.map((entry) => (
                              <li key={entry.field} className="activity-log-training-change-item">
                                <FieldChangeRow
                                  field={entry.field}
                                  label={entry.label}
                                  from={entry.from}
                                  to={entry.to}
                                />
                              </li>
                            ))}
                          </ul>
                        ) : log.changes && !hideChangeDetails ? (
                          renderLogChanges(log.changes, log.action)
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
