import { useEffect } from 'react';

export default function AlgorithmRunningOverlay({
  open,
  progress = 0,
  stage = '',
  processedProjects = 0,
  totalProjects = 0,
  processedTasks = 0,
  totalTasks = 0,
  title = 'Running algorithm…',
  message = 'Scheduling tasks and assigning operatives. Please wait.',
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const clampedProgress = Math.min(100, Math.max(0, Math.round(progress)));
  const statusText = stage || message;
  const taskTotal = totalTasks > 0 ? totalTasks : totalProjects;
  const taskProcessed = processedTasks > 0 || totalTasks > 0 ? processedTasks : processedProjects;
  const showTaskCount = taskTotal > 0;

  return (
    <div
      className="algorithm-running-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="algorithm-running-title"
      aria-describedby="algorithm-running-desc"
      aria-busy="true"
    >
      <div className="algorithm-running-card">
        <div className="algorithm-running-spinner" aria-hidden="true" />
        <h2 id="algorithm-running-title" className="algorithm-running-title">
          {title}
        </h2>
        <p id="algorithm-running-desc" className="algorithm-running-message">
          {statusText}
        </p>
        {showTaskCount ? (
          <p className="algorithm-running-message algorithm-running-project-count">
            Tasks processed: {taskProcessed} / {taskTotal}
          </p>
        ) : null}
        <div className="algorithm-running-progress" aria-hidden="true">
          <div className="algorithm-running-progress-label">
            <span>Progress</span>
            <span>{clampedProgress}%</span>
          </div>
          <div className="algorithm-running-progress-track">
            <div
              className="algorithm-running-progress-fill"
              style={{ width: `${clampedProgress}%` }}
            />
          </div>
        </div>
        <div
          className="visually-hidden"
          role="progressbar"
          aria-valuenow={clampedProgress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={statusText}
        />
      </div>
    </div>
  );
}
