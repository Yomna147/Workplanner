import Modal from './Modal';

function formatHours(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return '0';
  }
  return String(Math.round(num * 10) / 10);
}

export default function DlTraineeHoursExceededModal({
  open,
  onClose,
  alerts = [],
  weekRange = null,
}) {
  const count = alerts.length;
  const rangeLabel = weekRange?.start && weekRange?.end
    ? `${weekRange.start} → ${weekRange.end}`
    : 'this week';

  return (
    <Modal
      open={open}
      title="Trainee / junior hours exceeded"
      onClose={onClose}
      size="compact"
    >
      <div className="exceeds-dl-hours-modal">
        <p>
          {count === 1
            ? '1 trainee or junior operative has scheduled hours above their available capacity'
            : `${count} trainee or junior operatives have scheduled hours above their available capacity`}
          {' '}
          for
          {' '}
          {rangeLabel}
          .
        </p>

        <div className="exceeds-dl-hours-list-wrap">
          <ul className="exceeds-dl-hours-list">
            {alerts.map((alert) => (
              <li key={alert.employeeId} className="exceeds-dl-hours-item">
                <strong>{alert.name}</strong>
                <span className="exceeds-dl-hours-meta">
                  Scheduled
                  {' '}
                  {formatHours(alert.bookedHours)}
                  h · Capacity
                  {' '}
                  {formatHours(alert.capacityHours)}
                  h · Over by
                  {' '}
                  {formatHours(alert.overBy)}
                  h
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-actions exceeds-dl-hours-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
          >
            OK
          </button>
        </div>
      </div>
    </Modal>
  );
}
