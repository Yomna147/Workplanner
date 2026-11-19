import Modal from './Modal';

export default function AlgorithmSkippedTasksModal({ open, tasks = [], onClose }) {
  const skipped = Array.isArray(tasks) ? tasks : [];

  return (
    <Modal open={open} title="Tasks skipped by algorithm" onClose={onClose} size="wide">
      <p className="algorithm-skipped-intro">
        {skipped.length === 1
          ? '1 task was not processed because it is missing required data or does not match a known NRM section.'
          : `${skipped.length} tasks were not processed because they are missing required data or do not match a known NRM section.`}
      </p>
      <div className="algorithm-skipped-table-wrap">
        <table className="algorithm-skipped-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Task</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {skipped.map((task) => (
              <tr key={`${task.id ?? 'task'}-${task.task_name}-${task.reason}`}>
                <td>{task.project_name || '—'}</td>
                <td>{task.task_name || '—'}</td>
                <td>{task.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          OK
        </button>
      </div>
    </Modal>
  );
}
