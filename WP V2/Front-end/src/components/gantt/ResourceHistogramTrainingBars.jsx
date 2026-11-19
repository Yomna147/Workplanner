import { memo, useMemo, useState } from 'react';
import {
  buildTrainingBarSegments,
  formatTrainingScheduleTooltip,
  trainingBarDisplayLabel,
  trainingBarLabelText,
} from './trainingBarEdits';
import { timelineDayColumns } from './ganttUtils';
import HistogramTrainingHoverCard from './HistogramTrainingHoverCard';
import { resolveTrainingProgressOverlayWidthPx } from '../../utils/trainingForm';

function ResourceHistogramTrainingBars({
  trainings = [],
  timeline,
  rowName,
  rowBars = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
  onTrainingClick,
}) {
  const dayColumns = timelineDayColumns(timeline);
  const [hover, setHover] = useState(null);

  const segments = useMemo(
    () => buildTrainingBarSegments(trainings, timeline, dayColumns, {
      // Show the full scheduled span on Resource Histogram (not gap-clipped).
      clipToFreeTime: false,
      rowName,
      rowBars,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    }),
    [
      trainings,
      timeline,
      dayColumns,
      rowName,
      rowBars,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    ],
  );

  if (segments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="resource-histogram-training-bars" aria-hidden="false">
        {segments.map((segment) => {
          const progressOverlayWidthPx = resolveTrainingProgressOverlayWidthPx(
            segment.training,
            segment.width,
          );

          return (
          <button
            key={`${segment.training.id}-${segment.dayIndex ?? segment.left}`}
            type="button"
            className={`resource-histogram-training-bar${segment.isPartialDay ? ' is-partial-day' : ''}${segment.training?.confirm_override ? ' is-override' : ''}`}
            style={{
              left: segment.left,
              width: segment.width,
              ...(segment.labelMaxWidth
                ? { '--training-label-max-width': `${segment.labelMaxWidth}px` }
                : {}),
            }}
            aria-label={`${segment.training.title || 'Training'}: ${formatTrainingScheduleTooltip(segment.training)}`}
            onMouseEnter={(event) => {
              setHover({
                training: segment.training,
                operativeName: rowName,
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onMouseMove={(event) => {
              setHover((prev) => (
                prev
                  ? { ...prev, x: event.clientX, y: event.clientY, operativeName: rowName }
                  : {
                    training: segment.training,
                    operativeName: rowName,
                    x: event.clientX,
                    y: event.clientY,
                  }
              ));
            }}
            onMouseLeave={() => setHover(null)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setHover(null);
              onTrainingClick?.(segment.training);
            }}
          >
            {progressOverlayWidthPx > 0 ? (
              <span
                className="resource-gantt-bar-progress"
                style={{ width: `${progressOverlayWidthPx}px` }}
                aria-hidden="true"
              />
            ) : null}
            <span
              className="resource-histogram-training-bar-label"
              title={segment.label}
            >
              {segment.isPartialDay
                ? trainingBarLabelText(segment.label)
                : trainingBarDisplayLabel(segment.label, segment.width, segment.labelMaxWidth)}
            </span>
          </button>
          );
        })}
      </div>
      <HistogramTrainingHoverCard hover={hover} />
    </>
  );
}

export default memo(ResourceHistogramTrainingBars);
