export const navMenus = [
  {
    id: 'views',
    label: 'Views',
    items: [
      { label: 'Home', to: '/', page: 'Dashboard' },
      { label: 'Work Plan View', disabled: true },
      { label: 'Resource Histogram', to: '/resource-histogram', page: 'Resource Histogram' },
      { label: 'Sales Plan View', disabled: true },
    ],
  },
  {
    id: 'work-planning',
    label: 'Work Planning Data',
    items: [
      { label: 'Project Data Entry', to: '/projects', page: 'Project Data Entry' },
      { label: 'Trainings', to: '/trainings', page: 'Trainings' },
      { label: 'TT Project Hours', to: '/tt-project-hours', page: 'TT Project Hours' },
      { label: 'Operatives Allocation', to: '/operatives-allocation', page: 'Operatives Allocation' },
      { label: 'Project Description', disabled: true },
      { label: 'Estimate Hours', disabled: true },
    ],
  },
  {
    id: 'user-data',
    label: "User's Data Entry",
    items: [
      { label: 'User Availability', to: '/user-availability', page: 'User Availability' },
      { label: 'DL Input Hours', to: '/dl-input-hours', page: 'DL Input Hours' },
      { label: "Measurer's Time Planning", to: '/project-progress', page: 'Project Progress' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    items: [
      { label: 'System Monitor', to: '/admin/system-monitor', page: 'System Monitor' },
      { label: 'Outlook Emails', to: '/admin/outlook-emails', page: 'Outlook Emails' },
      { label: 'Access Permissions', to: '/admin/access-permissions', page: 'Access Permissions' },
      { label: 'Activity Log', to: '/admin/activity-log', page: 'Activity Log' },
      { label: 'Role', to: '/admin/roles', page: 'Role' },
      { label: 'Email Notifications', to: '/admin/email-notifications', page: 'Email Notifications' },
    ],
  },
];
