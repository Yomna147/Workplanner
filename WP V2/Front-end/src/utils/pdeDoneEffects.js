import { toStorageDate } from './dateFormat';
import { isDlMirrorLocked } from './dlMirrorFields';
import { employeeDisplayName, findEmployeeForAuthUser } from './employeeNames';

export function resolveOwnerForDoneCheckbox(user, employees = []) {
  const matched = findEmployeeForAuthUser(user, employees);
  if (matched) {
    return employeeDisplayName(matched);
  }

  const first = user?.first_name || user?.firstname || '';
  const last = user?.last_name || user?.lastname || '';
  const fullName = `${first} ${last}`.trim();
  return fullName || user?.name || 'Unknown';
}

function parseStoredProgressPercent(task) {
  const raw = task?.progress_per ?? task?.progress;
  if (raw == null || String(raw).trim() === '') {
    return null;
  }

  const num = Number(String(raw).trim().replace(/%$/, ''));
  if (!Number.isFinite(num)) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round(num)));
}

function progressLeftForPercent(task, percent) {
  const plan = Number(task?.plan ?? task?.progress_plan);
  if (!Number.isFinite(plan) || plan <= 0) {
    return task?.progress_left_hours ?? '';
  }

  return String(Math.max(0, Math.round(plan * (1 - percent / 100))));
}

/**
 * Keep Done and progress % aligned:
 * - Done on  → 100%
 * - Done off → below 100% (0 when it was complete)
 * - 100%     → Done on
 * - < 100%   → Done off
 */
export function syncTaskDoneAndProgress(task, { preferDone = null } = {}) {
  if (!task) {
    return task;
  }

  const storedPercent = parseStoredProgressPercent(task);
  let done = preferDone == null ? Boolean(task.done) : Boolean(preferDone);
  let percent = storedPercent;

  if (preferDone === true) {
    done = true;
    percent = 100;
  } else if (preferDone === false) {
    done = false;
    percent = storedPercent != null && storedPercent < 100 ? storedPercent : 0;
  } else if (percent != null && percent >= 100) {
    done = true;
    percent = 100;
  } else if (percent != null) {
    // Explicit % below 100 wins over a stale Done tick.
    done = false;
  } else if (done) {
    percent = 100;
  } else {
    percent = 0;
  }

  return {
    ...task,
    done,
    progress_per: String(percent),
    progress_left_hours: progressLeftForPercent(task, percent),
  };
}

export function applyDoneCheckboxChange(task, checked, { user, employees } = {}) {
  const today = toStorageDate(new Date());
  const ownerLocked = isDlMirrorLocked(task, 'owner');
  const synced = syncTaskDoneAndProgress(task, { preferDone: Boolean(checked) });

  if (checked) {
    return {
      ...synced,
      project_completion_date: today,
      ...(ownerLocked
        ? {}
        : { owner: resolveOwnerForDoneCheckbox(user, employees) }),
      progress_updated: today,
    };
  }

  return {
    ...synced,
    project_completion_date: '',
    ...(ownerLocked ? {} : { owner: '' }),
    progress_updated: today,
  };
}
