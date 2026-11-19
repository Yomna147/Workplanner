import { navMenus } from '../constants/navMenus';

/** Legacy capability page kept in the database but hidden from role permissions UI. */
export const HIDDEN_PERMISSION_PAGES = [
  'Notifications',
];

/** Page permission names for routes that are live in the app (nav items with a page, not disabled). */
export function getActivePermissionPageNames() {
  const names = [];
  const seen = new Set();

  navMenus.forEach((menu) => {
    menu.items.forEach((item) => {
      if (item.disabled || !item.page) {
        return;
      }
      if (seen.has(item.page)) {
        return;
      }
      seen.add(item.page);
      names.push(item.page);
    });
  });

  return names;
}

export function isActivePermissionPage(pageName) {
  return getActivePermissionPageNames().includes(String(pageName || '').trim());
}

export function filterActivePermissionPages(pages = []) {
  const activeNames = new Set(getActivePermissionPageNames());
  const hiddenNames = new Set(HIDDEN_PERMISSION_PAGES);
  return (pages || []).filter((page) => activeNames.has(page.name) && !hiddenNames.has(page.name));
}

export function sortActivePermissionPages(pages = []) {
  const order = getActivePermissionPageNames();
  const rank = new Map(order.map((name, index) => [name, index]));

  return [...pages].sort((left, right) => {
    const leftRank = rank.get(left.name) ?? 999;
    const rightRank = rank.get(right.name) ?? 999;
    return leftRank - rightRank || String(left.name).localeCompare(String(right.name));
  });
}

export function prepareActivePermissionPages(pages = []) {
  return sortActivePermissionPages(filterActivePermissionPages(pages));
}
