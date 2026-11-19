const VIEWPORT_MARGIN = 8;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function unionClientRects(rects = []) {
  const list = rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);
  if (!list.length) {
    return null;
  }

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  list.forEach((rect) => {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  });

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function rectsOverlap(leftRect, rightRect, padding = 8) {
  if (!leftRect || !rightRect) {
    return false;
  }

  return !(
    leftRect.right + padding < rightRect.left
    || leftRect.left - padding > rightRect.right
    || leftRect.bottom + padding < rightRect.top
    || leftRect.top - padding > rightRect.bottom
  );
}

function findHighlightedTaskBarRects(taskId, rootSelector = '.resource-histogram-chart-wrap') {
  const taskKey = String(taskId ?? '').trim();
  if (!taskKey) {
    return null;
  }

  const root = rootSelector ? document.querySelector(rootSelector) : document;
  const escaped = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(taskKey)
    : taskKey.replace(/"/g, '\\"');
  const bars = root?.querySelectorAll(
    `.resource-gantt-bar.is-editor-highlighted[data-task-id="${escaped}"]`,
  ) ?? [];

  return unionClientRects([...bars].map((bar) => bar.getBoundingClientRect()));
}

/**
 * Move or shrink the floating task editor so a histogram bar stays visible.
 */
export function repositionTaskEditorPanel({
  panelElement,
  targetRect,
  position,
  size,
  setPosition,
  setSize,
  overlayTop = 0,
  minWidth = 520,
  minHeight = 280,
} = {}) {
  if (!panelElement || !targetRect || !setPosition || !setSize) {
    return false;
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = Math.max(minHeight, window.innerHeight);
  const panelRect = panelElement.getBoundingClientRect();

  if (!rectsOverlap(panelRect, targetRect, 10)) {
    return false;
  }

  const tryPosition = (nextX, nextY, nextWidth = size.width, nextHeight = size.height) => {
    const clampedX = clamp(
      nextX,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, viewportWidth - nextWidth - VIEWPORT_MARGIN),
    );
    const clampedY = clamp(
      nextY,
      overlayTop + VIEWPORT_MARGIN,
      Math.max(overlayTop + VIEWPORT_MARGIN, viewportHeight - nextHeight - VIEWPORT_MARGIN),
    );
    const candidate = {
      left: clampedX,
      top: clampedY,
      right: clampedX + nextWidth,
      bottom: clampedY + nextHeight,
      width: nextWidth,
      height: nextHeight,
    };

    if (!rectsOverlap(candidate, targetRect, 10)) {
      setSize({ width: nextWidth, height: nextHeight });
      setPosition({
        x: clampedX,
        y: clampedY - overlayTop,
      });
      return true;
    }

    return false;
  };

  const targetCenterX = targetRect.left + (targetRect.width / 2);
  const targetCenterY = targetRect.top + (targetRect.height / 2);
  const panelCenterX = panelRect.left + (panelRect.width / 2);
  const panelCenterY = panelRect.top + (panelRect.height / 2);

  const candidates = [
    { x: targetRect.right + VIEWPORT_MARGIN, y: panelRect.top },
    { x: targetRect.left - size.width - VIEWPORT_MARGIN, y: panelRect.top },
    { x: panelRect.left, y: targetRect.bottom + VIEWPORT_MARGIN },
    { x: panelRect.left, y: targetRect.top - size.height - VIEWPORT_MARGIN },
    { x: viewportWidth - size.width - VIEWPORT_MARGIN, y: overlayTop + VIEWPORT_MARGIN },
    { x: VIEWPORT_MARGIN, y: overlayTop + VIEWPORT_MARGIN },
    { x: viewportWidth - size.width - VIEWPORT_MARGIN, y: viewportHeight - size.height - VIEWPORT_MARGIN },
    { x: VIEWPORT_MARGIN, y: viewportHeight - size.height - VIEWPORT_MARGIN },
  ];

  if (targetCenterX < panelCenterX) {
    candidates.unshift({ x: VIEWPORT_MARGIN, y: panelRect.top });
  } else {
    candidates.unshift({ x: viewportWidth - size.width - VIEWPORT_MARGIN, y: panelRect.top });
  }

  if (targetCenterY < panelCenterY) {
    candidates.unshift({ x: panelRect.left, y: viewportHeight - size.height - VIEWPORT_MARGIN });
  } else {
    candidates.unshift({ x: panelRect.left, y: overlayTop + VIEWPORT_MARGIN });
  }

  for (const candidate of candidates) {
    if (tryPosition(candidate.x, candidate.y)) {
      return true;
    }
  }

  const shrinkSteps = [0.85, 0.72, 0.6];
  for (const scale of shrinkSteps) {
    const nextWidth = Math.max(minWidth, Math.round(size.width * scale));
    const nextHeight = Math.max(minHeight, Math.round(size.height * scale));
    const nextX = targetCenterX < viewportWidth / 2
      ? viewportWidth - nextWidth - VIEWPORT_MARGIN
      : VIEWPORT_MARGIN;
    const nextY = overlayTop + VIEWPORT_MARGIN;
    if (tryPosition(nextX, nextY, nextWidth, nextHeight)) {
      return true;
    }
  }

  return tryPosition(
    viewportWidth - minWidth - VIEWPORT_MARGIN,
    overlayTop + VIEWPORT_MARGIN,
    minWidth,
    minHeight,
  );
}

export function revealTaskEditorSelection({
  taskId,
  panelElement,
  position,
  size,
  setPosition,
  setSize,
  overlayTop = 0,
  minWidth = 520,
  minHeight = 280,
  rootSelector = '.resource-histogram-chart-wrap',
} = {}) {
  const targetRect = findHighlightedTaskBarRects(taskId, rootSelector);
  if (!targetRect) {
    return false;
  }

  return repositionTaskEditorPanel({
    panelElement,
    targetRect,
    position,
    size,
    setPosition,
    setSize,
    overlayTop,
    minWidth,
    minHeight,
  });
}
