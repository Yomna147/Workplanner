import { useState } from 'react';

const LEGEND_ITEMS = [
  {
    id: 'oap',
    label: 'OAP',
    summary: 'allocation rank; algo picks lowest OAP on same start day',
    tooltip:
      'Set each operative\'s priority for an NRM section. The algorithm only considers operatives with an OAP value there who have enough availability, chooses who can start earliest, then uses the lowest OAP rank as the tie-break (e.g. rank 1.0 before rank 2.0).',
  },
  {
    id: 'performance',
    label: 'Performance %',
    summary: 'skill level; algo uses for trainee priority and adjusted hours',
    tooltip:
      'Record capability in each NRM section. Below 100% marks a trainee (blue name). The algorithm uses this rate for that section to prioritise trainees vs operatives, pair mentoring, and raise task hours when a trainee needs more time.',
  },
  {
    id: 'filled-cell',
    label: 'Filled cell',
    tooltip: 'Cells with a value are highlighted. Edit the field, then press Enter or click away to commit locally.',
    swatchClass: 'allocation-legend-swatch allocation-legend-swatch-filled',
    swatchText: '1',
  },
  {
    id: 'trainee',
    label: 'Trainee',
    summary: 'below 100% performance in a section',
    tooltip:
      'Operatives with performance below 100% in any section are shown with a blue name. The algorithm treats them as trainees in that NRM section and may prioritise them for development, pair them with a 100% operative, or adjust task hours to reflect their skill level.',
    textSampleClass: 'allocation-legend-trainee-sample',
    textSample: 'Name',
  },
  {
    id: 'nrm-filter',
    label: 'NRM column',
    summary: 'click header to filter operatives',
    tooltip:
      'Click an NRM section number to show only operatives with a value in that column. Click again to clear.',
    swatchClass: 'allocation-legend-swatch allocation-legend-swatch-nrm-active',
    swatchText: '1.1',
  },
  {
    id: 'name-filter',
    label: 'Operative name',
    summary: 'click to filter sections',
    tooltip:
      'Click an operative name to show only NRM columns where that person has a value. Click again to clear. Double-click to edit the name.',
  },
  {
    id: 'team',
    label: 'Team row',
    summary: 'click header to collapse or expand',
    tooltip: 'Click a team header to hide or show that team\'s operatives.',
    swatchClass: 'allocation-legend-swatch allocation-legend-swatch-chevron',
  },
  {
    id: 'save',
    label: 'Save',
    summary: 'required to persist changes',
    tooltip:
      'Edits stay on this page until you click Save. Use Team or NRM Section to add rows, and Delete after selecting operatives.',
  },
];

export default function OperativesAllocationLegend({ className = '' }) {
  const [expanded, setExpanded] = useState(false);
  const rootClass = [
    'allocation-reading-guide',
    'card',
    'allocation-reading-guide--collapsible',
    expanded ? 'is-expanded' : 'is-collapsed',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass} aria-label="How to use Operatives Allocation">
      <button
        type="button"
        className="allocation-reading-guide-collapse-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide Operatives Allocation guide' : 'Show Operatives Allocation guide'}
        title={expanded ? 'Hide details' : 'Show details'}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="allocation-reading-guide-collapse-title">How Operatives Allocation works</span>
        <span className="allocation-reading-guide-collapse-hint">
          <span>{expanded ? 'Hide' : 'Details'}</span>
          <span aria-hidden="true">{expanded ? ' ▴' : ' ▾'}</span>
        </span>
      </button>
      {expanded ? LEGEND_ITEMS.map((item) => (
        <span key={item.id} className="allocation-reading-guide-item" title={item.tooltip}>
          {item.swatchClass ? (
            <span className={item.swatchClass} aria-hidden="true">
              {item.swatchText || null}
            </span>
          ) : null}
          {item.textSampleClass ? (
            <span className={item.textSampleClass} aria-hidden="true">
              {item.textSample}
            </span>
          ) : null}
          <strong>{item.label}</strong>
          {item.summary ? (
            <span className="allocation-reading-guide-summary"> — {item.summary}</span>
          ) : null}
        </span>
      )) : null}
    </div>
  );
}
