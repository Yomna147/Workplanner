import { ttGetProjects, ttSearchAllReports } from "./client";
import { compareTtProjectsToWp } from "./wpMatch";

/** Min/max dates from report rows (for display only). */
export function deriveDateRangeFromReports(reports) {
  let minDate = null;
  let maxDate = null;
  for (const row of reports || []) {
    const raw = row?.t?.date;
    if (!raw) continue;
    const d = String(raw).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }
  return {
    start: minDate ?? "",
    end: maxDate ?? "",
    label: minDate && maxDate ? `${minDate} → ${maxDate}` : "All time",
  };
}

export function getGlobalDateRangeFromProjects(projectList) {
  let minDate = null;
  let maxDate = null;
  (projectList || []).forEach((project) => {
    (project.parts || []).forEach((part) => {
      (part.subs || []).forEach((sub) => {
        const rawStart = sub.Doc_Supply;
        const rawEnd = sub.Completion;
        if (!rawStart || !rawEnd) return;
        const start = new Date(rawStart);
        const end = new Date(rawEnd);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
        if (!minDate || start < minDate) minDate = start;
        if (!maxDate || end > maxDate) maxDate = end;
      });
    });
  });
  return {
    start: minDate ? minDate.toISOString().split("T")[0] : undefined,
    end: maxDate ? maxDate.toISOString().split("T")[0] : undefined,
  };
}

/**
 * 1) Getprojectlist (TT projects)
 * 2) Compare to WP projects
 */
export async function loadTtProjectsWithComparison({ token, wpProjects = [] }) {
  const ttProjects = await ttGetProjects(token);
  const comparison = compareTtProjectsToWp(ttProjects, wpProjects);
  return { ttProjects, comparison };
}

/** IndividualSearch — all reports, no date filter. */
export async function loadAllTtReports({ token, userId = null, projectId = null }) {
  return ttSearchAllReports(token, { userId, projectId });
}
