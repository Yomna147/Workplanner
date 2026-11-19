import {
  aggregateHoursByEmployee,
  aggregateHoursByTask,
  aggregateHoursByTaskAndEmployee,
  compareTtProjectsToWp,
  deriveDateRangeFromReports,
  extractTtJobNumber,
  extractWpJobNumber,
  filterReportsByOapUsers,
  filterReportsByTtProjectName,
  getGlobalDateRangeFromProjects,
  getCurrentMonthStartYmd,
  getLastAndCurrentMonthRange,
  jobNumbersMatch,
  loadAllTtReports,
  loadTtProjectsWithComparison,
  ttForEachReportSlice,
  ttSearchAllReports,
} from "./timeTracking";
import { formatTodayDisplay } from "./dateFormat";
import { canonicalNrmNumber } from "./nrmTasks";
import { sortTasksBySection } from "./taskSectionDefaults";

export { compareTtProjectsToWp };
export {
  buildOapAllowedTtUserIds,
  employeeQualifiesForOapNrmFilter,
} from "./timeTracking";
import {
  OVER_PLAN_WARN_PCT,
  TT_DERIVE_THRESHOLD,
} from "../config/progressRules";
import {
  buildTtUserToWpEmployeeMap,
  employeeDisplayName,
  employeeTeamName,
  isTtBTeamSharedLabel,
  listWpBTeamSlotEmployees,
  resolveTtBTeamPool,
  splitHoursEvenly,
} from "./employeeNames";

/** @deprecated Use extractWpJobNumber — kept for existing imports */
export function extractLeadingProjectNumber(name) {
  return extractWpJobNumber(name);
}

export function reportDateInRange(isoDate, startStr, endStr) {
  if (!startStr || !endStr) return true;
  if (!isoDate) return false;
  const d = String(isoDate).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return d >= startStr && d <= endStr;
}

export { getGlobalDateRangeFromProjects };

/** IndividualSearch — all reports, no date filter (optional userId / projectId). */
export async function fetchAllTtReports(token, options = {}) {
  return loadAllTtReports({
    token,
    userId: options.userId ?? null,
    projectId: options.projectId ?? null,
  });
}

/** @deprecated Use fetchAllTtReports — dates ignored when fetching all data. */
export async function fetchTtReportsDateRangeAllUsers(token, _startDate, _endDate, options = {}) {
  return fetchAllTtReports(token, options);
}

/** Sum TT hours per action/task name (lower-case key). */
export function aggregateTtHoursByTaskName(reportsForProject, oapAllowedTtUserIds) {
  return aggregateHoursByTask(filterReportsByOapUsers(reportsForProject, oapAllowedTtUserIds));
}

function taskNamePrefix(s) {
  const m = String(s || "").trim().match(/^[\d.]+/);
  if (!m) return "";
  return canonicalNrmNumber(m[0]) || m[0];
}

/**
 * Major section id at start of task name: "4.0 - …" / "4.1 - …" / "1.0 …" → "4", "4", "1".
 * Used so TT 4.0 matches WP 4.1 (same section family).
 */
