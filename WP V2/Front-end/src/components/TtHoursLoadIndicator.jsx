import { createPortal } from 'react-dom';

export default function TtHoursLoadIndicator({
  visible = false,
  message = 'Loading…',
  detail = '',
  percent = null,
}) {
  if (!visible) return null;

  return createPortal(
    <div className="tt-hours-load-indicator" role="status" aria-live="polite" aria-busy="true">
      <div className="tt-hours-load-indicator__header">
        <span className="tt-hours-load-indicator__spinner" aria-hidden="true" />
        <div className="tt-hours-load-indicator__copy">
          <p className="tt-hours-load-indicator__message">{message}</p>
          {detail ? <p className="tt-hours-load-indicator__detail">{detail}</p> : null}
        </div>
      </div>
      {Number.isFinite(percent) ? (
        <div className="tt-hours-load-indicator__bar" aria-hidden="true">
          <div
            className="tt-hours-load-indicator__bar-fill"
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
