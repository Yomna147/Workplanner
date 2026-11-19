/**
 * Browser / OS Notification helpers.
 * Prefers Service Worker showNotification (more reliable on Windows Chrome).
 */

const NOTIFY_SW_URL = '/wp-notify-sw.js';
const NOTIFY_SW_SCOPE = '/';

let swRegisterPromise = null;

function absoluteAssetUrl(path) {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path) || String(path).startsWith('data:')) return path;
  if (typeof window === 'undefined' || !window.location?.origin) return path;
  return new URL(path, window.location.origin).href;
}

/** WP brand logo — high-res square asset for Windows Action Center. */
export function getTtNotifyIconUrl() {
  return absoluteAssetUrl('/wp-notify-logo.png')
    || absoluteAssetUrl('/wp-logo.png')
    || absoluteAssetUrl('/favicon.png');
}

/** Large clear brand mark for rich notification image slot. */
export function getWpLogoUrl() {
  return absoluteAssetUrl('/wp-logo.png')
    || absoluteAssetUrl('/wp-notify-logo.png')
    || absoluteAssetUrl('/favicon.png');
}

export function browserNotificationsSupported() {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
}

export function getBrowserNotificationPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  return Notification.permission;
}

/** Ask once if still default; safe to call repeatedly. Must run from a user gesture in Chrome. */
export async function ensureBrowserNotificationPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';

  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function ensureNotifyServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  if (!swRegisterPromise) {
    swRegisterPromise = navigator.serviceWorker
      .register(NOTIFY_SW_URL, { scope: NOTIFY_SW_SCOPE })
      .then(async (registration) => {
        // Force update so style/action changes apply without hard refresh.
        try {
          await registration.update();
        } catch {
          // ignore
        }
        await navigator.serviceWorker.ready;
        return registration;
      })
      .catch((error) => {
        console.warn('[Notify] Service worker registration failed.', error);
        swRegisterPromise = null;
        return null;
      });
  }

  return swRegisterPromise;
}

/**
 * Show a system notification (Action Center / OS banner).
 * Uses SW when available; falls back to window Notification.
 */
export async function showBrowserNotification({
  title,
  body = '',
  tag = 'workplanner-notify',
  requireInteraction = false,
  icon = null,
  badge = '/wp-notify-logo.png',
  image = null,
  url = '/projects?newProject=1',
  actions = null,
} = {}) {
  if (!browserNotificationsSupported()) return null;
  if (Notification.permission !== 'granted') return null;
  if (!title) return null;

  const options = {
    body,
    tag,
    renotify: true,
    requireInteraction,
    silent: false,
    icon: absoluteAssetUrl(icon || getTtNotifyIconUrl()),
    badge: absoluteAssetUrl(badge || getTtNotifyIconUrl()),
    data: {
      url,
      source: 'workplanner',
      createdAt: Date.now(),
    },
  };

  if (image) {
    options.image = absoluteAssetUrl(image);
  }

  // Chrome supports action buttons on OS notifications.
  if (Array.isArray(actions) && actions.length) {
    options.actions = actions.slice(0, 2);
  }

  try {
    const registration = await ensureNotifyServiceWorker();
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return { via: 'service-worker' };
    }
  } catch (error) {
    console.warn('[Notify] SW notification failed, falling back.', error);
  }

  try {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      try {
        window.focus();
        if (url) {
          window.location.assign(url);
        }
        notification.close();
      } catch {
        // ignore
      }
    };
    if (!requireInteraction) {
      window.setTimeout(() => {
        try {
          notification.close();
        } catch {
          // ignore
        }
      }, 12000);
    }
    return { via: 'window', notification };
  } catch (error) {
    console.warn('[Notify] Browser notification failed.', error);
    return null;
  }
}
