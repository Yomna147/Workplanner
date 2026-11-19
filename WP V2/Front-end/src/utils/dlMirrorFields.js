/** Maps PDE task fields to DL mirror columns (set when edited on the DL page). */
export const DL_MIRROR_FIELD_MAP = {
  dl: 'dl_dl',
  rfi: 'dl_rfi',
  con: 'dl_con',
  override_1: 'dl_override_1',
  override_2: 'dl_override_2',
  override_3: 'dl_override_3',
  progress_updated: 'dl_progress_updated',
  progress_per: 'dl_progress_per',
  done: 'dl_done',
  owner: 'dl_owner',
  project_completion_date: 'dl_project_completion_date',
};

export const DL_OWNED_FIELD_KEYS = new Set(Object.keys(DL_MIRROR_FIELD_MAP));

export function isDlMirrorLocked(task, fieldKey) {
  const mirrorKey = DL_MIRROR_FIELD_MAP[fieldKey];
  if (!mirrorKey || !task) {
    return false;
  }

  const mirrorVal = task[mirrorKey];
  return mirrorVal !== null && mirrorVal !== undefined && String(mirrorVal).trim() !== '';
}

export function shouldPreserveTaskOwner(task) {
  if (isDlMirrorLocked(task, 'owner')) {
    return true;
  }

  const owner = String(task?.owner ?? '').trim();
  return owner !== '';
}

function mirrorValueForDlChange(fieldKey, value) {
  if (fieldKey === 'rfi') {
    return value === true || value === '1' || value === 1 ? '1' : '0';
  }

  if (fieldKey === 'done') {
    return value === true || value === '1' || value === 1 ? '1' : '0';
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

/** Stamp or clear the DL mirror column when a field is edited on the DL page. */
export function applyDlMirrorOnChange(task, fieldKey, value) {
  const mirrorKey = DL_MIRROR_FIELD_MAP[fieldKey];
  if (!mirrorKey) {
    return task;
  }

  if (fieldKey === 'rfi' || fieldKey === 'done') {
    return { ...task, [mirrorKey]: mirrorValueForDlChange(fieldKey, value) };
  }

  const mirrorValue = mirrorValueForDlChange(fieldKey, value);
  if (mirrorValue === '') {
    return { ...task, [mirrorKey]: '' };
  }

  return { ...task, [mirrorKey]: mirrorValue };
}

function parseDlMirrorFieldValue(fieldKey, mirrorValue) {
  if (fieldKey === 'rfi') {
    return mirrorValue === '1' || mirrorValue === 1 || mirrorValue === true ? '1' : '0';
  }

  if (fieldKey === 'done') {
    return mirrorValue === '1' || mirrorValue === 1 || mirrorValue === true;
  }

  return mirrorValue;
}

export function getDlOwnerDisplayValue(task) {
  return String(task?.dl_owner ?? '').trim();
}

/** Apply DL mirror values onto PDE fields when loading tasks for the PDE page. */
export function applyDlMirrorValuesToPde(task) {
  if (!task) {
    return task;
  }

  let next = { ...task };

  Object.entries(DL_MIRROR_FIELD_MAP).forEach(([fieldKey, mirrorKey]) => {
    if (!isDlMirrorLocked(next, fieldKey)) {
      return;
    }

    next[fieldKey] = parseDlMirrorFieldValue(fieldKey, next[mirrorKey]);
  });

  return next;
}
