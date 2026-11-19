import {
  DEFAULT_ROUTE_PRIORITY,
  getPagePermissionForRoute,
} from '../constants/routePermissions';
import { getCatalogActionKeys, legacyPageActions } from '../constants/pagePermissionCatalog';

export function getPagePermission(user, pageName) {
  if (!user) {
    return 0;
  }

  if (user.is_admin) {
    return 3;
  }

  const permissions = user.role?.permissions;
  if (!Array.isArray(permissions)) {
    return 0;
  }

  const match = permissions.find((item) => item.page === pageName);
  return match?.permission ?? 0;
}

export function getPageActions(user, pageName) {
  if (!user) {
    return [];
  }

  if (user.is_admin) {
    return getCatalogActionKeys(pageName);
  }

  if (getPagePermission(user, pageName) < 2) {
    return [];
  }

  const permissions = user.role?.permissions;
  if (!Array.isArray(permissions)) {
    return [];
  }

  const match = permissions.find((item) => item.page === pageName);
  if (Array.isArray(match?.actions)) {
    return match.actions;
  }

  const dlEdit = getPagePermission(user, 'DL Input Hours') >= 3;
  return legacyPageActions(pageName, match?.permission ?? 0, {
    notification_permission: match?.notification_permission,
    has_dl_edit: dlEdit,
  });
}

export function canViewPage(user, pageName) {
  return getPagePermission(user, pageName) >= 2;
}

export function canEditPage(user, pageName) {
  return getPagePermission(user, pageName) >= 3;
}

export function canPageAction(user, pageName, action) {
  if (!user) {
    return false;
  }

  if (user.is_admin) {
    return true;
  }

  if (!action || action === 'view') {
    return canViewPage(user, pageName);
  }

  if (!canViewPage(user, pageName)) {
    return false;
  }

  return getPageActions(user, pageName).includes(action);
}

export function getPageNotificationPermission(user, pageName) {
  if (!user) {
    return 0;
  }

  if (user.is_admin) {
    return 3;
  }

  if (canPageAction(user, pageName, 'assign_from_gaps')) {
    return 3;
  }
  if (canPageAction(user, pageName, 'receive_gap_alerts')) {
    return 2;
  }

  const permissions = user.role?.permissions;
  if (!Array.isArray(permissions)) {
    return 0;
  }

  const match = permissions.find((item) => item.page === pageName);
  const explicit = Number(match?.notification_permission);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  const legacy = permissions.find((item) => item.page === 'Notifications');
  const legacyLevel = Number(legacy?.permission);
  if (Number.isFinite(legacyLevel) && legacyLevel > 0) {
    return legacyLevel;
  }

  if (pageName === 'Trainings') {
    const pageLevel = Number(match?.permission ?? 0);
    if (pageLevel >= 2) {
      return pageLevel;
    }
  }

  return 0;
}

export function canViewPageNotifications(user, pageName) {
  return getPageNotificationPermission(user, pageName) >= 2;
}

export function canEditPageNotifications(user, pageName) {
  return getPageNotificationPermission(user, pageName) >= 3;
}

export function canViewNotifications(user) {
  return canViewPageNotifications(user, 'Trainings');
}

export function canEditNotifications(user) {
  return canEditPageNotifications(user, 'Trainings');
}

export function canAccessRoute(user, routePath) {
  if (!user) {
    return false;
  }

  if (user.is_admin) {
    return true;
  }

  const pageName = getPagePermissionForRoute(routePath);
  if (!pageName) {
    return false;
  }

  return canViewPage(user, pageName);
}

export function getDefaultAccessibleRoute(user) {
  if (!user) {
    return null;
  }

  for (const route of DEFAULT_ROUTE_PRIORITY) {
    const pageName = getPagePermissionForRoute(route);
    if (pageName && canViewPage(user, pageName)) {
      return route;
    }
  }

  return null;
}

export function isNavItemVisible(item, user) {
  if (item.disabled) {
    return true;
  }

  if (item.page) {
    return canViewPage(user, item.page);
  }

  if (item.adminOnly) {
    return Boolean(user?.is_admin);
  }

  return true;
}

export function filterNavMenus(menus, user) {
  return menus
    .filter((menu) => !menu.adminOnly || user?.is_admin || menu.items.some((item) => isNavItemVisible(item, user)))
    .map((menu) => ({
      ...menu,
      items: menu.items.filter((item) => isNavItemVisible(item, user)),
    }))
    .filter((menu) => menu.items.some((item) => !item.disabled && item.to));
}

/** Matches StandardRolesSeeder TEAM_LEADER_ROLES. */
const TEAM_LEADER_ROLE_NAMES = new Set([
  'NRM1 leader',
  'NRM2 leader',
  'NRM3&4 leader',
  'NRM8 leader',
  'Q&A leader',
  'Support leader',
  'Managers leader',
]);

/** True only for users assigned the DLs role (not team leaders, admins, or other DL Input Hours viewers). */
export function isDlUser(user) {
  return String(user?.role?.name || '').trim() === 'DLs';
}

/** True for NRM / Q&A / Support / Managers team-leader roles (not the DLs role). */
export function isTeamLeaderUser(user) {
  const roleName = String(user?.role?.name || '').trim();
  if (!roleName) {
    return false;
  }
  if (TEAM_LEADER_ROLE_NAMES.has(roleName)) {
    return true;
  }
  // Fallback for custom leader roles seeded later.
  return /\bleader$/i.test(roleName) && roleName.toLowerCase() !== 'dls';
}

/**
 * Exceed-DL budget warning (popup + amber rows) is for team leaders / admins only —
 * not every DL with approve_hours (WP-04).
 */
export function canWarnExceedsDlHours(user) {
  return Boolean(user?.is_admin) || isTeamLeaderUser(user);
}

/** True for Trainer / Trainers role (not admins). */
export function isTrainerUser(user) {
  if (!user || user.is_admin) {
    return false;
  }
  const roleName = String(user?.role?.name || '').trim().toLowerCase();
  return roleName === 'trainer' || roleName === 'trainers';
}

export function canApproveSectionHours(user) {
  return canPageAction(user, 'Project Progress', 'approve_hours');
}

export function canViewAllProgressEmployees(user) {
  return canPageAction(user, 'Project Progress', 'view_all_employees');
}

/** Drag, resize, and reassign task bars on the Resource Histogram (edit permission on that page). */
export function canEditHistogramBars(user) {
  return canPageAction(user, 'Resource Histogram', 'edit_bars');
}

/** Delete or remove a training assignment. */
export function canDeleteTrainings(user) {
  return canPageAction(user, 'Trainings', 'delete')
    || canPageAction(user, 'Resource Histogram', 'delete_trainings');
}
