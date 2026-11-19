import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import {
  formatTaskSyncValue,
  getTaskFieldLabel,
  overlapChoiceLabel,
  overlapTypeLabel,
} from '../utils/taskSync';

function defaultChoices(overlaps) {
  const next = {};
  (overlaps ?? []).forEach((item) => {
    if (item?.id != null) {
      next[String(item.id)] = 'server';
    }
  });
  return next;
}

export default function TaskSyncConflictModal({
  open,
  conflict,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const overlaps = Array.isArray(conflict?.overlaps) ? conflict.overlaps : [];
  const preserved = Array.isArray(conflict?.preserved) ? conflict.preserved : [];
  const [choices, setChoices] = useState(() => defaultChoices(overlaps));

  useEffect(() => {
    if (open) {
      setChoices(defaultChoices(overlaps));
    }
  }, [open, conflict]);

  const selectedCount = useMemo(
    () => Object.values(choices).filter((value) => value === 'client').length,
    [choices],
  );

  const setAll = (value) => {
    const next = {};
    overlaps.forEach((item) => {
      next[String(item.id)] = value;
    });
    setChoices(next);
  };

  const handleConfirm = () => {
    onConfirm?.(choices);
  };

  return (
    <Modal
      open={open}
      title="Newer version found"
      onClose={busy ? () => {} : onCancel}
      size="wide"
    >
      <div className="task-sync-conflict-modal">
        <p className="task-sync-conflict-intro">
          Someone else saved this part since you loaded it. Tasks you did not change
          are kept from the newer save. Choose what to do with overlapping edits.
        </p>

        {preserved.length > 0 ? (
          <div className="task-sync-conflict-preserved">
            <strong>
              {preserved.length} task{preserved.length === 1 ? '' : 's'} added in the
              newer save will be kept
            </strong>
            <ul>
              {preserved.map((task) => (
                <li key={task.id}>{task.task_name || `Task #${task.id}`}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {overlaps.length > 0 ? (
          <>
            <div className="task-sync-conflict-bulk">
              <button type="button" className="btn btn-secondary btn-compact" onClick={() => setAll('server')} disabled={busy}>
                Ignore all (keep saved)
              </button>
              <button type="button" className="btn btn-secondary btn-compact" onClick={() => setAll('client')} disabled={busy}>
                Save all mine
              </button>
            </div>

            <ul className="task-sync-conflict-list">
              {overlaps.map((item) => {
                const key = String(item.id);
                const choice = choices[key] || 'server';
                const fields = Object.entries(item.changed_fields ?? {});

                return (
                  <li key={key} className="task-sync-conflict-item">
                    <div className="task-sync-conflict-item-header">
                      <strong>{item.task_name || `Task #${item.id}`}</strong>
                      <span>{overlapTypeLabel(item.type)}</span>
                    </div>

                    {fields.length > 0 ? (
                      <table className="task-sync-conflict-fields">
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Yours</th>
                            <th>Saved version</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fields.map(([field, values]) => (
                            <tr key={field}>
                              <td>{getTaskFieldLabel(field)}</td>
                              <td>{formatTaskSyncValue(values?.yours)}</td>
                              <td>{formatTaskSyncValue(values?.saved)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}

                    <div className="task-sync-conflict-choices" role="radiogroup" aria-label={`Resolve ${item.task_name || item.id}`}>
                      {['server', 'client'].map((value) => (
                        <label key={value}>
                          <input
                            type="radio"
                            name={`task-sync-${key}`}
                            value={value}
                            checked={choice === value}
                            disabled={busy}
                            onChange={() => {
                              setChoices((current) => ({ ...current, [key]: value }));
                            }}
                          />
                          {overlapChoiceLabel(item.type, value)}
                        </label>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleConfirm} disabled={busy || overlaps.length === 0}>
            {busy
              ? 'Saving...'
              : selectedCount > 0
                ? `Save ${selectedCount} selected`
                : 'Keep saved versions'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
