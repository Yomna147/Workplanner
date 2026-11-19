import { employeeDisplayName, employeeTeamName } from './employeeNames';
import { sortEmployeesByTeamThenName } from './teamOrder';

export const TRAINING_NEW_SESSION_KEY = '__new__';

export function normalizeTrainingCourseTitle(title) {
  return String(title ?? '').replace(/^\[Sample\]\s*/i, '').trim();
}

export function buildTrainingCourseOptions(courses = []) {
  return [...(courses ?? [])]
    .filter((course) => course?.is_active !== false)
    .sort((left, right) => String(left.title ?? '').localeCompare(String(right.title ?? '')))
    .map((course) => ({
      value: String(course.id),
      label: course.title,
      course,
    }));
}

export function findTrainingCourseById(courses, courseId) {
  return (courses ?? []).find((course) => String(course.id) === String(courseId)) ?? null;
}

export function sessionMatchesCourse(session, course) {
  if (!session || !course) {
    return false;
  }

  // Prefer stable course id — title matching breaks after renames and confuses the LOV.
  if (session.training_course_id != null && course.id != null) {
    return String(session.training_course_id) === String(course.id);
  }

  return normalizeTrainingCourseTitle(session.title) === normalizeTrainingCourseTitle(course.title);
}

export function filterSessionsForCourse(sessions = [], course) {
  if (!course) {
    return [];
  }

  return sessions.filter((session) => sessionMatchesCourse(session, course));
}

export function buildTraineeOptions(employees = []) {
  return sortEmployeesByTeamThenName(employees).map((employee) => ({
    value: String(employee.id),
    label: employeeDisplayName(employee),
    teamName: employeeTeamName(employee) || 'No team',
    employee,
  }));
}

export function findAssignmentForEmployeeOnCourse(
  trainings = [],
  employeeId,
  course,
  ignoreAssignmentId = null,
) {
  const normalizedEmployeeId = String(employeeId ?? '').trim();
  if (!normalizedEmployeeId || !course) {
    return null;
  }

  return (trainings ?? []).find((row) => {
    if (ignoreAssignmentId != null && String(row?.id) === String(ignoreAssignmentId)) {
      return false;
    }
    if (String(row?.employee_id ?? '').trim() !== normalizedEmployeeId) {
      return false;
    }
    return sessionMatchesCourse(row, course);
  }) ?? null;
}

export function isEmployeeAssignedToCourse(
  trainings = [],
  employeeId,
  course,
  ignoreAssignmentId = null,
) {
  return Boolean(findAssignmentForEmployeeOnCourse(
    trainings,
    employeeId,
    course,
    ignoreAssignmentId,
  ));
}

/** Prevent assigning the same operative twice in one roster or course. */
export function getTraineeOptionsForRow(
  traineeOptions,
  rosterRows,
  rowIndex,
  currentEmployeeId = '',
  blockedEmployeeIds = [],
) {
  const normalizedCurrent = String(currentEmployeeId ?? '').trim();
  const usedIds = new Set(
    (rosterRows ?? [])
      .map((row, index) => (index === rowIndex ? '' : row?.employee_id))
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  );
  const blockedIds = new Set((blockedEmployeeIds ?? []).map((id) => String(id).trim()).filter(Boolean));

  return (traineeOptions ?? []).filter(
    (option) => (
      option.value === normalizedCurrent
      || (!usedIds.has(option.value) && !blockedIds.has(option.value))
    ),
  );
}

export function buildSessionDefaultsFromCourse(course) {
  if (!course) {
    return {};
  }

  return {
    title: course.title,
    training_course_id: course.id,
    course_link: course.course_link || '',
    description: course.description || '',
    duration: course.duration || '1-2 hours',
    hours_per_day: 2,
    priority: course.priority || 'P2',
    urgency: course.urgency || 'U1',
    status: 'not_started',
  };
}

export function emptyTraineeRow(sessionDefaults = {}) {
  const day = sessionDefaults.start_date || sessionDefaults.end_date || '';
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    employee_id: '',
    employee: null,
    employee_name: '',
    confirm_override: false,
    duration: '1-2 hours',
    hours_per_day: 2,
    start_date: day,
    end_date: day,
    ...sessionDefaults,
    day_segment: 0,
    ...(day ? { start_date: day, end_date: day, hours_per_day: 2, duration: '1-2 hours' } : {}),
  };
}

export function isUnsavedTrainingRow(training) {
  const id = training?.id;
  if (id == null || id === '') {
    return true;
  }
  return String(id).startsWith('new-');
}

export function resolveCourseIdForSession(session, courses = []) {
  if (session?.training_course_id != null) {
    return String(session.training_course_id);
  }

  const normalizedTitle = normalizeTrainingCourseTitle(session?.title);
  const match = (courses ?? []).find(
    (course) => normalizeTrainingCourseTitle(course.title) === normalizedTitle,
  );

  return match ? String(match.id) : '';
}
