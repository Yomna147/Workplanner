import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/client';
import { applyPdeTaskFieldChange, recalculatePdeDerivedFields } from '../../utils/taskCalculations';
import ActivityLogModal from '../../components/ActivityLogModal';
import AlgorithmAssignmentReviewModal from '../../components/AlgorithmAssignmentReviewModal';
import AlgorithmRunningOverlay from '../../components/AlgorithmRunningOverlay';
import AlgorithmSkippedTasksModal from '../../components/AlgorithmSkippedTasksModal';
import CreateNewProjectModal from '../../components/CreateNewProjectModal';
import DuplicatePartModal from '../../components/DuplicatePartModal';
import DuplicateProjectModal from '../../components/DuplicateProjectModal';
import DeleteConfirmModal from '../../components/DeleteConfirmModal';
import { ProjectsPageSkeleton, TaskGridSkeleton } from '../../components/PageSkeleton';
import PageHeader from '../../components/PageHeader';
import ProjectPriorityWarningModal from '../../components/ProjectPriorityWarningModal';
import ProjectColorSelect from '../../components/ProjectColorSelect';
import ProjectTaskGrid from '../../components/ProjectTaskGrid';
import { emptyTask } from '../../constants/projectTaskFields';
import ProjectFieldSourceLegend from '../../components/ProjectFieldSourceLegend';
import PdeAlgorithmLegend from '../../components/PdeAlgorithmLegend';
import HistogramMiniLegend from '../../components/gantt/HistogramMiniLegend';
import {
  buildProjectLegendItemsFromProjects,
  mergeProjectLegendWithTasks,
} from '../../components/gantt/ganttUtils';
import UpdateHoursModal from '../../components/UpdateHoursModal';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { canPageAction } from '../../utils/userPermissions';
import {
  mergeAlgorithmResults,
  saveAllAlgorithmResults,
  taskHasPlanHours,
} from '../../utils/algorithm';
import { initialAlgorithmProgress } from '../../utils/algorithmProgress';
import {
  runAlgorithmByProject,
  algorithmRunSleep,
  SHOW_ALGORITHM_SKIPPED_MODAL,
} from '../../utils/algorithmRun';
import { displayProjectColor } from '../../utils/projectColor';
import { formatProjectDropdownLabel, resolvePdeProjectContext, sortProjectsForPde } from '../../utils/projectSort';
import { analyzeActiveProjectPpDuplicates } from '../../utils/projectPriorityWarnings';
import { getAssignedPp } from '../../utils/projectPpRebalance';
import { toStorageDate } from '../../utils/dateFormat';
import { isDlMirrorLocked, applyDlMirrorValuesToPde } from '../../utils/dlMirrorFields';
import { isAlgorithmAssignmentReviewUser } from '../../utils/algorithmReviewAccess';
import { buildTaskNameOptions, getRapForTaskName } from '../../utils/nrmTasks';
import { applyDoneCheckboxChange } from '../../utils/pdeDoneEffects';
import { readTtHoursCache } from '../../utils/ttHoursCache';
import {
  applyTtHoursToPdeTasks,
  buildTtHoursProgressIndex,
} from '../../utils/ttHoursProgressLookup';
import { useDebouncedProjectColorUpdate } from '../../hooks/useDebouncedProjectColorUpdate';
import { useTaskSyncConflictModal } from '../../hooks/useTaskSyncConflictModal';
import {
  cloneTaskSyncSnapshot,
  isTaskSyncCancelled,
  taskSyncSuccessMessage,
} from '../../utils/taskSync';
import { showTaskSyncNotifications } from '../../utils/taskSyncNotifications';
import {
  normalizeDocSupplyDates,
  validatePdeTasksForAlgorithm,
} from '../../utils/pdeAlgorithmValidation';

const copyOptions = [
  { value: '', label: 'Duplicate...' },
  { value: 'without_data', label: 'Without Data' },
  { value: 'with_all_data', label: 'With All Data' },
  { value: 'with_allocation', label: 'With Operative Selection Only (assignees)' },
  { value: 'duplicate_part', label: 'Duplicate Part' },
];

