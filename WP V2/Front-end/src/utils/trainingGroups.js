import { compareEmployeesLikeOap } from './teamOrder';
import { formatDisplayDate } from './dateFormat';

export function trainingCourseKey(training) {
  const courseId = training?.training_course_id ?? training?.training_course?.id ?? null;
  if (courseId != null && String(courseId) !== '') {
    return `course:${courseId}`;
  }
  return `title:${String(training?.title ?? '').trim().toLowerCase()}`;
}

export function trainingSessionKey(training) {
  return trainingCourseKey(training);
}

function normalizeTrainingDate(value) {
  if (!value) {
    return '';
  }

  return String(value).slice(0, 10);
}

export function dedupeTrainingAssignmentsByEmployee(assignments = []) {
  const seen = new Set();
  const deduped = [];

  [...assignments]
    .sort((left, right) => Number(left?.id ?? 0) - Number(right?.id ?? 0))
    .forEach((assignment) => {
      const employeeId = String(assignment?.employee_id ?? assignment?.employee?.id ?? '');
      if (!employeeId || seen.has(employeeId)) {
        return;
      }
      seen.add(employeeId);
      deduped.push(assignment);
    });

  return deduped;
}

export function groupTrainingsBySession(trainings = [], courses = []) {
  const groups = new Map();
  const courseById = new Map(
    (courses || [])
      .filter((course) => course?.id != null)
      .map((course) => [String(course.id), course]),
  );

  trainings.forEach((training) => {
    const key = trainingSessionKey(training);
    const courseId = training?.training_course_id ?? training?.training_course?.id ?? null;
    const liveCourse = courseId != null ? courseById.get(String(courseId)) : null;
    const liveTitle = liveCourse?.title || training?.training_course?.title || training.title;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: liveTitle,
        training_course_id: courseId,
        start_date: normalizeTrainingDate(training.start_date),
        end_date: normalizeTrainingDate(training.end_date || training.start_date),
        course_link: liveCourse?.course_link || training.course_link,
        description: liveCourse?.description || training.description,
        duration: training.duration,
        hours_per_day: training.hours_per_day,
        status: training.status,
        // Course catalogue defaults; first assignment only for title-only sessions.
        priority: liveCourse?.priority || training.priority,
        urgency: liveCourse?.urgency || training.urgency,
        color: liveCourse?.color || training?.training_course?.color || null,
        assigned_by_name: training.assigned_by_name || '',
        created_at: training.created_at || null,
        assignments: [],
      });
    }

    const group = groups.get(key);
    // Keep group title/link in sync with the live course catalogue (renames).
    if (liveTitle) {
      group.title = liveTitle;
    }
    if (liveCourse?.course_link) {
      group.course_link = liveCourse.course_link;
    }
    if (liveCourse?.description) {
      group.description = liveCourse.description;
    }
    if (liveCourse?.color) {
      group.color = liveCourse.color;
    }
    if (liveCourse?.priority) {
      group.priority = liveCourse.priority;
    }
    if (liveCourse?.urgency) {
      group.urgency = liveCourse.urgency;
    }

    const nextStart = normalizeTrainingDate(training.start_date);
    const nextEnd = normalizeTrainingDate(training.end_date || training.start_date);
    if (nextStart && (!group.start_date || nextStart < group.start_date)) {
      group.start_date = nextStart;
    }
    if (nextEnd && (!group.end_date || nextEnd > group.end_date)) {
      group.end_date = nextEnd;
    }

    const assignmentId = String(training?.id ?? '');
    const alreadyAssigned = group.assignments.some(
      (assignment) => String(assignment?.id ?? '') === assignmentId && assignmentId !== '',
    );

    if (!alreadyAssigned) {
      group.assignments.push({
        ...training,
        title: liveTitle || training.title,
        course_link: liveCourse?.course_link || training.course_link,
        description: liveCourse?.description ?? training.description,
      });
    }
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      assignments: [...group.assignments].sort((left, right) => (
        compareEmployeesLikeOap(left.employee, right.employee)
      )),
    }))
    .sort((left, right) => {
      const startCmp = String(right.start_date ?? '').localeCompare(String(left.start_date ?? ''));
      if (startCmp !== 0) {
        return startCmp;
      }

      return String(left.title ?? '').localeCompare(String(right.title ?? ''));
    });
}

export function formatTrainingSessionLabel(group) {
  return group?.title || 'Untitled training';
}

export function formatTrainingSessionPickerLabel(group) {
  const title = formatTrainingSessionLabel(group);
  const start = formatDisplayDate(group?.start_date);
  const end = formatDisplayDate(group?.end_date);

  if (start && end && start !== end) {
    return `${title} (${start} → ${end})`;
  }

  if (start) {
    return `${title} (${start})`;
  }

  return title;
}

export function buildTrainingFormFromSession(group, defaults = {}) {
  if (!group) {
    return null;
  }

  const fallbackEmployeeIds = (defaults.employee_ids || []).map(String);

  return {
    title: group.title || '',
    training_course_id: group.training_course_id ?? null,
    course_link: group.course_link || '',
    description: group.description || '',
    duration: group.duration || '1-2 hours',
    hours_per_day: group.hours_per_day
      ?? group.assignments?.[0]?.hours_per_day
      ?? undefined,
    status: group.status || 'not_started',
    priority: group.priority || 'P2',
    urgency: group.urgency || 'U1',
    start_date: group.start_date || defaults.start_date || '',
    end_date: group.end_date || defaults.end_date || '',
    employee_ids: fallbackEmployeeIds,
    confirm_override: false,
  };
}

export const TRAINING_SESSION_COLOR_PALETTE = [
  '#2563eb',
  '#d97706',
  '#059669',
  '#7c3aed',
  '#dc2626',
  '#0891b2',
  '#c026d3',
  '#ea580c',
  '#0d9488',
  '#4f46e5',
];

export function annotateTrainingSessionLegend(groups = []) {
  return groups.map((group, index) => {
    const courseColor = String(group?.color || '').trim();
    const hasCourseColor = /^#[0-9A-Fa-f]{6}$/.test(courseColor);

    return {
      ...group,
      legendNumber: index + 1,
      legendColor: hasCourseColor
        ? courseColor
        : TRAINING_SESSION_COLOR_PALETTE[index % TRAINING_SESSION_COLOR_PALETTE.length],
    };
  });
}

export function buildTrainingSessionLegendLookup(groups = []) {
  const lookup = new Map();
  groups.forEach((group) => {
    lookup.set(group.key, {
      legendNumber: group.legendNumber,
      legendColor: group.legendColor,
      title: group.title,
    });
  });
  return lookup;
}

export function resolveTrainingSessionLegend(training, lookup) {
  if (!training || !lookup) {
    return { legendNumber: null, legendColor: '#3b82f6', title: training?.title || '' };
  }

  return lookup.get(trainingSessionKey(training)) ?? {
    legendNumber: null,
    legendColor: '#3b82f6',
    title: training?.title || '',
  };
}

export function trainingOverlapsViewRange(training, startDate, endDate) {
  const sessionStart = String(training?.start_date ?? '').slice(0, 10);
  const sessionEnd = String(training?.end_date ?? '').slice(0, 10) || sessionStart;
  if (!sessionStart || !startDate || !endDate) {
    return false;
  }
  return sessionEnd >= startDate && sessionStart <= endDate;
}
