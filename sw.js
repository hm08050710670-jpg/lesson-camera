/* GOLF GUTS CAMERA Service Worker
 *
 * 方針：「ネットワーク優先」
 *  - 電波がある時は必ず最新のファイルを取りに行く（＝更新後に古いプログラムが残り続けない）
 *  - 電波がない／遅い時だけ、前回保存したファイルで起動する（練習場などの圏外対策）
 *  - 保存するのはアプリ本体の小さなファイルだけ。撮影した写真・動画は一切キャッシュしない
 */
var CACHE = 'ggc-shell-v1';
var SHELL = ['./', 'index.html', 'style.css', 'config.js', 'app.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png'];
var CACHEABLE = /(\/|\.html|\.css|\.js|\.png|\.jpg|\.jpeg|\.webp|\.webmanifest)$/i;
var TIMEOUT_MS = 4000;

// ブラウザ側が古いファイルを使い回さないよう、毎回確認させる指定を付けて返す
// （GitHub Pages は「10分間は再確認不要」という指定を付けるため、そのままだと更新が遅れて見える）
function noReuse(res) {
  try {
    var h = new Headers(res.headers);
    h.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  } catch (e) { return res; }
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return fetch(url, { cache: 'no-store' })
          .then(function (res) { if (res.ok) return cache.put(url, res); })
          .catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;
  if (!CACHEABLE.test(url.pathname)) return;

  event.respondWith(new Promise(function (resolve) {
    var settled = false;
    var fromCache = function () {
      return caches.open(CACHE).then(function (c) { return c.match(req, { ignoreSearch: true }); });
    };
    var timer = setTimeout(function () {
      fromCache().then(function (hit) {
        if (hit && !settled) { settled = true; resolve(noReuse(hit)); }
      });
    }, TIMEOUT_MS);

    fetch(url.href, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      if (!settled) { settled = true; resolve(res.ok ? noReuse(res) : res); }
    }).catch(function () {
      clearTimeout(timer);
      if (settled) return;
      fromCache().then(function (hit) {
        settled = true;
        resolve(hit ? noReuse(hit) : new Response('オフラインのため読み込めませんでした。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }));
      });
    });
  }));
});
