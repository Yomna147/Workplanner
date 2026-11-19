export function parseProjectPp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

export function projectIsDone(project) {
  if (!project || project.status === 'completed') {
    return true;
  }

  const totalCount = Number(project.tasks_count ?? 0);
  if (totalCount <= 0) {
    return false;
  }

  const openCount = Number(project.open_tasks_count ?? 0);

  return openCount === 0;
}

/** Done when every project task is marked done (supports live edits in the open part). */
export function projectIsDoneWithLiveTasks(
  project,
  { tasks = [], openTasksInPartAtLoad = 0 } = {},
) {
  if (!project || project.status === 'completed') {
    return true;
  }

  const totalCount = Number(project.tasks_count ?? 0);
  if (totalCount === 0) {
    return false;
  }

  const apiOpen = Number(project.open_tasks_count ?? 0);
  const liveOpenInPart = tasks.filter((task) => !task.done).length;
  const liveOpenTotal = Math.max(0, apiOpen - openTasksInPartAtLoad + liveOpenInPart);

  return liveOpenTotal === 0;
}

/** Resolved status used for labels: on_hold, completed, or active. */
export function getProjectEffectiveStatus(project) {
  if (!project) {
    return 'active';
  }

  if (project.status === 'on_hold') {
    return 'on_hold';
  }

  if (project.status === 'completed' || projectIsDone(project)) {
    return 'completed';
  }

  return 'active';
}

export function formatProjectStatus(project) {
  switch (getProjectEffectiveStatus(project)) {
    case 'on_hold':
      return 'On hold';
    case 'completed':
      return 'Completed';
    default:
      return 'Active';
  }
}

export function formatProjectDropdownLabel(project) {
  const name = project?.name || '';
  const status = getProjectEffectiveStatus(project);

  if (status === 'completed') {
    return `${name} (Done)`;
  }

  if (status === 'on_hold') {
    return `${name} (On hold)`;
  }

  return name;
}

/**
 * PDE view: resolve done/active using API counts, with live task state for the open part.
 */
export function resolvePdeProjectContext(
  project,
  { tasks = [], openTasksInPartAtLoad = 0 } = {},
) {
  if (!project) {
    return {
      status: 'active',
      isDone: false,
      label: 'Active',
    };
  }

  if (project.status === 'on_hold') {
    return {
      status: 'on_hold',
      isDone: false,
      label: 'On hold',
    };
  }

  const isDone = projectIsDoneWithLiveTasks(project, { tasks, openTasksInPartAtLoad });

  return {
    status: isDone ? 'completed' : 'active',
    isDone,
    label: isDone ? 'Completed' : 'Active',
  };
}

/** Active = not completed and has at least one open task (done = 0), or no tasks yet. */
export function projectHasOpenTasks(project) {
  return !projectIsDone(project);
}

export function filterActiveProjects(projects = []) {
  return projects.filter(projectHasOpenTasks);
}

function comparePpAsc(aPp, bPp) {
  const aHas = typeof aPp === 'number';
  const bHas = typeof bPp === 'number';
  if (aHas && bHas) {
    return aPp - bPp;
  }
  if (aHas) {
    return -1;
  }
  if (bHas) {
    return 1;
  }
  return 0;
}

function comparePpDesc(aPp, bPp) {
  const aHas = typeof aPp === 'number';
  const bHas = typeof bPp === 'number';
  if (aHas && bHas) {
    return bPp - aPp;
  }
  if (aHas) {
    return -1;
  }
  if (bHas) {
    return 1;
  }
  return 0;
}

/** Active projects first, then done; within each group newest / highest PP first. */
export function sortProjectsForPde(projects = []) {
  return [...projects].sort((a, b) => {
    const aDone = projectIsDone(a) ? 1 : 0;
    const bDone = projectIsDone(b) ? 1 : 0;
    if (aDone !== bDone) {
      return aDone - bDone;
    }

    const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (aCreated !== bCreated) {
      return bCreated - aCreated;
    }

    const ppOrder = comparePpDesc(parseProjectPp(a.min_pp), parseProjectPp(b.min_pp));
    if (ppOrder !== 0) {
      return ppOrder;
    }

    return (a.name || '').localeCompare(b.name || '');
  });
}

