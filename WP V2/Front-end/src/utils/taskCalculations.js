import { recalculateTaskPri } from '../constants/projectTaskFields';
import { applyDlMirrorOnChange } from './dlMirrorFields';
import { applyDlSectionSplitChange } from './dlSectionRatio';
import { DL_BUDGET_HOUR_KEYS } from './taskSectionDetailCalculations';
import { toStorageDate } from './dateFormat';
import { normalizeTaskRapFromNrm } from './nrmTasks';
import { syncTaskDoneAndProgress } from './pdeDoneEffects';
import { defaultHrsPerForTaskName } from './taskSectionDefaults';

function parseNum(value) {
  const num = parseFloat(value);
  return Number.isNaN(num) ? 0 : num;
}

function parseOptionalNum(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const num = parseFloat(value);
  return Number.isNaN(num) ? null : num;
}

function resolveHrsPer(row) {
  const userHrsPer = parseOptionalNum(row.hrs_per);
  if (userHrsPer !== null) {
    return userHrsPer;
  }

  const est = parseOptionalNum(row.est);
  if (est !== null && est > 0) {
    return defaultHrsPerForTaskName(row.task_name);
  }

  return null;
}

export function recalculateRedFromEst(row) {
  const est = parseOptionalNum(row.est);
  const hrsPer = resolveHrsPer(row);
  if (est === null || est <= 0 || hrsPer === null) {
    return '';
  }

  return String(Math.max(0, Math.round(est * (hrsPer / 100))));
}

export function recalculatePlanFromHours(row, { applyDlReduction = false } = {}) {
  const pd = parseOptionalNum(row.pd);
  const dl = parseOptionalNum(row.dl);
  const est = parseOptionalNum(row.est);
  const buf = parseNum(row.buf);
  const adj = parseNum(row.adj);
  const hrsPer = resolveHrsPer(row);

  let calculatedPlan = null;

  if (pd !== null) {
    const basePlan = pd + buf;
    calculatedPlan =
      hrsPer !== null
        ? Math.round(basePlan * (hrsPer / 100) + adj)
        : Math.round(basePlan + adj);
  } else if (dl !== null) {
    calculatedPlan = Math.round(dl + buf + adj);
  } else if (est !== null) {
    const redValue =
      hrsPer !== null ? Math.max(0, Math.round(est * (hrsPer / 100))) : 0;
    if (buf === 0 && adj === 0) {
      calculatedPlan = redValue;
    } else if (hrsPer !== null) {
      const reducedBuf = buf * (hrsPer / 100);
      calculatedPlan = Math.round(redValue + reducedBuf + adj);
    } else {
      calculatedPlan = Math.round(buf + adj);
    }
  }

  if (calculatedPlan === null) {
    return row.plan ?? '';
  }

  let plan = calculatedPlan;
  if (applyDlReduction) {
    plan = Math.max(0, Math.ceil(plan * 0.8));
  }

  return String(Math.max(0, plan));
}

/** Human-readable formula for the Plan field tooltip. */
export function getPlanCalculationTooltip(row, { applyDlReduction = false } = {}) {
  const pd = parseOptionalNum(row?.pd);
  const dl = parseOptionalNum(row?.dl);
  const est = parseOptionalNum(row?.est);
  const buf = parseNum(row?.buf);
  const adj = parseNum(row?.adj);
  const hrsPer = resolveHrsPer(row);

  const suffix = applyDlReduction ? ' (rounded up, ×0.8 on DL page)' : ' (rounded)';

  if (pd !== null) {
    const scaled = hrsPer !== null ? ` × ${hrsPer}% + Adj (${adj})` : ` + Adj (${adj})`;
    return `Plan = (PD (${pd}) + Buf (${buf}))${scaled}${suffix}`;
  }
  if (dl !== null) {
    return `Plan = DL (${dl}) + Buf (${buf}) + Adj (${adj})${suffix}`;
  }
  if (est !== null) {
    const red = recalculateRedFromEst(row);
    if (buf === 0 && adj === 0 && red !== '') {
      return `Plan = Red (${red})${suffix}`;
    }
    const scaled = hrsPer !== null ? ` × ${hrsPer}%` : '';
    return `Plan = (Est (${est}) + Buf (${buf}) + Adj (${adj}))${scaled}${suffix}`;
  }
  return 'Plan — no PD, DL, or Est hours to calculate from';
}

/** Parse task/bar completion % (0–100) for PDE, personal summary, and histogram bars. */
export function parseTaskProgressPercent(task) {
  if (task?.done) {
    return 100;
  }

  const raw = task?.progress_per ?? task?.progress;
  if (raw == null || String(raw).trim() === '') {
    return 0;
  }

  const normalized = String(raw).trim().replace(/%$/, '');
  const num = Number(normalized);
  if (!Number.isFinite(num)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(num)));
}

