import { assigneeNamesMatch } from './employeeNames';

function sumBarHours(bar) {
  if (!bar || bar._suppressedByBarEdit) {
    return 0;
  }
  const explicit = Number(bar.hours);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return Object.values(bar.hours_by_day || {}).reduce(
    (sum, hours) => sum + (Number(hours) || 0),
    0,
  );
}

function readExplicitOverrideForSlot(task, bars, slotNumber) {
  const overrideKey = `override_${slotNumber}`;
  const algorithmKey = `algorithm_${slotNumber}`;
  const algorithmEmployee = String(task?.[algorithmKey] || '').trim();

  let chosen = '';
  let chosenHours = 0;

  bars.forEach((bar) => {
    const barOverride = String(bar[overrideKey] || '').trim();
    if (!barOverride) {
      return;
    }
    if (algorithmEmployee && assigneeNamesMatch(barOverride, algorithmEmployee)) {
      return;
    }
    const hours = sumBarHours(bar);
    if (!chosen || hours > chosenHours) {
      chosen = barOverride;
      chosenHours = hours;
    }
  });

  if (!chosen) {
    const taskOverride = String(task?.[overrideKey] || '').trim();
    if (taskOverride && (!algorithmEmployee || !assigneeNamesMatch(taskOverride, algorithmEmployee))) {
      chosen = taskOverride;
    }
  }

  return chosen;
}

/**
 * When opening the histogram task editor, derive override slots from the
 * operatives that actually have bars on the chart (not stale algorithm-only data).
 */
export function deriveTaskOverridesFromRelatedBars(task, bars = []) {
  if (!task) {
    return task;
  }

  const activeBars = (bars || []).filter((bar) => (
    bar && !bar._suppressedByBarEdit && sumBarHours(bar) > 0.001
  ));
  if (!activeBars.length) {
    return { ...task };
  }

  const hoursByEmployee = new Map();
  activeBars.forEach((bar) => {
    const employee = String(bar.employee || '').trim();
    if (!employee) {
      return;
    }
    hoursByEmployee.set(
      employee,
      (hoursByEmployee.get(employee) || 0) + sumBarHours(bar),
    );
  });

  const next = { ...task };
  const usedEmployees = new Set();

  // Pass 1: histogram reassign writes override_N onto every sibling bar.
  ['1', '2', '3'].forEach((slotNumber) => {
    const overrideKey = `override_${slotNumber}`;
    const explicit = readExplicitOverrideForSlot(next, activeBars, slotNumber);
    if (explicit) {
      next[overrideKey] = explicit;
      usedEmployees.add(explicit);
    }
  });

  // Pass 2: infer remaining slots from non-algorithm bar employees (by hours).
  // Do not match algorithm names first — a stale algorithm bar must not steal a slot.
  ['1', '2', '3'].forEach((slotNumber) => {
    const overrideKey = `override_${slotNumber}`;
    const algorithmKey = `algorithm_${slotNumber}`;
    const algorithmEmployee = String(next[algorithmKey] || '').trim();

    if (next[overrideKey]) {
      if (algorithmEmployee && assigneeNamesMatch(next[overrideKey], algorithmEmployee)) {
        usedEmployees.delete(next[overrideKey]);
        next[overrideKey] = '';
      }
      return;
    }

    if (!algorithmEmployee) {
      return;
    }

    let algorithmHours = 0;
    hoursByEmployee.forEach((hours, employee) => {
      if (assigneeNamesMatch(employee, algorithmEmployee)) {
        algorithmHours += hours;
      }
    });

    let replacement = '';
    let replacementHours = 0;
    hoursByEmployee.forEach((hours, employee) => {
      if (usedEmployees.has(employee)) {
        return;
      }
      if (assigneeNamesMatch(employee, algorithmEmployee)) {
        return;
      }
      const matchesOtherAlgorithm = ['1', '2', '3'].some((slot) => {
        if (slot === slotNumber) {
          return false;
        }
        const otherAlgorithm = String(next[`algorithm_${slot}`] || '').trim();
        return otherAlgorithm && assigneeNamesMatch(employee, otherAlgorithm);
      });
      if (matchesOtherAlgorithm) {
        return;
      }
      if (hours > replacementHours) {
        replacementHours = hours;
        replacement = employee;
      }
    });

    if (!replacement || algorithmHours > replacementHours) {
      return;
    }

    next[overrideKey] = replacement;
    usedEmployees.add(replacement);
  });

  return next;
}

/**
 * Override N is only meaningful when it differs from Algorithm N.
 * Empty string means "use the algorithm assignee".
 */
export function effectiveTaskOverride(task, slotNumber) {
  const slot = String(slotNumber);
  const overrideKey = `override_${slot}`;
  const algorithmKey = `algorithm_${slot}`;
  const override = String(task?.[overrideKey] ?? '').trim();
  const algorithm = String(task?.[algorithmKey] ?? '').trim();

  if (!override) {
    return '';
  }

  if (algorithm && assigneeNamesMatch(override, algorithm)) {
    return '';
  }

  return task[overrideKey];
}

/** Clear override slots that merely repeat the algorithm assignee. */
export function normalizeTaskOverrideFields(task) {
  if (!task) {
    return task;
  }

  const next = { ...task };
  ['1', '2', '3'].forEach((slot) => {
    const overrideKey = `override_${slot}`;
    next[overrideKey] = effectiveTaskOverride(next, slot);
  });

  return next;
}
