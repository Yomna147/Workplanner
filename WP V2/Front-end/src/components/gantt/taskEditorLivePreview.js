import { addDays, parseYmd } from './ganttUtils';
import { HISTOGRAM_DEFAULT_WORK_DAY_HOURS } from './histogramLayout';
import { recalculatePdeDerivedFields, parseTaskProgressPercent } from '../../utils/taskCalculations';
import { normalizeTaskOverrideFields, effectiveTaskOverride } from '../../utils/taskOverrides';
import {
  assigneeNameMatches,
  findAssigneeOverrideSlot,
  isAssignableWorkday,
} from './histogramBarEdits';

function normalizeTaskDate(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  return parseYmd(text.slice(0, 10)) || text.slice(0, 10);
}

function ymdToUtcDate(ymd) {
  const normalized = parseYmd(ymd);
  if (!normalized) {
    return null;
  }
  const [year, month, day] = normalized.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function resolveLayoutContext(bar, task, options = {}) {
  if (options.layoutContext) {
    return options.layoutContext;
  }
  const rowName = String(bar?.employee || task?.algorithm_1 || '').trim();
  return rowName ? { rowName } : {};
}

/** Signed assignable workday count between dates — matches histogram bar drag. */
function workdayDelta(fromYmd, toYmd, layoutContext = {}) {
  const from = ymdToUtcDate(fromYmd);
  const to = ymdToUtcDate(toYmd);
  if (!from || !to || from.getTime() === to.getTime()) {
    return 0;
  }
  const step = to.getTime() > from.getTime() ? 1 : -1;
  let count = 0;
  const cursor = new Date(from.getTime());
  while (
    (step > 0 && cursor.getTime() < to.getTime())
    || (step < 0 && cursor.getTime() > to.getTime())
  ) {
    cursor.setUTCDate(cursor.getUTCDate() + step);
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cursor.getUTCDate()).padStart(2, '0');
    if (isAssignableWorkday(`${y}-${m}-${d}`, layoutContext)) {
      count += step;
    }
  }
  return count;
}

function shiftDayByWorkdays(day, deltaWorkdays, layoutContext = {}) {
  if (!day || !deltaWorkdays) {
    return day;
  }
  const step = deltaWorkdays > 0 ? 1 : -1;
  let remaining = Math.abs(deltaWorkdays);
  let cursor = day;
  let guard = 0;
  while (remaining > 0 && guard < 366) {
    cursor = addDays(cursor, step);
    guard += 1;
    if (!cursor) {
      return null;
    }
    if (isAssignableWorkday(cursor, layoutContext)) {
      remaining -= 1;
    }
  }
  return cursor;
}

function roundQuarterHours(value) {
  return Math.round(value * 4) / 4;
}

function parsePlanHours(task) {
  const plan = Number.parseFloat(String(task?.plan ?? '').trim());
  return Number.isFinite(plan) && plan >= 0 ? plan : null;
}

function taskPlanHoursChanged(task, baseline) {
  if (!baseline) {
    return false;
  }
  const nextPlan = parsePlanHours(task);
  const prevPlan = parsePlanHours(baseline);
  if (nextPlan === null && prevPlan === null) {
    return false;
  }
  if (nextPlan === null || prevPlan === null) {
    return true;
  }
  return Math.abs(nextPlan - prevPlan) > 0.001;
}

function scaleHoursByDayRatio(hoursByDay, ratio) {
  if (!hoursByDay || !Number.isFinite(ratio) || Math.abs(ratio - 1) <= 0.001) {
    return hoursByDay || {};
  }
  if (ratio <= 0) {
    return {};
  }

  const entries = Object.entries(hoursByDay)
    .filter(([, hours]) => (Number(hours) || 0) > 0.001);
  if (!entries.length) {
    return {};
  }

  const targetTotal = roundQuarterHours(
    entries.reduce((sum, [, hours]) => sum + (Number(hours) || 0), 0) * ratio,
  );
  const next = {};
  let assigned = 0;

  entries.forEach(([day, hours], index) => {
    if (index === entries.length - 1) {
      next[day] = roundQuarterHours(Math.max(0, targetTotal - assigned));
      return;
    }
    const scaled = roundQuarterHours((Number(hours) || 0) * ratio);
    next[day] = scaled;
    assigned += scaled;
  });

  return next;
}