export function recalculateProgressLeft(row) {
  const plan = parseNum(row.plan);
  if (row.progress_per === '' || row.progress_per == null) {
    return {
      progress_left_hours: row.progress_left_hours ?? '',
    };
  }

  const per = Math.min(100, Math.max(0, parseNum(row.progress_per)));
  return {
    progress_per: String(per),
    progress_left_hours: plan > 0
      ? String(Math.max(0, Math.round(plan * (1 - per / 100))))
      : row.progress_left_hours ?? '',
  };
}

function recalculateProgressFromAct(row) {
  const plan = parseNum(row.plan);
  const act = parseNum(row.act);
  if (act > 0 && plan > 0) {
    const per = Math.min(100, Math.max(0, Math.round((act / plan) * 100)));
    return {
      progress_per: String(per),
      progress_left_hours: String(Math.max(0, Math.round(plan * (1 - per / 100)))),
    };
  }

  return recalculateProgressLeft(row);
}

export function recalculateDurationLeft(row) {
  if (row.plan === '' && row.act === '' && row.pre === '') {
    return '';
  }

  const plan = parseNum(row.plan);
  const act = parseNum(row.act);
  const pre = parseNum(row.pre);
  return String(Math.max(0, Math.round(plan - act - pre)));
}

/** Recalculate all PDE derived columns from the current row values. */
export function recalculatePdeDerivedFields(task, { nrms, respectManualProgressPer = false } = {}) {
  let next = { ...task };
  if (nrms?.length) {
    next = normalizeTaskRapFromNrm(next, nrms);
  }

  const hrsPer = resolveHrsPer(next);
  if (hrsPer !== null) {
    next.hrs_per = String(hrsPer);
  }

  next.red = recalculateRedFromEst(next);
  next.plan = recalculatePlanFromHours(next, { applyDlReduction: false });
  next.pri = recalculateTaskPri(next);
  // Done means complete: keep 100% even when Act/Plan (e.g. TT import) would derive less.
  if (Boolean(next.done)) {
    next.progress_per = '100';
    Object.assign(next, recalculateProgressLeft(next));
  } else {
    Object.assign(
      next,
      respectManualProgressPer ? recalculateProgressLeft(next) : recalculateProgressFromAct(next),
    );
  }
  next.duration_left = recalculateDurationLeft(next);
  next.progress_plan = next.plan ?? '';
  return syncShareHoursMirrorFields(syncTeamSizeMirrorFields(next));
}

const CALCULATED_FIELD_KEYS = new Set([
  'plan',
  'progress_plan',
  'tt_hours_logged',
  'pri',
  'progress_left_hours',
  'duration_left',
  'red',
  'ats',
  'ts',
]);

const PLAN_RECALC_FIELDS = new Set([
  'pd',
  'dl',
  'est',
  'sh',
  'buf',
  'adj',
  'hrs_per',
]);

