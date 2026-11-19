import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import ActivityLogModal from './ActivityLogModal';
import AlgorithmRunningOverlay from './AlgorithmRunningOverlay';
import RunAlgorithmAfterSaveModal from './RunAlgorithmAfterSaveModal';
import { getApiErrorMessage } from '../utils/apiErrors';
import { formatCompactDisplayDate, formatDisplayDate, toStorageDate } from '../utils/dateFormat';
import {
  completionPercentOptions,
  equalHourShares,
  filledOverrideNames,
  formatDlQuickStatus,
  isRfiOn,
  overrideValuesFromNames,
  percentDisplay,
  redistributeHourShares,
  RFI_CHECKBOX_HELP,
  sharePatchFromValues,
  sharePercentOptions,
  storedHourShares,
} from '../utils/dlQuickUpdate';
import { applyDlTaskFieldChange, normalizeTaskForSave } from '../utils/taskCalculations';
import { applyDoneCheckboxChange } from '../utils/pdeDoneEffects';
import { applyDlMirrorOnChange } from '../utils/dlMirrorFields';
import { findEmployeeForAuthUser } from '../utils/employeeNames';
import { displayProjectColor } from '../utils/projectColor';
import { compareTeamNames } from '../utils/teamOrder';
import { canPageAction, canViewPage } from '../utils/userPermissions';
import { saveAllAlgorithmResults } from '../utils/algorithm';
import { runAlgorithmByProject } from '../utils/algorithmRun';
import { initialAlgorithmProgress } from '../utils/algorithmProgress';
import { getDlFieldLabel } from '../constants/projectTaskFields';

const DL_PLAN_LOG_PARAMS = { section: 'dl' };
const ALL_TEAMS = '';
const ALL_PROJECTS = '';
const STATUS_ALL = 'all';
const STATUS_ACTIVE = 'active';

function groupEmployees(employees) {
  const map = new Map();
  (employees || []).forEach((employee) => {
    const teamName = employee.team_name || 'No team';
    if (!map.has(teamName)) {
      map.set(teamName, []);
    }
    map.get(teamName).push(employee);
  });

  return [...map.entries()]
    .sort(([left], [right]) => compareTeamNames(left, right))
    .map(([teamName, members]) => ({
      teamName,
      members: [...members].sort((left, right) => (
        String(left.name || '').localeCompare(String(right.name || ''))
      )),
    }));
}

function filterEmployeeGroups(groupedEmployees, predicate) {
  return groupedEmployees
    .map((group) => ({
      ...group,
      members: group.members.filter(predicate),
    }))
    .filter((group) => group.members.length > 0);
}

function teamEmployeeGroups(groupedEmployees, { teamId, teamName } = {}) {
  const id = teamId ? Number(teamId) : null;
  const name = String(teamName || '').trim().toLowerCase();
  if (!id && !name) {
    return groupedEmployees;
  }

  if (id) {
    const byId = filterEmployeeGroups(
      groupedEmployees,
      (employee) => Number(employee.team_id) === id,
    );
    if (byId.length > 0) {
      return byId;
    }
  }

  if (name) {
    const byName = filterEmployeeGroups(
      groupedEmployees,
      (employee) => String(employee.team_name || '').trim().toLowerCase() === name,
    );
    if (byName.length > 0) {
      return byName;
    }
  }

  return [];
}

