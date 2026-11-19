import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client';
import AddEmployeeModal from '../../components/AddEmployeeModal';
import AddNrmSectionModal from '../../components/AddNrmSectionModal';
import AddTeamModal from '../../components/AddTeamModal';
import OperativesAllocationLegend from '../../components/OperativesAllocationLegend';
import RowAddButton from '../../components/RowAddButton';
import { AllocationPageSkeleton } from '../../components/PageSkeleton';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { canPageAction } from '../../utils/userPermissions';
import { employeeDisplayName, employeeEditName } from '../../utils/employeeNames';
import { isTrainee } from '../../utils/employeeTrainee';
import { groupEmployeesByTeamLikeOap } from '../../utils/teamOrder';

function groupByTeam(teams, employees) {
  return groupEmployeesByTeamLikeOap(teams, employees)
    .filter((group) => group.teamId != null)
    .map((group) => ({
      teamId: group.teamId,
      teamName: group.teamName,
      members: group.members.map((employee) => ({
        ...employee,
        team_id: employee.team_id ?? group.teamId,
        nrms: employee.nrms || [],
      })),
    }));
}

function getPivotValue(employee, nrmId, field) {
  const match = (employee.nrms || []).find(
    (nrm) => String(nrm.id) === String(nrmId),
  );
  return match?.pivot?.[field] ?? '';
}

function getOap(employee, nrmId) {
  return getPivotValue(employee, nrmId, 'OAP');
}

function getPerformance(employee, nrmId) {
  return getPivotValue(employee, nrmId, 'performance_percentage');
}

function hasPivotValue(employee, nrmId, field) {
  return String(getPivotValue(employee, nrmId, field)).trim() !== '';
}

function hasOapValue(employee, nrmId) {
  return hasPivotValue(employee, nrmId, 'OAP');
}

function hasPerformanceValue(employee, nrmId) {
  return hasPivotValue(employee, nrmId, 'performance_percentage');
}


function employeeMatchesNrmFilter(employee, nrmId, viewMode) {
  if (!nrmId) {
    return true;
  }
  return viewMode === 'performance'
    ? hasPerformanceValue(employee, nrmId)
    : hasOapValue(employee, nrmId);
}

function formatPerformanceDisplay(value) {
  const raw = String(value ?? '').trim().replace(/%$/, '');
  if (!raw) return '';
  return `${raw}%`;
}

function normalizePerformanceValue(value) {
  return String(value ?? '').trim().replace(/%$/, '').trim();
}

