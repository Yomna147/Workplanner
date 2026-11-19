const TRAINING_STATUS_LABELS = {
  not_started: 'Not started',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  almost_complete: 'Almost complete',
  completed: 'Completed',
};

const TRAINING_FIELD_LABELS = {
  employee_id: 'Operative',
  title: 'Title',
  course_link: 'Course link',
  description: 'Description',
  duration: 'Duration',
  status: 'Status',
  priority: 'Priority',
  urgency: 'Urgency',
  start_date: 'Start',
  end_date: 'End',
  hours_per_day: 'Hours per day',
  day_segment: 'Day section',
  notes: 'Notes',
  confirm_override: 'Override occupied slot',
};

/** WHEN column + summary wall-clock — always browser local/display timezone. */
export function formatTrainingActivityTimestamp(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// Backend embeds "j M Y at H:i" (often UTC); rewrite to the same local clock as WHEN.
const EMBEDDED_SUMMARY_WHEN_RE = /\bon\s+\d{1,2}\s+[A-Za-z]{3,}\.?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\b/gi;

function alignSummaryTimestampToLocal(summary, createdAt) {
  const text = String(summary || '').trim();
  const localWhen = formatTrainingActivityTimestamp(createdAt);
  if (!text || !localWhen || localWhen === '—') {
    return text;
  }
  return text.replace(EMBEDDED_SUMMARY_WHEN_RE, `on ${localWhen}`);
}

export function isTrainingActivityField(field) {
  return Object.prototype.hasOwnProperty.call(TRAINING_FIELD_LABELS, field);
}

/**
 * Short title for training logs when field changes are shown as a before/after list.
 * Strips legacy inline details like ": Priority changed from P2 to P1; …".
 * Also rewrites legacy override summaries that were actually schedule moves.
 */
export function trainingActivityDisplaySummary(log, { hasFieldList = false } = {}) {
  const summary = String(log?.summary || '').trim();
  if (!summary) {
    return '';
  }

  const action = resolveTrainingLogDisplayAction(log);
  let resolved = summary;

  if (action === 'rescheduled') {
    const rescheduled = summary.match(
      /^(.*?)\s+overrode\b.*?\bwith\s+(.+?)\s+for\s+(.+?)\s+on\s+(.+)$/i,
    );
    if (rescheduled) {
      resolved = `${rescheduled[1]} rescheduled ${rescheduled[2]} for ${rescheduled[3]} on ${rescheduled[4]}`
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Drop legacy "Replaced:" bullet blocks — the UI list shows those items.
  const withoutReplacedBlock = resolved
    .replace(/\nReplaced:\n(?:•[^\n]*(?:\n|$))+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutReplacedBlock && withoutReplacedBlock !== resolved) {
    resolved = withoutReplacedBlock;
  }

  if (hasFieldList) {
    // "… for Assignee: Priority changed … on 23 Sep 2026 at 08:33."
    const withAssignee = resolved.match(
      /^(.*? for .+?): (?:Priority|Urgency|Start|End|Status|Duration|Title|Operative|Hours per day|Day section|Notes|Override occupied slot)\b.*?\bon (.+)$/i,
    );
    if (withAssignee) {
      resolved = `${withAssignee[1]} on ${withAssignee[2]}`.replace(/\s+/g, ' ').trim();
    } else {
      // "… updated Course: Priority changed … on …"
      const withCourse = resolved.match(
        /^(.*?): (?:Priority|Urgency|Start|End|Status|Duration|Title|Operative|Hours per day|Day section|Notes|Override occupied slot)\b.*?\bon (.+)$/i,
      );
      if (withCourse) {
        resolved = `${withCourse[1]} on ${withCourse[2]}`.replace(/\s+/g, ' ').trim();
      }
    }
  }

  return alignSummaryTimestampToLocal(resolved, log?.created_at);
}

/** Prefer Rescheduled when dates moved, even if the stored action was Overridden. */
export function resolveTrainingLogDisplayAction(log) {
  const action = String(log?.action || '').toLowerCase();
  if (trainingLogIncludesScheduleMove(log)) {
    return 'rescheduled';
  }
  return action;
}

export function trainingLogIncludesScheduleMove(log) {
  const changes = log?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return false;
  }

  return ['start_date', 'end_date'].some((field) => {
    const entry = changes[field];
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const from = String(entry.from ?? '');
    const to = String(entry.to ?? '');
    return from !== '' && to !== '' && from !== to;
  });
}

export function trainingActivityFieldLabel(field) {
  if (TRAINING_FIELD_LABELS[field]) {
    return TRAINING_FIELD_LABELS[field];
  }

  return String(field)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function trainingActivityFieldValue(field, value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (field === 'status') {
    return TRAINING_STATUS_LABELS[value] || String(value).replace(/_/g, ' ');
  }

  if (field === 'hours_per_day') {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return String(value);
    }
    const formatted = Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
    return `${formatted}h`;
  }

  if (field === 'confirm_override') {
    return value === true || value === 'true' || value === 1 || value === '1' ? 'Yes' : 'No';
  }

  if (field === 'day_segment') {
    const segment = Math.max(0, Math.min(3, Math.floor(Number(value) || 0)));
    return `Section ${segment + 1}`;
  }

  if (field === 'start_date' || field === 'end_date') {
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    }
  }

  return String(value);
}

/** Labels for projects/tasks displaced by a training override (from log meta). */
export function trainingOverrideReplacedLabels(log) {
  const tasks = Array.isArray(log?.overridden_tasks)
    ? log.overridden_tasks
    : (Array.isArray(log?.meta?.overridden_tasks) ? log.meta.overridden_tasks : []);
  const trainings = Array.isArray(log?.overridden_trainings)
    ? log.overridden_trainings
    : (Array.isArray(log?.meta?.overridden_trainings) ? log.meta.overridden_trainings : []);

  const labels = [];
  const seen = new Set();

  tasks.forEach((task) => {
    if (!task || typeof task !== 'object') {
      return;
    }
    const name = String(task.task_name || '').trim() || 'Untitled task';
    const project = String(task.project_name || '').trim();
    const label = project ? `${project} — ${name}` : name;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  });

  trainings.forEach((title) => {
    const trainingTitle = String(title || '').trim();
    if (!trainingTitle) {
      return;
    }
    const label = `Training: ${trainingTitle}`;
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  });

  const overrideBefore = String(log?.meta?.override_before || log?.override_before || '').trim();
  if (labels.length === 0 && overrideBefore && overrideBefore !== 'existing planned work') {
    overrideBefore.split(/\r?\n|; /).map((part) => part.trim()).filter(Boolean).forEach((part) => {
      const cleaned = part.replace(/^•\s*/, '');
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        labels.push(cleaned);
      }
    });
  }

  return labels;
}

