import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { trainingBarDisplayLabel, trainingBarLabelText } from './trainingBarEdits';
import { resolveTrainingProgressOverlayWidthPx } from '../../utils/trainingForm';
import HistogramTrainingHoverCard from './HistogramTrainingHoverCard';

function TrainingGapBar({
  segment,
  editable = false,
  extendMode = false,
  isResizing = false,
  isFocused = false,
  isMuted = false,
  suppressHover = false,
  rowName,
  onInteractionStart,
  onTrainingClick,
}) {
  const { training, left, width, label, legendNumber, legendColor } = segment;
  const canExtend = editable && extendMode;
  const [hover, setHover] = useState(null);

  // Hide the card while any bar is being dragged/resized so it doesn't trail the pointer.
  useEffect(() => {
    if (suppressHover) {
      setHover(null);
    }
  }, [suppressHover]);

  const updateHover = useCallback((event) => {
    if (suppressHover) {
      return;
    }
    setHover({
      training,
      operativeName: rowName,
      x: event.clientX,
      y: event.clientY,
    });
  }, [rowName, suppressHover, training]);

  const clearHover = useCallback(() => setHover(null), []);

  const handleBarPointerDown = useCallback((event) => {
    if (!canExtend || event.target.closest('.histogram-bar-handle')) {
      return;
    }
    setHover(null);

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const timelineRowEl = event.currentTarget.closest('.resource-gantt-timeline-row');
    if (!timelineRowEl || !onInteractionStart) {
      return;
    }

    onInteractionStart({
      mode: 'drag',
      training,
      event,
      timelineRowEl,
    });
  }, [canExtend, onInteractionStart, training]);

  const handleBarClick = useCallback((event) => {
    if (canExtend) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setHover(null);
    onTrainingClick?.(training);
  }, [canExtend, onTrainingClick, training]);

  const handleResizePointerDown = useCallback((mode) => (event) => {
    if (!canExtend || !onInteractionStart) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setHover(null);

    const timelineRowEl = event.currentTarget.closest('.resource-gantt-timeline-row');
    if (!timelineRowEl) {
      return;
    }

    onInteractionStart({
      mode,
      training,
      event,
      timelineRowEl,
    });
  }, [canExtend, onInteractionStart, training]);

  const progressOverlayWidthPx = useMemo(
    () => resolveTrainingProgressOverlayWidthPx(training, width),
    [training, width],
  );

  return (
    <>
    <div
      role="button"
      tabIndex={0}
      className={[
        'trainings-gap-training-bar',
        'resource-gantt-bar',
        segment.isPartialDay ? 'is-partial-day' : '',
        editable ? 'is-editable' : '',
        canExtend ? 'is-extend-mode' : '',
        isResizing ? 'is-resizing' : '',
        isFocused ? 'is-session-focused' : '',
        isMuted ? 'is-session-muted' : '',
      ].filter(Boolean).join(' ')}
      style={{
        left,
        width,
        backgroundColor: legendColor,
        ...(segment.labelMaxWidth
          ? { '--training-label-max-width': `${segment.labelMaxWidth}px` }
          : {}),
      }}
      aria-label={
        canExtend
          ? `${legendNumber ? `${legendNumber}. ` : ''}${label} — drag to move, edges to resize`
          : `${legendNumber ? `${legendNumber}. ` : ''}${label} — click to open`
      }
      onMouseEnter={updateHover}
      onMouseMove={updateHover}
      onMouseLeave={clearHover}
      onPointerDown={handleBarPointerDown}
      onClick={handleBarClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          handleBarClick(event);
        }
      }}
    >
      {progressOverlayWidthPx > 0 ? (
        <span
          className="resource-gantt-bar-progress"
          style={{ width: `${progressOverlayWidthPx}px` }}
          aria-hidden="true"
        />
      ) : null}
      {canExtend ? (
        <>
          <span
            className="histogram-bar-handle histogram-bar-handle-left"
            aria-hidden="true"
            onPointerDown={handleResizePointerDown('resize-start')}
          />
          <span
            className="histogram-bar-handle histogram-bar-handle-right"
            aria-hidden="true"
            onPointerDown={handleResizePointerDown('resize-end')}
          />
        </>
      ) : null}
      {legendNumber ? (
        <span className="trainings-gap-training-bar-index">{legendNumber}</span>
      ) : null}
      <span className="trainings-gap-training-bar-label">
        {segment.isPartialDay
          ? trainingBarLabelText(label)
          : trainingBarDisplayLabel(label, width, segment.labelMaxWidth)}
      </span>
    </div>
    <HistogramTrainingHoverCard hover={hover} />
    </>
  );
}

export default memo(TrainingGapBar);
