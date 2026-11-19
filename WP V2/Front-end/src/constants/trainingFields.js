import {
  TRAINING_DURATION_OPTIONS,
  TRAINING_PRIORITY_OPTIONS,
  TRAINING_STATUS_OPTIONS,
  TRAINING_URGENCY_OPTIONS,
  trainingDaySegmentLabel,
  trainingDurationDisplayLabel,
  trainingTotalHours,
} from '../utils/trainingForm';
import { employeeDisplayName } from '../utils/employeeNames';

export const trainingEmployeeSections = [
  {
    key: 'employee',
    title: 'Operative',
    fields: [
      {
        key: 'employee_name',
        label: 'Name',
        type: 'text',
        colSize: 'employee',
        readOnly: true,
        title: 'Assigned operative',
      },
    ],
  },
  {
    key: 'details',
    title: 'Training details',
    minimizedTitle: 'Details',
    minimizedFieldKeys: ['description', 'start_date', 'day_segment', 'status'],
    fields: [
      {
        key: 'course_link',
        label: 'Course link',
        type: 'url',
        colSize: 'course-link',
        title: 'Link to the training course',
      },
      {
        key: 'description',
        label: 'Description',
        type: 'text',
        title: 'Short description',
      },
      {
        key: 'start_date',
        label: 'Date',
        type: 'date',
        title: 'Training date (single 2h slot)',
      },
      {
        key: 'day_segment',
        label: 'Day section',
        type: 'day-segment',
        colSize: 'day-segment',
        title: 'Which quarter of the workday to book (2 h each)',
      },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        colSize: 'training-select',
        options: TRAINING_STATUS_OPTIONS.map((option) => option.value),
        title: 'Training status',
      },
      {
        key: 'priority',
        label: 'Priority',
        type: 'select',
        colSize: 'training-priority',
        options: TRAINING_PRIORITY_OPTIONS.map((option) => option.value),
        title: 'Training priority',
      },
      {
        key: 'urgency',
        label: 'Urgency',
        type: 'select',
        colSize: 'training-urgency',
        options: TRAINING_URGENCY_OPTIONS.map((option) => option.value),
        title: 'Scheduling urgency',
      },
    ],
  },
];

/** PDE-like roster grid: trainees as rows with operative LOV (duplicate-safe). */
export const trainingRosterSections = [
  {
    key: 'employee',
    title: 'Trainee',
    fields: [
      {
        key: 'employee_id',
        label: 'Operative',
        type: 'employee-select',
        colSize: 'employee',
        title: 'Select operative for this training session',
      },
    ],
  },
  {
    key: 'details',
    title: 'Training details',
    minimizedTitle: 'Details',
    minimizedFieldKeys: ['description', 'start_date', 'day_segment', 'status'],
    fields: trainingEmployeeSections[1].fields,
  },
];

export const dlMyTrainingSections = [
  {
    key: 'training',
    title: 'My training',
    minimizedTitle: 'Training',
    minimizedFieldKeys: ['title', 'status', 'start_date', 'day_segment'],
    fields: [
      {
        key: 'title',
        label: 'Title',
        type: 'text',
        wide: true,
        title: 'Training title',
      },
      {
        key: 'course_link',
        label: 'Course link',
        type: 'url',
        colSize: 'course-link',
        title: 'Link to the training course',
      },
      {
        key: 'description',
        label: 'Description',
        type: 'text',
        title: 'Short description',
      },
      {
        key: 'start_date',
        label: 'Date',
        type: 'date',
        title: 'Training date (single 2h slot)',
      },
      {
        key: 'day_segment',
        label: 'Day section',
        type: 'day-segment',
        colSize: 'day-segment',
        title: 'Which quarter of the workday to book (2 h each)',
      },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        colSize: 'training-select',
        options: TRAINING_STATUS_OPTIONS.map((option) => option.value),
        title: 'Training status',
      },
      {
        key: 'priority',
        label: 'Priority',
        type: 'select',
        colSize: 'training-priority',
        options: TRAINING_PRIORITY_OPTIONS.map((option) => option.value),
        title: 'Training priority',
      },
      {
        key: 'urgency',
        label: 'Urgency',
        type: 'select',
        colSize: 'training-urgency',
        options: TRAINING_URGENCY_OPTIONS.map((option) => option.value),
        title: 'Scheduling urgency',
      },
    ],
  },
];

export function getTrainingVisibleFields(sections = trainingEmployeeSections) {
  return sections.flatMap((section) => section.fields);
}

export function getTrainingSectionVisibleFields(section, minimized) {
  if (!minimized) {
    return section.fields;
  }

  const keys = section.minimizedFieldKeys ?? section.fields.map((field) => field.key);
  return section.fields.filter((field) => keys.includes(field.key));
}

export function getVisibleTrainingFields(sections, minimizedBySection) {
  return sections.flatMap((section) =>
    getTrainingSectionVisibleFields(section, minimizedBySection[section.key]),
  );
}

export function getTrainingFieldValue(row, key) {
  if (key === 'employee_name') {
    if (row.employee_name) {
      return row.employee_name;
    }

    return employeeDisplayName(row.employee);
  }

  if (key === 'employee_id') {
    return row?.employee_id ?? '';
  }

  if (key === 'total_hours') {
    const total = trainingTotalHours(row);
    return Number.isFinite(total) && total > 0 ? total : '';
  }

  if (key === 'day_segment') {
    return row?.day_segment ?? 0;
  }

  return row?.[key] ?? '';
}

export function getTrainingFieldColSize(field) {
  if (field.colSize) {
    return field.colSize;
  }

  if (field.wide) {
    return 'wide';
  }

  if (field.type === 'date') {
    return 'date';
  }

  if (field.type === 'decimal' || field.type === 'training-hours') {
    return 'decimal';
  }

  if (field.type === 'day-segment') {
    return 'day-segment';
  }

  if (field.type === 'select') {
    return 'select';
  }

  return 'text';
}

export function trainingSelectLabel(fieldKey, value, row = null) {
  if (value == null || value === '') {
    return '—';
  }

  if (fieldKey === 'duration') {
    if (row) {
      return trainingDurationDisplayLabel(row);
    }
    return TRAINING_DURATION_OPTIONS.find((option) => option.value === value)?.label ?? value;
  }

  if (fieldKey === 'status') {
    return TRAINING_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
  }

  if (fieldKey === 'priority') {
    return TRAINING_PRIORITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
  }

  if (fieldKey === 'urgency') {
    return TRAINING_URGENCY_OPTIONS.find((option) => option.value === value)?.label ?? value;
  }

  if (fieldKey === 'employee_id') {
    if (row?.employee_name) {
      return row.employee_name;
    }
    return employeeDisplayName(row?.employee) || String(value);
  }

  if (fieldKey === 'day_segment') {
    return trainingDaySegmentLabel(value);
  }

  return String(value);
}
