import { useCallback, useEffect, useRef } from 'react';
import { useScrollContainerWheel } from '../../hooks/useScrollContainerWheel';

function getHistogramHorizontalScroller() {
  return document.querySelector('.histogram-fixed-header-timeline')
    || document.querySelector('.histogram-timeline-scroll')
    || document.querySelector('.histogram-sync-scroll-main');
}

function syncHistogramScrollLeft(source, left, { behavior = 'auto', labelWidth = 0 } = {}) {
  const root = source?.closest('.histogram-sync-scroll');
  if (!root) return;

  const strip = root.querySelector('.histogram-top-scrollbar-strip');
  const bottomStrip = root.querySelector('.histogram-bottom-scrollbar-strip');
  const top = root.querySelector('.histogram-fixed-header-timeline')
    || root.querySelector('.histogram-sync-scroll-top:not(.histogram-top-scrollbar-strip)');
  const main = root.querySelector('.histogram-sync-scroll-main')
    || root.querySelector('.histogram-timeline-scroll');

  const sourceIsMain = source === main;
  // Sticky operative label columns: timeline offset matches main scrollLeft directly.
  const timelineLeft = left;
  const mainLeft = left;

  const apply = (element, value) => {
    if (!element || element === source) return;
    if (behavior === 'smooth') {
      element.scrollTo({ left: value, behavior: 'smooth' });
      return;
    }
    element.scrollLeft = value;
  };

  if (sourceIsMain) {
    apply(strip, timelineLeft);
    apply(bottomStrip, timelineLeft);
    apply(top, timelineLeft);
  } else {
    apply(main, mainLeft);
    if (strip && strip !== source) apply(strip, timelineLeft);
    if (bottomStrip && bottomStrip !== source) apply(bottomStrip, timelineLeft);
    if (top && top !== source) apply(top, timelineLeft);
  }
}

export function scrollHistogramToDay(dayYmd, { behavior = 'auto', rootSelector = '' } = {}) {
  if (!dayYmd) return;

  const scrollRoot = rootSelector ? document.querySelector(rootSelector) : null;
  const top = scrollRoot?.querySelector('.histogram-fixed-header-timeline')
    || scrollRoot?.querySelector('.histogram-sync-scroll-top:not(.histogram-top-scrollbar-strip)');
  const main = getHistogramScrollMain(rootSelector) || getHistogramHorizontalScroller();
  const marker = findTodayMarkerElement(scrollRoot, top, main, dayYmd)
    || document.querySelector(`.resource-histogram-header-days [data-histogram-day="${dayYmd}"]`)
    || document.querySelector(`[data-histogram-day="${dayYmd}"]`);
  if (!main || !marker) return;

  const mainRect = main.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const markerCenter = main.scrollLeft + (markerRect.left - mainRect.left) + (markerRect.width / 2);
  const nextScrollLeft = Math.max(0, markerCenter - (mainRect.width / 2));

  if (behavior === 'smooth') {
    main.scrollTo({ left: nextScrollLeft, behavior: 'smooth' });
    const labelEl = main.closest('.histogram-sync-scroll')?.querySelector('.histogram-fixed-header-label');
    const labelWidth = labelEl?.getBoundingClientRect().width ?? 0;
    syncHistogramScrollLeft(main, nextScrollLeft, { behavior: 'smooth', labelWidth });
    return;
  }

  main.scrollLeft = nextScrollLeft;
  const labelEl = main.closest('.histogram-sync-scroll')?.querySelector('.histogram-fixed-header-label');
  const labelWidth = labelEl?.getBoundingClientRect().width ?? 0;
  syncHistogramScrollLeft(main, nextScrollLeft, { labelWidth });
}

function getHistogramScrollMain(rootSelector = '') {
  const root = rootSelector ? document.querySelector(rootSelector) : document;
  return root?.querySelector('.histogram-sync-scroll-main')
    || root?.querySelector('.histogram-timeline-scroll')
    || getHistogramHorizontalScroller();
}

/** Prefer the timeline header day cell so the line aligns with the date row. */
function findTodayMarkerElement(root, top, main, todayYmd) {
  if (!todayYmd) {
    return null;
  }

  const daySelector = `[data-histogram-day="${todayYmd}"]`;
  const candidates = [
    top?.querySelector(`.resource-histogram-header-days ${daySelector}`),
    top?.querySelector(`.resource-gantt-day.is-today${daySelector}`),
    root?.querySelector(`.resource-histogram-header-days ${daySelector}`),
    root?.querySelector(`.resource-gantt-day.is-today${daySelector}`),
    main?.querySelector(`.resource-gantt-grid-cell.is-today${daySelector}`),
    main?.querySelector(daySelector),
  ];

  return candidates.find(Boolean) ?? null;
}

