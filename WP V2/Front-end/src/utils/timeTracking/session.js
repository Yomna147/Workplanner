import { ttDiscoverUsers, ttGetUsers, ttLogin } from "./client";
import { matchTtUserToWpEmployee } from "../employeeNames";

export function employeeQualifiesForOapNrmFilter(employee, teamIds, oapNrmIds) {
  if (employee?.team_id == null || !teamIds.has(employee.team_id)) return false;
  const empNrms = employee.nrms || [];
  if (empNrms.length === 0) return false;
  return empNrms.some((en) => oapNrmIds.has(en.id));
}

export function buildOapAllowedTtUserIds(ttUsers, employees, teams, nrms) {
  const teamIds = new Set((teams || []).map((t) => t.id));
  const oapNrmIds = new Set((nrms || []).map((n) => n.id));
  const allowed = new Set();

  for (const user of ttUsers || []) {
    if (user?.id == null) continue;
    const match = matchTtUserToWpEmployee(user, employees);
    if (!match) continue;
    if (!employeeQualifiesForOapNrmFilter(match, teamIds, oapNrmIds)) continue;
    allowed.add(Number(user.id));
  }
  return allowed;
}

export function getCredentialsFromEnv() {
  return {
    loginname: import.meta.env.VITE_TIMETRACKING_LOGIN || 'yomna',
    password: import.meta.env.VITE_TIMETRACKING_PASSWORD || '',
  };
}

/**
 * Full TT session: login (yomna) → Getuserlist or IndividualSearch.
 * Same as v1: credentials from the page / VITE_ env, backend falls back to .env.
 */
export async function createTtSession({
  loginname,
  password,
  apiClient = null,
  axiosClient = null,
  discoverUsers = true,
} = {}) {
  const envCreds = getCredentialsFromEnv();
  const name = loginname || envCreds.loginname;
  const pass = password || envCreds.password;
  const { token, raw: loginRaw } = await ttLogin(name, pass);
  const resolvedLogin = loginRaw?.loginname ?? name ?? 'yomna';

  let users = [];
  let usersSource = discoverUsers ? "individualSearch" : "getuserlist";

  if (discoverUsers) {
    try {
      users = await ttDiscoverUsers(token);
    } catch (discoverErr) {
      console.warn("[TT] IndividualSearch user discovery failed, trying Getuserlist.", discoverErr);
      usersSource = "getuserlist";
      try {
        users = await ttGetUsers(token, {
          id: 1,
          loginname: resolvedLogin,
          firstname: loginRaw?.firstname ?? resolvedLogin,
          lastname: loginRaw?.lastname ?? "",
        });
      } catch (listErr) {
        console.warn("[TT] Getuserlist also failed.", listErr);
      }
    }
  } else {
    try {
      users = await ttGetUsers(token, {
        id: 1,
        loginname: resolvedLogin,
        firstname: loginRaw?.firstname ?? resolvedLogin,
        lastname: loginRaw?.lastname ?? "",
      });
    } catch (listErr) {
      console.warn("[TT] Getuserlist failed.", listErr);
    }
  }

  if (!users.length) {
    console.warn("[TT] No users found from IndividualSearch or Getuserlist.");
  }

  let oapAllowedTtUserIds = null;
  // OAP filter disabled — include all TT report rows (same as v1 TT Project Hours).

  return { token, users, usersSource, oapAllowedTtUserIds, loginRaw };
}
