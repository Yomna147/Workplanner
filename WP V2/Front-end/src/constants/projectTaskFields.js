import { effectiveTaskOverride } from '../utils/taskOverrides';

export const emptyTask = () => ({
  task_name: '',
  est: '',
  hrs_per: '',
  red: '',
  dl: '',
  rfi: '',
  pd: '',
  buf: '',
  adj: '',
  plan: '',
  doc_supply: '',
  con: '',
  completion: '',
  pp: '',
  rap: '',
  pri: '',
  hbs: '',
  ats: '',
  ots: '',
  dd: '',
  sp: '',
  ts: '',
  sh: '',
  al: '',
  algorithm_1: '',
  algorithm_2: '',
  algorithm_3: '',
  override_1: '',
  override_2: '',
  override_3: '',
  override_share_1: '',
  override_share_2: '',
  override_share_3: '',
  dl_override_1: '',
  dl_override_2: '',
  dl_override_3: '',
  dl_dl: '',
  dl_rfi: '',
  dl_con: '',
  dl_progress_updated: '',
  dl_progress_per: '',
  dl_done: '',
  dl_owner: '',
  dl_project_completion_date: '',
  progress_updated: '',
  progress_per: '',
  progress_left_hours: '',
  progress_plan: '',
  tt_hours_logged: '',
  act: '',
  pre: '',
  duration_left: '',
  done: false,
  owner: '',
  project_completion_date: '',
  part_name: '',
  sec_hrs_02: '',
  sec_hrs_03: '',
  sec_hrs_04: '',
  sec_hrs_05: '',
  sec_hrs_06: '',
  sec_hrs_07: '',
  sec_hrs_extra: '',
  sec_hrs_total: '',
  dl_sec_hrs_approved: false,
  dl_sec_hrs_02: '',
  dl_sec_hrs_03: '',
  dl_sec_hrs_04: '',
  dl_sec_hrs_05: '',
  dl_sec_hrs_06: '',
});

