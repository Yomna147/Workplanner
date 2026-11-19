import api from '../api/client';
import { filterBarsByDateRange } from '../components/gantt/ganttUtils';
import { filterActiveProjects, sortProjectsForPde } from './projectSort';
import { getCurrentWeekRange } from './weekRange';

export async function fetchDlWeekProjects() {
  const weekRange = getCurrentWeekRange();

  const [histogramRes, projectsRes] = await Promise.all([
    api.get('/resource-histogram', {
      params: {
        start: weekRange.start,
        end: weekRange.end,
      },
    }),
    api.get('/projects'),
  ]);

  const bars = histogramRes.data?.data?.bars ?? [];
  const weekBars = filterBarsByDateRange(bars, weekRange.start, weekRange.end);

  const projectIds = new Set();
  weekBars.forEach((bar) => {
    if (bar?.project_id) {
      projectIds.add(String(bar.project_id));
    }
  });

  const allProjects = Array.isArray(projectsRes.data?.data) ? projectsRes.data.data : [];
  const projects = sortProjectsForPde(
    filterActiveProjects(allProjects.filter((project) => projectIds.has(String(project.id)))),
  );

  return {
    weekRange,
    projects,
  };
}
