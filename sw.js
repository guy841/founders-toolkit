/* Helm service worker — makes the web app installable and fully offline.
   Cache-first for the app shell; network fallback; runtime-cache other GETs. */
const CACHE = "helm-v11";
const CORE = [
  "./", "./index.html", "./privacy.html", "./manifest.webmanifest",
  "./helm-config.js", "./helm-sync.js", "./helm-company.js",
  "./fonts/fonts.css",
  "./fonts/manrope-400.woff2", "./fonts/manrope-500.woff2", "./fonts/manrope-600.woff2", "./fonts/manrope-700.woff2",
  "./fonts/outfit-500.woff2", "./fonts/outfit-600.woff2", "./fonts/outfit-700.woff2",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
  "./tools/deadline-copilot/index.html",
  "./tools/corporation-tax/index.html",
  "./tools/company-records/index.html",
  "./tools/setup-checklist/index.html",
  "./tools/insurance-check/index.html",
  "./tools/salary-dividends/index.html",
  "./tools/vat-checker/index.html",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === "navigate" ? caches.match("./index.html") : Promise.reject("offline")));
    })
  );
});
