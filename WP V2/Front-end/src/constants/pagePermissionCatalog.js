/** Page names and per-page actions for role permissions. Keep in sync with PagePermissionCatalog.php */

export const PAGE_PERMISSION_CATALOG = [
  {
    page: 'Dashboard',
    description: 'Home page, stats, and shortcuts to pages the role can open.',
    actions: [],
  },
  {
    page: 'Project Data Entry',
    description: 'Projects, parts, tasks, hours, and the allocation algorithm.',
    actions: [
      { key: 'edit', label: 'Edit projects, parts, and tasks', description: 'Create projects, add parts, save task rows, copy, and update hours.', group: 'editing' },
      { key: 'run_algorithm', label: 'Run algorithm', description: 'Run the allocation algorithm from this page.', group: 'editing' },
      { key: 'delete', label: 'Delete projects, parts, and tasks', description: 'Remove a project, part, or selected tasks.', group: 'additional' },
      { key: 'view_edits_log', label: 'View edits log', description: 'Open Project Data Entry edit history.', group: 'additional' },
    ],
  },
  {
    page: 'Resource Histogram',
    description: 'Schedule chart: task bars, trainings, and saved schedule history.',
    actions: [
      { key: 'edit_bars', label: 'Edit histogram bars', description: 'Drag, resize, reassign, save, and undo task bars. Includes the task editor.', group: 'editing' },
      { key: 'run_algorithm', label: 'Run algorithm after save', description: 'Offer to run the algorithm when saving bar edits.', group: 'editing' },
      { key: 'delete_trainings', label: 'Delete trainings from the histogram', description: 'Remove a training assignment or whole session from histogram panels.', group: 'additional' },
    ],
  },
  {
    page: 'Trainings',
    description: 'Training roster, gap view, and course catalog.',
    actions: [
      { key: 'assign', label: 'Create and edit training assignments', description: 'New training, roster save, status changes, and gap-view edits.', group: 'editing' },
      { key: 'delete', label: 'Delete trainings', description: 'Remove a trainee row or a whole training session.', group: 'additional' },
      { key: 'manage_courses', label: 'Manage course catalog', description: 'Add, edit, or archive training courses.', group: 'additional' },
      { key: 'view_activity_log', label: 'View trainings edit log', description: 'Open training assignment history.', group: 'additional' },
      { key: 'receive_gap_alerts', label: 'Receive gap alerts', description: 'See capacity-gap banners and notifications.', group: 'notifications' },
      { key: 'assign_from_gaps', label: 'Assign from gap alerts', description: 'Create a training directly from a gap notification.', group: 'notifications' },
    ],
  },
  {
    page: 'User Availability',
    description: 'Operative timesheets and availability import.',
    actions: [
      { key: 'edit', label: 'Edit availability', description: 'Add, edit, duplicate, and delete availability rows, then save.', group: 'editing' },
      { key: 'import', label: 'Import availability', description: 'Import one or more sheet tabs from a spreadsheet.', group: 'editing' },
      { key: 'duplicate_week', label: 'Duplicate week', description: 'Copy a week of hours onto another week.', group: 'editing' },
    ],
  },
  {
    page: 'DL Input Hours',
    description: 'DL plan hours on project tasks and the signed-in operative’s trainings.',
    actions: [
      { key: 'edit', label: 'Edit DL plan hours', description: 'Change and save DL task fields.', group: 'editing' },
      { key: 'run_algorithm', label: 'Run algorithm after save', description: 'Offer to run the algorithm when saving DL updates.', group: 'editing' },
      { key: 'edit_own_trainings', label: 'Edit own trainings', description: 'Update the signed-in operative’s training rows on this page.', group: 'editing' },
    ],
  },
  {
    page: 'Project Progress',
    description: "Measurer's Time Planning — section expected hours by operative.",
    actions: [
      { key: 'edit_hours', label: 'Edit section hours', description: 'Enter and save section expected hours (typically the operative’s own rows).', group: 'editing' },
      { key: 'view_all_employees', label: 'View all operatives', description: 'Pick any employee, not only the signed-in operative.', group: 'additional' },
      { key: 'approve_hours', label: 'Approve section hours', description: 'Tick DL approval. Hour fields stay read-only for approvers who are not admins.', group: 'additional' },
    ],
  },
  {
    page: 'Operatives Allocation',
    description: 'OAP / performance matrix, teams, NRM sections, and operatives.',
    actions: [
      { key: 'edit', label: 'Edit allocation values', description: 'Change and save OAP or performance cells.', group: 'editing' },
      { key: 'delete_employees', label: 'Delete operatives', description: 'Remove selected employees from the allocation table.', group: 'additional' },
      { key: 'manage_employees', label: 'Add / rename operatives', description: 'Create employees and edit names.', group: 'additional' },
      { key: 'manage_teams', label: 'Manage teams', description: 'Create, rename, or delete teams.', group: 'additional' },
      { key: 'manage_nrms', label: 'Manage NRM sections', description: 'Create, rename, or delete NRM sections.', group: 'additional' },
    ],
  },
  {
    page: 'TT Project Hours',
    description: 'Time Tracking hours matched to Work Planner projects.',
    actions: [
      { key: 'refresh', label: 'Load / refresh from Time Tracking', description: 'Pull live TT data and save it into Work Planner.', group: 'editing' },
    ],
  },
  {
    page: 'System Monitor',
    description: 'Application, database, and integration health.',
    actions: [
      { key: 'probe', label: 'Run live probes', description: 'Refresh checks against Time Tracking, Google Sheets, and Sales Tool.', group: 'editing' },
    ],
  },
  {
    page: 'Outlook Emails',
    description: 'Browse Outlook mailboxes and filter Order Confirmation emails.',
    actions: [],
  },
  {
    page: 'Access Permissions',
    description: 'User accounts, passwords, active flag, and role assignment.',
    actions: [
      { key: 'manage_users', label: 'Manage users', description: 'Add, edit, deactivate, or delete users and assign roles.', group: 'editing' },
    ],
  },
  {
    page: 'Activity Log',
    description: 'Cross-page audit log of plan, histogram, and training edits.',
    actions: [],
  },
  {
    page: 'Role',
    description: 'Role names and the page/action matrix.',
    actions: [
      { key: 'manage_roles', label: 'Manage roles and pages', description: 'Create, edit, or delete roles and add pages to the catalogue.', group: 'editing' },
    ],
  },
  {
    page: 'Email Notifications',
    description: 'In-app and email notification rules.',
    actions: [
      { key: 'manage_rules', label: 'Manage notification rules', description: 'Create, edit, test, or delete rules and delivery settings.', group: 'editing' },
    ],
  },
];

