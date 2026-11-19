import { createPortal } from 'react-dom';
import { formatDisplayDate } from '../../utils/dateFormat';
import { employeeDisplayName } from '../../utils/employeeNames';
import {
  formatTrainingTotalHours,
  trainingPriorityLabel,
  trainingStatusLabel,
  trainingUrgencyLabel,
} from '../../utils/trainingForm';

/** Host + path, trimmed so long URLs don't stretch the card. */
function courseLinkLabel(url) {
  const text = String(url || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

function HoverRow({ label, value, emphasis = false }) {
  if (value == null || value === '') {
    return null;
  }
  return (
    <div className={`histogram-training-hover-row${emphasis ? ' is-emphasis' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function HistogramTrainingHoverCard({ hover }) {
  if (!hover?.training) {
    return null;
  }

  const training = hover.training;
  const course = training.title || 'Untitled training';
  const operative = employeeDisplayName(training.employee)
    || [training.employee?.first_name, training.employee?.last_name].filter(Boolean).join(' ')
    || training.employee?.name
    || hover.operativeName
    || '—';
  const start = formatDisplayDate(training.start_date) || training.start_date;
  const end = formatDisplayDate(training.end_date) || training.end_date;
  const when = start && end && start !== end
    ? `${start} → ${end}`
    : (start || end || '—');
  const priority = trainingPriorityLabel(training.priority);
  const urgency = trainingUrgencyLabel(training.urgency);
  const priorityUrgency = [priority, urgency].filter(Boolean).join(' · ') || '—';
  const duration = formatTrainingTotalHours(training) || '—';
  const status = trainingStatusLabel(training.status) || training.status || '—';
  const description = String(training.description || '').trim();
  const courseLink = String(training.course_link || '').trim();

  return createPortal(
    <div
      className="histogram-training-hover-card histogram-training-course-summary"
      style={{ left: hover.x + 14, top: hover.y + 14 }}
      role="tooltip"
    >
      <div className="histogram-training-hover-title">{course}</div>
      <HoverRow label="Operative" value={operative} />
      <HoverRow label="Date" value={when} />
      <HoverRow label="Priority / Urgency" value={priorityUrgency} emphasis />
      <HoverRow label="Duration" value={duration} />
      <HoverRow label="Status" value={status} />
      {description ? (
        <div className="histogram-training-hover-description">
          <span>Description</span>
          <p>{description}</p>
        </div>
      ) : (
        <HoverRow label="Description" value="—" />
      )}
      {/* Text only: the card closes when the pointer leaves the bar, so a button here
          could never be clicked. The click panel opens the link. */}
      <HoverRow label="Course link" value={courseLinkLabel(courseLink) || '—'} />
      <div className="histogram-training-hover-hint">Click for full details</div>
    </div>,
    document.body,
  );
}
