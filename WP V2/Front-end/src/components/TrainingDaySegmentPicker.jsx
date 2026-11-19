import {
  TRAINING_DAY_SEGMENT_OPTIONS,
  normalizeTrainingDaySegment,
} from '../utils/trainingForm';

export default function TrainingDaySegmentPicker({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  occupiedSegments = null,
  className = '',
  'aria-label': ariaLabel = 'Section of the workday',
}) {
  const selected = normalizeTrainingDaySegment(value, 0);
  const occupied = occupiedSegments instanceof Set
    ? occupiedSegments
    : new Set(Array.isArray(occupiedSegments) ? occupiedSegments : []);

  if (readOnly) {
    const option = TRAINING_DAY_SEGMENT_OPTIONS.find((item) => item.value === selected);
    return (
      <span
        className={`training-day-segment-readonly${className ? ` ${className}` : ''}${disabled ? ' is-locked' : ''}`}
        title={option?.title || 'Not editable'}
      >
        {option?.label ?? `Section ${selected + 1}`}
      </span>
    );
  }

  return (
    <div
      className={`training-day-segment-picker${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={ariaLabel}
    >
      {TRAINING_DAY_SEGMENT_OPTIONS.map((option, index) => {
        const isSelected = selected === option.value;
        const isOccupied = occupied.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={[
              'training-day-segment-picker-part',
              isSelected ? 'is-selected' : '',
              isOccupied ? 'is-occupied' : '',
            ].filter(Boolean).join(' ')}
            aria-pressed={isSelected}
            aria-label={isOccupied ? `${option.title} (already taken)` : option.title}
            title={isOccupied ? `${option.title} — already taken (confirm override on save)` : option.title}
            disabled={disabled}
            onClick={() => onChange?.(option.value)}
          >
            <span className="training-day-segment-picker-index">{index + 1}</span>
          </button>
        );
      })}
    </div>
  );
}
