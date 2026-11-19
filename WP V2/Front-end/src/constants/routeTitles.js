export const APP_NAME = 'Workplanner';

/** Browser tab titles keyed by route path (must match App.jsx routes). */
export const ROUTE_TITLES = {
  '/': 'Home',
  '/operatives-allocation': 'Operatives Allocation',
  '/projects': 'Project Data Entry',
  '/dl-input-hours': 'DL Project Data Update',
  '/project-progress': "Measurer's Time Planning",
  '/user-availability': 'User Availability',
  '/resource-histogram': 'Resource Histogram',
  '/trainings': 'Trainings',
  '/tt-project-hours': 'TT Project Hours',
  '/apitest': 'TT API Test',
  '/admin/system-monitor': 'System Monitor',
  '/admin/outlook-emails': 'Outlook Emails',
  '/admin/access-permissions': 'Access Permissions',
  '/admin/activity-log': 'Activity Log',
  '/admin/roles': 'Roles',
  '/admin/email-notifications': 'Email Notifications',
  '/login': 'Sign in',
  '/register': 'Register',
};

export function formatPageTitle(title) {
  return title ? `${title} · ${APP_NAME}` : APP_NAME;
}

export function getRouteTitle(pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return ROUTE_TITLES[normalized] ?? null;
}
