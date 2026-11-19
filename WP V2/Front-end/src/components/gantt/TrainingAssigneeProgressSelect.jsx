import { TRAINING_PROGRESS_OPTIONS } from '../../utils/trainingForm';

function resolveTrainingStatusValue(status) {
  const value = String(status || '').trim();
  return TRAINING_PROGRESS_OPTIONS.some((option) => option.value === value)
    ? value
    : 'not_started';
}

export default function TrainingAssigneeProgressSelect({
  assignment,
  status,
  disabled = false,
  saving = false,
  onStatusChange = null,
  compact = true,
}) {
  const statusValue = resolveTrainingStatusValue(status);

  return (
    <label className="trainings-gap-detail-progress-select">
      <span className="trainings-gap-detail-progress-select-label">Progress</span>
      <select
        className="trainings-gap-detail-progress-select-control"
        value={statusValue}
        disabled={disabled || saving || !onStatusChange}
        onChange={(event) => onStatusChange?.(assignment, event.target.value)}
        aria-label="Training progress"
      >
        {TRAINING_PROGRESS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {compact ? option.compactLabel : option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
