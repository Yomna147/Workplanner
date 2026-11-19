import Modal from '../Modal';

function formatHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) {
    return '—';
  }
  return `${hours.toFixed(1)} h`;
}

export default function HistogramCollisionModal({ open, onClose, report }) {
  const collisionDays = report?.collisionDays ?? [];
  const tasksByBar = report?.tasksByBar ?? [];
  const summary = report?.summary ?? { dayCount: 0, taskCount: 0, operativeCount: 0 };

  return (
    <Modal open={open} title="Task bar collisions" onClose={onClose} size="wide">
      {collisionDays.length === 0 ? (
        <p className="muted histogram-collision-empty">
          No collision days in the current range. A collision is when one operative has two or more
          task bars with planned hours on the same weekday.
        </p>
      ) : (
        <div className="histogram-collision-modal">
          <p className="histogram-collision-summary">
            {summary.dayCount} collision day{summary.dayCount === 1 ? '' : 's'}
            {' · '}
            {summary.taskCount} task bar{summary.taskCount === 1 ? '' : 's'}
            {' · '}
            {summary.operativeCount} operative{summary.operativeCount === 1 ? '' : 's'}
          </p>

          <section className="histogram-collision-section">
            <h4>By operative and day</h4>
            <div className="histogram-collision-table-wrap">
              <table className="histogram-collision-table">
                <thead>
                  <tr>
                    <th>Operative</th>
                    <th>Day</th>
                    <th>Day AVA</th>
                    <th>Booked</th>
                    <th>Task</th>
                    <th>Project</th>
                    <th>Hrs</th>
                    <th>Share</th>
                    <th>Bar band</th>
                  </tr>
                </thead>
                <tbody>
                  {collisionDays.flatMap((collisionDay) =>
                    collisionDay.tasks.map((task, taskIndex) => (
                      <tr key={`${collisionDay.key}-${task.barId}`}>
                        {taskIndex === 0 && (
                          <>
                            <td rowSpan={collisionDay.tasks.length}>
                              <strong>{collisionDay.employee}</strong>
                              {collisionDay.team && (
                                <span className="histogram-collision-team">{collisionDay.team}</span>
                              )}
                            </td>
                            <td rowSpan={collisionDay.tasks.length}>{collisionDay.dayLabel}</td>
                            <td rowSpan={collisionDay.tasks.length}>
                              {collisionDay.dayAvaHours != null
                                ? formatHours(collisionDay.dayAvaHours)
                                : '—'}
                            </td>
                            <td rowSpan={collisionDay.tasks.length}>
                              {formatHours(collisionDay.dayBookedHours)}
                              {collisionDay.dayAvaHours != null
                                && collisionDay.dayBookedHours > collisionDay.dayAvaHours + 0.05 && (
                                <span className="histogram-collision-capacity">
                                  {' '}
                                  (over by {formatHours(collisionDay.dayBookedHours - collisionDay.dayAvaHours)})
                                </span>
                              )}
                            </td>
                          </>
                        )}
                        <td>
                          <span
                            className="histogram-collision-swatch"
                            style={{ background: task.color || '#94a3b8' }}
                            aria-hidden="true"
                          />
                          {task.taskName}
                          {task.nrmNumber && (
                            <span className="histogram-collision-nrm"> ({task.nrmNumber})</span>
                          )}
                        </td>
                        <td>
                          {task.projectName}
                          {task.partName ? ` / ${task.partName}` : ''}
                        </td>
                        <td>{formatHours(task.hoursOnDay)}</td>
                        <td>{task.sharePercent}%</td>
                        <td>{task.bandLabel}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="histogram-collision-section">
            <h4>By task bar</h4>
            <div className="histogram-collision-table-wrap">
              <table className="histogram-collision-table">
                <thead>
                  <tr>
                    <th>Task bar</th>
                    <th>Operative</th>
                    <th>Project</th>
                    <th>Collision day</th>
                    <th>Hrs that day</th>
                    <th>Shared with</th>
                    <th>Bar band</th>
                  </tr>
                </thead>
                <tbody>
                  {tasksByBar.flatMap((taskBar) =>
                    taskBar.collisionDays.map((dayEntry, dayIndex) => (
                      <tr key={`${taskBar.barId}-${dayEntry.day}`}>
                        {dayIndex === 0 && (
                          <>
                            <td rowSpan={taskBar.collisionDays.length}>
                              <span
                                className="histogram-collision-swatch"
                                style={{ background: taskBar.color || '#94a3b8' }}
                                aria-hidden="true"
                              />
                              {taskBar.taskName}
                              {taskBar.nrmNumber && (
                                <span className="histogram-collision-nrm"> ({taskBar.nrmNumber})</span>
                              )}
                            </td>
                            <td rowSpan={taskBar.collisionDays.length}>
                              <strong>{taskBar.employee}</strong>
                              {taskBar.team && (
                                <span className="histogram-collision-team">{taskBar.team}</span>
                              )}
                            </td>
                            <td rowSpan={taskBar.collisionDays.length}>
                              {taskBar.projectName}
                              {taskBar.partName ? ` / ${taskBar.partName}` : ''}
                            </td>
                          </>
                        )}
                        <td>{dayEntry.dayLabel}</td>
                        <td>{formatHours(dayEntry.hoursOnDay)}</td>
                        <td>
                          {dayEntry.sharedWith} tasks
                          {dayEntry.dayAvaHours != null
                            ? ` · ${formatHours(dayEntry.dayAvaHours)} AVA`
                            : ''}
                          {dayEntry.dayBookedHours > 0.05
                            ? ` · ${formatHours(dayEntry.dayBookedHours)} booked`
                            : ''}
                        </td>
                        <td>{dayEntry.bandLabel}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
