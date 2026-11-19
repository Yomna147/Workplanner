import { useEffect } from 'react';
import { formatPageTitle } from '../constants/routeTitles';

/** Override the route-based tab title when a page heading changes dynamically. */
export default function usePageTitle(title) {
  useEffect(() => {
    document.title = formatPageTitle(title);
  }, [title]);
}
