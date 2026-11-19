import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client';
import {
  ProjectProgressLegend,
  ProjectProgressProjectHeader,
  ProjectProgressTaskGrid,
} from '../../components/TaskSectionHoursTable';
import { AvailabilityPageSkeleton } from '../../components/PageSkeleton';
import PageHeader from '../../components/PageHeader';
import ExceedsDlHoursModal from '../../components/ExceedsDlHoursModal';
import { useToast } from '../../context/ToastContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { useAuth } from '../../context/AuthContext';
import { employeeDisplayName, findEmployeeForAuthUser } from '../../utils/employeeNames';
import { sortEmployeesByTeamThenName } from '../../utils/teamOrder';
import {
  applySectionDetailFieldChange,
  recalculateSectionHoursTotal,
  SECTION_HOUR_KEYS,
  findTasksExceedingDlHours,
  taskExceedsDlHours,
} from '../../utils/taskSectionDetailCalculations';
import {
  canApproveSectionHours,
  canPageAction,
  canViewAllProgressEmployees,
  canWarnExceedsDlHours,
} from '../../utils/userPermissions';
import { getProjectEffectiveStatus } from '../../utils/projectSort';
import { readTtHoursCache } from '../../utils/ttHoursCache';
import {
  buildTtHoursProgressIndex,
  enrichProgressProjectGroups,
} from '../../utils/ttHoursProgressLookup';

function normalizeProjectGroups(groups) {
  return (groups ?? [])
    .filter((group) => getProjectEffectiveStatus(group.project) === 'active')
    .map((group) => ({
      project: group.project,
      tasks: (group.tasks ?? []).map((task) => ({
        ...task,
        sec_hrs_total: recalculateSectionHoursTotal(task),
      })),
    }));
}

function flattenTasks(groups) {
  return groups.flatMap((group) => group.tasks);
}

