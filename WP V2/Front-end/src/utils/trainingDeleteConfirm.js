import { employeeDisplayName } from './employeeNames';

function resolveDeletableAssignments(groupOrAssignments) {
  const assignments = Array.isArray(groupOrAssignments)
    ? groupOrAssignments
    : (groupOrAssignments?.assignments ?? []);
  const deletable = assignments.filter((row) => row?.id != null && row.id !== '');

  return { assignments, deletable };
}

export function resolveTrainingSessionDeleteTarget(groupOrAssignments) {
  const { assignments, deletable } = resolveDeletableAssignments(groupOrAssignments);
  const courseId = groupOrAssignments?.training_course_id
    ?? deletable.find((row) => row?.training_course_id)?.training_course_id
    ?? assignments.find((row) => row?.training_course_id)?.training_course_id
    ?? '';

  if (deletable.length === 0 && (courseId == null || courseId === '')) {
    return null;
  }

  const title = String(
    groupOrAssignments?.title
    || deletable[0]?.title
    || assignments[0]?.title
    || 'this training',
  ).trim() || 'this training';

  return {
    kind: 'session',
    title,
    count: deletable.length,
    deletable,
    courseId: courseId != null && courseId !== '' ? String(courseId) : '',
  };
}

export function resolveTrainingAssignmentDeleteTarget(training) {
  if (!training?.id) {
    return null;
  }

  const name = employeeDisplayName(training.employee)
    || training.employee?.name
    || 'this operative';
  const trainingTitle = String(training.title || 'this training').trim() || 'this training';

  return {
    kind: 'assignment',
    training,
    name,
    trainingTitle,
  };
}

export function buildTrainingDeleteModalCopy(target) {
  if (!target) {
    return null;
  }

  if (target.kind === 'session') {
    const assigneeLabel = `${target.count} operative${target.count === 1 ? '' : 's'}`;

    return {
      title: 'Delete course',
      message: target.courseId
        ? 'This will delete the course from the catalogue and remove every assignment from the roster, histogram, and Gap view.'
        : 'You are about to delete every assignment of this course. Each trainee row will be removed from the roster, histogram, and Gap view.',
      details: [
        { label: 'Training', value: target.title },
        { label: 'Assignees', value: assigneeLabel },
      ],
      warning: 'This action cannot be undone.',
      confirmLabel: target.courseId ? 'Delete course' : 'Delete training',
    };
  }

  if (target.kind === 'assignment') {
    return {
      title: 'Remove assignee',
      message: 'Remove this operative from the training? Their assignment will be deleted.',
      details: [
        { label: 'Operative', value: target.name },
        { label: 'Training', value: target.trainingTitle },
      ],
      warning: 'This action cannot be undone.',
      confirmLabel: 'Remove assignee',
    };
  }

  return null;
}
