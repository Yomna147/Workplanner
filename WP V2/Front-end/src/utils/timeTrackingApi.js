import api from '../api/client';

function withTtToken(token, config = {}) {
  return {
    ...config,
    headers: {
      ...(config.headers || {}),
      // WP Sanctum uses Authorization; TT JWT goes in a separate header (v1 used Authorization when routes were public).
      'X-TT-Token': token,
    },
    timeout: config.timeout ?? 180000,
  };
}

export async function loginUser(payload = {}) {
  const { data } = await api.post('/timetracking-login', payload);
  return data;
}

export async function getUsers(token, payload) {
  const { data } = await api.post('/timetracking-users', payload, withTtToken(token));
  return data;
}

export async function getReports(token, payload) {
  const { data } = await api.post('/timetracking-report-search', payload, withTtToken(token, { timeout: 300000 }));
  return data;
}

export async function getReportSlice(token, payload) {
  const { data } = await api.post('/timetracking-report-search-all', payload, withTtToken(token));
  return data;
}

export async function getTtProjects(token) {
  const { data } = await api.post('/timetracking-projects', {}, withTtToken(token));
  return data;
}
