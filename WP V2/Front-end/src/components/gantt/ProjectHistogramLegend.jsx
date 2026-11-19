import { useEffect, useMemo, useRef, useState } from 'react';
import { sortLegendItemsAsc } from '../../utils/projectSort';
import { filterOpenLegendItems } from './ganttUtils';

const LEGEND_TITLE_RESERVE_PX = 76;
const LEGEND_ITEM_GAP_PX = 12;
const LEGEND_MIN_ITEM_WIDTH_PX = 112;
const LEGEND_MAX_ITEM_WIDTH_PX = 360;

function tierMaxWidthByCount(count) {
  if (count <= 0) {
    return 140;
  }
  if (count === 1) {
    return LEGEND_MAX_ITEM_WIDTH_PX;
  }
  if (count === 2) {
    return 280;
  }
  if (count <= 3) {
    return 230;
  }
  if (count <= 5) {
    return 195;
  }
  if (count <= 8) {
    return 170;
  }
  if (count <= 12) {
    return 150;
  }
  if (count <= 18) {
    return 135;
  }

  return 120;
}

function resolveLegendItemMaxWidth(projectCount, rowWidth) {
  const tierWidth = tierMaxWidthByCount(projectCount);
  if (!rowWidth || projectCount <= 0) {
    return tierWidth;
  }

  const scrollBudget = Math.max(0, rowWidth - LEGEND_TITLE_RESERVE_PX);
  const perItem = Math.floor(
    (scrollBudget - LEGEND_ITEM_GAP_PX * Math.max(0, projectCount - 1)) / projectCount,
  );

  return Math.min(
    tierWidth,
    Math.max(LEGEND_MIN_ITEM_WIDTH_PX, perItem),
  );
}

export default function ProjectHistogramLegend({ items = [], embedded = false, filterByOpenTasks = false }) {
  const rowRef = useRef(null);
  const [rowWidth, setRowWidth] = useState(0);

  const visibleItems = sortLegendItemsAsc(
    filterByOpenTasks ? filterOpenLegendItems(items) : items,
  );

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? 0;
      setRowWidth(Math.round(width));
    });

    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const itemMaxWidth = useMemo(
    () => resolveLegendItemMaxWidth(visibleItems.length, rowWidth),
    [visibleItems.length, rowWidth],
  );

  const rootClass = [
    'histogram-project-legend',
    embedded ? 'histogram-project-legend--embedded' : 'card',
    visibleItems.length === 0 ? 'histogram-project-legend-empty' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={rootClass}
      aria-label="Histogram legend"
      data-project-count={visibleItems.length > 0 ? visibleItems.length : undefined}
      style={{ '--histogram-legend-item-max-width': `${itemMaxWidth}px` }}
    >
      <div className="histogram-project-legend-row" ref={rowRef}>
        <div className="histogram-project-legend-title">Projects</div>
        <div className="histogram-project-legend-scroll" tabIndex={0} aria-label="Scroll project legend">
          <div className="histogram-project-legend-scroll-inner">
            {visibleItems.length === 0 ? (
              <p className="histogram-project-legend-empty-inline">No active projects in the current date range.</p>
            ) : (
              <ul className="histogram-project-legend-list">
                {visibleItems.map((item) => (
                  <li
                    key={item.id}
                    className="histogram-project-legend-item"
                    title={item.name}
                  >
                    <span
                      className="histogram-project-legend-dot"
                      style={{ backgroundColor: item.color || '#3B82F6' }}
                      aria-hidden="true"
                    />
                    <span className="histogram-project-legend-name">{item.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
