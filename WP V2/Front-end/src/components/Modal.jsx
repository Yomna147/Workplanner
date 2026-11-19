import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export default function Modal({
  open,
  title,
  subtitle = null,
  onClose,
  children,
  footer = null,
  size = 'default',
  overlayClassName = '',
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className={`modal-overlay${overlayClassName ? ` ${overlayClassName}` : ''}`}
      onDoubleClick={onClose}
      role="presentation"
    >
      <div
        className={[
          'modal-card',
          size === 'wide' ? 'modal-card-wide' : '',
          size === 'xwide' ? 'modal-card-xwide' : '',
          size === 'fullscreen' ? 'modal-card-fullscreen' : '',
          size === 'compact' ? 'modal-card-compact' : '',
        ].filter(Boolean).join(' ')}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className={`modal-header${subtitle ? ' modal-header--with-subtitle' : ''}`}>
          <div className="modal-header-copy">
            <h3 id="modal-title">{title}</h3>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
