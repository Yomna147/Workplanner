import { useEffect, useMemo, useState } from 'react';
import { formatCompactDisplayDate } from '../utils/dateFormat';
import Modal from './Modal';
import DlQuickUpdateList from './DlQuickUpdateList';

function buildSubtitle(meta) {
  if (!meta) {
    return 'Review last week, this week, and next week — then save or continue.';
  }

  const rangeStart = formatCompactDisplayDate(meta.rangeStart);
  const rangeEnd = formatCompactDisplayDate(meta.rangeEnd);
  const rangeLabel = rangeStart && rangeEnd ? `${rangeStart} – ${rangeEnd}` : null;
  const projectLabel = meta.projectCount === 1
    ? '1 project'
    : `${meta.projectCount} projects`;
  const taskLabel = meta.taskCount === 1
    ? '1 task'
    : `${meta.taskCount} tasks`;
  const statusLabel = meta.updateStatus
    ? ` · ${meta.updateStatus}`
    : '';

  if (rangeLabel) {
    return `${rangeLabel} · ${projectLabel} · ${taskLabel}${statusLabel}`;
  }

  return `${projectLabel} · ${taskLabel}${statusLabel}`;
}

export default function DlWeeklyProjectsConfirmModal({
  open,
  onDismiss,
}) {
  const [meta, setMeta] = useState(null);
  const subtitle = useMemo(() => buildSubtitle(meta), [meta]);

  useEffect(() => {
    if (!open) {
      setMeta(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title="Confirm project status"
      subtitle={subtitle}
      onClose={onDismiss}
      size="xwide"
      footer={(
        <div className="dl-weekly-confirm-footer">
          <p className="dl-weekly-confirm-footer-hint muted">
            Changes save from the toolbar above. You can reopen this any time from DL Input Hours.
          </p>
          <div className="dl-weekly-confirm-footer-actions">
            <button type="button" className="btn btn-secondary" onClick={onDismiss}>
              I&apos;ll review later
            </button>
            <button type="button" className="btn btn-primary" onClick={onDismiss}>
              Done
            </button>
          </div>
        </div>
      )}
    >
      <div className="dl-weekly-confirm-modal">
        <DlQuickUpdateList
          compact
          hideHeading
          className="dl-weekly-confirm-quick-update"
          onNavigate={onDismiss}
          onMeta={setMeta}
        />
      </div>
    </Modal>
  );
}
