/** Canonical operative allocation name => known aliases (keep in sync with EmployeeNames::aliasMap). */
import { sortEmployeesByTeamThenName } from './teamOrder';

export const EMPLOYEE_ALIAS_MAP = {
  'Rauno R': ['Rauno'],
  'Todor Tanev': ['Todor T'],
  'Shaimaa Mohamed': ['Shaimaa M'],
  'Nora Keshk': ['Nora'],
  'Gabriel Giurca': ['Gabriel G'],
  'Manu Vijay': ['Manu V'],
  'Khaled Maged': ['Khaled M'],
  'Faouad Diaa': ['Fouad D', 'B-team (KM1)', 'b-team (km1)', 'B-team KM'],
  'Valeriya Dramalieva': ['Valeria D', 'B-team (KM2)', 'b-team (km2)'],
  'Veselina Milanova': ['Veselina M', 'B-team (KM3)', 'b-team (km3)'],
  'Amro Mahmoud': ['Amro H'],
  'Mina Tawfik': ['Mina T', 'B-team (AH1)', 'B-Team (AH1)', 'b-team (ah1)', 'B-team AH'],
  'Rehaf Hamed': ['Rehaf H', 'B-team (AH2)', 'B-Team (AH2)', 'b-team (ah2)'],
  'Nour El Khatib': ['Nour', 'B-team (AH3)', 'B-Team (AH3)', 'b-team (ah3)'],
  'Stanley Prospere': ['Stanley P'],
  'Mayar Nashaat': ['Mayar N'],
  'Maya Wacily': ['Maya'],
  'Amal Nagi': ['Amal'],
  'Nataliia Markitan': ['Nataliia'],
  'Angela L': ['Angela'],
  'Alexander Suvoroff': ['Alexander S'],
  'Abdelrahman Hakiem': ['Abdelrahman Abdelhakiem', 'Abdelrahman A'],
  'Abdelsattar Alfarra': ['Abdelsattar'],
  'Mohamed Khaled': ['Mohamed'],
  'Kostadin Radulov': ['Kostadin'],
  'Mina Tarek': [],
  'Mostafa': [],
  'Habiba A': ['Habiba'],
  'Dalia Shalaan': ['Dalia'],
  'Aycel': [],
  'Emma F': ['Emma'],
};

export function employeeEditName(employee) {
  if (!employee) return '';
  return [employee.first_name, employee.last_name].filter(Boolean).join(' ');
}

export function employeeDisplayName(employee) {
  if (!employee) return '';
  const edited = employeeEditName(employee);
  if (edited) return edited;
  return employee.name || '';
}

export function employeeTeamName(employee) {
  if (!employee) return '';
  if (typeof employee.team === 'string') return employee.team;
  return employee.team?.name || employee.team_name || '';
}

export function employeeNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

