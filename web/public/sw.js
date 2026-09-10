/**
 * daybook 的 Service Worker：只做应用壳缓存。
 *
 * 规则（见计划 §9.3）：
 *  - `/v1/*` 与 `/healthz` 一律不缓存、不拦截（日记数据必须实时）；
 *  - 其余 GET 走「缓存优先 + 后台更新」，因此断网也能打开应用壳；
 *  - 触发 Web Push 的部分在阶段 3 接（push / notificationclick 事件）。
 */
const CACHE = 'daybook-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname === '/healthz') return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) void cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached ?? Response.error());
      // 有缓存先用缓存（秒开），同时后台更新
      return cached ?? network;
    }),
  );
});

/**
 * 收到服务端推送 → 弹系统通知。
 * 服务端只发 title/body/url/tag，正文永远不出现在通知里（计划 §10）。
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'daybook', body: '该写日记了', url: '/#/today', tag: 'daybook' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // 非 JSON 负载：用默认文案
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url },
    }),
  );
});

/** 点通知 → 聚焦已有窗口（并跳转）或新开一个 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/#/today';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          void client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
