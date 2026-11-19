import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_MIN_WIDTH = 480;
const DEFAULT_MIN_HEIGHT = 260;
const VIEWPORT_MARGIN = 8;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readViewportBounds(topInset = 0) {
  if (typeof window === 'undefined') {
    return { maxWidth: 1200, maxHeight: 800 };
  }
  const contentHeight = Math.max(DEFAULT_MIN_HEIGHT, window.innerHeight - topInset);
  return {
    maxWidth: Math.max(DEFAULT_MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2),
    maxHeight: Math.max(DEFAULT_MIN_HEIGHT, contentHeight - VIEWPORT_MARGIN * 2),
  };
}

/**
 * Pointer-driven resize for floating panels.
 * Resizing from left/top edges also adjusts position so the opposite edge stays put.
 */
export function useResizablePanel({
  position,
  setPosition,
  initialWidth = 864,
  initialHeight = 420,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  storageKey = null,
  topInset = 0,
} = {}) {
  const [size, setSize] = useState(() => {
    if (storageKey && typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.width && parsed?.height) {
            const bounds = readViewportBounds(topInset);
            return {
              width: clamp(Number(parsed.width), minWidth, bounds.maxWidth),
              height: clamp(Number(parsed.height), minHeight, bounds.maxHeight),
            };
          }
        }
      } catch {
        // ignore
      }
    }
    const bounds = readViewportBounds(topInset);
    return {
      width: clamp(initialWidth, minWidth, bounds.maxWidth),
      height: clamp(initialHeight, minHeight, bounds.maxHeight),
    };
  });
  const resizeRef = useRef(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') {
      return undefined;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(size));
    } catch {
      // ignore
    }
    return undefined;
  }, [size, storageKey]);

  useEffect(() => {
    const onWindowResize = () => {
      const bounds = readViewportBounds(topInset);
      const contentHeight = Math.max(minHeight, window.innerHeight - topInset);
      setSize((current) => ({
        width: clamp(current.width, minWidth, bounds.maxWidth),
        height: clamp(current.height, minHeight, bounds.maxHeight),
      }));
      setPosition?.((current) => ({
        x: clamp(current.x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - sizeRef.current.width - VIEWPORT_MARGIN)),
        y: clamp(
          current.y,
          VIEWPORT_MARGIN,
          Math.max(VIEWPORT_MARGIN, contentHeight - sizeRef.current.height - VIEWPORT_MARGIN),
        ),
      }));
    };
    window.addEventListener('resize', onWindowResize);
    return () => {
      window.removeEventListener('resize', onWindowResize);
      document.body.classList.remove('histogram-panel-resizing');
    };
  }, [minHeight, minWidth, setPosition, topInset]);

  const onPointerMove = useCallback((event) => {
    const state = resizeRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }

    const bounds = readViewportBounds(topInset);
    const contentHeight = Math.max(minHeight, window.innerHeight - topInset);
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const edge = state.edge;

    let nextWidth = state.originWidth;
    let nextHeight = state.originHeight;
    let nextX = state.originX;
    let nextY = state.originY;

    if (edge.includes('e')) {
      nextWidth = clamp(state.originWidth + dx, minWidth, bounds.maxWidth);
    }
    if (edge.includes('s')) {
      nextHeight = clamp(state.originHeight + dy, minHeight, bounds.maxHeight);
    }
    if (edge.includes('w')) {
      const widthDelta = clamp(state.originWidth - dx, minWidth, bounds.maxWidth) - state.originWidth;
      nextWidth = state.originWidth + widthDelta;
      nextX = state.originX - widthDelta;
    }
    if (edge.includes('n')) {
      const heightDelta = clamp(state.originHeight - dy, minHeight, bounds.maxHeight) - state.originHeight;
      nextHeight = state.originHeight + heightDelta;
      nextY = state.originY - heightDelta;
    }

    nextX = clamp(
      nextX,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, window.innerWidth - nextWidth - VIEWPORT_MARGIN),
    );
    nextY = clamp(
      nextY,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, contentHeight - nextHeight - VIEWPORT_MARGIN),
    );

    setSize({ width: nextWidth, height: nextHeight });
    if (setPosition && (nextX !== state.originX || nextY !== state.originY || edge.includes('w') || edge.includes('n'))) {
      setPosition({ x: nextX, y: nextY });
    }
  }, [minHeight, minWidth, setPosition, topInset]);

  const endResize = useCallback((event) => {
    const state = resizeRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    resizeRef.current = null;
    document.body.classList.remove('histogram-panel-resizing');
  }, []);

  const getResizeHandleProps = useCallback((edge) => ({
    onPointerDown: (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      resizeRef.current = {
        pointerId: event.pointerId,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        originWidth: sizeRef.current.width,
        originHeight: sizeRef.current.height,
        originX: position?.x ?? 0,
        originY: position?.y ?? 0,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('histogram-panel-resizing');
    },
    onPointerMove,
    onPointerUp: endResize,
    onPointerCancel: endResize,
  }), [endResize, onPointerMove, position?.x, position?.y]);

  return { size, setSize, getResizeHandleProps };
}
