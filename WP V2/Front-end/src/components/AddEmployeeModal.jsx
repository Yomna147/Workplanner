import { useEffect, useState } from 'react';
import api from '../api/client';

const emptyForm = {
  first_name: '',
  last_name: '',
  email: '',
  position: 1,
  team_id: '',
};

export default function AddEmployeeModal({ open, onClose, onSaved, teams, defaultTeamId = '' }) {
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({
        ...emptyForm,
        team_id: defaultTeamId ? String(defaultTeamId) : '',
      });
      setError('');
    }
  }, [open, defaultTeamId]);

  const handleSave = async () => {
    if (!form.first_name.trim()) {
      setError('First name is required.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await api.post('/employees', {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || null,
        email: form.email.trim() || null,
        team_id: form.team_id ? Number(form.team_id) : null,
        position: Number(form.position) || 1,
      });
      onSaved();
      onClose();
    } catch {
      setError('Unable to create employee.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" role="presentation" onDoubleClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>New employee</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body modal-form">
          {error && <div className="alert alert-error">{error}</div>}
          <label>
            First name
            <input
              value={form.first_name}
              onChange={(e) => setForm({ ...form, first_name: e.target.value })}
              placeholder="First name"
              required
            />
          </label>
          <label>
            Last name
            <input
              value={form.last_name}
              onChange={(e) => setForm({ ...form, last_name: e.target.value })}
              placeholder="Optional"
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="Optional"
            />
          </label>
          <label>
            Position
            <input
              type="number"
              min="1"
              max="99"
              value={form.position}
              onChange={(e) => setForm({ ...form, position: e.target.value })}
            />
          </label>
          <label>
            Team
            <select
              value={form.team_id}
              onChange={(e) => setForm({ ...form, team_id: e.target.value })}
            >
              <option value="">No team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal-actions" style={{ padding: '0 24px 24px' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Creating...' : 'Create employee'}
          </button>
        </div>
      </div>
    </div>
  );
}
