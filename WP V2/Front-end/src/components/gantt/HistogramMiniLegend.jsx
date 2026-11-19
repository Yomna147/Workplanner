import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  LEGEND_SORT_OPTIONS,
  legendSortModeFromColumn,
  parseLegendSortMode,
  sortLegendItemsByMode,
} from '../../utils/projectSort';
import { filterOpenLegendItems } from './ganttUtils';

const LEGEND_PANEL_MAX_WIDTH = 420;
const LEGEND_SORT_STORAGE_KEY = 'wp2_histogram_mini_legend_sort';

function formatPp(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function readStoredSortMode() {
  try {
    const value = localStorage.getItem(LEGEND_SORT_STORAGE_KEY);
    if (LEGEND_SORT_OPTIONS.some((option) => option.id === value)) {
      return value;
    }
  } catch {
    // ignore
  }
  return 'number';
}

function SortHeaderButton({ label, active, direction, align = 'left', onClick }) {
  const arrow = active ? (direction === 'desc' ? ' ↓' : ' ↑') : '';
  return (
    <button
      type="button"
      className={[
        'histogram-mini-legend-sort-btn',
        align === 'right' ? 'is-right' : '',
        active ? 'is-active' : '',
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-pressed={active}
      title={active ? `Sorted ${direction === 'desc' ? 'descending' : 'ascending'} — click to reverse` : `Sort by ${label}`}
    >
      <span>{label}</span>
      <span aria-hidden="true">{arrow || ' ↕'}</span>
    </button>
  );
}

export default function HistogramMiniLegend({
  items = [],
  filterByOpenTasks = false,
  onProjectSelect = null,
  selectedProjectId = '',
}) {
  const [open, setOpen] = useState(false);
  const [sortMode, setSortMode] = useState(readStoredSortMode);
  const rootRef = useRef(null);
  const toggleRef = useRef(null);
  const [panelStyle, setPanelStyle] = useState(null);

  const { column: sortColumn, direction: sortDirection } = parseLegendSortMode(sortMode);

  const visibleItems = useMemo(
    () => sortLegendItemsByMode(
      filterByOpenTasks ? filterOpenLegendItems(items) : items,
      sortMode,
    ),
    [filterByOpenTasks, items, sortMode],
  );

  const persistSortMode = (next) => {
    setSortMode(next);
    try {
      localStorage.setItem(LEGEND_SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  const handleHeaderSort = (column) => {
    const nextDirection = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc';
    persistSortMode(legendSortModeFromColumn(column, nextDirection));
  };

  const updatePanelPosition = () => {
    const toggle = toggleRef.current;
    if (!toggle) {
      return;
    }

    const rect = toggle.getBoundingClientRect();
    const panelWidth = Math.min(LEGEND_PANEL_MAX_WIDTH, window.innerWidth - 24);
    const right = Math.max(12, window.innerWidth - rect.right);

    setPanelStyle({
      position: 'fixed',
      right,
      bottom: window.innerHeight - rect.top + 8,
      width: panelWidth,
      zIndex: 1400,
    });
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    updatePanelPosition();

    const handleClickOutside = (event) => {
      const target = event.target;
      if (
        rootRef.current?.contains(target)
        || target.closest?.('.histogram-mini-legend-panel')
      ) {
        return;
      }
      setOpen(false);
    };

    const handleReposition = () => {
      updatePanelPosition();
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open]);

  if (visibleItems.length === 0) {
    return null;
  }

  const panel = open && panelStyle ? (
    <div
      className="histogram-mini-legend-panel card"
      style={panelStyle}
      role="dialog"
      aria-label="Projects legend"
    >
      <div className="histogram-mini-legend-panel-head">
        <strong>Projects</strong>
        <span>{visibleItems.length}</span>
      </div>
      <div className="histogram-mini-legend-table-head" role="row">
        <span>Color</span>
        <SortHeaderButton
          label="Project"
          active={sortColumn === 'project'}
          direction={sortDirection}
          onClick={() => handleHeaderSort('project')}
        />
        <SortHeaderButton
          label="PP"
          active={sortColumn === 'pp'}
          direction={sortDirection}
          align="right"
          onClick={() => handleHeaderSort('pp')}
        />
      </div>
      <div className="histogram-mini-legend-list">
        {visibleItems.map((item) => {
          const isSelected = selectedProjectId
            && String(item.id) === String(selectedProjectId);
          const rowClassName = [
            'histogram-mini-legend-row',
            item.isComplete ? 'is-complete' : '',
            isSelected ? 'is-selected' : '',
            onProjectSelect ? 'is-clickable' : '',
          ]
            .filter(Boolean)
            .join(' ');

          const rowContent = (
            <>
              <span
                className="histogram-mini-legend-swatch"
                style={{ backgroundColor: item.color || '#3B82F6' }}
                aria-hidden="true"
              />
              <span className="histogram-mini-legend-name">{item.name}</span>
              <span className="histogram-mini-legend-pp">{formatPp(item.pp)}</span>
            </>
          );

          if (onProjectSelect) {
            return (
              <button
                key={item.id}
                type="button"
                className={rowClassName}
                title={`Open ${item.name}`}
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => {
                  onProjectSelect(item.id);
                  setOpen(false);
                }}
              >
                {rowContent}
              </button>
            );
          }

          return (
            <div
              key={item.id}
              className={rowClassName}
              title={item.name}
            >
              {rowContent}
            </div>
          );
        })}
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="histogram-mini-legend" aria-label="Project priorities legend">
      {panel ? createPortal(panel, document.body) : null}
      <button
        ref={toggleRef}
        type="button"
        className="histogram-mini-legend-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Close project legend' : 'Open project legend'}
        title="Project colour, name, and PP"
      >
        <span className="histogram-mini-legend-toggle-icon" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>Projects ({visibleItems.length})</span>
      </button>
    </div>
  );
}
