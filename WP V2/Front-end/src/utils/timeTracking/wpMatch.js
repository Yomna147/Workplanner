import { extractTtJobNumber, formatReportUserName, resolveReportUserId } from "./parsers";

/** WP project names: leading job number (e.g. "1234 Client"). */
export function extractWpJobNumber(name) {
  if (name == null || typeof name !== "string") return null;
  const m = String(name).trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

export function jobNumbersMatch(wpProjectName, ttProjectName) {
  const wpNum = extractWpJobNumber(wpProjectName);
  if (!wpNum) return false;
  const ttNum = extractTtJobNumber(ttProjectName);
  return ttNum != null && ttNum === wpNum;
}

/** TT projects first, then compare to WP by job number. */
export function compareTtProjectsToWp(ttProjects, wpProjects) {
  const wpByJob = new Map();
  for (const wp of wpProjects || []) {
    const job = extractWpJobNumber(wp?.ProjectName || wp?.name);
    if (job && !wpByJob.has(job)) wpByJob.set(job, wp);
  }

  const matchedJobNumbers = new Set();
  const matched = [];
  const ttOnly = [];

  for (const ttProject of ttProjects || []) {
    const job = extractTtJobNumber(ttProject?.name);
    const wpProject = job ? wpByJob.get(job) : null;
    if (wpProject) {
      matchedJobNumbers.add(job);
      matched.push({ ttProject, wpProject, jobNumber: job });
    } else {
      ttOnly.push({ ttProject, jobNumber: job });
    }
  }

  const wpOnly = [];
  for (const wpProject of wpProjects || []) {
    const job = extractWpJobNumber(wpProject?.ProjectName || wpProject?.name);
    if (!job || matchedJobNumbers.has(job)) continue;
    wpOnly.push({ wpProject, jobNumber: job });
  }

  return {
    matched,
    ttOnly,
    wpOnly,
    stats: {
      ttCount: (ttProjects || []).length,
      wpCount: (wpProjects || []).length,
      matchedCount: matched.length,
      ttOnlyCount: ttOnly.length,
      wpOnlyCount: wpOnly.length,
    },
  };
}

export function filterReportsByJobNumber(reports, jobNumber) {
  if (!jobNumber) return [];
  return (reports || []).filter((r) => extractTtJobNumber(r.p?.name) === jobNumber);
}

export function filterReportsByTtProjectName(reports, ttProjectName) {
  const target = String(ttProjectName || "").trim().toLowerCase();
  const targetJob = extractTtJobNumber(ttProjectName);
  return (reports || []).filter((r) => {
    const name = r.p?.name;
    if (!name) return false;
    if (String(name).trim().toLowerCase() === target) return true;
    return targetJob != null && extractTtJobNumber(name) === targetJob;
  });
}

export function filterReportsByOapUsers(reports, oapAllowedTtUserIds) {
  if (oapAllowedTtUserIds == null) return reports || [];
  return (reports || []).filter((r) => {
    const uid = resolveReportUserId(r);
    return uid != null && oapAllowedTtUserIds.has(uid);
  });
}

/** Sum TT hours per employee on a project. */
export function aggregateHoursByEmployee(reports, ttUserNameMap = null) {
  const map = new Map();
  for (const r of reports || []) {
    const uid = resolveReportUserId(r);
    if (uid == null) continue;
    const fromMap = ttUserNameMap?.get(uid);
    const name = fromMap
      ? `${fromMap.firstname} ${fromMap.lastname}`.trim() || fromMap.loginname
      : formatReportUserName(r.u, uid);
    const h = (Number(r.t?.duration) || 0) / 60;
    if (!map.has(uid)) {
      map.set(uid, { userId: uid, name: name || `User #${uid}`, hours: 0 });
    }
    map.get(uid).hours += h;
  }
  return Array.from(map.values())
    .map((row) => ({ ...row, hours: Math.round(row.hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours);
}

export function aggregateHoursByTask(reports) {
  const map = new Map();
  for (const r of reports || []) {
    const key = String(r.a?.name || "N/A").trim().toLowerCase();
    const h = (Number(r.t?.duration) || 0) / 60;
    map.set(key, (map.get(key) || 0) + h);
  }
  return map;
}

/** Hours per TT task, split by employee (for OAP team grouping). */
export function aggregateHoursByTaskAndEmployee(reports, ttUserNameMap = null) {
  const map = new Map();
  for (const r of reports || []) {
    const taskKey = String(r.a?.name || "N/A").trim().toLowerCase();
    const uid = resolveReportUserId(r);
    if (uid == null) continue;
    const h = (Number(r.t?.duration) || 0) / 60;
    if (!map.has(taskKey)) {
      map.set(taskKey, new Map());
    }
    const users = map.get(taskKey);
    if (!users.has(uid)) {
      const fromMap = ttUserNameMap?.get(uid);
      const name = fromMap
        ? `${fromMap.firstname} ${fromMap.lastname}`.trim() || fromMap.loginname
        : formatReportUserName(r.u, uid);
      users.set(uid, { userId: uid, name: name || `User #${uid}`, hours: 0 });
    }
    users.get(uid).hours += h;
  }
  return map;
}
