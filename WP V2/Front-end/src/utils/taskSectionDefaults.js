import { canonicalNrmNumber } from './nrmTasks';

export const TRAINEE_WORK_SECTIONS = new Set(['2.1', '2.5', '3.1']);

export function extractSectionFromTaskName(taskName) {
  if (!taskName || typeof taskName !== 'string') {
    return null;
  }
  const match = taskName.match(/^(\d+\.\d+)/);
  return match ? (canonicalNrmNumber(match[1]) || match[1]) : null;
}

function parseTaskSectionParts(taskName) {
  const raw = String(taskName || '').trim();
  const decimalMatch = raw.match(/^(\d+\.\d+)/);
  if (decimalMatch) {
    const canonical = canonicalNrmNumber(decimalMatch[1]) || decimalMatch[1];
    const [major, minor] = canonical.split('.').map((part) => Number(part));

    return {
      major: Number.isFinite(major) ? major : Number.MAX_SAFE_INTEGER,
      minor: Number.isFinite(minor) ? minor : Number.MAX_SAFE_INTEGER,
      raw,
    };
  }

  const match = raw.match(/^(\d+)(?:\.(\d+))?/);
  if (!match) {
    return {
      major: Number.MAX_SAFE_INTEGER,
      minor: Number.MAX_SAFE_INTEGER,
      raw,
    };
  }

  return {
    major: Number(match[1]),
    minor: match[2] != null ? Number(match[2]) : 0,
    raw,
  };
}

/** NRM section order: 1.1, 2.4, 2.5, 8.6, then alphabetical. */
export function compareTaskNamesBySection(leftName, rightName) {
  const left = parseTaskSectionParts(leftName);
  const right = parseTaskSectionParts(rightName);

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.raw.localeCompare(right.raw, undefined, { sensitivity: 'base' });
}

export function sortTasksBySection(tasks = [], getName = (task) => task?.taskName ?? task?.task_name ?? task) {
  return [...tasks].sort((left, right) => compareTaskNamesBySection(getName(left), getName(right)));
}

export function defaultHrsPerForTaskName(taskName) {
  const section = extractSectionFromTaskName(taskName);
  return section && TRAINEE_WORK_SECTIONS.has(section) ? 100 : 80;
}
