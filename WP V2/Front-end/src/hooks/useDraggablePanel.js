import { useCallback, useRef, useState } from 'react';

/**
 * Pointer-drag positioning for floating panels (histogram task editor, etc.).
 */
export function useDraggablePanel(initial = {}) {
  const initialX = initial.initialX ?? initial.x ?? 24;
  const initialY = initial.initialY ?? initial.y ?? 72;
  const [position, setPosition] = useState({ x: initialX, y: initialY });
  const dragRef = useRef(null);

  const onPointerDown = useCallback((event) => {
    if (event.button !== 0) {
      return;
    }
    // Don't start a drag when clicking buttons / links inside the handle.
    if (event.target.closest('button, a, input, select, textarea, label')) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [position.x, position.y]);

  const onPointerMove = useCallback((event) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPosition({
      x: Math.max(8, dragRef.current.originX + dx),
      y: Math.max(8, dragRef.current.originY + dy),
    });
  }, []);

  const endDrag = useCallback((event) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = null;
  }, []);

  const dragHandleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  return { position, dragHandleProps, setPosition };
}
