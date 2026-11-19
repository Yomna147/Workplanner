/** Client-side filters for TT project hour summaries (after load). */
import {
  employeeDisplayName,
  isBTeamSlotName,
  resolveWpEmployeeForTtEntry,
  resolveWpEmployeeForTtName,
} from './employeeNames';
import { compareTeamNames, groupEmployeesByTeamLikeOap } from './teamOrder';
import { sortTasksBySection } from './taskSectionDefaults';

export function getSummarySortDate(summary) {
  const end = String(summary?.monthEnd || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(end)) return end;
  const start = String(summary?.monthStart || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  return '';
}

export function sortSummariesByDateNewest(summaries = []) {
  return [...summaries].sort((a, b) => compareSummariesByMode(a, b, 'date'));
}

export const TT_HOURS_SORT_OPTIONS = [
  { id: 'date', label: 'Newest activity' },
  { id: 'hours', label: 'TT hours (high → low)' },
  { id: 'variance', label: 'Variance (high → low)' },
  { id: 'name', label: 'Project name (A → Z)' },
  { id: 'job', label: 'Job number' },
];

function compareSummariesByMode(a, b, mode = 'date') {
  if (mode === 'hours') {
    if (b.totalTtHours !== a.totalTtHours) return b.totalTtHours - a.totalTtHours;
    return compareSummariesByMode(a, b, 'date');
  }

  if (mode === 'variance') {
    const varA = Number(a.variance) || 0;
    const varB = Number(b.variance) || 0;
    if (varB !== varA) return varB - varA;
    return compareSummariesByMode(a, b, 'date');
  }

  if (mode === 'name') {
    const nameA = formatProjectFilterLabel(a.ttProjectName || a.projectName, a.jobNumber);
    const nameB = formatProjectFilterLabel(b.ttProjectName || b.projectName, b.jobNumber);
    const nameDiff = nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    if (nameDiff !== 0) return nameDiff;
    return compareSummariesByMode(a, b, 'date');
  }

  if (mode === 'job') {
    const jobA = String(a.jobNumber || '');
    const jobB = String(b.jobNumber || '');
    const jobDiff = jobA.localeCompare(jobB, undefined, { numeric: true, sensitivity: 'base' });
    if (jobDiff !== 0) return jobDiff;
    return compareSummariesByMode(a, b, 'name');
  }

  const dateA = getSummarySortDate(a);
  const dateB = getSummarySortDate(b);
  if (dateA !== dateB) return dateB.localeCompare(dateA);
  if (b.totalTtHours !== a.totalTtHours) return b.totalTtHours - a.totalTtHours;
  return String(a.ttProjectName || a.projectName).localeCompare(String(b.ttProjectName || b.projectName));
}

export function sortSummariesByMode(summaries = [], mode = 'date') {
  return [...summaries].sort((a, b) => compareSummariesByMode(a, b, mode));
}

export function searchSummaries(summaries = [], query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return summaries;

  return summaries.filter((summary) => {
    const fields = [
      summary.jobNumber,
      summary.ttProjectName,
      summary.projectName,
      summary.wpProjectName,
      formatProjectFilterLabel(summary.ttProjectName || summary.projectName, summary.jobNumber),
    ];
    return fields.some((field) => String(field || '').toLowerCase().includes(needle));
  });
}

export function summariesHaveDistinctPeriods(summaries = []) {
  const keys = new Set(
    summaries.map((row) => `${row.monthStart || ''}|${row.monthEnd || ''}`),
  );
  return keys.size > 1;
}

function formatYmdShort(ymd, { withYear = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const date = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

export function formatSummaryPeriod(start, end) {
  if (!start && !end) return '—';
  if (start === 'All time' || (!end && start)) return String(start);

  const startYmd = String(start).slice(0, 10);
  const endYmd = String(end || '').slice(0, 10);
  const startOk = /^\d{4}-\d{2}-\d{2}$/.test(startYmd);
  const endOk = /^\d{4}-\d{2}-\d{2}$/.test(endYmd);

  if (startOk && endOk && startYmd !== endYmd) {
    const sameYear = startYmd.slice(0, 4) === endYmd.slice(0, 4);
    return `${formatYmdShort(startYmd)} – ${formatYmdShort(endYmd, { withYear: !sameYear })}`;
  }
  if (startOk) return formatYmdShort(startYmd, { withYear: true });
  if (endOk) return formatYmdShort(endYmd, { withYear: true });
  if (start && end && start !== end) return `${start} → ${end}`;
  return start || end || '—';
}

export function wpNamesDiffer(summary) {
  const ttLabel = formatProjectFilterLabel(
    summary?.ttProjectName || summary?.projectName,
    summary?.jobNumber,
  );
  const wpName = String(summary?.wpProjectName || '').trim();
  if (!wpName) return false;
  return wpName.toLowerCase() !== ttLabel.toLowerCase()
    && !wpName.toLowerCase().includes(String(summary?.jobNumber || '').toLowerCase());
}

function summaryOverlapsMonth(summary, monthValue) {
  if (!monthValue) return true;

  const start = String(summary.monthStart || '').slice(0, 10);
  const end = String(summary.monthEnd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return true;
  }

  const [year, month] = monthValue.split('-').map(Number);
  const rangeStart = `${monthValue}-01`;
  const nextMonth = new Date(year, month, 1);
  const rangeEnd = nextMonth.toISOString().slice(0, 10);

  return start < rangeEnd && end >= rangeStart;
}

export function applyTtHoursDisplayFilters(
  summaries,
  {
    projectId = '',
    employeeId = '',
    teamId = '',
    month = '',
    search = '',
    sort = 'date',
    matchedOnly = true,
    employees = [],
    teams = [],
  } = {},
) {
  let rows = summaries || [];

  if (matchedOnly) {
    rows = rows.filter((row) => row.wpMatchStatus === 'matched');
  }

  if (month) {
    rows = rows.filter((row) => summaryOverlapsMonth(row, month));
  }

  if (projectId) {
    rows = rows.filter((row) => String(row.projectId) === String(projectId));
  }

  if (teamId) {
    rows = rows
      .map((summary) => narrowSummaryToTeam(summary, teamId, employees, teams))
      .filter(Boolean);
  }

  if (employeeId) {
    rows = rows
      .map((summary) => {
        const employee = summary.employeeRows?.find((row) => {
          if (row.wpEmployeeId != null && String(row.wpEmployeeId) === String(employeeId)) {
            return true;
          }
          if (row.wpEmployeeId != null && String(employeeId) === `wp:${row.wpEmployeeId}`) {
            return true;
          }
          if (row.userId != null && String(row.userId) === String(employeeId)) {
            return true;
          }
          return false;
        });
        if (!employee || Number(employee.hours) <= 0) {
          return null;
        }
        const hours = Number(employee.hours) || 0;
        return {
          ...summary,
          totalTtHours: hours,
          totalPlanHours: null,
          variance: null,
          employeeFilterActive: true,
          filteredEmployeeName: employee.name,
          employeeRows: [employee],
          employeeCount: 1,
          taskRows: narrowTaskRowsToEmployees(summary.taskRows, [employee]),
        };
      })
      .filter(Boolean);
  }

  rows = searchSummaries(rows, search);

  return sortSummariesByMode(rows, sort);
}

function resolveEmployeeRowTeamId(row, employees = []) {
  if (row?.team_id != null) return String(row.team_id);

  // B-team slot shares: resolve by slot id/name only (never Mina/Rehaf aliases).
  if (row?.fromTtBTeam || isBTeamSlotName(row?.name || row?.label)) {
    const slot = row.wpEmployeeId != null
      ? employees.find((employee) => String(employee.id) === String(row.wpEmployeeId))
      : resolveWpEmployeeForTtName(row?.name || row?.label, employees);
    return slot?.team_id != null ? String(slot.team_id) : null;
  }

  const wpEmployee = resolveWpEmployeeForTtEntry(row, employees)
    || resolveWpEmployeeForTtName(row?.name || row?.label, employees);
  return wpEmployee?.team_id != null ? String(wpEmployee.team_id) : null;
}

function narrowTaskRowsToEmployees(taskRows = [], allowedEmployees = []) {
  if (!allowedEmployees.length) return [];

  const allowedIds = new Set(
    allowedEmployees
      .map((person) => (person.userId != null ? String(person.userId) : null))
      .filter(Boolean),
  );
  const allowedWpIds = new Set(
    allowedEmployees
      .map((person) => (person.wpEmployeeId != null ? String(person.wpEmployeeId) : null))
      .filter(Boolean),
  );
  const allowedNames = new Set(
    allowedEmployees
      .map((person) => String(person.name || '').trim().toLowerCase())
      .filter(Boolean),
  );

  return (taskRows || [])
    .map((task) => {
      const people = (task.employeeHours || []).filter((person) => (
        (person.userId != null && allowedIds.has(String(person.userId)))
        || (person.wpEmployeeId != null && allowedWpIds.has(String(person.wpEmployeeId)))
        || (person.name && allowedNames.has(String(person.name).trim().toLowerCase()))
      ));
      if (!people.length) return null;
      const hours = people.reduce((sum, person) => sum + (Number(person.hours) || 0), 0);
      const ttHours = Math.round(hours * 10) / 10;
      return {
        ...task,
        ttHours,
        planHours: people.length === (task.employeeHours || []).length ? task.planHours : null,
        variance: people.length === (task.employeeHours || []).length
          ? task.variance
          : null,
        employeeHours: people,
      };
    })
    .filter(Boolean);
}

function narrowSummaryToTeam(summary, teamId, employees = [], teams = []) {
  const targetTeamId = String(teamId);
  const teamEmployees = (summary.employeeRows || []).filter((row) => (
    resolveEmployeeRowTeamId(row, employees) === targetTeamId
    && Number(row.hours) > 0
  ));
  if (!teamEmployees.length) return null;

  const hours = teamEmployees.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  const rounded = Math.round(hours * 10) / 10;
  const teamName = teams.find((team) => String(team.id) === targetTeamId)?.name
    || teamEmployees.find((row) => row.teamName)?.teamName
    || employees.find((employee) => String(employee.team_id) === targetTeamId)?.team?.name
    || null;

  return {
    ...summary,
    totalTtHours: rounded,
    totalPlanHours: null,
    variance: null,
    teamFilterActive: true,
    filteredTeamId: targetTeamId,
    filteredTeamName: teamName,
    employeeRows: teamEmployees,
    employeeCount: teamEmployees.length,
    taskRows: narrowTaskRowsToEmployees(summary.taskRows, teamEmployees),
  };
}

export function buildTtTeamFilterOptions(summaries = [], teams = [], employees = []) {
  const hoursByTeam = new Map();

  for (const summary of summaries || []) {
    if (summary.wpMatchStatus !== 'matched') continue;
    for (const row of summary.employeeRows || []) {
      if (Number(row.hours) <= 0) continue;
      const teamKey = resolveEmployeeRowTeamId(row, employees);
      if (!teamKey) continue;
      hoursByTeam.set(teamKey, (hoursByTeam.get(teamKey) || 0) + (Number(row.hours) || 0));
    }
  }

  if (!hoursByTeam.size) return [];

  const teamById = new Map((teams || []).map((team) => [String(team.id), team]));

  return [...hoursByTeam.entries()]
    .map(([id, hours]) => {
      const team = teamById.get(String(id));
      return {
        id: String(id),
        label: team?.name || `Team #${id}`,
        hours: Math.round(hours * 10) / 10,
      };
    })
    .sort((left, right) => compareTeamNames(left.label, right.label));
}

export function formatProjectFilterLabel(name, jobNumber) {
  const raw = String(name || '').trim();
  if (!raw) return 'Unnamed project';
  if (!jobNumber) return raw;

  const escaped = String(jobNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutDup = raw
    .replace(new RegExp(`^${escaped}\\s*[-—–:]\\s*`, 'i'), '')
    .replace(new RegExp(`^${escaped}\\s+`, 'i'), '')
    .trim();

  return withoutDup || raw;
}

export function buildTtProjectFilterOptions(summaries = []) {
  const seen = new Set();

  return sortSummariesByDateNewest(
    summaries.filter((row) => row.projectId != null && row.wpMatchStatus === 'matched'),
  )
    .map((row) => {
      const id = String(row.projectId);
      if (seen.has(id)) return null;
      seen.add(id);

      const label = row.ttProjectName || row.projectName || `Project #${row.projectId}`;
      const jobNumber = row.jobNumber || '';
      const displayLabel = formatProjectFilterLabel(label, jobNumber);
      return {
        id,
        label,
        displayLabel,
        jobNumber,
        color: row.color || '#e2e8f0',
        sortDate: getSummarySortDate(row),
      };
    })
    .filter(Boolean);
}

function enrichTtEmployeesForGrouping(ttEmployees, employees = []) {
  return ttEmployees.map((row) => {
    const isBTeamSlot = Boolean(row.fromTtBTeam) || isBTeamSlotName(row.label || row.name);
    const wpEmployee = isBTeamSlot
      ? (row.wpEmployeeId != null
        ? employees.find((employee) => String(employee.id) === String(row.wpEmployeeId))
        : null)
      : (resolveWpEmployeeForTtEntry(row, employees)
        || resolveWpEmployeeForTtName(row.label || row.name, employees));
    const displayName = isBTeamSlot
      ? (row.label || row.name || employeeDisplayName(wpEmployee) || `User #${row.userId ?? row.id}`)
      : (wpEmployee
        ? employeeDisplayName(wpEmployee)
        : (row.label || row.name || `User #${row.userId ?? row.id}`));
    return {
      id: String(row.wpEmployeeId ?? row.userId ?? row.id),
      userId: row.userId ?? row.id,
      name: displayName,
      label: displayName,
      hours: Number(row.hours) || 0,
      first_name: wpEmployee?.first_name,
      last_name: wpEmployee?.last_name,
      position: wpEmployee?.position,
      team_id: row.team_id ?? wpEmployee?.team_id ?? null,
      team: wpEmployee?.team || (row.teamName ? { name: row.teamName } : undefined),
      wpEmployeeId: row.wpEmployeeId ?? wpEmployee?.id ?? null,
      wpMatched: Boolean(row.wpMatched || wpEmployee || isBTeamSlot),
      fromTtBTeam: Boolean(row.fromTtBTeam),
    };
  });
}

export function collectTtEmployeesFromSummaries(summaries = []) {
  const byId = new Map();

  for (const summary of summaries) {
    if (summary.wpMatchStatus !== 'matched') continue;
    for (const employee of summary.employeeRows || []) {
      if (Number(employee.hours) <= 0) continue;
      if (employee.userId == null && employee.wpEmployeeId == null) continue;
      const id = employee.wpEmployeeId != null
        ? `wp:${employee.wpEmployeeId}`
        : String(employee.userId);
      const existing = byId.get(id);
      if (!existing || Number(employee.hours) > Number(existing.hours)) {
        byId.set(id, {
          id,
          userId: employee.userId,
          wpEmployeeId: employee.wpEmployeeId ?? null,
          fromTtBTeam: Boolean(employee.fromTtBTeam),
          team_id: employee.team_id ?? null,
          teamName: employee.teamName ?? null,
          label: employee.name || `User #${employee.userId ?? employee.wpEmployeeId}`,
          hours: Number(employee.hours) || 0,
        });
      }
    }
  }

  return [...byId.values()];
}

export function buildTtEmployeeFilterGroups(summaries = [], teams = [], employees = []) {
  const ttEmployees = collectTtEmployeesFromSummaries(summaries);
  if (!ttEmployees.length) return [];

  const grouped = groupEmployeesByTeamLikeOap(
    teams,
    enrichTtEmployeesForGrouping(ttEmployees, employees),
  );

  return grouped
    .map((group) => ({
      teamId: group.teamId,
      teamName: group.teamName,
      members: group.members.map((member) => ({
        id: String(member.wpEmployeeId ?? member.userId ?? member.id),
        label: member.label || member.name,
        hours: member.hours,
      })),
    }))
    .filter((group) => group.members.length > 0);
}

export function groupTtEmployeeRowsByTeam(employeeRows = [], teams = [], employees = []) {
  const ttEmployees = (employeeRows || []).filter(
    (row) => row?.userId && Number(row.hours) > 0,
  );
  if (!ttEmployees.length) return [];

  const grouped = groupEmployeesByTeamLikeOap(
    teams,
    enrichTtEmployeesForGrouping(
      ttEmployees.map((row) => ({
        userId: row.userId,
        label: row.name,
        hours: row.hours,
      })),
      employees,
    ),
  );

  return grouped
    .map((group) => ({
      teamId: group.teamId,
      teamName: group.teamName,
      members: group.members.map((member) => ({
        userId: member.userId ?? member.id,
        name: member.name || member.label,
        hours: member.hours,
      })),
    }))
    .filter((group) => group.members.length > 0);
}

export function groupTtTaskRowsByTeam(taskRows = [], teams = [], employees = []) {
  if (!Array.isArray(taskRows) || taskRows.length === 0) {
    return [];
  }

  const buckets = new Map();

  const ensureBucket = (teamId, teamName) => {
    const key = teamId == null ? 'none' : String(teamId);
    if (!buckets.has(key)) {
      buckets.set(key, {
        teamId,
        teamName: teamName || 'No Team',
        hours: 0,
        rows: [],
      });
    }
    return buckets.get(key);
  };

  taskRows.forEach((task) => {
    const splits = Array.isArray(task.employeeHours) && task.employeeHours.length > 0
      ? task.employeeHours
      : [{ name: '', hours: Number(task.ttHours) || 0 }];

    const hoursByTeam = new Map();
    splits.forEach((entry) => {
      const hours = Number(entry.hours) || 0;
      if (hours <= 0) return;
      const isBTeamSlot = Boolean(entry.fromTtBTeam) || isBTeamSlotName(entry.name);
      const wpEmployee = isBTeamSlot
        ? (entry.wpEmployeeId != null
          ? employees.find((employee) => String(employee.id) === String(entry.wpEmployeeId))
          : null)
        : (resolveWpEmployeeForTtEntry(entry, employees)
          || resolveWpEmployeeForTtName(entry.name, employees));
      const teamId = entry.team_id ?? wpEmployee?.team_id ?? null;
      const teamName = entry.teamName
        || (wpEmployee
          ? (teams.find((team) => String(team.id) === String(teamId))?.name
            || wpEmployee.team?.name
            || 'No Team')
          : (teamId != null
            ? (teams.find((team) => String(team.id) === String(teamId))?.name || 'No Team')
            : 'Unmatched TT'));
      const key = teamId == null ? (wpEmployee || isBTeamSlot ? 'none' : 'unmatched') : String(teamId);
      const current = hoursByTeam.get(key) || {
        teamId,
        teamName,
        hours: 0,
        employees: [],
      };
      current.hours += hours;
      if (entry.userId || entry.name || entry.wpEmployeeId) {
        const existing = current.employees.find((person) => {
          // Prefer WP slot identity — shared TT B-TEAM userIds must not merge AH1/AH2/AH3.
          if (person.wpEmployeeId != null || entry.wpEmployeeId != null) {
            return person.wpEmployeeId != null
              && entry.wpEmployeeId != null
              && String(person.wpEmployeeId) === String(entry.wpEmployeeId);
          }
          if (person.userId != null && entry.userId != null) {
            return String(person.userId) === String(entry.userId);
          }
          return Boolean(person.name && entry.name && person.name === entry.name);
        });
        const displayName = isBTeamSlot
          ? (entry.name || employeeDisplayName(wpEmployee) || `User #${entry.userId}`)
          : (wpEmployee
            ? employeeDisplayName(wpEmployee)
            : (entry.name || `User #${entry.userId}`));
        if (existing) {
          existing.hours += hours;
        } else {
          current.employees.push({
            userId: entry.userId,
            wpEmployeeId: entry.wpEmployeeId ?? wpEmployee?.id ?? null,
            wpMatched: Boolean(entry.wpMatched || wpEmployee || isBTeamSlot),
            fromTtBTeam: Boolean(entry.fromTtBTeam),
            name: displayName,
            hours,
          });
        }
      }
      hoursByTeam.set(key, current);
    });

    if (hoursByTeam.size === 0) {
      const bucket = ensureBucket(null, 'No Team');
      bucket.rows.push(task);
      bucket.hours += Number(task.ttHours) || 0;
      return;
    }

    const splitAcrossTeams = hoursByTeam.size > 1;
    hoursByTeam.forEach((split) => {
      const bucket = ensureBucket(split.teamId, split.teamName);
      bucket.hours += split.hours;
      const ttHours = Math.round(split.hours * 10) / 10;
      bucket.rows.push({
        ...task,
        ttHours,
        planHours: splitAcrossTeams ? null : task.planHours,
        variance: splitAcrossTeams
          ? null
          : Math.round((ttHours - (Number(task.planHours) || 0)) * 10) / 10,
        teamHours: ttHours,
        employeeHours: (split.employees || [])
          .map((person) => ({ ...person, hours: Math.round(person.hours * 10) / 10 }))
          .sort((left, right) => right.hours - left.hours),
      });
    });
  });

  return [...buckets.values()]
    .filter((group) => group.rows.length > 0)
    .sort((left, right) => compareTeamNames(left.teamName, right.teamName))
    .map((group) => {
      const employeesByKey = new Map();

      group.rows.forEach((row) => {
        const people = Array.isArray(row.employeeHours) && row.employeeHours.length > 0
          ? row.employeeHours
          : [{ userId: null, name: '', hours: Number(row.ttHours) || 0 }];

        people.forEach((person) => {
          const hours = Number(person.hours) || 0;
          if (hours <= 0) return;

          const hasIdentity = person.userId != null
            || person.wpEmployeeId != null
            || (person.name && String(person.name).trim());
          const key = person.wpEmployeeId != null
            ? `wp:${person.wpEmployeeId}`
            : person.userId != null
              ? `id:${person.userId}`
              : hasIdentity
                ? `name:${String(person.name).toLowerCase()}`
                : 'unassigned';
          const existing = employeesByKey.get(key) || {
            userId: person.userId ?? null,
            wpEmployeeId: person.wpEmployeeId ?? null,
            wpMatched: Boolean(person.wpMatched),
            name: hasIdentity ? (person.name || `User #${person.userId}`) : 'Unassigned',
            hours: 0,
            tasks: [],
          };

          existing.hours += hours;
          if (person.wpMatched) existing.wpMatched = true;
          if (person.wpEmployeeId != null) existing.wpEmployeeId = person.wpEmployeeId;
          if (person.name && (!existing.name || existing.name.startsWith('User #'))) {
            existing.name = person.name;
          }
          existing.tasks.push({
            taskName: row.taskName,
            ttHours: Math.round(hours * 10) / 10,
            planHours: people.length === 1 ? row.planHours : null,
            variance: people.length === 1
              ? Math.round((hours - (Number(row.planHours) || 0)) * 10) / 10
              : null,
            matched: row.matched,
          });
          employeesByKey.set(key, existing);
        });
      });

      const employees = [...employeesByKey.values()]
        .map((person) => ({
          ...person,
          hours: Math.round(person.hours * 10) / 10,
          tasks: sortTasksBySection(person.tasks, (task) => task.taskName),
        }))
        .sort((left, right) => (
          right.hours - left.hours
          || String(left.name || '').localeCompare(String(right.name || ''))
        ));

      return {
        teamId: group.teamId,
        teamName: group.teamName,
        hours: Math.round(group.hours * 10) / 10,
        employees,
        rows: sortTasksBySection(group.rows, (row) => row.taskName),
      };
    });
}

export function buildTtTeamHourReport(summaries = [], teams = [], employees = []) {
  const byUser = new Map();
  summaries.forEach((summary) => {
    (summary.employeeRows || []).forEach((row) => {
      if (!row?.userId || Number(row.hours) <= 0) return;
      const id = String(row.userId);
      const existing = byUser.get(id);
      if (existing) {
        existing.hours += Number(row.hours) || 0;
      } else {
        byUser.set(id, { ...row, hours: Number(row.hours) || 0 });
      }
    });
  });

  return groupTtEmployeeRowsByTeam([...byUser.values()], teams, employees).map((group) => ({
    teamId: group.teamId,
    teamName: group.teamName,
    hours: Math.round(group.members.reduce((sum, member) => sum + (Number(member.hours) || 0), 0) * 10) / 10,
    members: group.members.length,
  }));
}

/** @deprecated Use buildTtEmployeeFilterGroups for team-grouped options. */
export function buildTtEmployeeFilterOptions(summaries = []) {
  return collectTtEmployeesFromSummaries(summaries)
    .sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label))
    .map(({ id, label }) => ({ id, label }));
}

export function buildTtMonthFilterOptions(summaries = []) {
  const months = new Set();

  for (const summary of summaries) {
    if (summary.wpMatchStatus !== 'matched') continue;
    const start = String(summary.monthStart || '').slice(0, 7);
    const end = String(summary.monthEnd || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(start)) months.add(start);
    if (/^\d{4}-\d{2}$/.test(end)) months.add(end);
  }

  return [...months]
    .sort((a, b) => b.localeCompare(a))
    .map((value) => {
      const [year, month] = value.split('-');
      const date = new Date(Number(year), Number(month) - 1, 1);
      const label = date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      return { id: value, label };
    });
}