function isBlankValue(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

export function normalizeWholeNumber(value, { min = 0, max = 999 } = {}) {
  if (isBlankValue(value)) {
    return '';
  }

  const parsed = Math.min(max, Math.max(min, parseInt(String(value), 10)));
  return Number.isNaN(parsed) ? '' : String(parsed);
}

function clampAllocationLimit(value) {
  return normalizeWholeNumber(value, { min: 0, max: 3 });
}

function normalizeSharePercent(value) {
  return normalizeWholeNumber(value, { min: 0, max: 100 });
}

/** SH mirrors Hbs as a 0–100 task-share percentage. */
export function syncShareHoursMirrorFields(task) {
  const sharePercent = normalizeSharePercent(task.sh ?? task.hbs ?? '');

  return {
    ...task,
    sh: sharePercent,
    hbs: sharePercent,
  };
}

/** ATS mirrors TS (algorithm); OTS mirrors AL (manual). */
export function syncTeamSizeMirrorFields(task) {
  const teamSize = normalizeWholeNumber(task.ts ?? task.ats ?? '');
  const allocationLimit = clampAllocationLimit(task.ots ?? task.al ?? '');

  return {
    ...task,
    ats: teamSize,
    ts: teamSize,
    ots: allocationLimit,
    al: allocationLimit,
  };
}

function applyShareHoursMirrorChange(task, key, value) {
  if (key === 'sh' || key === 'hbs') {
    const sharePercent = normalizeSharePercent(value);
    return {
      ...task,
      sh: sharePercent,
      hbs: sharePercent,
    };
  }

  return task;
}

function applyTeamSizeMirrorChange(task, key, value) {
  if (key === 'ots' || key === 'al') {
    const allocationLimit = clampAllocationLimit(value);
    return {
      ...task,
      ots: allocationLimit,
      al: allocationLimit,
    };
  }

  return task;
}

export function applyPdeTaskFieldChange(task, key, value, { getRapForTaskName, nrms } = {}) {
  if (CALCULATED_FIELD_KEYS.has(key)) {
    return task;
  }

  let next = { ...task, [key]: value };
  if (key === 'rfi') {
    next.rfi = value === true || value === '1' || value === 1 ? '1' : '0';
  }
  next = applyShareHoursMirrorChange(next, key, value);
  next = applyTeamSizeMirrorChange(next, key, value);

  if (key === 'task_name' && typeof getRapForTaskName === 'function') {
    next.rap = getRapForTaskName(value, nrms);
  }

  if (key === 'progress_per') {
    const recalculated = recalculatePdeDerivedFields(next, { nrms, respectManualProgressPer: true });
    return syncTaskDoneAndProgress(recalculated);
  }

  // Only Act / plan inputs should re-derive % from Act÷Plan. Date/owner/etc. must
  // keep the current % (including Done → 100% after TT import).
  const shouldDeriveProgressFromAct = PLAN_RECALC_FIELDS.has(key)
    || key === 'task_name'
    || key === 'act';

  const recalculated = recalculatePdeDerivedFields(next, {
    nrms,
    respectManualProgressPer: !shouldDeriveProgressFromAct,
  });

  if (key.startsWith('override_')) {
    const slot = String(key).replace(/^override_/, '');
    const mirrorKey = `dl_override_${slot}`;
    // PDE edit wins: clear any stale DL mirror so the next sync response cannot
    // re-apply an old dl_override_* and wipe the value the user just saved.
    // Keep the raw override value (even if it matches algorithm_*) so Save persists it.
    return {
      ...recalculated,
      [mirrorKey]: '',
    };
  }

  return recalculated;
}

/** PDE stores RFI as '1'/'0' strings; DL mirror hydration may use booleans. */
function normalizeCheckboxStringField(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  if (value === true || value === '1' || value === 1) {
    return '1';
  }
  if (value === false || value === '0' || value === 0) {
    return '0';
  }
  return String(value);
}

export function normalizeTaskForSave(task) {
  const normalized = syncShareHoursMirrorFields(syncTeamSizeMirrorFields({
    ...task,
    progress_plan: task.plan ?? '',
  }));

  // Persist override_* as the user set them. Do not strip values that match
  // algorithm_* here — that made PDE overrides disappear after Save even when
  // they were still shown in the grid. Algo/histogram use effectiveTaskOverride.
  // Completed must mean 100% (and vice versa).
  const aligned = syncTaskDoneAndProgress(normalized);
  const dlDoneRaw = aligned.dl_done;
  const dlDoneTruthy = dlDoneRaw === true || dlDoneRaw === '1' || dlDoneRaw === 1;
  const dlProgressSet = aligned.dl_progress_per != null && String(aligned.dl_progress_per).trim() !== '';
  let dlDone = normalizeCheckboxStringField(aligned.dl_done);
  let dlProgressPer = aligned.dl_progress_per ?? '';
  if (dlDoneTruthy || dlProgressSet) {
    const dlSynced = syncTaskDoneAndProgress({
      ...aligned,
      done: dlDoneTruthy,
      progress_per: aligned.dl_progress_per ?? '',
    });
    dlDone = normalizeCheckboxStringField(dlSynced.done ? '1' : '0');
    dlProgressPer = String(dlSynced.progress_per ?? '');
  }

  return {
    ...aligned,
    rfi: normalizeCheckboxStringField(normalized.rfi),
    dl_rfi: normalizeCheckboxStringField(normalized.dl_rfi),
    dl_done: dlDone,
    dl_progress_per: dlProgressPer,
  };
}

const DL_PLAN_FIELDS = new Set(['dl', 'buf', 'adj']);

export function applyDlTaskFieldChange(task, key, value) {
  let next = applyDlMirrorOnChange({ ...task, [key]: value }, key, value);

  if (key === 'rfi') {
    next.rfi = value === true || value === '1' || value === 1 ? '1' : '0';
  }

  if (key === 'dl' || DL_BUDGET_HOUR_KEYS.includes(key)) {
    next = applyDlSectionSplitChange(next, key, value);
    // Section-hour edits recalc `dl` without going through the dl key path —
    // stamp dl_dl so DL ownership of hours is recorded like a direct DL edit.
    next = applyDlMirrorOnChange(next, 'dl', next.dl);
  }

  if (DL_PLAN_FIELDS.has(key) || DL_BUDGET_HOUR_KEYS.includes(key)) {
    next.plan = recalculatePlanFromHours(next, { applyDlReduction: true });
  }

  if (key === 'pp' || key === 'rap') {
    next.pri = recalculateTaskPri(next);
  }

  // Only stamp the progress anchor when % changes — other DL edits must not
  // move Progress_Updated (WP-17 past/future split uses that day).
  if (key === 'progress_per') {
    const today = toStorageDate(new Date());
    const progress = recalculateProgressLeft(next);
    next = syncTaskDoneAndProgress({
      ...next,
      ...progress,
      progress_updated: today,
    });
    next = applyDlMirrorOnChange(next, 'progress_updated', today);
  }

  return next;
}
