import { getFieldSource } from '../constants/projectTaskFields';
import { getPlanCalculationTooltip } from './taskCalculations';

const FIELD_SOURCE_DESCRIPTIONS = {
  manual: 'Manual entry — editable on this page.',
  calculated: 'Calculated — derived from other fields.',
  auto: 'Algorithm output — set by Run algorithm.',
};

export const DL_LOCKED_FIELD_TOOLTIP =
  'Locked — value was set on the DL Input Hours page. Edit there to change it.';

export const INACTIVE_ROW_TOOLTIP =
  'Inactive row — task has no Plan hours and is excluded from allocation until Plan is set.';

export function getFieldCellTooltip(field, task, { isFieldLocked = false, applyDlPlanReduction = false } = {}) {
  const parts = [];

  if ((field.key === 'plan' || field.key === 'progress_plan') && task) {
    parts.push(getPlanCalculationTooltip(task, { applyDlReduction: applyDlPlanReduction }));
  } else if (field.key === 'progress_left_hours' && task) {
    const plan = parseFloat(task.plan || 0) || 0;
    const per = parseFloat(task.progress_per || 0) || 0;
    parts.push(`Left = Plan (${plan}) × (1 − ${per}%)`);
  } else if (field.key === 'act' && task) {
    const act = parseFloat(task.act || 0) || 0;
    const plan = parseFloat(task.plan || task.progress_plan || 0) || 0;
    const variance = Math.round((act - plan) * 10) / 10;
    const varianceLabel = variance > 0 ? `+${variance}` : String(variance);
    if (act > 0 && plan > 0) {
      parts.push(`Act ${act}h vs Plan ${plan}h (${varianceLabel}h). Progress % = Act / Plan.`);
    } else {
      parts.push('Actual hours worked — filled from Time Tracking by Compare TT hrs.');
    }
  } else if (field.key === 'tt_hours_logged' && task) {
    const tt = parseFloat(task.tt_hours_logged || 0) || 0;
    const plan = parseFloat(task.plan || task.progress_plan || 0) || 0;
    const variance = Math.round((tt - plan) * 10) / 10;
    const varianceLabel = variance > 0 ? `+${variance}` : String(variance);
    if (tt <= 0) {
      parts.push('TT hrs — Time Tracking hours logged for this task.');
    } else if (plan > 0) {
      parts.push(`TT ${tt}h vs Plan ${plan}h (${varianceLabel}h).`);
    } else {
      parts.push(`TT ${tt}h.`);
    }
  } else if (field.key === 'duration_left' && task) {
    const plan = parseFloat(task.plan || 0) || 0;
    const act = parseFloat(task.act || 0) || 0;
    const pre = parseFloat(task.pre || 0) || 0;
    parts.push(`Left = Plan (${plan}) − Act (${act}) − Pre (${pre})`);
  } else if (field.key === 'pri' && task) {
    parts.push(`Pri = RAP (${task.rap || 0}) + PP (${task.pp || 0})`);
  } else {
    const label = field.title || field.label;
    if (label) {
      parts.push(label);
    }
  }

  const source = getFieldSource(field);
  const sourceNote = FIELD_SOURCE_DESCRIPTIONS[source];
  if (sourceNote) {
    parts.push(sourceNote);
  }

  if (isFieldLocked) {
    parts.push(DL_LOCKED_FIELD_TOOLTIP);
  }

  return parts.filter(Boolean).join('\n');
}
