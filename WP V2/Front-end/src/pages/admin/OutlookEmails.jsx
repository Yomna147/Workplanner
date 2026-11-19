import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import usePageTitle from '../../hooks/usePageTitle';
import { getApiErrorMessage } from '../../utils/apiErrors';

const PROFILES = [
  { value: 'deals', label: 'Deals & Enquiries' },
  { value: 'leads', label: 'Angela (Leads)' },
];

const FILTERS = [
  { value: 'order_and_quotations', label: 'Projects (order + quotation)' },
  { value: 'order_confirmation', label: 'With order confirmation' },
  { value: 'quotations', label: 'With quotation form' },
];

const MATCH_FILTERS = [
  { value: 'all', label: 'All vs Drive' },
  { value: 'matched', label: 'In Drive + emails' },
  { value: 'drive_only', label: 'Drive only' },
  { value: 'outlook_only', label: 'Emails only' },
  { value: 'missing_wp', label: 'Not in Work Planner' },
  { value: 'in_wp', label: 'Already in Work Planner' },
];

function matchStatusLabel(status) {
  if (status === 'matched') return 'In Drive + emails';
  if (status === 'drive_only') return 'Drive only';
  if (status === 'outlook_only') return 'Emails only';
  return 'Unknown';
}

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatMoney(value) {
  if (value == null || value === '') return null;
  const num = Number(String(value).replace(/,/g, ''));
  if (Number.isFinite(num)) {
    return `£${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `£${value}`;
}

function ProjectFacts({ order }) {
  if (!order) {
    return <p className="muted outlook-emails-empty">No Order Confirmation data found for this project yet.</p>;
  }

  const rows = [
    ['Cost', formatMoney(order.cost)],
    ['Documentation Arrival', order.documentation_arrival],
    ['Start date', order.start_date],
    ['Completion', order.completion],
  ].filter(([, value]) => value);

  return (
    <div className="outlook-project-section">
      <div className="outlook-project-section-head">
        <h4>Order Confirmation</h4>
        {order.email?.web_link ? (
          <a href={order.email.web_link} target="_blank" rel="noreferrer" className="outlook-email-open-link">
            Open email
          </a>
        ) : null}
      </div>
      {order.email?.subject ? (
        <p className="muted outlook-project-email-meta">
          {order.email.subject}
          {order.email.received_at ? ` · ${formatWhen(order.email.received_at)}` : ''}
        </p>
      ) : null}
      {rows.length ? (
        <dl className="outlook-email-parsed">
          {rows.map(([label, value]) => (
            <div key={label} className="outlook-email-parsed-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">Order confirmation email found, but dates/cost were not parsed.</p>
      )}
    </div>
  );
}

function QuotationFormsPanel({ forms }) {
  const items = useMemo(
    () => (Array.isArray(forms) ? forms.filter((item) => item?.name) : []),
    [forms],
  );

  return (
    <div className="outlook-project-section">
      <div className="outlook-project-section-head">
        <h4>Quotation form</h4>
      </div>
      {!items.length ? (
        <p className="muted outlook-emails-empty">No Quotation form found on Drive for this project yet.</p>
      ) : (
        <ul className="outlook-email-attachments-list">
          {items.map((item) => (
            <li key={item.id || item.name} className="outlook-email-attachment-item">
              <div className="outlook-email-attachment-meta">
                <span className="outlook-email-attachment-kind">Form</span>
                <div>
                  <strong title={item.name}>{item.name}</strong>
                  <div className="muted">{item.project_name || 'Google Drive'}</div>
                </div>
              </div>
              <div className="outlook-email-attachment-actions">
                {item.web_link ? (
                  <a href={item.web_link} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
                    Open form
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceEmails({ emails }) {
  const items = Array.isArray(emails) ? emails : [];
  if (!items.length) return null;

  return (
    <div className="outlook-project-section">
      <div className="outlook-project-section-head">
        <h4>Source emails</h4>
        <span className="muted">{items.length}</span>
      </div>
      <ul className="outlook-project-email-list">
        {items.map((email) => (
          <li key={email.id || `${email.subject}-${email.received_at}`}>
            <div>
              <strong title={email.subject}>{email.subject || '(no subject)'}</strong>
              <div className="muted">
                {formatWhen(email.received_at)}
                {email.from ? ` · ${email.from}` : ''}
              </div>
              <div className="outlook-email-row-badges">
                {email.is_order_confirmation ? (
                  <span className="outlook-email-pill">Order confirmation</span>
                ) : null}
                {email.is_quotation ? (
                  <span className="outlook-email-pill outlook-email-pill-quote">Quotation</span>
                ) : null}
              </div>
            </div>
            {email.web_link ? (
              <a href={email.web_link} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
                Open
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function OutlookEmails() {
  usePageTitle('Outlook Emails');
  const toast = useToast();
  const [profile, setProfile] = useState('deals');
  const [filter, setFilter] = useState('order_and_quotations');
  const [matchFilter, setMatchFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState(null);
  const [selectedId, setSelectedId] = useState('');

  const comparison = payload?.drive_comparison || null;

  const projects = useMemo(() => {
    let rows = payload?.projects || [];
    if (matchFilter === 'missing_wp') {
      rows = rows.filter((project) => !project.in_workplanner);
    } else if (matchFilter === 'in_wp') {
      rows = rows.filter((project) => !!project.in_workplanner);
    } else if (matchFilter !== 'all') {
      rows = rows.filter((project) => (project.match_status || '') === matchFilter);
    }
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((project) => {
      const hay = [
        project.project_name,
        project.match_status,
        project.workplanner_project?.name,
        ...(project.quotation_forms || []).map((form) => form.name),
        ...(project.emails || []).map((email) => email.subject),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [matchFilter, payload?.projects, search]);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) || null,
    [projects, selectedId],
  );

  const loadList = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/admin/outlook-emails', {
        params: {
          profile,
          filter,
          top: 50,
        },
        timeout: 90000,
      });
      const data = response.data?.data || null;
      setPayload(data);
      const firstId = data?.projects?.[0]?.id || '';
      setSelectedId(firstId);
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to load project emails.');
      setError(message);
      setPayload(null);
      setSelectedId('');
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [filter, profile, toast]);

  useEffect(() => {
    loadList();
  }, [profile, filter]);

  useEffect(() => {
    if (!projects.length) {
      setSelectedId('');
      return;
    }
    if (!projects.some((project) => project.id === selectedId)) {
      setSelectedId(projects[0].id);
    }
  }, [projects, selectedId]);

  const mailboxLabel = useMemo(() => {
    const match = PROFILES.find((item) => item.value === profile);
    return `${match?.label || profile}${payload?.mailbox ? ` · ${payload.mailbox}` : ''}`;
  }, [payload?.mailbox, profile]);

  return (
    <section className="outlook-emails-page">
      <header className="page-header page-header-compact">
        <div className="page-heading page-heading-row">
          <div className="page-heading-copy">
            <h2>Outlook Emails</h2>
            <p className="access-permissions-description">
              Compare Outlook-collected project data against Drive Quotation form packs
              (e.g. Quotation form - Haileybury Turnford).
            </p>
          </div>
          <div className="page-header-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={loadList} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
      </header>

      <div className="outlook-emails-toolbar card">
        <label>
          Mailbox
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {PROFILES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          Email source
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          Drive compare
          <select value={matchFilter} onChange={(e) => setMatchFilter(e.target.value)}>
            {MATCH_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label className="outlook-emails-search">
          Search projects
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Haileybury, LBTH, Cambridge…"
          />
        </label>
        <button type="button" className="btn btn-primary btn-sm" onClick={loadList} disabled={loading}>
          Refresh
        </button>
      </div>

      {comparison ? (
        <div className="outlook-compare-summary card">
          <div>
            <strong>{comparison.drive_projects ?? 0}</strong>
            <span className="muted">Drive Quotation forms</span>
          </div>
          <div>
            <strong>{comparison.matched ?? 0}</strong>
            <span className="muted">Matched to emails</span>
          </div>
          <div>
            <strong>{comparison.in_workplanner ?? 0}</strong>
            <span className="muted">Already in Work Planner</span>
          </div>
          <div>
            <strong>{comparison.missing_in_workplanner ?? 0}</strong>
            <span className="muted">Not in Work Planner</span>
          </div>
          <div>
            <strong>{comparison.with_order_confirmation ?? 0}</strong>
            <span className="muted">Have order confirmation</span>
          </div>
        </div>
      ) : null}

      <div className="outlook-emails-meta muted">
        {mailboxLabel}
        {payload?.fetched_at ? ` · Updated ${formatWhen(payload.fetched_at)}` : ''}
        {` · Showing ${projects.length}`}
        {payload?.total != null ? ` · from ${payload.total} emails` : ''}
        {comparison?.drive_forms != null ? ` · ${comparison.drive_forms} Drive files` : ''}
      </div>

      {error ? (
        <div className="alert alert-error" role="alert">{error}</div>
      ) : null}

      <div className="outlook-emails-layout">
        <div className="outlook-emails-list card">
          {loading && !projects.length ? (
            <p className="muted outlook-emails-empty">Collecting project data…</p>
          ) : null}
          {!loading && !projects.length ? (
            <p className="muted outlook-emails-empty">No projects matched.</p>
          ) : null}
          <ul>
            {projects.map((project) => {
              const active = project.id === selectedId;
              return (
                <li key={project.id}>
                  <button
                    type="button"
                    className={`outlook-email-row${active ? ' is-active' : ''}`}
                    onClick={() => setSelectedId(project.id)}
                  >
                    <div className="outlook-email-row-top">
                      <strong title={project.project_name}>{project.project_name || 'Untitled project'}</strong>
                      <span>{formatWhen(project.latest_received_at)}</span>
                    </div>
                    <div className="outlook-email-row-from muted">
                      {matchStatusLabel(project.match_status)}
                      {` · ${project.email_count || 0} email${(project.email_count || 0) === 1 ? '' : 's'}`}
                      {project.order_confirmation?.cost ? ` · ${formatMoney(project.order_confirmation.cost)}` : ''}
                    </div>
                    <div className="outlook-email-row-badges">
                      <span className={`outlook-email-pill outlook-email-pill-match-${project.match_status || 'unknown'}`}>
                        {matchStatusLabel(project.match_status)}
                      </span>
                      {project.in_workplanner ? (
                        <span className="outlook-email-pill outlook-email-pill-wp">In Work Planner</span>
                      ) : (
                        <span className="outlook-email-pill outlook-email-pill-missing-wp">Not in Work Planner</span>
                      )}
                      {project.has_order_confirmation ? (
                        <span className="outlook-email-pill">Order confirmation</span>
                      ) : null}
                      {project.has_quotation_form ? (
                        <span className="outlook-email-pill outlook-email-pill-quote">Quotation form</span>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="outlook-emails-detail card">
          {!selected ? (
            <p className="muted outlook-emails-empty">Select a project to view collected data.</p>
          ) : (
            <>
              <div className="outlook-emails-detail-header">
                <h3>{selected.project_name || 'Untitled project'}</h3>
                <p className="muted">
                  {matchStatusLabel(selected.match_status)}
                  {` · ${selected.email_count || 0} email${(selected.email_count || 0) === 1 ? '' : 's'}`}
                  {selected.latest_received_at ? ` · Latest ${formatWhen(selected.latest_received_at)}` : ''}
                </p>
                <div className="outlook-email-row-badges">
                  <span className={`outlook-email-pill outlook-email-pill-match-${selected.match_status || 'unknown'}`}>
                    {matchStatusLabel(selected.match_status)}
                  </span>
                  {selected.in_workplanner ? (
                    <span className="outlook-email-pill outlook-email-pill-wp">In Work Planner</span>
                  ) : (
                    <span className="outlook-email-pill outlook-email-pill-missing-wp">Not in Work Planner</span>
                  )}
                  {selected.in_drive ? (
                    <span className="outlook-email-pill outlook-email-pill-quote">In Drive</span>
                  ) : (
                    <span className="outlook-email-pill outlook-email-pill-nofile">Not in Drive</span>
                  )}
                  {selected.in_outlook ? (
                    <span className="outlook-email-pill">In emails</span>
                  ) : (
                    <span className="outlook-email-pill outlook-email-pill-nofile">Not in emails</span>
                  )}
                  {selected.has_order_confirmation ? (
                    <span className="outlook-email-pill">Order confirmation</span>
                  ) : (
                    <span className="outlook-email-pill outlook-email-pill-nofile">No order confirmation</span>
                  )}
                </div>
              </div>

              {selected.in_workplanner && selected.workplanner_project ? (
                <div className="outlook-project-section">
                  <div className="outlook-project-section-head">
                    <h4>Work Planner project</h4>
                  </div>
                  <p className="muted outlook-project-email-meta">
                    Matched to <strong>{selected.workplanner_project.name}</strong>
                    {selected.workplanner_project.status ? ` · ${selected.workplanner_project.status}` : ''}
                    {selected.workplanner_project.id ? ` · #${selected.workplanner_project.id}` : ''}
                  </p>
                </div>
              ) : (
                <div className="outlook-project-section outlook-project-missing-wp">
                  <div className="outlook-project-section-head">
                    <h4>Work Planner project</h4>
                  </div>
                  <p className="muted outlook-project-email-meta">
                    No matching project found in Work Planner yet.
                  </p>
                </div>
              )}

              <ProjectFacts order={selected.order_confirmation} />
              <QuotationFormsPanel forms={selected.quotation_forms} />
              <SourceEmails emails={selected.emails} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
