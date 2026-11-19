import { createPortal } from 'react-dom';
import { contrastTextForBackground } from '../../utils/colorContrast';

export default function HistogramBarDragTooltip({
  tooltip,
  reassigning = false,
  blocked = false,
}) {
  if (!tooltip) {
    return null;
  }

  const isBlocked = Boolean(blocked || tooltip.blocked || tooltip.blockReason);
  const isReassign = Boolean(
    !isBlocked && (reassigning || tooltip.reassigning || tooltip.reassignTo),
  );
  const hasCard = Boolean(
    tooltip.title
    || tooltip.when
    || tooltip.summary
    || tooltip.operative
    || tooltip.blockReason,
  );
  if (!hasCard && !tooltip.text) {
    return null;
  }

  const accent = tooltip.color
    || (isBlocked ? '#ef4444' : (isReassign ? '#22c55e' : '#38bdf8'));
  const textColor = contrastTextForBackground(accent);

  return createPortal(
    <div
      className={`histogram-bar-edit-tooltip${isReassign ? ' is-reassign' : ''}${isBlocked ? ' is-blocked' : ''}`}
      style={{
        left: tooltip.x + 14,
        top: tooltip.y + 14,
        borderColor: accent,
        backgroundColor: accent,
        color: textColor,
      }}
      role="tooltip"
    >
      {hasCard ? (
        <>
          <div className="histogram-bar-edit-tooltip-title" style={{ color: textColor }}>
            {tooltip.title || 'Task'}
          </div>
          {tooltip.operative ? (
            <div className="histogram-bar-edit-tooltip-meta" style={{ color: textColor, opacity: 0.88 }}>
              {tooltip.operative}
            </div>
          ) : null}
          {tooltip.when ? (
            <div className="histogram-bar-edit-tooltip-meta" style={{ color: textColor, opacity: 0.88 }}>
              {tooltip.when}
            </div>
          ) : null}
          {tooltip.summary ? (
            <div className="histogram-bar-edit-tooltip-meta is-emphasis" style={{ color: textColor }}>
              {tooltip.summary}
            </div>
          ) : null}
          {tooltip.reassignTo ? (
            <div className="histogram-bar-edit-tooltip-hint" style={{ color: textColor }}>
              Reassign to
              {' '}
              {tooltip.reassignTo}
            </div>
          ) : null}
          {tooltip.blockReason ? (
            <div className="histogram-bar-edit-tooltip-hint is-blocked" style={{ color: textColor }}>
              {tooltip.blockReason}
            </div>
          ) : null}
        </>
      ) : (
        <div className="histogram-bar-edit-tooltip-title" style={{ color: textColor }}>
          {tooltip.text}
        </div>
      )}
    </div>,
    document.body,
  );
}
