import Modal from './Modal';

export default function ProjectPriorityWarningModal({
  open,
  warnings = [],
  onConfirm,
  onCancel,
  confirmLabel = 'Continue anyway',
}) {
  const items = Array.isArray(warnings) ? warnings : [];

  return (
    <Modal
      open={open}
      title="Project priority warning"
      onClose={onCancel}
    >
      <div className="project-priority-warning-modal">
        <p className="project-priority-warning-intro">
          Review these priority conflicts before continuing.
        </p>
        <ul className="project-priority-warning-list">
          {items.map((warning, index) => (
            <li key={`${warning.type}-${warning.title}-${index}`} className={`project-priority-warning-item is-${warning.type}`}>
              <strong>{warning.title}</strong>
              <span>{warning.message}</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
