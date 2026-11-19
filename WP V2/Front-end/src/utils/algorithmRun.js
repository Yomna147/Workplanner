/** Re-enable when skipped-task review UI is ready again. */
export const SHOW_ALGORITHM_SKIPPED_MODAL = false;

const DEFAULT_STEP_TIMEOUT_MS = 1800000; // 30 min — match AlgoController max_execution_time

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the scheduling algorithm in global priority order with stepped requests and live progress.
 */
export async function runAlgorithmByProject(api, onProgress, { stepTimeout = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  const initResponse = await api.post('/algorithm/run/init', null, { timeout: stepTimeout });
  const totalTasks = initResponse.data.total_tasks ?? 0;

  if (totalTasks === 0) {
    onProgress?.({
      percent: 100,
      stage: 'No schedulable tasks found.',
      processedProjects: 0,
      totalProjects: 0,
      processedTasks: 0,
      totalTasks: 0,
    });

    return {
      filteredTasks: [],
      assignmentDetails: [],
      processed: 0,
      totalProjects: 0,
      totalTasks: 0,
      skippedTasks: initResponse.data.skipped_tasks ?? [],
    };
  }

  onProgress?.({
    percent: 12,
    stage: `Starting — ${totalTasks} task${totalTasks === 1 ? '' : 's'} across all projects`,
    processedProjects: 0,
    totalProjects: totalTasks,
    processedTasks: 0,
    totalTasks,
  });

  let filteredTasks = [];
  let assignmentDetails = [];
  let processedTasks = 0;
  let skippedTasks = initResponse.data.skipped_tasks ?? [];

  while (processedTasks < totalTasks) {
    const stepResponse = await api.post('/algorithm/run/step', null, { timeout: stepTimeout });
    const data = stepResponse.data;
    processedTasks = data.processed_tasks ?? data.processed ?? processedTasks;
    const total = data.total_tasks ?? data.total ?? totalTasks;

    if (data.done) {
      if (Array.isArray(data.filteredTasks)) {
        filteredTasks = data.filteredTasks;
      }
      if (Array.isArray(data.assignmentDetails)) {
        assignmentDetails = data.assignmentDetails;
      }
      if (Array.isArray(data.skipped_tasks)) {
        skippedTasks = data.skipped_tasks;
      }
    } else if (Array.isArray(data.assignmentDetails) && data.assignmentDetails.length > 0) {
      assignmentDetails = data.assignmentDetails;
    }

    const projectName = data.project_name || 'Scheduling';
    const percent = 12 + Math.round((processedTasks / Math.max(total, 1)) * 78);

    onProgress?.({
      percent,
      stage: `Processed ${processedTasks} / ${total} tasks — ${projectName}`,
      processedProjects: processedTasks,
      totalProjects: total,
      processedTasks,
      totalTasks: total,
      projectName,
    });

    if (data.done) {
      break;
    }
  }

  if (assignmentDetails.length > 0 && typeof console !== 'undefined' && console.groupCollapsed) {
    console.groupCollapsed(`Algorithm allocation review (${assignmentDetails.length} tasks)`);
    assignmentDetails.forEach((detail) => {
      console.log(
        detail.task_name ?? `Task #${detail.task_id ?? '?'}`,
        detail,
      );
    });
    console.groupEnd();
  }

  return {
    filteredTasks,
    assignmentDetails,
    processed: processedTasks,
    totalProjects: totalTasks,
    totalTasks,
    skippedTasks,
  };
}

export { sleep as algorithmRunSleep };
