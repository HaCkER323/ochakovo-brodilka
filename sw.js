/* =========================================================
   БРОДИЛКА — service worker
   Кэширует оболочку, отдаёт офлайн-фолбэк и свежие скрипты.
   Работает только по http(s); на file:// не регистрируется.
   ========================================================= */

const VERSION = "brodilka-v11";
const SHELL_CACHE = VERSION + "-shell";
const RUNTIME_CACHE = VERSION + "-runtime";

/* Оболочка приложения. Каждый файл кэшируется независимо:
   отсутствие новой иконки или ассета не ломает установку SW. */
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
  "./assets/brand/pattern-red.jpg",
  "./assets/brand/pattern-white.jpg",
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
      /* кэш может быть недоступен — не мешаем выдаче ответа */
    });
  return response;
}

/* Сеть с откатом на кэш: свежие html/css/js важнее скорости. */
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

/* Кэш с фоновым обновлением: картинки и шрифты. */
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
