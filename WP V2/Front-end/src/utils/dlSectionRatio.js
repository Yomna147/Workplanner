import { DL_BUDGET_HOUR_KEYS } from './taskSectionDetailCalculations';

function parseNum(value) {
  const num = parseFloat(value);
  return Number.isNaN(num) ? 0 : num;
}

function dlSectionTotal(task) {
  return DL_BUDGET_HOUR_KEYS.reduce((sum, key) => sum + parseNum(task?.[key]), 0);
}

function hoursToCents(value) {
  return Math.max(0, Math.round((parseNum(value) + Number.EPSILON) * 100));
}

function formatCents(cents) {
  if (!cents) {
    return '';
  }
  return String(cents / 100);
}

/**
 * Split a cent total across weights. Locations with no share stay at 0.
 * Extra cents go to the largest fractional remainders so the parts sum exactly.
 */
function splitCentsByWeights(totalCents, weights) {
  const portions = weights.map(() => 0);
  if (totalCents <= 0) {
    return portions;
  }

  const active = weights
    .map((weight, index) => ({ index, weight }))
    .filter((item) => item.weight > 0);
  const targets = active.length > 0
    ? active
    : weights.map((_, index) => ({ index, weight: 1 }));
  const weightSum = targets.reduce((sum, item) => sum + item.weight, 0);
  const raw = targets.map((item) => (totalCents * item.weight) / weightSum);
  const floors = raw.map((value) => Math.floor(value + 1e-8));
  let leftover = totalCents - floors.reduce((sum, value) => sum + value, 0);
  const byFraction = raw
    .map((value, offset) => ({ offset, fraction: value - Math.floor(value + 1e-8) }))
    .sort((left, right) => right.fraction - left.fraction || left.offset - right.offset);

  const assigned = [...floors];
  for (let step = 0; step < leftover; step += 1) {
    assigned[byFraction[step % byFraction.length].offset] += 1;
  }

  targets.forEach((item, offset) => {
    portions[item.index] = assigned[offset];
  });

  return portions;
}

/**
 * When DL hours change, split across DL budget columns by current ratio (or evenly).
 * Hours land only on locations that already have a share. An empty location stays empty.
 * When a DL budget hour changes, sync DL to the sum of those columns only.
 * Operative TPS hours (sec_hrs_*) are stored separately and are not touched here.
 */
export function applyDlSectionSplitChange(task, changedKey, changedValue) {
  const next = { ...task, [changedKey]: changedValue };

  if (changedKey === 'dl') {
    const currentTotal = dlSectionTotal(next);
    const weights = DL_BUDGET_HOUR_KEYS.map((key) => (
      currentTotal > 0 ? parseNum(next[key]) / currentTotal : 0
    ));
    const portions = splitCentsByWeights(hoursToCents(changedValue), weights);

    DL_BUDGET_HOUR_KEYS.forEach((key, index) => {
      next[key] = formatCents(portions[index]);
    });

    return next;
  }

  if (DL_BUDGET_HOUR_KEYS.includes(changedKey)) {
    const dlTotal = dlSectionTotal(next);
    next.dl = dlTotal > 0 || DL_BUDGET_HOUR_KEYS.some((key) => String(next[key] ?? '').trim() !== '')
      ? String(Math.round(dlTotal * 100) / 100)
      : '';
    return next;
  }

  return next;
}