function todayLineSpanHeight(root, main) {
  if (!root || !main) {
    return 0;
  }

  const headerRow = root.querySelector('.histogram-fixed-header-row, .histogram-split-top');
  const bottomStrip = root.querySelector('.histogram-bottom-scrollbar-row');
  const bottomStripHeight = bottomStrip?.offsetHeight ?? 0;
  const mainBottom = main.offsetTop + main.clientHeight;
  const headerBottom = headerRow ? headerRow.offsetTop + headerRow.offsetHeight : 0;

  return Math.max(mainBottom, headerBottom, root.clientHeight - bottomStripHeight);
}

function isElementVisibleInContainer(element, container, padding = 20) {
  if (!element || !container) {
    return false;
  }
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return (
    elementRect.top >= containerRect.top + padding
    && elementRect.bottom <= containerRect.bottom - padding
    && elementRect.left >= containerRect.left + padding
    && elementRect.right <= containerRect.right - padding
  );
}

function unionClientRects(rects = []) {
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

function scrollClientRectToCenter(
  targetRect,
  { behavior = 'smooth', rootSelector = '' } = {},
) {
  const main = getHistogramScrollMain(rootSelector);
  if (!main || !targetRect) {
    return false;
  }

  const mainRect = main.getBoundingClientRect();
  const targetCenterX = targetRect.left + (targetRect.width / 2);
  const targetCenterY = targetRect.top + (targetRect.height / 2);
  const viewportCenterX = mainRect.left + (mainRect.width / 2);
  const viewportCenterY = mainRect.top + (mainRect.height / 2);

  const nextScrollLeft = Math.max(0, main.scrollLeft + (targetCenterX - viewportCenterX));
  const nextScrollTop = Math.max(0, main.scrollTop + (targetCenterY - viewportCenterY));

  if (behavior === 'smooth') {
    main.scrollTo({ left: nextScrollLeft, top: nextScrollTop, behavior: 'smooth' });
  } else {
    main.scrollLeft = nextScrollLeft;
    main.scrollTop = nextScrollTop;
  }

  const labelEl = main.closest('.histogram-sync-scroll')?.querySelector('.histogram-fixed-header-label');
  const labelWidth = labelEl?.getBoundingClientRect().width ?? 0;
  syncHistogramScrollLeft(main, nextScrollLeft, { behavior, labelWidth });
  return true;
}

/**
 * Scroll the histogram viewport so a bar/row element is visible (both axes).
 * No-op when the target is already fully in view.
 */
export function scrollHistogramElementIntoView(
  element,
  { behavior = 'smooth', rootSelector = '', padding = 24, center = false } = {},
) {
  const main = getHistogramScrollMain(rootSelector);
  if (!main || !element) {
    return false;
  }

  if (!center && isElementVisibleInContainer(element, main, padding)) {
    return false;
  }

  if (center) {
    return scrollClientRectToCenter(element.getBoundingClientRect(), { behavior, rootSelector });
  }

  const mainRect = main.getBoundingClientRect();
  const targetRect = element.getBoundingClientRect();
  let nextScrollLeft = main.scrollLeft;
  let nextScrollTop = main.scrollTop;

  if (targetRect.left < mainRect.left + padding) {
    nextScrollLeft += targetRect.left - mainRect.left - padding;
  } else if (targetRect.right > mainRect.right - padding) {
    nextScrollLeft += targetRect.right - mainRect.right + padding;
  }

  if (targetRect.top < mainRect.top + padding) {
    nextScrollTop += targetRect.top - mainRect.top - padding;
  } else if (targetRect.bottom > mainRect.bottom - padding) {
    nextScrollTop += targetRect.bottom - mainRect.bottom + padding;
  }

  nextScrollLeft = Math.max(0, nextScrollLeft);
  nextScrollTop = Math.max(0, nextScrollTop);

  if (behavior === 'smooth') {
    main.scrollTo({ left: nextScrollLeft, top: nextScrollTop, behavior: 'smooth' });
  } else {
    main.scrollLeft = nextScrollLeft;
    main.scrollTop = nextScrollTop;
  }

  const labelEl = main.closest('.histogram-sync-scroll')?.querySelector('.histogram-fixed-header-label');
  const labelWidth = labelEl?.getBoundingClientRect().width ?? 0;
  syncHistogramScrollLeft(main, nextScrollLeft, { behavior, labelWidth });
  return true;
}

/**
 * Bring task editor selection into view on the resource histogram.
 */
export function scrollHistogramToTask(
  taskId,
  {
    behavior = 'smooth',
    rootSelector = '.resource-histogram-chart-wrap',
    bars = [],
    center = false,
  } = {},
) {
  const taskKey = String(taskId ?? '').trim();
  if (!taskKey) {
    return false;
  }

  const root = rootSelector ? document.querySelector(rootSelector) : document;
  const escaped = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(taskKey)
    : taskKey.replace(/"/g, '\\"');

  const highlightedBars = root?.querySelectorAll(
    `.resource-gantt-bar.is-editor-highlighted[data-task-id="${escaped}"]`,
  ) ?? [];

  if (highlightedBars.length > 0) {
    if (center) {
      const targetRect = unionClientRects(
        [...highlightedBars].map((barEl) => barEl.getBoundingClientRect()),
      );
      if (targetRect) {
        return scrollClientRectToCenter(targetRect, { behavior, rootSelector });
      }
    }

    for (const barEl of highlightedBars) {
      if (!isElementVisibleInContainer(barEl, getHistogramScrollMain(rootSelector), 20)) {
        scrollHistogramElementIntoView(barEl, { behavior, rootSelector, center });
        return true;
      }
    }

    return false;
  }

  const bar = (bars ?? []).find((entry) => String(entry.task_id ?? entry.id) === taskKey);
  if (!bar) {
    return false;
  }

  let scrolled = false;
  if (bar.employee) {
    const employeeKey = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(String(bar.employee))
      : String(bar.employee).replace(/"/g, '\\"');
    const rowEl = root?.querySelector(`[data-histogram-row-name="${employeeKey}"]`);
    if (rowEl) {
      scrolled = scrollHistogramElementIntoView(rowEl, { behavior, rootSelector, center }) || scrolled;
    }
  }

  if (bar.start) {
    scrollHistogramToDay(bar.start, { behavior, rootSelector });
    scrolled = true;
  }

  return scrolled;
}

export default function SyncedHorizontalScroll({
  scrollWidth,
  children,
  className = '',
  todayYmd = '',
  frozenWidth = 0,
  frozenContent = null,
  frozenCorner = null,
  labelHeader = null,
  timelineHeader = null,
  labelWidth = 0,
  showTopScrollbarStrip = false,
  showBottomScrollbarStrip = false,
}) {
  const rootRef = useRef(null);
  const topScrollRef = useRef(null);
  const stripScrollRef = useRef(null);
  const bottomScrollRef = useRef(null);
  const mainScrollRef = useRef(null);
  const verticalScrollRef = useRef(null);
  const todayLineRef = useRef(null);
  const todayLineRaf = useRef(null);
  const syncLock = useRef(false);
  const splitLayout = frozenWidth > 0 && frozenContent != null;
  const fixedHeaderLayout = timelineHeader != null && !splitLayout;
  const useTopScrollbarStrip = showTopScrollbarStrip && fixedHeaderLayout;
  const useBottomScrollbarStrip = showBottomScrollbarStrip && fixedHeaderLayout;

  useScrollContainerWheel(
    splitLayout ? verticalScrollRef : null,
    splitLayout ? { horizontalRef: mainScrollRef } : {},
  );

  const mapMainScrollToTimeline = useCallback((mainScrollLeft) => mainScrollLeft, []);

  const mapTimelineScrollToMain = useCallback((timelineScrollLeft) => timelineScrollLeft, []);

  const updateTodayLinePosition = useCallback(() => {
    const root = rootRef.current;
    const main = mainScrollRef.current;
    const line = todayLineRef.current;
    if (!root || !main || !line) return;

    if (!todayYmd) {
      line.style.display = 'none';
      return;
    }

    const top = topScrollRef.current;
    const marker = findTodayMarkerElement(root, top, main, todayYmd);
    if (!marker) {
      line.style.display = 'none';
      return;
    }

    const timelineViewport = top || main;
    const viewportRect = timelineViewport.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const markerCenterX = markerRect.left + (markerRect.width / 2);

    if (markerRect.right < viewportRect.left || markerRect.left > viewportRect.right) {
      line.style.display = 'none';
      return;
    }

    const centerX = markerCenterX - rootRect.left;

    line.style.display = 'block';
    line.style.top = '0';
    line.style.left = `${centerX - 1}px`;
    line.style.height = `${todayLineSpanHeight(root, main)}px`;
  }, [todayYmd]);

  const scheduleTodayLineUpdate = useCallback(() => {
    if (todayLineRaf.current != null) return;
    todayLineRaf.current = requestAnimationFrame(() => {
      todayLineRaf.current = null;
      updateTodayLinePosition();
    });
  }, [updateTodayLinePosition]);

  useEffect(() => {
    const strip = stripScrollRef.current;
    const bottomStrip = bottomScrollRef.current;
    const top = topScrollRef.current;
    const main = mainScrollRef.current;
    if (!main) return undefined;
    if (!useTopScrollbarStrip && !useBottomScrollbarStrip && (!top || !main)) return undefined;

    const syncFrom = (source) => {
      if (syncLock.current) return;
      syncLock.current = true;

      if (source === main) {
        const timelineLeft = mapMainScrollToTimeline(source.scrollLeft);
        if (strip) strip.scrollLeft = timelineLeft;
        if (bottomStrip) bottomStrip.scrollLeft = timelineLeft;
        if (top) top.scrollLeft = timelineLeft;
      } else {
        const timelineLeft = source.scrollLeft;
        if (strip && strip !== source) strip.scrollLeft = timelineLeft;
        if (bottomStrip && bottomStrip !== source) bottomStrip.scrollLeft = timelineLeft;
        if (top && top !== source) top.scrollLeft = timelineLeft;
        main.scrollLeft = mapTimelineScrollToMain(timelineLeft);
      }

      scheduleTodayLineUpdate();
      requestAnimationFrame(() => {
        syncLock.current = false;
      });
    };

    const syncFromStrip = () => {
      if (strip) syncFrom(strip);
    };
    const syncFromBottomStrip = () => {
      if (bottomStrip) syncFrom(bottomStrip);
    };
    const syncFromTop = () => {
      if (top) syncFrom(top);
    };
    const syncFromMain = () => syncFrom(main);

    strip?.addEventListener('scroll', syncFromStrip, { passive: true });
    bottomStrip?.addEventListener('scroll', syncFromBottomStrip, { passive: true });
    top?.addEventListener('scroll', syncFromTop, { passive: true });
    main.addEventListener('scroll', syncFromMain, { passive: true });

    return () => {
      strip?.removeEventListener('scroll', syncFromStrip);
      bottomStrip?.removeEventListener('scroll', syncFromBottomStrip);
      top?.removeEventListener('scroll', syncFromTop);
      main.removeEventListener('scroll', syncFromMain);
    };
  }, [
    scrollWidth,
    scheduleTodayLineUpdate,
    splitLayout,
    fixedHeaderLayout,
    useTopScrollbarStrip,
    useBottomScrollbarStrip,
    mapMainScrollToTimeline,
    mapTimelineScrollToMain,
  ]);

  useEffect(() => {
    scheduleTodayLineUpdate();
    const main = mainScrollRef.current;
    const top = topScrollRef.current;
    if (!main) return undefined;

    const onResize = () => scheduleTodayLineUpdate();
    window.addEventListener('resize', onResize, { passive: true });

    let resizeObserver;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleTodayLineUpdate());
      if (rootRef.current) {
        resizeObserver.observe(rootRef.current);
      }
      resizeObserver.observe(main);
      if (top) {
        resizeObserver.observe(top);
      }
      const grid = main.querySelector('.resource-histogram-combined-grid');
      if (grid) {
        resizeObserver.observe(grid);
      }
    }

    let mutationObserver;
    if (typeof MutationObserver !== 'undefined' && todayYmd) {
      mutationObserver = new MutationObserver(() => scheduleTodayLineUpdate());
      const grid = main.querySelector('.resource-histogram-combined-grid');
      if (grid) {
        mutationObserver.observe(grid, { childList: true });
      }
    }

    const delayed = window.setTimeout(scheduleTodayLineUpdate, 0);
    const delayedAgain = window.setTimeout(scheduleTodayLineUpdate, 120);

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.clearTimeout(delayed);
      window.clearTimeout(delayedAgain);
      if (todayLineRaf.current != null) {
        cancelAnimationFrame(todayLineRaf.current);
      }
    };
  }, [scrollWidth, todayYmd, scheduleTodayLineUpdate, splitLayout, fixedHeaderLayout]);

  const todayLine = todayYmd ? (
    <div
      ref={todayLineRef}
      className="histogram-today-line"
      aria-hidden="true"
    />
  ) : null;

  if (splitLayout) {
    return (
      <div ref={rootRef} className={`histogram-sync-scroll histogram-sync-scroll--split ${className}`.trim()}>
        {todayLine}
        <div className="histogram-split-top">
          <div
            className="histogram-frozen-corner"
            style={{ width: frozenWidth, minWidth: frozenWidth, maxWidth: frozenWidth }}
          >
            {frozenCorner}
          </div>
          <div
            ref={topScrollRef}
            className="histogram-sync-scroll-top histogram-split-top-scroll"
            aria-label="Histogram horizontal scroll"
          >
            <div
              className="histogram-sync-scroll-top-inner"
              style={{ width: scrollWidth }}
              aria-hidden
            />
          </div>
        </div>
        <div ref={verticalScrollRef} className="histogram-sync-scroll-main histogram-split-main">
          <div className="histogram-split-body">
            <div
              className="histogram-frozen-labels"
              style={{ width: frozenWidth, minWidth: frozenWidth, maxWidth: frozenWidth }}
            >
              {frozenContent}
            </div>
            <div ref={mainScrollRef} className="histogram-timeline-scroll">
              {children}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`histogram-sync-scroll${fixedHeaderLayout ? ' histogram-sync-scroll--fixed-header' : ''}${useTopScrollbarStrip ? ' histogram-sync-scroll--top-strip' : ''}${useBottomScrollbarStrip ? ' histogram-sync-scroll--bottom-strip' : ''} ${className}`.trim()}
    >
      {todayLine}
      {fixedHeaderLayout ? (
        <>
          {useTopScrollbarStrip ? (
            <div className="histogram-top-scrollbar-row">
              <div
                className="histogram-top-scrollbar-spacer"
                style={{
                  width: labelWidth,
                  minWidth: labelWidth,
                  maxWidth: labelWidth,
                }}
                aria-hidden="true"
              />
              <div
                ref={stripScrollRef}
                className="histogram-sync-scroll-top histogram-top-scrollbar-strip"
                aria-label="Histogram horizontal scroll"
              >
                <div
                  className="histogram-sync-scroll-top-inner"
                  style={{ width: scrollWidth }}
                  aria-hidden
                />
              </div>
            </div>
          ) : null}
          <div className="histogram-fixed-header-row">
            <div
              className="histogram-fixed-header-label resource-gantt-label-col resource-histogram-header-label"
              style={{
                width: labelWidth,
                minWidth: labelWidth,
                maxWidth: labelWidth,
              }}
            >
              {labelHeader}
            </div>
            <div
              ref={topScrollRef}
              className="histogram-sync-scroll-top histogram-fixed-header-timeline"
              aria-label="Histogram timeline header"
            >
              <div
                className="histogram-fixed-header-timeline-inner"
                style={{ width: scrollWidth }}
              >
                {timelineHeader}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div
          ref={topScrollRef}
          className="histogram-sync-scroll-top"
          aria-label="Histogram horizontal scroll"
        >
          <div
            className="histogram-sync-scroll-top-inner"
            style={{ width: scrollWidth }}
            aria-hidden
          />
        </div>
      )}
      <div ref={mainScrollRef} className="histogram-sync-scroll-main">
        {children}
      </div>
      {useBottomScrollbarStrip ? (
        <div className="histogram-bottom-scrollbar-row">
          <div
            className="histogram-bottom-scrollbar-spacer"
            style={{
              width: labelWidth,
              minWidth: labelWidth,
              maxWidth: labelWidth,
            }}
            aria-hidden="true"
          />
          <div
            ref={bottomScrollRef}
            className="histogram-sync-scroll-bottom histogram-bottom-scrollbar-strip"
            aria-label="Histogram horizontal scroll"
          >
            <div
              className="histogram-sync-scroll-top-inner"
              style={{ width: scrollWidth }}
              aria-hidden
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