/**
 * Cap each day to AVA (default 8h) and spill overflow onto later workdays in
 * the task window so Plan edits cannot recreate 9h/8h overbooks.
 */
function redistributeHoursRespectingDayCap(hoursByDay, {
  dayCap = HISTOGRAM_DEFAULT_WORK_DAY_HOURS,
  windowStart = null,
  windowEnd = null,
  layoutContext = {},
} = {}) {
  const safeCap = Number.isFinite(dayCap) && dayCap > 0
    ? dayCap
    : HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
  const next = {};
  let overflow = 0;

  Object.keys(hoursByDay || {})
    .filter((day) => (Number(hoursByDay[day]) || 0) > 0.001 && isAssignableWorkday(day, layoutContext))
    .sort()
    .forEach((day) => {
      const hours = roundQuarterHours(Number(hoursByDay[day]) || 0);
      const placed = Math.min(hours, safeCap);
      if (placed > 0.001) {
        next[day] = placed;
      }
      overflow = roundQuarterHours(overflow + Math.max(0, hours - placed));
    });

  if (overflow <= 0.001) {
    return next;
  }

  const fillRoom = (day) => {
    if (!day || !isAssignableWorkday(day, layoutContext) || overflow <= 0.001) {
      return;
    }
    if (windowStart && day < windowStart) {
      return;
    }
    if (windowEnd && day > windowEnd) {
      return;
    }
    const used = Number(next[day]) || 0;
    const room = roundQuarterHours(Math.max(0, safeCap - used));
    if (room <= 0.001) {
      return;
    }
    const take = Math.min(room, overflow);
    next[day] = roundQuarterHours(used + take);
    overflow = roundQuarterHours(overflow - take);
  };

  // Prefer existing schedule days first, then walk forward from the last day.
  Object.keys(next).sort().forEach((day) => fillRoom(day));

  let cursor = Object.keys(next).sort().at(-1)
    || windowStart
    || Object.keys(hoursByDay || {}).sort().at(-1);
  for (let guard = 0; guard < 120 && overflow > 0.001 && cursor; guard += 1) {
    cursor = addDays(cursor, 1);
    if (!cursor) {
      break;
    }
    if (windowEnd && cursor > windowEnd) {
      break;
    }
    if (!isAssignableWorkday(cursor, layoutContext)) {
      continue;
    }
    fillRoom(cursor);
  }

  return next;
}

function scaleHoursByDayRatioRespectingCap(hoursByDay, ratio, options = {}) {
  const scaled = scaleHoursByDayRatio(hoursByDay, ratio);
  return redistributeHoursRespectingDayCap(scaled, options);
}

function shiftHoursByDay(hoursByDay, deltaWorkdays, layoutContext = {}) {
  if (!hoursByDay || !deltaWorkdays) {
    return hoursByDay || {};
  }

  const next = {};
  Object.entries(hoursByDay).forEach(([day, hours]) => {
    const amount = Number(hours) || 0;
    if (amount <= 0.001) {
      return;
    }
    const shifted = shiftDayByWorkdays(day, deltaWorkdays, layoutContext);
    if (!shifted || !isAssignableWorkday(shifted, layoutContext)) {
      return;
    }
    next[shifted] = (next[shifted] || 0) + amount;
  });
  return next;
}

function trimHoursToDateRange(hoursByDay, startYmd, endYmd, layoutContext = {}) {
  if (!startYmd || !endYmd) {
    return hoursByDay || {};
  }

  const next = {};
  Object.entries(hoursByDay || {}).forEach(([day, hours]) => {
    const amount = Number(hours) || 0;
    if (amount <= 0.001) {
      return;
    }
    if (day >= startYmd && day <= endYmd && isAssignableWorkday(day, layoutContext)) {
      next[day] = amount;
    }
  });
  return next;
}

