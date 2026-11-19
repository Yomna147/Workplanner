const NRM_NUMBER_ALIASES = {
  '1.0': '1.1',
};

export function canonicalNrmNumber(number) {
  const trimmed = String(number ?? '').trim();
  if (!trimmed) {
    return '';
  }
  return NRM_NUMBER_ALIASES[trimmed] ?? trimmed;
}

export function normalizeTaskNameForNrmMatch(taskName) {
  const raw = String(taskName ?? '').trim();
  if (!raw) {
    return '';
  }

  const match = raw.match(/^(\d+\.\d+)(.*)$/);
  if (!match) {
    return raw;
  }

  return `${canonicalNrmNumber(match[1])}${match[2]}`;
}

export function findMatchingNrm(taskName, nrms) {
  if (!taskName) {
    return null;
  }

  const normalizedTaskName = normalizeTaskNameForNrmMatch(taskName);
  const withoutPrefix = normalizedTaskName.replace(/^\d+\.?\d*\s*[-–—]\s*/i, '').trim().toLowerCase();

  return (nrms ?? []).find((nrm) => {
    const name = (nrm.name || '').toLowerCase();
    const scName = (nrm.sc_name || '').toLowerCase();
    const taskLower = normalizedTaskName.toLowerCase();
    return (
      (name && (taskLower.includes(name) || withoutPrefix.includes(name)))
      || (scName && (taskLower.includes(scName) || withoutPrefix.includes(scName)))
    );
  }) ?? null;
}

export function buildTaskNameOptions(nrms) {
  const seen = new Set();
  const options = [];

  for (const nrm of nrms ?? []) {
    const name = String(nrm.sc_name || nrm.Sc_Name || '').trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    options.push(name);
  }

  return options;
}

export function getRapForTaskName(taskName, nrms) {
  const match = findMatchingNrm(taskName, nrms);
  if (match?.pri == null || match.pri === '') {
    return '';
  }
  return String(match.pri);
}

/** v1 template rows can store section numbers (1.1, 6.5) instead of NRM pri decimals (0.11, 0.65). */
export function shouldNormalizeRapFromNrm(rap) {
  if (rap === null || rap === undefined || rap === '') {
    return true;
  }
  const parsed = parseFloat(String(rap).replace(',', '.'));
  return !Number.isFinite(parsed) || parsed >= 1;
}

export function normalizeTaskRapFromNrm(task, nrms) {
  if (!nrms?.length || !task?.task_name || !shouldNormalizeRapFromNrm(task.rap)) {
    return task;
  }

  const fromNrm = getRapForTaskName(task.task_name, nrms);
  if (!fromNrm) {
    return task;
  }

  return { ...task, rap: fromNrm };
}

export function getTaskNameOptionsForRow(taskNameOptions, tasks, rowIndex, currentValue = '') {
  const normalizedCurrent = String(currentValue || '').trim();
  const usedNames = new Set(
    tasks
      .map((task, index) => (index === rowIndex ? '' : task.task_name))
      .map((name) => String(name || '').trim())
      .filter(Boolean),
  );

  return (taskNameOptions ?? []).filter(
    (name) => name === normalizedCurrent || !usedNames.has(name),
  );
}
