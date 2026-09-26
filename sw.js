// MIN-Tube-Lite Service Worker (v2 - performance optimized)
const STATIC_CACHE = 'min-tube-lite-static-v3';
const RUNTIME_CACHE = 'min-tube-lite-runtime-v3';

const PRECACHE = [
  '/public/min-tube-lite.html',
  '/img/min-tube-lite.png',
  '/manifest.json',
];

// 静的アセット判定 (CSS/JS/フォント/画像)
const isStaticAsset = (url) =>
  /\.(?:css|js|woff2?|ttf|eot|png|jpe?g|gif|webp|svg|ico)$/i.test(url);

// インストール時: 静的リソースをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      cache.addAll(PRECACHE).catch(() => {/* 失敗してもインストールは継続 */})
    )
  );
  self.skipWaiting();
});

// 有効化時: 古いキャッシュを削除
self.addEventListener('activate', event => {
  const keep = new Set([STATIC_CACHE, RUNTIME_CACHE]);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// フェッチ戦略:
//  - 静的アセット: Cache First (高速)
//  - ナビゲーション: Network First (最新の HTML を優先, 失敗時はキャッシュ)
//  - その他: Stale-While-Revalidate
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 動画ストリームや API はキャッシュしない
  if (url.pathname.startsWith('/stream') ||
      url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/check-version') ||
      url.pathname.startsWith('/proxy-image')) {
    return;
  }

  // ナビゲーション: Network First
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        const clone = res.clone();
        caches.open(RUNTIME_CACHE).then(c => c.put(req, clone));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('/')))
    );
    return;
  }

  // 静的アセット: Cache First
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then(c => c.put(req, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // その他: Stale-While-Revalidate
  event.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
