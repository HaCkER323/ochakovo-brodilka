/* =========================================================
   Р‘Р РћР”РР›РљРђ вЂ” service worker
   РљСЌС€РёСЂСѓРµС‚ РѕР±РѕР»РѕС‡РєСѓ, РѕС‚РґР°С‘С‚ РѕС„Р»Р°Р№РЅ-С„РѕР»Р±СЌРє Рё СЃРІРµР¶РёРµ СЃРєСЂРёРїС‚С‹.
   Р Р°Р±РѕС‚Р°РµС‚ С‚РѕР»СЊРєРѕ РїРѕ http(s); РЅР° file:// РЅРµ СЂРµРіРёСЃС‚СЂРёСЂСѓРµС‚СЃСЏ.
   ========================================================= */

const VERSION = "brodilka-v18";
const SHELL_CACHE = VERSION + "-shell";
const RUNTIME_CACHE = VERSION + "-runtime";

/* РћР±РѕР»РѕС‡РєР° РїСЂРёР»РѕР¶РµРЅРёСЏ. РљР°Р¶РґС‹Р№ С„Р°Р№Р» РєСЌС€РёСЂСѓРµС‚СЃСЏ РЅРµР·Р°РІРёСЃРёРјРѕ:
   РѕС‚СЃСѓС‚СЃС‚РІРёРµ РЅРѕРІРѕР№ РёРєРѕРЅРєРё РёР»Рё Р°СЃСЃРµС‚Р° РЅРµ Р»РѕРјР°РµС‚ СѓСЃС‚Р°РЅРѕРІРєСѓ SW. */
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./css/game.css",
  "./css/brand.css",
  "./js/config.js",
  "./js/data.js",
  "./js/pdf.js",
  "./js/app.js",
  "./assets/share-promo.png",
  "./assets/brand/ochakovo-logo.png",
  "./assets/brand/ochakovo-logo-white.png",
  "./assets/brand/ochakovo-mark.svg",
  "./assets/brand/ornament.svg",
  "./assets/mascot/splat.svg",
  "./assets/mascot/pop.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png",
  "./assets/app-icon.svg",
  "./assets/mascot.svg",
  "./assets/chief.svg",
  "./assets/mark.svg",
  "./assets/dasha.svg",
  "./assets/lev.svg",
  "./assets/hero-can.svg",
  "./assets/scene-brew.svg",
  "./assets/scene-line.svg",
  "./assets/scene-lab.svg"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        return Promise.allSettled(
          SHELL.map(function (url) {
            return cache.add(new Request(url, { cache: "reload" }));
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
      .catch(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== SHELL_CACHE && key !== RUNTIME_CACHE) {
              return caches.delete(key);
            }
            return Promise.resolve(false);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

function putInCache(request, response) {
  if (!response || response.status !== 200 || response.type === "opaque") return response;
  const copy = response.clone();
  caches
    .open(RUNTIME_CACHE)
    .then(function (cache) {
      return cache.put(request, copy);
    })
    .catch(function () {
      /* РєСЌС€ РјРѕР¶РµС‚ Р±С‹С‚СЊ РЅРµРґРѕСЃС‚СѓРїРµРЅ вЂ” РЅРµ РјРµС€Р°РµРј РІС‹РґР°С‡Рµ РѕС‚РІРµС‚Р° */
    });
  return response;
}

/* РЎРµС‚СЊ СЃ РѕС‚РєР°С‚РѕРј РЅР° РєСЌС€: СЃРІРµР¶РёРµ html/css/js РІР°Р¶РЅРµРµ СЃРєРѕСЂРѕСЃС‚Рё. */
function networkFirst(request, fallbackUrl) {
  return fetch(request)
    .then(function (response) {
      return putInCache(request, response);
    })
    .catch(function () {
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        if (fallbackUrl) {
          return caches.match(fallbackUrl).then(function (fallback) {
            if (fallback) return fallback;
            return caches.match("./index.html").then(function (index) {
              return index || caches.match("./");
            });
          });
        }
        return cached;
      });
    });
}

/* РљСЌС€ СЃ С„РѕРЅРѕРІС‹Рј РѕР±РЅРѕРІР»РµРЅРёРµРј: РєР°СЂС‚РёРЅРєРё Рё С€СЂРёС„С‚С‹. */
function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    const update = fetch(request)
      .then(function (response) {
        return putInCache(request, response);
      })
      .catch(function () {
        return null;
      });
    return cached || update;
  });
}

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  /* Админка и API не проходят через SW: там пароль, cookie и персональные данные. */
  const pathname = url.pathname;
  if (
    pathname === "/admin" ||
    pathname === "/admin/" ||
    pathname === "/admin.html" ||
    pathname === "/admin.css" ||
    pathname === "/admin.js" ||
    pathname.startsWith("/api/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  const destination = request.destination;
  if (destination === "script" || destination === "style" || destination === "manifest") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (destination === "image" || destination === "font" || destination === "svg") {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});





