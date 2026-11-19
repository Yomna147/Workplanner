import { extractNrmNumberFromTaskName, isHistogramOapValue } from '../components/gantt/ganttUtils';
import { employeeMatchesName } from './employeeNames';

/**
 * NRM section numbers where any operative on the team has a value in the OAP table.
 */
export function collectTeamOapNrmNumbers(employees = [], teamId) {
  if (!teamId) {
    return new Set();
  }

  const numbers = new Set();
  employees
    .filter((employee) => String(employee.team_id) === String(teamId))
    .forEach((employee) => {
      (employee.nrms || []).forEach((nrm) => {
        if (!isHistogramOapValue(nrm?.pivot?.OAP)) {
          return;
        }
        const number = String(nrm?.number || '').trim();
        if (number) {
          numbers.add(number);
        }
      });
    });

  return numbers;
}

export function resolveTeamIdForAssignee(employees = [], assigneeName) {
  const label = String(assigneeName || '').trim();
  if (!label) {
    return null;
  }

  const match = employees.find((employee) => employeeMatchesName(employee, label));
  return match?.team_id ?? null;
}

/**
 * Keep only part tasks whose NRM prefix matches a team OAP column.
 * Always includes the focused task when possible.
 */
export function filterTasksForTeamOapSections(tasks = [], allowedNrmNumbers, focusTaskId = null) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!allowedNrmNumbers || allowedNrmNumbers.size === 0) {
    if (focusTaskId == null) {
      return list;
    }
    const focused = list.find((task) => String(task.id) === String(focusTaskId));
    return focused ? [focused] : list;
  }

  const filtered = list.filter((task) => {
    const nrmNumber = extractNrmNumberFromTaskName(task?.task_name);
    return nrmNumber && allowedNrmNumbers.has(nrmNumber);
  });

  if (filtered.length > 0) {
    return filtered;
  }

  if (focusTaskId == null) {
    return filtered;
  }

  const focused = list.find((task) => String(task.id) === String(focusTaskId));
  return focused ? [focused] : filtered;
}
