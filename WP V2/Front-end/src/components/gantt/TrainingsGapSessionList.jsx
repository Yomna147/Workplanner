import { memo } from 'react';
import { formatTrainingSessionLabel } from '../../utils/trainingGroups';

export default memo(function TrainingsGapSessionList({
  groups = [],
  activeSessionKey = '',
  onSessionClick,
}) {
  const rootClass = [
    'histogram-project-legend',
    'histogram-project-legend--embedded',
    'trainings-gap-session-legend',
    groups.length === 0 ? 'histogram-project-legend-empty' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={rootClass} aria-label="Training courses legend">
      <div className="histogram-project-legend-row">
        <div className="histogram-project-legend-title">Courses</div>
        <div
          className="histogram-project-legend-scroll"
          tabIndex={0}
          aria-label="Scroll course legend"
        >
          <div className="histogram-project-legend-scroll-inner">
            {groups.length === 0 ? (
              <p className="histogram-project-legend-empty-inline">
                No courses scheduled in the current date range.
              </p>
            ) : (
              <ul className="histogram-project-legend-list">
                {groups.map((group) => {
                  const label = formatTrainingSessionLabel(group);
                  const title = group.legendNumber
                    ? `${group.legendNumber}. ${label}`
                    : label;
                  return (
                    <li
                      key={group.key}
                      className={[
                        'histogram-project-legend-item',
                        activeSessionKey && group.key === activeSessionKey ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      title={title}
                    >
                      <button
                        type="button"
                        className={[
                          'trainings-gap-session-legend-item',
                          activeSessionKey && group.key === activeSessionKey ? 'is-active' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => onSessionClick?.(group)}
                        title={`${title} — show employees assigned to this course`}
                      >
                        <span
                          className="histogram-project-legend-dot"
                          style={{ backgroundColor: group.legendColor || '#3B82F6' }}
                          aria-hidden="true"
                        />
                        <span className="histogram-project-legend-name">{label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="histogram-project-legend-key" aria-label="Chart legend">
        <span className="histogram-project-legend-key-item" title="Available gap hours">
          <span
            className="histogram-project-legend-key-swatch histogram-project-legend-key-swatch-gap"
            aria-hidden="true"
          />
          <strong>Gap hours</strong>
        </span>
        <span className="histogram-project-legend-key-item" title="Holiday or unavailability">
          <span
            className="histogram-project-legend-key-swatch histogram-project-legend-key-swatch-holiday"
            aria-hidden="true"
          >
            H
          </span>
          <strong>Holiday (H)</strong>
        </span>
      </div>
    </div>
  );
});