function barTotalHours(bar) {
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

function resolveBarEmployeeFromOverrideEdit(task, bar, baselineTask, peerBars = []) {
  const currentEmployee = String(bar.employee || '').trim();
  if (!currentEmployee) {
    return currentEmployee;
  }

  if (!baselineTask) {
    const slotSource = {
      algorithm_1: task.algorithm_1 ?? bar.algorithm_1,
      algorithm_2: task.algorithm_2 ?? bar.algorithm_2,
      algorithm_3: task.algorithm_3 ?? bar.algorithm_3,
      override_1: task.override_1 ?? bar.override_1,
      override_2: task.override_2 ?? bar.override_2,
      override_3: task.override_3 ?? bar.override_3,
    };
    const slot = findAssigneeOverrideSlot(slotSource, currentEmployee);
    const nextAssignee = String(task[slot] || '').trim();
    if (nextAssignee && !assigneeNameMatches(nextAssignee, currentEmployee)) {
      return nextAssignee;
    }
    return currentEmployee;
  }

  for (const slotNumber of ['1', '2', '3']) {
    const slotKey = `override_${slotNumber}`;
    if (!taskFieldChanged(task, baselineTask, slotKey)) {
      continue;
    }

    const algoKey = `algorithm_${slotNumber}`;
    const algoAssignee = String(task[algoKey] ?? bar[algoKey] ?? '').trim();
    const prevOverride = effectiveTaskOverride(baselineTask, slotNumber);
    const nextOverride = effectiveTaskOverride(task, slotNumber);
    const prevEffective = prevOverride || algoAssignee;
    const nextEffective = nextOverride || algoAssignee;

    if (!assigneeNameMatches(currentEmployee, prevEffective)) {
      continue;
    }

    const peers = (peerBars || []).filter((entry) => (
      String(entry.task_id) === String(bar.task_id)
      && !entry._suppressedByBarEdit
      && assigneeNameMatches(entry.employee, prevEffective)
    ));
    if (peers.length > 1) {
      const dominant = peers.reduce((best, entry) => (
        barTotalHours(entry) > barTotalHours(best) ? entry : best
      ));
      if (dominant.id !== bar.id) {
        continue;
      }
    }

    if (!assigneeNameMatches(currentEmployee, nextEffective)) {
      return nextEffective;
    }
    return currentEmployee;
  }

  return currentEmployee;
}

function buildOverridePatch(task, baseline) {
  if (!baseline) {
    return {};
  }

  const patch = {};
  ['override_1', 'override_2', 'override_3'].forEach((key) => {
    if (taskFieldChanged(task, baseline, key)) {
      patch[key] = task[key] ?? '';
    }
  });
  return patch;
}

function taskFieldValue(task, key, { date = false } = {}) {
  if (date) {
    return normalizeTaskDate(task?.[key]);
  }
  if (key?.startsWith('override_')) {
    return effectiveTaskOverride(task, key.replace('override_', ''));
  }
  return String(task?.[key] ?? '');
}

function taskFieldChanged(task, baseline, key, options = {}) {
  if (!baseline) {
    return false;
  }
  return taskFieldValue(task, key, options) !== taskFieldValue(baseline, key, options);
}

function taskDraftScheduleChanged(task, baseline) {
  if (!baseline) {
    return false;
  }
  if (taskFieldChanged(task, baseline, 'doc_supply', { date: true })) {
    return true;
  }
  if (taskFieldChanged(task, baseline, 'completion', { date: true })) {
    return true;
  }
  return false;
}

export function taskDraftOverrideChanged(task, baseline) {
  if (!baseline) {
    return false;
  }
  return ['override_1', 'override_2', 'override_3'].some(
    (key) => taskFieldChanged(task, baseline, key),
  );
}

export function taskDraftAffectsHistogram(task, baseline) {
  if (!baseline) {
    return false;
  }
  return taskDraftScheduleChanged(task, baseline)
    || taskDraftOverrideChanged(task, baseline)
    || taskPlanHoursChanged(task, baseline);
}

function syncTaskAssigneeFieldsToBar(bar, task) {
  return {
    algorithm_1: task.algorithm_1 ?? bar.algorithm_1,
    algorithm_2: task.algorithm_2 ?? bar.algorithm_2,
    algorithm_3: task.algorithm_3 ?? bar.algorithm_3,
    override_1: effectiveTaskOverride(task, '1'),
    override_2: effectiveTaskOverride(task, '2'),
    override_3: effectiveTaskOverride(task, '3'),
  };
}

function applyTaskProgressFieldsToBar(bar, task) {
  const percent = parseTaskProgressPercent(task);
  return {
    ...bar,
    task_name: task.task_name || bar.task_name,
    progress: percent,
    progress_per: task.progress_per != null && String(task.progress_per).trim() !== ''
      ? String(task.progress_per).trim().replace(/%$/, '')
      : String(percent),
    done: Boolean(task.done),
    plan: task.plan ?? bar.plan,
    est: task.est ?? bar.est,
    act: task.act ?? bar.act,
    duration_left: task.duration_left ?? bar.duration_left,
    con: task.con ?? bar.con,
    ats: task.ats ?? bar.ats,
    sp: task.sp ?? bar.sp,
    pp: task.pp ?? bar.pp,
    pri: task.pri ?? bar.pri,
  };
}

/**
 * Apply live PDE task-editor draft fields onto a histogram bar so the chart
 * updates before "Save to PDE".
 */
export function applyTaskDraftToBar(bar, task, options = {}) {
  if (!bar || !task || String(bar.task_id) !== String(task.id)) {
    return bar;
  }

  const baseline = options.baseline ?? null;
  const peerBars = options.peerBars ?? [];
  const layoutContext = resolveLayoutContext(bar, task, options);
  const scheduleChanged = taskDraftScheduleChanged(task, baseline);
  const overrideChanged = taskDraftOverrideChanged(task, baseline);
  const planHoursChanged = taskPlanHoursChanged(task, baseline);

  if (!scheduleChanged && !overrideChanged && !planHoursChanged) {
    return applyTaskProgressFieldsToBar(bar, task);
  }

  if (!scheduleChanged && !planHoursChanged) {
    const employee = resolveBarEmployeeFromOverrideEdit(task, bar, baseline, peerBars);
    return {
      ...applyTaskProgressFieldsToBar(bar, task),
      ...syncTaskAssigneeFieldsToBar(bar, task),
      employee,
    };
  }

  const nextDocSupply = normalizeTaskDate(task.doc_supply) || bar.doc_supply;
  const nextCompletion = normalizeTaskDate(task.completion) || bar.completion;
  const docSupplyChanged = taskFieldChanged(task, baseline, 'doc_supply', { date: true });
  const completionChanged = taskFieldChanged(task, baseline, 'completion', { date: true });
  const prevDocSupply = normalizeTaskDate(baseline?.doc_supply) || bar.doc_supply;
  const prevCompletion = normalizeTaskDate(baseline?.completion) || bar.completion;

  let hoursByDay = { ...(bar.hours_by_day || {}) };

  if (docSupplyChanged && !completionChanged) {
    const deltaDays = workdayDelta(prevDocSupply, nextDocSupply, layoutContext);
    hoursByDay = shiftHoursByDay(hoursByDay, deltaDays, layoutContext);
  } else if (completionChanged && !docSupplyChanged) {
    hoursByDay = trimHoursToDateRange(hoursByDay, nextDocSupply, nextCompletion, layoutContext);
  } else if (docSupplyChanged && completionChanged && nextDocSupply && nextCompletion) {
    const deltaDays = workdayDelta(prevDocSupply, nextDocSupply, layoutContext);
    if (deltaDays) {
      hoursByDay = shiftHoursByDay(hoursByDay, deltaDays, layoutContext);
    }
    hoursByDay = trimHoursToDateRange(hoursByDay, nextDocSupply, nextCompletion, layoutContext);
  }

  if (planHoursChanged) {
    const prevPlan = parsePlanHours(baseline);
    const nextPlan = parsePlanHours(task);
    if (prevPlan != null && prevPlan > 0.001 && nextPlan != null) {
      const ratio = nextPlan / prevPlan;
      hoursByDay = scaleHoursByDayRatioRespectingCap(
        hoursByDay,
        ratio,
        {
          dayCap: options.dayCapacityHours ?? HISTOGRAM_DEFAULT_WORK_DAY_HOURS,
          windowStart: nextDocSupply,
          // Adj/Plan increases may need spill past the current completion date.
          windowEnd: ratio > 1.001 ? null : nextCompletion,
          layoutContext,
        },
      );
    }
  }

  const activeDays = Object.keys(hoursByDay)
    .filter((day) => (Number(hoursByDay[day]) || 0) > 0.001)
    .sort();
  const hours = activeDays.reduce((sum, day) => sum + (Number(hoursByDay[day]) || 0), 0);
  const employee = resolveBarEmployeeFromOverrideEdit(task, bar, baseline, peerBars);
  const scheduleEnd = activeDays.at(-1) || bar.end;
  let barCompletion = completionChanged ? (nextCompletion || bar.completion) : bar.completion;
  if (
    planHoursChanged
    && !completionChanged
    && scheduleEnd
    && normalizeTaskDate(barCompletion)
    && scheduleEnd > normalizeTaskDate(barCompletion)
  ) {
    barCompletion = scheduleEnd;
  }

  return {
    ...applyTaskProgressFieldsToBar(bar, task),
    ...syncTaskAssigneeFieldsToBar(bar, task),
    doc_supply: docSupplyChanged ? (nextDocSupply || bar.doc_supply) : bar.doc_supply,
    completion: barCompletion,
    start: activeDays[0] || bar.start,
    end: scheduleEnd,
    hours_by_day: hoursByDay,
    hours: hours > 0.001 ? hours : bar.hours,
    employee,
  };
}

export function applyTaskDraftToBars(bars, task, baselineTask = null) {
  return applyTaskDraftToTaskBars(bars, task, baselineTask);
}

/**
 * Apply task-editor draft to every histogram bar for the task, including
 * override propagation and duplicate suppression when an override reassigns a bar.
 */
export function applyTaskDraftToTaskBars(bars, task, baselineTask = null, options = {}) {
  if (!Array.isArray(bars) || !task?.id) {
    return bars;
  }

  const taskId = String(task.id);
  const resetSuppressed = options.resetSuppressed
    ?? taskDraftOverrideChanged(task, baselineTask);
  const taskBars = bars.filter((bar) => {
    if (String(bar.task_id) !== taskId) {
      return false;
    }
    if (resetSuppressed) {
      return true;
    }
    return !bar._suppressedByBarEdit;
  });

  if (taskBars.length === 0) {
    return bars;
  }

  const overridePatch = buildOverridePatch(task, baselineTask);
  const updatedById = new Map();

  taskBars.forEach((bar) => {
    let next = applyTaskDraftToBar(bar, task, {
      baseline: baselineTask,
      peerBars: taskBars,
      dayCapacityHours: options.dayCapacityHours,
      layoutContext: options.layoutContext,
    });
    if (Object.keys(overridePatch).length > 0) {
      next = { ...next, ...overridePatch };
    }
    updatedById.set(bar.id, next);
  });

  taskBars.forEach((bar) => {
    const next = updatedById.get(bar.id);
    if (!next || assigneeNameMatches(bar.employee, next.employee)) {
      return;
    }

    taskBars.forEach((other) => {
      if (other.id === bar.id) {
        return;
      }

      const otherNext = updatedById.get(other.id);
      if (!otherNext || otherNext._suppressedByBarEdit) {
        return;
      }

      if (!assigneeNameMatches(other.employee, next.employee)) {
        return;
      }

      updatedById.set(other.id, {
        ...otherNext,
        hours_by_day: {},
        hours: 0,
        start: next.start,
        end: next.start,
        _suppressedByBarEdit: bar.id,
        ...overridePatch,
      });
    });
  });

  return bars.map((bar) => updatedById.get(bar.id) ?? bar);
}

function barScheduleStart(bar) {
  const days = Object.entries(bar?.hours_by_day || {})
    .filter(([, hours]) => (Number(hours) || 0) > 0.001)
    .map(([day]) => day)
    .sort();
  return normalizeTaskDate(days[0] || bar?.start);
}

function barScheduleEnd(bar) {
  const days = Object.entries(bar?.hours_by_day || {})
    .filter(([, hours]) => (Number(hours) || 0) > 0.001)
    .map(([day]) => day)
    .sort();
  return normalizeTaskDate(days.at(-1) || bar?.end);
}

/** Earliest start / latest finish across all visible bars for a task. */
export function resolveTaskBarsDateEnvelope(bars = []) {
  let earliest = null;
  let latest = null;

  bars.forEach((bar) => {
    if (!bar || bar._suppressedByBarEdit) {
      return;
    }
    const start = barScheduleStart(bar);
    const end = barScheduleEnd(bar);
    if (start && (!earliest || start < earliest)) {
      earliest = start;
    }
    if (end && (!latest || end > latest)) {
      latest = end;
    }
  });

  return { start: earliest, end: latest };
}

function roundAdjHours(value) {
  return Math.round(value * 4) / 4;
}

function sumBarsHours(bars = []) {
  return bars.reduce((sum, entry) => sum + barTotalHours(entry), 0);
}

function applyAdjDelta(task, deltaHours) {
  if (Math.abs(deltaHours) <= 0.001) {
    return { task, changed: false };
  }
  const currentAdj = Number.parseFloat(String(task.adj ?? '').trim());
  const baseAdj = Number.isFinite(currentAdj) ? currentAdj : 0;
  const nextAdj = roundAdjHours(baseAdj + deltaHours);
  const adjValue = nextAdj === 0 ? '' : String(nextAdj);
  if (String(adjValue) === String(task.adj ?? '')) {
    return { task, changed: false };
  }
  return { task: { ...task, adj: adjValue }, changed: true };
}

/**
 * Push histogram bar schedule / assignee changes into the PDE task row
 * so the task editor grid stays in sync after bar drag/resize.
 *
 * options.relatedBars — all bars for the same task (hour totals / Adj).
 * PDE Doc Supply and Completion stay on the task; they are not replaced by
 * the clicked bar's assignment span.
 * options.previousRelatedBars — prior snapshot of those bars (Adj delta when any sibling changes).
 * options.originalRelatedBars — algo/base bars for the task; on open, seed Adj only when empty
 *   and bars disagree with Plan (never stack onto an already-saved Adj).
 * options.nrms — optional NRMs so plan/pri recalculate after Adj changes.
 */
export function applyHistogramBarToTask(task, bar, previousBar = null, options = {}) {
  if (!task || !bar) {
    return task;
  }

  const relatedBars = Array.isArray(options.relatedBars) && options.relatedBars.length > 0
    ? options.relatedBars
    : [bar];

  // Prefer the bar that actually changed among siblings (reassign / resize of another operative).
  let focusBar = bar;
  let focusPrevious = previousBar;
  if (Array.isArray(options.previousRelatedBars) && options.previousRelatedBars.length > 0) {
    const prevById = new Map(
      options.previousRelatedBars.map((entry) => [entry.id, entry]),
    );
    const changed = relatedBars.find((entry) => {
      const prev = prevById.get(entry.id);
      if (!prev) {
        return true;
      }
      return (
        entry.start !== prev.start
        || entry.end !== prev.end
        || Number(entry.hours) !== Number(prev.hours)
        || String(entry.employee || '') !== String(prev.employee || '')
        || entry.override_1 !== prev.override_1
        || entry.override_2 !== prev.override_2
        || entry.override_3 !== prev.override_3
        || JSON.stringify(entry.hours_by_day || {}) !== JSON.stringify(prev.hours_by_day || {})
      );
    });
    if (changed) {
      focusBar = changed;
      focusPrevious = prevById.get(changed.id) || previousBar;
    }
  }

  let next = { ...task };
  let changed = false;

  // Keep PDE Doc Supply / Completion. Assignment span (bar.start / bar.end)
  // is only the histogram fragment that was clicked or resized.

  // Resize hour delta → Adj (and recalculated Plan).
  // Live bar edits: incremental Adj from previousRelatedBars / previousBar.
  // Open seed: only when Adj is empty and bars disagree with Plan — never stack
  // bar-vs-original onto an Adj PDE already saved from a prior resize.
  // applyHourDelta: false — the hour change is not a user resize (for example the
  // view window expanded and previously clipped days became visible).
  let deltaHours = 0;
  if (options.applyHourDelta === false) {
    deltaHours = 0;
  } else if (Array.isArray(options.previousRelatedBars)) {
    deltaHours = sumBarsHours(relatedBars) - sumBarsHours(options.previousRelatedBars);
  } else if (focusPrevious) {
    deltaHours = barTotalHours(focusBar) - barTotalHours(focusPrevious);
  } else if (Array.isArray(options.originalRelatedBars)) {
    const barTotal = sumBarsHours(relatedBars);
    const planHours = parsePlanHours(next);
    const currentAdj = Number.parseFloat(String(next.adj ?? '').trim());
    const adjIsEmpty = !Number.isFinite(currentAdj) || Math.abs(currentAdj) <= 0.001;
    if (
      adjIsEmpty
      && planHours != null
      && Math.abs(barTotal - planHours) > 0.001
    ) {
      deltaHours = barTotal - sumBarsHours(options.originalRelatedBars);
    }
  }

  // Task editor Adj/Plan edits scale bars to match Plan — do not stack the same
  // hour delta onto Adj again when bars already reflect the user's Adj value.
  if (deltaHours) {
    const planHours = parsePlanHours(next);
    const barTotal = sumBarsHours(relatedBars);
    const currentAdj = Number.parseFloat(String(next.adj ?? '').trim());
    if (
      planHours != null
      && Number.isFinite(currentAdj)
      && Math.abs(currentAdj) > 0.001
      && Math.abs(barTotal - planHours) <= 0.25
      && Math.abs(deltaHours - currentAdj) <= 0.25
    ) {
      deltaHours = 0;
    }
  }

  if (deltaHours) {
    const adjResult = applyAdjDelta(next, deltaHours);
    next = adjResult.task;
    changed = changed || adjResult.changed;
  }

  // Copy only override slots that actually changed on the bar (e.g. reassign).
  // Blindly copying all three can wipe other operatives' slots on the task.
  ['override_1', 'override_2', 'override_3'].forEach((key) => {
    if (!focusPrevious) {
      return;
    }
    if (focusBar[key] == null) {
      return;
    }
    const prevValue = focusPrevious ? focusPrevious[key] : undefined;
    const barChanged = !focusPrevious
      || String(prevValue ?? '') !== String(focusBar[key] ?? '');
    if (!barChanged) {
      return;
    }
    if (String(focusBar[key]) !== String(next[key] ?? '')) {
      next[key] = focusBar[key];
      changed = true;
    }
  });

  // Reassign: Override N follows Algorithm N for the dragged-from operative.
  const prevEmp = String(focusPrevious?.employee || '').trim();
  const nextEmp = String(focusBar.employee || '').trim();
  if (prevEmp && nextEmp && !assigneeNameMatches(prevEmp, nextEmp)) {
    const slotSource = {
      ...(focusPrevious || focusBar),
      // Prefer task algorithm slots when the bar copy is incomplete.
      algorithm_1: focusPrevious?.algorithm_1 || focusBar?.algorithm_1 || task.algorithm_1,
      algorithm_2: focusPrevious?.algorithm_2 || focusBar?.algorithm_2 || task.algorithm_2,
      algorithm_3: focusPrevious?.algorithm_3 || focusBar?.algorithm_3 || task.algorithm_3,
      override_1: task.override_1,
      override_2: task.override_2,
      override_3: task.override_3,
    };
    const slot = findAssigneeOverrideSlot(slotSource, prevEmp);

    if (slot && !assigneeNameMatches(next[slot], nextEmp)) {
      next[slot] = nextEmp;
      changed = true;
    }
  }

  if (focusBar.task_name && focusBar.task_name !== next.task_name) {
    next.task_name = focusBar.task_name;
    changed = true;
  }

  if (focusBar.progress_per != null && String(focusBar.progress_per) !== String(next.progress_per ?? '')) {
    next.progress_per = focusBar.progress_per;
    changed = true;
  }

  if (typeof focusBar.done === 'boolean' && Boolean(next.done) !== focusBar.done) {
    next.done = focusBar.done;
    changed = true;
  }

  if (!changed) {
    return task;
  }

  next = normalizeTaskOverrideFields(next);

  if (options.recalculate !== false) {
    next = recalculatePdeDerivedFields(next, { nrms: options.nrms });
  }

  return next;
}
