/** Over-plan warning when Act exceeds Plan by this percentage. */
export const OVER_PLAN_WARN_PCT = 10;

/** Below this manual %, TT import may derive progress from timesheet hours. */
export const TT_DERIVE_THRESHOLD = 50;

/**
 * Legacy UI thresholds / names for local progress helpers.
 * Live email + in-app notice rules are configured in Admin → Email Notifications
 * and evaluated on the backend during task sync.
 */
export const NOTIFY_OPS_THRESHOLD = 80;

/** @deprecated Prefer Admin → Email Notifications rules. */
export const NOTIFY_MGMT_THRESHOLD = 95;

/** @deprecated Email delivery is controlled by backend global + rule settings. */
export const PROGRESS_EMAIL_ENABLED = false;

export const NOTIFY_OPS_NAMES = ["Rauno", "Yomna"];
export const NOTIFY_MGMT_NAMES = ["Mayar", "A"];
