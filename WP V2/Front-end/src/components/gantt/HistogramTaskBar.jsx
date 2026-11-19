import { memo, useCallback, useEffect, useState } from 'react';
import {
  resolveBarCompletionBorderState,
  resolveHoveredDayFromBarPointer,
  resolveBarSegmentLabel,
  resolveBarSegmentProgressOverlayWidthPx,
  timelineDayColumns,
} from './ganttUtils';
import { isHistogramBarEditable } from './histogramBarEdits';
import {
  HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX,
  HISTOGRAM_DAY_PARTITIONS,
} from './histogramLayout';
import HistogramTaskHoverCard, { buildTaskBarHover } from './HistogramTaskHoverCard';
import { contrastTextForBackground } from '../../utils/colorContrast';

const POINTER_ACTIVATE_PX = 3;

function HistogramTaskBar({
  bar,
  segment,
  segmentIndex,
  timeline,
  onBarClick,
  editable = false,
  isFirstSegment = false,
  isLastSegment = false,
  isResizing = false,
  isDragging = false,
  isDropBlocked = false,
  suppressHover = false,
  className = '',
  onInteractionStart,
  progressOverlayWidthPx = null,
  dlPlanEdit = null,
  todayYmd = null,
}) {
  const [hover, setHover] = useState(null);
  const barWidth = segment.width;
  const isSoloPartialBand = (segment.taskCount ?? 1) === 1
    && (segment.numSeg ?? HISTOGRAM_DAY_PARTITIONS) < HISTOGRAM_DAY_PARTITIONS;
  const segmentLabel = resolveBarSegmentLabel(bar, barWidth, 9, {
    allowLabelExpansion: !isSoloPartialBand,
  });
  const displayWidth = isSoloPartialBand
    ? barWidth
    : segmentLabel.vertical
      ? Math.max(barWidth, segmentLabel.minWidth ?? HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX)
      : Math.max(barWidth, segmentLabel.minWidth ?? barWidth);
  const completionBorderState = resolveBarCompletionBorderState(bar, todayYmd);
  const resolvedProgressOverlayWidthPx = progressOverlayWidthPx ?? (
    resolveBarSegmentProgressOverlayWidthPx(bar, barWidth, 0, barWidth)
  );
  const scheduledWidth = Math.max(barWidth, 1);
  const visualProgressOverlayWidthPx = resolvedProgressOverlayWidthPx > 0
    ? Math.min(displayWidth, resolvedProgressOverlayWidthPx * (displayWidth / scheduledWidth))
    : 0;
  const canEdit = editable && isHistogramBarEditable(bar);
  const barColor = bar.color || '#3b82f6';
  const labelColor = contrastTextForBackground(barColor);
  const showLeftHandle = canEdit && isFirstSegment;
  const showRightHandle = canEdit && isLastSegment;
  const hoverBlocked = suppressHover || isResizing || isDragging;
  const showHoverCard = Boolean(hover) && !hoverBlocked;

  const dayColumns = timelineDayColumns(timeline);

  useEffect(() => {
    if (hoverBlocked) {
      setHover(null);
    }
  }, [hoverBlocked]);

  const updateHover = useCallback((event) => {
    if (hoverBlocked) {
      setHover(null);
      return;
    }

    const hoveredDay = resolveHoveredDayFromBarPointer(event, segment, dayColumns);
    setHover({
      x: event.clientX,
      y: event.clientY,
      ...buildTaskBarHover(bar, hoveredDay, dlPlanEdit),
    });
  }, [bar, dayColumns, dlPlanEdit, hoverBlocked, segment]);

  const clearHover = useCallback(() => {
    setHover(null);
  }, []);

  const handleBarPointerDown = useCallback((event) => {
    if (event.target.closest('.histogram-bar-handle')) {
      return;
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    setHover(null);

    if (canEdit && onInteractionStart) {
      const timelineRowEl = event.currentTarget.closest('.resource-gantt-timeline-row');
      if (!timelineRowEl) {
        return;
      }

      onInteractionStart({
        mode: 'drag',
        bar,
        segment,
        segmentIndex,
        event,
        timelineRowEl,
      });
      return;
    }

    if (!onBarClick) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const barEl = event.currentTarget;
    const finishClick = (upEvent) => {
      window.removeEventListener('pointerup', finishClick);
      window.removeEventListener('pointercancel', finishClick);
      if (
        Math.abs(upEvent.clientX - startX) <= POINTER_ACTIVATE_PX
        && Math.abs(upEvent.clientY - startY) <= POINTER_ACTIVATE_PX
      ) {
        onBarClick(bar, { anchorRect: barEl.getBoundingClientRect() });
      }
    };
    window.addEventListener('pointerup', finishClick);
    window.addEventListener('pointercancel', finishClick);
  }, [bar, canEdit, onBarClick, onInteractionStart, segment, segmentIndex]);

  const handleResizePointerDown = useCallback((mode) => (event) => {
    if (!onInteractionStart) {
      return;
    }

    const timelineRowEl = event.currentTarget.closest('.resource-gantt-timeline-row');
    if (!timelineRowEl) {
      return;
    }

    setHover(null);

    onInteractionStart({
      mode,
      bar,
      segment,
      segmentIndex,
      event,
      timelineRowEl,
    });
  }, [bar, onInteractionStart, segment, segmentIndex]);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-task-id={bar.task_id ?? bar.id ?? ''}
        className={[
          'resource-gantt-bar',
          bar.done ? 'done' : '',
          segmentIndex > 0 ? 'resource-gantt-bar-continued' : '',
          ((segment.taskCount ?? 0) > 1 || (segment.numSeg ?? HISTOGRAM_DAY_PARTITIONS) < HISTOGRAM_DAY_PARTITIONS) ? 'is-day-split' : '',
          segmentLabel.compact ? 'is-compact-label' : '',
          segmentLabel.vertical ? 'is-vertical-label' : '',
          completionBorderState === 'approaching' ? 'is-completion-approaching' : '',
          completionBorderState === 'overdue' ? 'is-completion-overdue' : '',
          canEdit ? 'is-editable' : '',
          isResizing ? 'is-resizing' : '',
          isDragging ? 'is-dragging' : '',
          isDropBlocked ? 'is-drop-blocked' : '',
          className,
        ].filter(Boolean).join(' ')}
        style={{
          '--bar-color': barColor,
          '--bar-label-color': labelColor,
          color: labelColor,
          left: segment.left,
          width: displayWidth,
          minWidth: segmentLabel.minWidth ?? HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX,
        }}
        onMouseEnter={hoverBlocked ? undefined : updateHover}
        onMouseMove={hoverBlocked ? undefined : updateHover}
        onMouseLeave={clearHover}
        onPointerDown={handleBarPointerDown}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onBarClick?.(bar, { anchorRect: event.currentTarget.getBoundingClientRect() });
          }
        }}
      >
        {visualProgressOverlayWidthPx > 0 ? (
          <span
            className="resource-gantt-bar-progress"
            style={{ width: `${visualProgressOverlayWidthPx}px` }}
            aria-hidden="true"
          />
        ) : null}
        {completionBorderState ? (
          <span
            className={`resource-gantt-bar-status-ring resource-gantt-bar-status-ring--${completionBorderState}`}
            aria-hidden="true"
          />
        ) : null}
        {showLeftHandle && (
          <span
            className="histogram-bar-handle histogram-bar-handle-left"
            aria-hidden="true"
            onPointerDown={handleResizePointerDown('resize-start')}
          />
        )}
        {showRightHandle && (
          <span
            className="histogram-bar-handle histogram-bar-handle-right"
            aria-hidden="true"
            onPointerDown={handleResizePointerDown('resize-end')}
          />
        )}
        {segment.showLabel && (
          <span className="resource-gantt-bar-label">
            {segmentLabel.text}
          </span>
        )}
      </div>
      {showHoverCard ? <HistogramTaskHoverCard hover={hover} /> : null}
    </>
  );
}

export default memo(HistogramTaskBar);
