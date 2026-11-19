/** Histogram grid zoom: 50%–200% in 5% steps. */
export const HISTOGRAM_ZOOM_MIN = 0.5;
export const HISTOGRAM_ZOOM_MAX = 2;
export const HISTOGRAM_ZOOM_STEP_PCT = 5;

function zoomPercent(value) {
  return Math.round(Number(value) * 100);
}

function clampZoomPercent(pct) {
  const minPct = zoomPercent(HISTOGRAM_ZOOM_MIN);
  const maxPct = zoomPercent(HISTOGRAM_ZOOM_MAX);
  return Math.min(maxPct, Math.max(minPct, pct));
}

function zoomFromPercent(pct) {
  return clampZoomPercent(pct) / 100;
}

export function stepHistogramZoomIn(current = 1) {
  return zoomFromPercent(zoomPercent(current) + HISTOGRAM_ZOOM_STEP_PCT);
}

export function stepHistogramZoomOut(current = 1) {
  return zoomFromPercent(zoomPercent(current) - HISTOGRAM_ZOOM_STEP_PCT);
}

export function isHistogramZoomAtMin(zoom = 1) {
  return zoomPercent(zoom) <= zoomPercent(HISTOGRAM_ZOOM_MIN);
}

export function isHistogramZoomAtMax(zoom = 1) {
  return zoomPercent(zoom) >= zoomPercent(HISTOGRAM_ZOOM_MAX);
}

export function histogramZoomLabel(zoom = 1) {
  return `${zoomPercent(zoom)}%`;
}
