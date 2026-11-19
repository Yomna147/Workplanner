import { useEffect, useState } from 'react';
import Modal from './Modal';

export default function TrainingOccupiedSlotModal({
  open,
  phase = 'confirm',
  conflicts = [],
  busy = false,
  successMessage = 'Training schedule saved.',
  onCancel,
  onConfirm,
}) {
  const [confirmed, setConfirmed] = useState(false);
  const items = Array.isArray(conflicts) ? conflicts : [];
  const isConfirmPhase = phase === 'confirm';
  const isSavingPhase = phase === 'saving';
  const isSavedPhase = phase === 'saved';
  const hasTrainingConflict = items.some((entry) => entry?.kind === 'training');
  const hasProjectConflict = items.some((entry) => entry?.kind === 'project');
  const hasSegmentConflict = items.some((entry) => (
    entry?.segmentConflict || entry?.segment_conflict
  ));

  const title = isSavingPhase
    ? 'Saving training'
    : isSavedPhase
      ? 'Saved'
      : 'Confirm scheduling override';

  useEffect(() => {
    if (open && isConfirmPhase) {
      setConfirmed(false);
    }
  }, [open, conflicts, isConfirmPhase]);

  let intro = 'This operative already has planned work on the selected date(s). Confirm to continue.';
  if (hasTrainingConflict && hasProjectConflict) {
    intro = 'This operative already has training and project work on the selected date(s). Confirm override to continue. Project hours may be reduced to make room; existing courses are kept.';
  } else if (hasSegmentConflict) {
    intro = 'The selected day section already has another training. Confirm override to schedule anyway — existing courses are kept (they will share the day).';
  } else if (hasTrainingConflict) {
    intro = 'This operative already has training on the selected date(s). Confirm override to schedule anyway — existing courses are kept.';
  } else if (hasProjectConflict) {
    intro = 'This operative already has planned project work on the selected date(s). Confirm override to continue. Project hours on those days are reduced to make room for training — project tasks are kept, not deleted.';
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={isConfirmPhase && !busy ? onCancel : () => {}}
      size="compact"
      overlayClassName="training-occupied-slot-overlay"
    >
      {isSavingPhase ? (
        <div className="training-occupied-slot-modal training-occupied-slot-modal--status">
          <div className="training-occupied-slot-status-card" role="status" aria-live="polite">
            <span className="training-occupied-slot-spinner" aria-hidden="true" />
            <p>Saving training schedule…</p>
          </div>
        </div>
      ) : null}

      {isSavedPhase ? (
        <div className="training-occupied-slot-modal training-occupied-slot-modal--status">
          <div
            className="training-occupied-slot-status-card training-occupied-slot-status-card--saved"
            role="status"
            aria-live="polite"
          >
            <span className="training-occupied-slot-saved-icon" aria-hidden="true">✓</span>
            <p>{successMessage}</p>
          </div>
        </div>
      ) : null}

      {isConfirmPhase ? (
        <div className="training-occupied-slot-modal">
          <p>{intro}</p>

          {items.length > 0 ? (
            <ul className="training-modal-warnings-list">
              {items.map((warning) => (
                <li key={warning.id || warning.message} className="training-modal-warning-item">
                  <span className="training-modal-warning-icon" aria-hidden="true">!</span>
                  <span>{warning.message}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <label className="training-modal-override">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {hasTrainingConflict
                ? 'I confirm I want to override — schedule this training even though the day/section already has training or project work'
                : 'I confirm I want to override — project hours on those days will be reduced to make room for training'}
            </span>
          </label>

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !confirmed}
              onClick={() => onConfirm?.()}
            >
              Save with override
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
