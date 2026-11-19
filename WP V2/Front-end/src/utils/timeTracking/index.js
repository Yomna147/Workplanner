/**
 * Time Tracking module — canonical API aligned with TimeTracking Postman collection.
 *
 * Endpoints (via Laravel proxy):
 *   POST timetracking-login          → /account/login
 *   POST timetracking-projects       → /project/search (no body)
 *   POST timetracking-users          → /Account/Getreportstousers
 *   POST timetracking-report-search      → /reports/GetView (single query)
 *   POST timetracking-report-search-all  → bulk GetView (server-side month batches)
 */

export {
  buildIndividualSearchPayload,
  buildLoginPayload,
  buildUsersPayload,
} from "./payloads";

export {
  extractTtJobNumber,
  extractUsersFromReports,
  formatReportUserName,
  normalizeProject,
  normalizeReportRow,
  parseProjects,
  parseReports,
  parseToken,
  parseUsers,
  reportDurationHours,
  resolveReportUserId,
} from "./parsers";

export {
  ttDiscoverUsers,
  ttForEachReportSlice,
  ttGetProjects,
  ttGetUsers,
  ttLogin,
  ttSearchAllReports,
  ttSearchReportSlice,
  ttSearchReports,
  ttSearchReportsByMonth,
} from "./client";

export { buildMonthSlices, buildYearSlices, formatMonthWindowLabel, getCurrentMonthStartYmd, getCurrentYearStart, getLastAndCurrentMonthRange, getTodayYmd, TT_REPORTS_EARLIEST } from "./slices";

export {
  buildOapAllowedTtUserIds,
  createTtSession,
  employeeQualifiesForOapNrmFilter,
  getCredentialsFromEnv,
} from "./session";

export {
  aggregateHoursByEmployee,
  aggregateHoursByTask,
  aggregateHoursByTaskAndEmployee,
  compareTtProjectsToWp,
  extractWpJobNumber,
  filterReportsByJobNumber,
  filterReportsByOapUsers,
  filterReportsByTtProjectName,
  jobNumbersMatch,
} from "./wpMatch";

export {
  deriveDateRangeFromReports,
  getGlobalDateRangeFromProjects,
  loadAllTtReports,
  loadTtProjectsWithComparison,
} from "./sync";
