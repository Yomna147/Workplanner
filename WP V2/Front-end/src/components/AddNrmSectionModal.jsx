import { useEffect, useState } from 'react';
import api from '../api/client';
import { getApiErrorMessage } from '../utils/apiErrors';

export default function AddNrmSectionModal({ open, onClose, onSaved }) {
  const [number, setNumber] = useState('');
  const [nrms, setNrms] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadNrms = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/nrms');
      setNrms(data.data);
      setError('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load NRM sections.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadNrms();
      setNumber('');
      setEditingId(null);
      setError('');
    }
  }, [open]);

  const handleSave = async () => {
    if (!number.trim()) {
      setError('Enter an NRM number.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/nrms/${editingId}`, { number: number.trim() });
      } else {
        await api.post('/nrms', { number: number.trim() });
      }
      setNumber('');
      setEditingId(null);
      onSaved();
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to save NRM section.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this NRM section?')) return;
    try {
      await api.delete(`/nrms/${id}`);
      await loadNrms();
      onSaved();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to delete NRM section.'));
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
          <h3>{editingId ? 'Edit NRM Section' : 'Add NRM Section'}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-error">{error}</div>}
          <label>
            NRM number
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="e.g. 1.1"
              disabled={saving}
            />
          </label>
          <div className="table-card" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>NRM number</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={2}>Loading NRM sections…</td>
                  </tr>
                ) : (
                  nrms.map((nrm) => (
                    <tr key={nrm.id}>
                      <td>{nrm.number}</td>
                      <td className="table-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={saving}
                          onClick={() => {
                            setNumber(nrm.number || '');
                            setEditingId(nrm.id);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={saving}
                          onClick={() => handleDelete(nrm.id)}
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
