import { showBrowserNotification } from './browserNotify';
import { playNotifySound } from './notifySound';
import { formatNewTtProjectsToast } from './ttNewProjectNotify';

function browserTitle(newProjects = []) {
  const count = newProjects.length;
  if (count === 1) {
    return 'New TT project — not in Work Planner';
  }
  return `${count} TT projects — not in Work Planner`;
}

function formatProjectLine(item) {
  return `⚠  ${item.label}  ·  Needs setup in WP`;
}

function browserBody(newProjects = []) {
  const preview = newProjects.slice(0, 3);
  const lines = preview.map((item) => formatProjectLine(item));
  const remaining = newProjects.length - preview.length;

  if (remaining > 0) {
    lines.push(`…and ${remaining} more`);
  }

  lines.push('Tap to create in Project Data Entry');
  return lines.join('\n');
}

/** Deep-link that opens PDE Create New Project (optional name prefill). */
export function buildPdeNewProjectUrl(newProjects = []) {
  const params = new URLSearchParams();
  params.set('newProject', '1');

  const preferred = newProjects[0];
  const name = String(preferred?.name || '').trim();
  if (name) {
    params.set('name', name);
  } else if (preferred?.jobNumber) {
    params.set('name', String(preferred.jobNumber));
  }

  return `/projects?${params.toString()}`;
}

/**
 * In-app toast + sound + OS/browser notification (visible on other tabs).
 */
export async function announceTtNewProjects(newProjects, toast) {
  if (!newProjects?.length) return { shownOs: false };

  const message = formatNewTtProjectsToast(newProjects);
  playNotifySound();

  if (toast?.info) {
    toast.info(message);
  }

  const result = await showBrowserNotification({
    title: browserTitle(newProjects),
    body: browserBody(newProjects),
    tag: `wp2-tt-new-project-${Date.now()}`,
    requireInteraction: true,
    url: buildPdeNewProjectUrl(newProjects),
    actions: [
      { action: 'open', title: 'Create in PDE' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });

  return { shownOs: Boolean(result), via: result?.via ?? null, message };
}
