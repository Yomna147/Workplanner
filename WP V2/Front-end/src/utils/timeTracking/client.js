/**
 * Time Tracking HTTP client — Laravel proxy → timetracking.trevorsadd.co.uk
 * Mirrors Postman collection: UserLogin, Getprojectlist, Getuserlist, IndividualSearch
 */
import { getApiErrorMessage } from '../apiErrors';
import {
  getReportSlice,
  getReports,
  getTtProjects,
  getUsers,
  loginUser,
} from '../timeTrackingApi';
import { buildMonthSlices, buildYearSlices, getCurrentYearStart, TT_REPORTS_EARLIEST } from "./slices";
import { buildIndividualSearchPayload, buildLoginPayload, buildUsersPayload } from "./payloads";
import {
  extractUsersFromReports,
  parseProjects,
  parseReports,
  parseToken,
  parseUsers,
} from "./parsers";

/** Postman: UserLogin — POST /api/account/login (yomna). */
export async function ttLogin(loginname, password) {
  try {
    const response = await loginUser(buildLoginPayload(loginname, password));
    const token = parseToken(response);
    if (!token) {
      throw new Error(response?.message || "Time Tracking login failed.");
    }
    return { token, raw: response };
  } catch (error) {
    throw new Error(getApiErrorMessage(error, 'Time Tracking login failed.'));
  }
}

/** Postman: Getprojectlist — POST /project/search, Bearer only */
export async function ttGetProjects(token) {
  const response = await getTtProjects(token);
  return parseProjects(response);
}

/** Postman: Getuserlist (fallback only). */
export async function ttGetUsers(token, userProfile) {
  const response = await getUsers(token, buildUsersPayload(userProfile));
  return parseUsers(response);
}

/** Postman: IndividualSearch — single request (empty dates = no date filter). */
export async function ttSearchReports(token, searchOptions = {}) {
  const payload = buildIndividualSearchPayload({
    startDate: searchOptions.startDate ?? "",
    endDate: searchOptions.endDate ?? "",
    userId: searchOptions.userId ?? null,
    projectId: searchOptions.projectId ?? null,
    loginname: searchOptions.loginname ?? "",
    pagesize: searchOptions.pagesize ?? 10000,
    pageno: searchOptions.pageno ?? 1,
  });
  const response = await getReports(token, payload);
  return parseReports(response);
}

/** One date slice — Laravel fetches months within startDate/endDate only. */
export async function ttSearchReportSlice(token, startDate, endDate, options = {}) {
  const response = await getReportSlice(token, {
    startDate,
    endDate,
    userId: options.userId ?? null,
    projectId: options.projectId ?? null,
    loginname: options.loginname ?? "",
    pagesize: options.pagesize ?? 10000,
  });
  return parseReports(response);
}

/**
 * Fetch reports in date slices; calls onSlice after each slice (no giant in-memory merge).
 * Pass startDate + endDate for month slices (TT Project Hours uses last + current month).
 * Otherwise year slices from startDate (default: current year).
 */
export async function ttForEachReportSlice(token, options = {}, onSlice) {
  const slices = options.endDate
    ? buildMonthSlices(options.startDate ?? getCurrentYearStart(), options.endDate)
    : buildYearSlices(options.startDate ?? getCurrentYearStart());
  const total = slices.length;

  for (let i = 0; i < slices.length; i++) {
    const { label, startDate, endDate } = slices[i];
    const reports = await ttSearchReportSlice(token, startDate, endDate, options);
    if (onSlice) {
      await onSlice({
        reports,
        label,
        index: i + 1,
        total,
        startDate,
        endDate,
      });
    }
  }
}

/** @deprecated Prefer ttForEachReportSlice — concatenates all slices into one array. */
export async function ttSearchAllReports(token, options = {}) {
  const all = [];
  await ttForEachReportSlice(token, options, ({ reports }) => {
    all.push(...reports);
  });
  return all;
}

/** Discover TT users from all IndividualSearch rows (no date filter). */
export async function ttDiscoverUsers(token, options = {}) {
  const reports = await ttSearchAllReports(token, options);
  return extractUsersFromReports(reports);
}

/** IndividualSearch month-by-month (Postman uses explicit sdate/edate per request). */
export async function ttSearchReportsByMonth(token, startDate, endDate, options = {}) {
  if (!startDate || !endDate) return [];

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  const all = [];

  while (cursor <= endMonth) {
    const year = cursor.getFullYear();
    const month = String(cursor.getMonth() + 1).padStart(2, "0");
    const monthStart = `${year}-${month}-01`;
    const next = new Date(monthStart);
    next.setMonth(next.getMonth() + 1);
    const monthEnd = next.toISOString().split("T")[0];

    const chunk = await ttSearchReports(token, {
      startDate: monthStart,
      endDate: monthEnd,
      userId: options.userId ?? null,
      projectId: options.projectId ?? null,
      loginname: options.loginname ?? "",
      pagesize: options.pagesize ?? 10000,
    });
    all.push(...chunk);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return all;
}
