// Network-first SW. Pre-caches the app shell on install (best-effort —
// individual file failures don't abort install). Serves from cache when
// the network is unavailable. Bump CACHE on intentional cache flush.

const CACHE = "training-app-v2";

const SHELL = [
  "/",
  "/app.js",
  "/style.css",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

// Always go to network — these are the version stamp + the API base
// config + the SW itself, all of which must stay fresh across deploys.
const NEVER_CACHE = ["/version.txt", "/data/api_base.json", "/service-worker.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((url) => c.add(url))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.includes(url.pathname)) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((r) =>
          r || (e.request.mode === "navigate" ? caches.match("/") : null),
        ),
      ),
  );
});
