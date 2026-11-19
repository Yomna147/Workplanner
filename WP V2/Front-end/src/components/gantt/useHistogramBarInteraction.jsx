import { useCallback, useEffect, useRef, useState } from 'react';
import HistogramBarDragTooltip from './HistogramBarDragTooltip';
import HistogramBarDragGhost from './HistogramBarDragGhost';
import {
  getTimelineDayIndexFromPointer,
  getTimelineQuarterSnapFromPointer,
  resolveHoveredDayFromBarPointer,
  timelineDayColumns,
} from './ganttUtils';
import {
  barsHaveSameAssignment,
  barsHaveSameSchedule,
  buildBarEditTooltip,
  captureHistogramRowRects,
  clampSnapDayToTimeline,
  describeBarChange,
  evaluateBarDrag,
  evaluateResizeWithPush,
  findHistogramRowNameFromPoint,
  resolveBarCenterWorkday,
  resolveHistogramTimelineRowElement,
} from './histogramBarEdits';

const POINTER_ACTIVATE_PX = 1;
const DROP_TARGET_CLASSES = [
  'is-drop-target',
  'is-drop-target-blocked',
];

function clearDropTargetClasses(root = document) {
  root.querySelectorAll?.(
    '.resource-histogram-resource-block.is-drop-target, .resource-histogram-resource-block.is-drop-target-blocked, .resource-gantt-timeline-row.is-drop-target, .resource-gantt-timeline-row.is-drop-target-blocked',
  ).forEach((element) => {
    DROP_TARGET_CLASSES.forEach((className) => element.classList.remove(className));
  });
}

/** Stable signature so we skip React updates when the snap preview did not change. */
function previewMapFingerprint(previewByBarId = {}) {
  return Object.keys(previewByBarId)
    .sort()
    .map((id) => {
      const bar = previewByBarId[id];
      if (!bar) {
        return `${id}:`;
      }
      const days = Object.keys(bar.hours_by_day || {}).sort();
      const hours = days.map((day) => `${day}:${Number(bar.hours_by_day[day]) || 0}`).join(',');
      return `${id}:${bar.start}|${bar.end}|${hours}|${bar._resizeEdge || ''}`;
    })
    .join(';');
}

