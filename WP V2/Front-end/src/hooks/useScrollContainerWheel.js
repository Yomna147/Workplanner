import { useEffect } from 'react';

/**
 * Routes mouse-wheel deltas to a scroll container so nested grids scroll reliably
 * instead of bubbling to the page. Optional horizontalRef maps wheel to horizontal
 * scroll (shift+wheel, trackpad sideways, or vertical wheel at Y limits).
 */
export function useScrollContainerWheel(containerRef, { horizontalRef } = {}) {
  useEffect(() => {
    const container = containerRef?.current ?? null;
    if (!container) {
      return undefined;
    }

    const onWheel = (event) => {
      const horizontal = horizontalRef?.current ?? null;
      const canScrollY = container.scrollHeight > container.clientHeight + 1;
      const canScrollX = horizontal
        ? horizontal.scrollWidth > horizontal.clientWidth + 1
        : container.scrollWidth > container.clientWidth + 1;

      const { deltaX, deltaY } = event;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (horizontal && canScrollX) {
        if (event.shiftKey && absY > 0) {
          event.preventDefault();
          horizontal.scrollLeft += deltaY;
          return;
        }

        if (absX > absY && absX > 0) {
          event.preventDefault();
          horizontal.scrollLeft += deltaX;
          return;
        }
      }

      if (canScrollY && absY > 0 && (!event.shiftKey || absY >= absX)) {
        const scrollingDown = deltaY > 0;
        const atTop = container.scrollTop <= 0;
        const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;

        if ((scrollingDown && !atBottom) || (!scrollingDown && !atTop)) {
          event.preventDefault();
          container.scrollTop += deltaY;
          return;
        }
      }

      if (horizontal && canScrollX && absY > 0 && absY >= absX && !event.shiftKey) {
        const scrollingRight = deltaY > 0;
        const atLeft = horizontal.scrollLeft <= 0;
        const atRight = horizontal.scrollLeft + horizontal.clientWidth >= horizontal.scrollWidth - 1;

        if ((scrollingRight && !atRight) || (!scrollingRight && !atLeft)) {
          event.preventDefault();
          horizontal.scrollLeft += deltaY;
        }
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [containerRef, horizontalRef]);
}