function taskNameMajorSectionKey(s) {
  const m = String(s || "").trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

/** TT task names that look like NRM bill sections (e.g. 1.0, 4.1 - Description). */
function isNrmSectionTaskName(taskName) {
  return /^\d+(?:\.\d+)?(?:\s|$|[-–:])/.test(String(taskName || "").trim());
}

/**
 * Specific WP↔TT task key matches only (exact / contains / NRM prefix).
 * Does NOT use major-section fan-out — that double-counts when WP has 8.1…8.8.
 */
export function matchWpTaskToTtKeysSpecific(wpTaskName, ttMap) {
  const n = String(wpTaskName || "").trim().toLowerCase();
  if (!n || !ttMap || ttMap.size === 0) return [];
  if (ttMap.has(n)) return [n];
  for (const k of ttMap.keys()) {
    if (k === n) return [k];
  }
  for (const k of ttMap.keys()) {
    if (k.includes(n) || n.includes(k)) return [k];
  }
  const wpPref = taskNamePrefix(wpTaskName);
  if (wpPref) {
    for (const k of ttMap.keys()) {
      if (taskNamePrefix(k) === wpPref) return [k];
    }
  }
  return [];
}

/** Major-section TT keys (e.g. all "8.x") — use only for leftover unclaimed TT hours. */
export function matchWpTaskToTtKeysMajor(wpTaskName, ttMap) {
  const wpMajor = taskNameMajorSectionKey(wpTaskName);
  if (wpMajor == null || !ttMap || ttMap.size === 0) return [];
  const keys = [];
  for (const k of ttMap.keys()) {
    if (taskNameMajorSectionKey(k) === wpMajor) keys.push(k);
  }
  return keys;
}

/** Map WP TaskName → matching TT action key(s) (same rules as hour matching). */
export function matchWpTaskToTtKeys(wpTaskName, ttMap) {
  const specific = matchWpTaskToTtKeysSpecific(wpTaskName, ttMap);
  if (specific.length) return specific;
  return matchWpTaskToTtKeysMajor(wpTaskName, ttMap);
}

/** Map WP TaskName → total TT hours for that action (fuzzy match). */
export function matchWpTaskToTtHours(wpTaskName, ttMap) {
  const keys = matchWpTaskToTtKeys(wpTaskName, ttMap);
  if (!keys.length) return null;
  let sum = 0;
  for (const key of keys) {
    sum += Number(ttMap.get(key)) || 0;
  }
  return sum;
}

function mergeEmployeeHoursForTtKeys(keys, taskUserHours) {
  if (!taskUserHours || !keys?.length) return [];

  const byUser = new Map();
  for (const key of keys) {
    const users = taskUserHours.get(key);
    if (!users) continue;
    for (const row of users.values()) {
      const uid = row.userId;
      if (uid == null) continue;
      const prev = byUser.get(uid);
      if (prev) {
        prev.hours += Number(row.hours) || 0;
      } else {
        byUser.set(uid, { ...row, hours: Number(row.hours) || 0 });
      }
    }
  }

  return Array.from(byUser.values())
    .map((row) => ({ ...row, hours: roundHours1(row.hours) }))
    .filter((row) => row.hours > 0)
    .sort((a, b) => b.hours - a.hours);
}

function mergeTaskEmployeeHours(wpTaskName, ttMap, taskUserHours) {
  if (!taskUserHours) return [];
  return mergeEmployeeHoursForTtKeys(matchWpTaskToTtKeys(wpTaskName, ttMap), taskUserHours);
}

function sumTtHoursForKeys(ttMap, keys) {
  let sum = 0;
  for (const key of keys || []) {
    sum += Number(ttMap.get(key)) || 0;
  }
  return sum;
}

function scoreTtKeyToWpTask(ttKey, wpTaskName) {
  const tt = String(ttKey || "").trim().toLowerCase();
  const wp = String(wpTaskName || "").trim().toLowerCase();
  if (!tt || !wp) return 0;
  if (tt === wp) return 100;
  if (tt.includes(wp) || wp.includes(tt)) return 80;
  const ttPref = taskNamePrefix(ttKey);
  const wpPref = taskNamePrefix(wpTaskName);
  if (ttPref && wpPref && ttPref === wpPref) return 60;
  const ttMajor = taskNameMajorSectionKey(ttKey);
  const wpMajor = taskNameMajorSectionKey(wpTaskName);
  if (ttMajor != null && ttMajor === wpMajor) return 20;
  return 0;
}

/**
 * Build WP task rows with TT hours. Each TT action key is claimed at most once so
 * major-section fallback cannot stamp the same hours onto every 8.1…8.8 row.
 */
export function buildMatchedTaskRows(wpSubs, ttMap, taskUserHours = null, enrichEmployee = null) {
  const taskSeen = new Set();
  const uniqueSubs = [];
  for (const sub of wpSubs || []) {
    const key = String(sub.TaskName || "").trim().toLowerCase();
    if (!key || taskSeen.has(key)) continue;
    taskSeen.add(key);
    uniqueSubs.push(sub);
  }

  const claimedKeys = new Set();
  const keysByWpName = new Map();

  for (const sub of uniqueSubs) {
    const keys = matchWpTaskToTtKeysSpecific(sub.TaskName, ttMap)
      .filter((key) => !claimedKeys.has(key));
    keys.forEach((key) => claimedKeys.add(key));
    if (keys.length) keysByWpName.set(sub.TaskName, keys);
  }

  for (const [ttKey, hours] of ttMap.entries()) {
    if (claimedKeys.has(ttKey)) continue;
    if ((Number(hours) || 0) <= 0) continue;

    let bestSub = null;
    let bestScore = 0;
    for (const sub of uniqueSubs) {
      const score = scoreTtKeyToWpTask(ttKey, sub.TaskName);
      if (score > bestScore) {
        bestScore = score;
        bestSub = sub;
      }
    }
    if (!bestSub || bestScore < 20) continue;

    claimedKeys.add(ttKey);
    const existing = keysByWpName.get(bestSub.TaskName) || [];
    existing.push(ttKey);
    keysByWpName.set(bestSub.TaskName, existing);
  }

  const taskRows = [];
  for (const sub of uniqueSubs) {
    const keys = keysByWpName.get(sub.TaskName) || [];
    if (!keys.length) continue;
    const ttH = sumTtHoursForKeys(ttMap, keys);
    if (ttH <= 0) continue;
    const plan = sumPlanAcrossParts(sub.TaskName, wpSubs);
    let employees = mergeEmployeeHoursForTtKeys(keys, taskUserHours);
    if (typeof enrichEmployee === "function") {
      employees = employees.map((row) => enrichEmployee(row));
    }
    taskRows.push({
      taskName: sub.TaskName,
      ttHours: roundHours1(ttH),
      planHours: roundHours1(plan),
      variance: roundHours1(ttH - plan),
      employeeHours: employees,
    });
  }
  return sortTasksBySection(taskRows, (row) => row.taskName);
}

/** WP Plan hours for a Time Tracking action name (match to sub TaskName). */
export function findWpPlanForTtAction(ttActionName, wpSubs) {
  if (!ttActionName || !wpSubs?.length) return null;
  const n = String(ttActionName).trim().toLowerCase();
  for (const sub of wpSubs) {
    const w = String(sub.TaskName || "").trim().toLowerCase();
    if (w === n) {
      const p = parseFloat(sub.Plan);
      return Number.isFinite(p) ? p : null;
    }
  }
  for (const sub of wpSubs) {
    const w = String(sub.TaskName || "").trim().toLowerCase();
    if (w.includes(n) || n.includes(w)) {
      const p = parseFloat(sub.Plan);
      return Number.isFinite(p) ? p : null;
    }
  }
  const ttPref = taskNamePrefix(ttActionName);
  if (ttPref) {
    for (const sub of wpSubs) {
      if (taskNamePrefix(sub.TaskName) === ttPref) {
        const p = parseFloat(sub.Plan);
        return Number.isFinite(p) ? p : null;
      }
    }
  }
  const ttMajor = taskNameMajorSectionKey(ttActionName);
  if (ttMajor != null) {
    for (const sub of wpSubs) {
      if (taskNameMajorSectionKey(sub.TaskName) === ttMajor) {
        const p = parseFloat(sub.Plan);
        if (Number.isFinite(p)) return p;
      }
    }
  }
  return null;
}

/** First WP sub that matches a TT action name (same order as findWpPlanForTtAction). */
function findWpSubForTtAction(ttActionName, wpSubs) {
  if (!ttActionName || !wpSubs?.length) return null;
  const n = String(ttActionName).trim().toLowerCase();
  for (const sub of wpSubs) {
    const w = String(sub.TaskName || "").trim().toLowerCase();
    if (w === n) return sub;
  }
  for (const sub of wpSubs) {
    const w = String(sub.TaskName || "").trim().toLowerCase();
    if (w.includes(n) || n.includes(w)) return sub;
  }
  const ttPref = taskNamePrefix(ttActionName);
  if (ttPref) {
    for (const sub of wpSubs) {
      if (taskNamePrefix(sub.TaskName) === ttPref) return sub;
    }
  }
  const ttMajor = taskNameMajorSectionKey(ttActionName);
  if (ttMajor != null) {
    for (const sub of wpSubs) {
      if (taskNameMajorSectionKey(sub.TaskName) === ttMajor) return sub;
    }
  }
  return null;
}

export function flattenWpSubs(project) {
  const subs = [];
  for (const part of project?.parts || []) {
    for (const sub of part.subs || []) {
      subs.push(sub);
    }
  }
  return subs;
}

/** Sum Plan hours for a task name across all parts (no split). */
export function sumPlanAcrossParts(taskName, wpSubs) {
  const key = String(taskName || "").trim().toLowerCase();
  if (!key || !wpSubs?.length) return 0;
  let sum = 0;
  for (const sub of wpSubs) {
    if (String(sub.TaskName || "").trim().toLowerCase() !== key) continue;
    const p = parseFloat(sub.Plan || 0);
    if (Number.isFinite(p)) sum += p;
  }
  return sum;
}

/** TT actions with hours but no matching WP task (excludes NRM section entries). */
export function collectTtAdminHourTasks(ttMap, wpSubs) {
  const admin = [];
  for (const [ttKey, hours] of ttMap.entries()) {
    if (!hours || hours <= 0) continue;
    if (isNrmSectionTaskName(ttKey)) continue;
    if (!findWpSubForTtAction(ttKey, wpSubs)) {
      admin.push({ taskName: ttKey, hours: roundHours1(hours) });
    }
  }
  return admin;
}

/** Tasks where actual TT hours exceed combined plan by OVER_PLAN_WARN_PCT. */
export function analyzeOverPlanTasks(subs, ttMap, fullProject) {
  const allSubs = fullProject ? flattenWpSubs(fullProject) : subs;
  const results = [];
  const seen = new Set();
  for (const t of subs || []) {
    if (t.Done === 1 || t.Done === true) continue;
    const key = String(t.TaskName || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    const ttH = matchWpTaskToTtHours(t.TaskName, ttMap);
    if (ttH == null) continue;
    const combinedPlan = sumPlanAcrossParts(t.TaskName, allSubs);
    const act = roundHours1(ttH);
    if (combinedPlan <= 0) continue;
    const threshold = combinedPlan * (1 + OVER_PLAN_WARN_PCT / 100);
    if (act > threshold) {
      seen.add(key);
      results.push({
        taskName: t.TaskName,
        act,
        plan: combinedPlan,
        pct: Math.round((act / combinedPlan) * 100),
      });
    }
  }
  return results;
}

export function roundHours1(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

/**
 * Fetch TT rows for the WP project date window, filter by job number + OAP users,
 * return Map(lowerCaseTtAction -> sum hours).
 */
export async function fetchTtTaskHourTotalsForProject({
  ttToken,
  selectedProject,
  oapAllowedTtUserIds,
}) {
  const projectNumber = extractWpJobNumber(selectedProject.ProjectName);
  if (!projectNumber) {
    throw new Error(
      'Work Planner project name must start with a number (e.g. "1234 Client") to match Time Tracking.'
    );
  }

  const allReports = await fetchAllTtReports(ttToken);
  const reportsForProject = allReports.filter((report) =>
    jobNumbersMatch(selectedProject.ProjectName, report.p?.name)
  );
  const { start: monthStart, end: monthEnd } = deriveDateRangeFromReports(reportsForProject);

  const ttMap = aggregateTtHoursByTaskName(reportsForProject, oapAllowedTtUserIds);
  const ttReportsForCompare = reportsForProject.filter((r) => {
    const uid = r.u?.id;
    if (uid == null) return false;
    if (oapAllowedTtUserIds != null && !oapAllowedTtUserIds.has(uid)) return false;
    return true;
  });
  return { ttMap, monthStart, monthEnd, ttReportsForCompare };
}

export const ALGO_ASSIGNMENT_FIELDS = [
  "Algorithm_1",
  "Algorithm_2",
  "Algorithm_3",
  "Override_1",
  "Override_2",
  "Override_3",
];

/** "First Last (TT #1)" → "first" (apitest flat rows). */
function ttUserLabelToFirstNameKey(userLabel) {
  const base = String(userLabel || "")
    .replace(/\s*\(TT\s*#.*$/i, "")
    .trim();
  if (!base) return null;
  const first = base.split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

/** Match keys from one sub row: full cell + first token (TT "john" matches algo "John Smith"). */
function collectAlgoAssigneeMatchKeysAndDisplayFromSub(sub) {
  const matchKeys = new Set();
  const displayValues = new Set();
  if (!sub) return { matchKeys, displayValues };
  for (const field of ALGO_ASSIGNMENT_FIELDS) {
    const v = sub[field];
    if (v == null || String(v).trim() === "") continue;
    const raw = String(v).trim().toLowerCase();
    displayValues.add(raw);
    matchKeys.add(raw);
    const first = raw.split(/\s+/)[0];
    if (first) matchKeys.add(first);
  }
  return { matchKeys, displayValues };
}

function algoDisplayCoveredByTtKeys(displayLower, ttKeys) {
  if (!displayLower) return true;
  if (ttKeys.has(displayLower)) return true;
  const first = displayLower.split(/\s+/)[0];
  return first ? ttKeys.has(first) : false;
}

function collectTtKeysFromRows(ttRowsOrFlatRows) {
  const ttKeys = new Set();
  const ttKeyToLabels = new Map();
  const rows = ttRowsOrFlatRows || [];
  if (rows.length === 0) return { ttKeys, ttKeyToLabels };

  if (rows[0].userLabel != null) {
    for (const row of rows) {
      const k = ttUserLabelToFirstNameKey(row.userLabel);
      if (!k) continue;
      ttKeys.add(k);
      if (!ttKeyToLabels.has(k)) ttKeyToLabels.set(k, new Set());
      ttKeyToLabels.get(k).add(row.userLabel);
    }
  } else {
    for (const r of rows) {
      const uid = r.u?.id;
      if (uid == null) continue;
      const k = r.u?.firstname?.trim().toLowerCase();
      if (!k) continue;
      ttKeys.add(k);
      const label =
        [r.u?.firstname, r.u?.lastname].filter(Boolean).join(" ").trim() ||
        `User_${uid}`;
      const fullLabel = `${label} (TT #${uid})`;
      if (!ttKeyToLabels.has(k)) ttKeyToLabels.set(k, new Set());
      ttKeyToLabels.get(k).add(fullLabel);
    }
  }
  return { ttKeys, ttKeyToLabels };
}

function taskLabelFromTtRow(row) {
  if (row && row.a !== undefined) {
    return String(row.a?.name || "N/A").trim() || "N/A";
  }
  return String(row?.taskName || "N/A").trim() || "N/A";
}

function groupTtRowsByTask(ttRowsOrFlatRows) {
  const map = new Map();
  for (const row of ttRowsOrFlatRows || []) {
    const t = taskLabelFromTtRow(row);
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(row);
  }
  return map;
}

/**
 * Console warning when Time Tracking people (OAP-filtered rows) differ from
 * algorithm/override columns on the **matched WP sub** for each TT action.
 * Accepts TT API rows or apitest flat rows `{ taskName, userLabel }`.
 */
export function logTtVsAlgoEmployeeMismatch(project, ttRowsOrFlatRows) {
  if (!project || !ttRowsOrFlatRows?.length) return;
  const wpSubs = flattenWpSubs(project);
  const byTask = {};
  const taskGroups = groupTtRowsByTask(ttRowsOrFlatRows);
  for (const [ttTaskLabel, taskRows] of taskGroups) {
    if (!taskRows.length) continue;
    const { ttKeys, ttKeyToLabels } = collectTtKeysFromRows(taskRows);
    const matchedSub = findWpSubForTtAction(ttTaskLabel, wpSubs);
    const { matchKeys, displayValues } =
      collectAlgoAssigneeMatchKeysAndDisplayFromSub(matchedSub);
    const inTtNotAlgo = [...ttKeys].filter((k) => !matchKeys.has(k)).sort();
    const inAlgoNotTt = [...displayValues]
      .filter((a) => !algoDisplayCoveredByTtKeys(a, ttKeys))
      .sort();
    const noWpSub = !matchedSub;
    if (noWpSub && ttKeys.size === 0) continue;
    if (inTtNotAlgo.length === 0 && inAlgoNotTt.length === 0 && !noWpSub) continue;
    byTask[ttTaskLabel] = {
      wpTaskNameMatched: matchedSub ? matchedSub.TaskName : null,
      ...(noWpSub
        ? { note: "No Work Planner sub matched this TT action (same rules as Plan matching)." }
        : {}),
      inTimeTrackingNotInAlgo: inTtNotAlgo.map((k) => ({
        firstNameKey: k,
        ttLabels: [...(ttKeyToLabels.get(k) || [])],
      })),
      inAlgoNotInTimeTracking: inAlgoNotTt,
    };
  }
  if (Object.keys(byTask).length === 0) return;
  const byTaskSorted = Object.fromEntries(
    Object.entries(byTask).sort(([a], [b]) => a.localeCompare(b))
  );
  console.warn(
    "[TT vs algo] Per task: Time Tracking loggers vs algorithm/override on the matched WP row.",
    {
      project: project.ProjectName,
      byTask: byTaskSorted,
      hint: "Each key is the TT action name; wpTaskNameMatched is the WP sub used for that comparison.",
    }
  );
}

/**
 * Set Act from TT totals and recompute per / left fields.
 * Uses combined Plan across all parts for progress %; same TT total per matching part row.
 */
export function applyTtHoursToSubs(subs, ttMap, fullProject = null) {
  const today = formatTodayDisplay();
  const allSubs = fullProject ? flattenWpSubs(fullProject) : subs;

  return subs.map((task) => {
    if (task.Done === 1 || task.Done === true) return task;
    const ttH = matchWpTaskToTtHours(task.TaskName, ttMap);
    if (ttH == null) return task;

    const plan = parseFloat(task.Plan || 0);
    const combinedPlan = sumPlanAcrossParts(task.TaskName, allSubs) || plan;
    const act = roundHours1(ttH);

    const updated = {
      ...task,
      Act: act,
      Plan2: task.Plan,
      Updated: today,
      ttBacked: true,
    };
    updated.left_1 = plan - act;

    if (act > 0 && combinedPlan > 0) {
      const manualPer = Number(task.per) || 0;
      const ttDerivedPer = Math.max(0, Math.round((act / combinedPlan) * 100));
      if (manualPer < TT_DERIVE_THRESHOLD) {
        updated.per = ttDerivedPer;
      }
      updated.left_2 = Math.round(plan * (1 - (Number(updated.per) || 0) / 100));
    }
    return updated;
  });
}

function filterReportsForProjectNumber(allReports, wpProjectName) {
  return (allReports || []).filter((report) =>
    jobNumbersMatch(wpProjectName, report.p?.name)
  );
}

function filterReportsForTtProject(allReports, ttProjectName) {
  return filterReportsByTtProjectName(allReports, ttProjectName);
}

function displayRangeFromReports(reports) {
  const { start, end } = deriveDateRangeFromReports(reports);
  return {
    monthStart: start || "All time",
    monthEnd: end || "",
  };
}

/** Per-project TT summary from a pre-fetched report set (no extra TT API calls). */
export function computeProjectTtSummaryFromReports({
  project,
  allReports,
  oapAllowedTtUserIds,
  fallbackDateRange,
}) {
  const projectNumber = extractWpJobNumber(project?.ProjectName);
  const wpSubs = flattenWpSubs(project);

  if (!projectNumber) {
    return {
      projectId: project?.id,
      projectName: project?.ProjectName || "",
      color: project?.Color,
      jobNumber: null,
      monthStart: "All time",
      monthEnd: "",
      totalTtHours: 0,
      totalPlanHours: 0,
      variance: 0,
      taskCount: wpSubs.length,
      matchedTaskCount: 0,
      adminHours: [],
      taskRows: [],
      hasJobNumber: false,
    };
  }

  const reportsForProject = filterReportsForProjectNumber(allReports, project.ProjectName);
  const { monthStart, monthEnd } = displayRangeFromReports(reportsForProject);
  const ttMap = aggregateTtHoursByTaskName(reportsForProject, oapAllowedTtUserIds);

  let totalTtHours = 0;
  for (const hours of ttMap.values()) {
    totalTtHours += hours;
  }

  const seenPlanTasks = new Set();
  let totalPlanHours = 0;
  for (const sub of wpSubs) {
    if (sub.Done === 1 || sub.Done === true) continue;
    const key = String(sub.TaskName || "").trim().toLowerCase();
    if (!key || seenPlanTasks.has(key)) continue;
    seenPlanTasks.add(key);
    totalPlanHours += sumPlanAcrossParts(sub.TaskName, wpSubs);
  }

  const adminHours = collectTtAdminHourTasks(ttMap, wpSubs);
  const taskRows = buildMatchedTaskRows(wpSubs, ttMap);

  const roundedTt = roundHours1(totalTtHours);
  const roundedPlan = roundHours1(totalPlanHours);

  return {
    projectId: project.id,
    projectName: project.ProjectName,
    color: project.Color,
    jobNumber: projectNumber,
    monthStart,
    monthEnd,
    totalTtHours: roundedTt,
    totalPlanHours: roundedPlan,
    variance: roundHours1(roundedTt - roundedPlan),
    taskCount: wpSubs.length,
    matchedTaskCount: taskRows.length,
    adminHours,
    taskRows,
    hasJobNumber: true,
  };
}

/** Per-project summary from TT project list + pre-fetched reports. */
function buildTtUserNameMap(ttUsers) {
  const map = new Map();
  for (const u of ttUsers || []) {
    if (u?.id != null) map.set(Number(u.id), u);
  }
  return map;
}

function createTtSummaryAccumulator({ ttProject, wpProject, oapAllowedTtUserIds, ttUserNameMap, ttUserWpMap, wpEmployees = [] }) {
  const wpSubs = wpProject ? flattenWpSubs(wpProject) : [];
  const seenPlanTasks = new Set();
  let totalPlanHours = 0;
  for (const sub of wpSubs) {
    if (sub.Done === 1 || sub.Done === true) continue;
    const key = String(sub.TaskName || "").trim().toLowerCase();
    if (!key || seenPlanTasks.has(key)) continue;
    seenPlanTasks.add(key);
    totalPlanHours += sumPlanAcrossParts(sub.TaskName, wpSubs);
  }

  return {
    ttProject,
    wpProject,
    wpSubs,
    oapAllowedTtUserIds,
    ttUserNameMap,
    ttUserWpMap: ttUserWpMap instanceof Map ? ttUserWpMap : new Map(),
    wpEmployees: Array.isArray(wpEmployees) ? wpEmployees : [],
    totalPlanHours: roundHours1(totalPlanHours),
    taskHours: new Map(),
    taskUserHours: new Map(),
    employeeHours: new Map(),
    lastMonthHours: 0,
    currentMonthHours: 0,
    currentMonthStart: getCurrentMonthStartYmd(),
    dateMin: null,
    dateMax: null,
  };
}

function applyReportSliceToAccumulator(acc, sliceReports) {
  const reportsForProject = filterReportsForTtProject(sliceReports, acc.ttProject.name);
  if (!reportsForProject.length) return;

  const filtered = filterReportsByOapUsers(reportsForProject, acc.oapAllowedTtUserIds);
  const taskMap = aggregateHoursByTask(filtered);
  for (const [key, hours] of taskMap) {
    acc.taskHours.set(key, (acc.taskHours.get(key) || 0) + hours);
  }

  const taskUsers = aggregateHoursByTaskAndEmployee(filtered, acc.ttUserNameMap);
  for (const [taskKey, users] of taskUsers) {
    if (!acc.taskUserHours.has(taskKey)) {
      acc.taskUserHours.set(taskKey, new Map());
    }
    const dest = acc.taskUserHours.get(taskKey);
    for (const row of users.values()) {
      const prev = dest.get(row.userId);
      if (prev) {
        prev.hours += row.hours;
      } else {
        dest.set(row.userId, { ...row });
      }
    }
  }

  for (const row of aggregateHoursByEmployee(filtered, acc.ttUserNameMap)) {
    const prev = acc.employeeHours.get(row.userId);
    if (prev) {
      prev.hours += row.hours;
    } else {
      acc.employeeHours.set(row.userId, { ...row });
    }
  }

  const monthStart = acc.currentMonthStart || getCurrentMonthStartYmd();
  for (const report of filtered) {
    const hours = (Number(report?.t?.duration) || 0) / 60;
    if (hours <= 0) continue;
    const date = String(report?.t?.date || '').slice(0, 10);
    if (date && date >= monthStart) {
      acc.currentMonthHours += hours;
    } else {
      acc.lastMonthHours += hours;
    }
  }

  const { start, end } = deriveDateRangeFromReports(reportsForProject);
  if (start && (!acc.dateMin || start < acc.dateMin)) acc.dateMin = start;
  if (end && (!acc.dateMax || end > acc.dateMax)) acc.dateMax = end;
}

function enrichTtEmployeeRow(row, ttUserWpMap) {
  if (!row) return row;

  // Shared TT B-TEAM logins must stay unmatched so expandBTeamEmployeeHours can split
  // them across KM1–3 / AH1–3 — never bind the shared login to one WP person.
  if (isTtBTeamSharedLabel(row.name)) {
    return {
      ...row,
      wpEmployeeId: null,
      wpMatched: false,
      name: row.name || (row.userId != null ? `User #${row.userId}` : 'Unknown'),
      team_id: null,
      teamName: null,
    };
  }

  const wpEmployee = row.userId != null
    ? ttUserWpMap?.get(Number(row.userId))
    : null;
  if (!wpEmployee) {
    return {
      ...row,
      wpEmployeeId: null,
      wpMatched: false,
      name: row.name || (row.userId != null ? `User #${row.userId}` : 'Unknown'),
    };
  }

  return {
    ...row,
    wpEmployeeId: wpEmployee.id ?? null,
    wpMatched: true,
    name: employeeDisplayName(wpEmployee) || row.name,
    team_id: wpEmployee.team_id ?? null,
    teamName: wpEmployee.team?.name || wpEmployee.team_name || null,
  };
}

function mergeEmployeeHourRows(rows = []) {
  const byKey = new Map();
  for (const row of rows || []) {
    const hours = Number(row.hours) || 0;
    if (hours <= 0) continue;
    const key = row.wpEmployeeId != null
      ? `wp:${row.wpEmployeeId}`
      : row.userId != null
        ? `tt:${row.userId}`
        : `name:${String(row.name || '').toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.hours += hours;
    } else {
      byKey.set(key, { ...row, hours });
    }
  }
  return [...byKey.values()]
    .map((row) => ({ ...row, hours: roundHours1(row.hours) }))
    .filter((row) => row.hours > 0)
    .sort((left, right) => right.hours - left.hours || String(left.name || '').localeCompare(String(right.name || '')));
}

/**
 * TT shared B-TEAM logins → even split across the matching WP pool of 3:
 * B-TEAM / B-TEAM3 → KM1–KM3; B-TEAM2 / B-TEAM4 → AH1–AH3.
 */
export function expandBTeamEmployeeHours(rows = [], wpEmployees = [], ttUserWpMap = null) {
  const expanded = [];

  for (const raw of rows || []) {
    const enriched = enrichTtEmployeeRow(raw, ttUserWpMap);
    const hours = Number(enriched?.hours) || 0;
    if (hours <= 0) continue;

    const shouldSplit = !enriched.wpMatched && isTtBTeamSharedLabel(enriched.name);
    if (!shouldSplit) {
      expanded.push(enriched);
      continue;
    }

    const pool = resolveTtBTeamPool(enriched.name);
    const slots = listWpBTeamSlotEmployees(wpEmployees, pool);
    if (!slots.length) {
      expanded.push(enriched);
      continue;
    }

    const shares = splitHoursEvenly(hours, slots.length);
    slots.forEach((slot, index) => {
      const share = shares[index] || 0;
      if (share <= 0) return;
      expanded.push({
        userId: enriched.userId,
        name: employeeDisplayName(slot),
        hours: share,
        wpEmployeeId: slot.id ?? null,
        wpMatched: true,
        team_id: slot.team_id ?? null,
        teamName: employeeTeamName(slot) || slot.team?.name || null,
        fromTtBTeam: true,
        ttBTeamPool: pool,
        ttBTeamUserId: enriched.userId ?? null,
        ttBTeamName: enriched.name,
      });
    });
  }

  return mergeEmployeeHourRows(expanded);
}

function summaryFromAccumulator(acc) {
  const { ttProject, wpProject, wpSubs, taskHours, employeeHours, ttUserWpMap, wpEmployees } = acc;
  const jobNumber = extractTtJobNumber(ttProject?.name);

  let totalTtHours = 0;
  for (const hours of taskHours.values()) {
    totalTtHours += hours;
  }

  const adminHours = wpSubs.length ? collectTtAdminHourTasks(taskHours, wpSubs) : [];
  const taskRows = buildMatchedTaskRows(
    wpSubs,
    taskHours,
    acc.taskUserHours,
    (row) => row,
  ).map((task) => ({
    ...task,
    employeeHours: expandBTeamEmployeeHours(task.employeeHours, wpEmployees, ttUserWpMap),
  }));

  const employeeRows = expandBTeamEmployeeHours(
    Array.from(employeeHours.values()).map((row) => ({ ...row, hours: roundHours1(row.hours) })),
    wpEmployees,
    ttUserWpMap,
  );

  const roundedTt = roundHours1(totalTtHours);
  const roundedPlan = acc.totalPlanHours;

  return {
    projectId: ttProject.id,
    projectName: ttProject.name,
    ttProjectName: ttProject.name,
    wpProjectName: wpProject?.ProjectName ?? wpProject?.name ?? null,
    wpProjectId: wpProject?.id ?? null,
    wpMatchStatus: wpProject ? "matched" : "tt_only",
    color: wpProject?.Color ?? wpProject?.color,
    jobNumber,
    monthStart: acc.dateMin || "All time",
    monthEnd: acc.dateMax || "",
    totalTtHours: roundedTt,
    lastMonthHours: roundHours1(acc.lastMonthHours),
    currentMonthHours: roundHours1(acc.currentMonthHours),
    totalPlanHours: roundedPlan,
    variance: roundHours1(roundedTt - roundedPlan),
    taskCount: wpSubs.length || taskRows.length,
    matchedTaskCount: taskRows.length,
    adminHours,
    taskRows,
    employeeRows,
    employeeCount: employeeRows.length,
    hasJobNumber: Boolean(jobNumber),
    isTtProject: true,
  };
}

function sortSummaries(summaries) {
  return [...summaries].sort((a, b) => {
    const dateA = String(a.monthEnd || a.monthStart || '').slice(0, 10);
    const dateB = String(b.monthEnd || b.monthStart || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateA) && /^\d{4}-\d{2}-\d{2}$/.test(dateB) && dateA !== dateB) {
      return dateB.localeCompare(dateA);
    }
    if (b.totalTtHours !== a.totalTtHours) return b.totalTtHours - a.totalTtHours;
    return String(a.projectName).localeCompare(String(b.projectName));
  });
}

export function computeTtProjectSummaryFromReports({
  ttProject,
  allReports,
  oapAllowedTtUserIds,
  fallbackDateRange,
  wpProject = null,
  ttUserNameMap = null,
}) {
  const jobNumber = extractTtJobNumber(ttProject?.name);
  const wpSubs = wpProject ? flattenWpSubs(wpProject) : [];

  const reportsForProject = filterReportsForTtProject(allReports, ttProject.name);
  const { monthStart, monthEnd } = displayRangeFromReports(reportsForProject);
  const ttMap = aggregateTtHoursByTaskName(reportsForProject, oapAllowedTtUserIds);
  const employeeRows = aggregateHoursByEmployee(reportsForProject, ttUserNameMap);

  let totalTtHours = 0;
  for (const hours of ttMap.values()) {
    totalTtHours += hours;
  }

  const seenPlanTasks = new Set();
  let totalPlanHours = 0;
  for (const sub of wpSubs) {
    if (sub.Done === 1 || sub.Done === true) continue;
    const key = String(sub.TaskName || "").trim().toLowerCase();
    if (!key || seenPlanTasks.has(key)) continue;
    seenPlanTasks.add(key);
    totalPlanHours += sumPlanAcrossParts(sub.TaskName, wpSubs);
  }

  const adminHours = wpSubs.length ? collectTtAdminHourTasks(ttMap, wpSubs) : [];
  const taskRows = buildMatchedTaskRows(wpSubs, ttMap);

  const roundedTt = roundHours1(totalTtHours);
  const roundedPlan = roundHours1(totalPlanHours);

  return {
    projectId: ttProject.id,
    projectName: ttProject.name,
    ttProjectName: ttProject.name,
    wpProjectName: wpProject?.ProjectName ?? wpProject?.name ?? null,
    wpProjectId: wpProject?.id ?? null,
    wpMatchStatus: wpProject ? "matched" : "tt_only",
    color: wpProject?.Color ?? wpProject?.color,
    jobNumber,
    monthStart,
    monthEnd,
    totalTtHours: roundedTt,
    totalPlanHours: roundedPlan,
    variance: roundHours1(roundedTt - roundedPlan),
    taskCount: wpSubs.length || taskRows.length,
    matchedTaskCount: taskRows.length,
    adminHours,
    taskRows,
    employeeRows,
    employeeCount: employeeRows.length,
    hasJobNumber: Boolean(jobNumber),
    isTtProject: true,
  };
}

/** WP project with no matching TT project (comparison result). */
export function computeWpOnlySummary({ wpProject }) {
  const wpSubs = flattenWpSubs(wpProject);
  const wpName = wpProject?.ProjectName || wpProject?.name || '';
  const jobNumber = extractWpJobNumber(wpName);

  const seenPlanTasks = new Set();
  let totalPlanHours = 0;
  for (const sub of wpSubs) {
    if (sub.Done === 1 || sub.Done === true) continue;
    const key = String(sub.TaskName || "").trim().toLowerCase();
    if (!key || seenPlanTasks.has(key)) continue;
    seenPlanTasks.add(key);
    totalPlanHours += sumPlanAcrossParts(sub.TaskName, wpSubs);
  }

  return {
    projectId: `wp-${wpProject.id}`,
    projectName: wpName,
    ttProjectName: null,
    wpProjectName: wpName,
    wpProjectId: wpProject.id,
    wpMatchStatus: "wp_only",
    color: wpProject.Color ?? wpProject.color,
    jobNumber,
    monthStart: "All time",
    monthEnd: "",
    totalTtHours: 0,
    totalPlanHours: roundHours1(totalPlanHours),
    variance: roundHours1(-totalPlanHours),
    taskCount: wpSubs.length,
    matchedTaskCount: 0,
    adminHours: [],
    taskRows: [],
    hasJobNumber: Boolean(jobNumber),
    isTtProject: false,
  };
}

/**
 * 1) Fetch projects from Time Tracking
 * 2) Compare to Work Planner projects by job number
 * 3) Fetch reports and build summaries (TT rows first, then WP-only rows)
 */
export async function fetchAllTtProjectsSummaries({
  ttToken,
  oapAllowedTtUserIds,
  wpProjects = [],
  wpEmployees = [],
  includeWpOnly = true,
  matchedOnly = false,
  ttUsers = [],
  ttProjectId = null,
  ttUserId = null,
  onProgress,
}) {
  const { ttProjects, comparison } = await loadTtProjectsWithComparison({
    token: ttToken,
    wpProjects,
  });

  if (!ttProjects.length) {
    return {
      summaries: [],
      ttProjects: [],
      comparison,
      monthStart: '',
      monthEnd: '',
    };
  }

  const scopedTtProjects = ttProjectId
    ? ttProjects.filter((project) => String(project.id) === String(ttProjectId))
    : ttProjects;

  const wpByTtKey = new Map(
    comparison.matched.map((m) => [String(m.ttProject.id), m.wpProject]),
  );
  const ttUserNameMap = buildTtUserNameMap(ttUsers);
  const ttUserWpMap = buildTtUserToWpEmployeeMap(ttUsers, wpEmployees);

  const projectsForSummaries = matchedOnly
    ? scopedTtProjects.filter((project) => wpByTtKey.has(String(project.id)))
    : scopedTtProjects;

  const accumulators = projectsForSummaries.map((ttProject) =>
    createTtSummaryAccumulator({
      ttProject,
      wpProject: wpByTtKey.get(String(ttProject.id)) ?? null,
      oapAllowedTtUserIds,
      ttUserNameMap,
      ttUserWpMap,
      wpEmployees,
    }),
  );

  const wpOnlySummaries = includeWpOnly && !matchedOnly && !ttProjectId && !ttUserId
    ? comparison.wpOnly.map(({ wpProject }) => computeWpOnlySummary({ wpProject }))
    : [];

  let globalDateMin = null;
  let globalDateMax = null;

  const window = getLastAndCurrentMonthRange();

  await ttForEachReportSlice(
    ttToken,
    {
      userId: ttUserId ?? null,
      projectId: ttProjectId ?? null,
      startDate: window.start,
      endDate: window.end,
    },
    async ({ reports, label, index, total }) => {
    if (reports.length) {
      const { start, end } = deriveDateRangeFromReports(reports);
      if (start && (!globalDateMin || start < globalDateMin)) globalDateMin = start;
      if (end && (!globalDateMax || end > globalDateMax)) globalDateMax = end;
    }

    for (const acc of accumulators) {
      applyReportSliceToAccumulator(acc, reports);
    }

    if (onProgress) {
      const ttSummaries = accumulators.map(summaryFromAccumulator);
      const isLastSlice = index === total;
      onProgress({
        summaries: isLastSlice
          ? sortSummaries([...ttSummaries, ...wpOnlySummaries])
          : [...ttSummaries, ...wpOnlySummaries],
        ttProjects,
        comparison,
        sliceLabel: label,
        sliceIndex: index,
        sliceTotal: total,
        monthStart: globalDateMin || window.start,
        monthEnd: globalDateMax || window.end,
      });
    }
  });

  const monthStart = globalDateMin || window.start;
  const monthEnd = globalDateMax || window.end;
  const ttSummaries = accumulators.map(summaryFromAccumulator);
  const summaries = sortSummaries([...ttSummaries, ...wpOnlySummaries]);

  return {
    summaries,
    ttProjects,
    comparison,
    monthStart,
    monthEnd,
  };
}

/** Fetch TT once, then summarise every WP project. */
export async function fetchAllProjectsTtSummaries({
  ttToken,
  projects,
  oapAllowedTtUserIds,
}) {
  const allReports = await fetchAllTtReports(ttToken);
  const { start: monthStart, end: monthEnd } = deriveDateRangeFromReports(allReports);
  const fallbackDateRange = { start: "", end: "" };

  const summaries = (projects || []).map((project) =>
    computeProjectTtSummaryFromReports({
      project,
      allReports,
      oapAllowedTtUserIds,
      fallbackDateRange,
    })
  );

  return {
    summaries: summaries.sort((a, b) => b.totalTtHours - a.totalTtHours),
    monthStart,
    monthEnd,
  };
}
