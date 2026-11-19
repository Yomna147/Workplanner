import { recalculateTaskPri } from '../constants/projectTaskFields';
import { parseProjectPp } from './projectSort';

/**
 * Apply rebalance API results to in-memory PDE task rows.
 *
 * @param {Array} tasks
 * @param {{ project_id: number, pp: string }[]} assignments
 * @param {number|string} currentProjectId
 */
export function applyPpAssignmentsToTasks(tasks, assignments, currentProjectId) {
  const assignment = (assignments ?? []).find(
    (entry) => String(entry.project_id) === String(currentProjectId),
  );

  if (!assignment) {
    return tasks;
  }

  return tasks.map((task) => {
    const next = { ...task, pp: assignment.pp };
    return {
      ...next,
      pri: recalculateTaskPri(next),
    };
  });
}

export function getAssignedPp(assignments, projectId) {
  const match = (assignments ?? []).find(
    (entry) => String(entry.project_id) === String(projectId),
  );

  return match?.pp ?? '';
}

export function describePpRebalance(assignments, { projectName = 'Project' } = {}) {
  if (!assignments?.length) {
    return '';
  }

  const summary = assignments
    .map((entry) => `${entry.project_id === undefined ? projectName : `Project ${entry.project_id}`}: PP ${entry.pp}`)
    .join(', ');

  return `Project priorities rebalanced (${summary}).`;
}

export function normalizeRequestedProjectPp(value) {
  const parsed = parseProjectPp(value);
  if (parsed == null) {
    return null;
  }

  return parsed;
}
