import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import ImportAvailabilityModal from '../../components/ImportAvailabilityModal';
import AvailabilityRowActions from '../../components/AvailabilityRowActions';
import AvailabilityTimeInput from '../../components/AvailabilityTimeInput';
import DisplayDateInput from '../../components/DisplayDateInput';
import { AvailabilityPageSkeleton } from '../../components/PageSkeleton';
import PageHeader from '../../components/PageHeader';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { canPageAction } from '../../utils/userPermissions';
import { employeeDisplayName } from '../../utils/employeeNames';
import { sortEmployeesByTeamThenName } from '../../utils/teamOrder';
import { formatCompactDisplayDate, formatDisplayDate, toStorageDate } from '../../utils/dateFormat';
import {
  computeRowTotal,
  convertTimeToMinutes,
  dayName,
  formatMonthValue,
  formatTotalHours,
  isWeekendDate,
  listDaysInRange,
  monthStartEnd,
  sortAvailabilities,
  sumFilteredMinutes,
} from '../../utils/availabilityTime';

const TIME_FIELDS = ['strt1', 'end1', 'strt2', 'end2', 'strt3', 'end3', 'strt4', 'end4'];

const TIME_BLOCKS = [
  { from: 'strt1', to: 'end1', label: 'Shift 1' },
  { from: 'strt2', to: 'end2', label: 'Shift 2' },
  { from: 'strt3', to: 'end3', label: 'Shift 3' },
  { from: 'strt4', to: 'end4', label: 'Shift 4' },
];

const TABLE_COLUMN_COUNT = 2 + TIME_BLOCKS.length * 2 + 2;

function formatTimeDisplay(value) {
  if (!value || value === '00:00') return '—';
  return value;
}

function formatRowTotal(total, isEmpty) {
  if (isEmpty || !total || total === '00:00') return '—';
  return total;
}

function emptyRow(employeeId, date) {
  return {
    id: `temp-${Date.now()}-${Math.random()}`,
    employee_id: employeeId,
    date: date || toStorageDate(new Date()),
    strt1: '',
    end1: '',
    strt2: '',
    end2: '',
    strt3: '',
    end3: '',
    strt4: '',
    end4: '',
    total: '00:00',
    total_ava: '00:00',
    Total: '00:00',
  };
}

function normalizeRow(row) {
  const total = row.total || row.Total || row.total_ava || '00:00';
  return {
    ...row,
    date: typeof row.date === 'string' ? row.date.slice(0, 10) : row.date,
    total,
    total_ava: total,
    Total: total,
  };
}

function duplicateRowData(sourceRow, employeeId) {
  const total = sourceRow.total || sourceRow.Total || sourceRow.total_ava || '00:00';
  return {
    id: `temp-${Date.now()}-${Math.random()}`,
    employee_id: employeeId,
    date: sourceRow.date,
    strt1: sourceRow.strt1 || '',
    end1: sourceRow.end1 || '',
    strt2: sourceRow.strt2 || '',
    end2: sourceRow.end2 || '',
    strt3: sourceRow.strt3 || '',
    end3: sourceRow.end3 || '',
    strt4: sourceRow.strt4 || '',
    end4: sourceRow.end4 || '',
    total,
    total_ava: total,
    Total: total,
  };
}

function insertIdAfter(order, afterId, newId) {
  const afterKey = String(afterId);
  const idx = order.indexOf(afterKey);
  if (idx === -1) return [...order, String(newId)];
  const next = [...order];
  next.splice(idx + 1, 0, String(newId));
  return next;
}