export function isBTeamSlotName(name) {
  return /^b[-\s]?team\s*\(/i.test(String(name || '').trim());
}

/** TT shared logins like "B-TEAM", "B-TEAM2 B-TEAM2" (not WP slot labels). */
export function isTtBTeamSharedLabel(name) {
  const raw = String(name || '').trim();
  if (!raw || isBTeamSlotName(raw)) return false;
  const first = raw.split(/\s+/)[0] || '';
  return /^b[-\s]?team\d*$/i.test(first);
}

/**
 * Map TT shared B-TEAM login → WP pool of 3.
 * B-TEAM / B-TEAM3 → KM (KM1–KM3); B-TEAM2 / B-TEAM4 → AH (AH1–AH3).
 */
export function resolveTtBTeamPool(name) {
  if (!isTtBTeamSharedLabel(name)) return null;
  const match = String(name || '').match(/b[-\s]?team\s*(\d*)/i);
  if (!match) return null;
  const number = match[1] ? Number.parseInt(match[1], 10) : 1;
  if (!Number.isFinite(number) || number <= 0) return 'KM';
  return number % 2 === 0 ? 'AH' : 'KM';
}

export function wpBTeamSlotPool(employee) {
  const labels = [
    employeeDisplayName(employee),
    employeeEditName(employee),
    employee?.first_name,
    employee?.name,
  ];
  for (const label of labels) {
    if (/\(KM\d*\)/i.test(String(label || ''))) return 'KM';
    if (/\(AH\d*\)/i.test(String(label || ''))) return 'AH';
  }
  return null;
}

/** WP B-team slot employees: B-team (KM1), B-Team (AH2), etc. */
export function listWpBTeamSlotEmployees(employees = [], pool = null) {
  return (employees || [])
    .filter((employee) => {
      const labels = [
        employeeDisplayName(employee),
        employeeEditName(employee),
        employee?.first_name,
        employee?.name,
      ];
      if (!labels.some((label) => isBTeamSlotName(label))) return false;
      if (!pool) return true;
      return wpBTeamSlotPool(employee) === pool;
    })
    .sort((left, right) => (
      employeeDisplayName(left).localeCompare(employeeDisplayName(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    ));
}

/** Split total hours into `count` parts that sum exactly (1 decimal). */
export function splitHoursEvenly(total, count) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (safeCount <= 0) return [];
  const tenths = Math.round((Number(total) || 0) * 10);
  if (tenths <= 0) return Array.from({ length: safeCount }, () => 0);
  const base = Math.floor(tenths / safeCount);
  let remainder = tenths - base * safeCount;
  const parts = [];
  for (let index = 0; index < safeCount; index += 1) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    parts.push((base + extra) / 10);
  }
  return parts;
}

export function assigneeNameForEmployee(employee) {
  if (!employee) {
    return '';
  }
  return employeeEditName(employee) || employeeDisplayName(employee);
}

/** Prefer the operative row label when reassigning via drag-and-drop. */
export function resolveHistogramAssigneeName(targetEmployee, targetRowName) {
  const rowName = String(targetRowName || '').trim();
  if (rowName && isBTeamSlotName(rowName)) {
    return rowName;
  }

  if (targetEmployee) {
    return assigneeNameForEmployee(targetEmployee);
  }

  return rowName;
}

function nameKeysForEmployee(employee) {
  const canonical = employeeDisplayName(employee);
  const keys = new Set([
    employeeNameKey(canonical),
    employeeNameKey(employee.first_name),
  ]);

  (EMPLOYEE_ALIAS_MAP[canonical] || []).forEach((alias) => {
    keys.add(employeeNameKey(alias));
  });

  return [...keys].filter(Boolean);
}

export function employeeMatchesName(employee, value) {
  if (!employee || !value) return false;
  const needle = employeeNameKey(value);
  return nameKeysForEmployee(employee).includes(needle);
}

/** Whether two assignee labels refer to the same operative (aliases included). */
export function assigneeNamesMatch(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) {
    return false;
  }
  if (employeeNameKey(a) === employeeNameKey(b)) {
    return true;
  }

  for (const [canonical, aliases] of Object.entries(EMPLOYEE_ALIAS_MAP)) {
    const names = [canonical, ...aliases].map((name) => employeeNameKey(name));
    const aMatch = names.includes(employeeNameKey(a));
    const bMatch = names.includes(employeeNameKey(b));
    if (aMatch && bMatch) {
      return true;
    }
  }

  return false;
}

/** Map a stored assignee label to the employee dropdown option value. */
export function resolveEmployeeSelectValue(value, employees = []) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const match = employees.find((employee) => employeeMatchesName(employee, trimmed));
  return match ? employeeDisplayName(match) : trimmed;
}

/** Map normalized assignee name keys to a stable employee index key (id or display name). */
export function buildEmployeeNameKeyMap(employees) {
  const lookup = new Map();

  (employees ?? []).forEach((employee) => {
    const indexKey = String(employee.id ?? employeeDisplayName(employee));
    [
      employeeDisplayName(employee),
      employeeEditName(employee),
      employee.first_name,
      employee.name,
    ].forEach((label) => {
      const nameKey = employeeNameKey(label);
      if (nameKey) {
        lookup.set(nameKey, indexKey);
      }
    });
  });

  (employees ?? []).forEach((employee) => {
    const indexKey = String(employee.id ?? employeeDisplayName(employee));
    const canonical = employeeDisplayName(employee);

    (EMPLOYEE_ALIAS_MAP[canonical] || []).forEach((alias) => {
      const nameKey = employeeNameKey(alias);
      if (!nameKey || lookup.has(nameKey)) {
        return;
      }
      lookup.set(nameKey, indexKey);
    });
  });

  return lookup;
}

