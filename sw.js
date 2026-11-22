// Мінімальний service worker: потрібен, щоб браузер дозволив «додати на головний екран».
// Нічого не кешує — гра завжди бере свіжі файли.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
