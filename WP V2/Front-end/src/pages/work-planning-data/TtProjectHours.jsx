import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client';
import PageHeader from '../../components/PageHeader';
import ProjectColorSelect from '../../components/ProjectColorSelect';
import TtHoursLoadIndicator from '../../components/TtHoursLoadIndicator';
import TtHoursProjectsChart from '../../components/TtHoursProjectsChart';
import { useToast } from '../../context/ToastContext';
import { fetchAllTtProjectsSummaries } from '../../utils/ttWpProgressSync';
import {
  isTtHoursCacheStale,
  readTtHoursCache,
  writeTtHoursCache,
} from '../../utils/ttHoursCache';
import { announceTtNewProjects } from '../../utils/ttNewProjectAnnounce';
import {
  buildTtNotifyRows,
  detectNewTtProjects,
} from '../../utils/ttNewProjectNotify';
import { createTtSession, getCredentialsFromEnv } from '../../utils/timeTracking';
import {
  applyTtHoursDisplayFilters,
  buildTtEmployeeFilterGroups,
  buildTtMonthFilterOptions,
  buildTtProjectFilterOptions,
  buildTtTeamFilterOptions,
  formatProjectFilterLabel,
  formatSummaryPeriod,
  groupTtTaskRowsByTeam,
  summariesHaveDistinctPeriods,
  TT_HOURS_SORT_OPTIONS,
  wpNamesDiffer,
} from '../../utils/ttHoursFilters';
import { formatMonthWindowLabel } from '../../utils/timeTracking';
import { sortTasksBySection } from '../../utils/taskSectionDefaults';
import { canPageAction, canViewPage } from '../../utils/userPermissions';
import { useAuth } from '../../context/AuthContext';
import '../../styles/tt-hours-page.css';

function formatHours(value) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(1) : '—';
}

function formatFetchedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function VarianceCell({ value }) {
  if (value == null || value === '') {
    return <span className="tt-hours-num tt-hours-num--zero">—</span>;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) {
    return <span className="tt-hours-num tt-hours-num--zero">0.0</span>;
  }
  const prefix = number > 0 ? '+' : '';
  const tone = number > 0 ? 'tt-hours-num--positive' : 'tt-hours-num--negative';
  return (
    <span className={`tt-hours-num ${tone}`}>
      {prefix}
      {number.toFixed(1)}
    </span>
  );
}

