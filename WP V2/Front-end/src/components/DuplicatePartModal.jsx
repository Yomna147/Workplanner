import { useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import DisplayDateInput from './DisplayDateInput';

function monthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (date) => date.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export default function DuplicatePartModal({
  open,
  onClose,
  sourceProjectId,
  sourcePartId,
  sourcePartName,
  onSuccess,
}) {
  const bounds = monthBounds();
  const [partName, setPartName] = useState('');
  const [pp, setPp] = useState('');
  const [startDate, setStartDate] = useState(bounds.start);
  const [endDate, setEndDate] = useState(bounds.end);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const response = await api.post('/projects/copy', {
        type: 'duplicate_part',
        source_project_id: Number(sourceProjectId),
        source_part_id: Number(sourcePartId),
        part_name: partName.trim(),
        pp: pp === '' ? null : pp,
        start_date: startDate || null,
        end_date: endDate || null,
      });

      onSuccess(response.data.data);
      onClose();
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.errors?.part_name?.[0] ||
        'Unable to duplicate part.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} title="Duplicate Part" onClose={onClose}>
      <p className="muted">
        Copy all tasks from <strong>{sourcePartName}</strong> into a new part on the same
        project.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <form className="form-grid modal-form" onSubmit={handleSubmit}>
        <label className="full-width">
          New part name
          <input
            value={partName}
            onChange={(e) => setPartName(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          PP
          <input
            type="number"
            value={pp}
            onChange={(e) => setPp(e.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Start date (Doc Supply)
          <DisplayDateInput value={startDate} onChange={setStartDate} />
        </label>
        <label>
          End date (Completion)
          <DisplayDateInput value={endDate} onChange={setEndDate} />
        </label>
        <div className="full-width modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-save" disabled={submitting}>
            {submitting ? 'Copying...' : 'Duplicate part'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
