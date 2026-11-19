import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const VIEW_OPTIONS = [
  {
    id: 'startFlags',
    label: 'Doc supply flags',
    description: 'Show doc supply markers on each operative row.',
  },
  {
    id: 'endFlags',
    label: 'Completion flags',
    description: 'Show completion markers on each operative row.',
  },
  {
    id: 'daySplit',
    label: 'Day split',
    description: 'Show the 4-part day grid on each weekday column.',
  },
  {
    id: 'availability',
    label: 'Availability flags',
    description: 'Show remaining AVA hours after assignments (hidden completed projects still count). Fully booked days show 0.',
  },
  {
    id: 'showNoDocs',
    label: 'Show projects without all docs',
    description: 'Display no-docs projects on the chart. Allocation is unchanged.',
  },
  {
    id: 'showCompleted',
    label: 'Show completed projects',
    description: 'Show projects marked completed (or with every task done). Off by default.',
  },
  {
    id: 'legend',
    label: 'Legend',
    description: 'Show the project legend below the toolbar.',
  },
  {
    id: 'dlPlanEdits',
    label: 'Highlight DL plan edits',
    description: 'Mark histogram bars for tasks last saved on the DL page. Hover a bar to see who changed it and when.',
  },
];

export default function HistogramViewOptionsDropdown({
  showStartFlags,
  onShowStartFlagsChange,
  showEndFlags,
  onShowEndFlagsChange,
  showDaySplit,
  onShowDaySplitChange,
  showAvailability,
  onShowAvailabilityChange,
  hideMissingAllDocs,
  onHideMissingAllDocsChange,
  hideCompletedProjects,
  onHideCompletedProjectsChange,
  showLegend,
  onShowLegendChange,
  showDlPlanEdits = true,
  onShowDlPlanEditsChange,
}) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const values = useMemo(() => ({
    startFlags: showStartFlags,
    endFlags: showEndFlags,
    daySplit: showDaySplit,
    availability: showAvailability,
    showNoDocs: !hideMissingAllDocs,
    showCompleted: !hideCompletedProjects,
    legend: showLegend,
    dlPlanEdits: showDlPlanEdits,
  }), [
    showStartFlags,
    showEndFlags,
    showDaySplit,
    showAvailability,
    hideMissingAllDocs,
    hideCompletedProjects,
    showLegend,
    showDlPlanEdits,
  ]);

  const enabledCount = useMemo(
    () => Object.values(values).filter(Boolean).length,
    [values],
  );

  const updatePanelPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const menuWidth = Math.min(320, window.innerWidth - viewportPadding * 2);
    let left = rect.right - menuWidth;

    if (left < viewportPadding) {
      left = viewportPadding;
    }

    const maxLeft = window.innerWidth - menuWidth - viewportPadding;
    if (left > maxLeft) {
      left = Math.max(viewportPadding, maxLeft);
    }

    setPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left,
      width: menuWidth,
      zIndex: 1400,
    });
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    updatePanelPosition();

    const handlePointerDown = (event) => {
      const target = event.target;
      if (
        rootRef.current?.contains(target)
        || panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    const handleReposition = () => {
      updatePanelPosition();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open]);

  const handleToggle = (id, checked) => {
    switch (id) {
      case 'startFlags':
        onShowStartFlagsChange(checked);
        break;
      case 'endFlags':
        onShowEndFlagsChange(checked);
        break;
      case 'daySplit':
        onShowDaySplitChange(checked);
        break;
      case 'availability':
        onShowAvailabilityChange(checked);
        break;
      case 'showNoDocs':
        onHideMissingAllDocsChange(!checked);
        break;
      case 'showCompleted':
        onHideCompletedProjectsChange(!checked);
        break;
      case 'legend':
        onShowLegendChange(checked);
        break;
      case 'dlPlanEdits':
        onShowDlPlanEditsChange?.(checked);
        break;
      default:
        break;
    }
  };

  const panel = open && panelStyle ? (
    <div
      ref={panelRef}
      className="histogram-view-options-menu"
      role="group"
      aria-label="Histogram view options"
      style={panelStyle}
    >
      {VIEW_OPTIONS.map((option) => (
        <label
          key={option.id}
          className="histogram-view-options-item"
          title={option.description}
        >
          <input
            type="checkbox"
            checked={Boolean(values[option.id])}
            onChange={(event) => handleToggle(option.id, event.target.checked)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  ) : null;

  return (
    <div className="histogram-view-options" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`histogram-toolbar-btn histogram-view-options-trigger${open ? ' is-active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Enable or disable histogram view options"
      >
        View options
        {enabledCount > 0 ? (
          <span className="histogram-view-options-badge" aria-hidden="true">
            {enabledCount}
          </span>
        ) : null}
      </button>

      {panel ? createPortal(panel, document.body) : null}
    </div>
  );
}
