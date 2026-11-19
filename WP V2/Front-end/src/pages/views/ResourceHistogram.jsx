import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { resolveTrainingLogNavigationTarget } from '../../utils/trainingActivityLog';
import HistogramEditLogModal from '../../components/gantt/HistogramEditLogModal';
import RunAlgorithmAfterSaveModal from '../../components/RunAlgorithmAfterSaveModal';
import DisplayDateInput from '../../components/DisplayDateInput';
import { HistogramPageSkeleton } from '../../components/PageSkeleton';
import PageHeader from '../../components/PageHeader';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { useTaskSyncConflictModal } from '../../hooks/useTaskSyncConflictModal';
import { isTaskSyncCancelled } from '../../utils/taskSync';
import { showSaveNotifications, showTaskSyncNotifications } from '../../utils/taskSyncNotifications';
import { canDeleteTrainings, canEditHistogramBars, canPageAction } from '../../utils/userPermissions';
import {
  dlTrainingUrl,
  trainingOpenDestination,
  trainingOpenTitle,
  trainingRosterParams,
} from '../../utils/trainingNavigation';
import {
  buildDlPlanEditByTaskId,
  planLogTaskIds,
} from '../../utils/planActivityLog';
import {
  histogramZoomLabel,
  isHistogramZoomAtMax,
  isHistogramZoomAtMin,
  stepHistogramZoomIn,
  stepHistogramZoomOut,
} from '../../constants/histogramZoom';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import HistogramChartRefreshOverlay from '../../components/gantt/HistogramChartRefreshOverlay';
import HistogramTaskEditorPanel from '../../components/gantt/HistogramTaskEditorPanel';
import HistogramEmployeeDetailPanel from '../../components/gantt/HistogramEmployeeDetailPanel';
import HistogramTrainingDetailPanel from '../../components/gantt/HistogramTrainingDetailPanel';
import DeleteConfirmModal from '../../components/DeleteConfirmModal';
import HistogramMiniLegend from '../../components/gantt/HistogramMiniLegend';
import ResourceHistogramView from '../../components/gantt/ResourceHistogramView';
import { scrollHistogramToDay, scrollHistogramToTask } from '../../components/gantt/SyncedHorizontalScroll';
import ProjectHistogramLegend from '../../components/gantt/ProjectHistogramLegend';
import HistogramReadingGuide from '../../components/gantt/HistogramReadingGuide';
import {
  buildTrainingDeleteModalCopy,
  resolveTrainingAssignmentDeleteTarget,
  resolveTrainingSessionDeleteTarget,
} from '../../utils/trainingDeleteConfirm';
import { normalizeTrainingRecords, normalizeTrainingRecord } from '../../utils/trainingForm';
import { saveAllAlgorithmResults } from '../../utils/algorithm';
import { runAlgorithmByProject } from '../../utils/algorithmRun';
import {
  buildDailyHoursFromBars,
  buildHiddenCompletedProjectIdSet,
  buildProjectLegendItems,
  clipEmployeeDayMapToRange,
  dayCapacityForRow,
  defaultHistogramDateRange,
  expandViewRangeToInclude,
  filterBarsByDateRange,
  filterHistogramBarsForDisplay,
  filterLiteralHistogramBars,
  filterHistogramByTeam,
  histogramMaxEndFromStart,
  normalizeHistogramDateSelection,
  normalizeList,
  projectHasAllDocs,
  resolveHistogramDataEnvelope,
  viewRangeNeedsEnvelopeRefetch,
} from '../../components/gantt/ganttUtils';
import { HISTOGRAM_DEFAULT_WORK_DAY_HOURS } from '../../components/gantt/histogramLayout';
import HistogramViewOptionsDropdown from '../../components/gantt/HistogramViewOptionsDropdown';
import { clearBarResizeEdgeState, describeBarChange } from '../../components/gantt/histogramBarEdits';
import { applyTaskDraftToTaskBars, resolveTaskBarsDateEnvelope, taskDraftAffectsHistogram, taskDraftOverrideChanged } from '../../components/gantt/taskEditorLivePreview';
import { toStorageDate } from '../../utils/dateFormat';
import { formatProjectDropdownLabel } from '../../utils/projectSort';
import { normalizeTaskForSave, recalculateProgressLeft } from '../../utils/taskCalculations';
import { syncTaskDoneAndProgress } from '../../utils/pdeDoneEffects';
import { employeeMatchesName, employeeNameKey } from '../../utils/employeeNames';

const HISTOGRAM_CHART_ONLY_KEY = 'wp2-histogram-chart-only';

function currentUserDisplayName(user) {
  if (!user) {
    return 'You';
  }
  return user.name || user.login_name || user.email || 'You';
}

function mapSavedLogToEntry(log) {
  if (!log) {
    return null;
  }
  const kind = log.kind || (log.action === 'training_project_override' ? 'training_project_override' : 'bar_edit');
  return {
    id: `saved-${log.id}`,
    source: 'saved',
    activityLogId: log.id,
    type: 'saved',
    kind,
    action: log.action || kind,
    summary: log.summary,
    editSummaries: log.edit_summaries || [],
    userName: log.user_name || 'Unknown',
    undone: Boolean(log.undone),
    canUndo: kind === 'training_project_override' ? false : Boolean(log.can_undo),
    createdAt: log.created_at ? new Date(log.created_at).getTime() : 0,
  };
}

function cloneOverrideBar(bar) {
  if (!bar) {
    return null;
  }
  return { ...bar, hours_by_day: { ...(bar.hours_by_day || {}) } };
}

function resolveFullBarSchedule(barId, overrides, fullAllocationBars) {
  const full = fullAllocationBars.find((entry) => entry.id === barId);
  const override = overrides?.[barId];
  if (!override) {
    return full;
  }
  return {
    ...(full || override),
    ...override,
    hours_by_day: { ...(override.hours_by_day || {}) },
  };
}

/** Keep off-window hours from the full bar; apply in-window edits from the commit. */
function mergeCommittedBarSchedule(nextBar, viewRange, overrides, fullAllocationBars) {
  if (!nextBar?.id || !viewRange?.start || !viewRange?.end) {
    return nextBar;
  }

  const viewStart = viewRange.start;
  const viewEnd = viewRange.end;
  const fullBar = resolveFullBarSchedule(nextBar.id, overrides, fullAllocationBars);
  const fullHours = fullBar?.hours_by_day || {};
  const merged = {};

  Object.entries(fullHours).forEach(([day, hours]) => {
    if (day < viewStart || day > viewEnd) {
      const amount = Number(hours) || 0;
      if (amount > 0.001) {
        merged[day] = amount;
      }
    }
  });

  Object.entries(nextBar.hours_by_day || {}).forEach(([day, hours]) => {
    if (day >= viewStart && day <= viewEnd) {
      const amount = Number(hours) || 0;
      if (amount > 0.001) {
        merged[day] = amount;
      }
    }
  });

  const activeDays = Object.keys(merged)
    .filter((day) => (Number(merged[day]) || 0) > 0.001)
    .sort();
  const totalHours = activeDays.reduce((sum, day) => sum + (Number(merged[day]) || 0), 0);

  return {
    ...nextBar,
    hours_by_day: merged,
    hours: totalHours > 0.001 ? Math.round(totalHours * 10000) / 10000 : nextBar.hours,
    start: activeDays[0] || nextBar.start,
    end: activeDays.at(-1) || nextBar.end,
  };
}

