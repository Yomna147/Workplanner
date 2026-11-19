export const GAP_NOTIFY_DISMISS_KEY = 'wp2_training_gap_notify_dismissed';
export const GAP_NOTIFY_TOAST_RANGES_KEY = 'wp2_training_gap_toast_dismissed_ranges';
export const GAP_NOTIFY_READ_IDS_KEY = 'wp2_training_gap_notify_read_ids';
export const GAP_NOTIFY_READ_CHANGED_EVENT = 'wp2-training-gap-notify-read-changed';

/** Session-only dismiss/toast keys — do not wipe per-user read IDs. */
export function clearGapNotificationSessionState() {
  try {
    localStorage.removeItem(GAP_NOTIFY_DISMISS_KEY);
    localStorage.removeItem(GAP_NOTIFY_TOAST_RANGES_KEY);
  } catch {
    // ignore storage failures
  }
}

export function gapNotifyReadIdsStorageKey(userId) {
  const id = userId != null && String(userId).trim() !== '' ? String(userId) : 'anon';
  return `${GAP_NOTIFY_READ_IDS_KEY}:${id}`;
}

export function notifyGapReadStateChanged() {
  try {
    window.dispatchEvent(new CustomEvent(GAP_NOTIFY_READ_CHANGED_EVENT));
  } catch {
    // ignore (SSR / non-DOM)
  }
}

export function subscribeGapReadStateChanged(handler) {
  if (typeof handler !== 'function') {
    return () => {};
  }

  const onCustom = () => handler();
  const onStorage = (event) => {
    if (!event?.key) {
      return;
    }
    if (
      event.key === GAP_NOTIFY_READ_IDS_KEY
      || event.key.startsWith(`${GAP_NOTIFY_READ_IDS_KEY}:`)
    ) {
      handler();
    }
  };

  window.addEventListener(GAP_NOTIFY_READ_CHANGED_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(GAP_NOTIFY_READ_CHANGED_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
