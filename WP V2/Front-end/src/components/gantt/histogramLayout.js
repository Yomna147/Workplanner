export const HISTOGRAM_LABEL_WIDTH = 158;
export const HISTOGRAM_DAY_WIDTH = 56;
/** Narrower width for Sat/Sun columns so weekdays use more of the viewport. */
export const HISTOGRAM_WEEKEND_DAY_WIDTH = 24;
/** Maximum days shown in the histogram (~3 calendar months). */
export const HISTOGRAM_MAX_VIEW_DAYS = 90;
export const HISTOGRAM_GANTT_ROW_HEIGHT = 24;
export const HISTOGRAM_HEADER_MONTH_ROW_HEIGHT = 20;
export const HISTOGRAM_HEADER_DAY_ROW_HEIGHT = 22;
export const HISTOGRAM_HEADER_ROW_HEIGHT =
  HISTOGRAM_HEADER_MONTH_ROW_HEIGHT + HISTOGRAM_HEADER_DAY_ROW_HEIGHT;
export const HISTOGRAM_TEAM_ROW_HEIGHT = 28;
export const HISTOGRAM_HOURS_ROW_HEIGHT = 16;
export const HISTOGRAM_FLAG_SIZE = 27;
/** Vertical splits per calendar day column (e.g. 4 × 2h bands). */
export const HISTOGRAM_DAY_PARTITIONS = 4;
/** When true, shared-day bars use capacity-proportional bands (not forced full-column width). */
export const HISTOGRAM_FIXED_DAY_PARTITIONS = true;
/** Default work-day length when no per-day availability is set (matches v1 histogram). */
export const HISTOGRAM_DEFAULT_WORK_DAY_HOURS = 8;
/** Single-day task bars always show the full task name (not NRM-only). */
export const HISTOGRAM_COMPACT_LABEL_MAX_SPAN_DAYS = 1;
/** Minimum task bar width (px) to show the NRM label horizontally. */
export const HISTOGRAM_BAR_LABEL_MIN_HORIZONTAL_PX = 22;
/** Minimum task bar width (px) to show the NRM label vertically. */
export const HISTOGRAM_BAR_LABEL_MIN_VERTICAL_PX = 14;
/** Position task bars in proportional day bands when multiple tasks share a day. */
export const HISTOGRAM_DAY_SPLIT_BANDS_ENABLED = true;
