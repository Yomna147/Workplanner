import { useEffect, useState } from 'react';
import api from '../api/client';
import { getApiErrorMessage } from '../utils/apiErrors';

export default function AddTeamModal({ open, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [teams, setTeams] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadTeams = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/teams');
      setTeams(data.data);
      setError('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load teams.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadTeams();
      setName('');
      setEditingId(null);
      setError('');
    }
  }, [open]);

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Enter a team name.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/teams/${editingId}`, { name: name.trim() });
      } else {
        await api.post('/teams', { name: name.trim() });
      }
      setName('');
      setEditingId(null);
      onSaved();
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to save team.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this team?')) return;
    try {
      await api.delete(`/teams/${id}`);
      await loadTeams();
      onSaved();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to delete team.'));
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" role="presentation" onDoubleClick={onClose}>
      <div
        className="modal-card modal-card-compact"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{editingId ? 'Edit Team' : 'Add Team'}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-error">{error}</div>}
          <label>
            Team name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Team name"
              disabled={saving}
            />
          </label>
          <div className="table-card" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={2}>Loading teams…</td>
                  </tr>
                ) : (
                  teams.map((team) => (
                    <tr key={team.id}>
                      <td>{team.name}</td>
                      <td className="table-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={saving}
                          onClick={() => {
                            setName(team.name);
                            setEditingId(team.id);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={saving}
                          onClick={() => handleDelete(team.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-actions" style={{ padding: '0 24px 24px' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Close
          </button>
          <button type="button" className="btn btn-save" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
