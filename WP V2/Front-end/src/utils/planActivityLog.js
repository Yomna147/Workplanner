import { dlTaskSections, taskSections } from '../constants/projectTaskFields';

const fieldLabelMap = [...taskSections, ...dlTaskSections].reduce((map, section) => {
  section.fields.forEach((field) => {
    map[field.key] = field.label;
  });
  return map;
}, {});

/** Fields that mean a DL actually edited plan data (not owner stamp / algo side effects). */
export function isDlPlanField(key) {
  const field = String(key || '').trim().toLowerCase();
  if (!field) {
    return false;
  }
  if (field === 'dl_owner' || field === 'owner') {
    return false;
  }
  return field === 'dl' || field === 'rfi' || field.startsWith('dl_');
}

export function formatPlanFieldLabel(key) {
  if (fieldLabelMap[key]) {
    return fieldLabelMap[key];
  }

  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatPlanFieldValue(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  return String(value);
}

function updatedTaskHasDlPlanEdit(item) {
  if (!item?.changes || typeof item.changes !== 'object') {
    return false;
  }
  return Object.keys(item.changes).some((field) => isDlPlanField(field));
}

/** Task ids that had real DL plan-field edits in this log. */
export function planLogTaskIds(log) {
  if (Array.isArray(log?.task_ids) && log.task_ids.length > 0) {
    return [...new Set(log.task_ids.map((id) => String(id)).filter(Boolean))];
  }

  const ids = [];
  (log?.changes?.updated || []).forEach((item) => {
    if (!item?.id || !updatedTaskHasDlPlanEdit(item)) {
      return;
    }
    ids.push(String(item.id));
  });

  return [...new Set(ids)];
}

export function planLogTaskChanges(log) {
  const tasks = [];

  (log?.changes?.updated || []).forEach((item) => {
    if (!updatedTaskHasDlPlanEdit(item)) {
      return;
    }
    const fields = Object.entries(item.changes || {})
      .filter(([field]) => isDlPlanField(field))
      .map(([field, change]) => ({
        field,
        label: formatPlanFieldLabel(field),
        from: formatPlanFieldValue(change?.from),
        to: formatPlanFieldValue(change?.to),
      }));
    if (fields.length === 0) {
      return;
    }
    tasks.push({
      id: item.id,
      taskName: item.task_name || `Task #${item.id}`,
      kind: 'updated',
      fields,
    });
  });

  return tasks;
}

export function uniquePlanLogUserNames(logs) {
  return [...new Set(
    (logs || [])
      .map((log) => String(log.user_name || '').trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

export function buildDlPlanEditByTaskId(logs) {
  const map = new Map();
  const sorted = [...(logs || [])].sort((a, b) => {
    const aTime = new Date(a.created_at || 0).getTime();
    const bTime = new Date(b.created_at || 0).getTime();
    return bTime - aTime;
  });

  sorted.forEach((log) => {
    const taskChanges = planLogTaskChanges(log);
    taskChanges.forEach((item) => {
      const taskId = String(item.id);
      if (!taskId || map.has(taskId)) {
        return;
      }

      const firstField = item.fields?.[0];
      map.set(taskId, {
        logId: log.id,
        userName: log.user_name || 'Unknown',
        createdAt: log.created_at,
        summary: log.summary || '',
        taskName: item.taskName || '',
        what: firstField
          ? `${firstField.label}: ${firstField.from} → ${firstField.to}`
          : (log.summary || 'Plan updated'),
        extraFieldCount: Math.max(0, (item.fields?.length || 0) - 1),
      });
    });
  });

  return map;
}

export function formatDlPlanEditHover(edit) {
  if (!edit) {
    return null;
  }

  let when = '';
  try {
    const date = new Date(edit.createdAt);
    if (!Number.isNaN(date.getTime())) {
      when = date.toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  } catch {
    when = '';
  }

  const extra = edit.extraFieldCount > 0
    ? ` (+${edit.extraFieldCount} more)`
    : '';

  return `DL edit: ${edit.userName}${when ? ` · ${when}` : ''} · ${edit.what}${extra}`;
}
