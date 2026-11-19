import { useState } from 'react';
import { HISTOGRAM_READING_TOOLTIPS } from './ganttUtils';

const READING_ITEMS = [
  {
    id: 'start-flag',
    label: 'Doc supply (start)',
    tooltip: HISTOGRAM_READING_TOOLTIPS.docSupplyStart,
    flagClass: 'histogram-project-legend-key-flag histogram-project-legend-key-flag-start',
  },
  {
    id: 'end-flag',
    label: 'Completion (end)',
    tooltip: HISTOGRAM_READING_TOOLTIPS.completionEnd,
    flagClass: 'histogram-project-legend-key-flag histogram-project-legend-key-flag-end',
  },
  {
    id: 'holiday',
    dlKey: true,
    label: 'Holiday (H)',
    tooltip: HISTOGRAM_READING_TOOLTIPS.employeeHoliday,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-holiday',
    swatchText: 'H',
  },
  {
    id: 'half-day',
    dlKey: true,
    label: 'Half day (H|h)',
    tooltip: HISTOGRAM_READING_TOOLTIPS.halfWorkingDay,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-half-day',
    swatchText: 'H|4',
  },
  {
    id: 'free-dot',
    label: 'Free (3 days)',
    tooltip: HISTOGRAM_READING_TOOLTIPS.operativeFreeDot,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-free-dot',
  },
  {
    id: 'day-split',
    label: 'Day split (4)',
    tooltip: HISTOGRAM_READING_TOOLTIPS.daySplit,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-day-split',
  },
  {
    id: 'training',
    dlKey: true,
    label: 'Training',
    tooltip: HISTOGRAM_READING_TOOLTIPS.scheduledTraining,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-training',
  },
  {
    id: 'training-override',
    label: 'Training override',
    tooltip: HISTOGRAM_READING_TOOLTIPS.scheduledTrainingOverride,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-training-override',
  },
  {
    id: 'due-soon',
    dlKey: true,
    label: 'Due soon (3 days)',
    tooltip: HISTOGRAM_READING_TOOLTIPS.dueSoonBorder,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-due-soon',
  },
  {
    id: 'overdue',
    dlKey: true,
    label: 'Overdue',
    tooltip: HISTOGRAM_READING_TOOLTIPS.overdueBorder,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-overdue',
  },
  {
    id: 'dl-plan-edit',
    dlKey: true,
    label: 'DL plan edit',
    tooltip: HISTOGRAM_READING_TOOLTIPS.dlPlanEdit,
    swatchClass: 'histogram-project-legend-key-swatch histogram-project-legend-key-swatch-dl-plan',
  },
  {
    id: 'task-editor',
    label: 'Task editor',
    summary: 'click a task bar',
    tooltip: HISTOGRAM_READING_TOOLTIPS.openTaskEditor,
  },
  {
    id: 'personal-summary',
    label: 'Personal summary',
    summary: 'click an operative name',
    tooltip: HISTOGRAM_READING_TOOLTIPS.openPersonalSummary,
  },
];

export default function HistogramReadingGuide({ variant = 'page', className = '' }) {
  // Page variant on phones starts minimized to the keys DLs need most (CSS only honours
  // this below 640px; desktop always shows everything).
  const [expanded, setExpanded] = useState(false);
  const isPage = variant !== 'legend';
  const rootClass = [
    isPage ? 'histogram-reading-guide card' : 'histogram-project-legend-key',
    isPage ? (expanded ? 'is-expanded' : 'is-collapsed') : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass} aria-label="How to read the histogram">
      {isPage ? (
        <button
          type="button"
          className="histogram-reading-guide-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Show fewer legend keys' : 'Show all legend keys'}
          title={expanded ? 'Show fewer legend keys' : 'Show all legend keys'}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="histogram-reading-guide-toggle-text">{expanded ? 'Less' : 'All keys'}</span>
          <span aria-hidden="true">{expanded ? ' ▴' : ' ▾'}</span>
        </button>
      ) : null}
      {READING_ITEMS.map((item) => (
        <span
          key={item.id}
          className={[
            isPage ? 'histogram-reading-guide-item' : 'histogram-project-legend-key-item',
            item.dlKey ? 'is-dl-key' : '',
          ].filter(Boolean).join(' ')}
          title={item.tooltip}
        >
          {item.swatchClass ? (
            <span className={item.swatchClass} aria-hidden="true">
              {item.swatchText || null}
            </span>
          ) : null}
          {item.flagClass ? (
            <span className={item.flagClass} aria-hidden="true" />
          ) : null}
          <strong>{item.label}</strong>
          {item.summary ? (
            <span className="histogram-reading-guide-summary"> — {item.summary}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
