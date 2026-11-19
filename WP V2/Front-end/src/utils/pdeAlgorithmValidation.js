import { parseToLocalDate, toYmd } from './dateFormat';

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function isInvalidNumber(value) {
  return isBlank(value) || Number.isNaN(Number(value));
}

function isInvalidDate(value) {
  if (isBlank(value)) {
    return true;
  }
  const date = parseToLocalDate(value);
  return !date || Number.isNaN(date.getTime());
}

function isCompletionBeforeDocSupply(docSupply, completion) {
  if (isBlank(docSupply) || isBlank(completion)) {
    return false;
  }
  const start = parseToLocalDate(docSupply);
  const end = parseToLocalDate(completion);
  if (!start || !end) {
    return false;
  }
  return end < start;
}

/**
 * Mirrors v1 PDE handlePos validation before running the algorithm.
 */
export function validatePdeTasksForAlgorithm(tasks) {
  const invalidRows = [];
  const invalidFields = {};

  tasks.forEach((task, index) => {
    if (task.done) {
      return;
    }

    const isPriInvalid = isInvalidNumber(task.pri);
    const isEstInvalid = isInvalidNumber(task.est);
    const isPlanInvalid = isInvalidNumber(task.plan);
    const isDocSupplyInvalid = isInvalidDate(task.doc_supply);
    const isCompletionInvalid = isInvalidDate(task.completion)
      || isCompletionBeforeDocSupply(task.doc_supply, task.completion);
    const otsValue = task.ots ?? task.al;
    const isOtsInvalid = !isBlank(otsValue) && (
      Number.isNaN(Number(otsValue)) || !Number.isInteger(Number(otsValue))
    );

    const isAnyFieldInvalid =
      isPriInvalid ||
      isEstInvalid ||
      isPlanInvalid ||
      isDocSupplyInvalid ||
      isCompletionInvalid ||
      isOtsInvalid;

    const areAllFieldsEmpty =
      isBlank(task.pri) &&
      isBlank(task.est) &&
      isBlank(task.plan) &&
      isBlank(task.doc_supply) &&
      isBlank(task.completion) &&
      isBlank(otsValue);

    if (isAnyFieldInvalid && !areAllFieldsEmpty) {
      invalidRows.push({
        index,
        taskName: task.task_name || `Row ${index + 1}`,
      });
      invalidFields[index] = {
        pri: isPriInvalid,
        est: isEstInvalid,
        plan: isPlanInvalid,
        doc_supply: isDocSupplyInvalid,
        completion: isCompletionInvalid,
        ots: isOtsInvalid,
      };
    }
  });

  return { invalidRows, invalidFields };
}

export function normalizeDocSupplyDates(tasks) {
  return (tasks ?? []).map((task) => {
    const normalized = toYmd(task.doc_supply);
    if (!normalized) {
      return task;
    }

    return {
      ...task,
      doc_supply: normalized,
    };
  });
}
