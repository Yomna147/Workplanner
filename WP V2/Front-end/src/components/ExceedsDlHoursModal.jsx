import Modal from './Modal';

function formatHours(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '0';
  }
  return String(Math.round(num * 100) / 100);
}

function formatBreakdown(task) {
  if (!task.breakdown) {
    return null;
  }

  const parts = [];
  if (task.breakdown.dlSections > 0.001) {
    parts.push(`DL sections ${formatHours(task.breakdown.dlSections)}`);
  }
  if (task.breakdown.rework > 0.001) {
    parts.push(`rework ${formatHours(task.breakdown.rework)}`);
  }
  if (task.breakdown.extra > 0.001) {
    parts.push(`extra ${formatHours(task.breakdown.extra)}`);
  }

  if (parts.length <= 1) {
    return null;
  }

  return `Includes ${parts.join(' · ')}`;
}

export default function ExceedsDlHoursModal({
  open,
  onClose,
  onConfirm,
  busy = false,
  tasks = [],
}) {
  const count = tasks.length;

  return (
    <Modal
      open={open}
      title="Expected hours exceed DL hours"
      onClose={busy ? () => {} : onClose}
      size="compact"
    >
      <div className="exceeds-dl-hours-modal">
        <p>
          {count === 1
            ? '1 task has expected hours greater than the DL Input hours.'
            : `${count} tasks have expected hours greater than the DL Input hours.`}
          {' '}
          Review before saving.
        </p>

        <div className="exceeds-dl-hours-list-wrap">
          <ul className="exceeds-dl-hours-list">
            {tasks.map((task) => {
              const breakdown = formatBreakdown(task);
              return (
                <li key={task.id} className="exceeds-dl-hours-item">
                  <strong>{task.task_name}</strong>
                  {task.part_name ? (
                    <span className="exceeds-dl-hours-part">{task.part_name}</span>
                  ) : null}
                  {task.added_by ? (
                    <span className="exceeds-dl-hours-added-by">
                      Added by
                      {' '}
                      {task.added_by}
                    </span>
                  ) : null}
                  <span className="exceeds-dl-hours-meta">
                    {task.expectedLabel || 'Expected'}
                    {' '}
                    {formatHours(task.expected)}
                    {' '}
                    · DL
                    {' '}
                    {formatHours(task.dl)}
                    {' '}
                    · Over by
                    {' '}
                    {formatHours(task.over)}
                  </span>
                  {breakdown ? (
                    <span className="exceeds-dl-hours-breakdown">{breakdown}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="modal-actions exceeds-dl-hours-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save anyway'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
