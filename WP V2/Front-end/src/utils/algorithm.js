import { employeeDisplayName, employeeMatchesName } from './employeeNames';
import { shouldPreserveTaskOwner } from './dlMirrorFields';
import { normalizeWholeNumber } from './taskCalculations';

export function taskHasEstHours(task) {
  if (task?.est === null || task?.est === undefined || String(task.est).trim() === '') {
    return false;
  }

  const est = Number(task.est);
  return !Number.isNaN(est) && est > 0;
}

export function taskHasPlanHours(task) {
  if (task?.plan === null || task?.plan === undefined || String(task.plan).trim() === '') {
    return false;
  }

  const plan = Number(task.plan);
  return !Number.isNaN(plan) && plan > 0;
}

export function taskHasAlgorithmAssignment(task) {
  return ['algorithm_1', 'algorithm_2', 'algorithm_3'].some(
    (field) => String(task?.[field] ?? '').trim() !== '',
  );
}

export function validateTasksForAlgorithm(tasks) {
  const invalidRows = [];

  tasks.forEach((task, index) => {
    if (task.done || !taskHasEstHours(task)) {
      return;
    }

    const plan = Number(task.plan);
    const hasPlan = task.plan !== '' && task.plan != null && !Number.isNaN(plan) && plan > 0;
    const hasDocSupply = Boolean(task.doc_supply) && !Number.isNaN(Date.parse(task.doc_supply));
    const hasCompletion = Boolean(task.completion) && !Number.isNaN(Date.parse(task.completion));

    const isEmptyRow =
      !task.task_name &&
      !hasPlan &&
      !hasDocSupply &&
      !hasCompletion;

    if (isEmptyRow) {
      return;
    }

    if (!hasPlan || !hasDocSupply || !hasCompletion) {
      invalidRows.push({
        index,
        taskName: task.task_name || `Row ${index + 1}`,
      });
    }
  });

  return invalidRows;
}

export function validateTasksForDlAlgorithm(tasks) {
  const invalidRows = [];

  tasks.forEach((task, index) => {
    if (task.done || !taskHasPlanHours(task)) {
      return;
    }

    const hasDocSupply = Boolean(task.doc_supply) && !Number.isNaN(Date.parse(task.doc_supply));
    const hasCompletion = Boolean(task.completion) && !Number.isNaN(Date.parse(task.completion));

    const isEmptyRow =
      !task.task_name &&
      !hasDocSupply &&
      !hasCompletion;

    if (isEmptyRow) {
      return;
    }

    if (!hasDocSupply || !hasCompletion) {
      invalidRows.push({
        index,
        taskName: task.task_name || `Row ${index + 1}`,
      });
    }
  });

  return invalidRows;
}

export function resolveAssigneeDisplayName(value, employees = []) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const match = employees.find((employee) => employeeMatchesName(employee, trimmed));
  return match ? employeeDisplayName(match) : trimmed;
}

function pickAlgorithmField(task, index) {
  return task?.[`Algorithm_${index}`] ?? task?.[`algorithm_${index}`] ?? '';
}

export async function saveAllAlgorithmResults(api) {
  const response = await api.post('/algorithm/save-results');
  return response.data;
}

export function mergeAlgorithmResults(tasks, filteredTasks, employees = [], options = {}) {
  const usePlanGate = Boolean(options.usePlanGate);
  const hourGate = usePlanGate ? taskHasPlanHours : taskHasEstHours;

  const updatedById = new Map(
    (filteredTasks ?? []).map((task) => [Number(task.id), task]),
  );

  return tasks.map((task) => {
    if (task.done || !hourGate(task)) {
      return task;
    }

    const match = updatedById.get(Number(task.id));
    if (!match) {
      return {
        ...task,
        algorithm_1: '',
        algorithm_2: '',
        algorithm_3: '',
      };
    }

    const ts = normalizeWholeNumber(match.TS ?? task.ts ?? task.ats ?? '');
    // Algorithm SH is converted to an hour target internally. Keep the
    // planner-facing value as the original task-share percentage.
    const sh = normalizeWholeNumber(
      match.SH_Percent ?? task.sh ?? task.hbs ?? '',
      { min: 0, max: 100 },
    );

    const nextTask = {
      ...task,
      algorithm_1: resolveAssigneeDisplayName(pickAlgorithmField(match, 1), employees),
      algorithm_2: resolveAssigneeDisplayName(pickAlgorithmField(match, 2), employees),
      algorithm_3: resolveAssigneeDisplayName(pickAlgorithmField(match, 3), employees),
      ts,
      ats: ts,
      sh,
      hbs: sh,
    };

    if (!shouldPreserveTaskOwner(task)) {
      nextTask.owner = resolveAssigneeDisplayName(match.Owner ?? match.owner ?? task.owner, employees) || task.owner;
    }

    return nextTask;
  });
}
