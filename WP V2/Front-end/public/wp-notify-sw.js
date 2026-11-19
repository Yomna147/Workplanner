/* Work Planner desktop notification service worker */
const DEFAULT_OPEN_PATH = '/projects?newProject=1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function focusOrOpen(path) {
  const targetPath = path || DEFAULT_OPEN_PATH;
  const absoluteUrl = new URL(targetPath, self.registration.scope).href;
  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  for (const client of allClients) {
    try {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(absoluteUrl);
          } catch {
            // navigate not always allowed; focus is enough
          }
        }
        return;
      }
    } catch {
      // ignore bad client urls
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(absoluteUrl);
  }
}

self.addEventListener('notificationclick', (event) => {
  const action = event.action || 'open';
  event.notification.close();

  if (action === 'dismiss') {
    return;
  }

  const path = event.notification?.data?.url || DEFAULT_OPEN_PATH;
  event.waitUntil(focusOrOpen(path));
});
