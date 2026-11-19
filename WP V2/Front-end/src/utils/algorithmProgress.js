export const initialAlgorithmProgress = () => ({
  percent: 0,
  stage: '',
  processedProjects: 0,
  totalProjects: 0,
  processedTasks: 0,
  totalTasks: 0,
});

/**
 * Slowly advances progress while a long request is in flight (never reaches `to` until stopped).
 */
export function createCreepingProgress(onUpdate, { from = 30, to = 90, stage, intervalMs = 350 } = {}) {
  let current = from;
  onUpdate({ percent: Math.round(current), stage });

  const id = setInterval(() => {
    const remaining = to - current;
    if (remaining <= 0.2) {
      return;
    }
    current += Math.max(0.4, remaining * 0.06);
    onUpdate({ percent: Math.round(Math.min(to - 1, current)), stage });
  }, intervalMs);

  return {
    stop(atPercent = to) {
      clearInterval(id);
      onUpdate({ percent: Math.round(atPercent), stage });
    },
  };
}
