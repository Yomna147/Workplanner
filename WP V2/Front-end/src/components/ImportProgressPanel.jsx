function StepIcon({ status }) {
  if (status === 'done') {
    return <span className="import-progress-step-icon import-progress-step-icon-done" aria-hidden>✓</span>;
  }
  if (status === 'error') {
    return <span className="import-progress-step-icon import-progress-step-icon-error" aria-hidden>!</span>;
  }
  if (status === 'running') {
    return <span className="import-progress-step-spinner" aria-hidden />;
  }

  return <span className="import-progress-step-icon import-progress-step-icon-pending" aria-hidden>•</span>;
}

export default function ImportProgressPanel({
  open,
  title = 'Scheduled import',
  steps = [],
  status = 'idle',
  summary = '',
  error = '',
  onDismiss,
}) {
  if (!open) {
    return null;
  }

  const isRunning = status === 'running';
  const isDone = status === 'done';
  const isError = status === 'error';

  return (
    <div className="import-progress-panel" role="status" aria-live="polite">
      <div className="import-progress-panel-header">
        <div>
          <strong>{title}</strong>
          {isRunning && <p className="import-progress-panel-subtitle">Import in progress…</p>}
          {isDone && <p className="import-progress-panel-subtitle import-progress-panel-subtitle-success">Completed</p>}
          {isError && <p className="import-progress-panel-subtitle import-progress-panel-subtitle-error">Failed</p>}
        </div>
        {!isRunning && (
          <button
            type="button"
            className="import-progress-panel-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss import status"
          >
            ×
          </button>
        )}
      </div>

      <ul className="import-progress-steps">
        {steps.map((step) => (
          <li
            key={step.label}
            className={`import-progress-step import-progress-step-${step.status}`}
          >
            <StepIcon status={step.status} />
            <div className="import-progress-step-copy">
              <span>{step.label}</span>
              {step.detail ? <small>{step.detail}</small> : null}
            </div>
          </li>
        ))}
      </ul>

      {summary ? <p className="import-progress-summary">{summary}</p> : null}
      {error ? <p className="import-progress-error">{error}</p> : null}
    </div>
  );
}
