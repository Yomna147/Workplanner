import { useCallback, useEffect, useRef, useState } from 'react';
import HistogramBarDragTooltip from './HistogramBarDragTooltip';
import { getTimelineDayIndexFromPointer, timelineDayColumns } from './ganttUtils';
import { findHistogramRowNameFromPoint } from './histogramBarEdits';
import {
  applyTrainingScheduleChange,
  formatTrainingScheduleTooltip,
  mergeTrainingSchedulePreview,
  trainingSchedulesEqual,
} from './trainingBarEdits';

const POINTER_ACTIVATE_PX = 3;
const AUTO_SCROLL_EDGE_PX = 56;
const AUTO_SCROLL_STEP_PX = 20;

function scrollTimelineTowardsPointer(clientX, timelineRowEl) {
  const scroller = timelineRowEl?.closest('.histogram-sync-scroll-main, .histogram-timeline-scroll');
  if (!scroller) {
    return;
  }

  const rect = scroller.getBoundingClientRect();
  if (clientX < rect.left + AUTO_SCROLL_EDGE_PX) {
    scroller.scrollLeft = Math.max(0, scroller.scrollLeft - AUTO_SCROLL_STEP_PX);
  } else if (clientX > rect.right - AUTO_SCROLL_EDGE_PX) {
    scroller.scrollLeft += AUTO_SCROLL_STEP_PX;
  }
}

function updateDropTargetHighlight(rowName) {
  document.querySelectorAll('.resource-histogram-resource-block.is-drop-target')
    .forEach((element) => element.classList.remove('is-drop-target'));

  if (!rowName) {
    return;
  }

  document.querySelector(
    `.resource-histogram-resource-block[data-histogram-row-name="${CSS.escape(rowName)}"]`,
  )?.classList.add('is-drop-target');
}

