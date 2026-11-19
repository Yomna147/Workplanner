function Skeleton({
  className = '',
  style,
  variant = 'rect',
  width,
  height,
}) {
  const classes = [
    'skeleton',
    variant === 'text' ? 'skeleton-text' : '',
    variant === 'circle' ? 'skeleton-circle' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      style={{
        width,
        height,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

export function PageHeadingSkeleton({ withActions = false }) {
  return (
    <div className={`page-heading skeleton-heading${withActions ? ' skeleton-heading--actions' : ''}`}>
      <div className="skeleton-heading-copy">
        <Skeleton variant="text" className="skeleton-title" />
        <Skeleton variant="text" className="skeleton-subtitle" />
      </div>
      {withActions && (
        <div className="skeleton-heading-actions">
          <Skeleton className="skeleton-btn" />
          <Skeleton className="skeleton-btn skeleton-btn--primary" />
        </div>
      )}
    </div>
  );
}

export function StatGridSkeleton({ count = 4, className = '' }) {
  return (
    <div className={`stat-grid skeleton-stat-grid${className ? ` ${className}` : ''}`}>
      {Array.from({ length: count }).map((_, index) => (
        <article key={index} className="stat-card skeleton-stat-card">
          <Skeleton variant="text" className="skeleton-stat-label" />
          <Skeleton variant="text" className="skeleton-stat-value" />
        </article>
      ))}
    </div>
  );
}

export function DashboardSkeleton({ displayName = '' }) {
  return (
    <section className="dashboard-page skeleton-page">
      <header className="dashboard-welcome card">
        {displayName ? (
          <h1 className="dashboard-welcome-title">
            Hello <span className="dashboard-welcome-name">{displayName}</span>, Welcome to TSA Workplanner
          </h1>
        ) : (
          <Skeleton variant="text" className="skeleton-dashboard-welcome-title" />
        )}
        <Skeleton variant="text" className="skeleton-dashboard-welcome-subtitle" />
      </header>
      <StatGridSkeleton count={1} className="dashboard-stat-grid" />
    </section>
  );
}

export function FilterBarSkeleton({ fields = 4, actions = 3 }) {
  return (
    <div className="card histogram-filters skeleton-filter-bar">
      {Array.from({ length: fields }).map((_, index) => (
        <div key={index} className="skeleton-filter-field">
          <Skeleton variant="text" className="skeleton-label" />
          <Skeleton className="skeleton-input" />
        </div>
      ))}
      <div className="histogram-filter-actions skeleton-filter-actions">
        {Array.from({ length: actions }).map((_, index) => (
          <Skeleton key={index} className="skeleton-btn" />
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 8, cols = 5 }) {
  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };

  return (
    <div className="table-card skeleton-table-card">
      <div className="skeleton-table-head" style={gridStyle}>
        {Array.from({ length: cols }).map((_, index) => (
          <Skeleton key={index} variant="text" className="skeleton-th" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="skeleton-table-row" style={gridStyle}>
          {Array.from({ length: cols }).map((__, colIndex) => (
            <Skeleton
              key={colIndex}
              variant="text"
              className="skeleton-td"
              style={{ width: `${48 + ((rowIndex + colIndex) % 4) * 10}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function FormGridSkeleton({ fields = 5 }) {
  return (
    <div className="card form-grid skeleton-form-grid">
      {Array.from({ length: fields }).map((_, index) => (
        <div key={index} className="skeleton-form-field">
          <Skeleton variant="text" className="skeleton-label" />
          <Skeleton className="skeleton-input" />
        </div>
      ))}
      <Skeleton className="skeleton-btn skeleton-btn--primary skeleton-form-submit" />
    </div>
  );
}

export function FormAndTablePageSkeleton({
  formFields = 5,
  tableRows = 8,
  tableCols = 4,
}) {
  return (
    <section className="skeleton-page">
      <PageHeadingSkeleton />
      <FormGridSkeleton fields={formFields} />
      <TableSkeleton rows={tableRows} cols={tableCols} />
    </section>
  );
}

export function TablePageSkeleton({
  rows = 8,
  cols = 5,
  withActions = false,
  withInlineForm = false,
  className = '',
}) {
  return (
    <section className={`skeleton-page${className ? ` ${className}` : ''}`}>
      <PageHeadingSkeleton withActions={withActions} />
      {withInlineForm && (
        <div className="card inline-form skeleton-inline-form">
          <Skeleton className="skeleton-input skeleton-input--wide" />
          <Skeleton className="skeleton-btn skeleton-btn--primary" />
        </div>
      )}
      <TableSkeleton rows={rows} cols={cols} />
    </section>
  );
}

export function HistogramChartSkeleton({ inline = false }) {
  return (
    <div className={`card skeleton-histogram-chart${inline ? ' skeleton-histogram-chart--inline' : ''}`}>
      <div className="skeleton-histogram-header">
        <Skeleton className="skeleton-histogram-label" />
        <div className="skeleton-histogram-days">
          {Array.from({ length: 12 }).map((_, index) => (
            <Skeleton key={index} className="skeleton-histogram-day" />
          ))}
        </div>
      </div>
      {Array.from({ length: 6 }).map((_, rowIndex) => (
        <div key={rowIndex} className="skeleton-histogram-row">
          <Skeleton className="skeleton-histogram-name" />
          <div className="skeleton-histogram-lane">
            <Skeleton
              className="skeleton-histogram-bar"
              style={{ width: `${22 + ((rowIndex * 13) % 40)}%`, marginLeft: `${(rowIndex * 11) % 30}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistogramPageSkeleton() {
  return (
    <section className="skeleton-page resource-histogram-page">
      <PageHeadingSkeleton />
      <FilterBarSkeleton fields={4} actions={4} />
      <HistogramChartSkeleton />
    </section>
  );
}

function TrainingsOverviewSkeleton() {
  return (
    <div className="card trainings-overview skeleton-trainings-overview">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="trainings-overview-stat skeleton-trainings-overview-stat">
          <Skeleton variant="text" className="skeleton-stat-label" />
          <Skeleton variant="text" className="skeleton-stat-value" />
        </div>
      ))}
    </div>
  );
}

function TrainingsGapToolbarSkeleton() {
  return (
    <div className="trainings-toolbar skeleton-trainings-toolbar">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="skeleton-trainings-toolbar-field">
          <Skeleton variant="text" className="skeleton-label" />
          <Skeleton className="skeleton-input" />
        </div>
      ))}
      <Skeleton className="skeleton-btn" />
    </div>
  );
}

function TrainingsGapLegendSkeleton() {
  return (
    <div className="histogram-project-legend histogram-project-legend--embedded skeleton-trainings-legend">
      <div className="histogram-project-legend-row">
        <Skeleton className="skeleton-trainings-legend-chip" />
        <div className="skeleton-trainings-legend-sessions">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="skeleton-trainings-legend-session" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function TrainingsPageSkeleton() {
  return (
    <section className="skeleton-page trainings-page trainings-page--gaps">
      <header className="page-header page-header-compact skeleton-heading skeleton-heading--actions">
        <div className="page-heading page-heading-row">
          <div className="skeleton-heading-copy">
            <Skeleton variant="text" className="skeleton-title skeleton-trainings-title" />
          </div>
          <div className="skeleton-heading-actions trainings-header-actions">
            <Skeleton className="skeleton-btn skeleton-trainings-view-toggle" />
            <Skeleton className="skeleton-btn skeleton-btn--primary" />
          </div>
        </div>
      </header>
      <TrainingsOverviewSkeleton />
      <div className="trainings-layout trainings-layout-single">
        <section className="trainings-gap-panel card">
          <TrainingsGapToolbarSkeleton />
          <TrainingsGapLegendSkeleton />
          <HistogramChartSkeleton inline />
        </section>
      </div>
    </section>
  );
}

export function TaskGridSkeleton() {
  return (
    <div className="card skeleton-task-grid">
      <div className="project-task-toolbar skeleton-task-toolbar">
        <Skeleton className="skeleton-btn" />
        <Skeleton className="skeleton-btn" />
        <Skeleton className="skeleton-btn skeleton-btn--primary" />
      </div>
      <div className="skeleton-task-columns">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="skeleton-task-column">
            <Skeleton className="skeleton-task-column-head" />
            {Array.from({ length: 10 }).map((__, rowIndex) => (
              <Skeleton
                key={rowIndex}
                variant="text"
                className="skeleton-task-cell"
                style={{ width: `${50 + ((index + rowIndex) % 3) * 15}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProjectsPageSkeleton() {
  return (
    <section className="skeleton-page pde-page">
      <PageHeadingSkeleton withActions />
      <div className="card project-picker skeleton-project-picker">
        <div className="project-picker-row project-picker-toolbar">
          <Skeleton className="skeleton-input skeleton-input--wide" />
          <Skeleton className="skeleton-input skeleton-input--wide" />
          <Skeleton className="skeleton-input" style={{ width: 40, height: 36 }} />
          <Skeleton className="skeleton-input skeleton-input--wide" />
          <Skeleton className="skeleton-btn skeleton-btn--primary" />
          <Skeleton className="skeleton-btn" />
          <Skeleton className="skeleton-btn" />
        </div>
      </div>
      <TaskGridSkeleton />
    </section>
  );
}

export function AvailabilityPageSkeleton() {
  return (
    <section className="skeleton-page">
      <PageHeadingSkeleton withActions />
      <div className="card skeleton-availability-toolbar">
        <Skeleton className="skeleton-input skeleton-input--wide" />
        <Skeleton className="skeleton-input" />
        <Skeleton className="skeleton-input" />
        <Skeleton className="skeleton-btn" />
        <Skeleton className="skeleton-btn skeleton-btn--primary" />
      </div>
      <TableSkeleton rows={10} cols={9} />
    </section>
  );
}

export function AllocationPageSkeleton() {
  return (
    <section className="skeleton-page">
      <PageHeadingSkeleton withActions />
      <div className="allocation-toolbar skeleton-allocation-toolbar">
        <Skeleton className="skeleton-btn" />
        <Skeleton className="skeleton-btn" />
        <Skeleton className="skeleton-btn skeleton-btn--primary" />
      </div>
      <TableSkeleton rows={12} cols={6} />
    </section>
  );
}

export function RolesPageSkeleton() {
  return (
    <section className="skeleton-page skeleton-page--roles">
      <PageHeadingSkeleton withActions />
      <div className="roles-layout skeleton-roles-layout">
        <div className="card skeleton-roles-list">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="skeleton-role-item" />
          ))}
        </div>
        <div className="card skeleton-roles-editor">
          <Skeleton variant="text" className="skeleton-title" />
          <TableSkeleton rows={8} cols={2} />
        </div>
      </div>
    </section>
  );
}

export function SystemMonitorSkeleton() {
  return (
    <section className="skeleton-page system-monitor-page">
      <PageHeadingSkeleton withActions />
      <div className="system-monitor-banner">
        <Skeleton variant="text" className="skeleton-title" />
      </div>
      <StatGridSkeleton count={4} className="system-monitor-platform" />
      <StatGridSkeleton count={8} />
    </section>
  );
}

export function AppLoadingSkeleton() {
  return (
    <div className="app-shell">
      <div className="skeleton-navbar" aria-hidden="true">
        <Skeleton className="skeleton-navbar-brand" />
        <div className="skeleton-navbar-links">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="skeleton-navbar-link" />
          ))}
        </div>
        <Skeleton className="skeleton-navbar-user" />
      </div>
      <main className="app-main">
        <DashboardSkeleton />
      </main>
    </div>
  );
}

export default Skeleton;