const CATALOG_BY_PAGE = new Map(PAGE_PERMISSION_CATALOG.map((entry) => [entry.page, entry]));

export function getCatalogEntry(pageName) {
  return CATALOG_BY_PAGE.get(String(pageName || '').trim()) || null;
}

export function getCatalogActionKeys(pageName) {
  return (getCatalogEntry(pageName)?.actions || []).map((action) => action.key);
}

export function getDefaultEditActions(pageName) {
  return (getCatalogEntry(pageName)?.actions || [])
    .filter((action) => (action.group || 'editing') === 'editing')
    .map((action) => action.key);
}

export function legacyPageActions(pageName, permission = 0, context = {}) {
  const level = Number(permission) || 0;
  if (level < 2) {
    return [];
  }

  const extras = [];
  if (pageName === 'Trainings') {
    const notify = Number(context.notification_permission) || 0;
    if (notify >= 2) extras.push('receive_gap_alerts');
    if (notify >= 3) extras.push('assign_from_gaps');
  }

  if (level < 3) {
    return extras;
  }

  const actions = [...getDefaultEditActions(pageName), ...extras];
  if (pageName === 'Project Progress' && context.has_dl_edit) {
    actions.push('view_all_employees', 'approve_hours');
  }

  return [...new Set(actions)];
}

export const ACTION_GROUP_LABELS = {
  editing: 'Editing',
  additional: 'Privileged',
  notifications: 'Alerts',
};
