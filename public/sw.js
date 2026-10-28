/**
 * Growzar's service worker (pre-Wave-1 pack 3).
 *
 * It exists so Growzar installs as an app, opens on its launch page at once,
 * and says something useful offline.
 * It never stores a page, a loader's data or an API answer: those hold a
 * merchant's figures, and a stale number is worse than none. What it keeps is
 * the launch and offline pages, the icons and the build's fingerprinted files.
 *
 * VERSION is stamped from build/version.txt at build time (`npm run
 * build:sw`), so every deploy ships a changed worker. The new one replaces the
 * old as soon as it installs and deletes every cache but its own, so no file
 * from an earlier build outlives a deploy.
 */
const VERSION = "__BUILD_VERSION__";
const CACHE = `growzar-${VERSION}`;
const OFFLINE = "/offline.html";
const LAUNCH = "/launch.html";
const SHELL = [OFFLINE, LAUNCH, "/icons/growzar.svg", "/icons/growzar-192.png", "/favicon.ico"];

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

  // The launch page holds no figures, so the installed app opens it straight from the cache.
  if (request.mode === "navigate" && url.pathname === LAUNCH) {
    event.respondWith(caches.match(LAUNCH).then((hit) => hit ?? fetch(request)));
    return;
  }

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

// ── Push notifications (pre-Wave-1 pack 4) ───────────────────────────────────
// The server sends { title, body, url, id, tag }, worded as the card it opens.
// A click reports itself (push_sends.clickedAt), then opens the page in the
// window Growzar already has, or a new one. Only Growzar's own pages open.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Growzar", {
      body: data.body || "",
      icon: "/icons/growzar-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/home", id: data.id || null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url, id } = event.notification.data || {};
  const target = new URL(url || "/home", self.location.origin);
  if (target.origin !== self.location.origin) return;
  const report = id
    ? fetch("/api/push/click", { method: "POST", body: new URLSearchParams({ id }), credentials: "same-origin" }).catch(() => null)
    : Promise.resolve();
  const open = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const mine = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (mine) {
      await mine.focus();
      return mine.navigate(target.href).catch(() => self.clients.openWindow(target.href));
    }
    return self.clients.openWindow(target.href);
  });
  event.waitUntil(Promise.all([report, open]));
});

// The browser replaced the subscription: subscribe again with the same key, and tell Growzar which one it replaces.
self.addEventListener("pushsubscriptionchange", (event) => {
  const old = event.oldSubscription;
  if (!old || !old.options) return;
  event.waitUntil(
    self.registration.pushManager.subscribe(old.options).then((sub) =>
      fetch("/api/push", {
        method: "POST",
        body: new URLSearchParams({ intent: "subscribe", subscription: JSON.stringify(sub), replaces: old.endpoint }),
        credentials: "same-origin",
      }),
    ),
  );
});
