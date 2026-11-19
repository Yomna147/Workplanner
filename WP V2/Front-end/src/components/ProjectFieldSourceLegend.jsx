export default function ProjectFieldSourceLegend({ trailing = null }) {
  return (
    <div className="pde-field-source-legend-row">
      <div className="pde-field-source-legend" aria-label="Field source legend">
        <span className="pde-field-source-legend-item pde-field-source-legend-item--calculated" title="Blue — derived from other fields (e.g. Plan, Pri)">
          <span className="pde-field-source-swatch" aria-hidden="true" />
          Calculated
        </span>
        <span className="pde-field-source-legend-item pde-field-source-legend-item--auto" title="Light grey — set by Run algorithm">
          <span className="pde-field-source-swatch" aria-hidden="true" />
          Algorithm output
        </span>
        <span className="pde-field-source-legend-item pde-field-source-legend-item--dl-locked" title="Red border — value filled on the DL Input Hours page; edit there to change">
          <span className="pde-field-source-swatch pde-field-source-swatch--dl-locked" aria-hidden="true" />
          DL Filled.
        </span>
        <span className="pde-field-source-legend-item pde-field-source-legend-item--inactive" title="Light grey row — no Plan hours; excluded from allocation">
          <span className="pde-field-source-swatch pde-field-source-swatch--inactive" aria-hidden="true" />
          No plan
        </span>
      </div>
      {trailing}
    </div>
  );
}
