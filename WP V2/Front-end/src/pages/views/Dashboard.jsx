import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import DlQuickUpdateList from '../../components/DlQuickUpdateList';
import { useAuth } from '../../context/AuthContext';
import { findEmployeeForAuthUser } from '../../utils/employeeNames';
import { formatDisplayDate } from '../../utils/dateFormat';
import { TRAINING_STATUS_OPTIONS } from '../../utils/trainingForm';
import { canViewPage, isDlUser } from '../../utils/userPermissions';

function getWelcomeName(user) {
  return user?.login_name || user?.name || 'Guest';
}

function trainingStatusLabel(value) {
  return TRAINING_STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function formatTrainingDateRange(start, end) {
  const startLabel = formatDisplayDate(start);
  const endLabel = formatDisplayDate(end);
  if (startLabel && endLabel && startLabel !== endLabel) {
    return `${startLabel} → ${endLabel}`;
  }
  return startLabel || endLabel || '—';
}

const OUTLOOK_DISMISS_KEY = 'wp.dashboard.dismissedOutlookAwaiting';

function readDismissedOutlookIds() {
  try {
    const raw = localStorage.getItem(OUTLOOK_DISMISS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rememberDismissedOutlookId(id) {
  const next = Array.from(new Set([...readDismissedOutlookIds(), String(id)]));
  try {
    localStorage.setItem(OUTLOOK_DISMISS_KEY, JSON.stringify(next.slice(-200)));
  } catch {
    // ignore quota / private mode
  }
  return next;
}

function withSalesToolSource(row) {
  return {
    ...row,
    source: row.source || 'sales_tool',
    source_label: row.source_label || 'Sales Tool',
    source_tags: Array.isArray(row.source_tags) && row.source_tags.length
      ? row.source_tags
      : [{ key: 'sales_tool', label: 'Sales Tool' }],
    dismissible: row.dismissible !== false,
  };
}

/** Current calendar month through end of (current month + 2). */
function threeMonthWindowBounds() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(1);

  const until = new Date(since);
  until.setMonth(until.getMonth() + 3);
  until.setDate(0); // last day of (current + 2)
  until.setHours(23, 59, 59, 999);

  return { since, until };
}

function isWithinThreeMonths(iso) {
  if (!iso) {
    return true;
  }
  const stamp = new Date(iso);
  if (Number.isNaN(stamp.getTime())) {
    return true;
  }
  const { since, until } = threeMonthWindowBounds();
  return stamp >= since && stamp <= until;
}

function mergeSourceTags(...tagLists) {
  const seen = new Set();
  const merged = [];
  tagLists.flat().forEach((tag) => {
    if (!tag || typeof tag !== 'object') {
      return;
    }
    const key = String(tag.key || tag.label || '').toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(tag);
  });
  return merged;
}

function hasOrderConfirmation(row) {
  if (!row || typeof row !== 'object') {
    return false;
  }
  if (row.has_order_confirmation) {
    return true;
  }
  return Boolean(row.order_confirmation && typeof row.order_confirmation === 'object');
}

function mergeAwaitingProposals(salesRows, outlookRows) {
  const dismissed = new Set(readDismissedOutlookIds());
  // Outlook awaiting already requires an order confirmation.
  const outlook = (Array.isArray(outlookRows) ? outlookRows : [])
    .filter((row) => row && !dismissed.has(String(row.id)))
    .filter((row) => hasOrderConfirmation(row))
    .filter((row) => {
      // Prefer deal/OC schedule dates for the forward window; fall back to received.
      const candidates = [
        row.start_date,
        row.end_date,
        row.order_confirmation?.start_date,
        row.order_confirmation?.documentation_arrival,
        row.order_confirmation?.completion,
        row.order_confirmation?.email?.received_at,
        row.updated_at,
        row.created_at,
      ];
      return candidates.some((value) => value && isWithinThreeMonths(value))
        || candidates.every((value) => !value); // keep if no dates at all
    })
    .map((row) => ({
      ...row,
      source: row.source || 'outlook+drive',
      source_label: row.source_label || 'Outlook + Drive',
      source_tags: Array.isArray(row.source_tags) && row.source_tags.length
        ? row.source_tags
        : [
            { key: 'outlook', label: 'Outlook' },
            { key: 'drive', label: 'Drive' },
          ],
      dismissible: false,
    }));

  const outlookByName = new Map();
  outlook.forEach((row) => {
    const name = String(row.project_name || '').trim().toLowerCase();
    if (name) {
      outlookByName.set(name, row);
    }
  });

  // ST deals only appear when matched to an Outlook order confirmation
  // (quotation optional: OC + quote, or OC only).
  const sales = (Array.isArray(salesRows) ? salesRows : [])
    .map((row) => {
      const base = withSalesToolSource(row);
      const name = String(base.project_name || '').trim().toLowerCase();
      const match = name ? outlookByName.get(name) : null;
      if (!match && !hasOrderConfirmation(base)) {
        return null;
      }
      if (!match) {
        return base;
      }

      return {
        ...base,
        has_order_confirmation: true,
        order_confirmation: base.order_confirmation || match.order_confirmation || null,
        source_tags: mergeSourceTags(base.source_tags, match.source_tags),
        source_label: mergeSourceTags(base.source_tags, match.source_tags)
          .map((tag) => tag.label)
          .join(' + ') || base.source_label,
      };
    })
    .filter((row) => row && hasOrderConfirmation(row));

  const byName = new Set(
    sales
      .map((row) => String(row.project_name || '').trim().toLowerCase())
      .filter(Boolean),
  );

  const uniqueOutlook = outlook.filter((row) => {
    const name = String(row.project_name || '').trim().toLowerCase();
    return !name || !byName.has(name);
  });

  return [...sales, ...uniqueOutlook];
}

function DashboardWelcome({ displayName }) {
  return (
    <header className="dashboard-welcome card">
      <h1 className="dashboard-welcome-title">
        Hello <span className="dashboard-welcome-name">{displayName}</span>, Welcome to TSA Workplanner
      </h1>
      <p className="dashboard-welcome-subtitle">
        This is your Workplanner dashboard.
      </p>
    </header>
  );
}

function DashboardTrainings({ trainings, operativeName }) {
  if (!trainings.length) {
    return null;
  }

  return (
    <div className="card dashboard-my-trainings">
      <div className="dashboard-my-trainings-header">
        <h3 className="section-title">My trainings</h3>
        <Link to="/dl-input-hours?view=trainings" className="btn btn-secondary btn-sm">
          View all
        </Link>
      </div>
      {operativeName ? (
        <p className="dashboard-my-trainings-operative">{operativeName}</p>
      ) : null}
      <ul className="dashboard-my-trainings-list">
        {trainings.map((training) => (
          <li key={training.id} className="dashboard-my-trainings-item">
            <div className="dashboard-my-trainings-item-main">
              <strong>{training.title || 'Untitled training'}</strong>
              <span className="dashboard-my-trainings-dates">
                {formatTrainingDateRange(training.start_date, training.end_date)}
              </span>
            </div>
            {training.status ? (
              <span className="dashboard-my-trainings-status">
                {trainingStatusLabel(training.status)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [myTrainings, setMyTrainings] = useState([]);
  const [salesToolProposals, setSalesToolProposals] = useState([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [dismissingId, setDismissingId] = useState(null);
  const [error, setError] = useState('');
  const [showDlQuickUpdate, setShowDlQuickUpdate] = useState(false);
  const displayName = getWelcomeName(user);
  const canOpenDlHours = canViewPage(user, 'DL Input Hours');
  const canOpenPde = canViewPage(user, 'Project Data Entry');
  const wantsDlQuickUpdate = isDlUser(user);

  const loggedInEmployee = useMemo(
    () => findEmployeeForAuthUser(user, employees),
    [user, employees],
  );

  useEffect(() => {
    if (!wantsDlQuickUpdate) {
      return undefined;
    }

    const start = () => setShowDlQuickUpdate(true);
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(start, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(start, 500);
    return () => window.clearTimeout(id);
  }, [wantsDlQuickUpdate]);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/dashboard/stats')
      .then((response) => {
        if (!cancelled) {
          setStats(response.data.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Unable to load dashboard stats.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!canOpenDlHours) {
      return undefined;
    }

    let cancelled = false;
    api
      .get('/employees')
      .then((response) => {
        if (!cancelled) {
          setEmployees(Array.isArray(response.data?.data) ? response.data.data : []);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [canOpenDlHours]);

  /**
   * Login / dashboard open: read cached Sales Tool proposals only (no live ST sync,
   * Drive quotation refresh, or Outlook Graph call — those reconnect every time).
   * Refresh button: force live sync of ST + Drive + Outlook.
   */
  const loadSalesToolProposals = async ({ liveRefresh = false } = {}) => {
    if (!canOpenPde) {
      setSalesToolProposals([]);
      return;
    }
    setProposalsLoading(true);
    try {
      const salesParams = liveRefresh
        ? {
            sync_from_st: 1,
            refresh_quotations: 1,
            force: 1,
            limit: 80,
            window: '3months',
            ready_only: 0,
          }
        : {
            sync_from_st: 0,
            refresh_quotations: 0,
            limit: 80,
            window: '3months',
            ready_only: 0,
          };

      const salesPromise = api.get('/sales-tool/proposals', { params: salesParams })
        .catch(() => ({ data: { data: [] } }));

      // Outlook supplies order-confirmation details for the card slot.
      const outlookPromise = api.get('/outlook/awaiting-projects', {
        params: { profile: 'deals', top: 80 },
      }).catch(() => ({ data: { data: [] } }));

      const [salesResponse, outlookResponse] = await Promise.all([salesPromise, outlookPromise]);
      setSalesToolProposals(mergeAwaitingProposals(
        salesResponse.data?.data,
        outlookResponse.data?.data,
      ));
    } catch {
      setSalesToolProposals([]);
    } finally {
      setProposalsLoading(false);
    }
  };

  useEffect(() => {
    if (!canOpenPde) {
      setSalesToolProposals([]);
      return undefined;
    }

    let cancelled = false;
    // Initial load: cached ST proposals + Outlook order confirmations (no ST live sync).
    loadSalesToolProposals({ liveRefresh: false }).finally(() => {
      if (cancelled) {
        // no-op; loadSalesToolProposals owns loading state
      }
    });

    return () => {
      cancelled = true;
    };
  }, [canOpenPde]);

  const dismissProposal = async (event, proposalId) => {
    event.preventDefault();
    event.stopPropagation();
    if (!proposalId || dismissingId) {
      return;
    }
    setDismissingId(proposalId);
    try {
      const isOutlook = String(proposalId).startsWith('outlook:');
      if (isOutlook) {
        rememberDismissedOutlookId(proposalId);
        setSalesToolProposals((rows) => rows.filter((row) => row.id !== proposalId));
      } else {
        await api.post(`/sales-tool/proposals/${proposalId}/dismiss`);
        setSalesToolProposals((rows) => rows.filter((row) => row.id !== proposalId));
      }
    } catch {
      // Keep the card if dismiss failed; user can retry from PDE.
    } finally {
      setDismissingId(null);
    }
  };

  useEffect(() => {
    if (!loggedInEmployee?.id) {
      setMyTrainings([]);
      return undefined;
    }

    let cancelled = false;
    api
      .get('/trainings', { params: { employee_id: loggedInEmployee.id } })
      .then((response) => {
        if (cancelled) {
          return;
        }
        const rows = Array.isArray(response.data?.data) ? response.data.data : [];
        setMyTrainings(
          [...rows].sort((left, right) => (
            String(left.start_date ?? '').localeCompare(String(right.start_date ?? ''))
            || String(left.title ?? '').localeCompare(String(right.title ?? ''))
          )),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setMyTrainings([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loggedInEmployee?.id]);

  const cards = stats && canViewPage(user, 'Project Data Entry')
    ? [
        { label: 'Active Projects', value: stats.active_projects, to: '/projects' },
      ]
    : [];

  const quickLinks = [
    { label: 'Project Data Entry', to: '/projects', page: 'Project Data Entry' },
    { label: 'DL Input Hours', to: '/dl-input-hours', page: 'DL Input Hours' },
    { label: "Measurer's Time Planning", to: '/project-progress', page: 'Project Progress' },
    { label: 'Resource Histogram', to: '/resource-histogram', page: 'Resource Histogram' },
    { label: 'Operatives Allocation', to: '/operatives-allocation', page: 'Operatives Allocation' },
    { label: 'User Availability', to: '/user-availability', page: 'User Availability' },
  ].filter((link) => canViewPage(user, link.page));

  const showMyTrainings = canOpenDlHours && myTrainings.length > 0;
  const showDlQuickUpdatePanel = wantsDlQuickUpdate && showDlQuickUpdate;

  const operativeName = loggedInEmployee
    ? [loggedInEmployee.first_name, loggedInEmployee.last_name].filter(Boolean).join(' ')
    : '';

  return (
    <section className="dashboard-page">
      <DashboardWelcome displayName={displayName} />

      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      {cards.length > 0 ? (
        <div className="stat-grid dashboard-stat-grid">
          {cards.map((card) => (
            <Link key={card.label} to={card.to} className="stat-card stat-card-link">
              <p>{card.label}</p>
              <strong>{card.value}</strong>
            </Link>
          ))}
        </div>
      ) : null}

      {showDlQuickUpdatePanel ? (
        <div className="card dashboard-dl-quick-update">
          <DlQuickUpdateList className="dashboard-dl-quick-update-list" />
        </div>
      ) : wantsDlQuickUpdate ? (
        <div className="card dashboard-dl-quick-update">
          <p className="muted">Loading DL Quick Update…</p>
        </div>
      ) : null}

      {showMyTrainings ? (
        <DashboardTrainings trainings={myTrainings} operativeName={operativeName} />
      ) : null}

      {quickLinks.length > 0 ? (
        <div className="card dashboard-quick-links">
          <h3 className="section-title">Quick links</h3>
          <div className="quick-link-grid">
            {quickLinks.map((link) => (
              <Link key={link.to} to={link.to} className="quick-link-card">
                <strong>{link.label}</strong>
              </Link>
            ))}
          </div>

          {canOpenPde ? (
            <div className="dashboard-sales-tool-proposals">
              <div className="dashboard-sales-tool-proposals-header">
                <h4 className="section-title">New projects awaiting confirmation</h4>
                <div className="dashboard-sales-tool-proposals-toolbar">
                  <span className="muted">
                    {proposalsLoading
                      ? 'Checking Sales Tool and Outlook…'
                      : salesToolProposals.length
                        ? `${salesToolProposals.length} awaiting`
                        : 'None awaiting'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={proposalsLoading}
                    onClick={() => loadSalesToolProposals({ liveRefresh: true })}
                    title="Live-refresh Sales Tool, Google Drive quotations, and Outlook"
                  >
                    {proposalsLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
              </div>
              {salesToolProposals.length ? (
                <ul className="dashboard-sales-tool-list">
                  {salesToolProposals.map((proposal) => {
                    const quoteCount = proposal.quotation_count
                      ?? (Array.isArray(proposal.quotations) ? proposal.quotations.length : 0);
                    const hasQuote = Boolean(proposal.has_quotation || quoteCount > 0);
                    const primaryQuote = Array.isArray(proposal.quotations) ? proposal.quotations[0] : null;
                    const order = proposal.order_confirmation && typeof proposal.order_confirmation === 'object'
                      ? proposal.order_confirmation
                      : null;
                    const hasOrder = Boolean(proposal.has_order_confirmation || order);
                    const orderSubject = order?.email?.subject
                      || order?.project_name
                      || 'Order confirmation';
                    const orderLink = order?.email?.web_link || null;
                    const orderReceived = order?.email?.received_at
                      ? formatDisplayDate(order.email.received_at)
                      : null;
                    const title = String(proposal.project_name || proposal.job_number || 'Untitled');
                    const titleWithoutJob = proposal.job_number && title.startsWith(String(proposal.job_number))
                      ? title.slice(String(proposal.job_number).length).trim()
                      : title;
                    const sourceTags = Array.isArray(proposal.source_tags) && proposal.source_tags.length
                      ? proposal.source_tags
                      : [{ key: proposal.source || 'sales_tool', label: proposal.source_label || 'Sales Tool' }];
                    const metaRows = [
                      proposal.client ? { label: 'Client', value: proposal.client } : null,
                      proposal.owner ? { label: 'Owner', value: proposal.owner } : null,
                      proposal.agreed_cost ? { label: 'Agreed', value: proposal.agreed_cost } : null,
                      order?.cost ? { label: 'OC cost', value: String(order.cost) } : null,
                      proposal.quoted_hours ? { label: 'Hours', value: `${proposal.quoted_hours}h` } : null,
                      (proposal.start_date || proposal.end_date || order?.start_date || order?.completion)
                        ? {
                          label: 'Dates',
                          value: [
                            proposal.start_date || order?.start_date || order?.documentation_arrival,
                            proposal.end_date || order?.completion,
                          ].filter(Boolean).join(' → '),
                        }
                        : null,
                    ].filter(Boolean);

                    return (
                      <li key={proposal.id}>
                        <article className={`dashboard-sales-tool-card${hasQuote ? ' has-quotation' : ''}${hasOrder ? ' has-order' : ''}`}>
                          <header className="dashboard-sales-tool-card-top">
                            <div className="dashboard-sales-tool-card-heading">
                              <span className="dashboard-sales-tool-job">{proposal.job_number || '—'}</span>
                              {sourceTags.map((tag) => (
                                <span
                                  key={`${proposal.id}-${tag.key || tag.label}`}
                                  className={`dashboard-sales-tool-pill dashboard-sales-tool-pill--source dashboard-sales-tool-pill--source-${tag.key || 'other'}`}
                                >
                                  {tag.label}
                                </span>
                              ))}
                              {proposal.st_status ? (
                                <span className="dashboard-sales-tool-pill">
                                  {String(proposal.st_status).replace(/_/g, ' ')}
                                </span>
                              ) : null}
                            </div>
                            <h5 className="dashboard-sales-tool-card-title" title={title}>
                              {titleWithoutJob || title}
                            </h5>
                          </header>

                          <dl className="dashboard-sales-tool-meta">
                            {metaRows.map((row) => (
                              <div key={row.label} className="dashboard-sales-tool-meta-row">
                                <dt>{row.label}</dt>
                                <dd title={row.value}>{row.value}</dd>
                              </div>
                            ))}
                          </dl>

                          <div className={`dashboard-sales-tool-order-slot${hasOrder ? ' has-file' : ''}`}>
                            {hasOrder ? (
                              <>
                                <div className="dashboard-sales-tool-quote-main">
                                  <span className="dashboard-sales-tool-pill dashboard-sales-tool-pill--ok">
                                    Order confirmation
                                  </span>
                                  {orderReceived ? (
                                    <span className="dashboard-sales-tool-pill">
                                      {orderReceived}
                                    </span>
                                  ) : null}
                                </div>
                                <span className="dashboard-sales-tool-quote-name" title={orderSubject}>
                                  {orderSubject}
                                </span>
                                {orderLink ? (
                                  <a
                                    href={orderLink}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="dashboard-sales-tool-quote-link"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    Open email
                                  </a>
                                ) : null}
                              </>
                            ) : (
                              <span className="dashboard-sales-tool-quote-empty">No order confirmation found</span>
                            )}
                          </div>

                          <div className={`dashboard-sales-tool-quote-slot${hasQuote ? ' has-file' : ''}`}>
                            {hasQuote && primaryQuote ? (
                              <>
                                <div className="dashboard-sales-tool-quote-main">
                                  <span className="dashboard-sales-tool-pill dashboard-sales-tool-pill--quote">
                                    {quoteCount} Quotation form{quoteCount === 1 ? '' : 's'}
                                  </span>
                                  <span className="dashboard-sales-tool-pill dashboard-sales-tool-pill--ok">
                                    Import ready
                                  </span>
                                </div>
                                <span className="dashboard-sales-tool-quote-name" title={primaryQuote.name}>
                                  {primaryQuote.name || 'Quotation form'}
                                </span>
                                {primaryQuote.webViewLink ? (
                                  <a
                                    href={primaryQuote.webViewLink}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="dashboard-sales-tool-quote-link"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    Open sheet
                                  </a>
                                ) : null}
                              </>
                            ) : (
                              <span className="dashboard-sales-tool-quote-empty">No Quotation form found</span>
                            )}
                          </div>

                          <div className="dashboard-sales-tool-actions">
                            <Link
                              to={proposal.href || `/projects?salesToolProposal=${proposal.id}`}
                              className="btn btn-primary btn-sm"
                            >
                              {hasQuote ? 'Create & import' : 'Review & create'}
                            </Link>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={dismissingId === proposal.id}
                              onClick={(event) => dismissProposal(event, proposal.id)}
                            >
                              {dismissingId === proposal.id ? '…' : 'Dismiss'}
                            </button>
                          </div>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted dashboard-sales-tool-empty">
                  {proposalsLoading
                    ? 'Checking Sales Tool, Outlook Order Confirmations, and Google Drive Quotation forms…'
                    : 'No projects with an order confirmation for this month or the next 2 months.'}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
