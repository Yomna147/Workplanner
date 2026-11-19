import { useState } from 'react';

const LEGEND_ITEMS = [
  {
    id: 'hours',
    label: 'Hours',
    summary: 'Prev / Meas / Bill / Chk-Edit / Buffer; DL is the total',
    tooltip: 'Type section hours on this page. DL is the sum of those section hours.',
  },
  {
    id: 'progress',
    label: 'Progress',
    summary: '% complete; Left is remaining hours',
    tooltip: 'Progress % is how far the task is done. Left is hours still remaining at that %.',
  },
  {
    id: 'calculated',
    label: 'Calculated',
    summary: 'blue cells derived from other fields',
    tooltip: 'Blue cells (for example DL total and Left) are calculated. They update when you edit related hours.',
    swatchClass: 'allocation-legend-swatch dl-legend-swatch-calculated',
  },
  {
    id: 'algorithm',
    label: 'Algorithm output',
    shortLabel: 'Algorithm',
    summary: 'grey cells set by Run algorithm',
    tooltip: 'Light grey cells are filled by Run algorithm. Save hours first, then run the algorithm so the histogram matches.',
    swatchClass: 'allocation-legend-swatch dl-legend-swatch-algorithm',
  },
  {
    id: 'dl-filled',
    label: 'DL Filled',
    summary: 'red border — values you typed here',
    tooltip: 'A red border means this value was entered on the DL page. Change it here, then Save.',
    swatchClass: 'allocation-legend-swatch dl-legend-swatch-filled',
  },
  {
    id: 'no-plan',
    label: 'No plan',
    summary: 'grey row with no Plan hours',
    tooltip: 'Rows with no Plan hours stay inactive and are excluded from allocation.',
    swatchClass: 'allocation-legend-swatch dl-legend-swatch-inactive',
  },
  {
    id: 'save',
    label: 'Save',
    summary: 'required to persist; you may be asked to run the algorithm',
    tooltip: 'Edits stay on this page until you click Save. After Save, run the algorithm if prompted so histogram bars match DL hours.',
  },
];

export default function DlPageLegend({ className = '', trailing = null }) {
  // Phones start minimized to the colour key (CSS only honours this below 640px;
  // desktop always shows everything).
  const [expanded, setExpanded] = useState(false);
  const rootClass = [
    'allocation-reading-guide',
    'card',
    expanded ? 'is-expanded' : 'is-collapsed',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass} aria-label="How to use DL Project Data Update">
      <button
        type="button"
        className="dl-legend-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide legend details' : 'Show legend details'}
        title={expanded ? 'Hide legend details' : 'Show legend details'}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="dl-legend-toggle-label">Legend</span>
        <span className="dl-legend-toggle-hint">
          <span className="dl-legend-toggle-hint-text">{expanded ? 'Hide details' : 'Details'}</span>
          <span aria-hidden="true">{expanded ? ' ▴' : ' ▾'}</span>
        </span>
      </button>
      {LEGEND_ITEMS.map((item) => (
        <span
          key={item.id}
          className={`allocation-reading-guide-item${item.swatchClass ? ' has-swatch' : ''}`}
          title={item.tooltip}
        >
          {item.swatchClass ? (
            <span className={item.swatchClass} aria-hidden="true" />
          ) : null}
          {item.shortLabel ? (
            <strong>
              <span className="allocation-reading-guide-label-full">{item.label}</span>
              <span className="allocation-reading-guide-label-short">{item.shortLabel}</span>
            </strong>
          ) : (
            <strong>{item.label}</strong>
          )}
          {item.summary ? (
            <span className="allocation-reading-guide-summary"> — {item.summary}</span>
          ) : null}
        </span>
      ))}
      {trailing}
    </div>
  );
}
