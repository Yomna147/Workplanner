import { STEP_STATUS } from '../utils/timeTracking/loadSteps';

const STATUS_LABEL = {
  [STEP_STATUS.pending]: 'Pending',
  [STEP_STATUS.running]: 'Running…',
  [STEP_STATUS.ok]: 'OK',
  [STEP_STATUS.warn]: 'Warning',
  [STEP_STATUS.error]: 'Failed',
  [STEP_STATUS.skipped]: 'Skipped',
};

function statusClass(status) {
  return `tt-load-step tt-load-step--${status || STEP_STATUS.pending}`;
}

export default function TtLoadStepsPanel({ steps = [], title = 'Load steps' }) {
  if (!steps.length) return null;

  const failed = steps.find((step) => step.status === STEP_STATUS.error);
  const running = steps.find((step) => step.status === STEP_STATUS.running);

  return (
    <div className="tt-load-steps card">
      <div className="tt-load-steps__header">
        <h3 className="tt-load-steps__title">{title}</h3>
        {running ? (
          <span className="tt-load-steps__badge tt-load-steps__badge--running">
            Running:
            {' '}
            {running.label}
          </span>
        ) : null}
        {!running && failed ? (
          <span className="tt-load-steps__badge tt-load-steps__badge--error">
            Failed at:
            {' '}
            {failed.label}
          </span>
        ) : null}
      </div>
      <ol className="tt-load-steps__list">
        {steps.map((step, index) => (
          <li key={step.id} className={statusClass(step.status)}>
            <div className="tt-load-steps__row">
              <span className="tt-load-steps__index">{index + 1}</span>
              <div className="tt-load-steps__body">
                <div className="tt-load-steps__label-row">
                  <strong className="tt-load-steps__label">{step.label}</strong>
                  <span className="tt-load-steps__status">
                    {STATUS_LABEL[step.status] || step.status}
                  </span>
                </div>
                {step.endpoint ? (
                  <div className="tt-load-steps__endpoint">{step.endpoint}</div>
                ) : null}
                {step.detail ? (
                  <div className={`tt-load-steps__detail${step.status === STEP_STATUS.error ? ' tt-load-steps__detail--error' : ''}`}>
                    {step.detail}
                  </div>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
