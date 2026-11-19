/** Display priority values as ###.## (e.g. 120.00). */
export function formatPriorityValue(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

export function parsePriorityValue(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return '';
  }
  const n = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? String(n) : '';
}

export function clampPriorityValue(num, { min = 0, max = 999.99 } = {}) {
  let next = num;
  if (min !== undefined) {
    next = Math.max(min, next);
  }
  if (max !== undefined) {
    next = Math.min(max, next);
  }
  return Math.round(next * 100) / 100;
}
