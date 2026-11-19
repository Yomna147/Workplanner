import { useEffect, useState } from 'react';
import api from '../api/client';
import { getApiErrorMessage } from '../utils/apiErrors';
import { importHoursFromGoogleSheet } from '../utils/googleSheets';
import Modal from './Modal';

export default function UpdateHoursModal({ open, onClose, onSave }) {
  const [nrms, setNrms] = useState([]);
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetName, setSheetName] = useState('Adjudication - TEMPL');
  const [rows, setRows] = useState([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;

    const loadNrms = async () => {
      try {
        const response = await api.get('/nrms');
        setNrms(response.data.data ?? []);
      } catch (err) {
        setNrms([]);
        setError(getApiErrorMessage(err, 'Unable to load NRM task list.'));
      }
    };

    loadNrms();
  }, [open]);

  const reset = () => {
    setSheetUrl('');
    setSheetName('Adjudication - TEMPL');
    setRows([]);
    setError('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleImport = async (event) => {
    event.preventDefault();
    setImporting(true);
    setError('');

    try {
      const imported = await importHoursFromGoogleSheet({
        sheetUrl,
        sheetName,
        nrms,
      });

      setRows(
        imported.map((row) => ({
          taskName: row.taskName,
          est: row.est,
        })),
      );
    } catch (err) {
      setError(err.message || 'Failed to import spreadsheet.');
    } finally {
      setImporting(false);
    }
  };

  const handleSave = () => {
    if (rows.length === 0) {
      setError('Import spreadsheet data before saving.');
      return;
    }

    onSave(
      rows.map((row) => ({
        taskName: row.taskName,
        est: row.est === '' || row.est == null ? 0 : row.est,
      })),
    );
    handleClose();
  };

  const updateRow = (index, field, value) => {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row,
      ),
    );
  };

  return (
    <Modal open={open} title="Update hours" onClose={handleClose} size="wide">
      <p className="muted">
        Import estimated hours from a Google Sheet and apply them to matching task names in the
        current part.
      </p>

      <form className="update-hours-import" onSubmit={handleImport}>
        <div className="sheet-import-bar">
          <label>
            Spreadsheet link
            <input
              type="url"
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              required
            />
          </label>
          <label>
            Sheet name
            <input
              type="text"
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              placeholder="Adjudication - TEMPL"
              required
            />
          </label>
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={importing || !sheetUrl.trim()}
          >
            {importing ? 'Importing...' : 'Import'}
          </button>
        </div>
      </form>

      {error && <div className="alert alert-error">{error}</div>}

      {rows.length > 0 && (
        <div className="update-hours-rows">
          <div className="update-hours-rows-header">
            <span>Task name</span>
            <span>Est (hours)</span>
          </div>
          {rows.map((row, index) => (
            <div key={`${row.taskName}-${index}`} className="update-hours-row">
              <input
                type="text"
                value={row.taskName}
                onChange={(e) => updateRow(index, 'taskName', e.target.value)}
              />
              <input
                type="text"
                value={row.est}
                onChange={(e) => updateRow(index, 'est', e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={handleClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-save"
          disabled={rows.length === 0}
          onClick={handleSave}
        >
          Apply to tasks
        </button>
      </div>
    </Modal>
  );
}