export default function ProjectProgress() {
  const toast = useToast();
  const { user } = useAuth();
  const isDlApprover = canApproveSectionHours(user);
  const canWarnExceedsDl = canWarnExceedsDlHours(user);
  const canViewAllEmployees = canViewAllProgressEmployees(user);
  const canEditHours = canPageAction(user, 'Project Progress', 'edit_hours');

  const [employees, setEmployees] = useState([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [projectGroups, setProjectGroups] = useState([]);
  const projectGroupsRef = useRef(projectGroups);
  const [loadingEmployees, setLoadingEmployees] = useState(true);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState(() => new Set());
  const [filterProjectId, setFilterProjectId] = useState('');
  const [filterPartId, setFilterPartId] = useState('');
  const [showExceedsDlModal, setShowExceedsDlModal] = useState(false);
  const [exceedsDlTasks, setExceedsDlTasks] = useState([]);
  const [ttHoursIndex, setTtHoursIndex] = useState(() => new Map());

  const loggedInEmployee = useMemo(
    () => findEmployeeForAuthUser(user, employees),
    [user, employees],
  );

  const selectableEmployees = useMemo(() => {
    if (canViewAllEmployees) {
      return employees;
    }
    if (loggedInEmployee) {
      return [loggedInEmployee];
    }
    return [];
  }, [employees, canViewAllEmployees, loggedInEmployee]);

  const selectedEmployee = employees.find(
    (employee) => String(employee.id) === String(selectedEmployeeId),
  );

  const filteredProjectGroups = useMemo(() => {
    let groups = projectGroups;

    if (filterProjectId) {
      groups = groups.filter((group) => String(group.project.id) === String(filterProjectId));
    }

    if (filterPartId) {
      groups = groups
        .map((group) => ({
          ...group,
          tasks: group.tasks.filter((task) => String(task.part_id) === String(filterPartId)),
        }))
        .filter((group) => group.tasks.length > 0);
    }

    return groups;
  }, [projectGroups, filterProjectId, filterPartId]);

  const totalAssignedTasks = useMemo(
    () => flattenTasks(filteredProjectGroups).length,
    [filteredProjectGroups],
  );

  const approvedTaskCount = useMemo(
    () => flattenTasks(filteredProjectGroups).filter((task) => task.dl_sec_hrs_approved).length,
    [filteredProjectGroups],
  );

  const exceedsDlTaskCount = useMemo(() => {
    if (!canWarnExceedsDl) {
      return 0;
    }
    return flattenTasks(filteredProjectGroups).filter((task) => taskExceedsDlHours(task)).length;
  }, [filteredProjectGroups, canWarnExceedsDl]);

  const availableParts = useMemo(() => {
    const map = new Map();
    projectGroups.forEach((group) => {
      if (filterProjectId && String(group.project.id) !== String(filterProjectId)) {
        return;
      }
      group.tasks.forEach((task) => {
        if (!task.part_id) {
          return;
        }
        map.set(String(task.part_id), {
          id: task.part_id,
          name: task.part_name || `Part ${task.part_id}`,
          projectId: group.project.id,
        });
      });
    });
    return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [projectGroups, filterProjectId]);

  const totalAssignedTasksAll = useMemo(
    () => flattenTasks(projectGroups).length,
    [projectGroups],
  );

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

  const applyTtHoursToGroups = useCallback((groups, employee, index = ttHoursIndex) => (
    enrichProgressProjectGroups(groups, index, employee)
  ), [ttHoursIndex]);

  const loadAssignments = useCallback(async (employeeId) => {
    if (!employeeId) {
      setProjectGroups([]);
      setCollapsedProjects(new Set());
      return;
    }

    setLoadingAssignments(true);
    try {
      const { data } = await api.get(`/employees/${employeeId}/section-task-assignments`);
      const employee = employees.find((row) => String(row.id) === String(employeeId));
      const groups = applyTtHoursToGroups(
        normalizeProjectGroups(data.data),
        employee,
      );
      setProjectGroups(groups);
      setFilterProjectId('');
      setFilterPartId('');
      setCollapsedProjects(
        groups.length === 1
          ? new Set()
          : new Set(groups.map((group) => String(group.project.id))),
      );
      setError('');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to load assigned tasks for this employee.');
      setError(message);
      setProjectGroups([]);
    } finally {
      setLoadingAssignments(false);
    }
  }, [applyTtHoursToGroups, employees]);

  useEffect(() => {
    projectGroupsRef.current = projectGroups;
  }, [projectGroups]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const cached = await readTtHoursCache();
      if (cancelled) return;
      setTtHoursIndex(buildTtHoursProgressIndex(cached?.summaries ?? []));
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedEmployeeId || projectGroups.length === 0 || ttHoursIndex.size === 0) {
      return;
    }

    setProjectGroups((current) => applyTtHoursToGroups(
      current.map((group) => ({
        ...group,
        tasks: group.tasks.map(({ tt_hours_logged, ...task }) => task),
      })),
      selectedEmployee,
    ));
  }, [ttHoursIndex, selectedEmployee, applyTtHoursToGroups, selectedEmployeeId]);

  useEffect(() => {
    if (loadingEmployees) {
      return;
    }

    if (!isDlApprover && loggedInEmployee) {
      setSelectedEmployeeId(String(loggedInEmployee.id));
      return;
    }

    if (
      selectedEmployeeId
      && !selectableEmployees.some((employee) => String(employee.id) === String(selectedEmployeeId))
    ) {
      setSelectedEmployeeId('');
    }
  }, [loadingEmployees, isDlApprover, loggedInEmployee, selectableEmployees, selectedEmployeeId]);

  useEffect(() => {
    loadAssignments(selectedEmployeeId);
  }, [selectedEmployeeId, loadAssignments]);

  const handleEmployeeChange = (event) => {
    setSelectedEmployeeId(event.target.value);
    setFilterProjectId('');
    setFilterPartId('');
  };

  const handleFilterProjectChange = (event) => {
    const nextProjectId = event.target.value;
    setFilterProjectId(nextProjectId);
    if (!nextProjectId) {
      return;
    }
    if (filterPartId) {
      const partStillValid = projectGroups.some((group) => (
        String(group.project.id) === String(nextProjectId)
        && group.tasks.some((task) => String(task.part_id) === String(filterPartId))
      ));
      if (!partStillValid) {
        setFilterPartId('');
      }
    }
  };

  const handleFilterPartChange = (event) => {
    const nextPartId = event.target.value;
    setFilterPartId(nextPartId);
    if (!nextPartId) {
      return;
    }
    const match = availableParts.find((part) => String(part.id) === String(nextPartId));
    if (match?.projectId) {
      setFilterProjectId(String(match.projectId));
    }
  };

  const clearProjectPartFilters = () => {
    setFilterProjectId('');
    setFilterPartId('');
  };

  const expandAllProjects = () => {
    setCollapsedProjects(new Set());
  };

  const collapseAllProjects = () => {
    setCollapsedProjects(new Set(projectGroups.map((group) => String(group.project.id))));
  };

  const toggleProject = (projectId) => {
    const key = String(projectId);
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleTaskChange = useCallback((projectId, rowIndex, key, value) => {
    setProjectGroups((current) =>
      current.map((group) => {
        if (String(group.project.id) !== String(projectId)) {
          return group;
        }

        return {
          ...group,
          tasks: group.tasks.map((task, index) => (
            index === rowIndex ? applySectionDetailFieldChange(task, key, value) : task
          )),
        };
      }),
    );
  }, []);

  const lockedFieldPredicate = useCallback((task, fieldKey) => {
    if (fieldKey === 'dl_sec_hrs_approved') {
      return !isDlApprover;
    }

    if (!canEditHours) {
      return true;
    }

    if (
      isDlApprover
      && !user?.is_admin
      && SECTION_HOUR_KEYS.includes(fieldKey)
    ) {
      return true;
    }

    if (SECTION_HOUR_KEYS.includes(fieldKey) && task.dl_sec_hrs_approved && !isDlApprover) {
      return true;
    }

    return false;
  }, [canEditHours, isDlApprover, user?.is_admin]);

  const saveSectionHours = useCallback(async () => {
    if (!selectedEmployeeId || totalAssignedTasksAll === 0) {
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });

    setSaving(true);
    try {
      const tasks = flattenTasks(projectGroupsRef.current).map((task) => ({
        id: task.id,
        sec_hrs_02: task.sec_hrs_02 ?? '',
        sec_hrs_03: task.sec_hrs_03 ?? '',
        sec_hrs_04: task.sec_hrs_04 ?? '',
        sec_hrs_05: task.sec_hrs_05 ?? '',
        sec_hrs_06: task.sec_hrs_06 ?? '',
        sec_hrs_07: task.sec_hrs_07 ?? '',
        sec_hrs_extra: task.sec_hrs_extra ?? '',
        sec_hrs_total: task.sec_hrs_total ?? '',
        dl_sec_hrs_approved: Boolean(task.dl_sec_hrs_approved),
      }));

      const { data } = await api.post(`/employees/${selectedEmployeeId}/section-task-hours/sync`, {
        tasks,
      });

      const savedById = new Map((data.data || []).map((task) => [String(task.id), task]));

      setProjectGroups((current) =>
        current.map((group) => ({
          ...group,
          tasks: group.tasks.map((task) => {
            const saved = savedById.get(String(task.id));
            return saved ? { ...task, ...saved } : task;
          }),
        })),
      );

      toast.success('Expected hours saved.');
      setError('');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to save expected hours.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [selectedEmployeeId, toast, totalAssignedTasksAll]);

  const handleSave = async () => {
    if (!selectedEmployeeId || totalAssignedTasksAll === 0 || saving) {
      return;
    }

    if (canWarnExceedsDl) {
      const overBudget = findTasksExceedingDlHours(
        flattenTasks(projectGroupsRef.current),
        { compareDlSectionsOnly: false },
      );
      if (overBudget.length > 0) {
        setExceedsDlTasks(overBudget);
        setShowExceedsDlModal(true);
        return;
      }
    }

    await saveSectionHours();
  };

  if (loadingEmployees) {
    return <AvailabilityPageSkeleton />;
  }

  return (
    <section className="project-progress-page user-availability-page">
      <PageHeader
        compact
        title="Measurer's Time Planning"
        eyebrow="Expected hours by employee"
        actions={(
          <button
            type="button"
            className="btn btn-save btn-compact"
            onClick={handleSave}
            disabled={!canEditHours || !selectedEmployeeId || saving || totalAssignedTasksAll === 0}
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        )}
      />

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {isDlApprover ? (
        <div className="project-progress-info-banner" role="note">
          As a DL, review operative entries and tick <strong>DL</strong> to approve expected hours.
          {' '}
          Hour fields are read-only for DLs; operatives enter hours on their own view.
          {canWarnExceedsDl ? ' Amber rows exceed the DL budget.' : ''}
        </div>
      ) : null}

      <div className="availability-toolbar card project-progress-toolbar">
        <div className="availability-toolbar-filters project-progress-toolbar-filters">
          <label>
            Employee
            <select
              value={selectedEmployeeId}
              onChange={handleEmployeeChange}
              disabled={!canViewAllEmployees && Boolean(loggedInEmployee)}
            >
              <option value="">Select employee</option>
              {selectableEmployees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employeeDisplayName(employee)}
                </option>
              ))}
            </select>
          </label>

          {selectedEmployee ? (
            <>
              <label>
                Project
                <select value={filterProjectId} onChange={handleFilterProjectChange}>
                  <option value="">All projects</option>
                  {projectGroups.map((group) => (
                    <option key={group.project.id} value={group.project.id}>
                      {group.project.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Part
                <select value={filterPartId} onChange={handleFilterPartChange}>
                  <option value="">All parts</option>
                  {availableParts.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="availability-total project-progress-stat">
                <span>Assigned tasks</span>
                <strong>
                  {totalAssignedTasks}
                  {filterProjectId || filterPartId ? ` / ${totalAssignedTasksAll}` : ''}
                </strong>
              </div>
              <div className="availability-total project-progress-stat">
                <span>Projects</span>
                <strong>
                  {filteredProjectGroups.length}
                  {filterProjectId || filterPartId ? ` / ${projectGroups.length}` : ''}
                </strong>
              </div>
              <div className="availability-total project-progress-stat project-progress-stat--approved">
                <span>Approved</span>
                <strong>{approvedTaskCount}</strong>
              </div>
              {canWarnExceedsDl ? (
                <div className="availability-total project-progress-stat project-progress-stat--exceeds-dl">
                  <span>Exceeds DL</span>
                  <strong>{exceedsDlTaskCount}</strong>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {selectedEmployee && projectGroups.length > 0 ? (
          <div className="availability-toolbar-actions project-progress-toolbar-actions">
            {(filterProjectId || filterPartId) ? (
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={clearProjectPartFilters}
              >
                Clear project/part
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={expandAllProjects}
            >
              Expand all
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={collapseAllProjects}
            >
              Collapse all
            </button>
          </div>
        ) : null}
      </div>

      {selectedEmployee ? <ProjectProgressLegend showExceedsDlHint={canWarnExceedsDl} /> : null}

      {!isDlApprover && !loggedInEmployee ? (
        <div className="card muted-card">
          Your user account is not linked to an operative profile. Contact an administrator to enter expected hours.
        </div>
      ) : null}

      {selectedEmployeeId ? (
        <div className={`project-progress-stage${loadingAssignments ? ' is-refreshing' : ''}`}>
          {loadingAssignments && projectGroups.length === 0 ? (
            <AvailabilityPageSkeleton />
          ) : projectGroups.length === 0 ? (
            <div className="card muted-card">
              No assigned tasks found for {employeeDisplayName(selectedEmployee)}.
              <br />
              Run the algorithm from Project Data Entry or DL Input Hours first.
            </div>
          ) : filteredProjectGroups.length === 0 ? (
            <div className="card muted-card">
              No tasks match the selected project or part filter.
            </div>
          ) : (
            <>
              {loadingAssignments ? (
                <p className="project-progress-loading-hint muted" role="status">
                  Refreshing assignments...
                </p>
              ) : null}
              <div className="project-progress-projects">
                {filteredProjectGroups.map((group) => {
                  const projectId = String(group.project.id);
                  const expanded = !collapsedProjects.has(projectId);
                  const approvedCount = group.tasks.filter((task) => task.dl_sec_hrs_approved).length;

                  return (
                    <div
                      key={projectId}
                      className={`card project-progress-project${expanded ? ' is-expanded' : ''}`}
                    >
                      <ProjectProgressProjectHeader
                        project={group.project}
                        taskCount={group.tasks.length}
                        approvedCount={approvedCount}
                        expanded={expanded}
                        onToggle={() => toggleProject(group.project.id)}
                      />
                      {expanded ? (
                        <ProjectProgressTaskGrid
                          tasks={group.tasks}
                          employees={employees}
                          lockedFieldPredicate={lockedFieldPredicate}
                          highlightExceedsDl={canWarnExceedsDl}
                          onChange={(rowIndex, key, value) => handleTaskChange(group.project.id, rowIndex, key, value)}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="card muted-card">
          Select an employee to view assigned projects and enter expected hours.
        </div>
      )}

      <ExceedsDlHoursModal
        open={showExceedsDlModal}
        onClose={() => {
          if (saving) {
            return;
          }
          setShowExceedsDlModal(false);
          setExceedsDlTasks([]);
        }}
        onConfirm={async () => {
          setShowExceedsDlModal(false);
          setExceedsDlTasks([]);
          await saveSectionHours();
        }}
        busy={saving}
        tasks={exceedsDlTasks}
      />
    </section>
  );
}
