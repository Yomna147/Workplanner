import { useMemo } from 'react';
import { formatProjectFilterLabel } from '../utils/ttHoursFilters';

function formatHours(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(1) : '0.0';
}

/**
 * Right-side report: horizontal bars of TT hours by project (respects table filters).
 */
export default function TtHoursProjectsChart({
  summaries = [],
  selectedProjectId = '',
  onSelectProject,
}) {
  const rows = useMemo(() => {
    return [...(summaries || [])]
      .map((summary) => {
        const hours = Number(summary.totalTtHours) || 0;
        const label = formatProjectFilterLabel(
          summary.ttProjectName || summary.projectName,
          summary.jobNumber,
        );
        return {
          id: String(summary.projectId),
          label: label || '—',
          jobNumber: summary.jobNumber || '',
          hours,
          color: summary.color || '#64748b',
        };
      })
      .filter((row) => row.hours > 0)
      .sort((left, right) => right.hours - left.hours || left.label.localeCompare(right.label));
  }, [summaries]);

  const maxHours = rows[0]?.hours || 0;
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0);

  return (
    <aside className="card tt-hours-chart-card" aria-label="Projects hours chart">
      <div className="tt-hours-chart-card__head">
        <h3 className="tt-hours-chart-card__title">Hours by project</h3>
        <p className="tt-hours-chart-card__meta">
          {rows.length}
          {' '}
          project
          {rows.length === 1 ? '' : 's'}
          {' '}
          ·
          {' '}
          <strong>{formatHours(totalHours)}</strong>
          {' '}
          TT hrs
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="tt-hours-chart-empty muted">No project hours to chart.</p>
      ) : (
        <ul className="tt-hours-chart-list">
          {rows.map((row) => {
            const widthPct = maxHours > 0 ? Math.max((row.hours / maxHours) * 100, 4) : 0;
            const isActive = selectedProjectId && String(selectedProjectId) === row.id;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className={`tt-hours-chart-row${isActive ? ' is-active' : ''}`}
                  onClick={() => onSelectProject?.(isActive ? '' : row.id)}
                  title={`${row.jobNumber ? `#${row.jobNumber} ` : ''}${row.label}: ${formatHours(row.hours)}h`}
                >
                  <span className="tt-hours-chart-row__label">
                    {row.jobNumber ? (
                      <span className="tt-hours-chart-row__job">
                        #
                        {row.jobNumber}
                      </span>
                    ) : null}
                    <span className="tt-hours-chart-row__name">{row.label}</span>
                  </span>
                  <span className="tt-hours-chart-row__track" aria-hidden="true">
                    <span
                      className="tt-hours-chart-row__bar"
                      style={{
                        width: `${widthPct}%`,
                        backgroundColor: row.color,
                      }}
                    />
                  </span>
                  <span className="tt-hours-chart-row__hrs">{formatHours(row.hours)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
