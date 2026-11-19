/** Postman stores responseBody as token (plain string). Laravel proxy wraps { token }. */
export function parseToken(loginResponse) {
  let token = "";
  if (typeof loginResponse === "string" && loginResponse) {
    token = loginResponse.replace(/^"|"$/g, "");
  } else {
    const raw = loginResponse?.token ?? loginResponse?.data?.token ?? "";
    token = typeof raw === "string" ? raw.replace(/^"|"$/g, "") : raw;
  }
  if (!token || typeof token !== "string") {
    throw new Error("Time Tracking login failed — no token returned.");
  }
  // TT API returns a JWT; error messages are returned as plain text in the token field.
  if (!token.startsWith("eyJ")) {
    throw new Error(token);
  }
  return token;
}

export function extractTtJobNumber(name) {
  if (name == null || typeof name !== "string") return null;
  const s = String(name).trim();
  const leading = s.match(/^(\d+)/);
  if (leading) return leading[1];
  const any = s.match(/(\d+)/);
  return any ? any[1] : null;
}

export function normalizeProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ?? raw.projectId ?? raw.Id;
  const name = raw.name ?? raw.Name ?? raw.projectName ?? raw.ProjectName ?? "";
  const trimmed = String(name).trim();
  if (!trimmed && id == null) return null;
  const createdRaw = raw.createdat
    ?? raw.createdAt
    ?? raw.created_at
    ?? raw.CreateDate
    ?? raw.creationDate
    ?? raw.CreationDate
    ?? null;
  return {
    id: id ?? trimmed,
    name: trimmed || `Project ${id}`,
    jobNumber: extractTtJobNumber(trimmed),
    createdAt: createdRaw != null && String(createdRaw).trim() !== ""
      ? String(createdRaw).trim()
      : null,
  };
}

export function parseProjects(response) {
  if (Array.isArray(response)) return response.map(normalizeProject).filter(Boolean);
  if (Array.isArray(response?.data)) return response.data.map(normalizeProject).filter(Boolean);
  if (Array.isArray(response?.projects)) return response.projects.map(normalizeProject).filter(Boolean);
  if (Array.isArray(response?.project)) return response.project.map(normalizeProject).filter(Boolean);
  return [];
}

export function parseUsers(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.users)) return response.users;
  if (Array.isArray(response?.result)) return response.result;
  return [];
}

/** Resolve TT user id — API often puts userid on `t`, with `u.id` as 0. */
export function resolveReportUserId(row) {
  const top = row?.u;
  const topId = top?.id != null ? Number(top.id) : null;
  if (topId != null && topId > 0) return topId;
  const tUserId = row?.t?.userid ?? row?.t?.userId ?? row?.userId;
  if (tUserId != null && Number(tUserId) > 0) return Number(tUserId);
  return null;
}

export function formatReportUserName(u, userId) {
  const first = String(u?.firstname ?? "").trim();
  const last = String(u?.lastname ?? "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  const login = String(u?.loginname ?? "").trim();
  if (login) return login;
  return userId != null ? `User #${userId}` : "Unknown";
}

/** Unique TT users from IndividualSearch rows. */
export function extractUsersFromReports(reports) {
  const byId = new Map();
  for (const row of reports || []) {
    const id = resolveReportUserId(row);
    if (id == null) continue;
    const u = row?.u;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        firstname: String(u?.firstname ?? "").trim(),
        lastname: String(u?.lastname ?? "").trim(),
        loginname: String(u?.loginname ?? "").trim(),
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const nameA = `${a.firstname} ${a.lastname}`.trim().toLowerCase();
    const nameB = `${b.firstname} ${b.lastname}`.trim().toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

/** TT report row: { p: project, a: action, t: time, u: user } */
export function normalizeReportRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const p =
    raw.p && typeof raw.p === "object"
      ? raw.p
      : { id: raw.projectId, name: raw.projectName ?? raw.project ?? "" };
  const a =
    raw.a && typeof raw.a === "object"
      ? raw.a
      : { id: raw.actionId, name: raw.taskName ?? raw.action ?? "" };
  const t =
    raw.t && typeof raw.t === "object"
      ? raw.t
      : {
          duration: raw.duration ?? raw.spentMinutes ?? 0,
          date: raw.date ?? "",
          comments: raw.comments ?? "",
        };
  const rawU = raw.u && typeof raw.u === "object" ? raw.u : null;
  const userId =
    (rawU?.id != null && Number(rawU.id) > 0 ? Number(rawU.id) : null) ??
    (raw.t?.userid != null ? Number(raw.t.userid) : null) ??
    (raw.t?.userId != null ? Number(raw.t.userId) : null) ??
    (raw.userId != null ? Number(raw.userId) : null);
  const u = {
    id: userId,
    firstname: rawU?.firstname ?? raw.userFirstname ?? raw.firstname ?? "",
    lastname: rawU?.lastname ?? raw.userLastname ?? raw.lastname ?? "",
    loginname: rawU?.loginname ?? raw.loginname ?? "",
  };
  if (u.id == null && !p.name && !a.name) return null;
  return { p, a, t, u };
}

export function parseReports(response) {
  if (typeof response === "string") {
    const msg = response.trim();
    if (msg && !msg.startsWith("{") && !msg.startsWith("[")) {
      console.warn("[TT] GetView error:", msg);
      return [];
    }
  }
  const rows = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  return rows.map(normalizeReportRow).filter(Boolean);
}

/** duration field is minutes → hours */
export function reportDurationHours(row) {
  return (Number(row?.t?.duration) || 0) / 60;
}
