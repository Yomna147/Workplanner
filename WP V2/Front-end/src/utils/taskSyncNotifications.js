import { globalToastError, globalToastInfo, globalToastSuccess } from './toastBridge';

/**
 * Surface task-sync notification results from the backend.
 * "In-app" today means a toast for the saver listing intended recipient names.
 */
export function showSaveNotifications(notifications) {
  showTaskSyncNotifications({
    info: globalToastInfo,
    success: globalToastSuccess,
    error: globalToastError,
  }, notifications);
}

export function showTaskSyncNotifications(toast, notifications) {
  if (!toast || !notifications) {
    return;
  }

  if (notifications.in_app?.length) {
    const lead = notifications.summary || 'Progress review needed';
    toast.info(`${lead} — notified: ${notifications.in_app.join(', ')}`);
  }

  if (notifications.emails_sent > 0) {
    toast.success(`Email sent for ${notifications.emails_sent} notification rule(s).`);
  }

  if (notifications.email_errors?.length) {
    const first = notifications.email_errors[0];
    const detail = first?.error || 'Unknown mail error';
    const rule = first?.rule ? ` (${first.rule})` : '';
    toast.error(`Email notification failed${rule}: ${detail}`);
  }
}
