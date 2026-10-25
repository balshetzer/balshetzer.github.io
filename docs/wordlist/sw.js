// sw.js — keeps the app's own files so it opens offline. Network first, so a
// new version is picked up as soon as there is a connection; the cache is
// the fallback when offline or slow. GitHub's API is never touched here.
const CACHE = "wordlist-shell-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "logic.js", "api.js",
               "manifest.webmanifest", "icon.svg", "icon-192.png",
               "apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))
                        .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), ms));

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    // no-cache: ask the server every time (a cheap "not modified" when
    // nothing changed), so GitHub Pages' 10-minute max-age cannot serve a
    // stale copy right after a publish
    const response = await Promise.race([fetch(request, { cache: "no-cache" }), timeout(4000)]);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) ||
           (request.mode === "navigate" ? cache.match("index.html") : Response.error());
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
