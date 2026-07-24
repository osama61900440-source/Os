/* ============================================================
   Service Worker — makes the HOSTED shop-control page load OFFLINE.
   ============================================================
   Upload this file into the SAME folder as index.html on your web host
   (e.g. GitHub Pages: .../Os/sw.js next to .../Os/index.html).

   How it works:
   - First visit (needs internet once): the browser downloads the page
     normally, this worker installs, and caches the page.
   - Every visit after that (including with NO internet): the browser
     serves the cached copy instantly, so the app opens normally instead
     of showing "Web page not available / net::ERR_INTERNET_DISCONNECTED".
   - Whenever the phone does have internet, this worker quietly re-fetches
     the latest version in the background and updates the cache for next
     time (stale-while-revalidate), so the shop owner still gets updates
     without ever seeing a failed offline load.
   - This only caches the app "shell" (the HTML/JS itself). The shop's
     actual data (sales, expenses, etc.) is handled separately by the
     app's own localStorage + Firebase sync logic — this file has nothing
     to do with that and never touches shop data.
*/

var CACHE_NAME = "shop-control-shell-v1";
var APP_SHELL_URLS = [
  "./",
  "./index.html"
];

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL_URLS).catch(function () {
        // If one of the shell URLs 404s (e.g. no separate "./" route),
        // don't let that block installation entirely.
        return Promise.resolve();
      });
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  // Navigation requests (opening/refreshing the page itself, including
  // with query strings like ?ISCI=011102): always try the network first
  // for the freshest copy, but fall back to the cached shell the instant
  // the network is unavailable — this is the exact case from the
  // screenshot (net::ERR_INTERNET_DISCONNECTED).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var resClone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put("./index.html", resClone); });
          return res;
        })
        .catch(function () {
          return caches.match("./index.html").then(function (cached) {
            return cached || caches.match("./");
          });
        })
    );
    return;
  }

  // Everything else (scripts, icons, etc. if any are added later):
  // cache-first, falling back to network, and updating the cache
  // whenever a fresh network copy succeeds.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var networkFetch = fetch(req)
        .then(function (res) {
          if (res && res.status === 200) {
            var resClone = res.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(req, resClone); });
          }
          return res;
        })
        .catch(function () { return cached; });
      return cached || networkFetch;
    })
  );
});
