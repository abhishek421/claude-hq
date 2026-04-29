self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'Claude HQ', body: event.data.text() }; }

  const title = payload.title || 'Claude HQ';
  const options = {
    body: payload.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: payload.session_id || 'claude-hq',   // collapses duplicate notifications per session
    renotify: true,
    requireInteraction: true,                  // stays visible until dismissed
    data: { url: payload.url || 'http://localhost:4242' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || 'http://localhost:4242';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith('http://localhost:4242') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
