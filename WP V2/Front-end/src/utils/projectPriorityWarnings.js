import {
  getProjectEffectiveStatus,
  parseProjectPp,
  projectIsDoneWithLiveTasks,
} from './projectSort';

/** Match backend project list: highest task PP on the project (stored as min_pp). */
export function getProjectEffectivePp(project, tasks = []) {
  let effective = parseProjectPp(project?.min_pp);

  tasks.forEach((task) => {
    const pp = parseProjectPp(task?.pp);
    if (pp == null) {
      return;
    }
    if (effective == null || pp > effective) {
      effective = pp;
    }
  });

  return effective;
}

function isActiveProject(project, { liveTasks = [], openTasksInPartAtLoad = 0 } = {}) {
  if (!project || getProjectEffectiveStatus(project) !== 'active') {
    return false;
  }

  return !projectIsDoneWithLiveTasks(project, {
    tasks: liveTasks,
    openTasksInPartAtLoad,
  });
}

export function listActiveProjectsWithPp(
  projects = [],
  {
    currentProjectId = null,
    currentTasks = [],
    openTasksInPartAtLoad = 0,
  } = {},
) {
  return projects
    .map((project) => {
      const isCurrent = currentProjectId != null
        && String(project.id) === String(currentProjectId);
      const pp = getProjectEffectivePp(
        project,
        isCurrent ? currentTasks : [],
      );

      if (!isActiveProject(project, {
        liveTasks: isCurrent ? currentTasks : [],
        openTasksInPartAtLoad: isCurrent ? openTasksInPartAtLoad : 0,
      }) || pp == null) {
        return null;
      }

      return {
        projectId: project.id,
        name: project.name || `Project #${project.id}`,
        pp,
      };
    })
    .filter(Boolean);
}

export function findDuplicatePpGroups(activeProjects = []) {
  const groups = new Map();

  activeProjects.forEach((entry) => {
    if (!groups.has(entry.pp)) {
      groups.set(entry.pp, []);
    }
    groups.get(entry.pp).push(entry);
  });

  return [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([pp, entries]) => ({ pp, entries }));
}

function formatProjectList(entries = []) {
  return entries.map((entry) => `${entry.name} (PP ${entry.pp})`).join(', ');
}

/**
 * Warn when a PP edit changes this project's effective priority relative to others.
 */
export function analyzeProjectPpChange({
  projects = [],
  currentProjectId,
  currentProjectName = '',
  previousTasks = [],
  nextTasks = [],
  openTasksInPartAtLoad = 0,
}) {
  const currentProject = projects.find(
    (project) => String(project.id) === String(currentProjectId),
  );
  if (!currentProject) {
    return [];
  }

  const previousPp = getProjectEffectivePp(currentProject, previousTasks);
  const nextPp = getProjectEffectivePp(currentProject, nextTasks);

  if (nextPp == null || nextPp === previousPp) {
    return [];
  }

  const activeProjects = listActiveProjectsWithPp(projects, {
    currentProjectId,
    currentTasks: nextTasks,
    openTasksInPartAtLoad,
  });

  const others = activeProjects.filter(
    (entry) => String(entry.projectId) !== String(currentProjectId),
  );

  const warnings = [];
  const duplicates = others.filter((entry) => entry.pp === nextPp);

  if (duplicates.length > 0) {
    warnings.push({
      type: 'duplicate',
      title: 'Same project priority',
      message: `PP ${nextPp} is already used by ${formatProjectList(duplicates)}. Multiple active projects now share the same priority.`,
    });
    warnings.push({
      type: 'replaces',
      title: 'Priority order overlap',
      message: `${currentProjectName || 'This project'} will share priority order with ${formatProjectList(duplicates)}. The algorithm breaks ties by task creation date.`,
    });
    return warnings;
  }

  if (previousPp != null && nextPp < previousPp) {
    const overtaken = others.filter(
      (entry) => entry.pp >= nextPp && entry.pp < previousPp,
    );

    if (overtaken.length > 0) {
      warnings.push({
        type: 'replaces',
        title: 'Priority order change',
        message: `${currentProjectName || 'This project'} (PP ${nextPp}) will be scheduled before ${formatProjectList(overtaken)}.`,
      });
    }
  }

  if (previousPp != null && nextPp > previousPp) {
    const passedBy = others.filter(
      (entry) => entry.pp <= nextPp && entry.pp > previousPp,
    );

    if (passedBy.length > 0) {
      warnings.push({
        type: 'replaces',
        title: 'Priority order change',
        message: `${formatProjectList(passedBy)} will now be scheduled before ${currentProjectName || 'this project'} (PP ${nextPp}).`,
      });
    }
  }

  return warnings;
}

/** Scan all active projects for duplicate PP values. */
export function analyzeActiveProjectPpDuplicates(
  projects = [],
  {
    currentProjectId = null,
    currentTasks = [],
    openTasksInPartAtLoad = 0,
  } = {},
) {
  const activeProjects = listActiveProjectsWithPp(projects, {
    currentProjectId,
    currentTasks,
    openTasksInPartAtLoad,
  });

  return findDuplicatePpGroups(activeProjects).map(({ pp, entries }) => ({
    type: 'duplicate',
    title: 'Same project priority',
    message: `PP ${pp} is shared by ${formatProjectList(entries)}.`,
  }));
}

export function analyzeNewProjectPp({
  projects = [],
  projectName = '',
  pp,
  status = 'active',
}) {
  if (status !== 'active') {
    return [];
  }

  const parsedPp = parseProjectPp(pp);
  if (parsedPp == null) {
    return [];
  }

  const activeProjects = listActiveProjectsWithPp(projects);
  const duplicates = activeProjects.filter((entry) => entry.pp === parsedPp);

  if (duplicates.length === 0) {
    return [];
  }

  const label = projectName.trim() || 'This project';

  return [
    {
      type: 'duplicate',
      title: 'Same project priority',
      message: `${label} will use PP ${parsedPp}, which is already assigned to ${formatProjectList(duplicates)}.`,
    },
    {
      type: 'replaces',
      title: 'Priority order overlap',
      message: `${label} will share priority order with ${formatProjectList(duplicates)}. The algorithm breaks ties by task creation date.`,
    },
  ];
}
