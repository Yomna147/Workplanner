import { createPortal } from 'react-dom';
import { barHoursOnDay, dayLabel, totalBarAssignedHours } from './ganttUtils';
import { contrastTextForBackground } from '../../utils/colorContrast';
import { formatDlPlanEditHover } from '../../utils/planActivityLog';

export function buildTaskBarHover(bar, hoveredDay = null, dlPlanEdit = null) {
  if (!bar) {
    return null;
  }

  const totalHours = totalBarAssignedHours(bar);
  const dayHours = hoveredDay ? barHoursOnDay(bar, hoveredDay) : 0;
  const dayDetail = hoveredDay
    ? (dayHours > 0.001
      ? `${dayHours.toFixed(1)}h on ${dayLabel(hoveredDay)}`
      : `No hours on ${dayLabel(hoveredDay)}`)
    : null;

  const color = bar.color || null;

  return {
    title: bar.task_name || 'Untitled task',
    color,
    textColor: contrastTextForBackground(color || '#0f172a'),
    project: bar.project_name || null,
    operative: String(bar.employee || '').trim() || null,
    dayDetail,
    summary: totalHours > 0.001 ? `${totalHours.toFixed(1)}h total` : null,
    dlEdit: formatDlPlanEditHover(dlPlanEdit || bar.dl_plan_edit),
    hint: 'Click for full details',
  };
}

export default function HistogramTaskHoverCard({ hover }) {
  if (!hover?.title) {
    return null;
  }

  const accent = hover.color || '#38bdf8';
  const textColor = hover.textColor || contrastTextForBackground(accent);

  return createPortal(
    <div
      className="histogram-bar-edit-tooltip histogram-task-hover-card"
      style={{
        left: hover.x + 14,
        top: hover.y + 14,
        borderColor: accent,
        backgroundColor: accent,
        color: textColor,
      }}
      role="tooltip"
    >
      <div className="histogram-bar-edit-tooltip-title" style={{ color: textColor }}>
        {hover.title}
      </div>
      {hover.project ? (
        <div className="histogram-bar-edit-tooltip-meta" style={{ color: textColor, opacity: 0.88 }}>
          {hover.project}
        </div>
      ) : null}
      {hover.operative ? (
        <div className="histogram-bar-edit-tooltip-meta" style={{ color: textColor, opacity: 0.88 }}>
          {hover.operative}
        </div>
      ) : null}
      {hover.dayDetail ? (
        <div className="histogram-bar-edit-tooltip-meta is-emphasis" style={{ color: textColor }}>
          {hover.dayDetail}
        </div>
      ) : null}
      {hover.summary ? (
        <div className="histogram-bar-edit-tooltip-meta" style={{ color: textColor, opacity: 0.88 }}>
          {hover.summary}
        </div>
      ) : null}
      {hover.dlEdit ? (
        <div className="histogram-bar-edit-tooltip-meta is-emphasis" style={{ color: textColor }}>
          {hover.dlEdit}
        </div>
      ) : null}
      {hover.hint ? (
        <div className="histogram-bar-edit-tooltip-hint is-muted" style={{ color: textColor, opacity: 0.75 }}>
          {hover.hint}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
