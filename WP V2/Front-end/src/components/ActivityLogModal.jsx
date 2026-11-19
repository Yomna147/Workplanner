import { useEffect, useState } from 'react';
import api from '../api/client';
import ActivityLogTable from './ActivityLogTable';
import Modal from './Modal';

export default function ActivityLogModal({
  open,
  onClose,
  area = 'pde',
  limit = 30,
  title = 'Edits Log History',
  emptyMessage = 'No PDE changes recorded yet.',
  endpoint = '/admin/activity-logs',
  extraParams = null,
  onLogClick = null,
}) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    let cancelled = false;

    const loadLogs = async () => {
      setLoading(true);
      setError('');
      try {
        const params = {
          limit,
          page: 1,
          ...(extraParams || {}),
        };
        if (!extraParams?.section) {
          params.area = area;
        }
        const response = await api.get(endpoint, { params });
        if (!cancelled) {
          setLogs(response.data.data);
        }
      } catch {
        if (!cancelled) {
          setError('Unable to load activity log.');
          setLogs([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadLogs();

    return () => {
      cancelled = true;
    };
  }, [open, area, limit, endpoint, extraParams]);

  return (
    <Modal open={open} title={title} onClose={onClose} size="wide">
      <div className="activity-log-modal">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <ActivityLogTable
        logs={logs}
        loading={loading}
        emptyMessage={emptyMessage}
        onLogClick={onLogClick}
      />
      </div>
    </Modal>
  );
}
