export const STEP_STATUS = {
  pending: 'pending',
  running: 'running',
  ok: 'ok',
  warn: 'warn',
  error: 'error',
  skipped: 'skipped',
};

/** Postman flow — same order as v1 apitest. */
export function createInitialTtLoadSteps() {
  return [
    {
      id: 'wp-session',
      label: 'WP session',
      endpoint: 'Sanctum auth (must be logged into Work Planner)',
      status: STEP_STATUS.pending,
      detail: '',
    },
    {
      id: 'tt-login',
      label: 'TT UserLogin',
      endpoint: 'POST /api/timetracking-login → https://timetracking.trevorsadd.co.uk/api/account/login (yomna)',
      status: STEP_STATUS.pending,
      detail: '',
    },
    {
      id: 'tt-users',
      label: 'Discover TT users',
      endpoint: 'Getuserlist (fallback: IndividualSearch current year)',
      status: STEP_STATUS.pending,
      detail: '',
    },
    {
      id: 'tt-projects',
      label: 'Getprojectlist',
      endpoint: 'POST /api/timetracking-projects (X-TT-Token) → timetracking /project/search',
      status: STEP_STATUS.pending,
      detail: '',
    },
    {
      id: 'wp-projects',
      label: 'WP projects',
      endpoint: 'GET /api/projects/tt-comparison?all=true',
      status: STEP_STATUS.pending,
      detail: '',
    },
    {
      id: 'compare',
      label: 'Compare TT ↔ WP',
      endpoint: 'Match by job number (client-side)',
      status: STEP_STATUS.pending,
      detail: '',
    },
    {
      id: 'report-slices',
      label: 'IndividualSearch (current year)',
      endpoint: 'POST /api/timetracking-report-search-all (X-TT-Token, current year only)',
      status: STEP_STATUS.pending,
      detail: '',
    },
    {
      id: 'summaries',
      label: 'Build project summaries',
      endpoint: 'Aggregate TT hours per project / task / employee',
      status: STEP_STATUS.pending,
      detail: '',
    },
  ];
}

export function patchTtLoadStep(steps, id, patch) {
  return steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
}

export function resetTtLoadSteps(steps) {
  return steps.map((step) => ({
    ...step,
    status: STEP_STATUS.pending,
    detail: '',
  }));
}

export function formatStepError(error) {
  if (!error) return 'Unknown error';
  const response = error?.response;
  if (response?.data?.message) return String(response.data.message);
  if (response?.status) {
    return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  }
  return error?.message || String(error);
}
