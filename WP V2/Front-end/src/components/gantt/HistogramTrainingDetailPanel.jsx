import { memo, useMemo } from 'react';
import { formatDisplayDate } from '../../utils/dateFormat';
import {
  formatTrainingTotalHours,
  openTrainingCourseLink,
  TRAINING_STATUS_OPTIONS,
  trainingPriorityLabel,
  trainingStatusLabel,
  trainingStatusProgressPercent,
  trainingUrgencyLabel,
} from '../../utils/trainingForm';
import { employeeDisplayName, employeeTeamName } from '../../utils/employeeNames';
import TrainingAssigneeProgressSelect from './TrainingAssigneeProgressSelect';
import './histogram-detail-panel.css';

function InfoBox({ title, children }) {
  return (
    <section className="histogram-crm-info-box">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function displayValue(value) {
  const text = String(value ?? '').trim();
  return text || '—';
}

function statusLabel(value) {
  return trainingStatusLabel(value)
    || TRAINING_STATUS_OPTIONS.find((option) => option.value === value)?.label
    || value;
}

function TrainingMetaGrid({ training }) {
  return (
    <div className="histogram-crm-detail-grid trainings-gap-detail-grid">
      <div>
        <strong>Start</strong>
        <span>{formatDisplayDate(training.start_date) || '—'}</span>
      </div>
      <div>
        <strong>End</strong>
        <span>{formatDisplayDate(training.end_date) || '—'}</span>
      </div>
      <div>
        <strong>Status</strong>
        <span>{statusLabel(training.status)}</span>
      </div>
      <div>
        <strong>Priority</strong>
        <span>{trainingPriorityLabel(training.priority) || displayValue(training.priority)}</span>
      </div>
      <div>
        <strong>Urgency</strong>
        <span>{trainingUrgencyLabel(training.urgency) || displayValue(training.urgency)}</span>
      </div>
      <div>
        <strong>Duration</strong>
        <span>{formatTrainingTotalHours(training) || '—'}</span>
      </div>
      <div>
        <strong>Course link</strong>
        <span>
          {training.course_link ? (
            <button
              type="button"
              className="trainings-gap-detail-link"
              onClick={() => openTrainingCourseLink(training.course_link)}
            >
              Open link
            </button>
          ) : '—'}
        </span>
      </div>
    </div>
  );
}

function AssigneeCard({
  assignment,
  isFocused = false,
  isBusy = false,
  isRemoving = false,
  isSavingStatus = false,
  onRemoveAssignment = null,
  onUpdateStatus = null,
}) {
  const name = assignment.employee
    ? employeeDisplayName(assignment.employee)
      || [assignment.employee.first_name, assignment.employee.last_name].filter(Boolean).join(' ')
      || assignment.employee.name
    : '—';
  const progressPercent = trainingStatusProgressPercent(assignment.status);

  return (
    <li
      className={`trainings-gap-detail-assignee-item${isFocused ? ' is-focused' : ''}`}
    >
      <div className="trainings-gap-detail-assignee-head">
        <strong>{name || '—'}</strong>
        <span className="histogram-crm-stage-pill">
          {statusLabel(assignment.status)}
        </span>
      </div>
      <div
        className="trainings-gap-detail-assignee-progress"
        aria-label={`Progress ${progressPercent}%`}
      >
        <div className="trainings-gap-detail-assignee-progress-track">
          <div
            className="trainings-gap-detail-assignee-progress-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="trainings-gap-detail-assignee-progress-label">
          {progressPercent}%
        </span>
      </div>
      <div className="trainings-gap-detail-assignee-meta">
        <span>
          {formatDisplayDate(assignment.start_date) || '—'}
          {' → '}
          {formatDisplayDate(assignment.end_date) || '—'}
        </span>
        {formatTrainingTotalHours(assignment) ? (
          <span>{formatTrainingTotalHours(assignment)}</span>
        ) : null}
        {employeeTeamName(assignment.employee) ? (
          <span>{employeeTeamName(assignment.employee)}</span>
        ) : null}
      </div>
      {onRemoveAssignment || onUpdateStatus ? (
        <div className="trainings-gap-detail-item-actions">
          {onUpdateStatus ? (
            <TrainingAssigneeProgressSelect
              assignment={assignment}
              status={assignment.status}
              disabled={isBusy}
              saving={isSavingStatus}
              onStatusChange={onUpdateStatus}
            />
          ) : null}
          {onRemoveAssignment ? (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => onRemoveAssignment(assignment)}
              disabled={isBusy || isSavingStatus}
            >
              {isRemoving ? 'Removing...' : 'Remove'}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function HistogramTrainingDetailPanel({
  training,
  assignees = [],
  onClose,
  onRemoveAssignment = null,
  onDeleteTraining = null,
  onUpdateStatus = null,
  deletingId = null,
  statusSavingId = null,
}) {
  const isBusy = deletingId != null;
  const isDeletingSession = deletingId === 'session';

  const sessionAssignees = useMemo(
    () => (assignees?.length ? assignees : (training ? [training] : [])),
    [assignees, training],
  );

  if (!training) {
    return null;
  }

  return (
    <div
      className="histogram-crm-detail-overlay"
      onDoubleClick={onClose}
      role="presentation"
    >
      <aside
        className="histogram-crm-detail-panel histogram-training-detail-panel trainings-gap-detail-panel--session"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-label="Course summary"
      >
        <div className="histogram-crm-detail-top">
          <div className="histogram-crm-detail-heading">
            <span
              className="histogram-crm-detail-color histogram-training-detail-swatch"
              aria-hidden
            />
            <div>
              <p className="histogram-panel-eyebrow">Course summary</p>
              <h2>{training.title || 'Untitled training'}</h2>
            </div>
          </div>
          <div className="histogram-crm-detail-top-actions">
            {training.course_link ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => openTrainingCourseLink(training.course_link)}
              >
                Open course link
              </button>
            ) : null}
            {onDeleteTraining ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => onDeleteTraining({
                  title: training.title,
                  training_course_id: training.training_course_id,
                  assignments: sessionAssignees,
                })}
                disabled={isBusy}
                title="Delete this assignment"
              >
                {isDeletingSession ? 'Deleting...' : 'Delete training'}
              </button>
            ) : null}
            <button
              type="button"
              className="histogram-crm-detail-close"
              onClick={onClose}
              aria-label="Close training panel"
            >
              ×
            </button>
          </div>
        </div>

        <div className="histogram-crm-detail-subtitle">
          {formatDisplayDate(training.start_date) || '—'}
          {' → '}
          {formatDisplayDate(training.end_date) || '—'}
          {' · '}
          {sessionAssignees.length} operative{sessionAssignees.length === 1 ? '' : 's'}
          {formatTrainingTotalHours(training) ? ` · ${formatTrainingTotalHours(training)}` : ''}
        </div>

        <div className="histogram-crm-detail-stages">
          <span className="histogram-crm-stage-pill histogram-crm-stage-pill-active">
            {statusLabel(training.status)}
          </span>
          {training.priority ? (
            <span className="histogram-crm-stage-pill">
              {trainingPriorityLabel(training.priority)}
            </span>
          ) : null}
          {training.urgency ? (
            <span className="histogram-crm-stage-pill">
              {trainingUrgencyLabel(training.urgency)}
            </span>
          ) : null}
        </div>

        <div className="trainings-gap-detail-session-body">
          <InfoBox title="Assignment details">
            <TrainingMetaGrid training={training} />
            {training.description ? (
              <p className="trainings-gap-detail-description">{training.description}</p>
            ) : null}
          </InfoBox>

          <InfoBox title={`Assigned operatives (${sessionAssignees.length})`}>
            {sessionAssignees.length === 0 ? (
              <p className="trainings-gap-detail-empty">No operatives assigned.</p>
            ) : (
              <ul className="trainings-gap-detail-assignee-list is-horizontal">
                {sessionAssignees.map((assignment) => (
                  <AssigneeCard
                    key={assignment.id}
                    assignment={assignment}
                    isFocused={String(assignment.id) === String(training.id)}
                    isBusy={isBusy}
                    isRemoving={String(deletingId) === String(assignment.id)}
                    isSavingStatus={String(statusSavingId) === String(assignment.id)}
                    onRemoveAssignment={onRemoveAssignment}
                    onUpdateStatus={onUpdateStatus}
                  />
                ))}
              </ul>
            )}
          </InfoBox>
        </div>

        <p className="trainings-gap-detail-close-hint">
          Double-click outside the panel to close, or use × above.
        </p>
      </aside>
    </div>
  );
}

export default memo(HistogramTrainingDetailPanel);
