export default function HistogramChartRefreshOverlay({
  active = false,
  label = 'Loading…',
}) {
  if (!active) {
    return null;
  }

  return (
    <div
      className="histogram-chart-refresh-overlay"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className="histogram-chart-refresh-spinner" aria-hidden="true" />
      <span className="histogram-chart-refresh-label">{label}</span>
    </div>
  );
}
