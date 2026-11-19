import { memo } from 'react';
import { formatDisplayDate } from '../../utils/dateFormat';
import { employeeDisplayName, employeeTeamName } from '../../utils/employeeNames';
import {
  formatTrainingTotalHours,
  openTrainingCourseLink,
  trainingDaySegmentLabel,
  trainingPriorityLabel,
  trainingStatusProgressPercent,
  trainingUrgencyLabel,
} from '../../utils/trainingForm';
import { resolveTrainingSessionLegend } from '../../utils/trainingGroups';
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

function TrainingMetaGrid({ training, statusLabel }) {
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
        <span>{displayValue(training.priority)}</span>
      </div>
      <div>
        <strong>Urgency</strong>
        <span>{displayValue(training.urgency)}</span>
      </div>
      <div>
        <strong>Duration</strong>
        <span>{formatTrainingTotalHours(training) || '—'}</span>
      </div>
      <div>
        <strong>Day slot</strong>
        <span title="Which quarter of the workday this course uses (same as histogram day bands)">
          {trainingDaySegmentLabel(training.day_segment)}
        </span>
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

function TrainingSessionIndexBadge({ number, color, className = '' }) {
  if (!number) {
    return null;
  }

  return (
    <span
      className={`trainings-session-index-badge${className ? ` ${className}` : ''}`}
      style={{ backgroundColor: color || '#3b82f6' }}
      aria-hidden="true"
    >
      {number}
    </span>
  );
}

function PanelCloseHint() {
  return (
    <p className="trainings-gap-detail-close-hint">
      Double-click outside the panel to close, or use × above.
    </p>
  );
}

const TrainingsGapDetailPanel = memo(function TrainingsGapDetailPanel({
  panel,
  statusLabel,
  sessionLegendLookup,
  onClose,
  onRemoveAssignment = null,
  onDeleteTraining = null,
  onUpdateStatus = null,
  onOpenTraining = null,
  openTrainingTitle,
  deletingId = null,
  statusSavingId = null,
}) {
  const isBusy = deletingId != null;
  const isDeletingSession = deletingId === 'session';

  if (!panel) {
    return null;
  }

  if (panel.kind === 'employee') {
    const { row, trainings = [] } = panel;

    return (
      <div
        className="histogram-crm-detail-overlay"
        onDoubleClick={onClose}
        role="presentation"
      >
        <aside
          className="histogram-crm-detail-panel trainings-gap-detail-panel"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label="Operative trainings"
        >
          <div className="histogram-crm-detail-top">
            <div className="histogram-crm-detail-heading">
              <span
                className="histogram-crm-detail-color trainings-gap-detail-color is-employee"
                aria-hidden
              />
              <h2>{row.name}</h2>
            </div>
            <button
              type="button"
              className="histogram-crm-detail-close"
              onClick={onClose}
              aria-label="Close details panel"
            >
              ×
            </button>
          </div>

          <div className="histogram-crm-detail-subtitle">
            {row.teamName || 'No team'}
            {' · '}
            {trainings.length} training{trainings.length === 1 ? '' : 's'}
            {' · '}
            {row.gapHours.toFixed(1)} h gap in view
          </div>

          <div className="histogram-crm-detail-stages">
            <span className="histogram-crm-stage-pill histogram-crm-stage-pill-active">
              Operative
            </span>
          </div>

          <InfoBox title={`Assigned trainings (${trainings.length})`}>
            {trainings.length === 0 ? (
              <p className="trainings-gap-detail-empty">No trainings scheduled for this operative.</p>
            ) : (
              <ul className="trainings-gap-detail-training-list is-horizontal">
                {trainings.map((training) => {
                  const legend = resolveTrainingSessionLegend(training, sessionLegendLookup);
                  const isRemoving = String(deletingId) === String(training.id);
                  // The card opens the training; its own buttons/links keep their actions.
                  const openFromCard = (event) => {
                    if (!onOpenTraining || event.target.closest('button, a, input, select, textarea')) {
                      return;
                    }
                    onOpenTraining(training);
                  };
                  return (
                  <li
                    key={training.id}
                    className={`trainings-gap-detail-training-item${onOpenTraining ? ' is-openable' : ''}`}
                    {...(onOpenTraining ? {
                      role: 'button',
                      tabIndex: 0,
                      title: openTrainingTitle,
                      onClick: openFromCard,
                      onKeyDown: (event) => {
                        if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                          event.preventDefault();
                          onOpenTraining(training);
                        }
                      },
                    } : {})}
                  >
                    <div className="trainings-gap-detail-training-head">
                      <TrainingSessionIndexBadge
                        number={legend.legendNumber}
                        color={legend.legendColor}
                        className="trainings-gap-detail-training-index"
                      />
                      <strong>{training.title || 'Untitled training'}</strong>
                      <span className="histogram-crm-stage-pill">
                        {statusLabel(training.status)}
                      </span>
                    </div>
                    <TrainingMetaGrid training={training} statusLabel={statusLabel} />
                    {training.description ? (
                      <p className="trainings-gap-detail-description">{training.description}</p>
                    ) : null}
                    {onRemoveAssignment ? (
                      <div className="trainings-gap-detail-item-actions">
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => onRemoveAssignment(training)}
                          disabled={isBusy}
                        >
                          {isRemoving ? 'Removing...' : 'Remove assignment'}
                        </button>
                      </div>
                    ) : null}
                  </li>
                  );
                })}
              </ul>
            )}
          </InfoBox>
          <PanelCloseHint />
        </aside>
      </div>
    );
  }

  const { group } = panel;
  const assignments = group?.assignments ?? [];

  return (
    <div
      className="histogram-crm-detail-overlay"
      onDoubleClick={onClose}
      role="presentation"
    >
      <aside
        className="histogram-crm-detail-panel trainings-gap-detail-panel trainings-gap-detail-panel--session"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-label="Course details"
      >
        <div className="histogram-crm-detail-top">
          <div className="histogram-crm-detail-heading">
            <TrainingSessionIndexBadge
              number={group.legendNumber}
              color={group.legendColor}
              className="trainings-gap-detail-session-index"
            />
            <h2>{group.title || 'Untitled training'}</h2>
          </div>
          <div className="histogram-crm-detail-top-actions">
            {group.course_link ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => openTrainingCourseLink(group.course_link)}
              >
                Open course link
              </button>
            ) : null}
            {onDeleteTraining ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => onDeleteTraining(group)}
                disabled={isBusy}
                title="Delete this training for all assigned operatives"
              >
                {isDeletingSession ? 'Deleting...' : 'Delete training'}
              </button>
            ) : null}
            <button
              type="button"
              className="histogram-crm-detail-close"
              onClick={onClose}
              aria-label="Close details panel"
            >
              ×
            </button>
          </div>
        </div>

        <div className="histogram-crm-detail-subtitle">
          {formatDisplayDate(group.start_date) || '—'}
          {' → '}
          {formatDisplayDate(group.end_date) || '—'}
          {' · '}
          {assignments.length} operative{assignments.length === 1 ? '' : 's'}
        </div>

        <div className="histogram-crm-detail-stages">
          <span className="histogram-crm-stage-pill histogram-crm-stage-pill-active">
            {statusLabel(group.status)}
          </span>
          {group.priority ? (
            <span className="histogram-crm-stage-pill">{group.priority}</span>
          ) : null}
          {group.urgency ? (
            <span className="histogram-crm-stage-pill">{group.urgency}</span>
          ) : null}
        </div>

        <div className="trainings-gap-detail-session-body">
          <InfoBox title="Course details">
            <TrainingMetaGrid training={group} statusLabel={statusLabel} />
            {group.description ? (
              <p className="trainings-gap-detail-description">{group.description}</p>
            ) : null}
          </InfoBox>

          <InfoBox title={`Assigned operatives (${assignments.length})`}>
            {assignments.length === 0 ? (
              <p className="trainings-gap-detail-empty">No operatives assigned.</p>
            ) : (
              <ul className="trainings-gap-detail-assignee-list is-horizontal">
                {assignments.map((assignment) => {
                  const progressPercent = trainingStatusProgressPercent(assignment.status);
                  const isRemoving = String(deletingId) === String(assignment.id);
                  const isSavingStatus = String(statusSavingId) === String(assignment.id);
                  // Only flag values that deviate from the course defaults.
                  const priorityDiffers = Boolean(assignment.priority)
                    && assignment.priority !== group.priority;
                  const urgencyDiffers = Boolean(assignment.urgency)
                    && assignment.urgency !== group.urgency;
                  return (
                    <li key={assignment.id} className="trainings-gap-detail-assignee-item">
                      <div className="trainings-gap-detail-assignee-head">
                        <strong>{employeeDisplayName(assignment.employee) || '—'}</strong>
                        <span className="histogram-crm-stage-pill">
                          {statusLabel(assignment.status)}
                        </span>
                      </div>
                      {priorityDiffers || urgencyDiffers ? (
                        <div className="trainings-gap-detail-assignee-overrides">
                          {priorityDiffers ? (
                            <span
                              className="histogram-crm-stage-pill trainings-gap-detail-override-pill"
                              title={`Priority ${trainingPriorityLabel(assignment.priority)} (course: ${trainingPriorityLabel(group.priority) || '—'})`}
                            >
                              {assignment.priority}
                            </span>
                          ) : null}
                          {urgencyDiffers ? (
                            <span
                              className="histogram-crm-stage-pill trainings-gap-detail-override-pill"
                              title={`Urgency ${trainingUrgencyLabel(assignment.urgency)} (course: ${trainingUrgencyLabel(group.urgency) || '—'})`}
                            >
                              {assignment.urgency}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
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
                })}
              </ul>
            )}
          </InfoBox>
        </div>
        <PanelCloseHint />
      </aside>
    </div>
  );
});

export default TrainingsGapDetailPanel;
