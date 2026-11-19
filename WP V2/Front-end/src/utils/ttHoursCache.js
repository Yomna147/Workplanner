import api from '../api/client';
import { sortTasksBySection } from './taskSectionDefaults';

export const CACHE_VERSION = 6;

/** Refetch TT hours when cache is older than this (2 days). */
export const TT_HOURS_REFRESH_MS = 2 * 24 * 60 * 60 * 1000;

const CACHE_PUT_TIMEOUT_MS = 120000;

export function isTtHoursCacheStale(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return true;
  return now - Number(fetchedAt) >= TT_HOURS_REFRESH_MS;
}

function normalizeTaskRow(row) {
  if (!row || !row.taskName) return null;

  return {
    ...row,
    ttHours: Number(row.ttHours) || 0,
    planHours: row.planHours == null ? row.planHours : Number(row.planHours) || 0,
    variance: row.variance == null ? row.variance : Number(row.variance) || 0,
    employeeHours: Array.isArray(row.employeeHours)
      ? row.employeeHours
        .map((person) => ({
          ...person,
          hours: Number(person.hours) || 0,
        }))
        .filter((person) => person.hours > 0)
      : [],
  };
}

function normalizeSummary(summary) {
  if (!summary || summary.projectId == null) return null;

  const taskRows = sortTasksBySection(
    (summary.taskRows ?? []).map(normalizeTaskRow).filter(Boolean),
    (row) => row.taskName,
  );

  return {
    ...summary,
    wpProjectId: summary.wpProjectId ?? null,
    wpProjectName: summary.wpProjectName ?? null,
    wpMatchStatus: summary.wpMatchStatus ?? 'matched',
    totalTtHours: Number(summary.totalTtHours) || 0,
    lastMonthHours: Number(summary.lastMonthHours) || 0,
    currentMonthHours: Number(summary.currentMonthHours) || 0,
    totalPlanHours: summary.totalPlanHours == null
      ? summary.totalPlanHours
      : Number(summary.totalPlanHours) || 0,
    variance: summary.variance == null ? summary.variance : Number(summary.variance) || 0,
    employeeRows: Array.isArray(summary.employeeRows) ? summary.employeeRows : [],
    adminHours: Array.isArray(summary.adminHours) ? summary.adminHours : [],
    taskRows,
    taskCount: Number(summary.taskCount) || taskRows.length,
    matchedTaskCount: Number(summary.matchedTaskCount) || taskRows.length,
    employeeCount: Number(summary.employeeCount) || summary.employeeRows?.length || 0,
  };
}

export function normalizeTtHoursCache(data) {
  if (!data?.fetchedAt) return null;

  const fetchedAt = Number(data.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null;
  if (Number(data.version) !== CACHE_VERSION) return null;

  const summaries = (data.summaries ?? [])
    .map(normalizeSummary)
    .filter(Boolean);

  return {
    version: Number(data.version) || 1,
    fetchedAt,
    summaries,
    ttUsers: Array.isArray(data.ttUsers) ? data.ttUsers : [],
    dateRange: {
      start: data.dateRange?.start ?? '',
      end: data.dateRange?.end ?? '',
    },
    updatedAt: data.updatedAt ?? null,
    summaryCount: summaries.length,
  };
}

/** Strip unused fields to keep DB payload smaller and saves faster. */
export function prepareTtHoursCachePayload(payload) {
  const summaries = (payload.summaries ?? [])
    .map(normalizeSummary)
    .filter(Boolean);

  return {
    version: CACHE_VERSION,
    fetchedAt: payload.fetchedAt,
    summaries,
    ttUsers: payload.ttUsers ?? [],
    dateRange: {
      start: payload.dateRange?.start ?? '',
      end: payload.dateRange?.end ?? '',
    },
  };
}

export async function readTtHoursCache() {
  try {
    const response = await api.get('/tt-hours-cache', { timeout: 60000 });
    const normalized = normalizeTtHoursCache(response.data?.data);
    if (!normalized) return null;
    return normalized;
  } catch (error) {
    console.warn('[TT Hours] Failed to load cache from Work Planner DB.', error);
    return null;
  }
}

export async function writeTtHoursCache(payload) {
  const body = prepareTtHoursCachePayload(payload);

  try {
    const response = await api.put('/tt-hours-cache', body, {
      timeout: CACHE_PUT_TIMEOUT_MS,
    });
    return normalizeTtHoursCache(response.data?.data) ?? true;
  } catch (error) {
    console.warn('[TT Hours] Failed to save cache to Work Planner DB.', error);
    return false;
  }
}

export function msUntilTtHoursRefresh(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return 0;
  return Math.max(0, TT_HOURS_REFRESH_MS - (now - Number(fetchedAt)));
}
