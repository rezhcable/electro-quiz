const CACHE = 'electro-quiz-v18';
const ASSETS = [
  './',
  './index.html',
  './css/tailwind.css',
  './js/app.js',
  './data/exam_data.json',
  './manifest.json',
  './assets/fonts/inter-var-latin-cyrillic.woff',
  './assets/bandit.webp',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];

// Сколько ждать сеть для «сначала сеть» (мс), прежде чем отдать кэш — чтобы не висеть на плохой связи
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isCode(request, url) {
  return request.mode === 'navigate' || /\.(html|js|json|css)$/.test(url.pathname);
}

// HTML/JS/CSS/JSON: сначала сеть (чтобы обновления доходили), при сбое или таймауте — кэш
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const net = fetch(request).then((res) => {
    if (res && res.status === 200) cache.put(request, res.clone());
    return res;
  });
  net.catch(() => {}); // поздний ответ после таймаута просто обновит кэш
  try {
    return await Promise.race([
      net,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT))
    ]);
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

// Картинки, шрифты, иконки: сначала кэш
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.status === 200) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // чужие домены не трогаем
  e.respondWith(isCode(request, url) ? networkFirst(request) : cacheFirst(request));
});
