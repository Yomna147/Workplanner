import Modal from './Modal';

const BUTTON_GUIDE = [
  {
    label: 'Cancel',
    description: 'Discard — nothing is saved',
  },
  {
    label: 'Save only',
    description: 'Save as-is, no rescheduling',
  },
  {
    label: 'Save & run algorithm',
    description: 'Save, then auto-optimise the plan',
  },
];

export default function RunAlgorithmAfterSaveModal({
  open,
  onClose,
  onSaveOnly,
  onSaveAndRun,
  busy = false,
  contextLabel = 'changes',
}) {
  return (
    <Modal
      open={open}
      title="Run algorithm after saving?"
      onClose={busy ? () => {} : onClose}
      size="compact"
    >
      <div className="run-algo-after-save-modal">
        <p>
          Save your
          {' '}
          {contextLabel}
          {' '}
          now, and choose whether to run the algorithm afterwards.
        </p>
        <ul className="run-algo-after-save-button-guide" aria-label="Button descriptions">
          {BUTTON_GUIDE.map((item) => (
            <li key={item.label}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </li>
          ))}
        </ul>
        <div className="modal-actions run-algo-after-save-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
            title="Discard — nothing is saved"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onSaveOnly}
            disabled={busy}
            title="Save as-is, no rescheduling"
          >
            Save only
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSaveAndRun}
            disabled={busy}
            title="Save, then auto-optimise the plan"
          >
            Save &amp; run algorithm
          </button>
        </div>
      </div>
    </Modal>
  );
}
