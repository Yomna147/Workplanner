/**
 * Request payloads — TimeTracking Postman collection (v2.1).
 * Base URL: https://timetracking.trevorsadd.co.uk
 */

/** Postman: UserLogin — POST /account/login */
export function buildLoginPayload(loginname, password) {
  return {
    loginname,
    password,
    subscription: {},
  };
}

/** Postman: Getuserlist — POST /Account/Getreportstousers */
export function buildUsersPayload({ id = 1, firstname, lastname, loginname }) {
  return {
    id,
    firstname: firstname || loginname,
    lastname: lastname || "",
    loginname,
  };
}

/**
 * Postman: IndividualSearch — POST /reports/GetView
 * Filter order matches Postman exactly: p, t(sdate), u.loginname, u.id, t(edate), pr, a, s
 */
export function buildIndividualSearchPayload({
  startDate = "",
  endDate = "",
  userId = null,
  projectId = null,
  loginname = "",
  pagesize = 10000,
  pageno = 1,
}) {
  const userIdFilter =
    userId != null && userId !== ""
      ? { table: "u", column: "id", value: String(userId), operation: "In" }
      : { table: "u", column: "id", value: "" };

  return {
    pageno,
    ispage: true,
    pagesize,
    sortcol: "t.date",
    filter: [
      {
        table: "p",
        column: "id",
        value: projectId != null && projectId !== "" ? String(projectId) : "",
        paraname: "pid",
        operation: "=",
      },
      {
        table: "t",
        column: "date",
        value: startDate,
        paraname: "sdate",
        operation: ">=",
      },
      {
        table: "u",
        column: "loginname",
        value: loginname || "",
      },
      userIdFilter,
      {
        table: "t",
        column: "date",
        value: endDate,
        paraname: "edate",
        operation: "<=",
      },
      {
        table: "pr",
        column: "id",
        value: "",
        paraname: "prid",
        operation: "=",
      },
      {
        table: "a",
        column: "id",
        value: "",
        paraname: "aid",
        operation: "=",
      },
      {
        table: "s",
        column: "id",
        value: "",
        paraname: "sid",
        operation: "=",
      },
    ],
    Dfilter: { summary: false },
    count: 0,
    duration: 0,
  };
}
