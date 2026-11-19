/** Maps app routes to role-permission page names (see RolePageSeeder). */
export const ROUTE_PAGE_PERMISSIONS = {
  '/': 'Dashboard',
  '/projects': 'Project Data Entry',
  '/resource-histogram': 'Resource Histogram',
  '/trainings': 'Trainings',
  '/operatives-allocation': 'Operatives Allocation',
  '/user-availability': 'User Availability',
  '/dl-input-hours': 'DL Input Hours',
  '/project-progress': 'Project Progress',
  '/tt-project-hours': 'TT Project Hours',
  '/admin/system-monitor': 'System Monitor',
  '/admin/outlook-emails': 'Outlook Emails',
  '/admin/access-permissions': 'Access Permissions',
  '/admin/activity-log': 'Activity Log',
  '/admin/roles': 'Role',
  '/admin/email-notifications': 'Email Notifications',
};

/** Preferred fallback order when redirecting away from a denied page. */
export const DEFAULT_ROUTE_PRIORITY = [
  '/',
  '/resource-histogram',
  '/projects',
  '/trainings',
  '/operatives-allocation',
  '/dl-input-hours',
  '/project-progress',
  '/user-availability',
  '/tt-project-hours',
];

export function getPagePermissionForRoute(path) {
  const normalized = String(path || '').replace(/\/+$/, '') || '/';
  return ROUTE_PAGE_PERMISSIONS[normalized] ?? null;
}