export const taskSections = [
  {
    key: 'task',
    title: 'Task',
    fields: [
      {
        key: 'task_name',
        label: 'Task Name',
        type: 'text',
        wide: true,
        title: 'Name of the task',
      },
    ],
  },
  {
    key: 'hours',
    title: 'Hours',
    minimizedFieldKeys: ['plan'],
    fields: [
      { key: 'est', label: 'Est', title: 'Estimated hours for the task' },
      { key: 'hrs_per', label: '%', title: 'Hours percentage (% of estimate used for reduced hours)' },
      { key: 'red', label: 'Red', readOnly: true, source: 'calculated', title: 'Estimate reduction (hours) — Est × %' },
      { key: 'dl', label: 'DL', title: 'Divisional leaders (hours)' },
      { key: 'rfi', label: 'RFI', title: 'Request for information', type: 'checkbox' },
      { key: 'pd', label: 'PD', title: 'Production director / planner (hours)' },
      { key: 'buf', label: 'Buf', title: 'Buffer hours allocated' },
      { key: 'adj', label: 'Adj', title: 'Adjustment by production director' },
      { key: 'plan', label: 'Plan', title: 'Planned hours expected for the task', source: 'calculated', readOnly: true },
    ],
  },
  {
    key: 'supply',
    title: 'Supply & Completion Dates',
    minimizedTitle: 'Dates',
    minimizedFieldKeys: ['completion'],
    fields: [
      { key: 'doc_supply', label: 'Doc Supply', type: 'date', title: 'Document supply date (start date)' },
      {
        key: 'con',
        label: 'Con',
        type: 'select',
        colSize: 'confidence',
        options: ['', '<2WD', '<4WD', '<7WD', '>7WD'],
        title: 'Confidence band for supply timing',
      },
      { key: 'completion', label: 'Completion', type: 'date', title: 'Task completion date' },
    ],
  },
  {
    key: 'priority',
    title: 'Priority & Team Size',
    minimizedTitle: 'Priority',
    minimizedFieldKeys: ['pri', 'ats'],
    fields: [
      { key: 'pp', label: 'PP', colSize: 'priority', title: 'Project priority — type any number; all active projects are then rearranged to even values (2, 4, 6…).' },
      { key: 'rap', label: 'RAP', colSize: 'priority', title: 'NRM task priority (from the task list)' },
      { key: 'pri', label: 'Pri', colSize: 'priority', readOnly: true, source: 'calculated', title: 'Task priority (RAP + PP)' },
      {
        key: 'sh',
        label: 'SH %',
        type: 'number',
        colSize: 'percent',
        title: 'Share percentage — percentage of the task assigned to the first operative; the remainder goes to the next operative',
      },
      { key: 'ats', label: 'ATS', colSize: 'num', readOnly: true, source: 'auto', title: 'Allocation team size (TS) — set by Run algorithm' },
      { key: 'ots', label: 'OTS', type: 'number', colSize: 'num', title: 'Override team size (AL) — manual, whole number 0–3' },
      { key: 'dd', label: 'DD', title: 'Delay days' },
      { key: 'sp', label: 'SP', title: 'Single person task (limits allocation to one operative)' },
    ],
  },
  {
    key: 'allocation',
    title: 'Allocation',
    minimizedFieldKeys: ['allocation'],
    fields: [
      {
        key: 'allocation',
        label: 'Person + Hours Share %',
        type: 'dl_allocation',
        colSize: 'allocation',
        title: 'Assign operatives and set their hours share percentages. Changing a % pins everyone on the row so the split is kept on the next algorithm run. Grey = algorithm output; orange = manual override.',
      },
    ],
  },
  {
    key: 'progress',
    title: 'Progress - Details',
    minimizedTitle: 'Progress',
    minimizedFieldKeys: ['act', 'pre', 'duration_left'],
    fields: [
      { key: 'progress_updated', label: 'Updated', type: 'date', title: 'Date this task row was last updated' },
      { key: 'progress_per', label: '%', colSize: 'percent', title: 'Progress percentage complete' },
      { key: 'progress_left_hours', label: 'Left', source: 'calculated', readOnly: true, title: 'Hours remaining at the current progress %' },
      { key: 'progress_plan', label: 'Plan', source: 'calculated', readOnly: true, title: 'Planned hours expected for the task (same as Hours Plan)' },
      { key: 'act', label: 'Act', title: 'Actual hours worked — filled from Time Tracking by Compare TT hrs' },
      { key: 'pre', label: 'Pre', title: 'Previously recorded hours' },
      { key: 'duration_left', label: 'Left', source: 'calculated', readOnly: true, title: 'Duration left: plan minus actual and previous hours' },
    ],
  },
  {
    key: 'completion',
    title: 'Project Sections Completed',
    minimizedFieldKeys: ['done', 'owner'],
    fields: [
      { key: 'done', label: 'Done', type: 'checkbox', title: 'Mark task as done' },
      { key: 'owner', label: 'Owner', type: 'employee', title: 'Task owner' },
      { key: 'project_completion_date', label: 'Completion Date', type: 'date', title: 'Project section completion date' },
    ],
  },
];

/** DL Project Data Update — divisional leaders edit hours, dates from PDE are read-only. */
export const dlTaskSections = [
  {
    key: 'task',
    title: 'Task',
    fields: [
      {
        key: 'task_name',
        label: 'Task Name',
        type: 'text',
        wide: true,
        readOnly: true,
        title: 'Name of the task (set in Project Data Entry)',
      },
    ],
  },
  {
    key: 'hours',
    title: 'Hours',
    minimizedTitle: 'Hours',
    minimizedFieldKeys: ['rfi', 'dl'],
    fields: [
      { key: 'rfi', label: 'RFI', title: 'Request for information', type: 'checkbox' },
      {
        key: 'dl_sec_hrs_02',
        label: 'Prev',
        colSize: 'section-hour',
        title: 'Previewing',
      },
      {
        key: 'dl_sec_hrs_03',
        label: 'Meas',
        colSize: 'section-hour',
        title: 'Measuring',
      },
      {
        key: 'dl_sec_hrs_04',
        label: 'Bill',
        colSize: 'section-hour',
        title: 'Billing',
      },
      {
        key: 'dl_sec_hrs_05',
        label: 'Chk/Edit',
        colSize: 'section-hour',
        title: 'Checking/Editing',
      },
      {
        key: 'dl_sec_hrs_06',
        label: 'Buffer',
        colSize: 'section-hour',
        title: 'Buffer',
      },
      {
        key: 'dl',
        label: 'DL',
        title: 'Divisional leaders total hours (sum of section hours)',
      },
    ],
  },
  {
    key: 'supply',
    title: 'Supply & Completion Dates',
    minimizedTitle: 'Dates',
    minimizedFieldKeys: ['completion'],
    fields: [
      {
        key: 'doc_supply',
        label: 'Doc Supply',
        type: 'date',
        readOnly: true,
        title: 'Document supply date (from Project Data Entry)',
      },
      {
        key: 'con',
        label: 'Con',
        type: 'select',
        colSize: 'confidence',
        options: ['', '<2WD', '<4WD', '<7WD', '>7WD'],
        title: 'Confidence band for supply timing',
      },
      {
        key: 'completion',
        label: 'Completion',
        type: 'date',
        readOnly: true,
        title: 'Task completion date (from Project Data Entry)',
      },
    ],
  },
  {
    key: 'allocation',
    title: 'Allocation',
    minimizedFieldKeys: ['allocation'],
    fields: [
      {
        key: 'allocation',
        label: 'Person + Hours Share %',
        type: 'dl_allocation',
        colSize: 'allocation',
        title: 'Assign measurer/billers and set their hours share percentages',
      },
    ],
  },
  {
    key: 'progress',
    title: 'Progress - Details',
    minimizedTitle: 'Progress',
    minimizedFieldKeys: ['progress_per', 'progress_left_hours'],
    fields: [
      { key: 'progress_updated', label: 'Updated', type: 'date', title: 'Date this task row was last updated' },
      { key: 'progress_per', label: '%', type: 'number', colSize: 'percent', title: 'Progress percentage complete' },
      {
        key: 'progress_left_hours',
        label: 'Left',
        readOnly: true,
        source: 'calculated',
        title: 'Hours remaining at the current progress %',
      },
    ],
  },
  {
    key: 'completion',
    title: 'Project Sections Completed',
    minimizedFieldKeys: ['done', 'owner'],
    fields: [
      { key: 'done', label: 'Done', type: 'checkbox', title: 'Mark task as done' },
      { key: 'owner', label: 'Owner', type: 'employee', title: 'Task owner' },
      {
        key: 'project_completion_date',
        label: 'Completion Date',
        type: 'date',
        title: 'Project section completion date',
      },
    ],
  },
];

