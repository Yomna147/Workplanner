import { memo, useCallback, useEffect, useRef } from 'react';
import DisplayDateInput from './DisplayDateInput';
import TrainingDaySegmentPicker from './TrainingDaySegmentPicker';
import {
  TRAINING_PRIORITY_OPTIONS,
  TRAINING_STATUS_OPTIONS,
  TRAINING_URGENCY_OPTIONS,
  openTrainingCourseLink,
} from '../utils/trainingForm';
import { formatDisplayDate } from '../utils/dateFormat';
import { formatTrainingCreatedAt } from '../utils/trainingSaveGuard';

/** Fields a trainee (status-only) may still change. */
export const TRAINEE_EDITABLE_TRAINING_KEYS = new Set([
  'status',
]);

function formatDateRange(start, end) {
  const startLabel = formatDisplayDate(start);
  const endLabel = formatDisplayDate(end);
  if (startLabel && endLabel && startLabel !== endLabel) {
    return `${startLabel} → ${endLabel}`;
  }
  return startLabel || endLabel || '—';
}

const DATE_SCHEDULE_LOCK_KEYS = new Set([
  'start_date',
  'end_date',
  'day_segment',
  'hours_per_day',
  'duration',
]);

function isFieldLockedForUser(key, { readOnly, statusOnly, dateFieldsReadOnly }) {
  if (readOnly) {
    return true;
  }
  // Operatives/DLs: dates + day section are view-only (same grey lock as title/priority).
  if (dateFieldsReadOnly && DATE_SCHEDULE_LOCK_KEYS.has(key)) {
    return true;
  }
  if (statusOnly && !TRAINEE_EDITABLE_TRAINING_KEYS.has(key)) {
    return true;
  }
  return false;
}

