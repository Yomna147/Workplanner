import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { getApiErrorMessage } from '../utils/apiErrors';
import { importAvailabilityFromGoogleSheet } from '../utils/availabilityImport';
import { fetchSpreadsheetSheetTitles } from '../utils/googleSheets';
import {
  DEFAULT_AVAILABILITY_SPREADSHEET_URL,
  filterMonthSheetTabs,
} from '../utils/scheduledAvailabilityImport';
import ImportProgressPanel from './ImportProgressPanel';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function currentMonthLabel(date = new Date()) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

function pickDefaultTabs(tabs = []) {
  if (!tabs.length) return [];
  const current = currentMonthLabel().toLowerCase();
  const match = tabs.find((tab) => String(tab).trim().toLowerCase() === current);
  return match ? [match] : [];
}

export default function ImportAvailabilityModal({ open, onClose, employees, onImported }) {
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_AVAILABILITY_SPREADSHEET_URL);
  const [selectedSheetTabs, setSelectedSheetTabs] = useState([]);
  const [availableSheetTabs, setAvailableSheetTabs] = useState([]);
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [tabsError, setTabsError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressStatus, setProgressStatus] = useState('idle');
  const [progressSteps, setProgressSteps] = useState([]);
  const [progressSummary, setProgressSummary] = useState('');
  const [progressError, setProgressError] = useState('');

  const availableToAdd = useMemo(
    () => availableSheetTabs.filter((tab) => !selectedSheetTabs.includes(tab)),
    [availableSheetTabs, selectedSheetTabs],
  );

  const loadTabs = useCallback(async (url) => {
    const targetUrl = (url || '').trim() || DEFAULT_AVAILABILITY_SPREADSHEET_URL;
    setLoadingTabs(true);
    setTabsError('');
    try {
      const tabs = filterMonthSheetTabs(await fetchSpreadsheetSheetTitles(targetUrl));
      setAvailableSheetTabs(tabs);
      setSelectedSheetTabs((current) => {
        const stillValid = current.filter((tab) => tabs.includes(tab));
        if (stillValid.length) return stillValid;
        return pickDefaultTabs(tabs);
      });
      if (!tabs.length) {
        setTabsError('No month sheet tabs found for this year (expected names like “January 2026”).');
      }
    } catch (err) {
      setAvailableSheetTabs([]);
      setSelectedSheetTabs([]);
      setTabsError(getApiErrorMessage(err, 'Unable to load sheet tabs.'));
    } finally {
      setLoadingTabs(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    loadTabs(sheetUrl);
    return undefined;
    // Load once when the modal opens; URL changes reload via blur/Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadTabs]);

  if (!open) {
    return (
      <ImportProgressPanel
        open={progressOpen}
        steps={progressSteps}
        status={progressStatus}
        summary={progressSummary}
        error={progressError}
        onDismiss={() => setProgressOpen(false)}
      />
    );
  }

  const handleClose = () => {
    if (loading) return;
    setError('');
    setMessage('');
    onClose();
  };

  const addSheetTab = (tabName) => {
    const value = String(tabName || '').trim();
    if (!value) return;
    setSelectedSheetTabs((current) => (
      current.includes(value) ? current : [...current, value]
    ));
  };

  const removeSheetTab = (tabName) => {
    setSelectedSheetTabs((current) => current.filter((tab) => tab !== tabName));
  };

  const updateProgressStep = (index, patch) => {
    setProgressSteps((current) => current.map((step, stepIndex) => (
      stepIndex === index ? { ...step, ...patch } : step
    )));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!selectedSheetTabs.length) {
      setError('Select at least one sheet tab to import.');
      return;
    }

    setLoading(true);
    setError('');
    setMessage('');
    setProgressOpen(true);
    setProgressStatus('running');
    setProgressSummary('');
    setProgressError('');
    setProgressSteps(selectedSheetTabs.map((label) => ({
      label,
      status: 'pending',
      detail: '',
    })));

    try {
      let totalRows = 0;
      let maxEmployees = 0;

      for (let index = 0; index < selectedSheetTabs.length; index += 1) {
        const tabName = selectedSheetTabs[index];
        updateProgressStep(index, { status: 'running', detail: 'Fetching sheet…' });

        const imports = await importAvailabilityFromGoogleSheet({
          sheetUrl: sheetUrl.trim(),
          sheetName: tabName,
          employees,
        });

        const { data } = await api.post('/availabilities/import', { imports });
        const importedRows = data.imported_rows ?? 0;
        const employeeCount = new Set(imports.map((item) => item.employee_id)).size;
        totalRows += importedRows;
        maxEmployees = Math.max(maxEmployees, employeeCount);

        updateProgressStep(index, {
          status: 'done',
          detail: `${importedRows} rows from ${tabName}`,
        });
      }

      const summary = `Imported ${totalRows} day rows for ${maxEmployees} employee(s) from ${selectedSheetTabs.length} tab(s).`;
      setProgressStatus('done');
      setProgressSummary(summary);
      setMessage(summary);
      onImported({ silent: true });
    } catch (err) {
      const failureMessage = getApiErrorMessage(err, 'Import failed.');
      setProgressStatus('error');
      setProgressError(failureMessage);
      setProgressSteps((current) => current.map((step) => (
        step.status === 'running'
          ? { ...step, status: 'error', detail: failureMessage }
          : step
      )));
      setError(failureMessage);
    } finally {
      setLoading(false);
    }
  };

  const importLabel = selectedSheetTabs.length <= 1
    ? 'Collect availability'
    : `Collect ${selectedSheetTabs.length} sheets`;

  return (
    <>
      <ImportProgressPanel
        open={progressOpen}
        steps={progressSteps}
        status={progressStatus}
        summary={progressSummary}
        error={progressError}
        onDismiss={() => setProgressOpen(false)}
      />

      <div className="modal-overlay" role="presentation" onDoubleClick={handleClose}>
        <div
          className="modal-card modal-card-compact import-availability-modal"
          role="dialog"
          aria-labelledby="import-availability-title"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <h3 id="import-availability-title">Import availability</h3>
            <button type="button" className="modal-close" onClick={handleClose} aria-label="Close">
              ×
            </button>
          </div>
          <form className="modal-body modal-form" onSubmit={handleSubmit}>
            {error && <div className="alert alert-error">{error}</div>}
            {message && <div className="alert alert-success">{message}</div>}

            <p className="muted-help">
              Import from a shared Google Sheet (Viewer access). Add one or more sheet tabs,
              then import them together. Employee names must match Operatives Allocation.
            </p>

            <label>
              Spreadsheet link
              <div className="import-availability-url-row">
                <input
                  type="url"
                  value={sheetUrl}
                  onChange={(e) => setSheetUrl(e.target.value)}
                  onBlur={() => loadTabs(sheetUrl)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={() => loadTabs(sheetUrl)}
                  disabled={loading || loadingTabs}
                >
                  {loadingTabs ? 'Loading…' : 'Load tabs'}
                </button>
              </div>
            </label>

            <div className="import-availability-tabs-field">
              <span className="import-availability-tabs-label-text">Sheet tabs</span>
              <div className="training-employee-chips import-availability-sheet-chips">
                {selectedSheetTabs.map((tab) => (
                  <span key={tab} className="training-employee-chip">
                    <span className="import-availability-sheet-chip-label">{tab}</span>
                    <button
                      type="button"
                      className="training-employee-chip-remove"
                      onClick={() => removeSheetTab(tab)}
                      disabled={loading}
                      aria-label={`Remove ${tab}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <div className="training-employee-add">
                  <div className="training-employee-picker">
                    <select
                      className="training-employee-picker-select"
                      value=""
                      disabled={loading || loadingTabs || availableSheetTabs.length === 0}
                      onChange={(event) => {
                        const value = event.target.value;
                        event.target.value = '';
                        addSheetTab(value);
                      }}
                      aria-label="Select sheet tab"
                    >
                      <option value="">
                        {loadingTabs
                          ? 'Loading tabs…'
                          : availableSheetTabs.length === 0
                            ? 'No tabs loaded'
                            : availableToAdd.length === 0
                              ? 'All tabs selected'
                              : 'Select sheet tab…'}
                      </option>
                      {availableToAdd.map((tab) => (
                        <option key={tab} value={tab}>{tab}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              <p className="muted-help" id="import-availability-tabs-help">
                {tabsError || 'Only months for the year in the sheet titles are listed. Add as many as you need — each is imported in one run.'}
              </p>
            </div>
          </form>
          <div className="modal-actions" style={{ padding: '0 24px 24px' }}>
            <button type="button" className="btn btn-secondary" onClick={handleClose} disabled={loading}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-save"
              onClick={handleSubmit}
              disabled={loading || !selectedSheetTabs.length}
            >
              {loading ? 'Importing...' : importLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