function ProjectRowCell({ summary }) {
  const displayName = formatProjectFilterLabel(
    summary.ttProjectName || summary.projectName,
    summary.jobNumber,
  );
  const showWpName = wpNamesDiffer(summary);

  return (
    <div className="tt-hours-project-cell">
      <span
        className="tt-hours-swatch"
        style={{ backgroundColor: summary.color || '#e2e8f0' }}
        aria-hidden="true"
      />
      <div className="tt-hours-project-copy">
        <div className="tt-hours-project-primary" title={summary.ttProjectName || summary.projectName}>
          {summary.jobNumber ? (
            <span className="tt-hours-project-job">#{summary.jobNumber}</span>
          ) : null}
          <span className="tt-hours-project-title">{displayName || '—'}</span>
        </div>
        {showWpName ? (
          <div className="tt-hours-project-wp" title={summary.wpProjectName}>
            WP:
            {' '}
            {summary.wpProjectName}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TaskMatchCell({ matched = 0, total = 0 }) {
  const safeTotal = Math.max(Number(total) || 0, 0);
  const safeMatched = Math.min(Math.max(Number(matched) || 0, 0), safeTotal || Number(matched) || 0);
  const percent = safeTotal > 0 ? Math.round((safeMatched / safeTotal) * 100) : 0;

  return (
    <div className="tt-hours-task-match" title={`${safeMatched} of ${safeTotal} tasks matched`}>
      <span className="tt-hours-task-match__value">
        {safeMatched}
        /
        {safeTotal}
      </span>
      <span className="tt-hours-task-match__bar" aria-hidden="true">
        <span
          className="tt-hours-task-match__bar-fill"
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}

function DetailPanelHeader({ summary }) {
  return (
    <div className="tt-hours-detail-header">
      <ProjectRowCell summary={summary} />
      <div className="tt-hours-detail-header__stats">
        <span>
          <strong>{formatHours(summary.totalTtHours)}</strong>
          {' '}
          TT hrs
        </span>
        {summary.employeeFilterActive ? (
          <span className="tt-hours-detail-header__note">
            Showing
            {' '}
            {summary.filteredEmployeeName || 'employee'}
            {' '}
            only
          </span>
        ) : summary.teamFilterActive ? (
          <span className="tt-hours-detail-header__note">
            Showing
            {' '}
            {summary.filteredTeamName || 'team'}
            {' '}
            only
          </span>
        ) : (
          <>
            <span>
              <strong>{formatHours(summary.totalPlanHours)}</strong>
              {' '}
              plan
            </span>
            <span>
              Variance
              {' '}
              <VarianceCell value={summary.variance} />
            </span>
          </>
        )}
        <span className="tt-hours-detail-header__period">
          {formatSummaryPeriod(summary.monthStart, summary.monthEnd)}
        </span>
      </div>
    </div>
  );
}

function employeeKey(person, fallback = 'unassigned') {
  if (person?.wpEmployeeId != null) return `wp:${person.wpEmployeeId}`;
  if (person?.userId != null) return `id:${person.userId}`;
  if (person?.name) return `name:${String(person.name).toLowerCase()}`;
  return fallback;
}

function buildTaskEmployeeNode(person, hours, extras = {}) {
  return {
    key: person.wpEmployeeId != null
      ? `wp:${person.wpEmployeeId}`
      : employeeKey(person),
    userId: person.userId ?? null,
    wpEmployeeId: person.wpEmployeeId ?? null,
    wpMatched: person.wpMatched !== false && person.wpEmployeeId != null
      ? true
      : person.wpMatched,
    name: person.name || (person.userId != null ? `User #${person.userId}` : 'Unassigned'),
    hours: Math.round((Number(hours) || 0) * 10) / 10,
    ...extras,
  };
}

function tasksFromRows(rows = []) {
  return sortTasksBySection(
    (rows || [])
      .map((row) => {
        const people = Array.isArray(row.employeeHours) && row.employeeHours.length > 0
          ? row.employeeHours
          : [{ userId: null, name: '', hours: Number(row.ttHours) || 0 }];
        const employees = people
          .map((person) => buildTaskEmployeeNode(person, person.hours))
          .filter((person) => person.hours > 0)
          .sort((left, right) => right.hours - left.hours || left.name.localeCompare(right.name));
        const hours = employees.length > 0
          ? employees.reduce((sum, person) => sum + person.hours, 0)
          : (Number(row.ttHours) || 0);
        if (hours <= 0) return null;
        return {
          key: String(row.taskName || '').toLowerCase() || 'task',
          taskName: row.taskName || 'Task',
          hours: Math.round(hours * 10) / 10,
          planHours: row.planHours,
          variance: row.variance,
          employees,
        };
      })
      .filter(Boolean),
    (task) => task.taskName,
  );
}

function ProjectTeamHierarchy({ groups = [], fallbackRows = [] }) {
  const hierarchy = useMemo(() => {
    if (groups.length > 0) {
      return groups.map((group) => {
        const tasks = tasksFromRows(group.rows || []);
        return {
          key: String(group.teamId ?? group.teamName ?? 'team'),
          teamName: group.teamName || 'No Team',
          hours: group.hours,
          tasks,
        };
      }).filter((team) => team.tasks.length > 0);
    }

    const tasks = tasksFromRows(fallbackRows);
    if (tasks.length === 0) return [];

    return [{
      key: 'all',
      teamName: 'All tasks',
      hours: Math.round(tasks.reduce((sum, task) => sum + (Number(task.hours) || 0), 0) * 10) / 10,
      tasks,
    }];
  }, [groups, fallbackRows]);

  const [expandedTeams, setExpandedTeams] = useState(() => new Set());
  const [expandedTasks, setExpandedTasks] = useState(() => new Set());

  useEffect(() => {
    const nextTeams = new Set(hierarchy.map((team) => team.key));
    const nextTasks = new Set();
    hierarchy.forEach((team) => {
      team.tasks.forEach((task) => {
        nextTasks.add(`${team.key}::${task.key}`);
      });
    });
    setExpandedTeams(nextTeams);
    setExpandedTasks(nextTasks);
  }, [hierarchy]);

  const toggleSetKey = (setter, key) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (hierarchy.length === 0) {
    return <p className="tt-hours-detail-empty">No task-level matches for this project.</p>;
  }

  return (
    <div className="tt-hours-hierarchy">
      <table className="tt-hours-detail-table tt-hours-detail-table--hierarchy">
        <colgroup>
          <col className="tt-hours-col-expand" />
          <col />
          <col className="tt-hours-col-num" />
          <col className="tt-hours-col-num" />
          <col className="tt-hours-col-num" />
        </colgroup>
        <thead>
          <tr>
            <th aria-label="Expand" />
            <th>Team / Task / Employee</th>
            <th className="tt-hours-th--num">TT hrs</th>
            <th className="tt-hours-th--num">Plan hrs</th>
            <th className="tt-hours-th--num">Variance</th>
          </tr>
        </thead>
        <tbody>
          {hierarchy.map((team) => {
            const teamExpanded = expandedTeams.has(team.key);
            return (
              <Fragment key={team.key}>
                <tr
                  className={`tt-hours-hierarchy-row tt-hours-hierarchy-row--team${teamExpanded ? ' is-expanded' : ''}`}
                  onClick={() => toggleSetKey(setExpandedTeams, team.key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleSetKey(setExpandedTeams, team.key);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-expanded={teamExpanded}
                >
                  <td>
                    <button
                      type="button"
                      className="tt-hours-expand-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleSetKey(setExpandedTeams, team.key);
                      }}
                      aria-expanded={teamExpanded}
                      aria-label={teamExpanded ? 'Collapse team' : 'Expand team'}
                    >
                      {teamExpanded ? '▼' : '▶'}
                    </button>
                  </td>
                  <td>
                    <span className="tt-hours-hierarchy-label tt-hours-hierarchy-label--team">
                      {team.teamName}
                      <span className="tt-hours-team-count">
                        {' '}
                        (
                        {team.tasks.length}
                        {' '}
                        task
                        {team.tasks.length === 1 ? '' : 's'}
                        )
                      </span>
                    </span>
                  </td>
                  <td className="tt-hours-num">{formatHours(team.hours)}</td>
                  <td className="tt-hours-num">—</td>
                  <td className="tt-hours-num">—</td>
                </tr>

                {teamExpanded
                  ? team.tasks.map((task) => {
                    const taskKey = `${team.key}::${task.key}`;
                    const taskExpanded = expandedTasks.has(taskKey);
                    return (
                      <Fragment key={taskKey}>
                        <tr
                          className={`tt-hours-hierarchy-row tt-hours-hierarchy-row--task-mid${taskExpanded ? ' is-expanded' : ''}`}
                          onClick={() => toggleSetKey(setExpandedTasks, taskKey)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleSetKey(setExpandedTasks, taskKey);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          aria-expanded={taskExpanded}
                        >
                          <td>
                            {task.employees.length > 0 ? (
                              <button
                                type="button"
                                className="tt-hours-expand-btn"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleSetKey(setExpandedTasks, taskKey);
                                }}
                                aria-expanded={taskExpanded}
                                aria-label={taskExpanded ? 'Collapse employees' : 'Expand employees'}
                              >
                                {taskExpanded ? '▼' : '▶'}
                              </button>
                            ) : null}
                          </td>
                          <td>
                            <span className="tt-hours-hierarchy-label tt-hours-hierarchy-label--task-mid">
                              {task.taskName}
                            </span>
                          </td>
                          <td className="tt-hours-num">{formatHours(task.hours)}</td>
                          <td className="tt-hours-num">{formatHours(task.planHours)}</td>
                          <td className="tt-hours-num">
                            <VarianceCell value={task.variance} />
                          </td>
                        </tr>

                        {taskExpanded
                          ? task.employees.map((person) => (
                            <tr
                              key={`${taskKey}::${person.key}`}
                              className="tt-hours-hierarchy-row tt-hours-hierarchy-row--emp-leaf"
                            >
                              <td />
                              <td>
                                <span className="tt-hours-hierarchy-label tt-hours-hierarchy-label--emp-leaf">
                                  {person.name}
                                  {person.wpMatched === false ? (
                                    <span className="tt-hours-hierarchy-unmatched" title="No matching Work Planner employee">
                                      {' '}
                                      (TT only)
                                    </span>
                                  ) : null}
                                </span>
                              </td>
                              <td className="tt-hours-num">{formatHours(person.hours)}</td>
                              <td className="tt-hours-num">—</td>
                              <td className="tt-hours-num">—</td>
                            </tr>
                          ))
                          : null}
                      </Fragment>
                    );
                  })
                  : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProjectDetailPanel({ summary, teams = [], wpEmployees = [] }) {
  const hasEmployees = summary.employeeRows?.length > 0;
  const taskGroups = useMemo(
    () => groupTtTaskRowsByTeam(summary.taskRows || [], teams, wpEmployees),
    [summary.taskRows, teams, wpEmployees],
  );
  const taskRows = useMemo(
    () => sortTasksBySection(summary.taskRows || [], (row) => row.taskName),
    [summary.taskRows],
  );
  const adminHours = summary.adminHours || [];
  const hasTasks = taskRows.length > 0;

  if (!summary.hasJobNumber) {
    return (
      <p className="tt-hours-detail-empty">
        No job number found on this TT project — cannot match to Work Planner.
      </p>
    );
  }

  if (summary.totalTtHours <= 0 && !hasEmployees && adminHours.length === 0) {
    return (
      <p className="tt-hours-detail-empty">
        No Time Tracking hours in
        {' '}
        {formatSummaryPeriod(summary.monthStart, summary.monthEnd)}
        {' '}
        for job #
        {summary.jobNumber}.
      </p>
    );
  }

  return (
    <div className="tt-hours-detail-panel">
      <DetailPanelHeader summary={summary} />
      <section className="tt-hours-detail-section">
        <h4 className="tt-hours-detail-section__title">Project → Team → Task → Employee</h4>
        {hasTasks ? (
          <ProjectTeamHierarchy groups={taskGroups} fallbackRows={taskRows} />
        ) : (
          <p className="tt-hours-detail-empty">No task-level matches for this project.</p>
        )}
        {adminHours.length > 0 ? (
          <ul className="tt-hours-admin-list">
            {adminHours.map((item, index) => (
              <li key={`${item.taskName}-${index}`}>
                Unmatched TT:
                {' '}
                {item.taskName}
                {' '}
                (
                {formatHours(item.hours)}
                h)
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

export default function TtProjectHours() {
  const { user } = useAuth();
  const toast = useToast();
  const [wpProjects, setWpProjects] = useState([]);
  const [teams, setTeams] = useState([]);
  const [wpEmployees, setWpEmployees] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [ttUsers, setTtUsers] = useState([]);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [loadingWpProjects, setLoadingWpProjects] = useState(true);
  const [loadingTt, setLoadingTt] = useState(false);
  const [refreshingInBackground, setRefreshingInBackground] = useState(false);
  const [sliceProgress, setSliceProgress] = useState(null);
  const [loadPhase, setLoadPhase] = useState(null);
  const [pageError, setPageError] = useState('');
  const [filterProjectId, setFilterProjectId] = useState('');
  const [filterTeamId, setFilterTeamId] = useState('');
  const [filterEmployeeId, setFilterEmployeeId] = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [filterSort, setFilterSort] = useState('date');
  const [hideZeroHours, setHideZeroHours] = useState(true);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);
  const bootstrappedRef = useRef(false);
  const loadGenRef = useRef(0);
  const wpProjectsRef = useRef([]);
  const wpEmployeesRef = useRef([]);
  const ttUsersRef = useRef([]);
  const progressFlushTimerRef = useRef(null);
  const pendingProgressRef = useRef(null);

  const canView = canViewPage(user, 'TT Project Hours');
  const canRefreshTtHours = canPageAction(user, 'TT Project Hours', 'refresh');

  useEffect(() => {
    wpProjectsRef.current = wpProjects;
  }, [wpProjects]);

  useEffect(() => {
    wpEmployeesRef.current = wpEmployees;
  }, [wpEmployees]);

  useEffect(() => {
    ttUsersRef.current = ttUsers;
  }, [ttUsers]);

  const hydrateFromCache = useCallback((cached) => {
    const matchedSummaries = (cached.summaries ?? []).filter(
      (row) => row.wpMatchStatus === 'matched' && row.wpProjectId != null,
    );
    setSummaries(matchedSummaries);
    setTtUsers(cached.ttUsers ?? []);
    ttUsersRef.current = cached.ttUsers ?? [];
    setDateRange(cached.dateRange ?? { start: '', end: '' });
    setLastFetchedAt(cached.fetchedAt ?? null);
  }, []);

  const notifyNewTtProjects = useCallback((summaries = [], comparison = null) => {
    const newTtProjects = detectNewTtProjects(buildTtNotifyRows(summaries, comparison));
    if (!newTtProjects.length) return;
    announceTtNewProjects(newTtProjects, toast);
  }, [toast]);

  const loadWpSupportData = useCallback(async () => {
    const [projectsRes, allocationRes] = await Promise.all([
      api.get('/projects/tt-comparison', { params: { all: true } }),
      api.get('/operatives-allocation'),
    ]);
    const projects = projectsRes.data?.data ?? [];
    const allocationPayload = allocationRes.data?.data ?? allocationRes.data ?? {};
    setWpProjects(projects);
    wpProjectsRef.current = projects;
    setTeams(allocationPayload.teams ?? []);
    const employees = allocationPayload.employees ?? [];
    setWpEmployees(employees);
    wpEmployeesRef.current = employees;
    return projects;
  }, []);

  const flushProgressUpdate = useCallback(() => {
    const pending = pendingProgressRef.current;
    if (!pending) return;

    setSliceProgress({
      sliceLabel: pending.sliceLabel,
      sliceIndex: pending.sliceIndex,
      sliceTotal: pending.sliceTotal,
    });
    setLoadPhase({
      message: pending.background ? 'Refreshing TT hours in background…' : 'Fetching matched TT hours…',
      detail: `${pending.sliceLabel} (${pending.sliceIndex} of ${pending.sliceTotal})`,
      percent: pending.sliceTotal > 0
        ? Math.round((pending.sliceIndex / pending.sliceTotal) * 100)
        : null,
    });
    setSummaries(pending.summaries);
    setDateRange({ start: pending.monthStart, end: pending.monthEnd });
    pendingProgressRef.current = null;
  }, []);

  const queueProgressUpdate = useCallback((update) => {
    pendingProgressRef.current = update;
    if (progressFlushTimerRef.current) return;
    progressFlushTimerRef.current = window.setTimeout(() => {
      progressFlushTimerRef.current = null;
      flushProgressUpdate();
    }, 250);
  }, [flushProgressUpdate]);

  const loadTtHours = useCallback(async ({
    silent = false,
    background = false,
    cachedUsers = [],
  } = {}) => {
    if (!user) {
      if (!silent) {
        setPageError('Not logged into Work Planner.');
        toast.error('Not logged into Work Planner.');
      }
      return;
    }

    const gen = ++loadGenRef.current;
    const isStale = () => loadGenRef.current !== gen;

    if (background) {
      setRefreshingInBackground(true);
    } else {
      setLoadingTt(true);
    }
    setSliceProgress(null);
    setPageError('');
    if (!background) {
      setLoadPhase({ message: 'Logging into Time Tracking…' });
    }

    try {
      const wpListPromise = wpProjectsRef.current.length
        ? Promise.resolve(wpProjectsRef.current)
        : loadWpSupportData().catch((error) => {
          console.error(error);
          if (!silent) {
            toast.error('Work Planner projects could not be loaded — TT hours will load without plan-hour enrichment.');
          }
          return [];
        });

      if (!background) setLoadPhase({ message: 'Logging into Time Tracking…' });
      const { loginname, password } = getCredentialsFromEnv();
      const session = await createTtSession({
        loginname,
        password,
        discoverUsers: false,
      });
      if (isStale()) return;

      let users = cachedUsers.length ? cachedUsers : ttUsersRef.current;
      if (!users.length) {
        users = session.users || [];
      }
      setTtUsers(users);
      ttUsersRef.current = users;

      const wpList = await wpListPromise;
      if (isStale()) return;
      if (!background) {
        setLoadPhase({ message: 'Fetching matched TT hours…' });
      }

      const {
        summaries: nextSummaries,
        comparison,
        monthStart,
        monthEnd,
      } = await fetchAllTtProjectsSummaries({
        ttToken: session.token,
        oapAllowedTtUserIds: null,
        ttUsers: users,
        wpProjects: wpList,
        wpEmployees: wpEmployeesRef.current,
        includeWpOnly: false,
        matchedOnly: true,
        onProgress: ({
          summaries: partial,
          sliceLabel,
          sliceIndex,
          sliceTotal,
          monthStart: rangeStart,
          monthEnd: rangeEnd,
        }) => {
          if (isStale()) return;
          queueProgressUpdate({
            summaries: partial,
            sliceLabel,
            sliceIndex,
            sliceTotal,
            monthStart: rangeStart,
            monthEnd: rangeEnd,
            background,
          });
        },
      });

      if (isStale()) return;

      if (progressFlushTimerRef.current) {
        window.clearTimeout(progressFlushTimerRef.current);
        progressFlushTimerRef.current = null;
      }
      flushProgressUpdate();

      setSummaries(nextSummaries);
      setDateRange({ start: monthStart, end: monthEnd });
      if (!background) {
        setExpandedIds(new Set());
      }

      if (!nextSummaries.length && !silent) {
        setPageError('No matched TT projects were found for last month and this month.');
        toast.error('No matched TT projects with hours were found.');
      }

      notifyNewTtProjects(nextSummaries, comparison);

      const fetchedAt = Date.now();
      setLastFetchedAt(fetchedAt);
      if (!background) {
        setLoadPhase({ message: 'Saving to Work Planner…' });
      }
      const saved = await writeTtHoursCache({
        fetchedAt,
        summaries: nextSummaries,
        ttUsers: users,
        dateRange: { start: monthStart, end: monthEnd },
      });
      if (isStale()) return;
      if (!saved && !silent) {
        toast.error('TT hours loaded but could not be saved to Work Planner.');
      } else if (saved && !silent && !background && nextSummaries.length) {
        toast.success(`Saved ${nextSummaries.length} project summaries to Work Planner.`);
      }
    } catch (error) {
      console.error(error);
      if (isStale()) return;
      const message = error?.message || 'Failed to load Time Tracking hours.';
      if (!silent) {
        setPageError(message);
        toast.error(message);
      }
    } finally {
      if (isStale()) return;
      if (progressFlushTimerRef.current) {
        window.clearTimeout(progressFlushTimerRef.current);
        progressFlushTimerRef.current = null;
      }
      pendingProgressRef.current = null;
      setLoadingTt(false);
      setRefreshingInBackground(false);
      setSliceProgress(null);
      setLoadPhase(null);
    }
  }, [user, toast, loadWpSupportData, queueProgressUpdate, flushProgressUpdate, notifyNewTtProjects]);

  const loadTtHoursRef = useRef(loadTtHours);
  loadTtHoursRef.current = loadTtHours;

  useEffect(() => {
    if (!canView || !user || bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    (async () => {
      setLoadPhase({ message: 'Loading saved TT hours…' });

      const [cacheResult, wpResult] = await Promise.allSettled([
        readTtHoursCache(),
        (async () => {
          setLoadingWpProjects(true);
          try {
            return await loadWpSupportData();
          } finally {
            setLoadingWpProjects(false);
          }
        })(),
      ]);

      const cached = cacheResult.status === 'fulfilled' ? cacheResult.value : null;
      if (wpResult.status === 'rejected') {
        console.error(wpResult.reason);
        toast.error('Work Planner projects could not be loaded — filters may be limited.');
      }

      if (cached?.summaries?.length) {
        hydrateFromCache(cached);
        setLoadPhase(null);

        if (!isTtHoursCacheStale(cached.fetchedAt) || !canRefreshTtHours) {
          return;
        }

        loadTtHoursRef.current({
          silent: true,
          background: true,
          cachedUsers: cached.ttUsers ?? [],
        });
        return;
      }

      setLoadPhase(null);
      if (!canRefreshTtHours) {
        return;
      }
      loadTtHoursRef.current({
        silent: false,
        cachedUsers: cached?.ttUsers ?? [],
      });
    })();
  }, [canRefreshTtHours, canView, user, hydrateFromCache, loadWpSupportData, toast]);

  useEffect(() => () => {
    loadGenRef.current += 1;
    if (progressFlushTimerRef.current) {
      window.clearTimeout(progressFlushTimerRef.current);
    }
  }, []);

  const matchedSummaries = useMemo(
    () => summaries.filter((row) => row.wpMatchStatus === 'matched'),
    [summaries],
  );

  const projectFilterOptions = useMemo(
    () => buildTtProjectFilterOptions(matchedSummaries),
    [matchedSummaries],
  );

  const projectSelectOptions = useMemo(
    () => projectFilterOptions.map((option) => ({
      id: option.id,
      color: option.color,
      name: option.displayLabel,
      jobNumber: option.jobNumber,
    })),
    [projectFilterOptions],
  );

  const teamFilterOptions = useMemo(
    () => buildTtTeamFilterOptions(matchedSummaries, teams, wpEmployees),
    [matchedSummaries, teams, wpEmployees],
  );

  const employeeFilterGroups = useMemo(() => {
    const groups = buildTtEmployeeFilterGroups(matchedSummaries, teams, wpEmployees);
    if (!filterTeamId) return groups;
    return groups.filter((group) => String(group.teamId) === String(filterTeamId));
  }, [matchedSummaries, teams, wpEmployees, filterTeamId]);

  const employeeFilterOptions = useMemo(
    () => employeeFilterGroups.flatMap((group) => group.members),
    [employeeFilterGroups],
  );

  useEffect(() => {
    if (!filterEmployeeId) return;
    const stillValid = employeeFilterOptions.some((option) => String(option.id) === String(filterEmployeeId));
    if (!stillValid) setFilterEmployeeId('');
  }, [filterEmployeeId, employeeFilterOptions]);

  useEffect(() => {
    if (!filterTeamId) return;
    const stillValid = teamFilterOptions.some((option) => String(option.id) === String(filterTeamId));
    if (!stillValid) setFilterTeamId('');
  }, [filterTeamId, teamFilterOptions]);

  const monthFilterOptions = useMemo(
    () => buildTtMonthFilterOptions(matchedSummaries),
    [matchedSummaries],
  );

  const displaySummaries = useMemo(() => {
    const filtered = applyTtHoursDisplayFilters(summaries, {
      projectId: filterProjectId,
      teamId: filterTeamId,
      employeeId: filterEmployeeId,
      month: filterMonth,
      sort: filterSort,
      employees: wpEmployees,
      teams,
    });
    if (!hideZeroHours) return filtered;
    return filtered.filter((row) => Number(row.totalTtHours) > 0);
  }, [
    summaries,
    filterProjectId,
    filterTeamId,
    filterEmployeeId,
    filterMonth,
    filterSort,
    hideZeroHours,
    wpEmployees,
    teams,
  ]);

  const showPeriodColumn = useMemo(
    () => summariesHaveDistinctPeriods(displaySummaries),
    [displaySummaries],
  );

  const employeeFilterActive = Boolean(filterEmployeeId);
  const teamFilterActive = Boolean(filterTeamId);
  const hoursOnlyFilterActive = employeeFilterActive || teamFilterActive;
  const hiddenZeroCount = hideZeroHours
    ? applyTtHoursDisplayFilters(summaries, {
      projectId: filterProjectId,
      teamId: filterTeamId,
      employeeId: filterEmployeeId,
      month: filterMonth,
      sort: filterSort,
      employees: wpEmployees,
      teams,
    }).filter((row) => Number(row.totalTtHours) <= 0).length
    : 0;

  const totals = useMemo(() => displaySummaries.reduce(
    (acc, row) => ({
      tt: acc.tt + (row.totalTtHours || 0),
      plan: acc.plan + (Number(row.totalPlanHours) || 0),
    }),
    { tt: 0, plan: 0 },
  ), [displaySummaries]);

  const totalVariance = hoursOnlyFilterActive
    ? null
    : Number((totals.tt - totals.plan).toFixed(1));

  const cacheIsStale = isTtHoursCacheStale(lastFetchedAt);
  const lastFetchedLabel = formatFetchedAt(lastFetchedAt);
  const hasActiveFilters = Boolean(
    filterProjectId || filterTeamId || filterEmployeeId || filterMonth,
  );
  const sortLabel = TT_HOURS_SORT_OPTIONS.find((option) => option.id === filterSort)?.label
    || 'Newest activity';

  const activeFilterPills = useMemo(() => {
    const pills = [];
    if (filterMonth) {
      const month = monthFilterOptions.find((option) => option.id === filterMonth);
      pills.push({
        key: 'month',
        label: 'Month',
        value: month?.label || filterMonth,
        onClear: () => setFilterMonth(''),
      });
    }
    if (filterProjectId) {
      const project = projectFilterOptions.find((option) => option.id === filterProjectId);
      pills.push({
        key: 'project',
        label: 'Project',
        value: project
          ? `${project.jobNumber ? `${project.jobNumber} — ` : ''}${project.displayLabel || project.label}`
          : filterProjectId,
        onClear: () => setFilterProjectId(''),
      });
    }
    if (filterTeamId) {
      const team = teamFilterOptions.find((option) => option.id === filterTeamId);
      pills.push({
        key: 'team',
        label: 'Team',
        value: team?.label || filterTeamId,
        onClear: () => setFilterTeamId(''),
      });
    }
    if (filterEmployeeId) {
      const employee = employeeFilterOptions.find((option) => option.id === filterEmployeeId);
      pills.push({
        key: 'employee',
        label: 'Employee',
        value: employee?.label || filterEmployeeId,
        onClear: () => setFilterEmployeeId(''),
      });
    }
    return pills;
  }, [
    filterMonth,
    filterProjectId,
    filterTeamId,
    filterEmployeeId,
    monthFilterOptions,
    projectFilterOptions,
    teamFilterOptions,
    employeeFilterOptions,
  ]);

  const clearFilters = () => {
    setFilterProjectId('');
    setFilterTeamId('');
    setFilterEmployeeId('');
    setFilterMonth('');
  };

  const toggleExpand = (projectId) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedIds(new Set(displaySummaries.map((row) => row.projectId)));
  };

  const collapseAll = () => {
    setExpandedIds(new Set());
  };

  const loadProgressPercent = sliceProgress?.sliceTotal
    ? Math.round((sliceProgress.sliceIndex / sliceProgress.sliceTotal) * 100)
    : null;

  const loadIndicator = loadPhase || (loadingTt ? {
    message: 'Connecting to Time Tracking…',
    detail: '',
    percent: null,
  } : null);

  const dataScopeLabel = dateRange.start && dateRange.end
    ? formatMonthWindowLabel(dateRange.start, dateRange.end)
    : 'Last month + this month';

  const showInitialLoading = loadingTt && summaries.length === 0;

  if (!canView) {
    return (
      <section className="page tt-hours-page">
        <PageHeader title="TT Project Hours" />
        <p className="muted">You do not have permission to view this page.</p>
      </section>
    );
  }

  return (
    <section className="page tt-hours-page">
      <TtHoursLoadIndicator
        visible={Boolean(loadIndicator)}
        message={loadIndicator?.message || 'Loading…'}
        detail={loadIndicator?.detail || ''}
        percent={loadIndicator?.percent ?? loadProgressPercent}
      />

      <PageHeader
        compact
        title="TT Project Hours"
        eyebrow="Time Tracking ↔ Work Planner"
      />

      {pageError ? (
        <div className="alert alert-error" role="alert">
          {pageError}
        </div>
      ) : null}

      <div className="card tt-hours-panel">
        <div className="tt-hours-panel__top">
          <div className="tt-hours-panel__intro inline-heading">
            <h3 className="tt-hours-panel__title inline-heading__title">Filters &amp; data</h3>
            <p className="tt-hours-panel__meta inline-heading__meta">
              Matched projects by job number · last month + this month:
              {' '}
              {dataScopeLabel}
              {lastFetchedLabel ? (
                <>
                  <span className="tt-hours-panel__meta-dot">·</span>
                  Last updated
                  {' '}
                  {lastFetchedLabel}
                </>
              ) : null}
              <span className="tt-hours-panel__meta-dot">·</span>
              Saved in Work Planner · auto-refresh every 2 days
            </p>
          </div>
          <div className="tt-hours-panel__actions">
            {lastFetchedAt ? (
              <span className={`tt-hours-status${cacheIsStale ? ' tt-hours-status--stale' : ''}${loadingTt || refreshingInBackground ? ' tt-hours-status--loading' : ''}`}>
                {loadingTt
                  ? 'Refreshing…'
                  : refreshingInBackground
                    ? 'Updating…'
                    : cacheIsStale
                      ? 'Refresh due'
                      : 'Up to date'}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-compact"
              disabled={!canRefreshTtHours || loadingTt || refreshingInBackground}
              onClick={() => loadTtHours()}
            >
              {loadingTt || refreshingInBackground ? 'Loading…' : summaries.length ? 'Refresh' : 'Load data'}
            </button>
          </div>
        </div>

        <div className="tt-hours-panel__filters">
          <label className="tt-hours-filter-sort">
            Sort
            <select
              className="tt-hours-filter-control"
              value={filterSort}
              onChange={(event) => setFilterSort(event.target.value)}
              disabled={!matchedSummaries.length}
            >
              {TT_HOURS_SORT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="tt-hours-filter-month">
            Month
            <select
              className="tt-hours-filter-control"
              value={filterMonth}
              onChange={(event) => setFilterMonth(event.target.value)}
              disabled={!monthFilterOptions.length}
            >
              <option value="">All months</option>
              {monthFilterOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="tt-hours-filter-project">
            Project
            <ProjectColorSelect
              projects={projectSelectOptions}
              value={filterProjectId}
              onChange={setFilterProjectId}
              placeholder="All matched projects"
              allowEmpty
              disableAutoWidth
              disabled={!projectSelectOptions.length}
              formatProjectLabel={(project) => formatProjectFilterLabel(project?.name, project?.jobNumber)}
            />
          </label>

          <label className="tt-hours-filter-team">
            Team
            <select
              className="tt-hours-filter-control"
              value={filterTeamId}
              onChange={(event) => setFilterTeamId(event.target.value)}
              disabled={!teamFilterOptions.length}
            >
              <option value="">All teams</option>
              {teamFilterOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="tt-hours-filter-employee">
            Employee
            <select
              className="tt-hours-filter-control"
              value={filterEmployeeId}
              onChange={(event) => setFilterEmployeeId(event.target.value)}
              disabled={!employeeFilterGroups.length}
            >
              <option value="">All employees</option>
              {employeeFilterGroups.map((group) => (
                <optgroup key={group.teamId ?? group.teamName} label={group.teamName}>
                  {group.members.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="tt-hours-zero-toggle">
            <input
              type="checkbox"
              checked={hideZeroHours}
              onChange={(event) => setHideZeroHours(event.target.checked)}
            />
            Hide 0h projects
          </label>

          <div className="tt-hours-panel__filter-actions">
            {hasActiveFilters ? (
              <button type="button" className="btn btn-secondary btn-compact" onClick={clearFilters}>
                Clear all
              </button>
            ) : null}
          </div>
        </div>

        {activeFilterPills.length > 0 ? (
          <div className="tt-hours-active-filters">
            <span className="tt-hours-active-filters__label">Active</span>
            {activeFilterPills.map((pill) => (
              <span key={pill.key} className="tt-hours-pill">
                {pill.label}
                :
                {' '}
                <strong>{pill.value}</strong>
                <button type="button" onClick={pill.onClear} aria-label={`Remove ${pill.label} filter`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="tt-hours-body">
      <div className="card tt-hours-table-card">
        {showInitialLoading ? (
          <div className="tt-hours-loading">
            <p className="muted">
              {sliceProgress
                ? `Loading ${sliceProgress.sliceLabel} (${sliceProgress.sliceIndex} of ${sliceProgress.sliceTotal})`
                : 'Connecting to Time Tracking…'}
            </p>
            {sliceProgress ? (
              <div className="tt-hours-loading__bar" aria-hidden="true">
                <div
                  className="tt-hours-loading__bar-fill"
                  style={{ width: `${loadProgressPercent}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {displaySummaries.length > 0 ? (
              <div className="tt-hours-table-bar">
                <p className="tt-hours-table-bar__title">
                  Showing
                  {' '}
                  {displaySummaries.length}
                  {' '}
                  project
                  {displaySummaries.length === 1 ? '' : 's'}
                  {' '}
                  ·
                  {' '}
                  {sortLabel.toLowerCase()}
                  {!showPeriodColumn && dataScopeLabel ? (
                    <>
                      {' '}
                      ·
                      {' '}
                      {dataScopeLabel}
                    </>
                  ) : null}
                  {hiddenZeroCount > 0 ? (
                    <>
                      {' '}
                      ·
                      {' '}
                      {hiddenZeroCount}
                      {' '}
                      with 0h hidden
                    </>
                  ) : null}
                </p>
                <div className="tt-hours-table-bar__actions">
                  <button type="button" className="btn btn-secondary btn-compact" onClick={expandAll}>
                    Expand all
                  </button>
                  <button type="button" className="btn btn-secondary btn-compact" onClick={collapseAll}>
                    Collapse all
                  </button>
                </div>
              </div>
            ) : null}

            <div className="tt-hours-table-shell">
              <table className="tt-hours-table">
                <colgroup>
                  <col className="tt-hours-col-expand" />
                  <col className="tt-hours-col-project" />
                  {showPeriodColumn ? <col className="tt-hours-col-period" /> : null}
                  <col className="tt-hours-col-num" />
                  <col className="tt-hours-col-num" />
                  <col className="tt-hours-col-num" />
                  <col className="tt-hours-col-count" />
                  <col className="tt-hours-col-count" />
                </colgroup>
                <thead>
                  <tr>
                    <th aria-label="Expand" />
                    <th>Project</th>
                    {showPeriodColumn ? <th>Period</th> : null}
                    <th className="tt-hours-th--num">TT hrs</th>
                    <th className="tt-hours-th--num">Plan hrs</th>
                    <th className="tt-hours-th--num">Variance</th>
                    <th className="tt-hours-th--num">Staff</th>
                    <th className="tt-hours-th--num">Tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {displaySummaries.map((row) => {
                    const isExpanded = expandedIds.has(row.projectId);
                    const rowTone = row.totalTtHours <= 0
                      ? 'is-zero-hours'
                      : Number(row.variance) > 0
                        ? 'is-over-plan'
                        : '';
                    const detailColSpan = showPeriodColumn ? 8 : 7;

                    return (
                      <Fragment key={row.projectId}>
                        <tr
                          className={`tt-hours-project-row${isExpanded ? ' is-expanded' : ''}${rowTone ? ` ${rowTone}` : ''}`}
                          onClick={() => toggleExpand(row.projectId)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleExpand(row.projectId);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          aria-expanded={isExpanded}
                        >
                          <td>
                            <button
                              type="button"
                              className="tt-hours-expand-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleExpand(row.projectId);
                              }}
                              aria-expanded={isExpanded}
                              aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                            >
                              {isExpanded ? '▼' : '▶'}
                            </button>
                          </td>
                          <td>
                            <ProjectRowCell summary={row} />
                          </td>
                          {showPeriodColumn ? (
                            <td className="tt-hours-date-range">
                              {formatSummaryPeriod(row.monthStart, row.monthEnd)}
                            </td>
                          ) : null}
                          <td className="tt-hours-num">{formatHours(row.totalTtHours)}</td>
                          <td className="tt-hours-num">
                            {row.employeeFilterActive || row.teamFilterActive
                              ? '—'
                              : formatHours(row.totalPlanHours)}
                          </td>
                          <td className="tt-hours-num">
                            {row.employeeFilterActive || row.teamFilterActive
                              ? '—'
                              : <VarianceCell value={row.variance} />}
                          </td>
                          <td className="tt-hours-num">
                            {row.employeeCount ?? row.employeeRows?.length ?? 0}
                          </td>
                          <td className="tt-hours-num">
                            <TaskMatchCell
                              matched={row.matchedTaskCount}
                              total={row.taskCount}
                            />
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr className="tt-hours-detail-row">
                            <td colSpan={detailColSpan}>
                              <ProjectDetailPanel
                                summary={row}
                                teams={teams}
                                wpEmployees={wpEmployees}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
                {displaySummaries.length > 0 ? (
                  <tfoot>
                    <tr>
                      <td colSpan={showPeriodColumn ? 3 : 2}>
                        <strong>Totals</strong>
                        {' '}
                        (
                        {displaySummaries.length}
                        {' '}
                        projects)
                      </td>
                      <td className="tt-hours-num">{formatHours(totals.tt)}</td>
                      <td className="tt-hours-num">
                        {hoursOnlyFilterActive ? '—' : formatHours(totals.plan)}
                      </td>
                      <td className="tt-hours-num">
                        {hoursOnlyFilterActive ? '—' : <VarianceCell value={totalVariance} />}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                ) : null}
              </table>

              {!loadingTt && !summaries.length ? (
                <div className="tt-hours-empty">
                  <p className="muted">
                    Click
                    {' '}
                    <strong>Load data</strong>
                    {' '}
                    to fetch matched TT ↔ WP projects.
                    {loadingWpProjects ? ' (WP projects still loading…)' : ''}
                  </p>
                </div>
              ) : null}

              {!loadingTt && summaries.length > 0 && displaySummaries.length === 0 ? (
                <div className="tt-hours-empty">
                  <p className="muted">
                    {hideZeroHours && hiddenZeroCount > 0
                      ? 'All matching projects have 0 TT hours. Uncheck “Hide 0h projects” to see them.'
                      : 'No projects match the current filters.'}
                  </p>
                  {hasActiveFilters ? (
                    <button type="button" className="btn btn-secondary btn-compact" onClick={clearFilters}>
                      Clear filters
                    </button>
                  ) : hideZeroHours ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-compact"
                      onClick={() => setHideZeroHours(false)}
                    >
                      Show 0h projects
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      {!showInitialLoading ? (
        <TtHoursProjectsChart
          summaries={displaySummaries}
          selectedProjectId={filterProjectId}
          onSelectProject={setFilterProjectId}
        />
      ) : null}
      </div>
    </section>
  );
}