function OverrideSelect({ value, onChange, groupedEmployees, disabled, ariaLabel }) {
  const selected = value || '';
  const hasMatch = groupedEmployees.some(({ members }) => (
    members.some((employee) => employee.name === selected)
  ));

  return (
    <select
      className={`dl-quick-select dl-quick-alloc-person${disabled ? '' : ' is-editable'}`}
      value={selected}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
    >
      <option value="">{selected ? 'Remove' : 'Select person'}</option>
      {!hasMatch && selected ? <option value={selected}>{selected}</option> : null}
      {groupedEmployees.map(({ teamName, members }) => (
        <optgroup key={teamName} label={teamName}>
          {members.map((employee) => (
            <option key={employee.id} value={employee.name}>{employee.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function renderTableHeader(header) {
  const headerClass = [
    header.key === 'allocation' ? 'dl-quick-alloc-head' : '',
    header.key === 'progress_per' ? 'dl-quick-pct-head' : '',
    header.key === 'done' ? 'dl-quick-done-head' : '',
  ].filter(Boolean).join(' ');

  return (
    <th
      key={header.key}
      className={headerClass || undefined}
      title={header.key === 'rfi' ? RFI_CHECKBOX_HELP : header.title}
    >
      {header.sub ? (
        <>
          <span>{header.label}</span>
          <small>{header.sub}</small>
        </>
      ) : header.label}
    </th>
  );
}

function AllocationEditor({ task, disabled, groupedEmployees, onChangeOverrides, onChangeShares }) {
  const names = filledOverrideNames(task);
  const [adding, setAdding] = useState(false);
  const [shares, setShares] = useState(() => storedHourShares(task, names.length));
  const nameKey = names.join('|');
  const shareKey = [task?.override_share_1, task?.override_share_2, task?.override_share_3].join('|');

  useEffect(() => {
    setShares(storedHourShares(task, names.length));
    if (names.length >= 3) {
      setAdding(false);
    }
  }, [nameKey, names.length, shareKey, task]);

  const slots = adding && names.length < 3
    ? [...names.map((name, index) => ({ name, index })), { name: '', index: names.length }]
    : names.map((name, index) => ({ name, index }));
  const shareTotal = shares.reduce((sum, value) => sum + Number(value || 0), 0);
  const overAllocated = shareTotal > 100;
  const overBy = overAllocated ? (shareTotal - 100) : 0;
  const canAdd = !disabled && names.length < 3 && !adding;

  const commitNames = (nextNames) => {
    const packed = overrideValuesFromNames(nextNames);
    onChangeOverrides(packed);
    // Clearing all people should also drop leftover share % (same as PDE unpin).
    if (!packed.override_1 && !packed.override_2 && !packed.override_3) {
      onChangeShares?.(sharePatchFromValues([]));
      setShares([]);
    }
    setAdding(false);
  };

  return (
    <div className="dl-quick-alloc">
      {slots.length === 0 ? (
        <button
          type="button"
          className="dl-quick-alloc-add"
          disabled={disabled}
          onClick={() => setAdding(true)}
        >
          + Add measurer/biller
        </button>
      ) : (
        slots.map((slot) => (
          <div key={`${slot.index}-${slot.name || 'new'}`} className="dl-quick-alloc-slot">
            <span className="dl-quick-alloc-index" aria-hidden="true">{slot.index + 1}</span>
            <div className="dl-quick-alloc-pair">
              <OverrideSelect
                value={slot.name}
                disabled={disabled}
                groupedEmployees={groupedEmployees}
                ariaLabel={`Measurer/Biller ${slot.index + 1}`}
                onChange={(value) => {
                  const next = names.slice();
                  if (slot.name) {
                    next[slot.index] = value;
                  } else if (value) {
                    next.push(value);
                  }
                  commitNames(next);
                }}
              />
              {slot.name ? (
                <select
                  className={`dl-quick-select dl-quick-alloc-share${disabled ? '' : ' is-editable'}`}
                  value={String(shares[slot.index] ?? '')}
                  disabled={disabled}
                  aria-label={`Hours share for ${slot.name}`}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    const base = shares.length === names.length
                      ? shares
                      : equalHourShares(names.length);
                    const nextShares = redistributeHourShares(base, slot.index, nextValue);
                    setShares(nextShares);
                    onChangeShares?.(sharePatchFromValues(nextShares));
                  }}
                >
                  {sharePercentOptions(shares).map((pct) => (
                    <option key={pct} value={pct}>{pct}%</option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        ))
      )}
      {canAdd && names.length > 0 ? (
        <button
          type="button"
          className="dl-quick-alloc-add"
          onClick={() => setAdding(true)}
        >
          + Add person
        </button>
      ) : null}
      {names.length > 0 ? (
        <span className={`dl-quick-alloc-total${shareTotal === 100 ? ' is-complete' : ''}${overAllocated ? ' is-over' : ''}`}>
          Total {shareTotal}%
        </span>
      ) : null}
      {overAllocated ? (
        <span className="dl-quick-alloc-warning">Over by {overBy}%</span>
      ) : null}
    </div>
  );
}

function ProjectToggle({ project, expanded, onToggle, showStatus = false }) {
  const projectColor = displayProjectColor({ color: project.project_color });

  return (
    <button
      type="button"
      className="dl-quick-update-project-toggle"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="dl-quick-update-chevron" aria-hidden="true">
        {expanded ? '▾' : '▸'}
      </span>
      <span
        className="dl-quick-project-dot"
        style={{ backgroundColor: projectColor }}
        title="Project colour"
        aria-hidden="true"
      />
      <strong className="dl-quick-project-name" title={project.project_name}>
        {project.project_name || 'Untitled project'}
      </strong>
      {showStatus ? (
        <span className={`dl-quick-status is-${project.update_status}`}>
          {formatDlQuickStatus(project.update_status)}
        </span>
      ) : null}
      <span className="dl-quick-project-task-count muted">
        {project.tasks.length === 1 ? '1 task' : `${project.tasks.length} tasks`}
      </span>
    </button>
  );
}

function TaskRow({
  task,
  showTeamColumn = false,
  compact = false,
  leadingCell = null,
  draft,
  canEdit,
  groupedEmployees,
  viewerTeamId = null,
  viewerTeamName = '',
  onPatch,
}) {
  const row = draft ? { ...task, ...draft } : task;
  const allocationEmployees = teamEmployeeGroups(groupedEmployees, {
    teamId: row.team_id || viewerTeamId,
    teamName: row.team_name || viewerTeamName,
  });
  const disabled = !canEdit;
  const dirty = Boolean(draft);
  const editableClass = disabled ? '' : ' is-editable';
  const editableCell = disabled ? '' : ' is-editable-cell';
  const completionPct = percentDisplay(row.progress_per);
  const formatDate = compact ? formatCompactDisplayDate : formatDisplayDate;
  const dashboardLayout = !compact;

  const rfiCell = (
    <td className={`is-check${editableCell}`} title={RFI_CHECKBOX_HELP}>
      <input
        type="checkbox"
        className={editableClass.trim() || undefined}
        checked={isRfiOn(row.rfi)}
        disabled={disabled}
        title={RFI_CHECKBOX_HELP}
        onChange={(event) => onPatch(task, 'rfi', event.target.checked)}
        aria-label={`RFI for ${row.task_name || 'task'}`}
      />
    </td>
  );

  const hoursCell = (
    <td className={`dl-quick-hours-cell${editableCell}`}>
      <input
        className={`dl-quick-input dl-quick-input--hours${editableClass}`}
        type="number"
        min="0"
        step="1"
        value={row.dl ?? ''}
        disabled={disabled}
        onChange={(event) => onPatch(task, 'dl', event.target.value)}
      />
    </td>
  );

  const allocCell = (
    <td className={`dl-quick-alloc-cell${editableCell}`}>
      <AllocationEditor
        task={row}
        disabled={disabled}
        groupedEmployees={allocationEmployees}
        onChangeOverrides={(values) => onPatch(task, values)}
        onChangeShares={(values) => onPatch(task, values)}
      />
    </td>
  );

  const pctCell = (
    <td className={`dl-quick-pct-cell${editableCell}`}>
      <select
        className={`dl-quick-select dl-quick-select--pct${editableClass}${completionPct !== '' ? ' has-value' : ''}`}
        value={completionPct}
        disabled={disabled}
        onChange={(event) => onPatch(task, 'progress_per', event.target.value)}
        aria-label={`Completion percentage for ${row.task_name || 'task'}`}
      >
        {completionPct === '' ? <option value="">—</option> : null}
        {completionPercentOptions(row.progress_per).map((pct) => (
          <option key={pct} value={pct}>{pct}%</option>
        ))}
      </select>
    </td>
  );

  const startCell = (
    <td className="is-readonly-cell dl-quick-date-cell" title={formatDisplayDate(row.doc_supply) || undefined}>
      {formatDate(row.doc_supply) || '—'}
    </td>
  );

  const plannedCell = (
    <td className="is-readonly-cell dl-quick-date-cell" title={formatDisplayDate(row.completion) || undefined}>
      {formatDate(row.completion) || '—'}
    </td>
  );

  const doneCell = (
    <td className={`is-check dl-quick-done-cell${editableCell}`}>
      <input
        type="checkbox"
        className={editableClass.trim() || undefined}
        checked={Boolean(row.done)}
        disabled={disabled}
        onChange={(event) => onPatch(task, 'done', event.target.checked)}
        aria-label={`${getDlFieldLabel('done')} for ${row.task_name || 'task'}`}
      />
    </td>
  );

  const actualCell = (
    <td className={`dl-quick-date-cell${editableCell}`}>
      <input
        className={`dl-quick-input dl-quick-input--date${editableClass}`}
        type="date"
        value={String(row.project_completion_date || '').slice(0, 10)}
        disabled={disabled}
        onChange={(event) => onPatch(task, 'project_completion_date', event.target.value)}
      />
    </td>
  );

  return (
    <tr className={`dl-quick-task-row${dirty ? ' is-dirty' : ''}`}>
      {leadingCell}
      {showTeamColumn ? (
        <td className="is-readonly-cell dl-quick-team-cell">{row.team_name || '—'}</td>
      ) : null}
      <td className="is-readonly-cell dl-quick-task-name-cell">
        <span className="dl-quick-task-name" title={row.task_name || 'Untitled'}>
          {row.task_name || 'Untitled'}
        </span>
      </td>
      {rfiCell}
      {hoursCell}
      {allocCell}
      {dashboardLayout ? (
        <>
          {pctCell}
          {startCell}
          {plannedCell}
          {doneCell}
          {actualCell}
        </>
      ) : (
        <>
          {startCell}
          {plannedCell}
          {doneCell}
          {pctCell}
          {actualCell}
        </>
      )}
    </tr>
  );
}

function DlQuickUpdateLegend({ canEdit }) {
  return (
    <div className="dl-quick-update-legend" aria-label="DL Quick Update legend">
      <span className="dl-quick-update-legend-item">
        <span
          className="dl-quick-project-dot"
          style={{ background: 'conic-gradient(#38bdf8, #22c55e, #f59e0b, #ef4444)' }}
          aria-hidden="true"
        />
        Project colour
      </span>
      {canEdit ? (
        <span className="dl-quick-update-legend-item">
          <span className="dl-quick-update-legend-swatch is-editable" aria-hidden="true" />
          Editable field
        </span>
      ) : null}
      <span className="dl-quick-update-legend-item">
        <span className="dl-quick-update-legend-swatch is-hours" aria-hidden="true" />
        DL hours
      </span>
      <span className="dl-quick-update-legend-item">
        <span className="dl-quick-update-legend-swatch is-readonly" aria-hidden="true" />
        Read-only
      </span>
      <span className="dl-quick-update-legend-item">
        <span className="dl-quick-update-legend-swatch is-dirty" aria-hidden="true" />
        Unsaved change
      </span>
      <span className="dl-quick-update-legend-item muted">
        Click a project row to expand or collapse its tasks
      </span>
    </div>
  );
}

export default function DlQuickUpdateList({
  compact = false,
  hideHeading = false,
  className = '',
  onNavigate = null,
  onMeta = null,
}) {
  const { user } = useAuth();
  const toast = useToast();
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState(() => new Set());
  const [showEditLog, setShowEditLog] = useState(false);
  const [dlFilter, setDlFilter] = useState('');
  const [teamFilter, setTeamFilter] = useState(ALL_TEAMS);
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);
  const [statusFilter, setStatusFilter] = useState(STATUS_ACTIVE);
  const [showRunAlgoAfterSaveModal, setShowRunAlgoAfterSaveModal] = useState(false);
  const [runningAlgorithm, setRunningAlgorithm] = useState(false);
  const [algorithmProgress, setAlgorithmProgress] = useState(initialAlgorithmProgress);

  const showDashboardChrome = !compact;
  const canOpenHistogram = canViewPage(user, 'Resource Histogram');
  const canRunDlAlgorithm = canPageAction(user, 'DL Input Hours', 'run_algorithm');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/dl-quick-update');
      setPayload(response.data?.data ?? null);
      setError('');
    } catch (err) {
      setPayload(null);
      setError(getApiErrorMessage(err, 'Unable to load DL Quick Update.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canEdit = Boolean(payload?.viewer?.can_edit);
  const isTeamScope = payload?.viewer?.scope === 'team' || !payload?.viewer?.can_view_all;
  const showCompactTeamFilter = compact && !isTeamScope;
  const employees = useMemo(
    () => (payload?.employees ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      first_name: entry.name,
      team_id: entry.team_id,
      team: { name: entry.team_name },
      team_name: entry.team_name,
    })),
    [payload?.employees],
  );
  const dls = payload?.dls ?? [];
  const groupedEmployees = useMemo(() => groupEmployees(employees), [employees]);
  const ownerName = useMemo(() => {
    const matched = findEmployeeForAuthUser(user, employees);
    return matched?.name || payload?.viewer?.dl_name || '';
  }, [user, employees, payload?.viewer?.dl_name]);

  useEffect(() => {
    if (!payload?.viewer?.dl_name || dlFilter) {
      return;
    }
    if (isTeamScope) {
      setDlFilter(payload.viewer.dl_name);
    }
  }, [payload?.viewer?.dl_name, isTeamScope, dlFilter]);

  const filterOptions = useMemo(() => {
    const dlNames = [];
    const teams = new Set();
    const projects = new Map();
    const statuses = new Set();

    dls.forEach((dl) => {
      dlNames.push(dl.dl_name);
      dl.projects.forEach((project) => {
        projects.set(String(project.project_id), project.project_name || 'Untitled project');
        if (project.project_status) {
          statuses.add(String(project.project_status).toLowerCase());
        }
        project.tasks.forEach((task) => {
          if (task.team_name) {
            teams.add(task.team_name);
          }
        });
      });
    });

    return {
      dls: [...new Set(dlNames)].sort((a, b) => a.localeCompare(b)),
      teams: [...teams].sort(compareTeamNames),
      projects: [...projects.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      statuses: [...statuses].sort((a, b) => a.localeCompare(b)),
    };
  }, [dls]);

  const filteredDls = useMemo(() => {
    return dls
      .filter((dl) => !dlFilter || dl.dl_name === dlFilter)
      .map((dl) => {
        const projects = dl.projects
          .filter((project) => {
            if (projectFilter && String(project.project_id) !== String(projectFilter)) {
              return false;
            }
            if (statusFilter !== STATUS_ALL) {
              const status = String(project.project_status || '').toLowerCase();
              if (status !== statusFilter) {
                return false;
              }
            }
            return true;
          })
          .map((project) => {
            const tasks = teamFilter
              ? project.tasks.filter((task) => (task.team_name || '') === teamFilter)
              : project.tasks;
            return { ...project, tasks };
          })
          .filter((project) => project.tasks.length > 0);

        return { ...dl, projects };
      })
      .filter((dl) => dl.projects.length > 0);
  }, [dls, dlFilter, projectFilter, statusFilter, teamFilter]);

  const filtersActive = Boolean(
    (dlFilter && !(isTeamScope && dlFilter === payload?.viewer?.dl_name))
    || teamFilter
    || projectFilter
    || statusFilter !== STATUS_ACTIVE,
  );

  const clearFilters = () => {
    setDlFilter(isTeamScope ? (payload?.viewer?.dl_name || '') : '');
    setTeamFilter(ALL_TEAMS);
    setProjectFilter(ALL_PROJECTS);
    setStatusFilter(STATUS_ACTIVE);
  };

  const patchTask = useCallback((task, key, value) => {
    const patch = (key && typeof key === 'object') ? key : { [key]: value };
    setDrafts((current) => {
      const existing = current[String(task.id)] ?? task;
      let next = existing;
      Object.entries(patch).forEach(([field, fieldValue]) => {
        next = applyDlTaskFieldChange(next, field, fieldValue);
        if (field === 'done') {
          next = applyDoneCheckboxChange(next, Boolean(fieldValue), { user, employees });
          next = applyDlMirrorOnChange(next, 'done', next.done);
          next = applyDlMirrorOnChange(next, 'progress_per', next.progress_per);
          next = applyDlMirrorOnChange(next, 'progress_updated', next.progress_updated);
          next = applyDlMirrorOnChange(next, 'owner', next.owner);
          next = applyDlMirrorOnChange(next, 'project_completion_date', next.project_completion_date);
        }
        if (field === 'progress_per') {
          next = applyDlMirrorOnChange(next, 'done', next.done);
        }
      });
      if (!Object.prototype.hasOwnProperty.call(patch, 'owner') && ownerName) {
        next = applyDlTaskFieldChange(next, 'owner', ownerName);
      }
      return { ...current, [String(task.id)]: next };
    });
  }, [employees, ownerName, user]);

  const dirtyTasks = useMemo(() => Object.values(drafts), [drafts]);
  const dirtyCount = dirtyTasks.length;

  /**
   * WP-17: auto-replan only when completion % changed and is not 100% / Done.
   * Uses that exact % of plan hours in the past; the remainder goes to the future.
   */
  const needsProgressReplan = useMemo(() => {
    const originals = new Map();
    dls.forEach((dl) => {
      (dl.projects || []).forEach((project) => {
        (project.tasks || []).forEach((task) => {
          originals.set(String(task.id), task);
        });
      });
    });

    return dirtyTasks.some((task) => {
      const original = originals.get(String(task.id));
      if (!original) {
        return false;
      }
      if (Boolean(task.done) || String(task.progress_per ?? '').trim() === '100') {
        return false;
      }
      const nextPct = Number(String(task.progress_per ?? '').replace(/%$/, ''));
      if (!Number.isFinite(nextPct) || nextPct <= 0 || nextPct >= 100) {
        return false;
      }
      return String(task.progress_per ?? '') !== String(original.progress_per ?? '');
    });
  }, [dirtyTasks, dls]);
  const projectKeys = useMemo(
    () => filteredDls.flatMap((dl) => (
      dl.projects.map((project) => `${dl.dl_name}:${project.project_id}`)
    )),
    [filteredDls],
  );
  const projectKeysSignature = projectKeys.join('|');

  useEffect(() => {
    if (!projectKeysSignature) {
      setExpandedProjects(new Set());
      return;
    }
    setExpandedProjects(new Set(projectKeysSignature.split('|')));
  }, [projectKeysSignature]);

  useEffect(() => {
    if (!onMeta) {
      return;
    }

    if (!payload) {
      onMeta(null);
      return;
    }

    const projectCount = filteredDls.reduce((sum, dl) => sum + dl.projects.length, 0);
    const taskCount = filteredDls.reduce(
      (sum, dl) => sum + dl.projects.reduce((inner, project) => inner + project.tasks.length, 0),
      0,
    );
    const primaryStatus = filteredDls[0]?.update_status || '';

    onMeta({
      rangeStart: payload.range_start || '',
      rangeEnd: payload.range_end || '',
      weekStart: payload.week_start || '',
      projectCount,
      taskCount,
      updateStatus: primaryStatus ? formatDlQuickStatus(primaryStatus) : '',
    });
  }, [onMeta, payload, filteredDls]);

  const toggleProject = (key) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const persistDirtyTasks = useCallback(async () => {
    await api.post('/dl-quick-update/tasks', {
      tasks: dirtyTasks.map((task) => {
        const normalized = normalizeTaskForSave(task);
        return {
          id: task.id,
          rfi: normalized.rfi,
          dl: normalized.dl,
          plan: normalized.plan,
          override_1: normalized.override_1,
          override_2: normalized.override_2,
          override_3: normalized.override_3,
          override_share_1: normalized.override_share_1 ?? '',
          override_share_2: normalized.override_share_2 ?? '',
          override_share_3: normalized.override_share_3 ?? '',
          progress_per: normalized.progress_per,
          progress_left_hours: normalized.progress_left_hours,
          progress_updated: normalized.progress_updated || toStorageDate(new Date()),
          done: Boolean(normalized.done),
          project_completion_date: normalized.project_completion_date,
          owner: normalized.owner,
          dl_sec_hrs_02: normalized.dl_sec_hrs_02,
          dl_sec_hrs_03: normalized.dl_sec_hrs_03,
          dl_sec_hrs_04: normalized.dl_sec_hrs_04,
          dl_sec_hrs_05: normalized.dl_sec_hrs_05,
          dl_sec_hrs_06: normalized.dl_sec_hrs_06,
        };
      }),
    });
    setDrafts({});
  }, [dirtyTasks]);

  const handleSave = async ({ runAlgorithm = false } = {}) => {
    if (!canEdit || dirtyCount === 0) {
      return;
    }
    setShowRunAlgoAfterSaveModal(false);
    setSaving(true);
    try {
      await persistDirtyTasks();

      if (!runAlgorithm) {
        toast.success('DL Quick Update saved.');
        await load();
        return;
      }

      setRunningAlgorithm(true);
      setAlgorithmProgress({
        percent: 18,
        stage: 'Initializing algorithm…',
        processedProjects: 0,
        totalProjects: 0,
        processedTasks: 0,
        totalTasks: 0,
      });

      const { processed, totalTasks } = await runAlgorithmByProject(api, (progress) => {
        setAlgorithmProgress(progress);
      });

      setAlgorithmProgress({
        percent: 96,
        stage: 'Saving algorithm results…',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      await saveAllAlgorithmResults(api);

      setAlgorithmProgress({
        percent: 100,
        stage: 'Done',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      toast.success('DL Quick Update saved and algorithm results applied.');
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(
        err,
        runAlgorithm
          ? 'Unable to save DL updates or run the algorithm.'
          : 'Unable to save DL updates.',
      ));
    } finally {
      setSaving(false);
      setRunningAlgorithm(false);
      setAlgorithmProgress(initialAlgorithmProgress());
    }
  };

  const requestSave = () => {
    if (!canEdit || dirtyCount === 0 || saving || runningAlgorithm) {
      return;
    }
    // WP-17: partial % change → replan so that % of plan stays in the past.
    if (needsProgressReplan && canRunDlAlgorithm) {
      handleSave({ runAlgorithm: true });
      return;
    }
    if (canRunDlAlgorithm) {
      setShowRunAlgoAfterSaveModal(true);
      return;
    }
    handleSave({ runAlgorithm: false });
  };

  const classes = [
    'dl-quick-update',
    compact ? 'dl-quick-update--compact' : '',
    showDashboardChrome ? 'dl-quick-update--dashboard' : '',
    className,
  ].filter(Boolean).join(' ');

  if (loading && !payload) {
    return (
      <div className={classes}>
        <p className="muted">Loading DL Quick Update…</p>
      </div>
    );
  }

  if (error && !payload) {
    return (
      <div className={classes}>
        <div className="alert alert-error" role="alert">{error}</div>
      </div>
    );
  }

  const showTeamColumn = !showDashboardChrome && !isTeamScope;
  const tableHeaders = showDashboardChrome
    ? [
      { key: 'project', label: 'Project' },
      { key: 'task_name', label: 'Task Name' },
      { key: 'rfi', label: 'RFI' },
      { key: 'dl', label: 'DL Hours' },
      { key: 'allocation', label: 'Allocation', sub: 'Person + Hours Share %' },
      { key: 'progress_per', label: 'Completion %', title: 'Completion percentage' },
      { key: 'doc_supply', label: 'Project Start' },
      { key: 'completion', label: 'Planned Completion' },
      { key: 'done', label: 'Done' },
      { key: 'project_completion_date', label: 'Actual Completion' },
    ]
    : [
      { key: 'project', label: 'Project' },
      ...(showTeamColumn ? [{ key: 'team', label: 'Team' }] : []),
      { key: 'task_name', label: getDlFieldLabel('task_name') },
      { key: 'rfi', label: getDlFieldLabel('rfi') },
      { key: 'dl', label: getDlFieldLabel('dl') },
      { key: 'allocation', label: 'Allocation', sub: 'Person + Hours Share %' },
      { key: 'doc_supply', label: getDlFieldLabel('doc_supply') },
      { key: 'completion', label: getDlFieldLabel('completion') },
      { key: 'done', label: getDlFieldLabel('done') },
      { key: 'progress_per', label: 'Completion percentage', title: 'Completion percentage' },
      { key: 'project_completion_date', label: getDlFieldLabel('project_completion_date') },
    ];

  const renderProjectRows = (dl, project, { showTeamColumn = false, showStatus = false } = {}) => {
    const submitKey = `${dl.dl_name}:${project.project_id}`;
    const isExpanded = expandedProjects.has(submitKey);
    const toggle = (
      <ProjectToggle
        project={project}
        expanded={isExpanded}
        showStatus={showStatus}
        onToggle={() => toggleProject(submitKey)}
      />
    );

    if (!isExpanded) {
      return (
        <tr key={submitKey} className="dl-quick-update-project-row">
          <td colSpan={tableHeaders.length}>{toggle}</td>
        </tr>
      );
    }

    return (
      <Fragment key={submitKey}>
        {project.tasks.map((task, index) => (
          <TaskRow
            key={task.id}
            task={task}
            showTeamColumn={showTeamColumn}
            leadingCell={index === 0 ? (
              <td rowSpan={project.tasks.length} className="dl-quick-project-span-cell">
                {toggle}
              </td>
            ) : null}
            compact={compact}
            draft={drafts[String(task.id)]}
            canEdit={canEdit}
            groupedEmployees={groupedEmployees}
            viewerTeamId={payload?.viewer?.team_id}
            viewerTeamName={payload?.viewer?.team_name || ''}
            onPatch={patchTask}
          />
        ))}
      </Fragment>
    );
  };

  return (
    <div className={classes}>
      <div className="dl-quick-update-toolbar">
        <div className="dl-quick-update-heading">
          {hideHeading ? null : <h3 className="section-title">DL Quick Update</h3>}
        </div>
        <div className="dl-quick-update-actions">
          {showDashboardChrome ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowEditLog(true)}
                title="See which DL changed the plan, when, and what they changed"
              >
                View Edit Log History
              </button>
              {canOpenHistogram ? (
                <Link
                  to="/resource-histogram"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigate?.()}
                >
                  Open in Resource Histogram
                </Link>
              ) : null}
            </>
          ) : null}
          {dirtyCount > 0 ? (
            <span className="dl-quick-update-dirty">{dirtyCount} unsaved</span>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={requestSave}
              disabled={saving || runningAlgorithm || dirtyCount === 0}
              title={canRunDlAlgorithm
                ? 'Save DL updates. You will be asked whether to run the algorithm.'
                : 'Save DL updates'}
            >
              {saving || runningAlgorithm
                ? (runningAlgorithm ? 'Running…' : 'Saving…')
                : 'Save changes'}
            </button>
          ) : null}
        </div>
      </div>

      {showCompactTeamFilter ? (
        <div className="dl-quick-update-filters dl-quick-update-filters--compact">
          <label className="dl-quick-filter dl-quick-filter--team">
            Team (Task OAP)
            <select
              value={teamFilter}
              onChange={(event) => setTeamFilter(event.target.value)}
            >
              <option value={ALL_TEAMS}>All teams</option>
              {filterOptions.teams.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm dl-quick-filter-clear"
            onClick={() => setTeamFilter(ALL_TEAMS)}
            disabled={!teamFilter}
          >
            Clear
          </button>
        </div>
      ) : null}

      {showDashboardChrome ? (
        <div className="dl-quick-update-filters">
          <label className="dl-quick-filter dl-quick-filter--dl">
            DL
            <select
              value={dlFilter}
              onChange={(event) => setDlFilter(event.target.value)}
              disabled={isTeamScope && filterOptions.dls.length <= 1}
            >
              {!isTeamScope ? <option value="">All DLs</option> : null}
              {filterOptions.dls.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="dl-quick-filter dl-quick-filter--team">
            Team (Task OAP)
            <select
              value={teamFilter}
              onChange={(event) => setTeamFilter(event.target.value)}
            >
              <option value={ALL_TEAMS}>All teams</option>
              {filterOptions.teams.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="dl-quick-filter dl-quick-filter--project">
            Project
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value={ALL_PROJECTS}>All projects</option>
              {filterOptions.projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className="dl-quick-filter dl-quick-filter--status">
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value={STATUS_ACTIVE}>Active</option>
              <option value={STATUS_ALL}>All statuses</option>
              {filterOptions.statuses
                .filter((status) => status !== STATUS_ACTIVE)
                .map((status) => (
                  <option key={status} value={status}>
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm dl-quick-filter-clear"
            onClick={clearFilters}
            disabled={!filtersActive}
          >
            Clear filters
          </button>
        </div>
      ) : null}

      {showDashboardChrome ? <DlQuickUpdateLegend canEdit={canEdit} /> : null}

      {filteredDls.length === 0 ? (
        <p className="muted dl-quick-update-empty">
          No matching team tasks on active projects for last week, this week, or next week.
        </p>
      ) : showDashboardChrome ? (
        <div className="dl-quick-update-groups">
          {filteredDls.map((dl) => (
            <section key={dl.dl_name} className="dl-quick-update-dl">
              <div className="dl-quick-update-table-wrap">
                <table className="dl-quick-update-table dl-quick-update-table--dashboard">
                  <thead>
                    <tr>
                      {tableHeaders.map(renderTableHeader)}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="dl-quick-update-group-row">
                      <td colSpan={tableHeaders.length}>
                        {dl.dl_name}
                        {' — '}
                        {dl.projects.length}
                        {' '}
                        active project
                        {dl.projects.length === 1 ? '' : 's'}
                      </td>
                    </tr>
                    {dl.projects.map((project) => (
                      renderProjectRows(dl, project, { showStatus: true })
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="dl-quick-update-groups">
          {filteredDls.map((dl) => (
            <section key={dl.dl_name} className="dl-quick-update-dl">
              {isTeamScope ? null : (
                <header className="dl-quick-update-dl-head">
                  <div>
                    <h4>{dl.dl_name}</h4>
                    <p>
                      {dl.team_name ? `${dl.team_name} · ` : null}
                      {formatDlQuickStatus(dl.update_status)}
                      {dl.last_submitted_at ? ` · last submit ${formatDisplayDate(dl.last_submitted_at)}` : ''}
                    </p>
                  </div>
                </header>
              )}

              <div className="dl-quick-update-table-wrap">
                <table className="dl-quick-update-table">
                  <thead>
                    <tr>
                      {tableHeaders.map(renderTableHeader)}
                    </tr>
                  </thead>
                  <tbody>
                    {dl.projects.map((project) => (
                      renderProjectRows(dl, project, {
                        showTeamColumn,
                        showStatus: true,
                      })
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      <ActivityLogModal
        open={showEditLog}
        onClose={() => setShowEditLog(false)}
        area="dl"
        endpoint="/resource-histogram/activity-logs"
        extraParams={DL_PLAN_LOG_PARAMS}
        limit={100}
        title="DL plan edits"
        emptyMessage="No DL plan changes recorded yet."
      />
      <RunAlgorithmAfterSaveModal
        open={showRunAlgoAfterSaveModal}
        onClose={() => {
          if (saving || runningAlgorithm) {
            return;
          }
          setShowRunAlgoAfterSaveModal(false);
        }}
        onSaveOnly={() => handleSave({ runAlgorithm: false })}
        onSaveAndRun={() => handleSave({ runAlgorithm: true })}
        busy={saving || runningAlgorithm}
        contextLabel="DL Quick Update changes"
      />
      <AlgorithmRunningOverlay
        open={runningAlgorithm}
        progress={algorithmProgress.percent}
        stage={algorithmProgress.stage}
        processedProjects={algorithmProgress.processedProjects}
        totalProjects={algorithmProgress.totalProjects}
        processedTasks={algorithmProgress.processedTasks}
        totalTasks={algorithmProgress.totalTasks}
      />
    </div>
  );
}