function AllocationPivotInput({ value, onCommit, formatForDisplay, parseOnCommit, readOnly = false }) {
  const toDisplay = formatForDisplay ?? ((v) => v ?? '');
  const toStored = parseOnCommit ?? ((v) => String(v ?? '').trim());

  const [draft, setDraft] = useState(() => toDisplay(value));
  const committedRef = useRef(toStored(value));

  useEffect(() => {
    const stored = toStored(value);
    if (stored !== committedRef.current) {
      committedRef.current = stored;
      setDraft(toDisplay(value));
    }
  }, [value, toDisplay, toStored]);

  const commit = useCallback(() => {
    if (readOnly) {
      return;
    }
    const next = toStored(draft);
    const display = toDisplay(next);
    if (next !== committedRef.current) {
      committedRef.current = next;
      onCommit(next);
    }
    setDraft(display);
  }, [draft, onCommit, readOnly, toDisplay, toStored]);

  const handleFocus = useCallback(() => {
    setDraft(toStored(draft));
  }, [draft, toStored]);

  const hasValue = String(toStored(value) ?? '').trim() !== '';

  return (
    <input
      type="text"
      inputMode="decimal"
      className={hasValue ? 'allocation-oap-input allocation-oap-input--filled' : 'allocation-oap-input'}
      value={draft}
      readOnly={readOnly}
      onChange={(e) => { if (!readOnly) setDraft(e.target.value); }}
      onFocus={handleFocus}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function OperativeNameInput({ value, onCommit, onToggleFilter, isTrainee: isTraineeEmployee, readOnly = false }) {
  const [draft, setDraft] = useState(() => value ?? '');
  const committedRef = useRef(value ?? '');
  const filterClickTimerRef = useRef(null);

  useEffect(() => {
    const next = value ?? '';
    if (next !== committedRef.current) {
      committedRef.current = next;
      setDraft(next);
    }
  }, [value]);

  useEffect(() => () => {
    if (filterClickTimerRef.current) {
      window.clearTimeout(filterClickTimerRef.current);
    }
  }, []);

  const commit = useCallback(() => {
    if (readOnly) {
      return;
    }
    const next = draft ?? '';
    if (next !== committedRef.current) {
      committedRef.current = next;
      onCommit(next);
    }
  }, [draft, onCommit, readOnly]);

  const handleClick = useCallback(() => {
    if (filterClickTimerRef.current) {
      return;
    }

    filterClickTimerRef.current = window.setTimeout(() => {
      filterClickTimerRef.current = null;
      onToggleFilter?.();
    }, 220);
  }, [onToggleFilter]);

  const handleDoubleClick = useCallback((event) => {
    if (readOnly) {
      return;
    }
    if (filterClickTimerRef.current) {
      window.clearTimeout(filterClickTimerRef.current);
      filterClickTimerRef.current = null;
    }

    event.currentTarget.focus();
    event.currentTarget.select();
  }, [readOnly]);

  return (
    <input
      type="text"
      className={
        isTraineeEmployee
          ? 'allocation-name-input allocation-name-input--trainee allocation-name-input--filterable'
          : 'allocation-name-input allocation-name-input--filterable'
      }
      value={draft}
      readOnly={readOnly}
      onChange={(e) => { if (!readOnly) setDraft(e.target.value); }}
      onBlur={commit}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      title="Click to filter sections with values for this operative. Double-click to edit the name."
      aria-label="Operative name"
    />
  );
}

export default function OperativesAllocation() {
  const toast = useToast();
  const { user } = useAuth();
  const canEditAllocation = canPageAction(user, 'Operatives Allocation', 'edit');
  const canDeleteAllocationEmployees = canPageAction(user, 'Operatives Allocation', 'delete_employees');
  const canManageEmployees = canPageAction(user, 'Operatives Allocation', 'manage_employees');
  const canManageTeams = canPageAction(user, 'Operatives Allocation', 'manage_teams');
  const canManageNrms = canPageAction(user, 'Operatives Allocation', 'manage_nrms');
  const [nrms, setNrms] = useState([]);
  const [teams, setTeams] = useState([]);
  const [data, setData] = useState([]);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [showNrmModal, setShowNrmModal] = useState(false);
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [employeeModalTeamId, setEmployeeModalTeamId] = useState('');
  const [nrmFilterId, setNrmFilterId] = useState(null);
  const [employeeFilterId, setEmployeeFilterId] = useState(null);
  const [viewMode, setViewMode] = useState('oap');
  const [searchQuery, setSearchQuery] = useState('');
  const [teamFilterId, setTeamFilterId] = useState('');
  const [collapsedTeams, setCollapsedTeams] = useState(() => new Set());

  const pivotField = viewMode === 'performance' ? 'performance_percentage' : 'OAP';
  const hasCellValue = viewMode === 'performance' ? hasPerformanceValue : hasOapValue;
  const getCellValue = viewMode === 'performance' ? getPerformance : getOap;

  const openNewEmployeeModal = (teamId = '') => {
    setEmployeeModalTeamId(teamId ? String(teamId) : '');
    setShowEmployeeModal(true);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: response } = await api.get('/operatives-allocation');
      const payload = response?.data ?? response;
      const employees = payload?.employees ?? [];
      const teamList = payload?.teams ?? [];
      const nrmList = payload?.nrms ?? [];
      setTeams(teamList);
      setNrms(nrmList);
      setData(groupByTeam(teamList, employees));
      setError('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load operatives allocation data.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setViewMode('oap');
    setNrmFilterId(null);
    setEmployeeFilterId(null);
    loadData();
  }, []);

  const filteredEmployee = useMemo(() => {
    if (!employeeFilterId) return null;
    for (const team of data) {
      const match = team.members.find((member) => String(member.id) === String(employeeFilterId));
      if (match) return match;
    }
    return null;
  }, [data, employeeFilterId]);

  const visibleNrms = useMemo(() => {
    if (!employeeFilterId || !filteredEmployee) {
      return nrms;
    }
    return nrms.filter((nrm) => hasCellValue(filteredEmployee, nrm.id));
  }, [nrms, employeeFilterId, filteredEmployee, viewMode]);

  const visibleData = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return data
      .filter((team) => !teamFilterId || String(team.teamId) === String(teamFilterId))
      .map((team) => ({
        ...team,
        members: team.members.filter((employee) => {
          if (!employeeMatchesNrmFilter(employee, nrmFilterId, viewMode)) {
            return false;
          }
          if (!query) {
            return true;
          }
          return employeeDisplayName(employee).toLowerCase().includes(query);
        }),
      }))
      .filter((team) => !query || team.members.length > 0);
  }, [data, nrmFilterId, viewMode, searchQuery, teamFilterId]);

  const hasVisibleMembers = useMemo(
    () => visibleData.some((team) => team.members.length > 0),
    [visibleData],
  );

  const nrmFilterLabel = useMemo(() => {
    if (!nrmFilterId) return '';
    const match = nrms.find((nrm) => String(nrm.id) === String(nrmFilterId));
    return match?.number || 'Selected section';
  }, [nrmFilterId, nrms]);

  const toggleNrmFilter = (nrmId) => {
    setNrmFilterId((current) =>
      current != null && String(current) === String(nrmId) ? null : nrmId,
    );
  };

  const toggleEmployeeFilter = (employeeId) => {
    setEmployeeFilterId((current) =>
      current != null && String(current) === String(employeeId) ? null : employeeId,
    );
  };

  const clearFilters = () => {
    setNrmFilterId(null);
    setEmployeeFilterId(null);
    setSearchQuery('');
    setTeamFilterId('');
  };

  const toggleTeamCollapse = (teamId) => {
    setCollapsedTeams((current) => {
      const next = new Set(current);
      if (next.has(teamId)) {
        next.delete(teamId);
      } else {
        next.add(teamId);
      }
      return next;
    });
  };

  const addRow = (teamName) => {
    const team = teams.find((item) => item.name === teamName);
    if (!team) return;
    openNewEmployeeModal(team.id);
  };

  const toggleRowSelection = (employeeId) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) {
        next.delete(employeeId);
      } else {
        next.add(employeeId);
      }
      return next;
    });
  };

  const updateRowData = (teamName, employeeId, field, value, nrmId = null) => {
    setData((prev) =>
      prev.map((team) => {
        if (team.teamName !== teamName) return team;

        return {
          ...team,
          members: team.members.map((member) => {
            if (String(member.id) !== String(employeeId)) return member;

            if (field === 'name') {
              const parts = value.trim().split(/\s+/);
              const firstName = parts[0] || '';
              const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
              const { name: _removed, ...rest } = member;
              return { ...rest, first_name: firstName, last_name: lastName };
            }

            if (field === 'OAP' && nrmId !== null) {
              const nrmsUpdated = [...(member.nrms || [])];
              const nrmIndex = nrmsUpdated.findIndex(
                (nrm) => String(nrm.id) === String(nrmId),
              );

              if (nrmIndex !== -1) {
                nrmsUpdated[nrmIndex] = {
                  ...nrmsUpdated[nrmIndex],
                  pivot: { ...nrmsUpdated[nrmIndex].pivot, OAP: value },
                };
              } else {
                nrmsUpdated.push({
                  id: nrmId,
                  pivot: { OAP: value, performance_percentage: '' },
                });
              }

              return { ...member, nrms: nrmsUpdated };
            }

            if (field === 'performance_percentage' && nrmId !== null) {
              const nrmsUpdated = [...(member.nrms || [])];
              const nrmIndex = nrmsUpdated.findIndex(
                (nrm) => String(nrm.id) === String(nrmId),
              );

              if (nrmIndex !== -1) {
                nrmsUpdated[nrmIndex] = {
                  ...nrmsUpdated[nrmIndex],
                  pivot: { ...nrmsUpdated[nrmIndex].pivot, performance_percentage: value },
                };
              } else {
                nrmsUpdated.push({
                  id: nrmId,
                  pivot: { OAP: '', performance_percentage: value },
                });
              }

              return { ...member, nrms: nrmsUpdated };
            }

            return member;
          }),
        };
      }),
    );
  };

  const saveData = async () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });

    setSaving(true);
    setError('');
    try {
      await api.post('/operatives-allocation/sync', data);
      toast.success('Operatives allocation saved.');
      await loadData();
      setSelectedRows(new Set());
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to save operatives allocation.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const employeeIds = [...selectedRows].filter(
      (id) => !String(id).startsWith('temp-') && Number.isFinite(Number(id)),
    );

    if (employeeIds.length > 0) {
      try {
        await api.post('/operatives-allocation/delete-employees', {
          employee_ids: employeeIds,
        });
        await loadData();
        toast.success('Selected employees deleted.');
      } catch (err) {
        const message = getApiErrorMessage(err, 'Unable to delete selected employees.');
        setError(message);
        toast.error(message);
      }
    } else {
      setData((prev) =>
        prev.map((team) => ({
          ...team,
          members: team.members.filter((member) => !selectedRows.has(member.id)),
        })),
      );
    }

    setSelectedRows(new Set());
    setShowDeleteModal(false);
  };

  if (loading) {
    return <AllocationPageSkeleton />;
  }

  const operativeColumnCount = 2;
  const totalColumnCount = visibleNrms.length + operativeColumnCount + 1;

  return (
    <section className="operatives-allocation-page">
      <div className="allocation-page-body">
      <div className="allocation-page-chrome">
      <div className="allocation-toolbar card">
        <h2 className="allocation-toolbar-title">Operatives Allocation</h2>

        <div className="allocation-toolbar-filters">
          <div className="allocation-toolbar-controls">
            <label className="allocation-toolbar-search">
              <span className="sr-only">Search by operative name</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search by operative name..."
              />
            </label>

            <label className="allocation-toolbar-team">
              <span className="sr-only">Filter by team</span>
              <select
                value={teamFilterId}
                onChange={(event) => setTeamFilterId(event.target.value)}
              >
                <option value="">All teams</option>
                {teams.map((team) => (
                  <option key={team.id} value={String(team.id)}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="allocation-toolbar-chip-group">
            <button
              type="button"
              className="allocation-toolbar-chip"
              onClick={() => setShowTeamModal(true)}
              disabled={!canManageTeams}
            >
              Team
            </button>
            <button
              type="button"
              className="allocation-toolbar-chip"
              onClick={() => setShowNrmModal(true)}
              disabled={!canManageNrms}
            >
              NRM Section
            </button>
          </div>

          <div
            className="allocation-toolbar-chip-group allocation-toolbar-view-toggle"
            role="group"
            aria-label="View mode"
          >
            <button
              type="button"
              className={`allocation-toolbar-chip${viewMode === 'oap' ? ' is-active' : ''}`}
              onClick={() => setViewMode('oap')}
            >
              OAP
            </button>
            <button
              type="button"
              className={`allocation-toolbar-chip${viewMode === 'performance' ? ' is-active' : ''}`}
              onClick={() => setViewMode('performance')}
            >
              Performance %
            </button>
          </div>

          <div className="allocation-toolbar-actions">
            <button type="button" className="btn btn-save btn-compact" onClick={saveData} disabled={!canEditAllocation || saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-compact"
              onClick={() => (selectedRows.size ? setShowDeleteModal(true) : null)}
              disabled={!canDeleteAllocationEmployees || selectedRows.size === 0}
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {(nrmFilterId || employeeFilterId || searchQuery || teamFilterId) && (
        <div className="alert alert-info histogram-bar-filter-banner">
          <span>
            {teamFilterId && (
              <>
                Team: <strong>{teams.find((team) => String(team.id) === String(teamFilterId))?.name || 'Selected'}</strong>
              </>
            )}
            {teamFilterId && (nrmFilterId || employeeFilterId || searchQuery) && ' · '}
            {searchQuery && (
              <>
                Name contains <strong>{searchQuery}</strong>
              </>
            )}
            {searchQuery && (nrmFilterId || employeeFilterId) && ' · '}
            {nrmFilterId && (
              <>
                Showing operatives with a {viewMode === 'performance' ? 'performance' : 'OAP'} value in{' '}
                <strong>{nrmFilterLabel}</strong>
              </>
            )}
            {nrmFilterId && employeeFilterId && ' · '}
            {employeeFilterId && (
              <>
                Showing sections with {viewMode === 'performance' ? 'performance' : 'OAP'} values for{' '}
                <strong>{employeeDisplayName(filteredEmployee) || 'selected operative'}</strong>
              </>
            )}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
            Clear
          </button>
        </div>
      )}

      <OperativesAllocationLegend />
      </div>

      <div className="table-card allocation-table-wrap">
        <div className="allocation-table-scroller">
        <table
          className={`allocation-table${viewMode === 'performance' ? ' allocation-table--performance' : ''}`}
        >
          <colgroup>
            <col className="allocation-col-checkbox" />
            <col className="allocation-col-name" />
            {visibleNrms.map((nrm) => (
              <col key={nrm.id} className="allocation-col-nrm" />
            ))}
            <col className="allocation-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th colSpan={operativeColumnCount} className="allocation-head-main allocation-head-operative">
                Operative
              </th>
              <th colSpan={visibleNrms.length} className="allocation-head-main">
                {viewMode === 'performance' ? 'Performance %' : 'NRM Sections'}
              </th>
              <th className="allocation-head-main allocation-head-actions">Action</th>
            </tr>
            <tr>
              <th className="allocation-head-sub allocation-head-checkbox allocation-sticky-col allocation-sticky-checkbox" aria-label="Select" />
              <th className="allocation-head-sub allocation-head-name allocation-sticky-col allocation-sticky-name">Name</th>
              {visibleNrms.map((nrm) => {
                const isActive =
                  nrmFilterId != null && String(nrmFilterId) === String(nrm.id);

                return (
                  <th
                    key={nrm.id}
                    className={`allocation-head-sub allocation-nrm-filter${isActive ? ' is-filter-active' : ''}`}
                    title={[nrm.name, nrm.sc_name].filter(Boolean).join(' · ')}
                  >
                    <button
                      type="button"
                      className="allocation-nrm-filter-btn"
                      onClick={() => toggleNrmFilter(nrm.id)}
                      title={`Show operatives with a ${viewMode === 'performance' ? 'performance' : 'OAP'} value in ${[nrm.name, nrm.sc_name].filter(Boolean).join(' · ') || nrm.number}`}
                    >
                      {nrm.number}
                    </button>
                  </th>
                );
              })}
              <th className="allocation-head-sub allocation-head-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {visibleData.length === 0 ? (
              <tr>
                <td colSpan={totalColumnCount} className="allocation-empty-filter">
                  No teams found. Add a team to get started.
                </td>
              </tr>
            ) : !hasVisibleMembers ? (
              <tr>
                <td colSpan={totalColumnCount} className="allocation-empty-filter">
                  No operatives match the current filter.
                </td>
              </tr>
            ) : (
              visibleData.map((team) => {
              const isCollapsed = collapsedTeams.has(team.teamId);

              return (
              <Fragment key={team.teamId}>
                <tr className="allocation-team-row">
                  <td
                    colSpan={operativeColumnCount + visibleNrms.length}
                    className="allocation-team-bar"
                  >
                    <button
                      type="button"
                      className="allocation-team-label allocation-team-toggle"
                      onClick={() => toggleTeamCollapse(team.teamId)}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? `Expand ${team.teamName}` : `Collapse ${team.teamName}`}
                    >
                      <span className={`allocation-team-chevron${isCollapsed ? ' is-collapsed' : ''}`} aria-hidden="true" />
                      <strong>{team.teamName}</strong>
                      <span className="allocation-team-count">({team.members.length})</span>
                    </button>
                  </td>
                  <td className="allocation-actions-cell allocation-team-actions-cell">
                    <div className="allocation-actions-cell-inner">
                      {canManageEmployees ? (
                      <RowAddButton
                        className="allocation-team-add-btn"
                        onClick={() => addRow(team.teamName)}
                        title={`Add operative to ${team.teamName}`}
                      />
                      ) : null}
                    </div>
                  </td>
                </tr>
                {!isCollapsed && team.members.map((employee) => {
                  const isEmployeeFilterActive =
                    employeeFilterId != null
                    && String(employeeFilterId) === String(employee.id);

                  return (
                  <tr
                    key={`${team.teamId}-${employee.id}`}
                    className={isEmployeeFilterActive ? 'allocation-row-filter-active' : undefined}
                  >
                    <td className="allocation-checkbox-cell allocation-sticky-col allocation-sticky-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedRows.has(employee.id)}
                        onChange={() => toggleRowSelection(employee.id)}
                        aria-label={`Select ${employeeDisplayName(employee) || 'operative'}`}
                      />
                    </td>
                    <td
                      className={`allocation-name-cell allocation-sticky-col allocation-sticky-name${isEmployeeFilterActive ? ' is-filter-active' : ''}`}
                    >
                      <OperativeNameInput
                        value={employeeEditName(employee)}
                        isTrainee={isTrainee(employee)}
                        readOnly={!canManageEmployees}
                        onCommit={(next) =>
                          updateRowData(team.teamName, employee.id, 'name', next)
                        }
                        onToggleFilter={() => toggleEmployeeFilter(employee.id)}
                      />
                    </td>
                    {visibleNrms.map((nrm) => {
                      const highlightCell =
                        isEmployeeFilterActive && hasCellValue(employee, nrm.id);

                      return (
                      <td
                        key={`${employee.id}-${nrm.id}`}
                        className={highlightCell ? 'allocation-oap-highlight allocation-oap-cell' : 'allocation-oap-cell'}
                      >
                        <AllocationPivotInput
                          key={`${employee.id}-${nrm.id}-${viewMode}`}
                          value={getCellValue(employee, nrm.id)}
                          readOnly={!canEditAllocation}
                          formatForDisplay={
                            viewMode === 'performance' ? formatPerformanceDisplay : undefined
                          }
                          parseOnCommit={
                            viewMode === 'performance' ? normalizePerformanceValue : undefined
                          }
                          onCommit={(next) =>
                            updateRowData(team.teamName, employee.id, pivotField, next, nrm.id)
                          }
                        />
                      </td>
                      );
                    })}
                    <td className="allocation-actions-cell">
                      <div className="allocation-actions-cell-inner">
                        {canManageEmployees ? (
                        <RowAddButton
                          onClick={() => addRow(team.teamName)}
                          title={`Add operative to ${team.teamName}`}
                        />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </Fragment>
              );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>
      </div>

      {showDeleteModal && (
        <div className="modal-overlay" role="presentation" onDoubleClick={() => setShowDeleteModal(false)}>
          <div
            className="modal-card"
            role="dialog"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Confirm deletion</h3>
            </div>
            <div className="modal-body">
              <p>Are you sure you want to delete the selected row(s)?</p>
            </div>
            <div className="modal-actions" style={{ padding: '0 24px 24px' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <AddEmployeeModal
        open={showEmployeeModal}
        onClose={() => setShowEmployeeModal(false)}
        onSaved={() => {
          loadData();
          toast.success('Employee created successfully.');
        }}
        teams={teams}
        defaultTeamId={employeeModalTeamId}
      />
      <AddTeamModal
        open={showTeamModal}
        onClose={() => setShowTeamModal(false)}
        onSaved={loadData}
      />
      <AddNrmSectionModal
        open={showNrmModal}
        onClose={() => setShowNrmModal(false)}
        onSaved={loadData}
      />
    </section>
  );
}