export function getDlFieldLabel(key, fallback = key) {
  for (const section of dlTaskSections) {
    const field = section.fields.find((item) => item.key === key);
    if (field?.label) {
      return field.label;
    }
  }
  return fallback;
}

/** Time Planning Sheet — operatives log hours per workflow section; DL/RR approve. */
export const projectProgressTaskSections = [
  {
    key: 'task',
    title: 'Task',
    fields: [
      {
        key: 'task_name',
        label: 'Task Name',
        type: 'text',
        wide: true,
        readOnly: true,
        title: 'Assigned task name',
      },
      {
        key: 'part_name',
        label: 'Part',
        type: 'text',
        colSize: 'text',
        readOnly: true,
        title: 'Project part',
      },
      {
        key: 'doc_supply',
        label: 'Start',
        type: 'date',
        readOnly: true,
        title: 'Task start date (document supply)',
      },
      {
        key: 'completion',
        label: 'End',
        type: 'date',
        readOnly: true,
        title: 'Task end date (completion)',
      },
      {
        key: 'tt_hours_logged',
        label: 'TT hrs',
        readOnly: true,
        source: 'calculated',
        colSize: 'num',
        title: 'Time Tracking hours logged (last month + this month) for this operative on this task',
      },
    ],
  },
  {
    key: 'section_details',
    title: 'Expected Hours',
    minimizedTitle: 'Expected Hours',
    minimizedFieldKeys: ['sec_hrs_02', 'sec_hrs_total', 'dl_sec_hrs_approved'],
    fields: [
      {
        key: 'sec_hrs_02',
        label: '02 Sort',
        colSize: 'section-hour',
        title: '02 - Document Sort, Previewing',
      },
      {
        key: 'sec_hrs_03',
        label: '03 Meas',
        colSize: 'section-hour',
        title: '03 - Measurement, Calculations',
      },
      {
        key: 'sec_hrs_04',
        label: '04 Bill',
        colSize: 'section-hour',
        title: '04 - Bill, Edit, Sort, Present',
      },
      {
        key: 'sec_hrs_05',
        label: '05 Rev',
        colSize: 'section-hour',
        title: '05 - Personal (Self) Review',
      },
      {
        key: 'sec_hrs_06',
        label: '06 Chk',
        colSize: 'section-hour',
        title: '06 - External Check / Review',
      },
      {
        key: 'sec_hrs_07',
        label: '07 Rwk',
        colSize: 'section-hour',
        title: '07 - Rework / Correction (10% of total)',
      },
      {
        key: 'sec_hrs_extra',
        label: 'EXTRA',
        colSize: 'section-hour',
        title: 'EXTRA hours due to TAs and Updates',
      },
      {
        key: 'sec_hrs_total',
        label: 'Total',
        readOnly: true,
        source: 'calculated',
        colSize: 'num',
        title: 'Total section hours',
      },
      {
        key: 'dl_sec_hrs_approved',
        label: 'DL',
        type: 'checkbox',
        title: 'DL approval for detailed section hours',
      },
    ],
  },
];