export function sortLegendItemsDesc(items = []) {
  return [...items].sort((a, b) => {
    const ppOrder = comparePpDesc(a.pp, b.pp);
    if (ppOrder !== 0) {
      return ppOrder;
    }
    return (a.name || '').localeCompare(b.name || '');
  });
}

export function parseLeadingProjectNumber(name) {
  const match = String(name ?? '').trim().match(/^(\d+)/);
  if (!match) {
    return null;
  }
  const num = Number(match[1]);
  return Number.isNaN(num) ? null : num;
}

/** Ascending leading project number (e.g. 2622, 2625…), then PP, then name. */
export function sortLegendItemsAsc(items = []) {
  return [...items].sort((a, b) => {
    const aNum = parseLeadingProjectNumber(a.name);
    const bNum = parseLeadingProjectNumber(b.name);
    const aHasNum = typeof aNum === 'number';
    const bHasNum = typeof bNum === 'number';

    if (aHasNum && bHasNum && aNum !== bNum) {
      return aNum - bNum;
    }
    if (aHasNum && !bHasNum) {
      return -1;
    }
    if (!aHasNum && bHasNum) {
      return 1;
    }

    const ppOrder = comparePpAsc(a.pp, b.pp);
    if (ppOrder !== 0) {
      return ppOrder;
    }

    return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
  });
}

export const LEGEND_SORT_OPTIONS = [
  { id: 'number', label: 'Job # ↑' },
  { id: 'number-desc', label: 'Job # ↓' },
  { id: 'pp-asc', label: 'PP ↑' },
  { id: 'pp-desc', label: 'PP ↓' },
  { id: 'name', label: 'Name A–Z' },
  { id: 'name-desc', label: 'Name Z–A' },
];

function compareByProjectNumber(a, b) {
  const aNum = parseLeadingProjectNumber(a.name);
  const bNum = parseLeadingProjectNumber(b.name);
  const aHasNum = typeof aNum === 'number';
  const bHasNum = typeof bNum === 'number';

  if (aHasNum && bHasNum && aNum !== bNum) {
    return aNum - bNum;
  }
  if (aHasNum && !bHasNum) {
    return -1;
  }
  if (!aHasNum && bHasNum) {
    return 1;
  }

  return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
}

export function sortLegendItemsByMode(items = [], mode = 'number') {
  if (mode === 'pp-asc') {
    return [...items].sort((a, b) => {
      const ppOrder = comparePpAsc(a.pp, b.pp);
      if (ppOrder !== 0) return ppOrder;
      return compareByProjectNumber(a, b);
    });
  }

  if (mode === 'pp-desc') {
    return sortLegendItemsDesc(items);
  }

  if (mode === 'name') {
    return [...items].sort((a, b) => (
      (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
    ));
  }

  if (mode === 'name-desc') {
    return [...items].sort((a, b) => (
      (b.name || '').localeCompare(a.name || '', undefined, { numeric: true, sensitivity: 'base' })
    ));
  }

  if (mode === 'number-desc') {
    return [...items].sort((a, b) => compareByProjectNumber(b, a));
  }

  return sortLegendItemsAsc(items);
}

/** Map clickable legend column + direction to a sort mode id. */
export function legendSortModeFromColumn(column = 'project', direction = 'asc') {
  if (column === 'pp') {
    return direction === 'desc' ? 'pp-desc' : 'pp-asc';
  }
  return direction === 'desc' ? 'number-desc' : 'number';
}

export function parseLegendSortMode(mode = 'number') {
  if (mode === 'pp-asc') return { column: 'pp', direction: 'asc' };
  if (mode === 'pp-desc') return { column: 'pp', direction: 'desc' };
  if (mode === 'name-desc' || mode === 'number-desc') {
    return { column: 'project', direction: 'desc' };
  }
  return { column: 'project', direction: 'asc' };
}
