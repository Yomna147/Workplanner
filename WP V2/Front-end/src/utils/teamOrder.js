import { employeeTeamName } from './employeeNames';

/** True for NRM section teams (NRM1, NRM2, …) — not Administration / Support / Q&A managers. */
export function isNrmSectionTeamName(name) {
  return /nrm\s*\d/i.test(String(name || '').trim());
}

export function isNrmSectionOperative(employee, getTeamName = (entry) => employeeTeamName(entry)) {
  if (!employee) {
    return false;
  }
  return isNrmSectionTeamName(getTeamName(employee));
}

export function teamRank(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    return 99999;
  }

  const lower = trimmed.toLowerCase();
  const nrmMatch = trimmed.match(/nrm\s*(\d+)/i);
  if (nrmMatch) {
    return Number(nrmMatch[1]);
  }

  if (lower.includes('q&a') || lower.includes('qa team')) {
    return 100;
  }

  if (lower.includes('support')) {
    return 110;
  }

  if (
    lower.includes('management')
    || lower.includes('administration')
    || lower.includes('sales and admin')
    || lower === 'rauno'
  ) {
    return 9000;
  }

  if (lower.includes('trainee')) {
    return 9100;
  }

  return 200;
}

export function compareTeamNames(a, b) {
  const rankDiff = teamRank(a) - teamRank(b);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
}

export function sortByTeamName(items, getName = (item) => item?.name ?? item?.team ?? '') {
  return [...items].sort((left, right) => compareTeamNames(getName(left), getName(right)));
}

export function sortEmployeesByTeamThenName(employees, getTeamName = (employee) => employeeTeamName(employee)) {
  return [...employees].sort((left, right) => compareEmployeesLikeOap(left, right, getTeamName));
}

export function compareEmployeesLikeOap(left, right, getTeamName = (employee) => employeeTeamName(employee)) {
  const teamDiff = compareTeamNames(getTeamName(left), getTeamName(right));
  if (teamDiff !== 0) {
    return teamDiff;
  }

  const positionDiff = (left?.position ?? Number.MAX_SAFE_INTEGER) - (right?.position ?? Number.MAX_SAFE_INTEGER);
  if (positionDiff !== 0) {
    return positionDiff;
  }

  const leftName = [left?.first_name, left?.last_name].filter(Boolean).join(' ') || left?.name || '';
  const rightName = [right?.first_name, right?.last_name].filter(Boolean).join(' ') || right?.name || '';

  return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
}

/** Alias for the Operatives Allocation (OAP) table row order. */
export const sortEmployeesLikeOap = sortEmployeesByTeamThenName;

export function orderItemsByEmployeeAllocation(
  items = [],
  teams = [],
  employees = [],
  getEmployeeId = (item) => item?.employeeId ?? item?.employee_id ?? item?.id,
) {
  const orderedIds = buildAllocationOrderedEmployeeIds(teams, employees);
  const rank = new Map(orderedIds.map((id, index) => [String(id), index]));

  return [...items].sort((left, right) => {
    const rankA = rank.get(String(getEmployeeId(left))) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rank.get(String(getEmployeeId(right))) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    return String(getEmployeeId(left)).localeCompare(String(getEmployeeId(right)));
  });
}

export function groupEmployeesByTeamLikeOap(teams = [], employees = []) {
  const groups = sortByTeamName(teams, (team) => team.name).map((team) => ({
    teamId: team.id,
    teamName: team.name,
    members: sortEmployeesByTeamThenName(
      employees.filter((employee) => String(employee.team_id) === String(team.id)),
    ),
  }));

  const unassigned = sortEmployeesByTeamThenName(
    employees.filter((employee) => !employee.team_id),
  );

  if (unassigned.length > 0) {
    groups.push({
      teamId: null,
      teamName: 'No Team',
      members: unassigned,
    });
  }

  return groups;
}

/** Same team → position → name order as the Operatives Allocation (OAP) table. */
export function buildAllocationOrderedEmployeeIds(teams = [], employees = []) {
  const ordered = [];
  const seen = new Set();

  sortByTeamName(teams, (team) => team.name).forEach((team) => {
    sortEmployeesByTeamThenName(
      employees.filter((employee) => String(employee.team_id) === String(team.id)),
    ).forEach((employee) => {
      const id = String(employee.id);
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(employee.id);
      }
    });
  });

  sortEmployeesByTeamThenName(
    employees.filter((employee) => !employee.team_id),
  ).forEach((employee) => {
    const id = String(employee.id);
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(employee.id);
    }
  });

  return ordered;
}
