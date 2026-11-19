import Modal from './Modal';

function DeleteConfirmIcon() {
  return (
    <svg
      className="delete-confirm-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
      />
    </svg>
  );
}

export default function DeleteConfirmModal({
  open,
  title,
  message,
  details = [],
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onClose,
  onConfirm,
  busy = false,
  warning,
}) {
  const visibleDetails = Array.isArray(details)
    ? details.filter((item) => item?.label && item?.value)
    : [];

  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? () => {} : onClose}
      size="compact"
    >
      <div className="delete-confirm-modal delete-confirm-modal--pro">
        <div className="delete-confirm-lead">
          <div className="delete-confirm-icon-wrap" aria-hidden="true">
            <DeleteConfirmIcon />
          </div>
          <p className="delete-confirm-message">{message}</p>
        </div>

        {visibleDetails.length > 0 ? (
          <dl className="delete-confirm-details">
            {visibleDetails.map((item) => (
              <div key={item.label} className="delete-confirm-detail-row">
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {warning ? (
          <p className="delete-confirm-warning" role="note">
            {warning}
          </p>
        ) : null}

        <div className="modal-actions delete-confirm-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy
              ? (String(confirmLabel).toLowerCase().includes('remove') ? 'Removing...' : 'Deleting...')
              : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