function mergeHistogramEditsByTaskEmployee(edits) {
  const byKey = new Map();

  edits.forEach((edit) => {
    const key = `${edit.task_id}::${String(edit.employee || '').trim().toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...edit,
        hours_by_day: { ...(edit.hours_by_day || {}) },
        previous_hours_by_day: { ...(edit.previous_hours_by_day || {}) },
      });
      return;
    }

    Object.entries(edit.hours_by_day || {}).forEach(([day, hours]) => {
      const amount = Number(hours) || 0;
      if (amount > 0.001) {
        existing.hours_by_day[day] = amount;
      }
    });
    Object.entries(edit.previous_hours_by_day || {}).forEach(([day, hours]) => {
      existing.previous_hours_by_day[day] = (
        existing.previous_hours_by_day[day] || 0
      ) + (Number(hours) || 0);
    });
    if (!existing.bar_id && edit.bar_id) {
      existing.bar_id = edit.bar_id;
    }
  });

  return Array.from(byKey.values());
}

function resolveTypicalDayCapacityForEmployee(
  employee,
  availabilityHours,
  employeeHolidays,
  employees,
) {
  if (!employee) {
    return HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
  }

  const byEmployee = availabilityHours?.[employee];
  if (byEmployee && typeof byEmployee === 'object') {
    const caps = Object.values(byEmployee)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (caps.length > 0) {
      return Math.min(...caps);
    }
  }

  const sampleCap = dayCapacityForRow(
    employee,
    toStorageDate(new Date()),
    availabilityHours,
    employeeHolidays,
    employees,
  );
  return sampleCap ?? HISTOGRAM_DEFAULT_WORK_DAY_HOURS;
}

function buildTaskEditorOverridesSlice(taskId, overrides, fullAllocationBars) {
  const slice = {};
  fullAllocationBars.forEach((bar) => {
    if (String(bar.task_id) !== String(taskId)) {
      return;
    }
    slice[bar.id] = cloneOverrideBar(overrides[bar.id]);
  });
  return slice;
}

function buildHistogramScheduleEdits(overrides, allocationBars) {
  const edits = Object.entries(overrides)
    .filter(([, bar]) => !bar?._suppressedByBarEdit)
    .map(([barId, bar]) => {
      const originalBar = allocationBars.find((entry) => entry.id === barId);
      const previousEmployee = originalBar?.employee;
      const nextEmployee = bar.employee;

      // Clear hours from the previous assignee's fragments (critical for reassign).
      const previousEmployeeKey = String(previousEmployee || nextEmployee || '').trim().toLowerCase();
      const previousRelatedBars = allocationBars.filter((entry) => (
        String(entry.task_id) === String(bar.task_id)
        && String(entry.employee || '').trim().toLowerCase() === previousEmployeeKey
      ));

      const previousHoursByDay = {};
      previousRelatedBars.forEach((related) => {
        Object.entries(related.hours_by_day || {}).forEach(([day, hours]) => {
          previousHoursByDay[day] = (previousHoursByDay[day] || 0) + (Number(hours) || 0);
        });
      });

      let nextHoursByDay = {};
      if (bar && !bar._suppressedByBarEdit && Object.keys(bar.hours_by_day || {}).length > 0) {
        Object.entries(bar.hours_by_day || {}).forEach(([day, hours]) => {
          nextHoursByDay[day] = (Number(hours) || 0);
        });
      } else {
        const nextEmployeeKey = String(nextEmployee || '').trim().toLowerCase();
        allocationBars
          .filter((entry) => (
            String(entry.task_id) === String(bar.task_id)
            && String(entry.employee || '').trim().toLowerCase() === nextEmployeeKey
          ))
          .forEach((related) => {
            const final = overrides[related.id] ?? related;
            if (final?._suppressedByBarEdit) {
              return;
            }
            Object.entries(final?.hours_by_day || {}).forEach(([day, hours]) => {
              nextHoursByDay[day] = (nextHoursByDay[day] || 0) + (Number(hours) || 0);
            });
          });
      }

      return {
        bar_id: barId,
        task_id: bar.task_id,
        task_name: bar.task_name,
        project_name: bar.project_name,
        employee: nextEmployee,
        ...(previousEmployee && nextEmployee
          && String(previousEmployee).trim().toLowerCase() !== String(nextEmployee).trim().toLowerCase()
          ? { previous_employee: previousEmployee }
          : {}),
        previous_hours_by_day: Object.keys(previousHoursByDay).length
          ? previousHoursByDay
          : (originalBar?.hours_by_day ?? {}),
        hours_by_day: Object.keys(nextHoursByDay).length
          ? nextHoursByDay
          : (bar.hours_by_day ?? {}),
      };
    });

  return mergeHistogramEditsByTaskEmployee(edits);
}

async function fetchHistogram({ start, end, useAutoRange }) {
  const response = await api.get('/resource-histogram', {
    params: {
      start: useAutoRange ? undefined : start || undefined,
      end: useAutoRange ? undefined : end || undefined,
    },
  });
  const data = response.data.data;
  if (!data || typeof data !== 'object') {
    return data;
  }

  return {
    ...data,
    employees: normalizeList(data.employees),
    teams: normalizeList(data.teams),
    bars: applyProjectColorsToBars(normalizeList(data.bars), normalizeList(data.projects)),
    projects: normalizeList(data.projects),
  };
}

function applyProjectColorsToBars(bars, projects) {
  if (!Array.isArray(bars) || bars.length === 0 || !Array.isArray(projects) || projects.length === 0) {
    return bars;
  }

  const colors = new Map();
  projects.forEach((project) => {
    if (project?.id == null || !project.color) {
      return;
    }
    colors.set(String(project.id), project.color);
  });

  if (colors.size === 0) {
    return bars;
  }

  return bars.map((bar) => {
    const nextColor = colors.get(String(bar.project_id));
    if (!nextColor || nextColor === bar.color) {
      return bar;
    }
    return { ...bar, color: nextColor };
  });
}

export default function ResourceHistogram() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  // Phones: optionally hide everything above the chart (remembered per device).
  const [chartOnly, setChartOnly] = useState(() => {
    try {
      return window.localStorage.getItem(HISTOGRAM_CHART_ONLY_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleChartOnly = useCallback(() => {
    setChartOnly((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(HISTOGRAM_CHART_ONLY_KEY, next ? '1' : '0');
      } catch {
        // storage unavailable — the toggle still works for this visit
      }
      return next;
    });
  }, []);
  const isChartOnly = isMobile && chartOnly;
  const { syncPartTasksWithConflict, taskSyncConflictModal } = useTaskSyncConflictModal();
  const userDisplayName = currentUserDisplayName(user);
  const canEditBars = useMemo(() => canEditHistogramBars(user), [user]);
  const canDeleteTraining = useMemo(() => canDeleteTrainings(user), [user]);
  const canRunHistogramAlgorithm = useMemo(
    () => canPageAction(user, 'Resource Histogram', 'run_algorithm'),
    [user],
  );
  const [payload, setPayload] = useState(null);
  const [projectId, setProjectId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAvailability, setShowAvailability] = useState(false);
  const [showStartFlags, setShowStartFlags] = useState(false);
  const [showEndFlags, setShowEndFlags] = useState(false);
  const [showDaySplit, setShowDaySplit] = useState(false);
  const [histogramZoom, setHistogramZoom] = useState(1);
  const [showLegend, setShowLegend] = useState(false);
  const [showTrainings, setShowTrainings] = useState(true);
  const [hideCompletedProjects, setHideCompletedProjects] = useState(true);
  const [hideMissingAllDocs, setHideMissingAllDocs] = useState(true);
  const [selectedTaskBar, setSelectedTaskBar] = useState(null);
  const [selectedTaskAnchor, setSelectedTaskAnchor] = useState(null);
  const [editorHighlightedTaskIds, setEditorHighlightedTaskIds] = useState([]);
  const [selectedEmployeeRow, setSelectedEmployeeRow] = useState(null);
  const [selectedTraining, setSelectedTraining] = useState(null);
  const [needsAlgorithmRerun, setNeedsAlgorithmRerun] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [rangeRefreshing, setRangeRefreshing] = useState(false);
  const [barOverrides, setBarOverrides] = useState({});
  const [editHistory, setEditHistory] = useState([]);
  const [savedLogEntries, setSavedLogEntries] = useState([]);
  const [savedLogsLoading, setSavedLogsLoading] = useState(false);
  const [dlPlanLogs, setDlPlanLogs] = useState([]);
  const [dlPlanLogsLoading, setDlPlanLogsLoading] = useState(false);
  const [showDlPlanEdits, setShowDlPlanEdits] = useState(true);
  const [dlPlanUserFilter, setDlPlanUserFilter] = useState('');
  const [focusedDlPlanLogId, setFocusedDlPlanLogId] = useState(null);
  const [savingBarEdits, setSavingBarEdits] = useState(false);
  const [savePipeline, setSavePipeline] = useState(null);
  const [histogramChartKey, setHistogramChartKey] = useState(0);
  const histogramScrollLeftRef = useRef(0);

  const remountHistogramChart = useCallback(() => {
    const main = document.querySelector('.histogram-sync-scroll-main, .histogram-timeline-scroll');
    if (main) {
      histogramScrollLeftRef.current = main.scrollLeft;
    }
    setHistogramChartKey((current) => current + 1);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const next = document.querySelector('.histogram-sync-scroll-main, .histogram-timeline-scroll');
        if (next && histogramScrollLeftRef.current > 0) {
          next.scrollLeft = histogramScrollLeftRef.current;
          next.dispatchEvent(new Event('scroll'));
        }
      });
    });
  }, []);
  const [showEditLogModal, setShowEditLogModal] = useState(false);
  const [editLogInitialTab, setEditLogInitialTab] = useState(null);
  const [showRunAlgoAfterSaveModal, setShowRunAlgoAfterSaveModal] = useState(false);
  const [trainings, setTrainings] = useState([]);
  const [trainingDeletingId, setTrainingDeletingId] = useState(null);
  const [trainingDeleteConfirmTarget, setTrainingDeleteConfirmTarget] = useState(null);
  const [trainingStatusSavingId, setTrainingStatusSavingId] = useState(null);
  const [barEditPreview, setBarEditPreview] = useState(null);
  const envelopeRefetchIdRef = useRef(0);
  const viewDatesRef = useRef({ start: '', end: '' });
  const taskEditorBaselineRef = useRef(null);
  const taskEditorRef = useRef(null);
  const taskEditorOpenOverridesRef = useRef(null);
  const pendingEditorScrollTaskIdRef = useRef(null);
  const pendingEditorScrollRangeRef = useRef(null);
  const rangeRefreshingRef = useRef(false);
  const barOverridesRef = useRef(barOverrides);
  barOverridesRef.current = barOverrides;
  const editHistoryRef = useRef(editHistory);
  editHistoryRef.current = editHistory;
  const undoActionInFlightRef = useRef(false);

  viewDatesRef.current = { start: startDate, end: endDate };

  const viewRange = useMemo(() => {
    if (!startDate || !endDate) {
      return null;
    }

    return normalizeHistogramDateSelection(startDate, endDate);
  }, [startDate, endDate]);

  const dataEnvelope = useMemo(
    () => resolveHistogramDataEnvelope(payload),
    [payload],
  );

  const endDateMax = useMemo(
    () => (startDate ? histogramMaxEndFromStart(startDate) : undefined),
    [startDate],
  );

  const viewPayload = useMemo(() => {
    if (!payload || !viewRange?.start || !viewRange?.end) {
      return null;
    }

    const clippedBars = filterBarsByDateRange(
      normalizeList(payload.bars),
      viewRange.start,
      viewRange.end,
    );

    return {
      ...payload,
      bars: clippedBars,
      availability_hours: clipEmployeeDayMapToRange(
        payload.availability_hours,
        viewRange.start,
        viewRange.end,
      ),
      employee_holidays: clipEmployeeDayMapToRange(
        payload.employee_holidays,
        viewRange.start,
        viewRange.end,
      ),
    };
  }, [payload, viewRange]);

  const teams = useMemo(
    () => normalizeList(payload?.teams),
    [payload?.teams],
  );
  const employees = useMemo(
    () => normalizeList(payload?.employees),
    [payload?.employees],
  );
  const payloadProjects = useMemo(
    () => normalizeList(payload?.projects),
    [payload?.projects],
  );
  const allBars = viewPayload?.bars ?? [];

  // Full algorithm allocation — never filtered by docs visibility.
  const allocationBars = useMemo(
    () => filterLiteralHistogramBars(allBars),
    [allBars],
  );

  // Unclipped bars for save / draft application — view clipping must not
  // drop off-screen days from previous_hours_by_day (orphan assignment risk).
  const fullAllocationBars = useMemo(
    () => filterLiteralHistogramBars(payload?.bars ?? []),
    [payload?.bars],
  );

  const editedAllocationBars = useMemo(() => {
    const overridden = allocationBars.map((bar) => barOverrides[bar.id] ?? bar);

    // When one bar holds the full resized schedule for a task+employee, hide other
    // fragments of that assignment so they are not double-drawn or double-saved.
    const authoritative = new Map();
    overridden.forEach((bar) => {
      if (!barOverrides[bar.id]) {
        return;
      }
      if (bar._suppressedByBarEdit) {
        return;
      }
      const key = `${bar.task_id}::${String(bar.employee || '').trim().toLowerCase()}`;
      const existing = authoritative.get(key);
      const hours = Number(bar.hours) || 0;
      if (!existing || hours >= (Number(existing.hours) || 0)) {
        authoritative.set(key, bar);
      }
    });

    return overridden.filter((bar) => {
      if (bar._suppressedByBarEdit) {
        return false;
      }
      const key = `${bar.task_id}::${String(bar.employee || '').trim().toLowerCase()}`;
      const leader = authoritative.get(key);
      if (!leader) {
        return true;
      }
      return bar.id === leader.id;
    });
  }, [allocationBars, barOverrides]);

  const hiddenCompletedProjectIds = useMemo(
    () => buildHiddenCompletedProjectIdSet(
      payloadProjects,
      editedAllocationBars,
      hideCompletedProjects,
    ),
    [payloadProjects, editedAllocationBars, hideCompletedProjects],
  );

  const visibleProjects = useMemo(() => {
    const assignedProjectIds = new Set(
      allocationBars
        .map((bar) => String(bar.project_id))
        .filter(Boolean),
    );

    return payloadProjects
      .filter((project) => assignedProjectIds.has(String(project.id)))
      .filter((project) => {
        if (hideMissingAllDocs && !projectHasAllDocs(project)) {
          return false;
        }

        if (hiddenCompletedProjectIds?.has(String(project.id))) {
          return false;
        }

        return true;
      })
      .sort((a, b) => (b.name || '').localeCompare(a.name || ''));
  }, [payloadProjects, allocationBars, hiddenCompletedProjectIds, hideMissingAllDocs]);

  const histogramDisplayBars = useMemo(() => {
    let bars = editedAllocationBars;
    if (projectId) {
      bars = bars.filter(
        (bar) => String(bar.project_id) === String(projectId),
      );
    }

    return filterHistogramBarsForDisplay(bars, payloadProjects, {
      hideCompletedProjects,
      hideMissingAllDocs,
      completionReferenceBars: editedAllocationBars,
    });
  }, [editedAllocationBars, projectId, hideCompletedProjects, hideMissingAllDocs, payloadProjects]);

  const displayDailyHours = useMemo(
    () => buildDailyHoursFromBars(histogramDisplayBars),
    [histogramDisplayBars],
  );

  // Gap / free capacity must keep completed + no-docs hours booked even when
  // those bars are hidden from the chart.
  const gapDailyHours = useMemo(
    () => buildDailyHoursFromBars(editedAllocationBars),
    [editedAllocationBars],
  );

  const teamFilteredDisplay = useMemo(
    () => filterHistogramByTeam({
      teamId,
      employees,
      bars: histogramDisplayBars,
      dailyHours: displayDailyHours,
      availabilityHours: viewPayload?.availability_hours ?? {},
      employeeHolidays: viewPayload?.employee_holidays ?? {},
    }),
    [teamId, employees, histogramDisplayBars, displayDailyHours, viewPayload?.availability_hours, viewPayload?.employee_holidays],
  );

  const teamFilteredGapHours = useMemo(
    () => filterHistogramByTeam({
      teamId,
      employees,
      bars: editedAllocationBars,
      dailyHours: gapDailyHours,
      availabilityHours: viewPayload?.availability_hours ?? {},
      employeeHolidays: viewPayload?.employee_holidays ?? {},
    }),
    [teamId, employees, editedAllocationBars, gapDailyHours, viewPayload?.availability_hours, viewPayload?.employee_holidays],
  );

  const liveSelectedEmployeeRow = useMemo(() => {
    if (!selectedEmployeeRow) {
      return null;
    }

    const rowName = selectedEmployeeRow.name;
    const employeeId = selectedEmployeeRow.employeeId;
    const employee = employees.find((entry) => (
      (employeeId != null && String(entry.id) === String(employeeId))
      || employeeMatchesName(entry, rowName)
    ));

    const bars = editedAllocationBars.filter((bar) => (
      employee
        ? employeeMatchesName(employee, bar.employee)
        : String(bar.employee || '').trim() === String(rowName || '').trim()
    ));

    return {
      ...selectedEmployeeRow,
      bars,
    };
  }, [selectedEmployeeRow, editedAllocationBars, employees]);

  const teamFilterName = useMemo(() => {
    if (!teamId) return '';
    return teams.find((team) => String(team.id) === String(teamId))?.name ?? 'Selected team';
  }, [teamId, teams]);

  const legendItems = useMemo(
    () => buildProjectLegendItems(teamFilteredDisplay.bars, {
      hideCompletedProjects,
      hideMissingAllDocs,
      projects: payloadProjects,
      completionReferenceBars: editedAllocationBars,
    }),
    [teamFilteredDisplay.bars, hideCompletedProjects, hideMissingAllDocs, payloadProjects, editedAllocationBars],
  );

  const trainingsByEmployeeId = useMemo(() => {
    const visibleIds = new Set(
      teamFilteredDisplay.employees.map((employee) => String(employee.id)),
    );
    const map = new Map();

    trainings.forEach((training) => {
      const id = String(training.employee_id);
      if (!visibleIds.has(id)) {
        return;
      }
      if (!map.has(id)) {
        map.set(id, []);
      }
      map.get(id).push(training);
    });

    return map;
  }, [trainings, teamFilteredDisplay.employees]);

  const barFilterProjectName = useMemo(() => {
    if (!projectId) return '';
    return visibleProjects.find(
      (project) => String(project.id) === String(projectId),
    )?.name ?? 'Selected project';
  }, [projectId, visibleProjects]);

  useEffect(() => {
    if (!projectId) {
      return;
    }
    if (!visibleProjects.some((project) => String(project.id) === String(projectId))) {
      setProjectId('');
    }
  }, [projectId, visibleProjects]);

  useEffect(() => {
    if (!viewRange?.start || !viewRange?.end || !viewRangeNeedsEnvelopeRefetch(viewRange, dataEnvelope)) {
      setRangeRefreshing(false);
      return undefined;
    }

    const requestId = envelopeRefetchIdRef.current + 1;
    envelopeRefetchIdRef.current = requestId;
    const requestedRange = { start: viewRange.start, end: viewRange.end };
    setRangeRefreshing(true);

    const timer = window.setTimeout(async () => {
      try {
        const data = await fetchHistogram({
          start: requestedRange.start,
          end: requestedRange.end,
        });
        if (requestId !== envelopeRefetchIdRef.current) {
          return;
        }

        setPayload(data);
        if (data?.algorithm_cache_missing) {
          setNeedsAlgorithmRerun(true);
        }
        setError('');
      } catch (err) {
        if (requestId !== envelopeRefetchIdRef.current) {
          return;
        }
        setError(getApiErrorMessage(err, 'Unable to refresh histogram for the selected dates.'));
      } finally {
        if (requestId === envelopeRefetchIdRef.current) {
          setRangeRefreshing(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [viewRange?.start, viewRange?.end, dataEnvelope?.start, dataEnvelope?.end]);

  useEffect(() => {
    if (!viewRange?.start || !viewRange?.end) {
      setTrainings([]);
      return undefined;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await api.get('/trainings', {
          params: { start: viewRange.start, end: viewRange.end },
        });
        if (!cancelled) {
          setTrainings(normalizeTrainingRecords(
            Array.isArray(response.data?.data) ? response.data.data : [],
          ));
        }
      } catch (err) {
        if (!cancelled) {
          // Keep previous trainings on failure after a transient API error.
          toast.error(getApiErrorMessage(err, 'Unable to load trainings for this range.'));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [viewRange?.start, viewRange?.end, toast]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const data = await fetchHistogram({ useAutoRange: true });
        if (cancelled) {
          return;
        }

        const next = defaultHistogramDateRange();

        setPayload(data);
        if (data?.algorithm_cache_missing) {
          setNeedsAlgorithmRerun(true);
          toast.info('Run the algorithm from Project Data Entry to populate the histogram.');
        }
        setStartDate(next.start);
        setEndDate(next.end);
        setLoading(false);
        setError('');
      } catch (err) {
        if (!cancelled) {
          const message = getApiErrorMessage(err, 'Unable to load resource histogram.');
          setError(message);
          toast.error(message);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleBarClick = useCallback((bar, meta = {}) => {
    if (!bar) return;
    setSelectedEmployeeRow(null);
    setSelectedTraining(null);
    setBarEditPreview(null);
    setSelectedTaskBar(bar);
    setSelectedTaskAnchor(meta.anchorRect ?? null);
  }, []);

  useEffect(() => {
    if (!selectedTaskBar?.task_id) {
      taskEditorOpenOverridesRef.current = null;
      return;
    }
    taskEditorOpenOverridesRef.current = buildTaskEditorOverridesSlice(
      selectedTaskBar.task_id,
      barOverridesRef.current,
      fullAllocationBars,
    );
  }, [selectedTaskBar?.task_id, fullAllocationBars]);

  const handleEmployeeClick = useCallback((row) => {
    if (!row) return;
    setSelectedTaskBar(null);
    setSelectedTaskAnchor(null);
    setSelectedTraining(null);
    setBarEditPreview(null);
    taskEditorBaselineRef.current = null;
    setSelectedEmployeeRow(row);
  }, []);

  const handleTrainingClick = useCallback((training) => {
    if (!training) return;
    setSelectedTaskBar(null);
    setSelectedTaskAnchor(null);
    setSelectedEmployeeRow(null);
    setBarEditPreview(null);
    taskEditorBaselineRef.current = null;
    setSelectedTraining(training);
  }, []);

  const restoreOverridesSlice = useCallback((slice) => {
    setBarOverrides((current) => {
      const next = { ...current };
      Object.entries(slice || {}).forEach(([barId, previous]) => {
        if (previous == null) {
          delete next[barId];
        } else {
          next[barId] = previous;
        }
      });
      barOverridesRef.current = next;
      return next;
    });
  }, []);

  const cloneOverridesMap = useCallback((overrides) => {
    const snapshot = {};
    Object.entries(overrides || {}).forEach(([barId, bar]) => {
      snapshot[barId] = cloneOverrideBar(bar);
    });
    return snapshot;
  }, []);

  const applyOverridesSnapshot = useCallback((snapshot) => {
    const next = {};
    Object.entries(snapshot || {}).forEach(([barId, bar]) => {
      if (bar) {
        next[barId] = cloneOverrideBar(bar);
      }
    });
    barOverridesRef.current = next;
    setBarOverrides(next);
  }, []);

  const handleBarEditCommit = useCallback(({ previousBar, nextBar, pushedBars = [] }) => {
    if (!nextBar?.id || !previousBar) {
      return;
    }

    setBarEditPreview(null);

    const currentOverrides = barOverridesRef.current;
    const mergedNextBar = mergeCommittedBarSchedule(
      clearBarResizeEdgeState(nextBar),
      viewRange,
      currentOverrides,
      fullAllocationBars,
    );

    const overridePatch = {};
    ['override_1', 'override_2', 'override_3'].forEach((field) => {
      if (mergedNextBar[field] !== previousBar[field]) {
        overridePatch[field] = mergedNextBar[field];
      }
    });

    const previousOverridesSlice = {};
    const captureSlice = (barId) => {
      if (Object.prototype.hasOwnProperty.call(previousOverridesSlice, barId)) {
        return;
      }
      const current = barOverridesRef.current[barId];
      previousOverridesSlice[barId] = current ? cloneOverrideBar(current) : null;
    };

    const normalizedPushedBars = (pushedBars ?? [])
      .filter((entry) => entry?.nextBar?.id && entry?.previousBar)
      .map((entry) => ({
        previousBar: entry.previousBar,
        nextBar: mergeCommittedBarSchedule(
          clearBarResizeEdgeState(entry.nextBar),
          viewRange,
          currentOverrides,
          fullAllocationBars,
        ),
      }));

    const barsForCommit = fullAllocationBars.length > 0 ? fullAllocationBars : allocationBars;

    setBarOverrides((current) => {
      const withNext = {
        ...current,
        [mergedNextBar.id]: mergedNextBar,
      };
      captureSlice(mergedNextBar.id);

      normalizedPushedBars.forEach(({ nextBar: pushedBar }) => {
        captureSlice(pushedBar.id);
        withNext[pushedBar.id] = pushedBar;
      });

      // Hide duplicate algorithm fragments for this task on the committed assignee.
      const committedEmployeeKey = employeeNameKey(mergedNextBar.employee);
      barsForCommit.forEach((bar) => {
        if (bar.id === mergedNextBar.id) {
          return;
        }
        if (String(bar.task_id) !== String(mergedNextBar.task_id)) {
          return;
        }
        if (employeeNameKey(bar.employee) !== committedEmployeeKey) {
          return;
        }
        captureSlice(bar.id);
        withNext[bar.id] = {
          ...bar,
          hours_by_day: {},
          hours: 0,
          start: mergedNextBar.start,
          end: mergedNextBar.start,
          _suppressedByBarEdit: mergedNextBar.id,
        };
      });

      if (Object.keys(overridePatch).length > 0 && mergedNextBar.task_id != null) {
        barsForCommit.forEach((bar) => {
          if (String(bar.task_id) !== String(mergedNextBar.task_id) || bar.id === mergedNextBar.id) {
            return;
          }
          if (withNext[bar.id]?._suppressedByBarEdit) {
            return;
          }

          captureSlice(bar.id);
          const base = current[bar.id] ?? bar;
          withNext[bar.id] = {
            ...base,
            ...overridePatch,
            hours_by_day: base.hours_by_day,
            employee: base.employee,
            start: base.start,
            end: base.end,
            hours: base.hours,
          };
        });
      }

      const taskBars = barsForCommit
        .map((bar) => withNext[bar.id] ?? bar)
        .filter((bar) => (
          String(bar.task_id) === String(mergedNextBar.task_id)
          && !bar._suppressedByBarEdit
        ));
      const envelope = resolveTaskBarsDateEnvelope(taskBars);
      if (envelope.start || envelope.end) {
        taskBars.forEach((bar) => {
          captureSlice(bar.id);
          withNext[bar.id] = {
            ...(withNext[bar.id] ?? bar),
            doc_supply: envelope.start || bar.doc_supply,
            completion: envelope.end || bar.completion,
          };
        });
      }

      // Refresh date envelopes for pushed tasks as well.
      const pushedTaskIds = new Set(
        normalizedPushedBars.map(({ nextBar: pushedBar }) => String(pushedBar.task_id ?? '')),
      );
      pushedTaskIds.forEach((taskId) => {
        if (!taskId || taskId === String(mergedNextBar.task_id ?? '')) {
          return;
        }
        const related = barsForCommit
          .map((bar) => withNext[bar.id] ?? bar)
          .filter((bar) => (
            String(bar.task_id) === taskId
            && !bar._suppressedByBarEdit
          ));
        const pushedEnvelope = resolveTaskBarsDateEnvelope(related);
        if (!pushedEnvelope.start && !pushedEnvelope.end) {
          return;
        }
        related.forEach((bar) => {
          captureSlice(bar.id);
          withNext[bar.id] = {
            ...(withNext[bar.id] ?? bar),
            doc_supply: pushedEnvelope.start || bar.doc_supply,
            completion: pushedEnvelope.end || bar.completion,
          };
        });
      });

      barOverridesRef.current = withNext;
      return withNext;
    });

    setEditHistory((current) => [
      ...current,
      {
        id: `${Date.now()}-${mergedNextBar.id}`,
        source: 'unsaved',
        type: 'bar',
        previousBar,
        nextBar: mergedNextBar,
        pushedBars: normalizedPushedBars,
        overridePatch,
        previousOverridesSlice,
        overridesSnapshot: cloneOverridesMap(barOverridesRef.current),
        summary: describeBarChange(previousBar, mergedNextBar, {
          pushedCount: normalizedPushedBars.length,
        }),
        userName: userDisplayName,
        undone: false,
        canUndo: true,
        createdAt: Date.now(),
      },
    ]);

    if (Object.keys(overridePatch).length > 0) {
      setNeedsAlgorithmRerun(true);
    }
    toast.success(describeBarChange(previousBar, mergedNextBar, {
      pushedCount: normalizedPushedBars.length,
    }));
  }, [allocationBars, fullAllocationBars, cloneOverridesMap, toast, userDisplayName, viewRange]);

  const hasUnsavedBarEdits = useMemo(
    () => Object.values(barOverrides).some((bar) => bar && !bar._suppressedByBarEdit),
    [barOverrides],
  );

  const isSavePipelineRunning = Boolean(savePipeline);
  const shouldBlockLeave = hasUnsavedBarEdits || isSavePipelineRunning;

  useUnsavedChangesGuard(
    shouldBlockLeave,
    'You have unsaved histogram changes. Save before leaving this page?',
  );

  const refreshHistogramPayload = useCallback(async () => {
    // Always full-load like the initial mount so post-save refresh cannot drop
    // bars that are visible via hours_by_day but outside PDE date filters.
    const data = await fetchHistogram({ useAutoRange: true });
    setPayload(data);
    if (data?.algorithm_cache_missing) {
      setNeedsAlgorithmRerun(true);
    } else {
      setNeedsAlgorithmRerun(false);
    }
    setError('');
    return data;
  }, []);

  const persistPendingHistogramEdits = useCallback(async () => {
    taskEditorRef.current?.flushDraft?.();
    if (taskEditorRef.current?.isDirty?.()) {
      await taskEditorRef.current.savePdeNow?.();
    }

    // Prefer full (unclipped) bars so days outside the visible window are cleared.
    const uniqueEdits = buildHistogramScheduleEdits(
      barOverridesRef.current,
      fullAllocationBars.length > 0 ? fullAllocationBars : allocationBars,
    );
    if (!uniqueEdits.length) {
      return 0;
    }

    await api.post('/resource-histogram/save-bar-edits', { edits: uniqueEdits });
    barOverridesRef.current = {};
    setBarOverrides({});
    setEditHistory([]);
    return uniqueEdits.length;
  }, [allocationBars, fullAllocationBars]);

  const runAlgorithmPipeline = useCallback(async () => {
    await runAlgorithmByProject(api, (progress) => {
      const raw = Number(progress?.percent);
      const mapped = Number.isFinite(raw)
        ? Math.min(88, Math.max(18, Math.round(18 + (raw / 100) * 70)))
        : 40;
      setSavePipeline({
        stage: 'algo',
        percent: mapped,
        label: progress?.stage || 'Running algorithm…',
      });
    });

    setSavePipeline({
      stage: 'saving-results',
      percent: 92,
      label: 'Saving algorithm results…',
    });
    await saveAllAlgorithmResults(api);

    setSavePipeline({
      stage: 'reloading',
      percent: 97,
      label: 'Reloading histogram…',
    });
    setRangeRefreshing(true);
    await refreshHistogramPayload();
    remountHistogramChart();
    setNeedsAlgorithmRerun(false);
  }, [refreshHistogramPayload, remountHistogramChart]);

  const handleSaveAll = useCallback(async (runAlgorithmAfterSave = false) => {
    if (savingBarEdits || savePipeline) {
      return;
    }

    setShowRunAlgoAfterSaveModal(false);
    setSavingBarEdits(true);
    setSavePipeline({
      stage: 'saving',
      percent: 8,
      label: 'Saving schedule…',
    });

    try {
      const savedEditCount = await persistPendingHistogramEdits();

      if (!runAlgorithmAfterSave) {
        setSavePipeline({
          stage: 'reloading',
          percent: 90,
          label: 'Reloading histogram…',
        });
        setRangeRefreshing(true);
        await refreshHistogramPayload();
        remountHistogramChart();
        toast.success(
          savedEditCount > 0
            ? `Saved ${savedEditCount} schedule change${savedEditCount === 1 ? '' : 's'}.`
            : 'Nothing new to save.',
        );
        return;
      }

      setSavePipeline({
        stage: 'algo',
        percent: 18,
        label: 'Running algorithm…',
      });
      await runAlgorithmPipeline();

      toast.success(
        savedEditCount > 0
          ? `Saved ${savedEditCount} schedule change${savedEditCount === 1 ? '' : 's'}, ran algorithm, and saved results.`
          : 'Ran algorithm and saved results.',
      );
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Unable to save changes.'));
    } finally {
      setRangeRefreshing(false);
      setSavingBarEdits(false);
      setSavePipeline(null);
    }
  }, [
    persistPendingHistogramEdits,
    refreshHistogramPayload,
    remountHistogramChart,
    runAlgorithmPipeline,
    savePipeline,
    savingBarEdits,
    toast,
  ]);

  const handleRequestSaveAll = useCallback(() => {
    if (savingBarEdits || savePipeline || !hasUnsavedBarEdits) {
      return;
    }
    if (canRunHistogramAlgorithm) {
      setShowRunAlgoAfterSaveModal(true);
      return;
    }
    handleSaveAll(false);
  }, [canRunHistogramAlgorithm, handleSaveAll, hasUnsavedBarEdits, savePipeline, savingBarEdits]);

  const loadSavedLogs = useCallback(async () => {
    setSavedLogsLoading(true);
    try {
      const response = await api.get('/resource-histogram/activity-logs', {
        params: { limit: 100 },
      });
      const rows = (response.data?.data ?? [])
        .map(mapSavedLogToEntry)
        .filter(Boolean);
      setSavedLogEntries(rows);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Unable to load saved log.'));
    } finally {
      setSavedLogsLoading(false);
    }
  }, [toast]);

  const loadDlPlanLogs = useCallback(async () => {
    setDlPlanLogsLoading(true);
    try {
      const response = await api.get('/resource-histogram/activity-logs', {
        params: { section: 'dl', limit: 100 },
      });
      setDlPlanLogs(Array.isArray(response.data?.data) ? response.data.data : []);
    } catch {
      setDlPlanLogs([]);
    } finally {
      setDlPlanLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDlPlanLogs();
  }, [loadDlPlanLogs]);

  useEffect(() => {
    if (!showEditLogModal) {
      return;
    }
    loadSavedLogs();
    loadDlPlanLogs();
  }, [showEditLogModal, loadSavedLogs, loadDlPlanLogs]);

  const unifiedLogEntries = useMemo(() => {
    const unsaved = editHistory.map((entry) => ({
      ...entry,
      source: entry.source || 'unsaved',
      userName: entry.userName || userDisplayName,
      canUndo: entry.canUndo !== false,
    }));
    return [...savedLogEntries, ...unsaved];
  }, [editHistory, savedLogEntries, userDisplayName]);

  const filteredDlPlanLogs = useMemo(() => {
    if (!dlPlanUserFilter) {
      return dlPlanLogs;
    }
    return dlPlanLogs.filter((log) => String(log.user_name || '') === dlPlanUserFilter);
  }, [dlPlanLogs, dlPlanUserFilter]);

  const dlEditByTaskId = useMemo(
    () => buildDlPlanEditByTaskId(filteredDlPlanLogs),
    [filteredDlPlanLogs],
  );

  const focusedDlPlanLog = useMemo(
    () => dlPlanLogs.find((log) => String(log.id) === String(focusedDlPlanLogId)) || null,
    [dlPlanLogs, focusedDlPlanLogId],
  );

  const focusedPlanTaskIds = useMemo(
    () => (focusedDlPlanLog ? planLogTaskIds(focusedDlPlanLog) : []),
    [focusedDlPlanLog],
  );

  const dlEditedTaskIds = useMemo(
    () => (showDlPlanEdits ? [...dlEditByTaskId.keys()] : []),
    [dlEditByTaskId, showDlPlanEdits],
  );

  const handleShowPlanLogOnHistogram = useCallback((log) => {
    const taskIds = planLogTaskIds(log);
    if (taskIds.length === 0) {
      toast.info('This log has no tasks to highlight on the histogram.');
      return;
    }

    setShowEditLogModal(false);
    setSelectedTaskBar(null);
    setSelectedTaskAnchor(null);
    setSelectedEmployeeRow(null);
    setSelectedTraining(null);
    setBarEditPreview(null);
    taskEditorBaselineRef.current = null;
    setEditorHighlightedTaskIds([]);
    setFocusedDlPlanLogId(log.id);
    if (log.user_name) {
      setDlPlanUserFilter(String(log.user_name));
    }
    setShowDlPlanEdits(true);
  }, [toast]);

  const handleOpenTrainingFromLog = useCallback((log) => {
    const target = resolveTrainingLogNavigationTarget(log);
    if (target.kind === 'none') {
      toast.error('This log is not linked to a training assignment.');
      return;
    }

    const matched = target.trainingId
      ? trainings.find((row) => String(row.id) === String(target.trainingId))
      : null;

    if (!matched) {
      toast.error(target.deleted
        ? 'That training assignment was deleted.'
        : 'Could not find the related training on the histogram.');
      return;
    }

    setShowEditLogModal(false);
    setEditLogInitialTab(null);
    handleTrainingClick(matched);
    const day = String(matched.start_date || target.startDate || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      requestAnimationFrame(() => {
        scrollHistogramToDay(day);
      });
    }
  }, [handleTrainingClick, toast, trainings]);

  const handleClearPlanHighlight = useCallback(() => {
    setFocusedDlPlanLogId(null);
  }, []);

  const canUndo = useMemo(
    () => editHistory.some((entry) => !entry.undone && entry.canUndo !== false),
    [editHistory],
  );

  const unsavedActiveCount = useMemo(
    () => editHistory.filter((entry) => !entry.undone).length,
    [editHistory],
  );

  const undoUnsavedEntryById = useCallback(async (entryId) => {
    const current = editHistoryRef.current;
    const index = current.findIndex((entry) => entry.id === entryId);
    if (index < 0 || current[index].undone) {
      return false;
    }

    const target = current[index];
    if (target.overridesSnapshot) {
      applyOverridesSnapshot(target.overridesSnapshot);
    } else {
      restoreOverridesSlice(target.previousOverridesSlice);
    }

    if (target.type === 'task') {
      if (
        taskEditorRef.current
        && String(selectedTaskBar?.task_id) === String(target.taskId)
      ) {
        taskEditorRef.current.applyTask?.(target.previousTask);
      } else if (target.partId && target.previousTask) {
        try {
          const tasksRes = await api.get(`/parts/${target.partId}/tasks`);
          const rows = tasksRes.data?.data ?? [];
          const merged = rows.map((row) => (
            String(row.id) === String(target.previousTask.id)
              ? normalizeTaskForSave(target.previousTask)
              : normalizeTaskForSave(row)
          ));
          await syncPartTasksWithConflict(api, target.partId, {
            tasks: merged,
            baselineTasks: rows,
            extra: { source: 'pde' },
          });
        } catch (err) {
          if (!isTaskSyncCancelled(err)) {
            toast.error(getApiErrorMessage(err, 'Bar restored, but task fields could not be reverted.'));
          }
        }
      }
    }

    setEditHistory((history) => {
      const entryIndex = history.findIndex((entry) => entry.id === entryId);
      if (entryIndex < 0 || history[entryIndex].undone) {
        return history;
      }
      return history.map((entry, mapIndex) => (
        mapIndex >= entryIndex ? { ...entry, undone: true } : entry
      ));
    });

    toast.info(target.type === 'task' ? 'Task edit undone.' : 'Bar edit undone.');
    return true;
  }, [applyOverridesSnapshot, restoreOverridesSlice, selectedTaskBar?.task_id, syncPartTasksWithConflict, toast]);

  const handleUndoEntry = useCallback(async (entryOrId) => {
    if (undoActionInFlightRef.current) {
      return;
    }

    const entry = typeof entryOrId === 'object' && entryOrId
      ? entryOrId
      : unifiedLogEntries.find((row) => row.id === entryOrId);

    if (!entry || entry.undone) {
      return;
    }

    if (entry.source === 'saved') {
      if (editHistoryRef.current.some((row) => !row.undone)) {
        toast.error('Undo or save your unsaved changes first.');
        return;
      }

      undoActionInFlightRef.current = true;
      try {
        await api.post(`/resource-histogram/activity-logs/${entry.activityLogId}/revert`);
        barOverridesRef.current = {};
        setBarOverrides({});
        setEditHistory([]);
        setRangeRefreshing(true);
        await refreshHistogramPayload();
        remountHistogramChart();
        await loadSavedLogs();
        toast.info('Saved change undone.');
      } catch (err) {
        toast.error(getApiErrorMessage(err, 'Unable to undo saved change.'));
      } finally {
        setRangeRefreshing(false);
        undoActionInFlightRef.current = false;
      }
      return;
    }

    undoActionInFlightRef.current = true;
    try {
      await undoUnsavedEntryById(entry.id);
    } finally {
      undoActionInFlightRef.current = false;
    }
  }, [
    loadSavedLogs,
    refreshHistogramPayload,
    remountHistogramChart,
    toast,
    undoUnsavedEntryById,
    unifiedLogEntries,
  ]);

  const handleUndo = useCallback(() => {
    const latest = [...editHistory]
      .reverse()
      .find((entry) => !entry.undone && entry.canUndo !== false);
    if (!latest) {
      return;
    }
    handleUndoEntry(latest);
  }, [editHistory, handleUndoEntry]);

  const handleUndoAllSession = useCallback(async () => {
    if (undoActionInFlightRef.current) {
      return;
    }

    const firstActiveIndex = editHistoryRef.current.findIndex((entry) => !entry.undone);
    if (firstActiveIndex < 0) {
      return;
    }

    undoActionInFlightRef.current = true;
    try {
      const target = editHistoryRef.current[firstActiveIndex];
      if (target.overridesSnapshot) {
        applyOverridesSnapshot(target.overridesSnapshot);
      } else {
        restoreOverridesSlice(target.previousOverridesSlice);
      }

      // Earliest previousTask per taskId in the undone range (session start state).
      const taskRevertById = new Map();
      editHistoryRef.current.slice(firstActiveIndex).forEach((entry) => {
        if (entry.undone || entry.type !== 'task' || !entry.previousTask || !entry.partId) {
          return;
        }
        const key = String(entry.taskId);
        if (!taskRevertById.has(key)) {
          taskRevertById.set(key, entry);
        }
      });

      for (const entry of taskRevertById.values()) {
        if (
          taskEditorRef.current
          && String(selectedTaskBar?.task_id) === String(entry.taskId)
        ) {
          taskEditorRef.current.applyTask?.(entry.previousTask);
          continue;
        }
        try {
          const tasksRes = await api.get(`/parts/${entry.partId}/tasks`);
          const rows = tasksRes.data?.data ?? [];
          const merged = rows.map((row) => (
            String(row.id) === String(entry.previousTask.id)
              ? normalizeTaskForSave(entry.previousTask)
              : normalizeTaskForSave(row)
          ));
          await syncPartTasksWithConflict(api, entry.partId, {
            tasks: merged,
            baselineTasks: rows,
            extra: { source: 'pde' },
          });
        } catch (err) {
          if (!isTaskSyncCancelled(err)) {
            toast.error(getApiErrorMessage(err, 'Some task fields could not be reverted.'));
          }
        }
      }

      setEditHistory((current) => current.map((entry) => (
        entry.undone ? entry : { ...entry, undone: true }
      )));
      toast.info('All recent session edits undone.');
    } finally {
      undoActionInFlightRef.current = false;
    }
  }, [
    applyOverridesSnapshot,
    restoreOverridesSlice,
    selectedTaskBar?.task_id,
    syncPartTasksWithConflict,
    toast,
  ]);

  useEffect(() => {
    if (!selectedTaskBar?.id || !barOverrides[selectedTaskBar.id]) {
      return;
    }
    setSelectedTaskBar(barOverrides[selectedTaskBar.id]);
  }, [barOverrides, selectedTaskBar?.id]);

  const selectedTaskLiveBar = useMemo(() => {
    if (!selectedTaskBar) {
      return null;
    }
    // Keep the originally selected bar as the panel anchor; sibling previews
    // are merged into relatedBars instead of replacing this bar.
    if (barEditPreview && barEditPreview.id === selectedTaskBar.id) {
      return barEditPreview;
    }
    return editedAllocationBars.find((bar) => bar.id === selectedTaskBar.id)
      || editedAllocationBars.find((bar) => (
        String(bar.task_id) === String(selectedTaskBar.task_id)
        && String(bar.employee || '').trim().toLowerCase()
          === String(selectedTaskBar.employee || '').trim().toLowerCase()
      ))
      || selectedTaskBar;
  }, [barEditPreview, editedAllocationBars, selectedTaskBar]);

  const selectedTaskRelatedBars = useMemo(() => {
    const taskId = String(
      selectedTaskLiveBar?.task_id
      ?? selectedTaskBar?.task_id
      ?? '',
    );
    if (!taskId) {
      return selectedTaskLiveBar ? [selectedTaskLiveBar] : [];
    }

    const byId = new Map();
    editedAllocationBars.forEach((entry) => {
      if (String(entry.task_id) !== taskId || entry._suppressedByBarEdit) {
        return;
      }
      byId.set(entry.id, entry);
    });

    // Live drag/resize of ANY bar for this task (not only the selected one).
    if (
      barEditPreview
      && String(barEditPreview.task_id) === taskId
      && !barEditPreview._suppressedByBarEdit
    ) {
      byId.set(barEditPreview.id, barEditPreview);
    }

    if (selectedTaskLiveBar && String(selectedTaskLiveBar.task_id) === taskId) {
      byId.set(selectedTaskLiveBar.id, selectedTaskLiveBar);
    }

    return [...byId.values()];
  }, [barEditPreview, editedAllocationBars, selectedTaskBar, selectedTaskLiveBar]);

  useEffect(() => {
    const finishedRefresh = rangeRefreshingRef.current && !rangeRefreshing;
    rangeRefreshingRef.current = rangeRefreshing;

    if (!finishedRefresh || !selectedTaskBar?.task_id) {
      return;
    }

    const taskId = String(selectedTaskBar.task_id);
    const employeeKey = String(selectedTaskBar.employee || '').trim().toLowerCase();
    const match = allocationBars.find((bar) => (
      String(bar.task_id) === taskId
      && String(bar.employee || '').trim().toLowerCase() === employeeKey
    )) || allocationBars.find((bar) => String(bar.task_id) === taskId);

    if (match) {
      setSelectedTaskBar(match);
    }

    setEditorHighlightedTaskIds((current) => (
      current.length === 1 && current[0] === taskId ? current : [taskId]
    ));
  }, [allocationBars, rangeRefreshing, selectedTaskBar?.employee, selectedTaskBar?.task_id]);

  const handleFilterProjectFromPanel = useCallback((nextProjectId) => {
    setProjectId(nextProjectId);
    setSelectedTaskBar(null);
    setSelectedTaskAnchor(null);
    setSelectedEmployeeRow(null);
    setBarEditPreview(null);
    taskEditorBaselineRef.current = null;
  }, []);

  const applyTaskProgressLocally = useCallback((taskId, patch) => {
    const matchesTask = (bar) => String(bar?.task_id ?? bar?.id) === String(taskId);

    setPayload((current) => {
      if (!current?.bars) {
        return current;
      }
      return {
        ...current,
        bars: current.bars.map((bar) => (
          matchesTask(bar) ? { ...bar, ...patch } : bar
        )),
      };
    });

    setBarOverrides((current) => {
      const entries = Object.entries(current);
      if (entries.length === 0) {
        return current;
      }
      let changed = false;
      const next = { ...current };
      entries.forEach(([id, bar]) => {
        if (bar && matchesTask(bar)) {
          next[id] = { ...bar, ...patch };
          changed = true;
        }
      });
      if (changed) {
        barOverridesRef.current = next;
      }
      return changed ? next : current;
    });

    setSelectedEmployeeRow((current) => {
      if (!current?.bars) {
        return current;
      }
      return {
        ...current,
        bars: current.bars.map((bar) => (
          matchesTask(bar) ? { ...bar, ...patch } : bar
        )),
      };
    });

    setSelectedTaskBar((current) => (
      current && matchesTask(current) ? { ...current, ...patch } : current
    ));
  }, []);

  const handleTaskProgressChange = useCallback(async (task, patch) => {
    const taskId = task?.task_id ?? task?.id;
    let partId = task?.part_id;
    if (!partId && taskId) {
      const barsForLookup = fullAllocationBars.length > 0 ? fullAllocationBars : allocationBars;
      partId = barsForLookup.find((bar) => String(bar.task_id) === String(taskId))?.part_id;
    }
    if (!taskId || !partId) {
      toast.error('Unable to update task — missing part or task id.');
      throw new Error('Missing part or task id');
    }

    const synced = syncTaskDoneAndProgress({
      ...task,
      progress_per: patch.progress_per ?? task.progress_per ?? task.progress ?? '',
      done: Object.prototype.hasOwnProperty.call(patch, 'done') ? Boolean(patch.done) : Boolean(task.done),
    }, Object.prototype.hasOwnProperty.call(patch, 'done')
      ? { preferDone: Boolean(patch.done) }
      : {});

    const nextPatch = {
      progress_per: String(synced.progress_per),
      done: Boolean(synced.done),
      progress_left_hours: synced.progress_left_hours,
    };
    const progressNumeric = Number(String(nextPatch.progress_per).replace(/%$/, ''));
    nextPatch.progress = Number.isFinite(progressNumeric)
      ? Math.max(0, Math.min(100, progressNumeric))
      : 0;

    const derivedLeft = recalculateProgressLeft({
      plan: task.plan ?? task.progress_plan,
      progress_per: nextPatch.progress_per,
      progress_left_hours: patch.progress_left_hours ?? nextPatch.progress_left_hours,
    });
    if (derivedLeft.progress_left_hours != null && derivedLeft.progress_left_hours !== '') {
      nextPatch.progress_left_hours = String(derivedLeft.progress_left_hours);
    } else if (patch.progress_left_hours != null && patch.progress_left_hours !== '') {
      nextPatch.progress_left_hours = String(patch.progress_left_hours);
    }

    const previousPatch = {
      progress_per: task.progress_per ?? task.progress ?? '',
      progress_left_hours: task.progress_left_hours ?? '',
      progress: task.progress,
      done: Boolean(task.done),
    };

    applyTaskProgressLocally(taskId, nextPatch);

    try {
      const tasksRes = await api.get(`/parts/${partId}/tasks`);
      const rows = tasksRes.data?.data ?? [];
      const merged = rows.map((row) => {
        if (String(row.id) !== String(taskId)) {
          return normalizeTaskForSave({ ...row, done: Boolean(row.done) });
        }

        const withProgress = {
          ...row,
          progress_per: nextPatch.progress_per,
          done: nextPatch.done,
        };
        const derived = recalculateProgressLeft(withProgress);

        return normalizeTaskForSave({
          ...withProgress,
          ...derived,
          progress_left_hours: nextPatch.progress_left_hours ?? derived.progress_left_hours,
          progress_updated: toStorageDate(new Date()),
        });
      });
      const syncResponse = await syncPartTasksWithConflict(api, partId, {
        tasks: merged,
        baselineTasks: rows,
        extra: { source: 'pde' },
      });
      showTaskSyncNotifications(toast, syncResponse.data?.notifications);
    } catch (err) {
      applyTaskProgressLocally(taskId, previousPatch);
      if (isTaskSyncCancelled(err)) {
        return;
      }
      toast.error(getApiErrorMessage(err, 'Unable to update task progress.'));
      throw err;
    }
  }, [allocationBars, fullAllocationBars, applyTaskProgressLocally, syncPartTasksWithConflict, toast]);

  const handleTrainingStatusChange = useCallback(async (training, nextStatus) => {
    if (!training?.id || !nextStatus) {
      return;
    }

    const trainingId = training.id;
    const previousStatus = training.status;

    const applyLocal = (list) => list.map((entry) => (
      String(entry.id) === String(trainingId)
        ? { ...entry, status: nextStatus }
        : entry
    ));

    setTrainings((current) => applyLocal(current));
    setSelectedTraining((current) => (
      current && String(current.id) === String(trainingId)
        ? { ...current, status: nextStatus }
        : current
    ));

    try {
      setTrainingStatusSavingId(trainingId);
      // Status only: re-sending the cached schedule would overwrite a day
      // section / date saved elsewhere since this page loaded.
      const response = await api.put(`/trainings/${trainingId}`, { status: nextStatus });
      showSaveNotifications(response.data?.notifications);
      const saved = normalizeTrainingRecord(response.data?.data);
      if (saved) {
        setTrainings((current) => current.map((entry) => (
          String(entry.id) === String(trainingId) ? { ...entry, ...saved } : entry
        )));
        setSelectedTraining((current) => (
          current && String(current.id) === String(trainingId)
            ? { ...current, ...saved }
            : current
        ));
      }
    } catch (err) {
      setTrainings((current) => current.map((entry) => (
        String(entry.id) === String(trainingId)
          ? { ...entry, status: previousStatus }
          : entry
      )));
      setSelectedTraining((current) => (
        current && String(current.id) === String(trainingId)
          ? { ...current, status: previousStatus }
          : current
      ));
      toast.error(err?.code === 'TRAINING_VALIDATION'
        ? err.message
        : getApiErrorMessage(err, 'Unable to update training progress.'));
      throw err;
    } finally {
      setTrainingStatusSavingId(null);
    }
  }, [toast]);

  const requestRemoveTrainingAssignment = useCallback((training) => {
    const target = resolveTrainingAssignmentDeleteTarget(training);
    if (!target) {
      return;
    }
    setTrainingDeleteConfirmTarget(target);
  }, []);

  const requestDeleteTrainingSession = useCallback((assignmentsOrTraining) => {
    const target = resolveTrainingSessionDeleteTarget(assignmentsOrTraining);
    if (target) {
      setTrainingDeleteConfirmTarget(target);
    }
  }, []);

  const handleCloseTrainingDeleteConfirm = useCallback(() => {
    if (trainingDeletingId != null) {
      return;
    }
    setTrainingDeleteConfirmTarget(null);
  }, [trainingDeletingId]);

  const trainingDeleteConfirmCopy = useMemo(
    () => buildTrainingDeleteModalCopy(trainingDeleteConfirmTarget),
    [trainingDeleteConfirmTarget],
  );

  const handleConfirmTrainingDelete = useCallback(async () => {
    if (!trainingDeleteConfirmTarget) {
      return;
    }

    if (trainingDeleteConfirmTarget.kind === 'assignment') {
      const { training } = trainingDeleteConfirmTarget;
      setTrainingDeletingId(training.id);
      try {
        await api.delete(`/trainings/${training.id}`);
        setTrainings((current) => current.filter((entry) => String(entry.id) !== String(training.id)));
        setSelectedTraining((current) => (
          current && String(current.id) === String(training.id) ? null : current
        ));
        toast.success('Assignment removed.');
        setTrainingDeleteConfirmTarget(null);
      } catch (err) {
        toast.error(getApiErrorMessage(err, 'Failed to remove assignment.'));
      } finally {
        setTrainingDeletingId(null);
      }
      return;
    }

    if (trainingDeleteConfirmTarget.kind === 'session') {
      const { deletable, count, courseId } = trainingDeleteConfirmTarget;
      setTrainingDeletingId('session');
      try {
        if (courseId) {
          await api.delete(`/training-courses/${courseId}`);
        } else {
          await Promise.all(deletable.map((row) => api.delete(`/trainings/${row.id}`)));
        }
        const ids = new Set(deletable.map((row) => String(row.id)));
        setTrainings((current) => current.filter((entry) => !ids.has(String(entry.id))));
        setSelectedTraining((current) => (
          current && ids.has(String(current.id)) ? null : current
        ));
        toast.success(
          courseId
            ? 'Course and assignments deleted.'
            : (count === 1 ? 'Training deleted.' : 'Training deleted for all assignees.'),
        );
        setTrainingDeleteConfirmTarget(null);
      } catch (err) {
        toast.error(getApiErrorMessage(err, 'Failed to delete training.'));
      } finally {
        setTrainingDeletingId(null);
      }
    }
  }, [toast, trainingDeleteConfirmTarget]);

  const handleRemoveTrainingAssignment = requestRemoveTrainingAssignment;

  const handleDeleteTrainingSession = requestDeleteTrainingSession;

  const handleOpenTrainingFromSummary = useCallback((training) => {
    if (!training) {
      return;
    }

    const employeeId = training.employee_id
      ?? training.employee?.id
      ?? selectedEmployeeRow?.employeeId;
    if (!employeeId || training.id == null || training.id === '') {
      toast.error('Unable to open this training — missing operative or training id.');
      return;
    }

    const destination = trainingOpenDestination(user);
    if (destination === 'roster') {
      navigate(`/trainings?${new URLSearchParams(trainingRosterParams(training)).toString()}`);
    } else if (destination === 'dl') {
      navigate(dlTrainingUrl(training, employeeId));
    }
  }, [navigate, selectedEmployeeRow?.employeeId, toast, user]);

  const handleProjectChange = useCallback((value) => {
    setProjectId(value);
  }, []);

  const applyViewDates = useCallback((nextStart, nextEnd, changed) => {
    const next = normalizeHistogramDateSelection(nextStart, nextEnd, changed);
    setStartDate(next.start);
    setEndDate(next.end);
  }, []);

  const handleResetFilters = useCallback(() => {
    setProjectId('');
    setTeamId('');
    setSelectedTaskBar(null);
    setSelectedTaskAnchor(null);

    const next = defaultHistogramDateRange();
    applyViewDates(next.start, next.end, 'end');
    setError('');
  }, [applyViewDates]);

  const handleCloseDetailPanel = useCallback(() => {
    setSelectedTaskBar(null);
    setSelectedTaskAnchor(null);
    setSelectedEmployeeRow(null);
    setSelectedTraining(null);
    setBarEditPreview(null);
    setEditorHighlightedTaskIds([]);
    taskEditorBaselineRef.current = null;
    taskEditorOpenOverridesRef.current = null;
  }, []);

  const handleTaskEditorDismiss = useCallback(() => {
    const openSnapshot = taskEditorOpenOverridesRef.current;
    if (openSnapshot) {
      restoreOverridesSlice(openSnapshot);
    }
    handleCloseDetailPanel();
  }, [handleCloseDetailPanel, restoreOverridesSlice]);

  const handleTaskEditorSelectionChange = useCallback((taskIds) => {
    const next = Array.isArray(taskIds) ? taskIds.map(String) : [];
    setEditorHighlightedTaskIds((current) => (
      current.length === next.length && current.every((id, index) => id === next[index])
        ? current
        : next
    ));
  }, []);

  const revealEditorTaskInHistogram = useCallback((taskId) => {
    if (!taskId) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollHistogramToTask(taskId, {
          behavior: 'smooth',
          center: true,
          bars: teamFilteredDisplay.bars,
        });
        window.setTimeout(() => {
          taskEditorRef.current?.revealTask?.(taskId);
        }, 450);
      });
    });
  }, [teamFilteredDisplay.bars]);

  useEffect(() => {
    if (editorHighlightedTaskIds.length === 0) {
      pendingEditorScrollTaskIdRef.current = null;
      pendingEditorScrollRangeRef.current = null;
      return;
    }

    const taskId = String(editorHighlightedTaskIds[editorHighlightedTaskIds.length - 1]);
    // Scroll the existing window to the task. Do not move the date filter:
    // bars are clipped to that filter, so widening it redraws them.
    pendingEditorScrollRangeRef.current = null;
    revealEditorTaskInHistogram(taskId);
  }, [
    editorHighlightedTaskIds,
    revealEditorTaskInHistogram,
  ]);

  useEffect(() => {
    if (editorHighlightedTaskIds.length > 0 || focusedPlanTaskIds.length === 0) {
      return;
    }

    const taskId = String(focusedPlanTaskIds[0]);
    const currentRange = viewDatesRef.current;
    if (!currentRange.start || !currentRange.end) {
      return;
    }

    const taskBars = teamFilteredDisplay.bars.filter(
      (bar) => String(bar.task_id ?? bar.id) === taskId,
    );
    const envelope = resolveTaskBarsDateEnvelope(taskBars);
    const expanded = expandViewRangeToInclude(
      { start: currentRange.start, end: currentRange.end },
      envelope,
    );

    if (expanded.changed) {
      pendingEditorScrollTaskIdRef.current = taskId;
      pendingEditorScrollRangeRef.current = {
        start: expanded.start,
        end: expanded.end,
      };
      applyViewDates(expanded.start, expanded.end, 'end');
      return;
    }

    pendingEditorScrollRangeRef.current = null;
    revealEditorTaskInHistogram(taskId);
  }, [
    focusedPlanTaskIds,
    editorHighlightedTaskIds,
    teamFilteredDisplay.bars,
    applyViewDates,
    revealEditorTaskInHistogram,
  ]);

  useEffect(() => {
    const pendingTaskId = pendingEditorScrollTaskIdRef.current;
    const pendingRange = pendingEditorScrollRangeRef.current;
    if (!pendingTaskId || !pendingRange || rangeRefreshing) {
      return;
    }

    if (viewRange?.start !== pendingRange.start || viewRange?.end !== pendingRange.end) {
      return;
    }

    pendingEditorScrollTaskIdRef.current = null;
    pendingEditorScrollRangeRef.current = null;
    revealEditorTaskInHistogram(pendingTaskId);
  }, [
    rangeRefreshing,
    viewRange?.start,
    viewRange?.end,
    revealEditorTaskInHistogram,
  ]);

  const handleTaskEditorDraftChange = useCallback((draft, baseline, meta = {}) => {
    if (!draft?.id) {
      taskEditorBaselineRef.current = null;
      return;
    }

    // Open / histogram→editor: advance baseline only (bars already match).
    if (meta.initialize || meta.fromBar) {
      taskEditorBaselineRef.current = draft;
      return;
    }

    const applyBaseline = baseline || taskEditorBaselineRef.current || draft;
    const overrideChanged = taskDraftOverrideChanged(draft, applyBaseline);
    const previousOverridesSlice = {};
    const nextOverridesSlice = {};
    const currentOverrides = barOverridesRef.current;
    // Use full (unclipped) bars so date shifts affect hours outside the view window.
    const draftBars = fullAllocationBars.length > 0 ? fullAllocationBars : allocationBars;
    const mergedBars = draftBars.map((bar) => {
      const existing = currentOverrides[bar.id];
      if (overrideChanged && existing?._suppressedByBarEdit) {
        return bar;
      }
      return existing ?? bar;
    });

    draftBars.forEach((bar) => {
      if (String(bar.task_id) !== String(draft.id)) {
        return;
      }
      previousOverridesSlice[bar.id] = currentOverrides[bar.id]
        ? { ...currentOverrides[bar.id] }
        : null;
    });

    const taskBarsForLayout = mergedBars.filter((bar) => (
      String(bar.task_id) === String(draft.id)
      && !bar._suppressedByBarEdit
    ));
    const layoutEmployee = taskBarsForLayout[0]?.employee || draft.algorithm_1 || '';
    const layoutContext = {
      rowName: layoutEmployee,
      availabilityHours: payload?.availability_hours ?? {},
      employeeHolidays: payload?.employee_holidays ?? {},
      employees,
    };
    const dayCapacityHours = resolveTypicalDayCapacityForEmployee(
      layoutEmployee,
      layoutContext.availabilityHours,
      layoutContext.employeeHolidays,
      employees,
    );

    const nextBars = applyTaskDraftToTaskBars(mergedBars, draft, applyBaseline, {
      resetSuppressed: overrideChanged,
      layoutContext,
      dayCapacityHours,
    });
    const nextOverrides = { ...currentOverrides };

    nextBars.forEach((bar) => {
      if (String(bar.task_id) !== String(draft.id)) {
        return;
      }
      const base = mergedBars.find((entry) => entry.id === bar.id);
      if (base?._suppressedByBarEdit && bar._suppressedByBarEdit) {
        return;
      }
      nextOverrides[bar.id] = bar;
      nextOverridesSlice[bar.id] = { ...bar };
    });

    if (taskDraftAffectsHistogram(draft, applyBaseline)) {
      setNeedsAlgorithmRerun(true);
    }

    barOverridesRef.current = nextOverrides;
    setBarOverrides(nextOverrides);
    if (String(draft.id) === String(selectedTaskBar?.task_id)) {
      taskEditorBaselineRef.current = draft;
    }

    const previousTask = meta.previousTask ? { ...meta.previousTask } : null;
    if (previousTask) {
      setEditHistory((current) => {
        const last = current[current.length - 1];
        const coalesce = last
          && !last.undone
          && last.type === 'task'
          && String(last.taskId) === String(draft.id)
          && (Date.now() - last.createdAt) < 2500;

        if (coalesce) {
          return [
            ...current.slice(0, -1),
            {
              ...last,
              nextTask: { ...draft },
              nextOverridesSlice,
              createdAt: Date.now(),
            },
          ];
        }

        return [
          ...current,
          {
            id: `${Date.now()}-task-${draft.id}`,
            source: 'unsaved',
            type: 'task',
            taskId: draft.id,
            partId: draft.part_id ?? selectedTaskBar?.part_id ?? null,
            previousTask,
            nextTask: { ...draft },
            previousOverridesSlice,
            nextOverridesSlice,
            overridesSnapshot: cloneOverridesMap(currentOverrides),
            summary: `Task editor: ${draft.task_name || draft.id}`,
            userName: userDisplayName,
            undone: false,
            canUndo: true,
            createdAt: Date.now(),
          },
        ];
      });
    }
  }, [allocationBars, employees, fullAllocationBars, cloneOverridesMap, payload, selectedTaskBar?.part_id, userDisplayName]);

  const handleTaskEditorPdeAutoSaved = useCallback((savedTask) => {
    if (savedTask?.id) {
      taskEditorBaselineRef.current = savedTask;
      taskEditorOpenOverridesRef.current = buildTaskEditorOverridesSlice(
        savedTask.id,
        barOverridesRef.current,
        fullAllocationBars,
      );
    }
    if (savedTask?.done) {
      refreshHistogramPayload();
    }
  }, [fullAllocationBars, refreshHistogramPayload]);

  const handleBarEditPreview = useCallback((previewBar) => {
    if (!previewBar) {
      setBarEditPreview(null);
      return;
    }

    const taskId = String(previewBar.task_id ?? '');
    const siblings = editedAllocationBars.filter((entry) => (
      String(entry.task_id) === taskId
      && !entry._suppressedByBarEdit
      && entry.id !== previewBar.id
    ));
    const envelope = resolveTaskBarsDateEnvelope([previewBar, ...siblings]);
    setBarEditPreview({
      ...previewBar,
      doc_supply: envelope.start || previewBar.doc_supply,
      completion: envelope.end || previewBar.completion,
    });
  }, [editedAllocationBars]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = String(event.key || '').toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) {
        const tag = String(event.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) {
          return;
        }
        if (!canUndo) {
          return;
        }
        event.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canUndo, handleUndo]);

  const handleStartDateChange = useCallback((value) => {
    const { end } = viewDatesRef.current;
    applyViewDates(value, end, 'start');
  }, [applyViewDates]);

  const handleEndDateChange = useCallback((value) => {
    const { start } = viewDatesRef.current;
    applyViewDates(start, value, 'end');
  }, [applyViewDates]);

  const handleGoToToday = useCallback(() => {
    const next = defaultHistogramDateRange();
    applyViewDates(next.start, next.end, 'end');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollHistogramToDay(toStorageDate(new Date()));
      });
    });
  }, [applyViewDates]);

  const isInitialLoad = loading && !payload;

  if (isInitialLoad) {
    return <HistogramPageSkeleton />;
  }

  const saveUndoButtons = (
    <>
      <button
        type="button"
        className={`histogram-toolbar-btn${hasUnsavedBarEdits || isSavePipelineRunning ? ' histogram-toolbar-btn-primary' : ''}`}
        onClick={handleRequestSaveAll}
        disabled={!canEditBars || !hasUnsavedBarEdits || isSavePipelineRunning}
        title="Save histogram changes. You will be asked whether to run the algorithm."
      >
        {isSavePipelineRunning
          ? (
            savePipeline.stage === 'saving' ? 'Saving…'
              : savePipeline.stage === 'algo' ? 'Running algo…'
                : savePipeline.stage === 'saving-results' ? 'Saving results…'
                  : 'Reloading…'
          )
          : 'Save'}
      </button>
      <button
        type="button"
        className="histogram-toolbar-btn"
        onClick={handleUndo}
        disabled={!canEditBars || !canUndo || isSavePipelineRunning}
        title="Undo the last bar or task-editor change (Ctrl+Z)."
      >
        Undo
      </button>
    </>
  );

  return (
    <section className={`resource-histogram-page${isChartOnly ? ' is-chart-only' : ''}`}>
      {savePipeline ? (
        <div
          className="histogram-save-pipeline-chip"
          role="status"
          aria-live="polite"
          title={savePipeline.label}
        >
          <span className="histogram-save-pipeline-chip-spinner" aria-hidden="true" />
          <span className="histogram-save-pipeline-chip-copy">
            <strong>
              {savePipeline.stage === 'saving' && 'Saving'}
              {savePipeline.stage === 'algo' && 'Algorithm'}
              {savePipeline.stage === 'saving-results' && 'Saving results'}
              {savePipeline.stage === 'reloading' && 'Reloading'}
            </strong>
            <small>{savePipeline.label}</small>
          </span>
          <span className="histogram-save-pipeline-chip-percent">
            {Math.round(savePipeline.percent)}%
          </span>
        </div>
      ) : null}

      <PageHeader
        compact
        title="Resource Histogram"
        actions={(
          <div className="histogram-header-log-actions">
            {/* Phones: Save / Undo sit next to the edit log instead of in the toolbar. */}
            {isMobile ? saveUndoButtons : null}
            {isMobile ? (
              <button
                type="button"
                className={`histogram-toolbar-btn histogram-chart-only-toggle${isChartOnly ? ' is-active' : ''}`}
                aria-pressed={isChartOnly}
                onClick={toggleChartOnly}
                title={isChartOnly ? 'Show the filters and legend again' : 'Hide the filters and legend to give the chart the full screen'}
              >
                {isChartOnly ? 'Show filters' : 'Chart only'}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={() => {
                setEditLogInitialTab(null);
                setShowEditLogModal(true);
              }}
              title="View project, DL plan, and training edit history"
            >
              Edits Log History
              {unsavedActiveCount > 0 ? (
                <span className="histogram-edit-log-count">
                  {unsavedActiveCount}
                </span>
              ) : null}
            </button>
          </div>
        )}
      />

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {!canEditBars ? (
        <div className="alert alert-info histogram-readonly-banner" role="note">
          Histogram task bars are view-only for your role. Ask an administrator for edit access on Resource Histogram.
        </div>
      ) : null}

      {needsAlgorithmRerun && (
        <div className="alert alert-warning histogram-algorithm-rerun-banner" role="alert">
          <span>
            {payload?.algorithm_cache_missing ? (
              <>
                No algorithm assignments are loaded on this histogram yet. Run the algorithm from Project Data Entry to populate per-day operative schedules.
              </>
            ) : (
              <>
                Histogram schedule changes are not saved yet. Use <strong>Save</strong> before running the algorithm so your bar edits are kept.
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setNeedsAlgorithmRerun(false)}
            disabled={isSavePipelineRunning}
          >
            Dismiss
          </button>
        </div>
      )}

      {projectId && (
        <div className="alert alert-info histogram-bar-filter-banner">
          <span>
            Showing tasks for <strong>{barFilterProjectName}</strong> only.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setProjectId('')}>
            Clear
          </button>
        </div>
      )}

      {teamId && (
        <div className="alert alert-info histogram-bar-filter-banner">
          <span>
            Showing employees from <strong>{teamFilterName}</strong> only.
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTeamId('')}>
            Clear
          </button>
        </div>
      )}

      {focusedDlPlanLog ? (
        <div className="alert alert-info histogram-bar-filter-banner histogram-dl-plan-banner">
          <span>
            Highlighting tasks edited by <strong>{focusedDlPlanLog.user_name || 'a DL'}</strong>
            {focusedDlPlanLog.created_at ? (
              <>
                {' '}on {new Date(focusedDlPlanLog.created_at).toLocaleString(undefined, {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </>
            ) : null}
            {focusedDlPlanLog.summary ? (
              <>
                {': '}
                {focusedDlPlanLog.summary}
              </>
            ) : null}
            .
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleClearPlanHighlight}>
            Clear highlight
          </button>
        </div>
      ) : null}

      <div className="card histogram-toolbar-card">
        <div className="histogram-toolbar-row">
          <div className="histogram-toolbar-filters">
          <label className="histogram-toolbar-field">
            <span>Team</span>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">All teams</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <label className="histogram-toolbar-field">
            <span>Project</span>
            <select value={projectId} onChange={(e) => handleProjectChange(e.target.value)}>
              <option value="">All projects</option>
              {visibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {formatProjectDropdownLabel(project)}
                </option>
              ))}
            </select>
          </label>
          <label className="histogram-toolbar-field histogram-toolbar-field-date">
            <span>Start</span>
            <DisplayDateInput
              value={startDate}
              compact={isMobile}
              onChange={handleStartDateChange}
              max={endDate || endDateMax}
              className="histogram-date-input"
            />
          </label>
          <label className="histogram-toolbar-field histogram-toolbar-field-date">
            <span>End</span>
            <DisplayDateInput
              value={endDate}
              compact={isMobile}
              onChange={handleEndDateChange}
              min={startDate || undefined}
              max={endDateMax}
              className="histogram-date-input"
            />
          </label>
          <div className="histogram-toolbar-filter-actions">
            <button
              type="button"
              className="histogram-toolbar-btn"
              onClick={handleGoToToday}
              title="Reset the date range to 1 week ago through 7 weeks ahead."
            >
              Today
            </button>
            <button
              type="button"
              className="histogram-toolbar-btn"
              onClick={handleResetFilters}
              title="Clear team and project filters and restore the default date range."
            >
              Reset
            </button>
          </div>
          </div>

          <div className="histogram-toolbar-actions">
        <div
          className="histogram-zoom-controls"
          role="group"
          aria-label="Histogram grid zoom"
        >
          <svg
            className="histogram-zoom-icon"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16 L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <button
            type="button"
            className="histogram-zoom-step-btn"
            onClick={() => setHistogramZoom((current) => stepHistogramZoomOut(current))}
            disabled={isHistogramZoomAtMin(histogramZoom)}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="histogram-zoom-label" aria-live="polite">
            {histogramZoomLabel(histogramZoom)}
          </span>
          <button
            type="button"
            className="histogram-zoom-step-btn"
            onClick={() => setHistogramZoom((current) => stepHistogramZoomIn(current))}
            disabled={isHistogramZoomAtMax(histogramZoom)}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
        {isMobile ? null : saveUndoButtons}
        <button
          type="button"
          className={`histogram-toolbar-btn${showTrainings ? ' is-active' : ''}`}
          aria-pressed={showTrainings}
          onClick={() => setShowTrainings((value) => !value)}
          title="Show scheduled training bars on operative rows (black with yellow border)."
        >
          Trainings
        </button>
        <HistogramViewOptionsDropdown
          showStartFlags={showStartFlags}
          onShowStartFlagsChange={setShowStartFlags}
          showEndFlags={showEndFlags}
          onShowEndFlagsChange={setShowEndFlags}
          showDaySplit={showDaySplit}
          onShowDaySplitChange={setShowDaySplit}
          showAvailability={showAvailability}
          onShowAvailabilityChange={setShowAvailability}
          hideMissingAllDocs={hideMissingAllDocs}
          onHideMissingAllDocsChange={setHideMissingAllDocs}
          hideCompletedProjects={hideCompletedProjects}
          onHideCompletedProjectsChange={setHideCompletedProjects}
          showLegend={showLegend}
          onShowLegendChange={setShowLegend}
          showDlPlanEdits={showDlPlanEdits}
          onShowDlPlanEditsChange={setShowDlPlanEdits}
        />
        </div>
        </div>

        {showLegend ? <ProjectHistogramLegend items={legendItems} embedded /> : null}
        <HistogramReadingGuide variant="page" className="histogram-page-reading-guide" />
      </div>

      <div
        className={`resource-histogram-chart-wrap${rangeRefreshing || isSavePipelineRunning ? ' is-refreshing' : ''}`}
        style={{ '--histogram-grid-zoom': histogramZoom }}
      >
        {payload && viewRange ? (
          <ResourceHistogramView
            key={histogramChartKey}
            range={viewRange}
            employees={teamFilteredDisplay.employees}
            bars={teamFilteredDisplay.bars}
            dailyHours={teamFilteredDisplay.dailyHours}
            bookedDailyHours={teamFilteredGapHours.dailyHours}
            availabilityHours={teamFilteredDisplay.availabilityHours}
            employeeHolidays={teamFilteredDisplay.employeeHolidays}
            showDaySplit={showDaySplit}
            showAvailability={showAvailability}
            showStartFlags={showStartFlags}
            showEndFlags={showEndFlags}
            hideCompletedProjects={hideCompletedProjects}
            hiddenCompletedProjectIds={hiddenCompletedProjectIds}
            projects={payloadProjects}
            projectFilterId={projectId || null}
            teamFilterId={teamId}
            onBarClick={handleBarClick}
            onEmployeeClick={handleEmployeeClick}
            onTrainingClick={handleTrainingClick}
            barEditsEnabled={canEditBars && !isSavePipelineRunning}
            onBarEditCommit={handleBarEditCommit}
            onBarEditPreview={handleBarEditPreview}
            highlightedTaskIds={editorHighlightedTaskIds}
            focusedPlanTaskIds={focusedPlanTaskIds}
            dlEditedTaskIds={dlEditedTaskIds}
            dlEditByTaskId={dlEditByTaskId}
            showTrainings={showTrainings}
            trainingsByEmployeeId={trainingsByEmployeeId}
            freeCheckBars={teamFilteredGapHours.bars}
          />
        ) : null}
        {liveSelectedEmployeeRow ? (
          <HistogramEmployeeDetailPanel
            row={liveSelectedEmployeeRow}
            range={viewRange}
            dailyHours={teamFilteredDisplay.dailyHours}
            gapDailyHours={teamFilteredGapHours.dailyHours}
            availabilityHours={teamFilteredDisplay.availabilityHours}
            employeeHolidays={teamFilteredDisplay.employeeHolidays}
            employees={teamFilteredDisplay.employees}
            rowTrainings={trainingsByEmployeeId.get(String(liveSelectedEmployeeRow.employeeId)) ?? []}
            onClose={handleCloseDetailPanel}
            onFilterProject={handleFilterProjectFromPanel}
            onSelectTask={handleBarClick}
            onTrainingStatusChange={handleTrainingStatusChange}
            onRemoveTraining={canDeleteTraining ? handleRemoveTrainingAssignment : undefined}
            removingTrainingId={trainingDeletingId}
            onTaskProgressChange={handleTaskProgressChange}
            onOpenTraining={trainingOpenDestination(user) ? handleOpenTrainingFromSummary : undefined}
            openTrainingTitle={trainingOpenTitle(user)}
          />
        ) : null}
        {selectedTraining ? (
          <HistogramTrainingDetailPanel
            training={selectedTraining}
            assignees={[selectedTraining]}
            onClose={handleCloseDetailPanel}
            onRemoveAssignment={canDeleteTraining ? handleRemoveTrainingAssignment : undefined}
            onDeleteTraining={canDeleteTraining
              ? () => handleRemoveTrainingAssignment(selectedTraining)
              : undefined}
            onUpdateStatus={handleTrainingStatusChange}
            deletingId={trainingDeletingId}
            statusSavingId={trainingStatusSavingId}
          />
        ) : null}
        {selectedTaskLiveBar ? (
          <HistogramTaskEditorPanel
            ref={taskEditorRef}
            key={selectedTaskLiveBar.task_id ?? selectedTaskLiveBar.id}
            bar={selectedTaskLiveBar}
            taskBars={selectedTaskRelatedBars}
            anchorRect={selectedTaskAnchor}
            employees={teamFilteredDisplay.employees}
            isBarEditPreview={Boolean(barEditPreview)}
            onClose={handleTaskEditorDismiss}
            onFilterProject={handleFilterProjectFromPanel}
            onDraftChange={handleTaskEditorDraftChange}
            onPdeAutoSaved={handleTaskEditorPdeAutoSaved}
            onSelectionChange={handleTaskEditorSelectionChange}
            readOnly={!canEditBars}
          />
        ) : null}
        <HistogramMiniLegend items={legendItems} />
        <HistogramChartRefreshOverlay active={rangeRefreshing} />
      </div>

      <HistogramEditLogModal
        open={showEditLogModal}
        onClose={() => {
          setShowEditLogModal(false);
          setEditLogInitialTab(null);
        }}
        entries={unifiedLogEntries}
        onUndoEntry={canEditBars ? handleUndoEntry : undefined}
        onUndoAllSession={canEditBars ? handleUndoAllSession : undefined}
        sessionUndoCount={unsavedActiveCount}
        busy={isSavePipelineRunning}
        loading={savedLogsLoading}
        planLogs={dlPlanLogs}
        planLogsLoading={dlPlanLogsLoading}
        planUserFilter={dlPlanUserFilter}
        onPlanUserFilterChange={setDlPlanUserFilter}
        focusedPlanLogId={focusedDlPlanLogId}
        onShowPlanLog={handleShowPlanLogOnHistogram}
        onTrainingLogClick={handleOpenTrainingFromLog}
        initialTab={editLogInitialTab}
      />
      <RunAlgorithmAfterSaveModal
        open={showRunAlgoAfterSaveModal}
        onClose={() => setShowRunAlgoAfterSaveModal(false)}
        onSaveOnly={() => handleSaveAll(false)}
        onSaveAndRun={() => handleSaveAll(true)}
        busy={isSavePipelineRunning}
        contextLabel="histogram changes"
      />
      <DeleteConfirmModal
        open={Boolean(trainingDeleteConfirmTarget && trainingDeleteConfirmCopy)}
        title={trainingDeleteConfirmCopy?.title ?? 'Confirm deletion'}
        message={trainingDeleteConfirmCopy?.message ?? ''}
        details={trainingDeleteConfirmCopy?.details ?? []}
        warning={trainingDeleteConfirmCopy?.warning}
        confirmLabel={trainingDeleteConfirmCopy?.confirmLabel ?? 'Delete'}
        onClose={handleCloseTrainingDeleteConfirm}
        onConfirm={handleConfirmTrainingDelete}
        busy={trainingDeletingId != null}
      />
      {taskSyncConflictModal}
    </section>
  );
}
