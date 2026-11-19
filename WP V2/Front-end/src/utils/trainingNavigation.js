import { canAccessRoute, canViewPage, isDlUser } from './userPermissions';

const DL_FOCUS_TRAINING_KEY = 'dl-focus-training';

/**
 * Where clicking a training card should take this user:
 * - DLs → the Trainings tab on their DL Input Hours page.
 * - Admins / trainers (anyone else who can open the Trainings page) → that course in the roster.
 * - Anyone else → the DL Input Hours Trainings tab when they can open it.
 */
export function trainingOpenDestination(user) {
  if (isDlUser(user)) {
    return 'dl';
  }
  if (canViewPage(user, 'Trainings')) {
    return 'roster';
  }
  return canAccessRoute(user, '/dl-input-hours') ? 'dl' : null;
}

export function trainingOpenTitle(user) {
  const destination = trainingOpenDestination(user);
  if (destination === 'roster') {
    return 'Open this course in the Trainings roster';
  }
  if (destination === 'dl') {
    return 'Open this training on the DL trainings page';
  }
  return undefined;
}

/** Query params that open `training`'s course in the Trainings roster with its row focused. */
export function trainingRosterParams(training) {
  const params = { view: 'roster', training: String(training.id) };
  if (training.training_course_id != null && training.training_course_id !== '') {
    params.course = String(training.training_course_id);
  }
  return params;
}

/** URL of the DL Input Hours Trainings tab focused on `training` (stashes it for the DL page). */
export function dlTrainingUrl(training, employeeId) {
  try {
    window.sessionStorage.setItem(
      DL_FOCUS_TRAINING_KEY,
      JSON.stringify({ ...training, employee_id: employeeId }),
    );
  } catch {
    // ignore storage failures — navigation still proceeds
  }

  const params = new URLSearchParams({
    view: 'trainings',
    employee: String(employeeId),
    training: String(training.id),
  });
  return `/dl-input-hours?${params.toString()}`;
}
