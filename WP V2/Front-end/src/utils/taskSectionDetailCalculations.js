/** DL budget breakdown columns (DL Input Hours page only). */
const DL_BUDGET_HOUR_KEYS = [
  'dl_sec_hrs_02',
  'dl_sec_hrs_03',
  'dl_sec_hrs_04',
  'dl_sec_hrs_05',
  'dl_sec_hrs_06',
];

/** Time Planning Sheet stage keys entered by operatives on Project Progress. */
const SECTION_HOUR_KEYS = [
  'sec_hrs_02',
  'sec_hrs_03',
  'sec_hrs_04',
  'sec_hrs_05',
  'sec_hrs_06',
  'sec_hrs_07',
  'sec_hrs_extra',
];

function parseNum(value) {
  const num = parseFloat(value);
  return Number.isNaN(num) ? 0 : num;
}

function sumSectionHours(task, keys) {
  return keys.reduce((sum, key) => sum + parseNum(task?.[key]), 0);
}

export function recalculateSectionHoursTotal(task) {
  const total = sumSectionHours(task, SECTION_HOUR_KEYS);

  if (total <= 0 && SECTION_HOUR_KEYS.every((key) => {
    const value = task?.[key];
    return value === null || value === undefined || String(value).trim() === '';
  })) {
    return '';
  }

  return String(Math.round(total * 100) / 100);
}

export function applySectionDetailFieldChange(task, key, value) {
  const next = { ...task, [key]: value };

  if (SECTION_HOUR_KEYS.includes(key)) {
    next.sec_hrs_total = recalculateSectionHoursTotal(next);
  }

  return next;
}

export function sumDlSectionHours(task) {
  return sumSectionHours(task, DL_BUDGET_HOUR_KEYS);
}

function resolveExpectedHours(task, compareDlSectionsOnly) {
  if (compareDlSectionsOnly) {
    return sumDlSectionHours(task);
  }

  return parseNum(task?.sec_hrs_total ?? recalculateSectionHoursTotal(task));
}

export function taskExceedsDlHours(task, options = {}) {
  const { compareDlSectionsOnly = false } = options;
  const dlRaw = String(task?.dl ?? '').trim();
  if (dlRaw === '') {
    return false;
  }
  const expected = resolveExpectedHours(task, compareDlSectionsOnly);
  const dlHours = parseNum(task.dl);
  return expected > dlHours + 0.001;
}

/** Tasks where expected section total exceeds the DL Input hours budget. */
export function findTasksExceedingDlHours(tasks = [], options = {}) {
  const {
    compareDlSectionsOnly = false,
    addedByName = '',
  } = options;

  return (tasks || []).filter((task) => (
    taskExceedsDlHours(task, { compareDlSectionsOnly })
  )).map((task) => {
    const expected = resolveExpectedHours(task, compareDlSectionsOnly);
    const dlHours = parseNum(task.dl);
    const dlSections = sumDlSectionHours(task);
    const rework = parseNum(task?.sec_hrs_07);
    const extra = parseNum(task?.sec_hrs_extra);

    return {
      id: task.id,
      task_name: task.task_name || `Task ${task.id}`,
      part_name: task.part_name || '',
      expected,
      dl: dlHours,
      over: Math.round((expected - dlHours) * 100) / 100,
      added_by: String(
        task.added_by
        || task.owner
        || task.dl_owner
        || addedByName
        || '',
      ).trim(),
      expectedLabel: compareDlSectionsOnly ? 'DL sections' : 'TPS expected',
      breakdown: compareDlSectionsOnly
        ? null
        : {
          dlSections,
          rework,
          extra,
        },
    };
  });
}

export {
  SECTION_HOUR_KEYS,
  DL_BUDGET_HOUR_KEYS,
  /** @deprecated Use DL_BUDGET_HOUR_KEYS */
  DL_BUDGET_HOUR_KEYS as DL_SECTION_HOUR_KEYS,
};
