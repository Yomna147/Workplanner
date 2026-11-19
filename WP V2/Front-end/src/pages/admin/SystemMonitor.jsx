import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { SystemMonitorSkeleton } from '../../components/PageSkeleton';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import usePageTitle from '../../hooks/usePageTitle';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { canPageAction } from '../../utils/userPermissions';

const STATUS_LABELS = {
  ok: 'Operational',
  warn: 'Needs attention',
  error: 'Down',
  unknown: 'Not checked',
};

const LIVE_PROBE_TARGETS = [
  'timetracking',
  'google_sheets',
  'google_drive_quotations',
  'sales_tool',
  'outlook_deals',
  'outlook_leads',
];

const METRIC_LABELS = {
  projects: 'Projects',
  active_projects: 'Active projects',
  parts: 'Parts',
  tasks: 'Tasks',
  open_tasks: 'Open tasks',
  assigned_algorithm_1: 'Assigned (algorithm)',
  open_unassigned: 'Open unassigned',
  assigned_tasks: 'Assigned tasks',
  bar_overrides: 'Bar overrides',
  courses: 'Courses',
  assignments: 'Assignments',
  active_assignments: 'Active assignments',
  employees: 'Operatives',
  teams: 'Teams',
  nrms: 'NRMs',
  nrm_allocations: 'NRM allocations',
  without_team: 'Without a team',
  summary_count: 'Cached summaries',
  fetched_at: 'Last TT fetch',
  date_start: 'From',
  date_end: 'To',
  rows: 'Availability rows',
  employees_with_availability: 'Operatives with availability',
  current_month_rows: 'This month',
  latest_date: 'Latest date',
  tasks_with_dl_progress: 'DL progress updates',
  tasks_with_dl_owner: 'DL owners',
  section_hours_approved: 'Approved section hours',
  tasks_with_section_hours: 'Tasks with section hours',
  users: 'Users',
  active_users: 'Active',
  inactive_users: 'Inactive',
  admins: 'Admins',
  rules: 'Rules',
  enabled: 'Enabled',
  email_enabled: 'Email enabled',
  base_url: 'Base URL',
  login: 'Service login',
  password_configured: 'Password set',
  api_key_configured: 'API key set',
  service_account_configured: 'Service account set',
  client_email: 'Service account email',
  folder_id: 'Quotations folder ID',
  quotation_count: 'Quotation files',
  quotation_names: 'Sample files',
  spreadsheet_id: 'Spreadsheet ID',
  sheet_count: 'Sheet tabs',
  sheet_titles: 'Tabs',
  mailer: 'Mailer',
  from: 'From',
  host: 'SMTP host',
  schedule: 'Schedule',
  command: 'Command',
  next_run_at: 'Next run',
  last_availability_update: 'Last availability update',
  cache_fetched_at: 'Cached hours',
  cache_summaries: 'Cached summaries',
  latency_ms: 'Response',
  used_for: 'Used for',
  token_configured: 'Integration token set',
  mailbox: 'Mailbox',
  auth: 'Auth',
  credentials_configured: 'Credentials set',
  live_sync_enabled: 'Live sync',
  pending_proposals: 'Pending proposals',
  st_cache_key: 'Sales Tool cache',
  st_last_sync_at: 'Last proposal update',
  driver: 'Driver',
  detail: 'Detail',
};

const PRIMARY_METRIC_KEYS = new Set([
  'latency_ms',
  'active_projects',
  'open_tasks',
  'open_unassigned',
  'employees',
  'active_assignments',
  'quotation_count',
  'sheet_count',
  'mailbox',
  'pending_proposals',
  'st_last_sync_at',
  'cache_fetched_at',
  'last_availability_update',
  'next_run_at',
  'fetched_at',
  'used_for',
]);