export const allTaskFieldKeys = taskSections.flatMap((section) =>
  section.fields.map((field) => field.key),
);

export const allTaskFields = taskSections.flatMap((section) => section.fields);

export function getSectionVisibleFields(section, minimized) {
  if (!minimized) {
    return section.fields;
  }
  const keys = section.minimizedFieldKeys ?? section.fields.map((field) => field.key);
  return section.fields.filter((field) => keys.includes(field.key));
}

export function getVisibleTaskFields(sections, minimizedBySection) {
  return sections.flatMap((section) =>
    getSectionVisibleFields(section, minimizedBySection[section.key]),
  );
}

export function createInitialMinimizedSections(
  sections = taskSections,
  { startMinimized = false, defaultMinimizedKeys = null } = {},
) {
  const keySet = Array.isArray(defaultMinimizedKeys)
    ? new Set(defaultMinimizedKeys)
    : null;

  return Object.fromEntries(sections.map((section) => {
    const canMinimize = Boolean(section.minimizedFieldKeys?.length);
    if (keySet) {
      return [section.key, keySet.has(section.key) && canMinimize];
    }
    return [section.key, startMinimized ? canMinimize : false];
  }));
}

export function getFieldTooltip(field) {
  const label = field.title || field.label;
  const source = getFieldSource(field);
  const sourceDescriptions = {
    manual: 'Manual entry — editable on this page.',
    calculated: 'Calculated — derived from other fields.',
    auto: 'Algorithm output — set by Run algorithm.',
  };
  const sourceNote = sourceDescriptions[source];
  if (label && sourceNote && source !== 'manual') {
    return `${label} — ${sourceNote}`;
  }
  return label || sourceNote || '';
}

export function getFieldSource(field) {
  if (field.source) {
    return field.source;
  }
  if (
    field.key === 'pri'
    || field.key === 'duration_left'
    || field.key === 'progress_left_hours'
    || field.key === 'red'
    || field.key === 'sec_hrs_total'
  ) {
    return 'calculated';
  }
  if (field.readOnly || field.key === 'plan') {
    return 'auto';
  }
  return 'manual';
}

const MIRRORED_TASK_FIELD_VALUES = {
  progress_plan: 'plan',
  ats: 'ts',
  ots: 'al',
  hbs: 'sh',
};

export function getTaskFieldValue(task, fieldKey, options = {}) {
  if (options.preferDlOwner && fieldKey === 'owner') {
    return String(task?.dl_owner ?? '').trim();
  }

  if (fieldKey?.startsWith('override_') && options.suppressAlgorithmDuplicateOverrides) {
    return effectiveTaskOverride(task, fieldKey.replace('override_', ''));
  }

  const mirrorKey = MIRRORED_TASK_FIELD_VALUES[fieldKey];
  if (mirrorKey) {
    return task?.[mirrorKey] ?? task?.[fieldKey] ?? '';
  }
  if (fieldKey === 'sh') {
    return task?.sh ?? task?.hbs ?? '';
  }
  return task?.[fieldKey];
}

export function getFieldSourceClassName(field) {
  return `pde-field-source--${getFieldSource(field)}`;
}

export function recalculateTaskPri(row) {
  const rap = parseFloat(row.rap || 0);
  const pp = parseFloat(row.pp || 0);
  if (!rap && !pp) {
    return row.pri || '';
  }
  return String(Math.round((rap + pp) * 100) / 100);
}

export function getFieldColSize(field) {
  if (field.colSize) return field.colSize;
  if (field.key?.startsWith('sec_hrs_') && field.key !== 'sec_hrs_total') {
    return 'section-hour';
  }
  if (field.key?.startsWith('dl_sec_hrs_')) {
    return 'section-hour';
  }
  if (field.key?.startsWith('algorithm_')) return 'algorithm';
  if (field.key?.startsWith('override_')) return 'override';
  if (field.type === 'checkbox') return 'check';
  if (field.type === 'date') return 'date';
  if (field.type === 'employee' || field.type === 'user') return 'employee';
  if (field.type === 'select') return 'select';
  if (field.wide) return 'wide';
  return 'num';
}
