import { TT_DERIVE_THRESHOLD } from '../config/progressRules';
import { employeeMatchesName } from './employeeNames';
import { toStorageDate } from './dateFormat';
import { recalculatePdeDerivedFields } from './taskCalculations';
import { matchWpTaskToTtHours, roundHours1 } from './ttWpProgressSync';

function normalizeTaskRows(taskRows = []) {
  return (taskRows || []).map((row) => ({
    ...row,
    ttHours: Number(row.ttHours) || 0,
    planHours: row.planHours == null ? row.planHours : Number(row.planHours) || 0,
    variance: row.variance == null ? row.variance : Number(row.variance) || 0,
    employeeHours: Array.isArray(row.employeeHours)
      ? row.employeeHours
        .map((person) => ({
          ...person,
          hours: Number(person.hours) || 0,
        }))
        .filter((person) => person.hours > 0)
      : [],
  }));
}

/**
 * Index TT cache summaries by Work Planner project id for Task Progress / section hours.
 */
export function buildTtHoursProgressIndex(summaries = []) {
  const byWpProjectId = new Map();

  for (const summary of summaries || []) {
    if (summary?.wpMatchStatus !== 'matched') continue;

    const wpProjectId = summary.wpProjectId ?? summary.wpProject?.id;
    if (wpProjectId == null) continue;

    const taskRows = normalizeTaskRows(summary.taskRows);
    const ttMap = new Map();

    for (const row of taskRows) {
      const taskKey = String(row.taskName || '').trim().toLowerCase();
      if (!taskKey || row.ttHours <= 0) continue;
      ttMap.set(taskKey, row);
    }

    const key = String(wpProjectId);
    const nextEntry = {
      summary: {
        ...summary,
        taskRows,
      },
      ttMap,
    };

    const existing = byWpProjectId.get(key);
    if (!existing || (summary.totalTtHours || 0) >= (existing.summary.totalTtHours || 0)) {
      byWpProjectId.set(key, nextEntry);
    }
  }

  return byWpProjectId;
}

function ttMapForEmployee(entry, employee = null) {
  const map = new Map();

  for (const row of entry.ttMap.values()) {
    const taskKey = String(row.taskName || '').trim().toLowerCase();
    if (!taskKey) continue;

    let hours = Number(row.ttHours) || 0;
    if (employee && row.employeeHours.length > 0) {
      hours = row.employeeHours
        .filter((person) => (
          (person.wpEmployeeId != null && String(person.wpEmployeeId) === String(employee.id))
          || employeeMatchesName(employee, person.name)
        ))
        .reduce((sum, person) => sum + (Number(person.hours) || 0), 0);
    }

    hours = roundHours1(hours);
    if (hours > 0) {
      map.set(taskKey, hours);
    }
  }

  return map;
}

/** TT hours logged for one WP task (optionally scoped to the selected operative). */
export function resolveTtLoggedHoursForTask({
  index,
  wpProjectId,
  taskName,
  employee = null,
}) {
  if (!index || wpProjectId == null || !taskName) {
    return null;
  }

  const entry = index.get(String(wpProjectId));
  if (!entry) {
    return null;
  }

  const ttMap = ttMapForEmployee(entry, employee);
  if (ttMap.size === 0) {
    return null;
  }

  const matched = matchWpTaskToTtHours(taskName, ttMap);
  if (matched == null || matched <= 0) {
    return null;
  }

  return roundHours1(matched);
}

export function enrichProgressProjectGroups(groups, index, employee = null) {
  if (!index?.size || !Array.isArray(groups)) {
    return groups;
  }

  return groups.map((group) => ({
    ...group,
    tasks: (group.tasks || []).map((task) => {
      const ttHours = resolveTtLoggedHoursForTask({
        index,
        wpProjectId: group.project?.id,
        taskName: task.task_name,
        employee,
      });

      return {
        ...task,
        tt_hours_logged: ttHours != null ? String(ttHours) : '',
      };
    }),
  }));
}

function parseHours(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Write Time Tracking hours into Act on PDE rows and derive progress % from Act / Plan
 * (unless % is already ≥ the TT threshold).
 */
export function applyTtHoursToPdeTasks(tasks, {
  index,
  wpProjectId,
  nrms,
  todayYmd = toStorageDate(new Date()),
} = {}) {
  const empty = {
    tasks: tasks || [],
    matched: 0,
    skippedDone: 0,
    totalTt: 0,
    totalPlan: 0,
    projectMatched: Boolean(index?.has(String(wpProjectId))),
  };

  if (!index?.size || wpProjectId == null || !Array.isArray(tasks)) {
    return empty;
  }

  let matched = 0;
  let skippedDone = 0;
  let totalTt = 0;
  let totalPlan = 0;

  const nextTasks = tasks.map((task) => {
    if (task?.done) {
      skippedDone += 1;
      return task;
    }

    const ttHours = resolveTtLoggedHoursForTask({
      index,
      wpProjectId,
      taskName: task.task_name,
    });

    if (ttHours == null) {
      return task;
    }

    matched += 1;
    totalTt += ttHours;
    totalPlan += parseHours(task.plan);

    const currentPer = parseHours(task.progress_per);
    const withTt = {
      ...task,
      act: String(ttHours),
      progress_updated: todayYmd,
    };

    return recalculatePdeDerivedFields(withTt, {
      nrms,
      respectManualProgressPer: currentPer >= TT_DERIVE_THRESHOLD,
    });
  });

  return {
    tasks: nextTasks,
    matched,
    skippedDone,
    totalTt: roundHours1(totalTt),
    totalPlan: roundHours1(totalPlan),
    projectMatched: Boolean(index.has(String(wpProjectId))),
  };
}