export function useTrainingBarInteraction({
  timeline,
  onCommit,
  onTrainingClick,
  getEmployeeIdByRowName,
  enabled = true,
}) {
  const [previewByTrainingId, setPreviewByTrainingId] = useState({});
  const [activeTrainingId, setActiveTrainingId] = useState(null);
  const [activeMode, setActiveMode] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const interactionRef = useRef(null);
  const previewRef = useRef(null);

  const clearInteraction = useCallback(() => {
    interactionRef.current = null;
    previewRef.current = null;
    setPreviewByTrainingId({});
    setActiveTrainingId(null);
    setActiveMode(null);
    setTooltip(null);
    document.body.classList.remove('histogram-bar-interacting', 'histogram-bar-dragging');
    updateDropTargetHighlight(null);
  }, []);

  useEffect(() => () => {
    document.body.classList.remove('histogram-bar-interacting', 'histogram-bar-dragging');
    updateDropTargetHighlight(null);
  }, []);

  const startInteraction = useCallback(({
    mode,
    training,
    event,
    timelineRowEl,
    rowName,
  }) => {
    if (!enabled || !timeline || !training || !timelineRowEl || !event) {
      return;
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const dayColumns = timelineDayColumns(timeline);
    const anchorDayIndex = getTimelineDayIndexFromPointer(
      timelineRowEl,
      event.clientX,
      timeline,
    );
    const anchorSnapDay = dayColumns[anchorDayIndex];
    const captureTarget = event.currentTarget;

    if (captureTarget?.setPointerCapture) {
      try {
        captureTarget.setPointerCapture(pointerId);
      } catch {
        // Ignore capture failures on unsupported targets.
      }
    }

    interactionRef.current = {
      mode,
      training,
      initialTraining: training,
      sourceRowName: rowName || null,
      dayColumns,
      timelineRowEl,
      pointerId,
      anchorSnapDay,
      captureTarget,
      moved: false,
    };

    setActiveTrainingId(training.id);
    setActiveMode(mode);
    document.body.classList.add('histogram-bar-interacting');
    if (mode === 'drag') {
      document.body.classList.add('histogram-bar-dragging');
    }

    const updateFromPointer = (moveEvent) => {
      const state = interactionRef.current;
      if (!state) {
        return;
      }

      scrollTimelineTowardsPointer(moveEvent.clientX, state.timelineRowEl);

      const dayIndex = getTimelineDayIndexFromPointer(
        state.timelineRowEl,
        moveEvent.clientX,
        timeline,
      );
      const snapDay = state.dayColumns[dayIndex];
      if (!snapDay) {
        return;
      }

      const previewTraining = mergeTrainingSchedulePreview(
        state.initialTraining,
        applyTrainingScheduleChange(state.initialTraining, state.mode, snapDay, {
          anchorSnapDay: state.anchorSnapDay,
          dayColumns: state.dayColumns,
        }),
      );

      if (!previewTraining || trainingSchedulesEqual(state.initialTraining, previewTraining)) {
        previewRef.current = null;
        setPreviewByTrainingId({});
        setTooltip(null);
        if (state.mode === 'drag') {
          updateDropTargetHighlight(null);
        }
        return;
      }

      state.moved = true;
      previewRef.current = previewTraining;
      setPreviewByTrainingId({ [String(state.training.id)]: previewTraining });
      setActiveTrainingId(state.training.id);
      setActiveMode(state.mode);

      if (state.mode === 'drag') {
        const targetRowName = findHistogramRowNameFromPoint(moveEvent.clientY) || state.sourceRowName;
        const reassigning = Boolean(
          targetRowName
          && state.sourceRowName
          && targetRowName !== state.sourceRowName,
        );
        updateDropTargetHighlight(reassigning ? targetRowName : null);
        if (reassigning) {
          state.moved = true;
        }
      }

      setTooltip({
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        text: formatTrainingScheduleTooltip(previewTraining),
      });
    };

    const finishInteraction = (upEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishInteraction);
      window.removeEventListener('pointercancel', finishInteraction);

      const state = interactionRef.current;
      if (state?.captureTarget?.releasePointerCapture) {
        try {
          if (state.captureTarget.hasPointerCapture?.(pointerId)) {
            state.captureTarget.releasePointerCapture(pointerId);
          }
        } catch {
          // Ignore release failures.
        }
      }

      const movedEnough = state?.moved
        || Math.abs(upEvent.clientX - startX) > POINTER_ACTIVATE_PX
        || Math.abs(upEvent.clientY - startY) > POINTER_ACTIVATE_PX;

      let previewTraining = previewRef.current;
      if (state && movedEnough) {
        const dayIndex = getTimelineDayIndexFromPointer(
          state.timelineRowEl,
          upEvent.clientX,
          timeline,
        );
        const snapDay = state.dayColumns[dayIndex];
        if (snapDay) {
          previewTraining = mergeTrainingSchedulePreview(
            state.initialTraining,
            applyTrainingScheduleChange(state.initialTraining, state.mode, snapDay, {
              anchorSnapDay: state.anchorSnapDay,
              dayColumns: state.dayColumns,
            }),
          );
        }
      }

      const initialTraining = state?.initialTraining ?? state?.training;
      const scheduleChanged = previewTraining
        && !trainingSchedulesEqual(initialTraining, previewTraining);
      const targetRowName = state?.mode === 'drag'
        ? (findHistogramRowNameFromPoint(upEvent.clientY) || state?.sourceRowName)
        : state?.sourceRowName;
      const targetEmployeeId = targetRowName
        ? getEmployeeIdByRowName?.(targetRowName)
        : null;
      const reassigning = Boolean(
        targetEmployeeId
        && Number(targetEmployeeId) !== Number(initialTraining?.employee_id),
      );

      if (
        state
        && movedEnough
        && (scheduleChanged || reassigning)
      ) {
        onCommit?.({
          mode: state.mode,
          training: initialTraining,
          start_date: previewTraining?.start_date ?? initialTraining?.start_date,
          end_date: previewTraining?.end_date ?? initialTraining?.end_date,
          employee_id: reassigning ? targetEmployeeId : undefined,
          target_row_name: targetRowName,
        });
      } else if (state?.mode === 'drag' && !state?.moved && !movedEnough) {
        onTrainingClick?.(initialTraining);
      }

      clearInteraction();
    };

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      moveEvent.preventDefault();
      updateFromPointer(moveEvent);
    };

    event.preventDefault();
    event.stopPropagation();

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishInteraction);
    window.addEventListener('pointercancel', finishInteraction);
  }, [clearInteraction, enabled, getEmployeeIdByRowName, onCommit, onTrainingClick, timeline]);

  const interactionOverlay = <HistogramBarDragTooltip tooltip={tooltip} />;

  return {
    previewByTrainingId,
    activeTrainingId,
    activeMode,
    startInteraction,
    interactionOverlay,
  };
}
