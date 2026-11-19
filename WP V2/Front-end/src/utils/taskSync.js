import { emptyTask, taskSections } from '../constants/projectTaskFields';
import { normalizeTaskForSave } from './taskCalculations';

export const TASK_SYNC_CONFLICT_CODE = 'TASK_SYNC_CONFLICT';
export const TASK_SYNC_CANCELLED_CODE = 'TASK_SYNC_CANCELLED';

const COMPARE_KEYS = Object.keys(emptyTask());
const IGNORE_COMPARE_KEYS = new Set(['id', 'part_id', 'created_at', 'updated_at', 'part_name']);

const FIELD_LABELS = (() => {
  const labels = {};
  taskSections.forEach((section) => {
    (section.fields ?? []).forEach((field) => {
      if (field?.key && !labels[field.key]) {
        labels[field.key] = field.label || field.key;
      }
    });
  });
  return labels;
})();

export class TaskSyncCancelledError extends Error {
  constructor() {
    super('Save cancelled.');
    this.name = 'TaskSyncCancelledError';
    this.code = TASK_SYNC_CANCELLED_CODE;
  }
}

export function cloneTaskSyncSnapshot(tasks) {
  try {
    return JSON.parse(JSON.stringify(tasks ?? []));
  } catch {
    return (tasks ?? []).map((task) => ({ ...task }));
  }
}

export function getTaskFieldLabel(key) {
  return FIELD_LABELS[key] || key;
}

export function formatTaskSyncValue(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (value === true) {
    return 'Yes';
  }
  if (value === false) {
    return 'No';
  }
  return String(value);
}

function normalizeCompareValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (value === true) {
    return '1';
  }
  if (value === false) {
    return '0';
  }
  return String(value).trim();
}

function comparableTask(task) {
  const normalized = normalizeTaskForSave(task ?? {});
  const values = {};
  COMPARE_KEYS.forEach((key) => {
    if (IGNORE_COMPARE_KEYS.has(key)) {
      return;
    }
    values[key] = normalizeCompareValue(normalized[key]);
  });
  return values;
}

export function tasksContentEqual(left, right) {
  const a = comparableTask(left);
  const b = comparableTask(right);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function collectDirtyTaskIds(currentTasks, baselineTasks) {
  const baselineById = new Map(
    (baselineTasks ?? [])
      .filter((task) => task?.id != null && task.id !== '')
      .map((task) => [String(task.id), task]),
  );

  const dirty = [];
  (currentTasks ?? []).forEach((task) => {
    if (task?.id == null || task.id === '') {
      return;
    }
    const baseline = baselineById.get(String(task.id));
    if (!baseline || !tasksContentEqual(task, baseline)) {
      dirty.push(Number(task.id));
    }
  });

  return dirty;
}

export function buildTaskSyncPayload(tasks, baselineTasks, extra = {}) {
  const current = (tasks ?? []).map((task) => normalizeTaskForSave(task));
  const baseline = (baselineTasks ?? []).filter((task) => task?.id != null && task.id !== '');

  return {
    tasks: current,
    baseline_task_ids: baseline.map((task) => Number(task.id)),
    baseline_tasks: baseline.map((task) => ({
      id: Number(task.id),
      updated_at: task.updated_at ?? null,
    })),
    dirty_task_ids: collectDirtyTaskIds(current, baseline),
    ...extra,
  };
}

export function isTaskSyncConflict(error) {
  return error?.response?.status === 409
    && error?.response?.data?.code === TASK_SYNC_CONFLICT_CODE;
}

export function isTaskSyncCancelled(error) {
  return error?.code === TASK_SYNC_CANCELLED_CODE
    || error?.name === 'TaskSyncCancelledError';
}

export function getTaskSyncConflict(error) {
  return error?.response?.data?.conflict ?? {
    preserved: [],
    overlaps: [],
    skipped_stale_count: 0,
  };
}

export async function syncPartTasks(api, partId, {
  tasks,
  baselineTasks,
  extra = {},
  conflictResolutions,
} = {}) {
  const payload = buildTaskSyncPayload(tasks, baselineTasks, extra);
  if (conflictResolutions && Object.keys(conflictResolutions).length > 0) {
    payload.conflict_resolutions = conflictResolutions;
  }

  return api.post(`/parts/${partId}/tasks/sync`, payload);
}

export function overlapChoiceLabel(type, choice) {
  if (type === 'delete') {
    return choice === 'client' ? 'Delete anyway' : 'Keep saved version';
  }
  if (type === 'deleted_on_server') {
    return choice === 'client' ? 'Restore mine' : 'Leave deleted';
  }
  return choice === 'client' ? 'Save mine' : 'Ignore (keep saved)';
}

export function overlapTypeLabel(type) {
  if (type === 'delete') {
    return 'You removed this task, but it was updated in the newer save.';
  }
  if (type === 'deleted_on_server') {
    return 'You edited this task, but it was deleted in the newer save.';
  }
  return 'This task was edited in both versions.';
}

export function taskSyncSuccessMessage(response, fallback = 'Tasks saved.') {
  const preserved = Number(response?.data?.sync?.preserved_count ?? 0);
  if (preserved > 0) {
    return `${fallback} Kept ${preserved} task${preserved === 1 ? '' : 's'} from a newer save.`;
  }
  return fallback;
}