export function resolveEmployeeIndexKey(assignee, employees) {
  const name = String(assignee || '').trim();
  if (!name) {
    return 'Unassigned';
  }

  const lookup = buildEmployeeNameKeyMap(employees);
  return lookup.get(employeeNameKey(name)) ?? name;
}

export function findEmployeeForAuthUser(user, employees = []) {
  if (!user || !Array.isArray(employees) || employees.length === 0) {
    return null;
  }

  const labels = [
    user.name,
    [user.first_name, user.last_name].filter(Boolean).join(' '),
    user.first_name,
    user.login_name,
  ].filter(Boolean);

  for (const label of labels) {
    const match = employees.find((employee) => employeeMatchesName(employee, label));
    if (match) {
      return match;
    }
  }

  return null;
}

/** Labels from a Time Tracking user row used to match Work Planner employees. */
export function ttUserMatchLabels(ttUser) {
  if (!ttUser) return [];
  return [
    [ttUser.firstname, ttUser.lastname].filter(Boolean).join(' ').trim(),
    [ttUser.first_name, ttUser.last_name].filter(Boolean).join(' ').trim(),
    ttUser.firstname,
    ttUser.first_name,
    ttUser.lastname,
    ttUser.last_name,
    ttUser.loginname,
    ttUser.login_name,
    ttUser.name,
  ].filter((label) => String(label || '').trim());
}

/** Match one TT user to a Work Planner employee (aliases + first/last/login). */
export function matchTtUserToWpEmployee(ttUser, employees = []) {
  if (!ttUser || !Array.isArray(employees) || employees.length === 0) {
    return null;
  }

  if (typeof ttUser === 'string') {
    if (isTtBTeamSharedLabel(ttUser)) return null;
    return employees.find((employee) => employeeMatchesName(employee, ttUser)) || null;
  }

  for (const label of ttUserMatchLabels(ttUser)) {
    if (isTtBTeamSharedLabel(label)) return null;
  }

  for (const label of ttUserMatchLabels(ttUser)) {
    const match = employees.find((employee) => employeeMatchesName(employee, label));
    if (match) return match;
  }

  return null;
}

/** Map TT user id → matched Work Planner employee. */
export function buildTtUserToWpEmployeeMap(ttUsers = [], employees = []) {
  const map = new Map();
  for (const ttUser of ttUsers || []) {
    if (ttUser?.id == null) continue;
    const wpEmployee = matchTtUserToWpEmployee(ttUser, employees);
    if (wpEmployee) {
      map.set(Number(ttUser.id), wpEmployee);
    }
  }
  return map;
}

/**
 * Resolve WP employee by display name.
 * B-team slot labels (AH1/KM1…) match only the real slot row — never Mina/Rehaf aliases.
 */
export function resolveWpEmployeeForTtName(name, employees = []) {
  if (!name || !Array.isArray(employees) || employees.length === 0) return null;

  if (isBTeamSlotName(name)) {
    const needle = employeeNameKey(name);
    return employees.find((employee) => {
      const labels = [
        employeeDisplayName(employee),
        employeeEditName(employee),
        employee?.first_name,
        employee?.name,
      ];
      return labels.some((label) => employeeNameKey(label) === needle);
    }) || null;
  }

  return employees.find((employee) => employeeMatchesName(employee, name)) || null;
}

/** Resolve WP employee from a TT hours row (cached wpEmployeeId, TT user map, or name). */
export function resolveWpEmployeeForTtEntry(entry, employees = [], ttUserWpMap = null) {
  if (!entry) return null;

  if (entry.wpEmployeeId != null && Array.isArray(employees)) {
    const byId = employees.find((employee) => String(employee.id) === String(entry.wpEmployeeId));
    if (byId) return byId;
  }

  // B-team slot rows must stay on KM1–3 / AH1–3 — never alias onto Mina/Rehaf/etc.
  if (entry.fromTtBTeam || isBTeamSlotName(entry.name)) {
    return resolveWpEmployeeForTtName(entry.name, employees);
  }

  if (entry.userId != null && ttUserWpMap instanceof Map) {
    const fromMap = ttUserWpMap.get(Number(entry.userId));
    if (fromMap) return fromMap;
  }

  if (entry.name) {
    return resolveWpEmployeeForTtName(entry.name, employees);
  }

  return null;
}

export function sortEmployeesByName(employees) {
  return sortEmployeesByTeamThenName(employees);
}