function isTimeOrderValid(row, field, value) {
  const newMinutes = convertTimeToMinutes(value);
  if (field === 'strt2' && newMinutes < convertTimeToMinutes(row.end1)) return false;
  if (field === 'strt3' && newMinutes < convertTimeToMinutes(row.end2)) return false;
  if (field === 'strt4' && newMinutes < convertTimeToMinutes(row.end3)) return false;
  if (field === 'end1' && newMinutes <= convertTimeToMinutes(row.strt1)) return false;
  if (field === 'end2' && newMinutes <= convertTimeToMinutes(row.strt2)) return false;
  if (field === 'end3' && newMinutes <= convertTimeToMinutes(row.strt3)) return false;
  if (field === 'end4' && newMinutes <= convertTimeToMinutes(row.strt4)) return false;
  return true;
}

export default function UserAvailability() {
  const toast = useToast();
  const { user } = useAuth();
  const canEditAvailability = canPageAction(user, 'User Availability', 'edit');
  const canImportAvailability = canPageAction(user, 'User Availability', 'import');
  const canDuplicateWeek = canPageAction(user, 'User Availability', 'duplicate_week');
  const now = new Date();
  const [employees, setEmployees] = useState([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [rows, setRows] = useState([]);
  const [draftRows, setDraftRows] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState(formatMonthValue(now));
  const [startDate, setStartDate] = useState(monthStartEnd(formatMonthValue(now)).start);
  const [endDate, setEndDate] = useState(monthStartEnd(formatMonthValue(now)).end);
  const [loadingEmployees, setLoadingEmployees] = useState(true);
  const [loadingAvailabilities, setLoadingAvailabilities] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [duplicateTargetWeek, setDuplicateTargetWeek] = useState('');
  const [rowOrderIds, setRowOrderIds] = useState([]);
  const [editingRowId, setEditingRowId] = useState(null);

  const selectedEmployee = employees.find((e) => String(e.id) === String(selectedEmployeeId));

  const allRows = useMemo(() => [...rows, ...draftRows], [rows, draftRows]);

  const rowById = useMemo(() => {
    const map = new Map();
    allRows.forEach((row) => map.set(String(row.id), row));
    return map;
  }, [allRows]);

  const loadEmployees = useCallback(async () => {
    setLoadingEmployees(true);
    try {
      const { data } = await api.get('/employees');
      setEmployees(sortEmployeesByTeamThenName(data.data || []));
      setError('');
    } catch {
      setError('Unable to load employees.');
      setEmployees([]);
    } finally {
      setLoadingEmployees(false);
    }
  }, []);

  const loadEmployeeAvailabilities = useCallback(async (employeeId, from, to) => {
    if (!employeeId) {
      setRows([]);
      setRowOrderIds([]);
      return;
    }

    setLoadingAvailabilities(true);
    try {
      const { data } = await api.get(`/employees/${employeeId}/availabilities`, {
        params: { from, to },
      });
      const normalized = sortAvailabilities((data.data || []).map(normalizeRow));
      setRows(normalized);
      setDraftRows([]);
      setRowOrderIds(normalized.map((row) => String(row.id)));
      setEditingRowId(null);
      setError('');
    } catch {
      setError('Unable to load availability for this employee.');
      setRows([]);
      setDraftRows([]);
      setRowOrderIds([]);
    } finally {
      setLoadingAvailabilities(false);
    }
  }, []);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  useEffect(() => {
    if (!selectedEmployeeId) {
      setRows([]);
      setDraftRows([]);
      setRowOrderIds([]);
      setEditingRowId(null);
      return;
    }

    loadEmployeeAvailabilities(selectedEmployeeId, startDate, endDate);
  }, [selectedEmployeeId, startDate, endDate, loadEmployeeAvailabilities]);

  useEffect(() => {
    const allIds = allRows.map((row) => String(row.id));
    setRowOrderIds((prev) => {
      const kept = prev.filter((id) => allIds.includes(id));
      const missing = allIds.filter((id) => !kept.includes(id));
      if (missing.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...missing];
    });
  }, [allRows]);

  const displayRows = useMemo(() => {
    if (!selectedEmployee) {
      return [];
    }

    const orderedRows = rowOrderIds
      .map((id) => rowById.get(id))
      .filter(Boolean)
      .filter((row) => row.date >= startDate && row.date <= endDate);

    const rowsByDate = new Map();
    orderedRows.forEach((row) => {
      const existing = rowsByDate.get(row.date) || [];
      existing.push(row);
      rowsByDate.set(row.date, existing);
    });

    return listDaysInRange(startDate, endDate).flatMap((day) => {
      const rowsForDay = rowsByDate.get(day);
      if (rowsForDay?.length) {
        return rowsForDay;
      }

      return [{
        ...emptyRow(selectedEmployee.id, day),
        id: `placeholder-${day}`,
        _placeholder: true,
      }];
    });
  }, [rowOrderIds, rowById, startDate, endDate, selectedEmployee]);

  const totalMinutes = useMemo(
    () => sumFilteredMinutes([...rows, ...draftRows], startDate, endDate),
    [rows, draftRows, startDate, endDate],
  );

  const handleEmployeeChange = (event) => {
    setSelectedEmployeeId(event.target.value);
    setDraftRows([]);
    setEditingRowId(null);
  };

  const handleMonthChange = (event) => {
    const month = event.target.value;
    setSelectedMonth(month);
    const range = monthStartEnd(month);
    setStartDate(range.start);
    setEndDate(range.end);
  };

  const handleOpenImport = () => {
    setShowImport(true);
  };

  const getPromotedRow = (rowId) => {
    if (!selectedEmployee || !String(rowId).startsWith('placeholder-')) {
      return { targetId: rowId, promotedRow: null };
    }

    const date = String(rowId).slice('placeholder-'.length);
    const existingDraft = draftRows.find((row) => row.date === date);
    if (existingDraft) {
      return { targetId: existingDraft.id, promotedRow: null };
    }

    const promotedRow = emptyRow(selectedEmployee.id, date);
    return { targetId: promotedRow.id, promotedRow };
  };

  const promotePlaceholderRow = (rowId) => {
    const result = getPromotedRow(rowId);
    if (!result.promotedRow) {
      return result;
    }

    setDraftRows((prev) => [...prev, result.promotedRow]);
    setRowOrderIds((prev) => [...prev, String(result.promotedRow.id)]);

    if (String(editingRowId) === String(rowId)) {
      setEditingRowId(result.targetId);
    }

    return result;
  };

  const updateRow = (rowId, field, value) => {
    const { targetId, promotedRow } = String(rowId).startsWith('placeholder-')
      ? getPromotedRow(rowId)
      : { targetId: rowId, promotedRow: null };

    if (promotedRow) {
      setRowOrderIds((prev) => (
        prev.includes(String(promotedRow.id)) ? prev : [...prev, String(promotedRow.id)]
      ));
      if (String(editingRowId) === String(rowId)) {
        setEditingRowId(targetId);
      }
    }

    const apply = (list, setter) => {
      let nextList = list;
      if (promotedRow && !list.some((row) => String(row.id) === String(promotedRow.id))) {
        nextList = [...list, promotedRow];
      }

      setter(
        nextList.map((row) => {
          if (String(row.id) !== String(targetId)) return row;
          if (TIME_FIELDS.includes(field) && !isTimeOrderValid(row, field, value)) {
            return row;
          }
          const updated = {
            ...row,
            [field]: field === 'date' ? String(value).slice(0, 10) : value,
          };
          if (field !== 'date' && TIME_FIELDS.includes(field)) {
            const total = computeRowTotal(updated);
            updated.total = total;
            updated.total_ava = total;
            updated.Total = total;
          }
          return updated;
        }),
      );
    };

    if (String(targetId).startsWith('temp-')) {
      apply(draftRows, setDraftRows);
    } else {
      apply(rows, setRows);
    }
  };

  const beginEditRow = (row) => {
    if (row._placeholder) {
      const { targetId } = promotePlaceholderRow(row.id);
      setEditingRowId(targetId);
      return;
    }

    setEditingRowId(row.id);
  };

  const addRow = () => {
    if (!selectedEmployee) return;
    const newRow = emptyRow(selectedEmployee.id, startDate);
    setDraftRows((prev) => [...prev, newRow]);
    setRowOrderIds((prev) => [...prev, String(newRow.id)]);
    setEditingRowId(newRow.id);
  };

  const addRowBelow = (afterRow) => {
    if (!selectedEmployee) return;
    const newRow = emptyRow(selectedEmployee.id, afterRow.date);
    setDraftRows((prev) => [...prev, newRow]);
    setRowOrderIds((prev) => insertIdAfter(prev, afterRow.id, newRow.id));
    setEditingRowId(newRow.id);
  };

  const duplicateRowBelow = (sourceRow) => {
    if (!selectedEmployee) return;
    const newRow = duplicateRowData(sourceRow, selectedEmployee.id);
    setDraftRows((prev) => [...prev, newRow]);
    setRowOrderIds((prev) => insertIdAfter(prev, sourceRow.id, newRow.id));
    setEditingRowId(newRow.id);
  };

  const removeRow = async (row) => {
    if (row._placeholder) {
      return;
    }

    if (String(editingRowId) === String(row.id)) {
      setEditingRowId(null);
    }

    if (String(row.id).startsWith('temp-')) {
      setRowOrderIds((prev) => prev.filter((id) => id !== String(row.id)));
      setDraftRows((prev) => prev.filter((r) => r.id !== row.id));
      return;
    }

    if (!window.confirm('Clear this day and mark it as holiday?')) return;

    try {
      const { data } = await api.delete(`/availabilities/${row.id}`);
      const cleared = normalizeRow(data?.data ?? {
        ...row,
        strt1: '',
        end1: '',
        strt2: '',
        end2: '',
        strt3: '',
        end3: '',
        strt4: '',
        end4: '',
        total: '00:00',
        total_ava: '00:00',
        Total: '00:00',
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? cleared : r)));
      toast.success('Day marked as holiday.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to clear day.');
      setError(message);
      toast.error(message);
    }
  };

  const saveAll = async () => {
    if (!selectedEmployee) return;

    const payload = sortAvailabilities([...rows, ...draftRows]).map((row) => {
      const copy = { ...row, employee_id: selectedEmployee.id };
      if (String(copy.id).startsWith('temp-')) {
        delete copy.id;
      }
      return copy;
    });

    if (payload.length === 0) {
      setError('No rows to save.');
      return;
    }

    const seenDates = new Set();
    const duplicateDates = [];
    for (const row of payload) {
      const date = String(row.date).slice(0, 10);
      if (seenDates.has(date)) {
        duplicateDates.push(date);
      } else {
        seenDates.add(date);
      }
    }

    if (duplicateDates.length > 0) {
      const message = `Duplicate dates: ${[...new Set(duplicateDates)].map(formatDisplayDate).join(', ')}. Only one row per day is allowed.`;
      setError(message);
      toast.error(message);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const { data } = await api.post('/availabilities/sync', payload);
      const saved = sortAvailabilities((data.data || []).map(normalizeRow));
      setRows(saved);
      setDraftRows([]);
      setRowOrderIds(saved.map((row) => String(row.id)));
      setEditingRowId(null);
      toast.success('Availability saved successfully.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to save availability.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const duplicateWeek = async () => {
    if (!selectedEmployee || !duplicateTargetWeek) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await api.post(
        `/employees/${selectedEmployee.id}/availabilities/duplicate-week`,
        {
          source_week_start: startDate,
          target_week_start: duplicateTargetWeek,
        },
      );
      await loadEmployeeAvailabilities(selectedEmployee.id, startDate, endDate);
      setShowDuplicate(false);
      setDuplicateTargetWeek('');
      toast.success(`Duplicated ${data.data?.length || 0} day(s) to target week.`);
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to duplicate week.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (loadingEmployees) {
    return <AvailabilityPageSkeleton />;
  }

  const tableBusy = loadingAvailabilities;

  return (
    <section className="user-availability-page">
      <PageHeader title="User Availability" />

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="availability-toolbar card">
        <div className="availability-toolbar-filters">
          <label>
            Employee
            <select
              value={selectedEmployeeId}
              onChange={handleEmployeeChange}
            >
              <option value="">Select employee</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {employeeDisplayName(emp)}
                </option>
              ))}
            </select>
          </label>

          <label>
            Month
            <input type="month" value={selectedMonth} onChange={handleMonthChange} />
          </label>

          <label>
            From
            <DisplayDateInput value={startDate} onChange={setStartDate} />
          </label>

          <label>
            To
            <DisplayDateInput value={endDate} onChange={setEndDate} />
          </label>

          {selectedEmployee && (
            <div className="availability-total" aria-label={`Total hours: ${formatTotalHours(totalMinutes)}`}>
              <span className="availability-total-label">Total hours</span>
              <strong className="availability-total-value">{formatTotalHours(totalMinutes)}</strong>
            </div>
          )}
        </div>

        <div className="availability-toolbar-actions">
          {canImportAvailability ? (
            <button type="button" className="btn btn-secondary btn-compact" onClick={handleOpenImport}>
              Import availability
            </button>
          ) : null}

          {selectedEmployee ? (
            <>
              <button type="button" className="btn btn-secondary btn-compact" onClick={addRow} disabled={!canEditAvailability}>
                Add row
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={() => setShowDuplicate(true)}
                disabled={!canDuplicateWeek}
              >
                Duplicate week
              </button>

              <button
                type="button"
                className="btn btn-save btn-compact"
                onClick={saveAll}
                disabled={!canEditAvailability || saving || tableBusy}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {!selectedEmployee ? (
        <div className="card muted-card">
          Select an employee to view or edit their timesheet.
        </div>
      ) : (
        <div className="table-card availability-table-wrap">
          {tableBusy && (
            <p className="availability-loading-hint muted" role="status">
              Loading availability...
            </p>
          )}
          <div className="availability-table-scroller">
            <table className="availability-table">
            <thead>
              <tr className="availability-header-row">
                <th rowSpan={2} className="col-day">Day</th>
                <th rowSpan={2} className="col-date">Date</th>
                {TIME_BLOCKS.map((block) => (
                  <th key={block.label} colSpan={2} className="availability-block-header">
                    {block.label}
                  </th>
                ))}
                <th rowSpan={2} className="col-total">Total</th>
                <th rowSpan={2} className="actions-cell col-actions">Actions</th>
              </tr>
              <tr className="availability-subheader-row">
                {TIME_BLOCKS.flatMap((block) => [
                  <th key={`${block.label}-from`} className="col-time availability-shift-divider">From</th>,
                  <th key={`${block.label}-to`} className="col-time">To</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 && (
                <tr>
                  <td colSpan={TABLE_COLUMN_COUNT} className="empty-cell">
                    No days in this month range.
                  </td>
                </tr>
              )}
              {displayRows.map((row) => {
                const isPlaceholder = Boolean(row._placeholder);
                const isEmpty =
                  isPlaceholder || (
                    !row.strt1 && !row.end1 && !row.strt2 && !row.end2 &&
                    !row.strt3 && !row.end3 && !row.strt4 && !row.end4
                  );
                const isWeekend = isWeekendDate(row.date);
                const isEditing = canEditAvailability && !isPlaceholder && String(row.id) === String(editingRowId);
                const rowClass = [
                  isEmpty ? 'availability-row-empty' : '',
                  isWeekend ? 'availability-row-weekend' : '',
                  isEditing ? 'availability-row-editing' : '',
                ].filter(Boolean).join(' ');

                return (
                  <tr key={row.id} className={rowClass || undefined}>
                    <td className="col-day">
                      <span className={`availability-day-label${isWeekend ? ' is-weekend' : ''}`}>
                        {dayName(row.date)}
                      </span>
                    </td>
                    <td className="col-date">
                      {isEditing ? (
                        <DisplayDateInput
                          compact
                          className="availability-date-input"
                          value={row.date || ''}
                          min={startDate}
                          max={endDate}
                          onChange={(nextValue) => updateRow(row.id, 'date', nextValue)}
                        />
                      ) : (
                        <span className="availability-readonly">{formatCompactDisplayDate(row.date)}</span>
                      )}
                    </td>
                    {TIME_BLOCKS.flatMap((block) =>
                      [block.from, block.to].map((field) => (
                        <td
                          key={`${row.id}-${field}`}
                          className={`col-time${field === block.from ? ' availability-shift-divider' : ''}`}
                        >
                          {isEditing ? (
                            <AvailabilityTimeInput
                              value={row[field] || ''}
                              onChange={(nextValue) => updateRow(row.id, field, nextValue)}
                            />
                          ) : (
                            <span className={`availability-readonly${!row[field] || row[field] === '00:00' ? ' is-empty' : ''}`}>
                              {formatTimeDisplay(row[field])}
                            </span>
                          )}
                        </td>
                      )),
                    )}
                    <td className={`total-cell col-total${isEmpty ? ' is-empty' : ''}`}>
                      {formatRowTotal(row.total || row.Total, isEmpty)}
                    </td>
                    <td className="actions-cell col-actions">
                      <AvailabilityRowActions
                        isEditing={canEditAvailability && isEditing}
                        showEdit={canEditAvailability}
                        showDuplicate={canEditAvailability}
                        showAdd={canEditAvailability}
                        showDelete={canEditAvailability}
                        disableDelete={!canEditAvailability}
                        onAddBelow={canEditAvailability ? () => addRowBelow(row) : undefined}
                        onDelete={canEditAvailability ? () => removeRow(row) : undefined}
                        onEdit={canEditAvailability ? () => beginEditRow(row) : undefined}
                        onDuplicate={canEditAvailability ? () => duplicateRowBelow(row) : undefined}
                        onFinishEdit={() => setEditingRowId(null)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <ImportAvailabilityModal
        open={showImport}
        onClose={() => setShowImport(false)}
        employees={employees}
        onImported={async ({ silent = false } = {}) => {
          try {
            if (selectedEmployeeId) {
              await loadEmployeeAvailabilities(selectedEmployeeId, startDate, endDate);
            }
            await loadEmployees();
            if (!silent) {
              toast.success('Availability imported successfully.');
              setShowImport(false);
            }
          } catch (err) {
            const message = getApiErrorMessage(err, 'Import succeeded but refresh failed. Reload the page.');
            setError(message);
            toast.error(message);
          }
        }}
      />

      {showDuplicate && (
        <div className="modal-overlay" role="presentation" onDoubleClick={() => setShowDuplicate(false)}>
          <div
            className="modal-card"
            role="dialog"
            aria-labelledby="duplicate-week-title"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="duplicate-week-title">Duplicate week</h3>
            </div>
            <div className="modal-body">
            <p>
              Copy availability from the week containing{' '}
              <strong>{formatDisplayDate(startDate)}</strong> to another week.
            </p>
            <label>
              Target week (any date in that week)
              <DisplayDateInput
                value={duplicateTargetWeek}
                onChange={setDuplicateTargetWeek}
              />
            </label>
            </div>
            <div className="modal-actions" style={{ padding: '0 24px 24px' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowDuplicate(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-save"
                onClick={duplicateWeek}
                disabled={!canDuplicateWeek || !duplicateTargetWeek || saving}
              >
                Duplicate
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
