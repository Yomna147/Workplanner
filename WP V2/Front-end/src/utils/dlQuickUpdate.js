export const DL_QUICK_STATUS_LABELS = {
  submitted: 'Submitted this week',
  stale: 'Edited after submit',
  due: 'Ready to submit',
  overdue: 'Update overdue',
  never: 'Never submitted',
};

export function formatDlQuickStatus(status) {
  return DL_QUICK_STATUS_LABELS[status] || 'Unknown';
}

export function isRfiOn(value) {
  if (value === true || value === 1) {
    return true;
  }
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export function rfiDisplayValue(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  if (isRfiOn(value)) {
    return 'Yes';
  }
  const raw = String(value).trim();
  if (raw === '0' || raw.toLowerCase() === 'false' || raw.toLowerCase() === 'no') {
    return 'No';
  }
  return raw;
}

export function percentDisplay(value) {
  const raw = String(value ?? '').trim().replace(/%$/, '');
  if (raw === '') {
    return '';
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

export const RFI_CHECKBOX_HELP = 'Tick this box when the initial RFI review has been completed. Leave it unticked if the review is still required or in progress.';

export const OVERRIDE_KEYS = ['override_1', 'override_2', 'override_3'];

export function packedOverrideNames(names = []) {
  return names.map((name) => String(name ?? '').trim()).filter(Boolean).slice(0, OVERRIDE_KEYS.length);
}

export function overrideValuesFromNames(names = []) {
  const packed = packedOverrideNames(names);
  return {
    override_1: packed[0] || '',
    override_2: packed[1] || '',
    override_3: packed[2] || '',
  };
}

export function filledOverrideNames(task) {
  return packedOverrideNames(OVERRIDE_KEYS.map((key) => task?.[key]));
}

export const OVERRIDE_SHARE_KEYS = ['override_share_1', 'override_share_2', 'override_share_3'];

export function storedHourShares(task, count) {
  const defaults = equalHourShares(count);
  if (!task || count <= 0) {
    return defaults;
  }

  const shares = [];
  let anyStored = false;
  for (let index = 0; index < count; index += 1) {
    const raw = task[OVERRIDE_SHARE_KEYS[index]];
    const numeric = Number(raw);
    if (raw !== null && raw !== undefined && String(raw).trim() !== '' && Number.isFinite(numeric)) {
      shares.push(Math.max(0, Math.min(100, Math.round(numeric))));
      anyStored = true;
    } else {
      shares.push(defaults[index] ?? 0);
    }
  }

  if (!anyStored) {
    return defaults;
  }

  const sum = shares.reduce((total, value) => total + value, 0);
  if (sum <= 0) {
    return defaults;
  }
  // Match backend overrideSharePercentsForSlots: renorm when sum ≠ 100.
  if (Math.abs(sum - 100) > 0.5) {
    return shares.map((value) => Math.max(0, Math.min(100, Math.round((value * 100) / sum))));
  }

  return shares;
}

export function sharePatchFromValues(shares = []) {
  return {
    override_share_1: shares[0] != null && shares[0] !== '' ? String(shares[0]) : '',
    override_share_2: shares[1] != null && shares[1] !== '' ? String(shares[1]) : '',
    override_share_3: shares[2] != null && shares[2] !== '' ? String(shares[2]) : '',
  };
}

/**
 * Write share % against physical slots (1–3), matching backend Override_Share_N.
 * @param {Array<{ slot: number }>} slots
 * @param {Array<number|string>} shareValues display-order percents aligned to slots
 */
export function sharePatchForSlots(slots = [], shareValues = []) {
  const patch = {
    override_share_1: '',
    override_share_2: '',
    override_share_3: '',
  };
  (Array.isArray(slots) ? slots : []).forEach((slot, index) => {
    const slotNumber = Number(slot?.slot);
    if (!Number.isFinite(slotNumber) || slotNumber < 1 || slotNumber > 3) {
      return;
    }
    const value = shareValues[index];
    if (value != null && value !== '') {
      patch[`override_share_${slotNumber}`] = String(value);
    }
  });
  return patch;
}

/** Pin every named allocation chip so share splits are honored on the next algo run. */
export function pinAllocationNamesPatch(slots = []) {
  const patch = {};
  (Array.isArray(slots) ? slots : []).forEach((slot) => {
    const slotNumber = Number(slot?.slot);
    const name = String(slot?.name ?? '').trim();
    if (!Number.isFinite(slotNumber) || slotNumber < 1 || slotNumber > 3 || !name) {
      return;
    }
    patch[`override_${slotNumber}`] = name;
  });
  return patch;
}

export function equalHourShares(count) {
  const size = Number(count) || 0;
  if (size <= 0) {
    return [];
  }
  if (size === 1) {
    return [100];
  }
  if (size === 2) {
    return [50, 50];
  }
  return [40, 30, 30];
}

/**
 * % from the hours the algorithm gave each person (ratio of allocated hours).
 * Snaps to 10% steps so the share dropdown stays usable; remainder goes to the largest hour slot.
 */
export function sharesFromHours(hours) {
  const vals = (hours || []).map((h) => Math.max(0, Number(h) || 0));
  const total = vals.reduce((sum, h) => sum + h, 0);
  if (vals.length === 0) {
    return [];
  }
  if (total <= 0) {
    return equalHourShares(vals.length);
  }

  const raw = vals.map((h) => (h / total) * 100);
  const rounded = raw.map((p) => Math.round(p / 10) * 10);
  let diff = 100 - rounded.reduce((sum, p) => sum + p, 0);
  if (diff !== 0) {
    let best = 0;
    for (let i = 1; i < vals.length; i += 1) {
      if (vals[i] > vals[best]) {
        best = i;
      }
    }
    rounded[best] = Math.max(0, Math.min(100, rounded[best] + diff));
  }
  return rounded;
}

/**
 * Stand-in for algo hour targets when per-person hours are not on the task row.
 * Matches backend buildPlanTargetsForEmployees (even ceil split).
 */
export function estimateAlgoHours(names, plan) {
  const n = (names || []).length;
  const p = Math.max(0, Number(plan) || 0);
  if (n <= 0) {
    return [];
  }
  if (n === 1) {
    return [p || 1];
  }

  const targets = Array.from({ length: n }, () => Math.ceil(p / n));
  let overflow = targets.reduce((sum, value) => sum + value, 0) - p;
  for (let index = n - 1; index >= 0 && overflow > 0; index -= 1) {
    const deduct = Math.min(overflow, targets[index]);
    targets[index] -= deduct;
    overflow -= deduct;
  }
  return targets;
}

/**
 * Display slots: override pins take precedence per slot; otherwise show algorithm names (grey).
 * Empty slots are omitted so 1–3 people stay on one row.
 */
export function buildAllocationSlots(task) {
  const slots = [];
  for (let slot = 1; slot <= OVERRIDE_KEYS.length; slot += 1) {
    const override = String(task?.[`override_${slot}`] ?? '').trim();
    const algorithm = String(task?.[`algorithm_${slot}`] ?? '').trim();
    const name = override || algorithm;
    if (!name) {
      continue;
    }
    slots.push({
      index: slots.length,
      slot,
      name,
      source: override ? 'manual' : 'algo',
      override,
      algorithm,
    });
  }
  return slots;
}

/** Next free slot number (1–3) for adding a person, or null when full. */
export function nextAllocationSlot(task) {
  for (let slot = 1; slot <= OVERRIDE_KEYS.length; slot += 1) {
    const override = String(task?.[`override_${slot}`] ?? '').trim();
    const algorithm = String(task?.[`algorithm_${slot}`] ?? '').trim();
    if (!override && !algorithm) {
      return slot;
    }
  }
  return null;
}

export function algorithmNames(task) {
  return [1, 2, 3]
    .map((slot) => String(task?.[`algorithm_${slot}`] ?? '').trim())
    .filter(Boolean);
}

export function hasManualAllocation(task) {
  return OVERRIDE_KEYS.some((key) => String(task?.[key] ?? '').trim() !== '')
    || OVERRIDE_SHARE_KEYS.some((key) => {
      const raw = task?.[key];
      return raw !== null && raw !== undefined && String(raw).trim() !== '';
    });
}

export function clearAllocationOverridePatch() {
  return {
    ...overrideValuesFromNames([]),
    ...sharePatchFromValues([]),
  };
}

/**
 * X on a chip:
 * - Manual pin with algorithm underneath → clear override (reset to grey algo choice).
 * - Manual-only add → clear override (delete that emp cell).
 * - Pure algorithm chip → clear algorithm_N (delete that emp cell).
 * When the last pin is gone, drop shares so algo equal split returns.
 * When headcount drops and other pins remain, re-equalize shares for who is left.
 */
export function unpinAllocationSlotPatch(task, slotNumber) {
  const slot = Number(slotNumber);
  const override = String(task?.[`override_${slot}`] ?? '').trim();
  const algorithm = String(task?.[`algorithm_${slot}`] ?? '').trim();
  const beforeCount = buildAllocationSlots(task).length;
  const patch = {};

  if (override) {
    patch[`override_${slot}`] = '';
  } else if (algorithm) {
    patch[`algorithm_${slot}`] = '';
  } else {
    return patch;
  }

  const nextTask = { ...task, ...patch };
  const afterSlots = buildAllocationSlots(nextTask);
  const remainingOverrides = OVERRIDE_KEYS.some((key) => String(nextTask?.[key] ?? '').trim() !== '');

  if (!remainingOverrides) {
    Object.assign(patch, sharePatchFromValues([]));
  } else if (afterSlots.length !== beforeCount) {
    Object.assign(patch, sharePatchForSlots(afterSlots, equalHourShares(afterSlots.length)));
  }

  return patch;
}

/**
 * Shares for the current display slots: stored overrides first, else BE-aligned equal split.
 * Prefer physical-slot values (override_share_N); fall back to packed share_1..count for legacy rows.
 */
export function displayHourShares(task, slotCount) {
  const count = Number(slotCount) || 0;
  if (count <= 0) {
    return [];
  }

  const anyStored = OVERRIDE_SHARE_KEYS.slice(0, count).some((key) => {
    const raw = task?.[key];
    return raw !== null && raw !== undefined && String(raw).trim() !== '';
  });
  if (anyStored) {
    return storedHourShares(task, count);
  }

  return equalHourShares(count);
}

/**
 * @param {object} task
 * @param {Array<{ slot: number }>} slots
 * @return {number[]}
 */
export function displayHourSharesForSlots(task, slots = []) {
  const list = Array.isArray(slots) ? slots : [];
  const count = list.length;
  if (count <= 0) {
    return [];
  }

  const defaults = equalHourShares(count);
  const bySlot = [];
  let anyPhysical = false;
  list.forEach((slot, index) => {
    const slotNumber = Number(slot?.slot);
    const raw = Number.isFinite(slotNumber)
      ? task?.[`override_share_${slotNumber}`]
      : null;
    const numeric = Number(raw);
    if (raw !== null && raw !== undefined && String(raw).trim() !== '' && Number.isFinite(numeric)) {
      bySlot.push(Math.max(0, Math.min(100, Math.round(numeric))));
      anyPhysical = true;
    } else {
      bySlot.push(defaults[index] ?? 0);
    }
  });

  if (anyPhysical) {
    const sum = bySlot.reduce((total, value) => total + value, 0);
    if (sum <= 0) {
      return defaults;
    }
    if (Math.abs(sum - 100) > 0.5) {
      return bySlot.map((value) => Math.max(0, Math.min(100, Math.round((value * 100) / sum))));
    }
    return bySlot;
  }

  // Legacy rows wrote shares by packed index (share_1 = first chip), not physical slot.
  return displayHourShares(task, count);
}

/**
 * When one employee's share changes, adjust the others so shares still total 100%.
 * Remaining percent is split proportionally to the others' previous shares (snapped to 10%).
 */
export function redistributeHourShares(shares, index, nextValue) {
  const numeric = Number(nextValue);
  if (!Array.isArray(shares) || shares.length === 0 || !Number.isFinite(numeric)) {
    return shares;
  }

  const clamped = Math.max(0, Math.min(100, Math.round(numeric / 10) * 10));
  if (shares.length === 1) {
    return [100];
  }

  const next = shares.map((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  next[index] = clamped;

  const otherIndexes = next
    .map((_, other) => other)
    .filter((other) => other !== index);
  const remaining = 100 - clamped;

  if (otherIndexes.length === 1) {
    next[otherIndexes[0]] = remaining;
    return next;
  }

  const weights = otherIndexes.map((other) => Math.max(0, Number(shares[other]) || 0));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  let given = 0;
  otherIndexes.forEach((other, offset) => {
    if (offset === otherIndexes.length - 1) {
      next[other] = remaining - given;
      return;
    }
    const part = weightSum > 0
      ? Math.round(((weights[offset] / weightSum) * remaining) / 10) * 10
      : Math.round((remaining / otherIndexes.length) / 10) * 10;
    next[other] = part;
    given += part;
  });

  return next;
}

export const SHARE_PERCENT_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export function sharePercentOptions(shares = []) {
  const steps = new Set(SHARE_PERCENT_STEPS);
  (Array.isArray(shares) ? shares : []).forEach((value) => {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      steps.add(Math.max(0, Math.min(100, Math.round(numeric))));
    }
  });
  return [...steps].sort((left, right) => left - right);
}

export const COMPLETION_PERCENT_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export function completionPercentOptions(currentValue) {
  const current = percentDisplay(currentValue);
  const steps = COMPLETION_PERCENT_STEPS.map(String);
  if (current !== '' && !steps.includes(current)) {
    return [...steps, current].sort((left, right) => Number(left) - Number(right));
  }
  return steps;
}
