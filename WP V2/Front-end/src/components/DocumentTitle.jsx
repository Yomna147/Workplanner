import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { APP_NAME, formatPageTitle, getRouteTitle } from '../constants/routeTitles';

export default function DocumentTitle() {
  const { pathname } = useLocation();

  useEffect(() => {
    const routeTitle = getRouteTitle(pathname);
    document.title = routeTitle ? formatPageTitle(routeTitle) : APP_NAME;
  }, [pathname]);

  return null;
}