export function useHistogramBarInteraction({
  timeline,
  employeeHolidays = {},
  availabilityHours = {},
  employees = [],
  getRowByName,
  onCommit,
  onPreview,
  onBarClick,
  enabled = true,
}) {
  const [previewByBarId, setPreviewByBarId] = useState({});
  const [activeBarId, setActiveBarId] = useState(null);
  const [activeMode, setActiveMode] = useState(null);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(null);
  const [dropTargetRowName, setDropTargetRowName] = useState(null);
  const [dragPreview, setDragPreview] = useState(null);
  const [dragGhost, setDragGhost] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const previewFingerprintRef = useRef('');
  const interactionRef = useRef(null);
  const previewRef = useRef(null);
  const dragMetaRef = useRef(null);
  const dropHighlightRef = useRef({ rowName: null, blocked: false });
  const activePointerListenersRef = useRef(null);

  const publishPreviewMap = useCallback((nextMap, previewBarForEditor = null) => {
    const fingerprint = previewMapFingerprint(nextMap);
    if (fingerprint === previewFingerprintRef.current) {
      return false;
    }
    previewFingerprintRef.current = fingerprint;
    setPreviewByBarId(nextMap);
    onPreview?.(previewBarForEditor);
    return true;
  }, [onPreview]);

  const clearInteraction = useCallback(() => {
    interactionRef.current = null;
    previewRef.current = null;
    dragMetaRef.current = null;
    dropHighlightRef.current = { rowName: null, blocked: false };
    previewFingerprintRef.current = '';
    setPreviewByBarId({});
    setActiveBarId(null);
    setActiveMode(null);
    setActiveSegmentIndex(null);
    setDropTargetRowName(null);
    setDragPreview(null);
    setDragGhost(null);
    setTooltip(null);
    onPreview?.(null);
    document.body.classList.remove('histogram-bar-interacting', 'histogram-bar-dragging');
    clearDropTargetClasses();
  }, [onPreview]);

  useEffect(() => () => {
    const active = activePointerListenersRef.current;
    if (active) {
      if (active.rafId != null) {
        window.cancelAnimationFrame(active.rafId);
      }
      window.removeEventListener('pointermove', active.onPointerMove);
      window.removeEventListener('pointerup', active.finishInteraction);
      window.removeEventListener('pointercancel', active.finishInteraction);
      activePointerListenersRef.current = null;
    }
    document.body.classList.remove('histogram-bar-interacting', 'histogram-bar-dragging');
    clearDropTargetClasses();
  }, []);

  const updateDropTargetHighlight = useCallback((rowName, blocked = false) => {
    const previous = dropHighlightRef.current;
    if (previous.rowName === rowName && previous.blocked === blocked) {
      return;
    }

    if (previous.rowName) {
      const previousBlock = document.querySelector(
        `.resource-histogram-resource-block[data-histogram-row-name="${CSS.escape(previous.rowName)}"]`,
      );
      previousBlock?.classList.remove(...DROP_TARGET_CLASSES);
      previousBlock?.querySelector('.resource-gantt-timeline-row')
        ?.classList.remove(...DROP_TARGET_CLASSES);
    } else {
      clearDropTargetClasses();
    }

    dropHighlightRef.current = { rowName: rowName || null, blocked: Boolean(blocked) };

    if (!rowName) {
      return;
    }

    const className = blocked ? 'is-drop-target-blocked' : 'is-drop-target';
    const rowBlock = document.querySelector(
      `.resource-histogram-resource-block[data-histogram-row-name="${CSS.escape(rowName)}"]`,
    );
    rowBlock?.classList.add(className);
    rowBlock?.querySelector('.resource-gantt-timeline-row')?.classList.add(className);
  }, []);

  const buildDragResult = useCallback((state, clientX, clientY) => {
    if (!state?.initialBar) {
      return null;
    }

    const dayColumns = state.layoutContext.dayColumns ?? [];
    const targetRowName = findHistogramRowNameFromPoint(clientY, {
      rowRects: state.rowRects,
      alwaysSnapToNearest: true,
    }) || state.sourceRowName;
    const timelineRowEl = resolveHistogramTimelineRowElement(
      targetRowName,
      state.timelineRowEl,
    );
    const { dayIndex, filledQuarters } = getTimelineQuarterSnapFromPointer(
      timelineRowEl,
      clientX,
      timeline,
    );
    const snapDay = clampSnapDayToTimeline(dayColumns[dayIndex], state.layoutContext);
    if (!snapDay) {
      return null;
    }

    const targetRow = getRowByName?.(targetRowName);
    return evaluateBarDrag(
      state.initialBar,
      snapDay,
      state.layoutContext,
      {
        anchorSnapDay: state.anchorSnapDay,
        anchorFilledQuarters: state.anchorFilledQuarters,
        filledQuarters,
        anchorBarCenterDay: state.anchorBarCenterDay,
        sourceRowName: state.sourceRowName,
        targetRowName,
        targetRowBars: targetRow?.bars ?? [],
        sourceRowBars: state.layoutContext.sourceRowBars ?? state.layoutContext.rowBars ?? [],
        employees,
        segment: state.segment,
      },
    );
  }, [employees, getRowByName, timeline]);

  const buildResizeResult = useCallback((state, clientX) => {
    if (!state?.initialBar) {
      return null;
    }

    const dayColumns = state.layoutContext.dayColumns ?? [];
    const { dayIndex, filledQuarters } = getTimelineQuarterSnapFromPointer(
      state.timelineRowEl,
      clientX,
      timeline,
    );
    const snapDay = clampSnapDayToTimeline(dayColumns[dayIndex], state.layoutContext);
    if (!snapDay) {
      return null;
    }

    if (!state.pushCache) {
      state.pushCache = {};
    }

    return evaluateResizeWithPush(
      state.initialBar,
      state.mode,
      snapDay,
      state.layoutContext,
      state.segment,
      filledQuarters,
      state.pushCache,
    );
  }, [timeline]);

  const buildPreviewBar = useCallback((state, clientX, clientY) => {
    if (!state?.initialBar) {
      return null;
    }

    if (state.mode === 'drag') {
      return buildDragResult(state, clientX, clientY)?.previewBar ?? null;
    }

    return buildResizeResult(state, clientX)?.resizedBar ?? null;
  }, [buildDragResult, buildResizeResult]);

  const startInteraction = useCallback(({
    mode,
    bar,
    segment,
    segmentIndex,
    rowName,
    siblingBars = [],
    rowBars = [],
    sourceRowBars = rowBars,
    timelineRowEl,
    event,
  }) => {
    if (!enabled || !timeline || !bar || !timelineRowEl || !event) {
      return;
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const dayColumns = timelineDayColumns(timeline);
    const { dayIndex: anchorDayIndex, filledQuarters: anchorFilledQuarters } = getTimelineQuarterSnapFromPointer(
      timelineRowEl,
      event.clientX,
      timeline,
    );
    const anchorSnapDay = dayColumns[anchorDayIndex];
    const layoutContext = {
      rowName,
      employeeHolidays,
      availabilityHours,
      employees,
      dayColumns,
      siblingBars,
      rowBars,
      sourceRowBars,
    };
    const anchorGrabDay = segment
      ? resolveHoveredDayFromBarPointer(event, segment, dayColumns)
      : null;
    const anchorBarCenterDay = anchorGrabDay
      || resolveBarCenterWorkday(bar, layoutContext, segment);

    interactionRef.current = {
      mode,
      bar,
      initialBar: bar,
      segment,
      segmentIndex,
      layoutContext,
      timelineRowEl,
      sourceRowName: rowName,
      anchorSnapDay,
      anchorFilledQuarters,
      anchorBarCenterDay,
      pointerId,
      moved: false,
      anchorRect: event.currentTarget?.getBoundingClientRect?.() ?? null,
      rowRects: mode === 'drag' ? captureHistogramRowRects() : null,
    };

    setActiveBarId(bar.id);
    setActiveMode(mode);
    setActiveSegmentIndex(segmentIndex ?? null);

    document.body.classList.add('histogram-bar-interacting');
    if (mode === 'drag') {
      document.body.classList.add('histogram-bar-dragging');
    }

    let rafId = null;
    let latestMoveEvent = null;

    const updateFromPointer = (moveEvent) => {
      const state = interactionRef.current;
      if (!state) {
        return;
      }

      const initialBar = state.initialBar;

      if (state.mode === 'drag') {
        const dragResult = buildDragResult(state, moveEvent.clientX, moveEvent.clientY);
        if (!dragResult?.previewBar) {
          return;
        }

        const {
          previewBar,
          shiftedBar,
          commitBar,
          reassigning,
          blocked,
          blockReason,
          targetRowName,
        } = dragResult;

        const scheduleOrAssigneeChanged = !barsHaveSameAssignment(initialBar, previewBar);
        const dropStateChanged = reassigning || blocked
          || dragMetaRef.current?.targetRowName !== targetRowName
          || dragMetaRef.current?.blocked !== blocked;

        if (!scheduleOrAssigneeChanged && !dropStateChanged && !state.moved) {
          setTooltip({
            x: moveEvent.clientX,
            y: moveEvent.clientY,
            ...buildBarEditTooltip(previewBar, {
              reassigning,
              targetRowName,
              blocked,
              blockReason,
            }),
            reassigning,
            blocked,
          });
          return;
        }

        state.moved = true;
        previewRef.current = previewBar;
        dragMetaRef.current = {
          commitBar,
          reassigning,
          blocked,
          blockReason,
          targetRowName,
        };

        const livePreviewBar = blocked ? shiftedBar : previewBar;

        publishPreviewMap({ [bar.id]: livePreviewBar }, livePreviewBar);

        const anchorRect = state.anchorRect;
        const ghostWidth = anchorRect?.width
          ? Math.max(48, Math.min(220, anchorRect.width))
          : 120;
        setDragGhost({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          width: ghostWidth,
          label: previewBar.task_name || previewBar.project_name || 'Task',
          color: previewBar.color,
          reassigning,
          blocked,
        });

        setDropTargetRowName(reassigning ? targetRowName : null);
        updateDropTargetHighlight(reassigning ? targetRowName : null, blocked);
        setDragPreview({
          barId: bar.id,
          previewBar,
          sourceRowName: state.sourceRowName,
          targetRowName,
          reassigning,
          blocked,
          blockReason,
        });
        setTooltip({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          ...buildBarEditTooltip(previewBar, {
            reassigning,
            targetRowName,
            blocked,
            blockReason,
          }),
          reassigning,
          blocked,
        });
        return;
      }

      const resizeResult = buildResizeResult(state, moveEvent.clientX);
      const previewBar = resizeResult?.resizedBar ?? null;
      if (!previewBar) {
        return;
      }

      if (barsHaveSameSchedule(initialBar, previewBar)) {
        if (state.moved) {
          previewRef.current = initialBar;
          dragMetaRef.current = { pushedBars: [], previewByBarId: {} };
          publishPreviewMap({}, null);
          setTooltip({
            x: moveEvent.clientX,
            y: moveEvent.clientY,
            ...buildBarEditTooltip(initialBar),
          });
        }
        return;
      }

      state.moved = true;
      previewRef.current = previewBar;
      const nextPreviewMap = resizeResult?.previewByBarId ?? { [previewBar.id]: previewBar };
      dragMetaRef.current = {
        pushedBars: resizeResult?.pushedBars ?? [],
        previewByBarId: nextPreviewMap,
      };
      publishPreviewMap(nextPreviewMap, previewBar);
      setTooltip({
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        ...buildBarEditTooltip(previewBar),
      });
    };

    const finishInteraction = (upEvent) => {
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishInteraction);
      window.removeEventListener('pointercancel', finishInteraction);
      activePointerListenersRef.current = null;

      const state = interactionRef.current;
      const movedEnough = state?.moved
        || Math.abs(upEvent.clientX - startX) > POINTER_ACTIVATE_PX
        || Math.abs(upEvent.clientY - startY) > POINTER_ACTIVATE_PX;

      let previewBar = previewRef.current;
      let commitBar = dragMetaRef.current?.commitBar ?? previewBar;
      let blocked = Boolean(dragMetaRef.current?.blocked);
      let pushedBars = dragMetaRef.current?.pushedBars ?? [];

      if (state?.mode === 'drag' && movedEnough) {
        const dragResult = buildDragResult(state, upEvent.clientX, upEvent.clientY);
        if (dragResult) {
          previewBar = dragResult.previewBar;
          commitBar = dragResult.commitBar;
          blocked = dragResult.blocked;
        }
        pushedBars = [];
      } else if (state && movedEnough) {
        const resizeResult = buildResizeResult(state, upEvent.clientX);
        previewBar = resizeResult?.resizedBar ?? previewBar;
        commitBar = previewBar;
        pushedBars = resizeResult?.pushedBars ?? [];
      }

      const initialBar = state?.initialBar ?? state?.bar;
      const nextBar = state?.mode === 'drag' ? commitBar : previewBar;
      const changed = state?.mode === 'drag'
        ? Boolean(nextBar) && !barsHaveSameAssignment(initialBar, nextBar)
        : !barsHaveSameSchedule(initialBar, nextBar);

      if (state?.moved && nextBar && movedEnough && changed && !blocked) {
        onCommit?.({
          mode: state.mode,
          previousBar: initialBar,
          nextBar,
          pushedBars,
        });
      } else if (state?.mode === 'drag' && !state?.moved && !movedEnough) {
        onBarClick?.(initialBar, { anchorRect: state.anchorRect ?? null });
      }

      clearInteraction();
    };

    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      moveEvent.preventDefault();
      latestMoveEvent = moveEvent;
      if (rafId != null) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        if (latestMoveEvent) {
          updateFromPointer(latestMoveEvent);
        }
      });
    };

    event.preventDefault();
    event.stopPropagation();

    activePointerListenersRef.current = {
      onPointerMove,
      finishInteraction,
      get rafId() {
        return rafId;
      },
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishInteraction);
    window.addEventListener('pointercancel', finishInteraction);
  }, [
    buildDragResult,
    buildPreviewBar,
    buildResizeResult,
    clearInteraction,
    enabled,
    onBarClick,
    onCommit,
    publishPreviewMap,
    timeline,
    updateDropTargetHighlight,
    employeeHolidays,
    availabilityHours,
    employees,
  ]);

  const interactionOverlay = (
    <>
      <HistogramBarDragGhost ghost={dragGhost} />
      <HistogramBarDragTooltip
        tooltip={tooltip}
        reassigning={tooltip?.reassigning}
        blocked={tooltip?.blocked}
      />
    </>
  );

  return {
    previewByBarId,
    activeBarId,
    activeMode,
    activeSegmentIndex,
    dropTargetRowName,
    dragPreview,
    startInteraction,
    interactionOverlay,
  };
}

export { describeBarChange };
