import { navMenus } from '../constants/navMenus';

export function getBreadcrumbs(pathname) {
  for (const menu of navMenus) {
    for (const item of menu.items) {
      if (!item.to || item.disabled) continue;

      const matches =
        item.to === '/'
          ? pathname === '/'
          : pathname === item.to || pathname.startsWith(`${item.to}/`);

      if (matches) {
        return [
          { label: menu.label },
          { label: item.label, to: item.to },
        ];
      }
    }
  }

  return [];
}