const DlMyTrainingRow = memo(function DlMyTrainingRow({
  row,
  onChange,
  focused = false,
  readOnly = false,
  statusOnly = false,
  dateFieldsReadOnly = false,
}) {
  const rowRef = useRef(null);

  useEffect(() => {
    if (!focused || !rowRef.current) {
      return;
    }
    rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);

  const lock = (key) => isFieldLockedForUser(key, {
    readOnly,
    statusOnly,
    dateFieldsReadOnly,
  });

  const commit = useCallback((key, value) => {
    if (typeof onChange !== 'function') {
      return;
    }
    if (isFieldLockedForUser(key, { readOnly, statusOnly, dateFieldsReadOnly })) {
      return;
    }
    onChange(row.id, key, value);
  }, [dateFieldsReadOnly, onChange, readOnly, row.id, statusOnly]);
  const lockedClass = (key) => (lock(key) ? ' is-locked' : '');
  const cellClass = (key, base) => (
    `${base}${lock(key) ? ' is-readonly-cell' : ' is-editable-cell'}`
  );

  return (
    <tr
      ref={rowRef}
      className={[
        focused ? 'is-focused-training' : '',
        statusOnly ? 'is-trainee-status-only' : '',
        readOnly ? 'is-training-readonly' : '',
      ].filter(Boolean).join(' ') || undefined}
      data-training-id={row.id}
    >
      <td className={cellClass('title', 'dl-my-training-cell dl-my-training-cell--title')}>
        <input
          type="text"
          className={`dl-my-training-input${lockedClass('title')}`}
          value={row.title ?? ''}
          onChange={(e) => commit('title', e.target.value)}
          title={lock('title') ? 'Not editable for trainees' : (row.title || 'Training title')}
          readOnly={lock('title')}
          tabIndex={lock('title') ? -1 : undefined}
        />
      </td>
      <td className={cellClass('course_link', 'dl-my-training-cell dl-my-training-cell--link')}>
        <div className="dl-my-training-link-row">
          <input
            type="url"
            className={`dl-my-training-input${lockedClass('course_link')}`}
            value={row.course_link ?? ''}
            onChange={(e) => commit('course_link', e.target.value)}
            placeholder="https://"
            title={lock('course_link') ? 'Not editable for trainees' : (row.course_link || 'Course link')}
            readOnly={lock('course_link')}
            tabIndex={lock('course_link') ? -1 : undefined}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm dl-my-training-open-btn"
            onClick={() => openTrainingCourseLink(row.course_link)}
            disabled={!row.course_link?.trim()}
            title="Open course link"
          >
            Open
          </button>
        </div>
      </td>
      <td className={cellClass('description', 'dl-my-training-cell dl-my-training-cell--description')}>
        <input
          type="text"
          className={`dl-my-training-input${lockedClass('description')}`}
          value={row.description ?? ''}
          onChange={(e) => commit('description', e.target.value)}
          placeholder="Description"
          title={lock('description') ? 'Not editable for trainees' : (row.description || 'Description')}
          readOnly={lock('description')}
          tabIndex={lock('description') ? -1 : undefined}
        />
      </td>
      <td className={cellClass('status', 'dl-my-training-cell dl-my-training-cell--select')}>
        <select
          className={`dl-my-training-input${lock('status') ? ' is-locked' : ' is-editable'}`}
          value={row.status ?? ''}
          onChange={(e) => commit('status', e.target.value)}
          title={lock('status') ? 'Not editable' : 'Status'}
          disabled={lock('status')}
        >
          {TRAINING_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
      <td className={cellClass('priority', 'dl-my-training-cell dl-my-training-cell--select')}>
        <select
          className={`dl-my-training-input${lockedClass('priority')}`}
          value={row.priority ?? ''}
          onChange={(e) => commit('priority', e.target.value)}
          title={lock('priority') ? 'Not editable for trainees' : 'Priority'}
          disabled={lock('priority')}
        >
          {TRAINING_PRIORITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
      <td className={cellClass('urgency', 'dl-my-training-cell dl-my-training-cell--select dl-my-training-cell--urgency')}>
        <select
          className={`dl-my-training-input${lockedClass('urgency')}`}
          value={row.urgency ?? ''}
          onChange={(e) => commit('urgency', e.target.value)}
          title={lock('urgency') ? 'Not editable for trainees' : 'Urgency'}
          disabled={lock('urgency')}
        >
          {TRAINING_URGENCY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
      <td className={cellClass('start_date', 'dl-my-training-cell dl-my-training-cell--date')}>
        <DisplayDateInput
          value={row.start_date ?? ''}
          onChange={(value) => commit('start_date', value)}
          className={`dl-my-training-date${lockedClass('start_date')}`}
          placeholder=""
          disabled={lock('start_date')}
          title={lock('start_date') ? 'Not editable for trainees' : undefined}
        />
      </td>
      <td className={cellClass('day_segment', 'dl-my-training-cell dl-my-training-cell--segment')}>
        <TrainingDaySegmentPicker
          value={row.day_segment}
          onChange={(segment) => commit('day_segment', segment)}
          disabled={lock('day_segment')}
          readOnly={lock('day_segment')}
          className={lock('day_segment') ? 'is-locked' : ''}
          aria-label="Day section"
        />
      </td>
      <td className="dl-my-training-cell is-readonly-cell">
        <span className="task-readonly-text is-locked">
          {row.assigned_by_name || '—'}
        </span>
      </td>
      <td className="dl-my-training-cell is-readonly-cell">
        <span className="task-readonly-text is-locked">
          {formatTrainingCreatedAt(row) || '—'}
        </span>
      </td>
    </tr>
  );
});

export default memo(function DlMyTrainingsPanel({
  rows = [],
  totalCount = 0,
  operativeName = '',
  onChange,
  statusLabel,
  focusedTrainingId = '',
  emptyMessage = 'No trainings scheduled for you.',
  filteredEmptyMessage = 'No trainings match the current filters.',
  readOnly = false,
  statusOnly = false,
  dateFieldsReadOnly = false,
}) {
  const nextTraining = rows[0] ?? null;
  const showingFiltered = totalCount > 0 && rows.length < totalCount;
  const focusedId = focusedTrainingId ? String(focusedTrainingId) : '';

  if (rows.length === 0) {
    return (
      <div className="dl-my-trainings">
        <div className="dl-my-trainings-empty card">
          <p>{totalCount > 0 ? filteredEmptyMessage : emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dl-my-trainings">
      <section className="dl-my-trainings-overview card" aria-label="Training summary">
        <div className="dl-my-trainings-stat">
          <span className="dl-my-trainings-stat-label">Operative</span>
          <strong>{operativeName || '—'}</strong>
        </div>
        <div className="dl-my-trainings-stat">
          <span className="dl-my-trainings-stat-label">Assigned</span>
          <strong>
            {showingFiltered ? `${rows.length} of ${totalCount}` : rows.length}
          </strong>
        </div>
        <div className="dl-my-trainings-stat">
          <span className="dl-my-trainings-stat-label">Next training</span>
          <strong>{formatDateRange(nextTraining?.start_date, nextTraining?.end_date)}</strong>
        </div>
        <div className="dl-my-trainings-stat">
          <span className="dl-my-trainings-stat-label">Status</span>
          <strong>{statusLabel(nextTraining?.status)}</strong>
        </div>
      </section>

      <div className="card dl-my-trainings-table-wrap">
        <div className="dl-my-trainings-table-scroll">
          <table className="dl-my-trainings-table">
            <thead>
              <tr>
                <th>Course</th>
                <th>Course link</th>
                <th>Short description</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Urgency</th>
                <th>Task date</th>
                <th>Day section</th>
                <th>Assigned by</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <DlMyTrainingRow
                  key={row.id ?? `${row.title}-${index}`}
                  row={row}
                  onChange={onChange}
                  focused={focusedId !== '' && String(row.id) === focusedId}
                  readOnly={readOnly}
                  statusOnly={statusOnly}
                  dateFieldsReadOnly={dateFieldsReadOnly}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});
