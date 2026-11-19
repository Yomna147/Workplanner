import { useEffect, useState } from 'react';

/** Phone-width breakpoint shared with the `@media (max-width: 640px)` blocks in index.css. */
export const MOBILE_MEDIA_QUERY = '(max-width: 640px)';

function matchesMobile() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(MOBILE_MEDIA_QUERY).matches);
}

/** True while the viewport is phone-sized; updates on resize / rotation. */
export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(matchesMobile);

  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_MEDIA_QUERY);
    if (!query) {
      return undefined;
    }
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return isMobile;
}