export default function Projects() {
  const toast = useToast();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const { syncPartTasksWithConflict, taskSyncConflictModal } = useTaskSyncConflictModal();
  const canEditProjects = canPageAction(user, 'Project Data Entry', 'edit');
  const canRunAlgorithm = canPageAction(user, 'Project Data Entry', 'run_algorithm');
  const canDeleteProjects = canPageAction(user, 'Project Data Entry', 'delete');
  const canViewEditsLog = canPageAction(user, 'Project Data Entry', 'view_edits_log');
  const canReviewAlgorithmAssignments = isAlgorithmAssignmentReviewUser(user);
  const ownerName = user?.name ?? '';
  const [projects, setProjects] = useState([]);
  const [teams, setTeams] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [parts, setParts] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedPartId, setSelectedPartId] = useState('');
  const [tasks, setTasks] = useState([]);
  const tasksRef = useRef(tasks);
  const tasksBaselineRef = useRef([]);
  const algorithmSavePendingRef = useRef(false);
  const openTasksInPartAtLoadRef = useRef(0);
  const tasksLoadingRef = useRef(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [partsLoading, setPartsLoading] = useState(false);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [savingTasks, setSavingTasks] = useState(false);
  const [runningAlgorithm, setRunningAlgorithm] = useState(false);
  const [algorithmProgress, setAlgorithmProgress] = useState(initialAlgorithmProgress);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [salesToolProposalId, setSalesToolProposalId] = useState(null);
  const [salesToolPrefill, setSalesToolPrefill] = useState(null);
  const [salesToolSummary, setSalesToolSummary] = useState(null);
  const [ttCreateSummary, setTtCreateSummary] = useState(null);
  const [showProjectCopyModal, setShowProjectCopyModal] = useState(false);
  const [showPartCopyModal, setShowPartCopyModal] = useState(false);
  const [showUpdateHoursModal, setShowUpdateHoursModal] = useState(false);
  const [showActivityLogModal, setShowActivityLogModal] = useState(false);
  const [showAlgorithmReviewModal, setShowAlgorithmReviewModal] = useState(false);
  const [showAlgorithmSkippedModal, setShowAlgorithmSkippedModal] = useState(false);
  const [algorithmSkippedTasks, setAlgorithmSkippedTasks] = useState([]);
  const [invalidFields, setInvalidFields] = useState({});
  const [ppWarning, setPpWarning] = useState({
    open: false,
    warnings: [],
    pending: null,
  });
  const [copyType, setCopyType] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingPart, setDeletingPart] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [savingHaveAllDocs, setSavingHaveAllDocs] = useState(false);
  const [selectedTaskRows, setSelectedTaskRows] = useState([]);
  const [nrms, setNrms] = useState([]);
  const [ttHoursIndex, setTtHoursIndex] = useState(() => new Map());
  const [ttHoursCacheReady, setTtHoursCacheReady] = useState(false);
  const [comparingTtHours, setComparingTtHours] = useState(false);

  const selectedProject = projects.find(
    (project) => String(project.id) === String(selectedProjectId),
  );

  const selectedPart = parts.find((part) => String(part.id) === String(selectedPartId));

  const selectedProjectContext = useMemo(
    () => resolvePdeProjectContext(selectedProject, {
      tasks,
      openTasksInPartAtLoad: openTasksInPartAtLoadRef.current,
    }),
    [selectedProject, tasks],
  );

  const selectedProjectTtHours = useMemo(() => {
    if (!selectedProjectId || !ttHoursCacheReady) {
      return null;
    }

    const entry = ttHoursIndex.get(String(selectedProjectId));
    const hours = Number(entry?.summary?.totalTtHours) || 0;
    const hasTt = hours > 0 || (entry?.ttMap?.size ?? 0) > 0;

    return { hasTt, hours };
  }, [selectedProjectId, ttHoursCacheReady, ttHoursIndex]);

  const legendItems = useMemo(() => {
    const items = buildProjectLegendItemsFromProjects(projects);

    if (!selectedProject || selectedProjectContext.isDone) {
      return items;
    }

    return mergeProjectLegendWithTasks(items, selectedProjectId, tasks);
  }, [projects, selectedProject, selectedProjectId, selectedProjectContext.isDone, tasks]);

  const taskNameOptions = useMemo(() => buildTaskNameOptions(nrms), [nrms]);

  const prepareLoadedTasks = useCallback(
    (taskList) => (taskList ?? []).map((task) =>
      recalculatePdeDerivedFields(applyDlMirrorValuesToPde(task), { nrms }),
    ),
    [nrms],
  );

  const loadProjects = async () => {
    setLoading(true);
    try {
      const [projectsRes, teamsRes, employeesRes] = await Promise.all([
        api.get('/projects', { params: { all: true } }),
        api.get('/teams'),
        api.get('/employees'),
      ]);
      setProjects(sortProjectsForPde(projectsRes.data.data));
      setTeams(teamsRes.data.data);
      setEmployees(employeesRes.data.data);
      setError('');
    } catch {
      setError('Unable to load projects.');
    } finally {
      setLoading(false);
    }
  };

  const refreshProjectSummaries = async () => {
    try {
      const response = await api.get('/projects', { params: { all: true } });
      setProjects(sortProjectsForPde(response.data.data));
    } catch {
      // Keep existing list if refresh fails after save.
    }
  };

  const rebalanceProjectPp = useCallback(async ({
    projectId = selectedProjectId,
    requestedPp = null,
    normalizeOnly = false,
  } = {}) => {
    const response = await api.post('/projects/rebalance-pp', {
      project_id: projectId ? Number(projectId) : null,
      requested_pp: requestedPp === '' || requestedPp == null ? null : String(requestedPp),
      normalize_only: normalizeOnly,
    });

    return response.data.data ?? [];
  }, [selectedProjectId]);

  const rememberTaskBaseline = useCallback((taskList) => {
    tasksBaselineRef.current = cloneTaskSyncSnapshot(taskList ?? []);
  }, []);

  const reloadCurrentPartTasks = useCallback(async () => {
    if (!selectedPartId) {
      return;
    }

    const response = await api.get(`/parts/${selectedPartId}/tasks`);
    const nextTasks = prepareLoadedTasks(response.data.data);
    tasksRef.current = nextTasks;
    rememberTaskBaseline(nextTasks);
    setTasks(nextTasks);
  }, [prepareLoadedTasks, rememberTaskBaseline, selectedPartId]);

  const loadParts = async (projectId, preferredPartId = '') => {
    if (!projectId) {
      setParts([]);
      setSelectedPartId('');
      setTasks([]);
      return;
    }

    setPartsLoading(true);
    try {
      const response = await api.get(`/projects/${projectId}/parts`);
      const nextParts = response.data.data;
      setParts(nextParts);
      setError('');

      if (nextParts.length === 0) {
        setSelectedPartId('');
        setTasks([]);
        return;
      }

      const stillValid = preferredPartId
        && nextParts.some((part) => String(part.id) === String(preferredPartId));

      if (stillValid) {
        setSelectedPartId(String(preferredPartId));
        return;
      }

      if (nextParts.length === 1) {
        setSelectedPartId(String(nextParts[0].id));
        return;
      }

      setSelectedPartId('');
      setTasks([]);
    } catch {
      setError('Unable to load parts.');
      setParts([]);
      setSelectedPartId('');
    } finally {
      setPartsLoading(false);
    }
  };

  const loadTasks = async (partId) => {
    if (!partId) {
      setTasks([]);
      rememberTaskBaseline([]);
      return;
    }

    setTasksLoading(true);
    try {
      const response = await api.get(`/parts/${partId}/tasks`);
      const nextTasks = prepareLoadedTasks(response.data.data);
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      rememberTaskBaseline(nextTasks);
      setError('');
    } catch {
      setError('Unable to load project tasks.');
    } finally {
      setTasksLoading(false);
    }
  };

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    const justFinishedLoading = tasksLoadingRef.current && !tasksLoading;
    tasksLoadingRef.current = tasksLoading;

    if (justFinishedLoading && selectedPartId) {
      openTasksInPartAtLoadRef.current = tasks.filter((task) => !task.done).length;
    }
  }, [tasksLoading, selectedPartId, tasks]);

  useEffect(() => {
    if (!selectedPartId) {
      openTasksInPartAtLoadRef.current = 0;
    }
  }, [selectedPartId]);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const cached = await readTtHoursCache();
      if (cancelled) {
        return;
      }
      setTtHoursIndex(buildTtHoursProgressIndex(cached?.summaries ?? []));
      setTtHoursCacheReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (!projects.some((project) => String(project.id) === String(selectedProjectId))) {
      setSelectedProjectId('');
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    setSelectedPartId('');
    setTasks([]);
    loadParts(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    setSelectedTaskRows([]);
    loadTasks(selectedPartId);
  }, [selectedPartId]);

  useEffect(() => {
    if (!selectedPartId) {
      setNrms([]);
      return undefined;
    }

    let cancelled = false;

    const loadNrms = async () => {
      try {
        const response = await api.get('/nrms');
        if (!cancelled) {
          setNrms(response.data.data ?? []);
        }
      } catch {
        if (!cancelled) {
          setNrms([]);
        }
      }
    };

    loadNrms();

    return () => {
      cancelled = true;
    };
  }, [selectedPartId]);

  const handleCreateProjectSuccess = async (result) => {
    await loadProjects();
    if (result.project?.id) {
      setSelectedProjectId(String(result.project.id));
      await loadParts(result.project.id, result.part?.id);
    }
    toast.success('Project and tasks created.');
    setError('');
  };

  const handleDeletePart = () => {
    if (!selectedPartId) {
      return;
    }
    setDeleteTarget('part');
  };

  const confirmDeletePart = async () => {
    if (!selectedPartId) {
      return;
    }

    setDeletingPart(true);
    try {
      await api.delete(`/parts/${selectedPartId}`);
      toast.success('Part deleted.');
      setDeleteTarget(null);
      await loadParts(selectedProjectId);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to delete part.');
    } finally {
      setDeletingPart(false);
    }
  };

  const handleDeleteProject = () => {
    if (!selectedProjectId) {
      return;
    }
    setDeleteTarget('project');
  };

  const confirmDeleteProject = async () => {
    if (!selectedProjectId) {
      return;
    }

    setDeletingProject(true);
    try {
      await api.delete(`/projects/${selectedProjectId}`);
      setSelectedProjectId('');
      setSelectedPartId('');
      setTasks([]);
      setParts([]);
      setSelectedTaskRows([]);
      setDeleteTarget(null);
      await loadProjects();
      toast.success('Project deleted.');
      setError('');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to delete project.');
      setError(message);
      toast.error(message);
    } finally {
      setDeletingProject(false);
    }
  };

  const clearSalesToolProposalQuery = useCallback(() => {
    if (!searchParams.get('salesToolProposal')) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('salesToolProposal');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const clearNewProjectQuery = useCallback(() => {
    const keys = ['newProject', 'name', 'doc_supply', 'completion', 'sheet_url', 'sheet_name', 'description'];
    if (!keys.some((key) => searchParams.get(key))) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    keys.forEach((key) => next.delete(key));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const openCreateModal = () => {
    setSalesToolProposalId(null);
    setSalesToolPrefill(null);
    setSalesToolSummary(null);
    setTtCreateSummary(null);
    clearSalesToolProposalQuery();
    clearNewProjectQuery();
    setShowCreateModal(true);
  };

  const closeCreateModal = () => {
    setShowCreateModal(false);
    setSalesToolProposalId(null);
    setSalesToolPrefill(null);
    setSalesToolSummary(null);
    setTtCreateSummary(null);
    clearSalesToolProposalQuery();
    clearNewProjectQuery();
  };

  // Deep-link from TT OS notification: /projects?newProject=1&name=...
  useEffect(() => {
    const wantsNew = String(searchParams.get('newProject') || '').trim();
    if (!wantsNew || wantsNew === '0' || wantsNew.toLowerCase() === 'false') {
      return;
    }
    if (!canEditProjects) {
      clearNewProjectQuery();
      return;
    }
    if (searchParams.get('salesToolProposal')) {
      return;
    }

    const prefillName = String(searchParams.get('name') || '').trim();
    const docSupply = String(searchParams.get('doc_supply') || '').trim();
    const completion = String(searchParams.get('completion') || '').trim();
    const sheetUrl = String(searchParams.get('sheet_url') || '').trim();
    const sheetName = String(searchParams.get('sheet_name') || '').trim();
    const description = String(searchParams.get('description') || '').trim();
    const prefill = {};
    if (prefillName) prefill.name = prefillName;
    if (docSupply) prefill.doc_supply = docSupply.slice(0, 10);
    if (completion) prefill.completion = completion.slice(0, 10);
    if (sheetUrl) prefill.sheet_url = sheetUrl;
    if (sheetName) prefill.sheet_name = sheetName;
    if (description) prefill.description = description;
    setSalesToolProposalId(null);
    setSalesToolSummary(null);
    setSalesToolPrefill(Object.keys(prefill).length ? prefill : null);
    setTtCreateSummary(
      prefillName
        ? (sheetUrl ? `New project from Outlook / Drive: ${prefillName}` : prefillName)
        : 'New project from Time Tracking',
    );
    setShowCreateModal(true);
    clearNewProjectQuery();
  }, [canEditProjects, clearNewProjectQuery, searchParams]);

  useEffect(() => {
    const proposalId = String(searchParams.get('salesToolProposal') || '').trim();
    if (!proposalId || !canEditProjects) {
      return undefined;
    }

    let cancelled = false;
    api
      .get(`/sales-tool/proposals/${proposalId}`)
      .then((response) => {
        if (cancelled) {
          return;
        }
        const row = response.data?.data;
        if (!row || row.status !== 'pending') {
          toast.error('That Sales Tool proposal is no longer pending.');
          clearSalesToolProposalQuery();
          return;
        }
        setSalesToolProposalId(row.id);
        setSalesToolPrefill(row.prefill || null);
        setTtCreateSummary(null);
        setSalesToolSummary(
          [
            row.project_name,
            row.client ? `Client: ${row.client}` : '',
            row.agreed_cost ? `Agreed: ${row.agreed_cost}` : '',
            row.quoted_hours ? `Quoted hours: ${row.quoted_hours}` : '',
            row.owner ? `Owner: ${row.owner}` : '',
            row.st_status ? `ST status: ${row.st_status}` : '',
            row.has_quotation || (row.quotation_count ?? 0) > 0
              ? `${row.quotation_count || row.quotations?.length || 1} quotation file(s) matched`
              : 'No quotation file matched yet',
          ].filter(Boolean).join(' · '),
        );
        setShowCreateModal(true);
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(getApiErrorMessage(err, 'Unable to load Sales Tool proposal.'));
          clearSalesToolProposalQuery();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [searchParams, canEditProjects, toast, clearSalesToolProposalQuery]);

  const handleCopyTypeChange = (value) => {
    setCopyType(value);
    if (!value) {
      return;
    }

    if (!selectedProjectId) {
      setError('Select a project before duplicating.');
      setCopyType('');
      return;
    }

    if (value === 'duplicate_part') {
      if (!selectedPartId) {
        setError('Select a part before duplicating.');
        setCopyType('');
        return;
      }
      setShowPartCopyModal(true);
      return;
    }

    setShowProjectCopyModal(true);
  };

  const handleCopySuccess = async (result) => {
    setCopyType('');
    await loadProjects();
    if (result.project?.id) {
      setSelectedProjectId(String(result.project.id));
      await loadParts(result.project.id, result.part?.id);
    } else if (selectedProjectId) {
      await loadParts(selectedProjectId, result.part?.id);
    }
    toast.success(result.message || 'Copy completed.');
    setError('');
  };

  const closeProjectCopyModal = () => {
    setShowProjectCopyModal(false);
    setCopyType('');
  };

  const closePartCopyModal = () => {
    setShowPartCopyModal(false);
    setCopyType('');
  };

  const applyOwnerToTask = useCallback(
    (task, skipOwnerUpdate = false) => {
      if (skipOwnerUpdate || !ownerName || isDlMirrorLocked(task, 'owner')) {
        return task;
      }

      const existingOwner = String(task?.owner ?? '').trim();
      if (existingOwner !== '') {
        return task;
      }

      return { ...task, owner: ownerName };
    },
    [ownerName],
  );

  const applyTaskChange = useCallback((rowIndex, key, value, rowIndices, options = {}) => {
    const applyPpToAll = key === 'pp';
    const editedIndices = rowIndices?.length
      ? new Set(rowIndices)
      : new Set([rowIndex]);

    setInvalidFields((current) => {
      if (!current || Object.keys(current).length === 0) {
        return current;
      }

      const next = { ...current };
      editedIndices.forEach((index) => {
        if (!next[index]) {
          return;
        }
        const rowFlags = { ...next[index], [key]: false };
        if (Object.values(rowFlags).every((flag) => !flag)) {
          delete next[index];
        } else {
          next[index] = rowFlags;
        }
      });
      return next;
    });

    setTasks((current) => {
      const indices = applyPpToAll
        ? new Set(current.map((_, index) => index))
        : editedIndices;

      const nextTasks = current.map((task, index) => {
        if (!indices.has(index)) {
          return task;
        }

        if (key === 'done') {
          return applyDoneCheckboxChange(task, Boolean(value), { user, employees });
        }

        let result = applyPdeTaskFieldChange(task, key, value, {
          getRapForTaskName,
          nrms,
        });

        result =
          key === 'owner' || options.skipOwnerUpdate
            ? result
            : applyOwnerToTask(result, options.skipOwnerUpdate);

        if (key !== 'progress_updated' && editedIndices.has(index)) {
          result = { ...result, progress_updated: toStorageDate(new Date()) };
        }

        return result;
      });

      // Keep ref in sync immediately so Save never sends a stale row (e.g. missing override).
      tasksRef.current = nextTasks;
      return nextTasks;
    });
  }, [applyOwnerToTask, employees, nrms, user]);

  const handleTaskChange = useCallback(async (rowIndex, key, value, rowIndices, options = {}) => {
    if (key === 'pp' && selectedProjectId) {
      try {
        const assignments = await rebalanceProjectPp({
          projectId: selectedProjectId,
          requestedPp: value,
        });
        const assignedPp = getAssignedPp(assignments, selectedProjectId) || value;
        await refreshProjectSummaries();
        await reloadCurrentPartTasks();
        if (assignedPp !== '' && String(assignedPp) !== String(value)) {
          toast.info(`Project priorities rearranged to even numbers. This project is PP ${assignedPp}.`);
        }
      } catch (err) {
        toast.error(getApiErrorMessage(err, 'Unable to rebalance project priority.'));
      }
      return;
    }

    applyTaskChange(rowIndex, key, value, rowIndices, options);
  }, [
    applyTaskChange,
    rebalanceProjectPp,
    reloadCurrentPartTasks,
    selectedProjectId,
    toast,
  ]);

  const handleCancelPpWarning = useCallback(() => {
    setPpWarning({ open: false, warnings: [], pending: null });
  }, []);

  const handleToggleAllDone = useCallback((checked) => {
    setTasks((current) =>
      current.map((task) => applyDoneCheckboxChange(task, checked, { user, employees })),
    );
  }, [employees, user]);

  const doneSelectionState = useMemo(() => {
    if (tasks.length === 0) {
      return { allDoneChecked: false, someDoneChecked: false };
    }

    const doneCount = tasks.filter((task) => task.done).length;
    return {
      allDoneChecked: doneCount === tasks.length,
      someDoneChecked: doneCount > 0,
    };
  }, [tasks]);

  const handleAddRow = useCallback(() => {
    setTasks((current) => [...current, applyOwnerToTask(emptyTask())]);
  }, [applyOwnerToTask]);

  const updateSelectedTaskRows = useCallback((updater) => {
    setSelectedTaskRows((current) => (typeof updater === 'function' ? updater(current) : updater));
  }, []);

  const cloneTaskRow = useCallback((task) => {
    const { id, ...rest } = task;
    return { ...emptyTask(), ...rest };
  }, []);

  const handleDuplicateSelectedTasks = useCallback(() => {
    if (selectedTaskRows.length === 0) {
      toast.info('Select one or more tasks to duplicate.');
      return;
    }

    const copies = [...selectedTaskRows]
      .sort((a, b) => a - b)
      .map((rowIndex) => applyOwnerToTask(cloneTaskRow(tasks[rowIndex])))
      .filter(Boolean);

    if (copies.length === 0) {
      return;
    }

    setTasks((current) => [...current, ...copies]);
    setSelectedTaskRows([]);
    toast.success(
      `Duplicated ${copies.length} task${copies.length === 1 ? '' : 's'}. Click Save tasks to persist.`,
    );
  }, [applyOwnerToTask, cloneTaskRow, selectedTaskRows, tasks, toast]);

  const handleDeleteSelectedTasks = useCallback(() => {
    if (selectedTaskRows.length === 0) {
      toast.info('Select one or more tasks to delete.');
      return;
    }

    const count = selectedTaskRows.length;
    const message = `Delete ${count} selected task${count === 1 ? '' : 's'}?`;
    if (!window.confirm(message)) {
      return;
    }

    const deleteSet = new Set(selectedTaskRows);
    setTasks((current) => current.filter((_, index) => !deleteSet.has(index)));
    setSelectedTaskRows([]);
    toast.success(
      `Removed ${count} task${count === 1 ? '' : 's'}. Click Save tasks to persist.`,
    );
  }, [selectedTaskRows, toast]);

  const saveTasksNow = async (options = {}) => {
    if (!selectedPartId) {
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });

    setSavingTasks(true);
    try {
      const savingAlgorithm = Boolean(options.algorithmRun) || algorithmSavePendingRef.current;

      if (savingAlgorithm) {
        await saveAllAlgorithmResults(api);
        algorithmSavePendingRef.current = false;
      }

      const response = await syncPartTasksWithConflict(api, selectedPartId, {
        tasks: tasksRef.current,
        baselineTasks: tasksBaselineRef.current,
        extra: {
          algorithm_run: savingAlgorithm,
          source: 'pde',
        },
      });
      const nextTasks = prepareLoadedTasks(response.data.data);
      setTasks(nextTasks);
      rememberTaskBaseline(nextTasks);
      toast.success(
        taskSyncSuccessMessage(
          response,
          savingAlgorithm
            ? 'Algorithm results saved for all projects.'
            : 'Tasks saved.',
        ),
      );
      showTaskSyncNotifications(toast, response.data.notifications);
      setError('');
      await refreshProjectSummaries();
    } catch (err) {
      if (isTaskSyncCancelled(err)) {
        return;
      }
      const message = getApiErrorMessage(err, 'Unable to save tasks.');
      toast.error(message);
      setError(message);
    } finally {
      setSavingTasks(false);
    }
  };

  const handleSaveTasks = async (options = {}) => {
    if (!selectedPartId) {
      return;
    }

    const warnings = analyzeActiveProjectPpDuplicates(projects, {
      currentProjectId: selectedProjectId,
      currentTasks: tasksRef.current,
      openTasksInPartAtLoad: openTasksInPartAtLoadRef.current,
    });

    if (warnings.length > 0) {
      try {
        await rebalanceProjectPp({ normalizeOnly: true });
        await refreshProjectSummaries();
        await reloadCurrentPartTasks();
      } catch (err) {
        toast.error(getApiErrorMessage(err, 'Unable to rearrange project priorities.'));
        return;
      }
    }

    await saveTasksNow(options);
  };

  const handleConfirmPpWarning = useCallback(() => {
    const pending = ppWarning.pending;
    if (!pending) {
      setPpWarning({ open: false, warnings: [], pending: null });
      return;
    }

    if (pending.action === 'save') {
      setPpWarning({ open: false, warnings: [], pending: null });
      saveTasksNow(pending.saveOptions ?? {});
      return;
    }

    setPpWarning({ open: false, warnings: [], pending: null });
  }, [ppWarning.pending, saveTasksNow]);

  const handleRunAlgorithm = async () => {
    if (!selectedPartId) {
      return;
    }

    if (selectedProjectContext.isDone) {
      toast.info('This project is completed. Reopen tasks before running the algorithm.');
      return;
    }

    const activeTasks = tasks.filter((task) => !task.done);
    if (activeTasks.length === 0) {
      toast.info('No active tasks to run the algorithm on.');
      return;
    }

    const { invalidRows, invalidFields: nextInvalidFields } = validatePdeTasksForAlgorithm(tasks);
    if (invalidRows.length > 0) {
      setInvalidFields(nextInvalidFields);
      toast.error(
        `Fix required fields before running the algorithm (${invalidRows.length} task${invalidRows.length === 1 ? '' : 's'}).`,
      );
      return;
    }

    setInvalidFields({});

    const allActiveFieldsEmpty = activeTasks.every((task) => (
      [task.pri, task.est, task.plan, task.doc_supply, task.completion].every(
        (value) => value === null || value === undefined || String(value).trim() === '',
      )
    ));
    if (allActiveFieldsEmpty) {
      toast.info('No task data to run the algorithm on.');
      return;
    }

    const normalizedTasks = prepareLoadedTasks(normalizeDocSupplyDates(tasksRef.current));
    tasksRef.current = normalizedTasks;
    setTasks(normalizedTasks);

    setRunningAlgorithm(true);
    setAlgorithmProgress({ percent: 8, stage: 'Rebalancing project priorities…', processedProjects: 0, totalProjects: 0 });
    try {
      await rebalanceProjectPp({ normalizeOnly: true });
      await refreshProjectSummaries();
      await reloadCurrentPartTasks();

      setAlgorithmProgress({ percent: 18, stage: 'Saving tasks…', processedProjects: 0, totalProjects: 0 });
      const syncResponse = await syncPartTasksWithConflict(api, selectedPartId, {
        tasks: tasksRef.current,
        baselineTasks: tasksBaselineRef.current,
        extra: {
          algorithm_run: false,
          source: 'pde',
        },
      });
      const syncedTasks = prepareLoadedTasks(syncResponse.data.data ?? tasksRef.current);
      tasksRef.current = syncedTasks;
      rememberTaskBaseline(syncedTasks);
      setTasks(syncedTasks);

      setAlgorithmProgress({ percent: 28, stage: 'Initializing algorithm…', processedProjects: 0, totalProjects: 0, processedTasks: 0, totalTasks: 0 });
      const { filteredTasks, processed, totalTasks, skippedTasks } = await runAlgorithmByProject(api, (progress) => {
        setAlgorithmProgress(progress);
      });

      setAlgorithmProgress({
        percent: 92,
        stage: 'Applying results…',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      const mergedTasks = prepareLoadedTasks(
        mergeAlgorithmResults(syncedTasks, filteredTasks, employees),
      );
      tasksRef.current = mergedTasks;
      setTasks(mergedTasks);

      setAlgorithmProgress({
        percent: 96,
        stage: 'Saving algorithm results…',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      await saveAllAlgorithmResults(api);
      algorithmSavePendingRef.current = false;
      await reloadCurrentPartTasks();

      setAlgorithmProgress({
        percent: 100,
        stage: 'Complete — assignments applied',
        processedProjects: processed,
        totalProjects: totalTasks,
        processedTasks: processed,
        totalTasks,
      });
      if (SHOW_ALGORITHM_SKIPPED_MODAL && skippedTasks?.length > 0) {
        setAlgorithmSkippedTasks(skippedTasks);
        setShowAlgorithmSkippedModal(true);
      }
      toast.success(
        `Algorithm finished and saved (${processed} / ${totalTasks} tasks). Review assignments in the grid.`,
      );
      setError('');
      await algorithmRunSleep(600);
    } catch (err) {
      if (isTaskSyncCancelled(err)) {
        return;
      }
      const message =
        err.response?.data?.error ||
        err.response?.data?.message ||
        'Unable to run the algorithm.';
      toast.error(message);
      setError(message);
    } finally {
      setRunningAlgorithm(false);
      setAlgorithmProgress(initialAlgorithmProgress());
    }
  };

  const handleHaveAllDocsChange = async (event) => {
    const nextValue = event.target.checked;
    if (!selectedProjectId) {
      return;
    }

    const previousValue = selectedProject?.have_all_docs !== false;

    setProjects((current) =>
      current.map((project) =>
        String(project.id) === String(selectedProjectId)
          ? { ...project, have_all_docs: nextValue }
          : project,
      ),
    );

    setSavingHaveAllDocs(true);
    try {
      const response = await api.put(`/projects/${selectedProjectId}`, {
        have_all_docs: nextValue,
      });
      setProjects((current) =>
        current.map((project) =>
          String(project.id) === String(selectedProjectId)
            ? response.data.data
            : project,
        ),
      );
      toast.success(
        nextValue
          ? 'Project will show on the histogram. Algorithm allocation is unchanged.'
          : 'Project hidden on the histogram only. It remains fully allocated.',
      );
      setError('');
    } catch {
      setProjects((current) =>
        current.map((project) =>
          String(project.id) === String(selectedProjectId)
            ? { ...project, have_all_docs: previousValue }
            : project,
        ),
      );
      setError('Unable to update project documentation status.');
    } finally {
      setSavingHaveAllDocs(false);
    }
  };

  const { handleColorChange } = useDebouncedProjectColorUpdate({
    selectedProjectId,
    setProjects,
    toast,
    onError: setError,
  });

  const handleUpdateHoursFromImport = (importedRows) => {
    const hoursByTask = new Map(
      importedRows.map((row) => [String(row.taskName).trim().toLowerCase(), row.est]),
    );

    const lookupEst = (taskName) =>
      hoursByTask.get(String(taskName ?? '').trim().toLowerCase());

    const tasksWithExistingHours = tasks.filter((task) => {
      const est = lookupEst(task.task_name);
      return (
        est !== undefined &&
        task.est !== null &&
        task.est !== undefined &&
        String(task.est).trim() !== ''
      );
    });

    if (tasksWithExistingHours.length > 0) {
      const confirmed = window.confirm(
        'Some matching tasks already have estimated hours. Override existing values?',
      );
      if (!confirmed) {
        return;
      }
    }

    let updatedCount = 0;
    const nextTasks = tasks.map((task) => {
      const importedEst = lookupEst(task.task_name);
      if (importedEst === undefined) {
        return task;
      }

      const est = String(importedEst ?? '');
      updatedCount += 1;
      return applyOwnerToTask({
        ...applyPdeTaskFieldChange(
          {
            ...task,
            est,
            dl: '',
            hrs_per: '',
            red: '',
            pd: '',
            buf: '',
            adj: '',
            sh: '',
            al: '',
            ots: '',
          },
          'est',
          est,
        ),
        progress_updated: toStorageDate(new Date()),
      });
    });

    if (updatedCount === 0) {
      setError('No matching task names found in the current part.');
      return;
    }

    setTasks(nextTasks);
    toast.success(`Updated hours for ${updatedCount} task(s). Click Save tasks to persist.`);
    setError('');
  };

  const handleCompareTtHours = async () => {
    if (!canEditProjects || !selectedPartId || !selectedProjectId) {
      return;
    }

    setComparingTtHours(true);
    try {
      let index = ttHoursIndex;
      if (!index.size) {
        const cached = await readTtHoursCache();
        index = buildTtHoursProgressIndex(cached?.summaries ?? []);
        setTtHoursIndex(index);
      }

      if (!index.size) {
        toast.info('No TT hours cache yet. Open TT Project Hours, load hours, then compare again.');
        return;
      }

      const result = applyTtHoursToPdeTasks(tasksRef.current, {
        index,
        wpProjectId: selectedProjectId,
        nrms,
        todayYmd: toStorageDate(new Date()),
      });

      tasksRef.current = result.tasks;
      setTasks(result.tasks);
      setError('');

      if (!result.projectMatched) {
        toast.info('This project is not matched in the TT hours cache. Check the job number on TT Project Hours.');
        return;
      }

      if (result.matched === 0) {
        toast.info('No matching TT task hours for this part.');
        return;
      }

      toast.success(
        `Wrote TT hours into Act on ${result.matched} task(s): ${result.totalTt.toFixed(1)}h vs Plan ${result.totalPlan.toFixed(1)}h. Click Save to persist.`,
      );
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to compare TT hours.');
      toast.error(message);
      setError(message);
    } finally {
      setComparingTtHours(false);
    }
  };

  const handleLegendProjectSelect = useCallback((projectId) => {
    setSelectedProjectId(String(projectId));
    setSelectedPartId('');
    setTasks([]);
    setSelectedTaskRows([]);
  }, []);

  if (loading) {
    return <ProjectsPageSkeleton />;
  }

  return (
    <section className={`pde-page${selectedProjectContext.isDone ? ' pde-page--project-done' : ''}`}>
      <PageHeader
        compact
        title="Project Data Entry"
        actions={(
          <div className="pde-header-actions">
            <button
              type="button"
              className="btn btn-save btn-compact"
              onClick={() => handleSaveTasks()}
              disabled={!canEditProjects || !selectedPartId || savingTasks || runningAlgorithm}
            >
              {savingTasks ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn-save btn-compact"
              onClick={handleRunAlgorithm}
              disabled={!canRunAlgorithm || !selectedPartId || savingTasks || runningAlgorithm || selectedProjectContext.isDone}
              title={selectedProjectContext.isDone ? 'Project is completed' : undefined}
            >
              {runningAlgorithm ? 'Running...' : 'Run algorithm'}
            </button>
            {canReviewAlgorithmAssignments ? (
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={() => setShowAlgorithmReviewModal(true)}
                title="Review algorithm hours and days per task across all projects"
              >
                Review assignments
              </button>
            ) : null}
            {canViewEditsLog ? (
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={() => setShowActivityLogModal(true)}
              >
                Edits Log History
              </button>
            ) : null}
          </div>
        )}
      />

      {error && (
        <div className="alert alert-error pde-alert" role="alert">
          {error}
        </div>
      )}

      <div className="card project-picker">
        <div className="pde-controls pde-controls--filters">
          <div className="pde-controls-group pde-controls-group--filters">
            <label className="project-select-field">
              Select project
              <ProjectColorSelect
                projects={projects}
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                formatProjectLabel={formatProjectDropdownLabel}
              />
            </label>

            {selectedProjectId ? (
              <>
                <label className="project-select-field">
                  Select part
                  <select
                    value={selectedPartId}
                    disabled={partsLoading}
                    onChange={(e) => setSelectedPartId(e.target.value)}
                  >
                    <option value="">
                      {partsLoading ? 'Loading parts...' : '\u00a0'}
                    </option>
                    {parts.map((part) => (
                      <option key={part.id} value={part.id}>
                        {part.name}
                        {part.tasks_count != null ? ` (${part.tasks_count} tasks)` : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="project-color-field">
                  <span className="project-color-label">Project color</span>
                  <input
                    type="color"
                    className="project-color-input"
                    value={displayProjectColor(selectedProject)}
                    onChange={handleColorChange}
                    disabled={!canEditProjects}
                    title="Gantt bar colour for this project"
                  />
                </label>

                <label className="copy-type-field">
                  <span className="copy-type-label">Copy</span>
                  <select
                    value={copyType}
                    disabled={!canEditProjects}
                    onChange={(e) => handleCopyTypeChange(e.target.value)}
                  >
                    {copyOptions.map((option) => (
                      <option key={option.value || 'default'} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="have-all-docs-field" title="Controls histogram visibility only. Does not change algorithm allocation.">
                  <input
                    type="checkbox"
                    checked={selectedProject?.have_all_docs !== false}
                    onChange={handleHaveAllDocsChange}
                    disabled={!canEditProjects || savingHaveAllDocs}
                  />
                  <span>Have all docs</span>
                </label>
              </>
            ) : null}
          </div>

          <div
            className="pde-controls-toolbar-row pde-controls-toolbar-row--primary"
            role="toolbar"
            aria-label="Create and edit actions"
          >
            <div className="pde-action-cluster" aria-label="Create project">
              <button type="button" className="btn btn-secondary btn-compact" onClick={openCreateModal} disabled={!canEditProjects}>
                New project
              </button>
            </div>

            {selectedPartId ? (
              <>
                <div className="pde-controls-divider" aria-hidden="true" />
                <div className="pde-action-cluster" aria-label="Task rows">
                  <button type="button" className="btn btn-secondary btn-compact" onClick={handleAddRow} disabled={!canEditProjects}>
                    Add task row
                  </button>
                  {selectedTaskRows.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-compact"
                      onClick={handleDuplicateSelectedTasks}
                      disabled={!canEditProjects}
                    >
                      Duplicate selected
                    </button>
                  ) : null}
                </div>

                <div className="pde-controls-divider" aria-hidden="true" />
                <div className="pde-action-cluster" aria-label="Import">
                  <button
                    type="button"
                    className="btn btn-secondary btn-compact"
                    onClick={() => setShowUpdateHoursModal(true)}
                    disabled={!canEditProjects}
                  >
                    Update hours
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-compact"
                    onClick={handleCompareTtHours}
                    disabled={!canEditProjects || comparingTtHours || savingTasks}
                    title="Write Time Tracking hours into Act and calculate progress % from Act / Plan"
                  >
                    {comparingTtHours ? 'Comparing...' : 'Compare TT hrs'}
                  </button>
                </div>
              </>
            ) : null}
          </div>
          
        </div>

        {(selectedPartId && selectedTaskRows.length > 0) || selectedProjectId ? (
          <div className="pde-controls-toolbar pde-controls-toolbar--danger" role="toolbar" aria-label="Delete actions">
            <div className="pde-controls-toolbar-row pde-controls-toolbar-row--danger">
              <div className="pde-danger-toolbar-start">
                {selectedProject && (
                  <div className="project-meta pde-project-meta">
                    <span className={`pde-project-status pde-project-status--${selectedProjectContext.status}`}>
                      Status: {selectedProjectContext.label}
                    </span>
                    <span
                      className={`pde-project-tt${selectedProjectTtHours
                        ? ` pde-project-tt--${selectedProjectTtHours.hasTt ? 'yes' : 'no'}`
                        : ''}`}
                      title={selectedProjectTtHours
                        ? (selectedProjectTtHours.hasTt
                          ? `${selectedProjectTtHours.hours.toFixed(1)}h in the Time Tracking cache`
                          : (ttHoursIndex.size
                            ? 'No Time Tracking hours for this project'
                            : 'No TT hours cache yet. Open TT Project Hours and load hours.'))
                        : 'Checking Time Tracking hours…'}
                    >
                      TT hrs: {selectedProjectTtHours
                        ? (selectedProjectTtHours.hasTt ? 'Yes' : 'No')
                        : '…'}
                    </span>
                    {selectedPart && <span>Part: {selectedPart.name}</span>}
                  </div>
                )}

                {selectedProjectContext.isDone && (
                  <p className="muted pde-project-done-hint" role="status">
                    This project is completed. You can review tasks and save changes, but the algorithm is disabled.
                  </p>
                )}

                {selectedProjectId && !partsLoading && parts.length === 0 && (
                  <p className="muted pde-empty-parts">No parts yet. Create a part to start entering tasks.</p>
                )}
              </div>

              <div className="pde-danger-toolbar-actions">
                {canDeleteProjects && selectedPartId && selectedTaskRows.length > 0 ? (
                  <button
                    type="button"
                    className="btn btn-danger btn-compact"
                    onClick={handleDeleteSelectedTasks}
                  >
                    Delete selected
                  </button>
                ) : null}
                {canDeleteProjects && selectedProjectId ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger btn-compact"
                      disabled={!selectedPartId}
                      onClick={handleDeletePart}
                    >
                      Delete part
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-compact"
                      disabled={deletingProject}
                      onClick={handleDeleteProject}
                    >
                      {deletingProject ? 'Deleting...' : 'Delete project'}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}


      </div>

      <CreateNewProjectModal
        open={showCreateModal}
        onClose={closeCreateModal}
        projects={projects}
        onSuccess={handleCreateProjectSuccess}
        initialValues={salesToolPrefill}
        salesToolProposalId={salesToolProposalId}
        salesToolSummary={salesToolSummary}
        ttSummary={ttCreateSummary}
      />

      <DuplicateProjectModal
        open={showProjectCopyModal}
        onClose={closeProjectCopyModal}
        copyType={copyType}
        sourceProjectId={selectedProjectId}
        sourcePartId={selectedPartId}
        sourceProjectName={selectedProject?.name}
        projects={projects}
        existingParts={parts}
        onSuccess={handleCopySuccess}
      />

      <DuplicatePartModal
        open={showPartCopyModal}
        onClose={closePartCopyModal}
        sourceProjectId={selectedProjectId}
        sourcePartId={selectedPartId}
        sourcePartName={selectedPart?.name}
        onSuccess={handleCopySuccess}
      />

      <UpdateHoursModal
        open={showUpdateHoursModal}
        onClose={() => setShowUpdateHoursModal(false)}
        onSave={handleUpdateHoursFromImport}
      />

      <DeleteConfirmModal
        open={deleteTarget === 'part'}
        title="Delete part"
        message={
          selectedPart?.name
            ? `Delete "${selectedPart.name}" and all of its tasks? This cannot be undone.`
            : 'Delete this part and all of its tasks? This cannot be undone.'
        }
        confirmLabel="Delete part"
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDeletePart}
        busy={deletingPart}
      />

      <DeleteConfirmModal
        open={deleteTarget === 'project'}
        title="Delete project"
        message={`Delete "${selectedProject?.name || 'this project'}" and all of its parts and tasks? This cannot be undone.`}
        confirmLabel="Delete project"
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteProject}
        busy={deletingProject}
      />

      {canViewEditsLog && (
        <ActivityLogModal
          open={showActivityLogModal}
          onClose={() => setShowActivityLogModal(false)}
          area="pde"
          title="Edits Log History"
        />
      )}

      {selectedPartId && (
        tasksLoading ? (
          <TaskGridSkeleton />
        ) : (
          <>
            <ProjectFieldSourceLegend
              trailing={
                selectedTaskRows.length > 0 ? (
                  <div className="project-task-bulk-hint project-task-bulk-hint--legend" role="status">
                    {selectedTaskRows.length} task{selectedTaskRows.length === 1 ? '' : 's'} selected — edits apply instantly to all selected rows.
                  </div>
                ) : null
              }
            />
            <PdeAlgorithmLegend />
            <ProjectTaskGrid
              tasks={tasks}
              employees={employees}
              onChange={handleTaskChange}
              selectedRows={selectedTaskRows}
              onSelectedRowsChange={updateSelectedTaskRows}
              inactiveRowPredicate={taskHasPlanHours}
              lockedFieldPredicate={(task, fieldKey) => !canEditProjects || isDlMirrorLocked(task, fieldKey)}
              suppressBulkHint
              taskNameOptions={taskNameOptions}
              instantCommit
              invalidFields={invalidFields}
              onToggleAllDone={handleToggleAllDone}
              allDoneChecked={doneSelectionState.allDoneChecked}
              someDoneChecked={doneSelectionState.someDoneChecked}
              taskNameDoubleClickToEdit
            />
          </>
        )
      )}

      <HistogramMiniLegend
        items={legendItems}
        selectedProjectId={selectedProjectId}
        onProjectSelect={handleLegendProjectSelect}
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

      {SHOW_ALGORITHM_SKIPPED_MODAL ? (
        <AlgorithmSkippedTasksModal
          open={showAlgorithmSkippedModal}
          tasks={algorithmSkippedTasks}
          onClose={() => setShowAlgorithmSkippedModal(false)}
        />
      ) : null}

      <AlgorithmAssignmentReviewModal
        open={showAlgorithmReviewModal}
        onClose={() => setShowAlgorithmReviewModal(false)}
      />

      <ProjectPriorityWarningModal
        open={ppWarning.open}
        warnings={ppWarning.warnings}
        onConfirm={handleConfirmPpWarning}
        onCancel={handleCancelPpWarning}
        confirmLabel="Save anyway"
      />
      {taskSyncConflictModal}
    </section>
  );
}
