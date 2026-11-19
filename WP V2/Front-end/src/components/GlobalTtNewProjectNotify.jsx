import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  browserNotificationsSupported,
  ensureBrowserNotificationPermission,
  ensureNotifyServiceWorker,
  getBrowserNotificationPermission,
  showBrowserNotification,
} from '../utils/browserNotify';
import { announceTtNewProjects } from '../utils/ttNewProjectAnnounce';
import { fetchFreshTtNewProjects } from '../utils/ttNewProjectNotify';
import { canViewPage } from '../utils/userPermissions';

const TT_NEW_PROJECT_POLL_MS = 5 * 60 * 1000;
const PERMISSION_BANNER_DISMISS_KEY = 'wp2_tt_desktop_notify_banner_dismissed';

/**
 * On login (and every 5 minutes while logged in), freshly compares Time Tracking
 * projects to Work Planner and announces newly seen TT projects in-app + OS notify.
 *
 * Desktop notifications need an explicit Allow click in external browsers.
 */
export default function GlobalTtNewProjectNotify() {
  const { user, loading } = useAuth();
  const toast = useToast();
  const runningRef = useRef(false);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [permission, setPermission] = useState(() => getBrowserNotificationPermission());
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try {
      return localStorage.getItem(PERMISSION_BANNER_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [enabling, setEnabling] = useState(false);

  const canNotify = Boolean(user && !loading && canViewPage(user, 'TT Project Hours'));
  const showPermissionBanner = canNotify
    && browserNotificationsSupported()
    && permission !== 'granted'
    && permission !== 'unsupported'
    && !bannerDismissed;

  const runCheck = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const newcomers = await fetchFreshTtNewProjects();
      if (!newcomers.length) return;
      announceTtNewProjects(newcomers, toastRef.current);
    } catch (error) {
      console.warn('[TT] New-project check failed.', error);
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!canNotify) return undefined;

    let cancelled = false;
    ensureNotifyServiceWorker().catch(() => {});

    const tick = async () => {
      if (cancelled) return;
      await runCheck();
    };

    tick();
    const timerId = window.setInterval(tick, TT_NEW_PROJECT_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [canNotify, runCheck]);

  const handleEnableDesktop = async () => {
    setEnabling(true);
    try {
      const next = await ensureBrowserNotificationPermission();
      setPermission(next);

      if (next === 'granted') {
        await ensureNotifyServiceWorker();
        await showBrowserNotification({
          title: 'Work Planner alerts on',
          body: 'You’ll get a Windows banner when a new TT project appears.\nTap any alert to open Create New Project in PDE.',
          tag: `wp2-tt-notify-enabled-${Date.now()}`,
          requireInteraction: true,
          url: '/projects?newProject=1',
          actions: [
            { action: 'open', title: 'Open PDE' },
            { action: 'dismiss', title: 'Dismiss' },
          ],
        });
        toast.success('Desktop notifications enabled for new TT projects.');
        runCheck();
      } else if (next === 'denied') {
        toast.error(
          'Browser blocked notifications. Allow them for this site in the address-bar lock/permissions icon.',
        );
      } else {
        toast.info('Notification permission was not granted yet.');
      }
    } finally {
      setEnabling(false);
    }
  };

  const handleDismissBanner = () => {
    setBannerDismissed(true);
    try {
      localStorage.setItem(PERMISSION_BANNER_DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  };

  if (!showPermissionBanner) {
    return null;
  }

  return (
    <div className="tt-desktop-notify-banner" role="status">
      <div className="tt-desktop-notify-banner-copy">
        <strong>Enable desktop alerts</strong>
        <span>
          Allow notifications so new TT projects appear even when Work Planner is in another tab.
          {permission === 'denied' ? ' Permission is currently blocked for this site.' : ''}
        </span>
      </div>
      <div className="tt-desktop-notify-banner-actions">
        {permission !== 'denied' ? (
          <button
            type="button"
            className="btn btn-save btn-compact"
            onClick={handleEnableDesktop}
            disabled={enabling}
          >
            {enabling ? 'Enabling…' : 'Allow desktop alerts'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-compact"
            onClick={handleEnableDesktop}
            disabled={enabling}
            title="Opens the browser permission prompt if available"
          >
            Try again
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-compact"
          onClick={handleDismissBanner}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
