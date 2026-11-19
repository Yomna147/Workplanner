import { createPortal } from 'react-dom';
import { contrastTextForBackground } from '../../utils/colorContrast';

export default function HistogramBarDragGhost({ ghost }) {
  if (!ghost) {
    return null;
  }

  const accent = ghost.color || '#38bdf8';
  const textColor = contrastTextForBackground(accent);

  return createPortal(
    <div
      className={`histogram-bar-drag-ghost${ghost.reassigning ? ' histogram-bar-drag-ghost--reassign' : ''}${ghost.blocked ? ' histogram-bar-drag-ghost--blocked' : ''}`}
      style={{
        left: ghost.x,
        top: ghost.y,
        width: ghost.width,
        backgroundColor: accent,
        color: textColor,
        transform: 'translate(-50%, -50%)',
      }}
      aria-hidden="true"
    >
      <span className="histogram-bar-drag-ghost-label">{ghost.label}</span>
    </div>,
    document.body,
  );
}
