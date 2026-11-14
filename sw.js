// 네트워크 우선, 실패하면 캐시 (오프라인에서도 열리게)
// __BUILD__ 은 배포 때 커밋 해시로 바뀐다 → 배포마다 이 파일이 달라져서 설치된 앱이 새 버전을 알아챔
const CACHE = 'filmcam-__BUILD__';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './film.js', './stamp.js', './exif.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
