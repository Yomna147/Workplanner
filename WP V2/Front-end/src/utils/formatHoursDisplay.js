/**
 * Format hour values for display (1 decimal max, no long fractions like 30.6667).
 */
export function formatHoursDisplay(value, { suffix = '', empty = '—' } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    return empty;
  }
  const num = Number(text);
  if (!Number.isFinite(num)) {
    return text;
  }
  const formatted = Number.isInteger(num) ? String(num) : (Math.round(num * 10) / 10).toFixed(1);
  return suffix ? `${formatted}${suffix}` : formatted;
}
