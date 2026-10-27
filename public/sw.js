/**
 * Growzar's service worker (pre-Wave-1 pack 3).
 *
 * It exists so Growzar installs as an app and says something useful offline.
 * It never stores a page, a loader's data or an API answer: those hold a
 * merchant's figures, and a stale number is worse than none. What it keeps is
 * the offline page, the icons and the build's fingerprinted files.
 *
 * VERSION is stamped from build/version.txt at build time (`npm run
 * build:sw`), so every deploy ships a changed worker. The new one replaces the
 * old as soon as it installs and deletes every cache but its own, so no file
 * from an earlier build outlives a deploy.
 */
const VERSION = "__BUILD_VERSION__";
const CACHE = `growzar-${VERSION}`;
const OFFLINE = "/offline.html";
const SHELL = [OFFLINE, "/icons/icon-64.png", "/icons/icon-192.png", "/favicon.ico"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Files whose content never changes under the same URL: kept, and served from the cache first. */
function isStatic(url) {
  return url.origin === self.location.origin && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/"));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // A page: always from the network. Offline, the offline page, never a saved copy.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok && response.type === "basic") cache.put(request, response.clone());
        return response;
      }),
    );
  }
  // Everything else (loader data, /api, the manifest) goes straight to the network, unseen.
});
