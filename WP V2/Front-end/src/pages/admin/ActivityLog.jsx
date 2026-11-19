import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import ActivityLogTable from '../../components/ActivityLogTable';
import DisplayDateInput from '../../components/DisplayDateInput';
import { TablePageSkeleton } from '../../components/PageSkeleton';

const pageOptions = [
  { value: '', label: 'All pages' },
  { value: 'pde', label: 'Project Data Entry' },
  { value: 'dl', label: 'DL Input Hours' },
  { value: 'Trainings', label: 'Trainings' },
  { value: 'histogram', label: 'Resource Histogram' },
];

function userLabel(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.login_name || `User #${user.id}`;
}

export default function ActivityLog() {
  const [logs, setLogs] = useState([]);
  const [users, setUsers] = useState([]);
  const [pageFilter, setPageFilter] = useState('');
  const [userId, setUserId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, pages: 1, limit: 50 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const loadUsers = async () => {
      try {
        const response = await api.get('/admin/users');
        if (!cancelled) {
          setUsers(response.data.data ?? []);
        }
      } catch {
        if (!cancelled) {
          setUsers([]);
        }
      }
    };

    loadUsers();

    return () => {
      cancelled = true;
    };
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/activity-logs', {
        params: {
          area: pageFilter || undefined,
          user_id: userId || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          page,
          limit: 50,
        },
      });
      setLogs(response.data.data);
      setMeta(response.data.meta);
      setError('');
    } catch (err) {
      const message = err.response?.data?.message || 'Unable to load activity log.';
      setError(message);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, page, pageFilter, userId]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const resetFilters = () => {
    setPageFilter('');
    setUserId('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  if (loading && logs.length === 0) {
    return <TablePageSkeleton rows={10} cols={5} />;
  }

  return (
    <section className="activity-log-page">
      <div className="page-heading admin-toolbar activity-log-toolbar">
        <div>
          <h2>Activity Log</h2>
        </div>
        <div className="admin-toolbar-actions activity-log-filters">
          <label className="activity-log-filter">
            Employee
            <select
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All employees</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {userLabel(user)}
                </option>
              ))}
            </select>
          </label>

          <label className="activity-log-filter">
            From
            <DisplayDateInput
              compact
              className="activity-log-date-input"
              value={dateFrom}
              placeholder="Any date"
              onChange={(value) => {
                setDateFrom(value);
                setPage(1);
              }}
            />
          </label>

          <label className="activity-log-filter">
            To
            <DisplayDateInput
              compact
              className="activity-log-date-input"
              value={dateTo}
              placeholder="Any date"
              onChange={(value) => {
                setDateTo(value);
                setPage(1);
              }}
            />
          </label>

          <label className="activity-log-filter">
            Page
            <select
              value={pageFilter}
              onChange={(event) => {
                setPageFilter(event.target.value);
                setPage(1);
              }}
            >
              {pageOptions.map((option) => (
                <option key={option.value || 'all'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="btn btn-secondary btn-compact" onClick={loadLogs}>
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-compact"
            onClick={resetFilters}
            disabled={!pageFilter && !userId && !dateFrom && !dateTo}
          >
            Clear filters
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="table-card admin-table-wrap activity-log-table-card">
        <ActivityLogTable
          logs={logs}
          loading={loading && logs.length > 0}
          showPageColumn
        />
      </div>

      {meta.pages > 1 && (
        <div className="activity-log-pagination">
          <button
            type="button"
            className="btn btn-secondary btn-compact"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span className="muted">
            Page {page} of {meta.pages} ({meta.total} entries)
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-compact"
            disabled={page >= meta.pages || loading}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </div>
      )}

      <p className="muted activity-log-back-link">
        <Link to="/projects">Back to Project Data Entry</Link>
      </p>
    </section>
  );
}
