import { useState } from 'react';

const LEGEND_ITEMS = [
  {
    id: 'eligible',
    label: 'Eligible tasks',
    summary: 'Plan > 0, Doc Supply & Completion set, not Done',
    tooltip:
      'Only open tasks with valid Plan hours and both schedule dates are scheduled. Rows with no plan are skipped.',
  },
  {
    id: 'priority',
    label: 'Priority',
    summary: 'lower Pri runs first across all projects',
    tooltip:
      'The algorithm processes every eligible task in global priority order (Pri = RAP + PP). Higher-priority tasks claim operative availability first.',
  },
  {
    id: 'operatives',
    label: 'Operatives',
    summary: 'OAP + daily availability from Operatives Allocation',
    tooltip:
      'For each task\'s NRM section, only operatives with an OAP value and enough free hours in the date window are considered. The algo picks who can start earliest, then lowest OAP rank as tie-break.',
  },
  {
    id: 'dates',
    label: 'Dates',
    summary: 'hours stay between Doc Supply and Completion',
    tooltip:
      'Work is never placed before Doc Supply. Daily hours are capped by each operative\'s availability (AVA) so days are not double-booked.',
  },
  {
    id: 'allocation',
    label: 'Allocation',
    summary: 'grey = algorithm · orange = manual pin · % from algo hour ratios',
    tooltip:
      'Person + Hours Share % combines assignee and share. Grey chips are algorithm output; orange chips are manual overrides kept when the algorithm re-runs. Share % follows each person’s share of allocated hours (not an equal split). Use Reset to clear pins.',
  },
  {
    id: 'overrides',
    label: 'Manual pins',
    summary: 'Editing a person or share pins that slot (orange)',
    tooltip:
      'Manual pins take precedence over automatic OAP selection. Trainee pairing and performance % may adjust total hours.',
  },
  {
    id: 'output',
    label: 'Output',
    summary: 'Allocation + Owner — Run algorithm, then Save',
    tooltip:
      'Run algorithm fills Allocation (grey) and Owner. Click Save to persist assignments and update the resource histogram.',
  },
];

export default function PdeAlgorithmLegend({ className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const rootClass = [
    'pde-algorithm-legend',
    'card',
    expanded ? 'is-expanded' : 'is-collapsed',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass} aria-label="How the scheduling algorithm works">
      <button
        type="button"
        className="pde-algorithm-legend-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide how the algorithm works' : 'Show how the algorithm works'}
        title={expanded ? 'Hide details' : 'Show details'}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="pde-algorithm-legend-heading">How the algorithm works</span>
        <span className="pde-algorithm-legend-toggle-hint">
          <span>{expanded ? 'Hide' : 'Details'}</span>
          <span aria-hidden="true">{expanded ? ' ▴' : ' ▾'}</span>
        </span>
      </button>
      {expanded ? (
        LEGEND_ITEMS.map((item) => (
          <span key={item.id} className="pde-algorithm-legend-item" title={item.tooltip}>
            <strong>{item.label}</strong>
            {item.summary ? (
              <span className="pde-algorithm-legend-summary"> — {item.summary}</span>
            ) : null}
          </span>
        ))
      ) : null}
    </div>
  );
}