function statusLabel(status) {
  return STATUS_LABELS[status] || 'Unknown';
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatRelative(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const deltaSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (deltaSec < 10) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const mins = Math.round(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return formatTimestamp(value);
}

function humanizeKey(key) {
  return METRIC_LABELS[key] || String(key).replace(/_/g, ' ');
}

function formatMetricValue(key, value) {
  if (value == null || value === '') {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(', ') || '—';
  }
  if (key === 'latency_ms' && typeof value === 'number') {
    return `${value.toLocaleString()} ms`;
  }
  if (typeof value === 'string' && (key.endsWith('_at') || key.endsWith('_date') || key === 'last_availability_update')) {
    return formatTimestamp(value) || value;
  }
  if (typeof value === 'number') {
    return value.toLocaleString();
  }
  return String(value);
}

function overallCopy(status, counts) {
  if (status === 'ok') {
    return 'Work Planner functions and configured integrations look healthy.';
  }
  if (status === 'warn') {
    return `${counts.warn} area${counts.warn === 1 ? '' : 's'} need attention. Platform is still up.`;
  }
  if (status === 'error') {
    return `${counts.error} area${counts.error === 1 ? '' : 's'} down${counts.warn ? `, ${counts.warn} need attention` : ''}.`;
  }
  return 'Collecting system status…';
}

function aggregateStatus(items) {
  const statuses = items.map((item) => item?.status).filter(Boolean);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('unknown')) return 'unknown';
  return statuses.length ? 'ok' : 'unknown';
}

function countByStatus(items) {
  return items.reduce(
    (acc, item) => {
      const status = item?.status || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      acc.total += 1;
      return acc;
    },
    { ok: 0, warn: 0, error: 0, unknown: 0, total: 0 },
  );
}

function StatusPill({ status }) {
  return (
    <span className={`system-monitor-pill system-monitor-pill--${status || 'unknown'}`}>
      {statusLabel(status)}
    </span>
  );
}

function MetricList({ metrics, compact = false }) {
  const entries = Object.entries(metrics || {}).filter(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return false;
    }
    if (Array.isArray(value) && value.length === 0) {
      return false;
    }
    if (compact && !PRIMARY_METRIC_KEYS.has(key)) {
      return false;
    }
    return true;
  });
  if (!entries.length) {
    return null;
  }

  return (
    <dl className="system-monitor-metrics">
      {entries.map(([key, value]) => (
        <div key={key} className="system-monitor-metric">
          <dt>{humanizeKey(key)}</dt>
          <dd title={String(formatMetricValue(key, value))}>{formatMetricValue(key, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function MonitorCard({ item, probing = false, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded || item.status === 'error' || item.status === 'warn');
  const livePending = probing && LIVE_PROBE_TARGETS.includes(item.id);
  const displayStatus = livePending && item.status !== 'error' ? 'unknown' : (item.status || 'unknown');
  const message = livePending && item.status !== 'error'
    ? 'Checking live connection…'
    : item.message;

  const extra = {
    base_url: item.base_url,
    login: item.login,
    password_configured: item.password_configured,
    api_key_configured: item.api_key_configured,
    service_account_configured: item.service_account_configured,
    client_email: item.client_email,
    folder_id: item.folder_id,
    quotation_count: item.quotation_count,
    quotation_names: item.quotation_names,
    spreadsheet_id: item.spreadsheet_id,
    sheet_count: item.sheet_count,
    sheet_titles: item.sheet_titles,
    mailer: item.mailer,
    from: item.from,
    host: item.host,
    schedule: item.schedule,
    command: item.command,
    next_run_at: item.next_run_at,
    last_availability_update: item.last_availability_update,
    cache_fetched_at: item.cache_fetched_at,
    cache_summaries: item.cache_summaries,
    latency_ms: item.latency_ms,
    used_for: item.used_for,
    token_configured: item.token_configured,
    mailbox: item.mailbox,
    auth: item.auth,
    credentials_configured: item.credentials_configured,
    st_cache_key: item.st_cache_key,
    st_last_sync_at: item.st_last_sync_at,
    driver: item.driver,
    detail: item.detail,
    ...(item.metrics || {}),
  };

  const hasMoreMetrics = Object.entries(extra).some(([key, value]) => {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) {
      return false;
    }
    return !PRIMARY_METRIC_KEYS.has(key);
  });

  const body = (
    <>
      <div className="system-monitor-card-top">
        <h3>{item.label}</h3>
        <StatusPill status={displayStatus} />
      </div>
      <p className="system-monitor-card-message">{message}</p>
      <MetricList metrics={extra} compact={!expanded} />
      {hasMoreMetrics ? (
        <button
          type="button"
          className="system-monitor-card-toggle"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      ) : null}
      {item.last_activity_at ? (
        <p className="system-monitor-card-meta muted">Last activity {formatTimestamp(item.last_activity_at)}</p>
      ) : null}
      {item.href ? (
        <span className="system-monitor-card-link muted">Open page →</span>
      ) : null}
    </>
  );

  const className = `system-monitor-card system-monitor-card--${displayStatus}`;

  if (item.href) {
    return (
      <Link to={item.href} className={className}>
        {body}
      </Link>
    );
  }

  return (
    <article className={className}>
      {body}
    </article>
  );
}

export default function SystemMonitor() {
  usePageTitle('System Monitor');
  const toast = useToast();
  const { user } = useAuth();
  const canProbe = canPageAction(user, 'System Monitor', 'probe');
  const [data, setData] = useState(null);
  const [probeMap, setProbeMap] = useState({});
  const [probedAt, setProbedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/system-monitor');
      setData(response.data.data);
      setError('');
      return true;
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to load system monitor.');
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const runProbes = useCallback(async () => {
    if (!canProbe) {
      return;
    }
    setProbing(true);
    try {
      const response = await api.post('/admin/system-monitor/probe', {
        targets: LIVE_PROBE_TARGETS,
      }, { timeout: 120000 });
      setProbeMap(response.data.data?.results || {});
      setProbedAt(response.data.data?.checked_at || new Date().toISOString());
      toast.success('Live connection checks finished.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to check integrations.');
      toast.error(message);
    } finally {
      setProbing(false);
    }
  }, [canProbe, toast]);

  // Snapshot only on open — do not auto-probe (that reconnects every integration).
  useEffect(() => {
    loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const integrations = useMemo(() => (
    (data?.integrations || []).map((item) => {
      const live = probeMap[item.id];
      if (!live) {
        return item;
      }
      return {
        ...item,
        ...live,
        status: live.status || item.status,
        message: live.message || item.message,
      };
    })
  ), [data, probeMap]);

  const allItems = useMemo(() => {
    const platformItems = data?.platform
      ? [data.platform.database, data.platform.cache].filter(Boolean)
      : [];
    return [
      ...platformItems,
      ...(data?.functions || []),
      ...integrations,
    ];
  }, [data, integrations]);

  const counts = useMemo(() => countByStatus(allItems), [allItems]);
  const overall = useMemo(() => aggregateStatus(allItems), [allItems]);

  const issueItems = useMemo(
    () => allItems.filter((item) => item?.status === 'error' || item?.status === 'warn'),
    [allItems],
  );

  const matchesQuery = useCallback((item) => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return true;
    }
    return [item.label, item.message, item.id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  }, [query]);

  const visibleFunctions = useMemo(() => {
    const rows = data?.functions || [];
    return rows.filter((item) => {
      if (filter === 'issues' && item.status !== 'error' && item.status !== 'warn') {
        return false;
      }
      if (filter === 'integrations') {
        return false;
      }
      return matchesQuery(item);
    });
  }, [data, filter, matchesQuery]);

  const visibleIntegrations = useMemo(() => (
    integrations.filter((item) => {
      if (filter === 'issues' && item.status !== 'error' && item.status !== 'warn') {
        return false;
      }
      if (filter === 'functions') {
        return false;
      }
      return matchesQuery(item);
    })
  ), [filter, integrations, matchesQuery]);

  if (loading && !data) {
    return <SystemMonitorSkeleton />;
  }

  const checkedAt = data?.checked_at;
  const filterOptions = [
    { id: 'all', label: 'All', count: counts.total },
    { id: 'issues', label: 'Issues', count: counts.error + counts.warn },
    { id: 'functions', label: 'Functions', count: (data?.functions || []).length },
    { id: 'integrations', label: 'Integrations', count: integrations.length },
  ];

  return (
    <section className="system-monitor-page">
      <header className="page-header page-header-compact system-monitor-header">
        <div className="page-heading page-heading-row">
          <div className="page-heading-copy">
            <h2>System Monitor</h2>
            <p className="access-permissions-description">
              Health of Work Planner functions and external integrations.
              {checkedAt ? ` Snapshot ${formatRelative(checkedAt)}.` : ''}
              {probedAt ? ` Live checks ${formatRelative(probedAt)}.` : ' Live checks run only when you ask.'}
            </p>
          </div>
          <div className="page-header-actions system-monitor-toolbar-actions">
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={loadSnapshot}
              disabled={loading || probing}
              title="Reload cached health snapshot (no live reconnection)"
            >
              {loading ? 'Refreshing…' : 'Refresh snapshot'}
            </button>
            {canProbe ? (
              <button
                type="button"
                className="btn btn-primary btn-compact"
                onClick={runProbes}
                disabled={loading || probing}
                title="Live-check Time Tracking, Google, Sales Tool, and Outlook"
              >
                {probing ? 'Checking connections…' : 'Check connections'}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      {data ? (
        <>
          <div className={`system-monitor-banner system-monitor-banner--${overall}`} role="status">
            <StatusPill status={overall} />
            <div className="system-monitor-banner-copy">
              <p>{overallCopy(overall, counts)}</p>
              <div className="system-monitor-banner-counts" aria-label="Status counts">
                <span className="system-monitor-count system-monitor-count--ok">{counts.ok} ok</span>
                <span className="system-monitor-count system-monitor-count--warn">{counts.warn} warn</span>
                <span className="system-monitor-count system-monitor-count--error">{counts.error} down</span>
                {counts.unknown ? (
                  <span className="system-monitor-count system-monitor-count--unknown">{counts.unknown} unchecked</span>
                ) : null}
              </div>
            </div>
          </div>

          {issueItems.length && filter === 'all' && !query.trim() ? (
            <section className="system-monitor-section">
              <div className="system-monitor-section-heading">
                <h3 className="section-title">Needs attention</h3>
                <span className="muted">{issueItems.length} item{issueItems.length === 1 ? '' : 's'}</span>
              </div>
              <div className="system-monitor-grid">
                {issueItems.map((item) => (
                  <MonitorCard
                    key={`issue-${item.id}`}
                    item={item}
                    probing={probing && LIVE_PROBE_TARGETS.includes(item.id)}
                    defaultExpanded
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="system-monitor-section">
            <h3 className="section-title">Platform</h3>
            <div className="system-monitor-platform">
              <article className="system-monitor-platform-stat">
                <span>Application</span>
                <strong>{data.platform.app}</strong>
                <small>{data.platform.env}{data.platform.debug ? ' · debug' : ''}</small>
              </article>
              <article className="system-monitor-platform-stat">
                <span>Runtime</span>
                <strong>PHP {data.platform.php}</strong>
                <small>Laravel {data.platform.laravel}</small>
              </article>
              <article className={`system-monitor-platform-stat system-monitor-platform-stat--${data.platform.database.status}`}>
                <span>Database</span>
                <strong>{statusLabel(data.platform.database.status)}</strong>
                <small>
                  {data.platform.database.driver}
                  {typeof data.platform.database.latency_ms === 'number' ? ` · ${data.platform.database.latency_ms} ms` : ''}
                </small>
              </article>
              <article className={`system-monitor-platform-stat system-monitor-platform-stat--${data.platform.cache.status}`}>
                <span>Cache</span>
                <strong>{statusLabel(data.platform.cache.status)}</strong>
                <small>
                  {data.platform.cache.driver}
                  {typeof data.platform.cache.latency_ms === 'number' ? ` · ${data.platform.cache.latency_ms} ms` : ''}
                </small>
              </article>
            </div>
          </section>

          <section className="system-monitor-section">
            <div className="system-monitor-section-heading">
              <h3 className="section-title">Browse</h3>
            </div>
            <div className="system-monitor-filters">
              <div className="system-monitor-filter-chips" role="tablist" aria-label="Filter monitor items">
                {filterOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === option.id}
                    className={`system-monitor-filter-chip${filter === option.id ? ' is-active' : ''}`}
                    onClick={() => setFilter(option.id)}
                  >
                    {option.label}
                    <span>{option.count}</span>
                  </button>
                ))}
              </div>
              <label className="system-monitor-search">
                <span className="sr-only">Search</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search functions or integrations…"
                />
              </label>
            </div>
          </section>

          {filter === 'issues' ? (
            <section className="system-monitor-section">
              <div className="system-monitor-section-heading">
                <h3 className="section-title">Issues</h3>
                <span className="muted">
                  {issueItems.filter(matchesQuery).length} shown
                </span>
              </div>
              {issueItems.filter(matchesQuery).length ? (
                <div className="system-monitor-grid">
                  {issueItems.filter(matchesQuery).map((item) => (
                    <MonitorCard
                      key={item.id}
                      item={item}
                      probing={probing && LIVE_PROBE_TARGETS.includes(item.id)}
                      defaultExpanded
                    />
                  ))}
                </div>
              ) : (
                <p className="muted system-monitor-empty">No issues match this filter.</p>
              )}
            </section>
          ) : (
            <>
              {filter !== 'integrations' ? (
                <section className="system-monitor-section">
                  <div className="system-monitor-section-heading">
                    <h3 className="section-title">Work Planner functions</h3>
                    <span className="muted">{visibleFunctions.length} shown</span>
                  </div>
                  {visibleFunctions.length ? (
                    <div className="system-monitor-grid">
                      {visibleFunctions.map((item) => (
                        <MonitorCard key={item.id} item={item} />
                      ))}
                    </div>
                  ) : (
                    <p className="muted system-monitor-empty">No functions match this filter.</p>
                  )}
                </section>
              ) : null}

              {filter !== 'functions' ? (
                <section className="system-monitor-section">
                  <div className="system-monitor-section-heading">
                    <h3 className="section-title">Integrations</h3>
                    <span className="muted">
                      {visibleIntegrations.length} shown
                      {!probedAt && canProbe ? ' · config snapshot until you check connections' : ''}
                    </span>
                  </div>
                  {visibleIntegrations.length ? (
                    <div className="system-monitor-grid">
                      {visibleIntegrations.map((item) => (
                        <MonitorCard
                          key={item.id}
                          item={item}
                          probing={probing && LIVE_PROBE_TARGETS.includes(item.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="muted system-monitor-empty">No integrations match this filter.</p>
                  )}
                </section>
              ) : null}
            </>
          )}

          <section className="system-monitor-section">
            <div className="system-monitor-section-heading">
              <h3 className="section-title">Recent activity</h3>
              <Link to="/admin/activity-log" className="btn btn-secondary btn-compact">
                Open activity log
              </Link>
            </div>
            <div className="table-card admin-table-wrap">
              <table className="system-monitor-activity-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Area</th>
                    <th>Action</th>
                    <th>User</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.recent_activity || []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">No activity recorded yet.</td>
                    </tr>
                  ) : (
                    data.recent_activity.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <span className="system-monitor-activity-when">{formatRelative(row.created_at) || '—'}</span>
                          <small className="muted">{formatTimestamp(row.created_at)}</small>
                        </td>
                        <td>{row.area || '—'}</td>
                        <td>{row.action || '—'}</td>
                        <td>{row.user_name || '—'}</td>
                        <td>{row.summary || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