/**
 * Resolve navigation target for a training activity log row.
 * @returns {{
 *   kind: 'assignment'|'course'|'none',
 *   trainingId: string|null,
 *   courseId: string|null,
 *   employeeId: string|null,
 *   startDate: string,
 *   endDate: string,
 *   deleted: boolean,
 * }}
 */
export function resolveTrainingLogNavigationTarget(log) {
  const meta = (log?.meta && typeof log.meta === 'object') ? log.meta : {};
  const subjectType = String(log?.subject_type || '');
  const subjectId = log?.subject_id != null ? String(log.subject_id) : '';
  const action = String(log?.action || '').toLowerCase();
  const deleted = action === 'deleted';

  const isCourseSubject = /TrainingCourse$/i.test(subjectType)
    || subjectType === 'training_course';
  const isAssignmentSubject = /EmployeeTraining$/i.test(subjectType)
    || subjectType === 'employee_training'
    || (!isCourseSubject && subjectId !== '');

  const courseId = meta.training_course_id != null && meta.training_course_id !== ''
    ? String(meta.training_course_id)
    : (isCourseSubject ? subjectId : null);
  const trainingId = isAssignmentSubject && subjectId ? subjectId : null;
  const employeeId = meta.employee_id != null && meta.employee_id !== ''
    ? String(meta.employee_id)
    : null;
  const startDate = String(meta.start_date || changesDate(log?.changes, 'start_date', 'to') || '').slice(0, 10);
  const endDate = String(meta.end_date || changesDate(log?.changes, 'end_date', 'to') || startDate).slice(0, 10);

  if (trainingId) {
    return {
      kind: 'assignment',
      trainingId,
      courseId,
      employeeId,
      startDate,
      endDate,
      deleted,
    };
  }

  if (courseId) {
    return {
      kind: 'course',
      trainingId: null,
      courseId,
      employeeId,
      startDate,
      endDate,
      deleted,
    };
  }

  return {
    kind: 'none',
    trainingId: null,
    courseId: null,
    employeeId: null,
    startDate: '',
    endDate: '',
    deleted,
  };
}

function changesDate(changes, field, side) {
  const entry = changes?.[field];
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  return entry[side] ?? '';
}

export function trainingActivityChangeEntries(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return [];
  }

  const fieldOrder = [
    'priority',
    'urgency',
    'start_date',
    'end_date',
    ...Object.keys(TRAINING_FIELD_LABELS).filter((field) => (
      !['priority', 'urgency', 'start_date', 'end_date'].includes(field)
    )),
  ];

  const startChange = changes.start_date;
  const endChange = changes.end_date;
  const sameDayMove = startChange
    && endChange
    && typeof startChange === 'object'
    && typeof endChange === 'object'
    && String(startChange.from ?? '') === String(endChange.from ?? '')
    && String(startChange.to ?? '') === String(endChange.to ?? '');

  const entries = Object.entries(changes)
    .filter(([field, change]) => {
      if (!change || typeof change !== 'object') {
        return false;
      }
      // Single-day date moves: show one Date row instead of Start + End.
      if (sameDayMove && field === 'end_date') {
        return false;
      }
      return true;
    })
    .map(([field, change]) => {
      if (sameDayMove && field === 'start_date') {
        return {
          field: 'date',
          label: 'Date',
          from: trainingActivityFieldValue('start_date', change.from),
          to: trainingActivityFieldValue('start_date', change.to),
        };
      }

      return {
        field,
        label: trainingActivityFieldLabel(field),
        from: trainingActivityFieldValue(field, change.from),
        to: trainingActivityFieldValue(field, change.to),
      };
    })
    .sort((left, right) => {
      const leftKey = left.field === 'date' ? 'start_date' : left.field;
      const rightKey = right.field === 'date' ? 'start_date' : right.field;
      const leftIndex = fieldOrder.indexOf(leftKey);
      const rightIndex = fieldOrder.indexOf(rightKey);
      if (leftIndex === -1 && rightIndex === -1) {
        return String(left.field).localeCompare(String(right.field));
      }
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    });

  return entries;
}
