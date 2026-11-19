import api from '../api/client';
import {
  createTtSession,
  getCredentialsFromEnv,
  loadTtProjectsWithComparison,
} from './timeTracking';
import { getTodayYmd } from './timeTracking/slices';

/** Bumped when notify rules change so prior silent seeds can re-apply quietly. */
const SEEN_TT_PROJECT_IDS_KEY = 'wp2_tt_hours_seen_project_ids_v5';

function summaryKey(summary) {
  if (summary?.projectId != null && String(summary.projectId).trim() !== '') {
    return `tt:${summary.projectId}`;
  }
  if (summary?.wpProjectId != null && String(summary.wpProjectId).trim() !== '') {
    return `wp:${summary.wpProjectId}`;
  }
  const name = String(summary?.ttProjectName || summary?.projectName || '').trim().toLowerCase();
  return name ? `name:${name}` : '';
}

function summaryLabel(summary) {
  const job = summary?.jobNumber != null && String(summary.jobNumber).trim() !== ''
    ? `#${summary.jobNumber} `
    : '';
  const name = String(summary?.ttProjectName || summary?.projectName || summary?.wpProjectName || '').trim();
  return `${job}${name || `Project ${summary?.projectId ?? ''}`.trim()}`.trim();
}

function extractJobNumber(value) {
  const match = String(value || '').trim().match(/^(\d{4,})/);
  return match ? match[1] : null;
}

export function isTtProjectMissingInWp(summary) {
  if (!summary) return false;
  if (summary.wpMatchStatus === 'tt_only') return true;
  if (summary.wpMatchStatus === 'matched') return false;
  return summary.wpProjectId == null;
}

/** Parse TT createdAt to YYYY-MM-DD when possible. */
export function parseTtCreatedYmd(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim();

  const isoDay = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDay) return isoDay[1];

  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slash) {
    const day = slash[1].padStart(2, '0');
    const month = slash[2].padStart(2, '0');
    const year = slash[3];
    // Prefer DD/MM/YYYY (UK TT); if month > 12 treat as MM/DD/YYYY.
    if (Number(slash[2]) > 12) {
      return `${year}-${day}-${month}`;
    }
    return `${year}-${month}-${day}`;
  }

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return getTodayYmd(new Date(ms));
}

/**
 * Current/future TT projects only (not historical).
 * Uses createdAt when present; undated rows stay eligible so post-seed newcomers can still alert.
 */
export function isTtProjectCurrentOrFuture(summary, todayYmd = getTodayYmd()) {
  const createdYmd = parseTtCreatedYmd(summary?.createdAt);
  if (!createdYmd) return true;
  return createdYmd >= todayYmd;
}

export function isTtNotifyEligible(summary, todayYmd = getTodayYmd()) {
  return isTtProjectMissingInWp(summary) && isTtProjectCurrentOrFuture(summary, todayYmd);
}

export function readSeenTtProjectIds() {
  try {
    const raw = localStorage.getItem(SEEN_TT_PROJECT_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((id) => String(id)).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function writeSeenTtProjectIds(ids) {
  try {
    const list = [...ids].map((id) => String(id)).filter(Boolean);
    localStorage.setItem(SEEN_TT_PROJECT_IDS_KEY, JSON.stringify(list));
  } catch {
    // ignore storage failures
  }
}

function toNotifyItem(row) {
  const name = String(row?.ttProjectName || row?.projectName || row?.wpProjectName || '').trim();
  const job = row?.jobNumber != null && String(row.jobNumber).trim() !== ''
    ? String(row.jobNumber).trim()
    : extractJobNumber(name);
  return {
    id: summaryKey(row),
    label: summaryLabel(row),
    name,
    jobNumber: job,
    createdAt: row?.createdAt ?? null,
    missingInWp: true,
  };
}

/**
 * Notify candidates: TT-only (not in WP) job-numbered projects.
 * Matched / already-in-WP projects are never included.
 */
export function buildTtNotifyRows(summaries = [], comparison = null) {
  void summaries;

  return (comparison?.ttOnly ?? [])
    .map(({ ttProject, jobNumber }) => {
      const job = (jobNumber != null && String(jobNumber).trim() !== '')
        ? String(jobNumber)
        : extractJobNumber(ttProject?.name);
      if (!job) return null;
      return {
        projectId: ttProject?.id,
        projectName: ttProject?.name,
        ttProjectName: ttProject?.name,
        jobNumber: job,
        createdAt: ttProject?.createdAt ?? null,
        wpMatchStatus: 'tt_only',
        wpProjectId: null,
        isTtProject: true,
      };
    })
    .filter(Boolean);
}

/**
 * Diff newly loaded TT-only rows against previously seen project IDs.
 * - First run: seed all TT-only (including past) quietly — never toast the backlog.
 * - Later runs: toast only newly seen, current/future, missing-in-WP projects.
 */
export function detectNewTtProjects(summaries = [], { seedOnly = false } = {}) {
  const rows = (summaries ?? []).filter((row) => row && summaryKey(row));
  const nextIds = new Set(rows.map(summaryKey).filter(Boolean));
  const seen = readSeenTtProjectIds();

  if (seedOnly || seen.size === 0) {
    writeSeenTtProjectIds(new Set([...seen, ...nextIds]));
    return [];
  }

  const newcomers = rows.filter((row) => (
    !seen.has(summaryKey(row))
    && isTtNotifyEligible(row)
  ));
  writeSeenTtProjectIds(new Set([...seen, ...nextIds]));
  return newcomers.map(toNotifyItem);
}

export function formatNewTtProjectsToast(newProjects = []) {
  if (!newProjects.length) return '';

  if (newProjects.length === 1) {
    return `New TT project not in Work Planner: ${newProjects[0].label}`;
  }

  const preview = newProjects.slice(0, 3).map((project) => project.label).join(', ');
  const more = newProjects.length > 3 ? ` (+${newProjects.length - 3} more)` : '';
  return `New TT projects not in Work Planner (${newProjects.length}): ${preview}${more}`;
}

/**
 * Fresh TT ↔ WP comparison (no hours cache). Returns newly notifiable projects.
 */
export async function fetchFreshTtNewProjects({ wpProjects = null } = {}) {
  let projects = wpProjects;
  if (!Array.isArray(projects) || !projects.length) {
    const response = await api.get('/projects/tt-comparison', { params: { all: true } });
    projects = response.data?.data ?? [];
  }

  const { loginname, password } = getCredentialsFromEnv();
  const session = await createTtSession({
    loginname,
    password,
    discoverUsers: false,
  });

  const { comparison } = await loadTtProjectsWithComparison({
    token: session.token,
    wpProjects: projects,
  });

  return detectNewTtProjects(buildTtNotifyRows([], comparison));
}
