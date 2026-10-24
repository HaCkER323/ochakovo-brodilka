#!/usr/bin/env node
/**
 * run-qa.js — переиспользуемый QA-раннер для «БРОДИЛКА» (статический квест/PWA).
 *
 * Без сторонних npm-пакетов: Node.js >= 22 (встроенный WebSocket),
 * Chromium (Edge/Chrome) и DevTools Protocol.
 *
 * Что делает:
 *   - поднимает локальный http-сервер (нужен для service worker / PWA);
 *   - запускает headless Chromium с изолированными browser context на сценарий;
 *   - проходит игру по data-action селекторам (лендинг → интро → герой → все
 *     мини-игры → финал → форма), собирает скриншоты;
 *   - проверяет горизонтальный скролл, console errors, сетевые ошибки;
 *   - проверяет PWA: манифест, иконки, service worker, кэш, offline reload,
 *     standalone-эмуляцию, safe-area/iOS meta;
 *   - пишет машинный отчёт qa-report/artifacts/latest.json.
 *
 * Запуск:
 *   node qa-report/run-qa.js                      # все сценарии
 *   node qa-report/run-qa.js --scenario=survey-desktop
 *   node qa-report/run-qa.js --list
 *   node qa-report/run-qa.js --url=http://127.0.0.1:8080 --headed
 *   node qa-report/run-qa.js --browser="C:\Program Files\...\msedge.exe"
 *
 * Выход: код 0 — все проверки pass; 1 — есть fail/фatal; 2 — ошибка стенда.
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const QA_DIR = path.join(ROOT, "qa-report");
const SCREENS_DIR = path.join(QA_DIR, "screens");
const ARTIFACTS_DIR = path.join(QA_DIR, "artifacts");
const DOWNLOADS_DIR = path.join(QA_DIR, "artifacts", "downloads");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_DIR = path.join(SCREENS_DIR, RUN_ID);

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  console.log("[qa]", ...args);
}

function warn(...args) {
  console.warn("[qa][warn]", ...args);
}

async function mkdirp(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function safeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function waitUntil(fn, { timeout = 10000, interval = 100, label = "condition" } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timeout ${timeout}ms: ${label}${lastError ? " / last error: " + lastError.message : ""}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function readJSON(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    return null;
  }
}

function inspectPdfBuffer(buffer, filename = "") {
  const latin = buffer.toString("latin1");
  const head = buffer.subarray(0, 16).toString("latin1");
  const pageMatches = latin.match(/\/Type\s*\/Page[^s]/g) || [];
  return {
    file: filename,
    size: buffer.length,
    isPdf: /^%PDF-\d\.\d/.test(head),
    hasEof: latin.includes("%%EOF"),
    pages: pageMatches.length,
    hasImage: /\/Subtype\s*\/Image/.test(latin),
    hasJpeg: buffer.includes(Buffer.from([0xff, 0xd8])),
    hasXref: /xref/.test(latin) && /startxref/.test(latin)
  };
}

function parseSwVersion(swText) {
  const match = String(swText || "").match(/VERSION\s*=\s*["'](brodilka-v(\d+))["']/);
  return match ? { version: match[1], number: Number(match[2]) } : { version: null, number: null };
}

/* ------------------------------------------------------------------ */
/* static server                                                       */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".manifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf"
};

function startStaticServer(root, port) {
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const filePath = path.resolve(root, "." + pathname);
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found: " + pathname);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        "content-type": MIME[ext] || "application/octet-stream",
        "cache-control": "no-cache",
        "service-worker-allowed": "/"
      };
      if (request.method === "HEAD") {
        response.writeHead(200, headers);
        response.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      response.writeHead(200, { ...headers, "content-length": stat.size });
      stream.pipe(response);
      stream.on("error", () => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("server error: " + error.message);
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        stop: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* CDP client                                                          */
/* ------------------------------------------------------------------ */

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket open timeout")), 15000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error("CDP websocket error: " + (event.message || "unknown")));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this._onMessage(event.data));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  _onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch (error) {
      return;
    }
    if (message.id) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message} (${message.error.code})`));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    const handlers = this.handlers.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(message.params || {}, message.sessionId);
      } catch (error) {
        warn("handler error", message.method, error.message);
      }
    }
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method).delete(handler);
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error(`CDP closed, cannot send ${method}`));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch (error) {
      /* noop */
    }
  }
}

/* ------------------------------------------------------------------ */
/* browser launcher                                                    */
/* ------------------------------------------------------------------ */

function findBrowserPath(explicit) {
  const candidates = [
    explicit,
    process.env.BRODILKA_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      /* noop */
    }
  }
  return null;
}

async function fetchJson(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function launchBrowser({ browserPath, headed, profileRoot, appUrl = null }) {
  const executable = findBrowserPath(browserPath);
  if (!executable) {
    throw new Error(
      "Chromium-браузер не найден. Укажите --browser=\"C:\\path\\to\\msedge.exe\" или задайте BRODILKA_BROWSER."
    );
  }
  const port = await getFreePort();
  const profileDir = path.join(profileRoot, "profile-" + port);
  await mkdirp(profileDir);
  const args = [
    headed ? "--headless=false" : "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--window-size=1440,1000",
    appUrl ? `--app=${appUrl}` : "about:blank"
  ];
  // Edge иногда требует явный --headless (без =new); новый режим поддерживается в 112+.
  if (/msedge/i.test(executable)) args[0] = headed ? "--headless=false" : "--headless=new";

  let child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  let version = null;
  try {
    version = await waitUntil(() => fetchJson(`http://127.0.0.1:${port}/json/version`), {
      timeout: 20000,
      interval: 250,
      label: "browser devtools endpoint"
    });
  } catch (error) {
    // fallback: старый headless-флаг
    try {
      child.kill();
    } catch (killError) {
      /* noop */
    }
    await sleep(500);
    args[0] = headed ? "--headless=false" : "--headless";
    child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    version = await waitUntil(() => fetchJson(`http://127.0.0.1:${port}/json/version`), {
      timeout: 20000,
      interval: 250,
      label: "browser devtools endpoint (legacy headless)"
    });
  }
  const cdp = new CdpClient(version.webSocketDebuggerUrl);
  await cdp.open();
  return {
    cdp,
    executable,
    port,
    version: version.Browser || version["User-Agent"] || "chromium",
    profileDir,
    profileRoot,
    async close() {
      try {
        await cdp.send("Browser.close");
      } catch (error) {
        /* noop */
      }
      cdp.close();
      try {
        child.kill();
      } catch (error) {
        /* noop */
      }
      await sleep(300);
      await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/* ------------------------------------------------------------------ */
/* Page (CDP session)                                                  */
/* ------------------------------------------------------------------ */

const SCREEN_DETECT_JS = `(() => {
  const q = (selector) => document.querySelector(selector);
  if (q("#applyForm")) return "apply";
  if (q('[data-action="download-application"]')) return "success";
  if (q('[data-action="open-apply"]') || q("#promoCode") || q(".result-screen")) return "result";
  if (q('[data-action="select-character"]')) return "characters";
  if (q('[data-action="intro-next"]') || q('[data-action="intro-skip"]')) return "intro";
  if (q('[data-action="next-beat"]') || q('[data-action="next-step"]') || q(".game-screen") || q(".task-block") || q(".feedback-wrap")) return "game";
  if (q("#app") || q('[data-action="start-quest"]') || q('[data-action="resume-quest"]') || q(".landing")) return "landing";
  return "unknown";
})()`;

const TASK_KIND_JS = `(() => {
  const q = (selector) => document.querySelector(selector);
  if (q('[data-action="pick-option"]')) return "pick";
  if (q('[data-action="sort-item"]')) return "sort";
  if (q('[data-action="choice-option"]')) return "choice";
  if (q('[data-action="sample-option"]')) return "samples";
  if (q("#phRange") || q('[data-action="ph-adjust"]')) return "ph";
  if (q('[data-action="defect-bottle"]') || q("#conveyor") || q(".conveyor")) return "defect";
  return null;
})()`;

class Page {
  constructor(cdp, targetId, sessionId, options) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.options = options || {};
    this.consoleEntries = [];
    this.networkEntries = [];
    this.pageErrors = [];
    this.offline = false;
    this.downloadsDir = null;
    this.unsubscribers = [];
    this.navigating = false;
  }

  async init({ width, height, mobile = false, dpr = 1, ua = null, baseUrl }) {
    this.baseUrl = baseUrl;
    for (const domain of ["Page", "Runtime", "Log", "Network", "DOM"]) {
      await this.cdp.send(`${domain}.enable`, {}, this.sessionId).catch(() => {});
    }
    await this.cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, this.sessionId).catch(() => {});
    await this.setViewport({ width, height, mobile, dpr, ua });

    this.unsubscribers.push(
      this.cdp.on("Runtime.exceptionThrown", (params, sid) => {
        if (sid !== this.sessionId) return;
        const details = params.exceptionDetails || {};
        const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || "unknown exception";
        this.consoleEntries.push({ level: "exception", text: String(text).slice(0, 800), url: details.url || null, line: details.lineNumber });
      }),
      this.cdp.on("Runtime.consoleAPICalled", (params, sid) => {
        if (sid !== this.sessionId) return;
        const level = params.type;
        if (level !== "error" && level !== "warning" && level !== "assert") return;
        const text = (params.args || [])
          .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type))
          .join(" ");
        this.consoleEntries.push({ level, text: text.slice(0, 800), url: params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0] && params.stackTrace.callFrames[0].url });
      }),
      this.cdp.on("Log.entryAdded", (params, sid) => {
        if (sid !== this.sessionId) return;
        const entry = params.entry || {};
        if (entry.level !== "error" && entry.level !== "warning") return;
        if (entry.source === "network" && this.offline) return;
        this.consoleEntries.push({ level: entry.level, text: String(entry.text || "").slice(0, 800), url: entry.url || null, source: entry.source });
      }),
      this.cdp.on("Network.loadingFailed", (params, sid) => {
        if (sid !== this.sessionId) return;
        if (params.canceled) return;
        if (this.offline) return;
        this.networkEntries.push({
          kind: "failed",
          error: params.errorText,
          type: params.type,
          url: params.requestId,
          documentURL: params.documentURL || null
        });
      }),
      this.cdp.on("Network.responseReceived", (params, sid) => {
        if (sid !== this.sessionId) return;
        const response = params.response || {};
        if (response.status >= 400) {
          this.networkEntries.push({ kind: "http", status: response.status, url: response.url, type: params.type });
        }
      })
    );
    return this;
  }

  async setViewport({ width, height, mobile = false, dpr = 1, ua = null }) {
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: dpr, mobile, screenWidth: width, screenHeight: height },
      this.sessionId
    );
    await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 }, this.sessionId).catch(() => {});
    if (mobile) {
      await this.cdp.send(
        "Emulation.setUserAgentOverride",
        { userAgent: ua || MOBILE_UA, platform: "iPhone", acceptLanguage: "ru-RU,ru;q=0.9,en;q=0.8" },
        this.sessionId
      ).catch(() => {});
    } else {
      await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36", platform: "Win32", acceptLanguage: "ru-RU,ru;q=0.9,en;q=0.8" }, this.sessionId).catch(() => {});
    }
  }

  async eval(expression, { awaitPromise = true, timeout = 20000 } = {}) {
    const result = await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, userGesture: true, includeCommandLineAPI: false, timeout },
      this.sessionId
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || "evaluate error";
      throw new Error(`page evaluate failed: ${String(text).split("\n")[0]}`);
    }
    return result.result ? result.result.value : undefined;
  }

  async navigate(url, { timeout = 20000 } = {}) {
    this.navigating = true;
    try {
      await this.cdp.send("Page.navigate", { url }, this.sessionId);
      await waitUntil(
        async () => {
          try {
            return await this.eval("document.readyState === 'complete' || document.readyState === 'interactive'", { awaitPromise: false });
          } catch (error) {
            return false;
          }
        },
        { timeout, label: "navigate " + url }
      );
      await this.waitForSelector("body", { timeout: 5000 });
    } finally {
      this.navigating = false;
    }
  }

  async reload({ timeout = 20000 } = {}) {
    this.navigating = true;
    try {
      await this.cdp.send("Page.reload", { ignoreCache: false }, this.sessionId);
      await sleep(150);
      await waitUntil(
        async () => {
          try {
            return await this.eval("document.readyState === 'complete'", { awaitPromise: false });
          } catch (error) {
            return false;
          }
        },
        { timeout, interval: 200, label: "reload" }
      );
      await this.waitForSelector("body");
    } finally {
      this.navigating = false;
    }
  }

  async waitForSelector(selector, { timeout = 10000, visible = false } = {}) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { w: rect.width, h: rect.height, x: rect.left, y: rect.top, text: (el.textContent || "").trim().slice(0, 300), disabled: !!el.disabled };
    })()`;
    return waitUntil(
      async () => {
        try {
          const info = await this.eval(expression, { awaitPromise: false });
          if (!info) return null;
          if (visible && (info.w <= 0 || info.h <= 0)) return null;
          return info;
        } catch (error) {
          return null;
        }
      },
      { timeout, interval: 120, label: `selector ${selector}` }
    );
  }

  async exists(selector) {
    try {
      return await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`, { awaitPromise: false });
    } catch (error) {
      return false;
    }
  }

  async text(selector) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent || "").trim() : null; })()`, { awaitPromise: false });
  }

  async count(selector) {
    return this.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`, { awaitPromise: false });
  }

  async screen() {
    return this.eval(SCREEN_DETECT_JS, { awaitPromise: false });
  }

  async waitScreen(name, { timeout = 10000 } = {}) {
    return waitUntil(async () => {
      try {
        return (await this.screen()) === name ? true : null;
      } catch (error) {
        return null;
      }
    }, { timeout, interval: 120, label: `screen ${name}` });
  }

  async scrollIntoView(selector) {
    // Прокручиваем только окно, не внутренние overflow:hidden-контейнеры
    // (иначе scrollIntoView сдвигает контент чат-панели и ломает скриншот).
    return this.eval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const target = window.scrollY + rect.top - Math.max(12, (window.innerHeight - rect.height) / 2);
        window.scrollTo({ top: Math.max(0, target), left: 0, behavior: "instant" });
        return true;
      })()`,
      { awaitPromise: false }
    ).catch(() => false);
  }

  /**
   * Клик настоящей мышью по центру элемента (доверенное событие + фокус).
   * Если элемент перекрыт — фиксируем это в hit, но кликаем JS, чтобы сценарий
   * можно было продолжить и собрать остальные проверки.
   */
  async click(selector, { timeout = 10000, label = null, method = "mouse" } = {}) {
    await this.waitForSelector(selector, { timeout, visible: true });
    // Прокручиваем только если элемент вне viewport: scrollIntoView внутри
    // overflow:hidden-панели (чат) может незаметно сдвинуть её контент и
    // создать ложный «клиппинг» на скриншоте.
    const inViewport = await this.eval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= document.documentElement.clientWidth;
      })()`,
      { awaitPromise: false }
    );
    if (!inViewport) {
      await this.scrollIntoView(selector);
      await sleep(60);
    }
    const probe = await this.eval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        const contained = !!(top && (el === top || el.contains(top) || top.contains(el)));
        return { x, y, contained, width: rect.width, height: rect.height, tag: el.tagName.toLowerCase(), topTag: top ? top.tagName.toLowerCase() + "." + String(top.className || "").slice(0, 60) : null, disabled: !!el.disabled };
      })()`,
      { awaitPromise: false }
    );
    if (!probe) throw new Error("click: element vanished " + selector);
    let usedMethod = method;
    if (method === "mouse" && probe.contained) {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: probe.x, y: probe.y }, this.sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: probe.x, y: probe.y, button: "left", clickCount: 1 }, this.sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: probe.x, y: probe.y, button: "left", clickCount: 1 }, this.sessionId);
    } else {
      usedMethod = "js";
      await this.eval(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`,
        { awaitPromise: false }
      );
    }
    await sleep(90);
    return { probe, usedMethod, label: label || selector };
  }

  async hover(selector) {
    await this.scrollIntoView(selector);
    const rect = await this.eval(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      { awaitPromise: false }
    );
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y }, this.sessionId);
    await sleep(80);
  }

  async fill(selector, value, { blur = false } = {}) {
    const result = await this.eval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.focus();
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (${blur ? "true" : "false"}) el.blur();
        return el.value;
      })()`,
      { awaitPromise: false }
    );
    if (result === null) throw new Error("fill: no element " + selector);
    await sleep(40);
    return result;
  }

  async setChecked(selector, checked) {
    const current = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? !!el.checked : null; })()`,
      { awaitPromise: false }
    );
    if (current === null) throw new Error("setChecked: no element " + selector);
    if (current !== checked) {
      await this.scrollIntoView(selector);
      await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`, { awaitPromise: false });
    }
    await sleep(60);
    return checked;
  }

  async press(key, { modifiers = 0, text = undefined } = {}) {
    const map = {
      Enter: { code: "Enter", keyCode: 13, text: text !== undefined ? text : "\r" },
      Escape: { code: "Escape", keyCode: 27, text: undefined },
      Tab: { code: "Tab", keyCode: 9, text: undefined },
      " ": { code: "Space", keyCode: 32, text: " " },
      ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { code: "ArrowRight", keyCode: 39 },
      ArrowUp: { code: "ArrowUp", keyCode: 38 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 }
    };
    const info = map[key];
    if (!info) throw new Error("unsupported key " + key);
    const base = {
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
      modifiers
    };
    // Для клавиш без text (Tab/Escape/стрелки) Chromium ожидает rawKeyDown,
    // иначе не срабатывает нативный default action (например, смена фокуса по Tab).
    const downType = info.text === undefined ? "rawKeyDown" : "keyDown";
    await this.cdp.send("Input.dispatchKeyEvent", { ...base, type: downType, ...(info.text !== undefined ? { text: info.text } : {}) }, this.sessionId);
    await sleep(30);
    await this.cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, this.sessionId);
    await sleep(100);
  }

  async activeElement() {
    return this.eval(
      `(() => { const el = document.activeElement; if (!el) return null; return { tag: el.tagName.toLowerCase(), cls: String(el.className || ""), action: el.getAttribute && el.getAttribute("data-action"), id: el.id || null, name: el.getAttribute && el.getAttribute("name"), text: (el.textContent || "").trim().slice(0, 80) }; })()`,
      { awaitPromise: false }
    );
  }

  async setFileInput(selector, filePath) {
    const { root } = await this.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, this.sessionId);
    const { nodeId } = await this.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector }, this.sessionId);
    if (!nodeId) throw new Error("setFileInput: not found " + selector);
    await this.cdp.send("DOM.setFileInputFiles", { files: [filePath], nodeId }, this.sessionId);
    await sleep(120);
  }

  async configureDownloads(dir) {
    this.downloadsDir = dir;
    await mkdirp(dir);
    let method = "Browser";
    try {
      const params = { behavior: "allow", downloadPath: dir, eventsEnabled: true };
      if (this.options.browserContextId) params.browserContextId = this.options.browserContextId;
      await this.cdp.send("Browser.setDownloadBehavior", params);
    } catch (error) {
      method = "Page";
      try {
        await this.cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }, this.sessionId);
      } catch (fallbackError) {
        method = "none";
      }
    }
    this.downloadBehaviorMethod = method;
    log(`downloads: ${dir} (via ${method})`);
  }

  async waitForDownload({ timeout = 10000, existing = [] } = {}) {
    if (!this.downloadsDir) throw new Error("downloads not configured");
    const before = new Set(existing);
    return waitUntil(async () => {
      const files = await fsp.readdir(this.downloadsDir).catch(() => []);
      const fresh = files.filter((file) => !before.has(file) && !file.endsWith(".crdownload") && !file.endsWith(".tmp"));
      return fresh.length ? fresh : null;
    }, { timeout, interval: 200, label: "download file" });
  }

  async screenshot(fullPage = false) {
    let params = { format: "png", fromSurface: true, captureBeyondViewport: false };
    if (fullPage) {
      const metrics = await this.cdp.send("Page.getLayoutMetrics", {}, this.sessionId);
      const size = metrics.cssContentSize || metrics.contentSize || {};
      const width = Math.ceil(size.width || 1440);
      const height = Math.min(Math.ceil(size.height || 1000), 8000);
      params = {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 }
      };
    }
    const { data } = await this.cdp.send("Page.captureScreenshot", params, this.sessionId);
    return Buffer.from(data, "base64");
  }

  async setOffline(offline) {
    this.offline = offline;
    await this.cdp.send(
      "Network.emulateNetworkConditions",
      { offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1 },
      this.sessionId
    );
    await sleep(150);
  }

  async historyBack() {
    await this.eval("history.back()", { awaitPromise: false });
    await sleep(400);
  }

  async historyForward() {
    await this.eval("history.forward()", { awaitPromise: false });
    await sleep(400);
  }

  async getAppManifest() {
    return this.cdp.send("Page.getAppManifest", {}, this.sessionId);
  }

  async getInstallabilityErrors() {
    return this.cdp.send("Page.getInstallabilityErrors", {}, this.sessionId);
  }

  async fetchTexts(files) {
    return this.eval(
      `Promise.all(${JSON.stringify(files)}.map(async (file) => {
        try {
          const response = await fetch(file, { cache: "no-store" });
          return { file, status: response.status, text: await response.text() };
        } catch (error) {
          return { file, status: 0, error: String(error) };
        }
      }))`,
      { awaitPromise: true }
    );
  }

  async setReducedMotion(reduce) {
    await this.cdp.send(
      "Emulation.setEmulatedMedia",
      { media: "screen", features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] },
      this.sessionId
    ).catch(() => {});
    await sleep(250);
    return this.eval(`matchMedia("(prefers-reduced-motion: reduce)").matches`, { awaitPromise: false });
  }

  async emulateDisplayMode(mode) {
    if (!mode) {
      await this.cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] }, this.sessionId).catch(() => {});
      return;
    }
    try {
      await this.cdp.send(
        "Emulation.setEmulatedMedia",
        { media: "screen", features: [{ name: "display-mode", value: mode }, { name: "prefers-color-scheme", value: "light" }] },
        this.sessionId
      );
    } catch (error) {
      log("Emulation.setEmulatedMedia(display-mode) failed: " + error.message);
    }
    await sleep(200);
    const applied = await this.eval(
      `({ standalone: matchMedia("(display-mode: standalone)").matches, browser: matchMedia("(display-mode: browser)").matches })`,
      { awaitPromise: false }
    ).catch(() => null);
    this.lastDisplayModeEmulation = applied;
    return applied;
  }

  async storage() {
    return this.eval(
      `(() => {
        const out = { keys: [], state: null, stateKey: null };
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          out.keys.push(key);
          if (/brodilka/i.test(key)) {
            out.stateKey = key;
            try { out.state = JSON.parse(localStorage.getItem(key)); }
            catch (error) { out.state = { parseError: String(error) }; }
          }
        }
        return out;
      })()`
    );
  }

  async horizontalScroll() {
    return this.eval(
      `(() => {
        const doc = document.documentElement;
        const body = document.body;
        const viewport = doc.clientWidth;
        const scrollWidth = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0);
        const htmlOverflowX = getComputedStyle(doc).overflowX;
        const bodyOverflowX = body ? getComputedStyle(body).overflowX : "";
        const hiddenOverflow = htmlOverflowX === "hidden" || htmlOverflowX === "clip" || bodyOverflowX === "hidden" || bodyOverflowX === "clip";
        const beforeX = window.scrollX;
        window.scrollTo({ left: 99999, top: window.scrollY, behavior: "instant" });
        const maxX = window.scrollX;
        window.scrollTo({ left: beforeX, top: window.scrollY, behavior: "instant" });
        const hasOverflow = scrollWidth > viewport + 1;
        const offenders = [];
        if (hasOverflow) {
          document.querySelectorAll("body *").forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && (rect.right > viewport + 1 || rect.left < -1)) {
              const style = getComputedStyle(el);
              offenders.push({
                tag: el.tagName.toLowerCase(),
                cls: String(el.className || "").slice(0, 70),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                width: Math.round(rect.width),
                position: style.position,
                overflowX: style.overflowX
              });
            }
          });
        }
        return {
          canScrollX: maxX > 0,
          hasOverflow,
          hiddenOverflow,
          visibleOverflow: hasOverflow && !hiddenOverflow,
          maxScrollX: Math.round(maxX),
          viewport,
          scrollWidth,
          htmlOverflowX,
          bodyOverflowX,
          offenders: offenders.slice(0, 8)
        };
      })()`,
      { awaitPromise: false }
    );
  }

  async imagesLoaded() {
    return this.eval(
      `(() => {
        const images = Array.from(document.images);
        const broken = images.filter((img) => img.complete && img.naturalWidth === 0).map((img) => ({ src: img.currentSrc || img.src, alt: img.alt }));
        return { total: images.length, broken };
      })()`,
      { awaitPromise: false }
    );
  }

  async tapTargets() {
    return this.eval(
      `(() => {
        const nodes = Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]'));
        const small = [];
        for (const el of nodes) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.width < 24 || rect.height < 24) {
            small.push({ tag: el.tagName.toLowerCase(), action: el.getAttribute("data-action"), cls: String(el.className || "").slice(0, 60), w: Math.round(rect.width), h: Math.round(rect.height), text: (el.textContent || "").trim().slice(0, 40) });
          }
        }
        return small.slice(0, 20);
      })()`,
      { awaitPromise: false }
    );
  }

  getConsoleErrors({ includeWarnings = false } = {}) {
    return this.consoleEntries.filter((entry) => entry.level === "exception" || entry.level === "error" || (includeWarnings && entry.level === "warning"));
  }

  resetConsole() {
    this.consoleEntries = [];
    this.networkEntries = [];
  }
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

class Report {
  constructor(runDir) {
    this.runDir = runDir;
    this.scenario = null;
    this.scenarios = [];
    this.shotCounter = 0;
    this.env = {};
    this.startedAt = new Date().toISOString();
  }

  begin(id, title, viewport) {
    this.scenario = { id, title, viewport, startedAt: new Date().toISOString(), checks: [], screenshots: [], notes: [], fatal: null };
    this.shotCounter = 0;
    this.scenarios.push(this.scenario);
    log(`\n=== ${id} — ${title} (${viewport.width}×${viewport.height}${viewport.mobile ? ", mobile" : ""}) ===`);
  }

  check(id, ok, details = null) {
    const entry = { id, status: ok ? "pass" : "fail", details };
    this.scenario.checks.push(entry);
    if (ok) log(`  ✓ ${id}`);
    else warn(`  ✗ ${id}`, details === null || details === undefined ? "" : JSON.stringify(details).slice(0, 700));
    return ok;
  }

  warnCheck(id, details = null) {
    this.scenario.checks.push({ id, status: "warn", details });
    warn(`  ~ ${id}`, details === null || details === undefined ? "" : JSON.stringify(details).slice(0, 700));
  }

  skip(id, reason) {
    this.scenario.checks.push({ id, status: "skip", details: reason });
    log(`  - ${id} (skip: ${reason})`);
  }

  note(text) {
    this.scenario.notes.push(text);
    log("  · " + text);
  }

  fatal(error) {
    this.scenario.fatal = String((error && error.stack) || error);
    warn("  FATAL", String((error && error.message) || error));
  }

  async shot(page, name, { fullPage = false } = {}) {
    this.shotCounter += 1;
    const dir = path.join(this.runDir, this.scenario.id);
    await mkdirp(dir);
    const file = path.join(dir, `${String(this.shotCounter).padStart(2, "0")}-${safeName(name)}.png`);
    const buffer = await page.screenshot(fullPage);
    await fsp.writeFile(file, buffer);
    const relative = path.relative(QA_DIR, file).split(path.sep).join("/");
    this.scenario.screenshots.push(relative);
    log(`  📸 ${relative}`);
    return relative;
  }

  summary() {
    const checks = this.scenarios.reduce((acc, scenario) => acc.concat(scenario.checks), []);
    const failed = checks.filter((check) => check.status === "fail");
    const warned = checks.filter((check) => check.status === "warn");
    const skipped = checks.filter((check) => check.status === "skip");
    return {
      scenarios: this.scenarios.length,
      checks: checks.length,
      passed: checks.filter((check) => check.status === "pass").length,
      failed: failed.length,
      warned: warned.length,
      skipped: skipped.length,
      fatal: this.scenarios.filter((scenario) => scenario.fatal).length,
      failures: failed
    };
  }

  toJSON() {
    return {
      runId: RUN_ID,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      env: this.env,
      summary: this.summary(),
      scenarios: this.scenarios
    };
  }
}

/* ------------------------------------------------------------------ */
/* game driver                                                         */
/* ------------------------------------------------------------------ */

class GameDriver {
  constructor(page, report) {
    this.page = page;
    this.report = report;
    this.data = null;
  }

  async loadData() {
    this.data = await this.page.eval(
      "window.BRODILKA_DATA ? JSON.parse(JSON.stringify(window.BRODILKA_DATA)) : null",
      { awaitPromise: false }
    );
    return this.data;
  }

  characters() {
    return (this.data && this.data.characters) || [];
  }

  character(charId) {
    return this.characters().find((char) => char.id === charId) || null;
  }

  async dismissModalIfOpen() {
    if (await this.page.exists('[data-action="modal-confirm"]')) {
      await this.page.click('[data-action="modal-confirm"]');
      await sleep(200);
      return true;
    }
    return false;
  }

  async skipIntroIfNeeded() {
    if (await this.page.exists('[data-action="intro-skip"]')) {
      await this.page.click('[data-action="intro-skip"]');
      await this.page.waitScreen("characters");
    }
  }

  async goToCharacters() {
    let screen = await this.page.screen();
    if (screen === "result" || screen === "apply" || screen === "success") {
      const selector = (await this.page.exists('[data-action="go-characters"]'))
        ? '[data-action="go-characters"]'
        : '[data-action="home"]';
      await this.page.click(selector);
      await sleep(300);
      screen = await this.page.screen();
    }
    if (screen === "landing") {
      const selector = (await this.page.exists('[data-action="start-quest"]'))
        ? '[data-action="start-quest"]'
        : '[data-action="resume-quest"]';
      await this.page.click(selector);
      await sleep(250);
    }
    await this.skipIntroIfNeeded();
    if ((await this.page.screen()) === "game") {
      // активная смена: назад на карту
      if (await this.page.exists('[data-action="game-back"]')) {
        await this.page.click('[data-action="game-back"]');
        await sleep(200);
      }
    }
    await this.page.waitScreen("characters");
  }

  async selectCharacter(charId) {
    await this.goToCharacters();
    await sleep(350); // даём экрану выбора героя завершить screen-in анимацию
    const selector = `[data-action="select-character"][data-char="${charId}"]`;
    const fallback = `[data-action="select-character"]`;
    const usedSelector = (await this.page.exists(selector)) ? selector : fallback;
    const clickInfo = await this.page.click(usedSelector);
    await sleep(250);
    await this.dismissModalIfOpen();
    if ((await this.page.screen()) !== "game") {
      // повторный программный клик: диагностика «первый тап не сработал»
      const jsClicked = await this.page.eval(
        `(() => { const el = document.querySelector(${JSON.stringify(usedSelector)}); if (!el) return false; el.click(); return true; })()`,
        { awaitPromise: false }
      ).catch(() => false);
      if (jsClicked) {
        await sleep(450);
        if ((await this.page.screen()) === "game") {
          this.report.warnCheck(`select-character-retry.${charId}`, { usedSelector, clickInfo, note: "первый mouse-клик не открыл игру; помог JS-клик" });
        }
      }
    }
    if ((await this.page.screen()) !== "game") {
      try {
        await this.page.waitScreen("game", { timeout: 8000 });
      } catch (error) {
        const diagnostics = await this.page.eval(
          `(() => ({
            screen: window.__qaScreen || null,
            classes: Array.from(document.querySelectorAll('#app > .screen')).map((el) => String(el.className)),
            modal: !!document.querySelector('.modal-card, #modalRoot .modal-card'),
            active: document.activeElement ? { tag: document.activeElement.tagName, cls: String(document.activeElement.className || ''), action: document.activeElement.getAttribute && document.activeElement.getAttribute('data-action') } : null,
            bodyLocked: document.body.classList.contains('is-locked'),
            clicks: window.__qaClickLog || null,
            storage: (() => { try { const raw = localStorage.getItem('ochakovo-brodilka-v1'); return raw ? JSON.parse(raw).activeQuest : null; } catch (e) { return 'err'; } })()
          }))()`,
          { awaitPromise: false }
        ).catch(() => null);
        throw new Error(`selectCharacter(${charId}) failed: ${JSON.stringify({ usedSelector, click: clickInfo, diagnostics, console: this.page.getConsoleErrors({ includeWarnings: true }).slice(-6) })}`);
      }
    }
    await sleep(150);
  }

  async advanceDialogueToTask() {
    let guard = 0;
    while (guard++ < 20) {
      if (!(await this.page.exists('[data-action="next-beat"]'))) return;
      await this.page.click('[data-action="next-beat"]');
      await sleep(180);
    }
    throw new Error("dialogue did not reach task");
  }

  async waitForTask() {
    return waitUntil(async () => {
      try {
        return (await this.page.eval(TASK_KIND_JS, { awaitPromise: false })) || null;
      } catch (error) {
        return null;
      }
    }, { timeout: 10000, interval: 120, label: "task widget" });
  }

  async waitForFeedback() {
    return waitUntil(async () => {
      try {
        return (await this.page.exists('[data-action="next-step"]')) ? true : null;
      } catch (error) {
        return null;
      }
    }, { timeout: 10000, interval: 120, label: "feedback panel" });
  }

  async solvePick(task) {
    const correct = task.options.filter((option) => option.correct).map((option) => option.id);
    const required = task.required || correct.length;
    for (const id of correct.slice(0, required)) {
      const selector = `[data-action="pick-option"][data-id="${id}"]`;
      await this.page.click(selector);
      await sleep(80);
    }
    await this.page.click('[data-action="check-recipe"]');
    await sleep(250);
  }

  async solveSort(task) {
    for (const id of task.correct) {
      await this.page.click(`[data-action="sort-item"][data-id="${id}"]`);
      await sleep(160);
    }
  }

  async solveChoice(task) {
    const correct = task.options.find((option) => option.correct);
    if (!correct) throw new Error("choice: no correct option");
    await this.page.click(`[data-action="choice-option"][data-id="${correct.id}"]`);
    await sleep(250);
  }

  async solveSamples(task) {
    const correct = task.options.find((option) => option.correct);
    if (!correct) throw new Error("samples: no correct option");
    await this.page.click(`[data-action="sample-option"][data-id="${correct.id}"]`);
    await sleep(250);
  }

  async phValue() {
    const value = await this.page.eval(
      `(() => {
        const range = document.querySelector("#phRange");
        const valueEl = document.querySelector("#phValue");
        if (range) return { value: Number(range.value), min: Number(range.min), max: Number(range.max), step: Number(range.step) || 0.1 };
        if (valueEl) return { value: Number(String(valueEl.textContent).replace(",", ".")), min: null, max: null, step: 0.1 };
        return null;
      })()`,
      { awaitPromise: false }
    );
    return value;
  }

  async solvePh(task, { mistake = false } = {}) {
    if (mistake) {
      const current = await this.phValue();
      const target = task.target || [4.2, 4.6];
      if (current && current.value >= target[0] && current.value <= target[1]) {
        // специально уводим из нормы вниз
        let guard = 0;
        while (guard++ < 40) {
          const now = await this.phValue();
          if (!now || now.value < target[0] - 0.2) break;
          await this.page.click('[data-action="ph-adjust"][data-delta="-0.1"]');
          await sleep(50);
        }
      }
      await this.page.click('[data-action="ph-submit"]');
      await sleep(350);
    }
    const target = task.target || [4.2, 4.6];
    const goal = Number(((target[0] + target[1]) / 2).toFixed(1));
    let guard = 0;
    while (guard++ < 60) {
      const current = await this.phValue();
      if (!current) throw new Error("ph: widget not found");
      const diff = Number((goal - current.value).toFixed(1));
      if (Math.abs(diff) < 0.05) break;
      const delta = diff > 0 ? "0.1" : "-0.1";
      const selector = `[data-action="ph-adjust"][data-delta="${delta}"]`;
      if (!(await this.page.exists(selector))) {
        // fallback: прямой input
        await this.page.eval(
          `(() => { const r = document.querySelector("#phRange"); if (!r) return false; r.value = ${goal}; r.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
          { awaitPromise: false }
        );
        break;
      }
      await this.page.click(selector);
      await sleep(70);
    }
    await this.page.click('[data-action="ph-submit"]');
    await sleep(300);
  }

  async defectIndex() {
    return this.page.eval(
      `(() => {
        const selectors = [
          ".bottle.is-low", ".bottle.is-cap", ".bottle.is-label", ".bottle.is-defect",
          ".bottle[data-defect]", "[data-defect='true']", ".bottle.is-brak", ".bottle.is-wrong"
        ];
        for (const selector of selectors) {
          const bottle = document.querySelector(selector);
          if (!bottle) continue;
          const button = bottle.closest('[data-action="defect-bottle"]');
          if (button) return Number(button.getAttribute("data-index"));
        }
        const marked = document.querySelector('[data-action="defect-bottle"].is-defect, [data-action="defect-bottle"][data-defect]');
        if (marked) return Number(marked.getAttribute("data-index"));
        return null;
      })()`,
      { awaitPromise: false }
    );
  }

  async solveDefect(task) {
    const rounds = task.rounds || 3;
    for (let round = 0; round < rounds; round += 1) {
      const found = await waitUntil(
        async () => {
          try {
            const index = await this.defectIndex();
            // индекс 0 — валидный, поэтому возвращаем объект (waitUntil считает 0 ложью)
            return index === null || index === undefined ? null : { index };
          } catch (error) {
            return null;
          }
        },
        { timeout: 8000, interval: 90, label: "defect bottle" }
      ).catch(() => null);
      if (!found) {
        this.report.warnCheck("defect.selector", "Не удалось найти бутылку с дефектом по DOM-классам; пробую перебор");
        const clicked = await this.clickAnyDefectBottle();
        if (!clicked) throw new Error("defect: no bottles found");
      } else {
        await this.page.click(`[data-action="defect-bottle"][data-index="${found.index}"]`, { method: "js" });
      }
      // ждём следующий раунд или фидбек
      await sleep(950);
      if (await this.page.exists('[data-action="next-step"]')) return;
    }
  }

  async clickAnyDefectBottle() {
    const count = await this.page.count('[data-action="defect-bottle"]');
    for (let i = 0; i < count; i += 1) {
      const before = await this.page.text("#defectRound").catch(() => null);
      await this.page.click(`[data-action="defect-bottle"][data-index="${i}"]`, { method: "js" });
      await sleep(120);
      if (await this.page.exists('[data-action="next-step"]')) return true;
      const after = await this.page.text("#defectRound").catch(() => null);
      if (before !== after) return true;
    }
    return false;
  }

  async solveCurrentTask(task, { mistakeKind = null } = {}) {
    const kind = await this.waitForTask();
    if (!kind) throw new Error("task kind not detected");
    if (kind === "pick") await this.solvePick(task);
    else if (kind === "sort") await this.solveSort(task);
    else if (kind === "choice") await this.solveChoice(task);
    else if (kind === "samples") await this.solveSamples(task);
    else if (kind === "ph") await this.solvePh(task, { mistake: mistakeKind === "ph" });
    else if (kind === "defect") await this.solveDefect(task);
    else throw new Error("unknown task type " + kind);
    await this.waitForFeedback();
    return kind;
  }

  async completeRoute(charId, { mistakeKind = null, screenshotPrefix = null } = {}) {
    const char = this.character(charId);
    if (!char) throw new Error("unknown character " + charId);
    await this.selectCharacter(charId);
    await this.finishActiveRoute(char, { mistakeKind, screenshotPrefix });
  }

  /** Доигрывает активный маршрут с текущего экрана/этапа (без выбора героя). */
  async finishActiveRoute(char, { mistakeKind = null, screenshotPrefix = null } = {}) {
    for (let guard = 0; guard < 12; guard += 1) {
      const screen = await this.page.screen();
      if (screen === "result") return;
      if (screen !== "game") throw new Error("finishActiveRoute: unexpected screen " + screen);
      if (screenshotPrefix && guard === 0) await this.report.shot(this.page, `${screenshotPrefix}-game`);
      if (await this.page.exists('[data-action="next-beat"]')) {
        await this.advanceDialogueToTask();
      }
      if (await this.page.exists('[data-action="next-step"]')) {
        await this.page.click('[data-action="next-step"]');
        await sleep(300);
        continue;
      }
      const storage = await this.page.storage();
      const stepIndex = storage.state && storage.state.activeQuest ? storage.state.activeQuest.stepIndex : 0;
      const step = char.steps[stepIndex];
      if (!step) throw new Error("finishActiveRoute: no step " + stepIndex + " for " + char.id);
      const kind = await this.solveCurrentTask(step.task, { mistakeKind });
      if (screenshotPrefix && guard === 0) await this.report.shot(this.page, `${screenshotPrefix}-task-${kind}`);
      await this.waitForFeedback();
      await this.page.click('[data-action="next-step"]');
      await sleep(300);
    }
    throw new Error("finishActiveRoute: did not reach result");
  }

  async resultInfo() {
    return this.page.eval(
      `(() => {
        const codeEl = document.querySelector("#promoCode, .ticket-code, .promo-code");
        const text = document.body.innerText || "";
        const starsOn = document.querySelectorAll('.result-head-stars span:not(.off), .result-stars span:not(.off)').length;
        const starsOff = document.querySelectorAll('.result-head-stars span.off, .result-stars span.off').length;
        const ticket = document.querySelector(".ticket-code, #promoCode");
        return {
          code: codeEl ? codeEl.textContent.trim() : null,
          stars: starsOn,
          starsOff,
          hasResultScreen: !!document.querySelector(".result-screen") || !!document.querySelector('[data-action="open-apply"]'),
          bodyHasPrize: /балл/i.test(text) && /промокод/i.test(text),
          ticketVisible: ticket ? ticket.getBoundingClientRect().width > 0 : false
        };
      })()`,
      { awaitPromise: false }
    );
  }

  async formState() {
    return this.page.eval(
      `(() => {
        const errors = Array.from(document.querySelectorAll(".field.has-error")).map((field) => {
          const input = field.querySelector("input, textarea, select");
          const error = field.querySelector(".field-error");
          return { name: input ? input.name : null, error: error ? error.textContent.trim() : "" };
        });
        const general = document.querySelector("#formError");
        const consent = document.querySelector("#consentLabel");
        const active = document.activeElement;
        return {
          errors,
          generalError: general ? { text: general.textContent.trim(), visible: general.classList.contains("is-visible") } : null,
          consentError: consent ? consent.classList.contains("has-error") : null,
          active: active ? { tag: active.tagName.toLowerCase(), name: active.getAttribute && active.getAttribute("name"), id: active.id || null } : null,
          submitDisabled: (() => { const button = document.querySelector('#applyForm button[type="submit"]'); return button ? button.disabled : null; })()
        };
      })()`,
      { awaitPromise: false }
    );
  }

  async fillApplyForm({ name = "Иван Тестов", phone = "+7 999 123-45-67", email = "ivan@example.com", city = "Москва", link = "", consent = true, file = null, birthDate = "1996-05-14", education = "" } = {}) {
    await this.page.fill("#fieldName", name);
    if (await this.page.exists("#fieldBirthDate")) await this.page.fill("#fieldBirthDate", birthDate);
    await this.page.fill("#fieldPhone", phone);
    await this.page.fill("#fieldEmail", email);
    await this.page.fill("#fieldCity", city);
    if (education && (await this.page.exists("#fieldEducation"))) await this.page.fill("#fieldEducation", education);
    if (link) await this.page.fill("#fieldResumeLink", link);
    if (file) {
      await this.page.setFileInput("#fieldResume", file);
      await this.page.eval(
        `(() => { const input = document.querySelector("#fieldResume"); input.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
        { awaitPromise: false }
      );
      await sleep(150);
    }
    if (consent) await this.page.setChecked('input[name="consent"]', true);
  }

  async submitApplyForm() {
    await this.page.scrollIntoView('#applyForm button[type="submit"]');
    await this.page.click('#applyForm button[type="submit"]');
    await sleep(300);
  }

  async openApplyFromResult() {
    await this.page.click('[data-action="open-apply"]');
    await this.page.waitScreen("apply");
    await sleep(200);
  }

  async reloadAndGetLandingCta() {
    await this.page.reload();
    await this.page.waitScreen("landing");
    await sleep(400);
    const cta = await this.page.eval(
      `(() => { const buttons = Array.from(document.querySelectorAll('[data-action="start-quest"], [data-action="resume-quest"]')); return buttons.map((button) => ({ action: button.getAttribute("data-action"), text: (button.textContent || "").trim() })); })()`,
      { awaitPromise: false }
    );
    return cta;
  }
}

/* ------------------------------------------------------------------ */
/* checks                                                              */
/* ------------------------------------------------------------------ */

async function checkLayout(page, report, tag, { screenshot = true, fullPage = false, mobile = false } = {}) {
  await sleep(220);
  if (fullPage) await sleep(350); // даём экранной анимации завершиться, иначе fullPage-скрин может поймать пустой кадр
  const info = await page.horizontalScroll();
  const failed = info.visibleOverflow || (info.canScrollX && !info.hiddenOverflow);
  report.check(`${tag}.no-horizontal-scroll`, !failed, failed ? info : undefined);
  if (screenshot) await report.shot(page, tag, { fullPage });
  if (mobile) {
    const small = await page.tapTargets();
    if (small.length) report.warnCheck(`${tag}.tap-targets-small`, small);
    else report.check(`${tag}.tap-targets`, true);
  }
  return info;
}

async function checkConsole(page, report, tag, { allow = [] } = {}) {
  await sleep(200);
  const warnings = page.getConsoleErrors({ includeWarnings: true }).filter((entry) => entry.level === "warning");
  if (warnings.length) report.note(`${tag}: предупреждения в консоли: ` + JSON.stringify(warnings.slice(0, 3)));
  const errors = page.getConsoleErrors().filter((entry) => {
    const text = (entry.text || "") + " " + (entry.url || "");
    return !allow.some((pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)));
  });
  report.check(`${tag}.console-clean`, errors.length === 0, errors.length ? errors : undefined);
}

async function checkNetwork(page, report, tag, { allow = [] } = {}) {
  const failures = page.networkEntries.filter((entry) => {
    const text = (entry.url || "") + " " + (entry.error || "") + " " + (entry.documentURL || "");
    return !allow.some((pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)));
  });
  report.check(`${tag}.network-clean`, failures.length === 0, failures.length ? failures : undefined);
}

async function checkImages(page, report, tag) {
  await sleep(300);
  const images = await page.imagesLoaded();
  report.check(`${tag}.images-loaded`, images.broken.length === 0, images.broken.length ? images : undefined);
}

const CONTENT_RULES = [
  { id: "beer", label: "пиво/пивовар", re: /пив/i, severity: "fail" },
  { id: "18plus", label: "18+", re: /18\s*\+/, severity: "fail" },
  { id: "hops", label: "хмель", re: /хмел/i, severity: "fail" },
  { id: "beer-en", label: "beer/alcohol (en)", re: /\b(beer|brewery|alcohol)\b/i, severity: "fail" },
  { id: "zero-percent", label: "0% (возрастной маркер)", re: /(?<!\d)0\s*%/, severity: "fail" },
  { id: "non-alcoholic-label", label: "безалкогольные (возрастной маркер)", re: /безалкогольн/i, severity: "fail" },
  { id: "alcohol", label: "алкоголь (кроме «безалкогольный»)", re: /(?<!без)алкогол/i, severity: "warn" }
];

function scanContent(text) {
  const hits = [];
  for (const rule of CONTENT_RULES) {
    const matches = String(text || "").match(rule.re);
    if (matches) hits.push({ rule: rule.id, label: rule.label, severity: rule.severity, samples: [...new Set(matches)].slice(0, 5) });
  }
  return hits;
}

async function auditCta(page, report, selector, tag, { minHeight = 44 } = {}) {
  const count = await page.count(selector);
  if (!count) {
    report.check(`${tag}.cta-present`, false, selector);
    return [];
  }
  const results = [];
  const countProbe = Math.min(count, 4);
  for (let index = 0; index < countProbe; index += 1) {
    const info = await page.eval(
      `(() => {
        const elements = document.querySelectorAll(${JSON.stringify(selector)});
        const element = elements[${index}];
        if (!element) return null;
        const preRect = element.getBoundingClientRect();
        window.scrollTo({ top: Math.max(0, window.scrollY + preRect.top - Math.max(12, (window.innerHeight - preRect.height) / 2)), left: 0, behavior: "instant" });
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const hit = !!(top && (element === top || element.contains(top) || top.contains(element)));
        return {
          text: (element.textContent || "").trim().slice(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          viewportWidth,
          viewportHeight,
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
          fitsX: rect.left >= -1 && rect.right <= viewportWidth + 1,
          inViewportY: rect.top >= -1 && rect.bottom <= viewportHeight + 1,
          hit
        };
      })()`,
      { awaitPromise: false }
    );
    if (info) results.push(info);
  }
  const broken = results.filter((info) => !info.visible || !info.fitsX || !info.inViewportY || !info.hit);
  report.check(`${tag}.cta-visible`, broken.length === 0, broken.length ? broken : results);
  const cramped = results.filter((info) => info.height < minHeight);
  if (cramped.length) report.warnCheck(`${tag}.cta-tap-height`, cramped);
  return results;
}

async function readTouchTargets(page, selectors) {
  return page.eval(
    `(() => {
      const specs = ${JSON.stringify(selectors)};
      return specs.map((spec) => {
        const element = document.querySelector(spec.selector);
        if (!element) return { name: spec.name, missing: true };
        const preRect = element.getBoundingClientRect();
        window.scrollTo({ top: Math.max(0, window.scrollY + preRect.top - Math.max(12, (window.innerHeight - preRect.height) / 2)), left: 0, behavior: "instant" });
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const top = document.elementFromPoint(cx, cy);
        return {
          name: spec.name,
          selector: spec.selector,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          minHeight: style.minHeight,
          display: style.display,
          hit: !!(top && (element === top || element.contains(top) || top.contains(element))),
          inViewport: rect.top >= -1 && rect.bottom <= window.innerHeight + 1 && rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1
        };
      });
    })()`,
    { awaitPromise: false }
  );
}

function checkTouchTarget(report, tag, target, { minSize = 44, strict = true } = {}) {
  if (!target || target.missing) {
    report.check(`${tag}.present`, false, target || null);
    return;
  }
  if (target.width >= minSize && target.height >= minSize) {
    report.check(`${tag}.size`, true, target);
  } else if (!strict && target.width >= 24 && target.height >= 24) {
    // не P2-пара из final.md: 24–43 px — проходит WCAG 2.5.8 (24), но ниже Apple HIG (44)
    report.warnCheck(`${tag}.size`, target);
  } else {
    report.check(`${tag}.size`, false, target);
  }
  report.check(`${tag}.hit-not-overlapped`, target.hit === true, target);
  report.check(`${tag}.in-viewport`, target.inViewport === true, target);
}

async function checkHeaderOverlap(page, report, tag) {
  const info = await page.eval(
    `(() => {
      const brand = document.querySelector(".brand");
      const sound = document.querySelector("#soundToggle");
      const status = document.querySelector("#headStatus");
      const header = document.querySelector(".site-head");
      if (!brand) return null;
      const toRect = (el) => (el ? el.getBoundingClientRect() : null);
      const intersects = (a, b) => !!(a && b && a.width > 0 && b.width > 0 && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1);
      const brandRect = toRect(brand);
      const soundRect = toRect(sound);
      const statusRect = toRect(status);
      const headerRect = toRect(header);
      return {
        brandVsSound: intersects(brandRect, soundRect),
        brandVsStatus: intersects(brandRect, statusRect),
        soundVsStatus: intersects(soundRect, statusRect),
        brandInsideHeader: !headerRect || (brandRect.top >= headerRect.top - 1 && brandRect.bottom <= headerRect.bottom + 1),
        headerRect: headerRect ? { top: Math.round(headerRect.top), bottom: Math.round(headerRect.bottom), height: Math.round(headerRect.height) } : null,
        brandRect: brandRect ? { top: Math.round(brandRect.top), bottom: Math.round(brandRect.bottom), height: Math.round(brandRect.height) } : null
      };
    })()`,
    { awaitPromise: false }
  );
  if (!info) {
    report.check(`${tag}.header-present`, false);
    return;
  }
  report.check(`${tag}.header-no-overlap`, !info.brandVsSound && !info.brandVsStatus && !info.soundVsStatus, info);
  report.check(`${tag}.brand-inside-header`, info.brandInsideHeader, info);
}

async function checkConfettiBehindContent(page, report, tag) {
  const info = await page.eval(
    `(() => {
      const confetti = document.querySelector('.result-screen .confetti, .confetti');
      const content = document.querySelector('.result-wrap, .result-screen > .result-wrap');
      const title = document.querySelector('.result-title, .result-head h1, .result-screen h1');
      const ticket = document.querySelector('.reward-ticket');
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
      const z = (el) => (el ? Number(getComputedStyle(el).zIndex) || 0 : null);
      const covered = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !(top && (el === top || el.contains(top) || top.contains(el)));
      };
      return {
        present: !!confetti,
        count: confetti ? confetti.querySelectorAll('i').length : 0,
        position: confetti ? getComputedStyle(confetti).position : null,
        pointerEvents: confetti ? getComputedStyle(confetti).pointerEvents : null,
        confettiZ: z(confetti),
        contentZ: z(content),
        contentPosition: content ? getComputedStyle(content).position : null,
        titleCovered: covered(title),
        ticketCovered: covered(ticket),
        titleRect: rect(title),
        ticketRect: rect(ticket)
      };
    })()`,
    { awaitPromise: false }
  );
  report.check(`${tag}.confetti-present`, !!info.present && info.count > 10, info);
  report.check(`${tag}.confetti-in-background`, info.pointerEvents === "none" && info.confettiZ !== null && info.contentZ !== null && info.confettiZ < info.contentZ, info);
  report.check(`${tag}.confetti-no-text-cover`, info.titleCovered === false, info);
  report.check(`${tag}.confetti-no-card-cover`, info.ticketCovered === false, info);
  return info;
}

async function checkDialogueAlignment(page, report, tag) {
  const alignment = await page.eval(
    `(() => {
      const title = document.querySelector(".quest-title");
      const text = document.querySelector(".chat-panel, .quest-text");
      if (!title || !text) return null;
      const titleRect = title.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      return {
        title: { left: Math.round(titleRect.left), bottom: Math.round(titleRect.bottom), height: Math.round(titleRect.height) },
        text: { left: Math.round(textRect.left), top: Math.round(textRect.top), height: Math.round(textRect.height) },
        gap: Math.round(textRect.top - titleRect.bottom),
        leftDelta: Math.round(textRect.left - titleRect.left)
      };
    })()`,
    { awaitPromise: false }
  );
  if (!alignment) {
    report.skip(`${tag}.dialogue-alignment`, "нет .quest-title/.chat-panel");
    return;
  }
  report.check(`${tag}.dialogue-alignment`, alignment.gap >= 0 && alignment.gap <= 80, alignment);
}

/* ------------------------------------------------------------------ */
/* scenarios                                                           */
/* ------------------------------------------------------------------ */

const VIEWPORTS = {
  "desktop": { id: "desktop", width: 1440, height: 1000, dpr: 1, mobile: false },
  "mobile": { id: "mobile", width: 390, height: 844, dpr: 3, mobile: true },
  "compact": { id: "compact", width: 360, height: 740, dpr: 3, mobile: true },
  "landscape": { id: "landscape", width: 844, height: 390, dpr: 3, mobile: true }
};

async function surveyScenario(page, report, driver, { viewportKey, screenshotTag }) {
  const errorsBefore = page.getConsoleErrors().length;
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");

  const landing = await page.eval(
    `(() => ({
      title: document.title,
      h1: (document.querySelector("h1") || {}).innerText || "",
      cta: Array.from(document.querySelectorAll('[data-action="start-quest"], [data-action="resume-quest"]')).map((button) => ({ action: button.getAttribute("data-action"), text: button.textContent.trim() })),
      prize: /балл|приз|промокод/i.test(document.body.innerText || ""),
      footerReset: !!document.querySelector('[data-action="reset-progress"]')
    }))()`,
    { awaitPromise: false }
  );
  report.check("landing.title", /БРОДИЛКА/i.test(landing.title), landing.title);
  report.check("landing.h1", landing.h1.trim().length > 0, landing.h1);
  report.check("landing.cta", landing.cta.length > 0, landing.cta);
  report.check("landing.prize-copy", landing.prize);
  report.check("landing.footer-reset", landing.footerReset);
  await checkImages(page, report, "landing");
  await checkLayout(page, report, `${screenshotTag}-landing`, { mobile: viewportKey !== "desktop" });

  // intro
  const startSelector = (await page.exists('[data-action="start-quest"]')) ? '[data-action="start-quest"]' : '[data-action="resume-quest"]';
  await page.click(startSelector);
  await sleep(350);
  const screenAfterStart = await page.screen();
  if (screenAfterStart === "intro") {
    const intro = await page.eval(
      `(() => ({
        hasNext: !!document.querySelector('[data-action="intro-next"]'),
        hasSkip: !!document.querySelector('[data-action="intro-skip"]'),
        counter: (document.querySelector(".intro-counter") || {}).innerText || "",
        textLength: ((document.querySelector(".dialogue-text") || {}).textContent || "").trim().length
      }))()`,
      { awaitPromise: false }
    );
    report.check("intro.controls", intro.hasNext && intro.hasSkip, intro);
    report.check("intro.text", intro.textLength > 10, intro.textLength);
    await checkLayout(page, report, `${screenshotTag}-intro`, { mobile: viewportKey !== "desktop" });
    // шаг вперёд кнопкой
    await page.click('[data-action="intro-next"]');
    await sleep(250);
    const counterAfter = await page.text(".intro-counter");
    report.check("intro.next-works", counterAfter !== intro.counter, { before: intro.counter, after: counterAfter });
    // skip
    await page.click('[data-action="intro-skip"]');
    await page.waitScreen("characters");
  } else if (screenAfterStart === "characters" || screenAfterStart === "game") {
    report.note("Интро ранее пропущено (introSeen=true), сразу выбор героя");
    if (screenAfterStart === "game") {
      await page.click('[data-action="game-back"]');
      await page.waitScreen("characters");
    }
  }

  await page.waitScreen("characters");
  const chars = await page.eval(
    `(() => ({
      count: document.querySelectorAll('[data-action="select-character"]').length,
      names: Array.from(document.querySelectorAll(".char-name h3")).map((el) => el.textContent.trim()),
      home: !!document.querySelector('[data-action="home"]')
    }))()`,
    { awaitPromise: false }
  );
  report.check("characters.cards", chars.count === 3, chars);
  await checkLayout(page, report, `${screenshotTag}-characters`, { mobile: viewportKey !== "desktop" });

  // первый герой: диалог и первое задание
  const firstChar = driver.characters()[0];
  if (firstChar) {
    await driver.selectCharacter(firstChar.id);
    await checkLayout(page, report, `${screenshotTag}-game-dialogue`, { mobile: viewportKey !== "desktop" });
    if (viewportKey === "desktop") await checkDialogueAlignment(page, report, screenshotTag);
    await driver.advanceDialogueToTask();
    const kind = await driver.waitForTask();
    report.check("game.first-task-visible", !!kind, { kind });
    await checkLayout(page, report, `${screenshotTag}-game-task`, { mobile: viewportKey !== "desktop" });
  }

  await checkImages(page, report, `${screenshotTag}-images`);
  const errors = page.getConsoleErrors().slice(errorsBefore);
  report.check(`${screenshotTag}.console-clean`, errors.length === 0, errors.length ? errors : undefined);
  const network = page.networkEntries.filter((entry) => entry.kind === "http" || entry.kind === "failed");
  report.check(`${screenshotTag}.network-clean`, network.length === 0, network.length ? network : undefined);
}

async function desktopFullScenario(page, report, driver) {
  await page.configureDownloads(DOWNLOADS_DIR);
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");

  const characters = driver.characters();
  if (characters.length < 3) throw new Error("BRODILKA_DATA.characters < 3");
  const brewer = characters[0];

  await page.click('[data-action="start-quest"]');
  await sleep(250);
  if (await page.screen() === "intro") {
    let guard = 0;
    while ((await page.screen()) === "intro" && guard++ < 10) {
      await page.click('[data-action="intro-next"]');
      await sleep(250);
    }
  }
  await page.waitScreen("characters");
  await report.shot(page, "characters");

  // полный маршрут героя №1 без ошибок
  await driver.completeRoute(brewer.id, { screenshotPrefix: "route" });
  const result = await driver.resultInfo();
  report.check("result.screen", result.hasResultScreen);
  report.check("result.promo-code", !!result.code && result.code.length >= 4, result.code);
  report.check("result.promo-format", /^[A-Z0-9-]+$/i.test(result.code || ""), result.code);
  report.check("result.stars-3", result.stars === 3, { on: result.stars, off: result.starsOff });
  report.check("result.prize-copy", result.bodyHasPrize);
  await checkLayout(page, report, "result", { fullPage: true });
  await checkConfettiBehindContent(page, report, "result");

  // копирование промокода
  await page.click('[data-action="copy-code"]');
  await sleep(400);
  const toast = await page.eval(
    `(() => { const toast = document.querySelector("#toast, .toast"); return toast ? { text: toast.textContent.trim(), visible: toast.classList.contains("is-visible") || getComputedStyle(toast).opacity !== "0" } : null; })()`,
    { awaitPromise: false }
  );
  report.check("result.copy-feedback", !!toast && toast.text.length > 0, toast);

  // форма отклика
  await driver.openApplyFromResult();
  await checkLayout(page, report, "apply-empty", { fullPage: false });

  // 1) пустая отправка
  await driver.submitApplyForm();
  await sleep(300);
  let form = await driver.formState();
  report.check("form.empty-errors", form.errors.length >= 4, form);
  report.check("form.empty-consent-error", form.consentError === true || (form.generalError && form.generalError.visible), form);
  report.check("form.empty-focus", !!form.active && (form.active.name === "name" || form.active.id === "fieldName"), form.active);
  await report.shot(page, "form-empty-errors");

  // Tab из первого невалидного поля ведёт в следующее поле (ФИО → дата рождения)
  await page.press("Tab");
  const tabbed = await page.activeElement();
  report.check("form.tab-order", !!tabbed && (tabbed.name === "birthDate" || tabbed.id === "fieldBirthDate" || tabbed.name === "phone" || tabbed.id === "fieldPhone"), tabbed);

  // 2) невалидные значения
  await driver.fillApplyForm({ name: "A", birthDate: "2999-01-01", phone: "123", email: "bad", city: "", link: "not-a-url", consent: false });
  await driver.submitApplyForm();
  await sleep(300);
  form = await driver.formState();
  const errorNames = form.errors.map((entry) => entry.name);
  report.check("form.invalid-name", errorNames.includes("name"), form.errors);
  report.check("form.invalid-birthdate", errorNames.includes("birthDate"), form.errors);
  report.check("form.invalid-phone", errorNames.includes("phone"), form.errors);
  report.check("form.invalid-email", errorNames.includes("email"), form.errors);
  report.check("form.invalid-link", errorNames.includes("resumeLink"), form.errors);
  report.check("form.invalid-consent", form.consentError === true || (form.generalError && form.generalError.visible), form);
  await report.shot(page, "form-invalid-errors");

  // 3) валидная отправка
  await driver.fillApplyForm({ link: "https://hh.ru/resume/test", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 8000 });
  const success = await page.eval(
    `(() => ({
      ticket: (document.querySelector(".success-ticket b, .success-ticket") || {}).textContent || "",
      actions: Array.from(document.querySelectorAll(".success-actions [data-action], [data-action='download-application']")).map((el) => el.getAttribute("data-action")),
      body: (document.body.innerText || "").slice(0, 400)
    }))()`,
    { awaitPromise: false }
  );
  report.check("form.success-screen", true, success.ticket.trim());
  report.check("form.success-actions", success.actions.includes("download-application"), success.actions);
  const storageAfterApply = await page.storage();
  const applications = storageAfterApply.state && storageAfterApply.state.applications;
  report.check("form.application-saved", Array.isArray(applications) && applications.length >= 1, applications ? applications.length : null);
  await checkLayout(page, report, "success");

  // 4) скачивание заявки
  const existing = await fsp.readdir(DOWNLOADS_DIR).catch(() => []);
  await page.click('[data-action="download-application"]');
  await sleep(500);
  const downloadToast = await page.text("#toast");
  report.note("download toast: " + JSON.stringify(downloadToast));
  const files = await page.waitForDownload({ existing, timeout: 8000 }).catch(() => null);
  if (!files) {
    const allFiles = await fsp.readdir(DOWNLOADS_DIR).catch(() => []);
    report.note("download dir after click: " + JSON.stringify({ before: existing, after: allFiles }));
  }
  report.check("form.download-file", !!files, files);
  if (files && files.length) {
    const downloadPath = path.join(DOWNLOADS_DIR, files[0]);
    const buffer = await fsp.readFile(downloadPath).catch(() => Buffer.alloc(0));
    const pdf = inspectPdfBuffer(buffer, files[0]);
    report.check("form.download-pdf", pdf.isPdf && pdf.hasEof && pdf.pages === 1, pdf);
    report.check("form.download-filename", /ochakovo-zayavka-.+\.pdf$/i.test(files[0]), files[0]);
    report.check("form.download-not-txt", !/\.txt$/i.test(files[0]), files[0]);
  }

  // 5) reload: прогресс и заявки сохраняются
  await page.reload();
  await page.waitScreen("landing");
  await sleep(300);
  const storageAfterReload = await page.storage();
  const state = storageAfterReload.state || {};
  report.check("persistence.completed", !!(state.completed && state.completed[brewer.id]), Object.keys(state.completed || {}));
  report.check("persistence.application", Array.isArray(state.applications) && state.applications.length >= 1);
  const cta = await page.eval(
    `(() => Array.from(document.querySelectorAll('[data-action="start-quest"], [data-action="resume-quest"]')).map((button) => ({ action: button.getAttribute("data-action"), text: button.textContent.trim() })))()`,
    { awaitPromise: false }
  );
  report.check("persistence.cta-replay", cta.some((item) => /ещё раз|пройти/i.test(item.text) || item.action === "start-quest"), cta);
  await driver.goToCharacters();
  const charStatus = await page.eval(
    `(() => Array.from(document.querySelectorAll(".character-card, [data-action='select-character']")).map((card) => (card.textContent || "").trim().slice(0, 120)))()`,
    { awaitPromise: false }
  );
  report.check("persistence.character-done-status", /пройден|3\s*\/\s*3/i.test(charStatus.join(" ")), charStatus);

  // повторный проход не дублирует звёзды и промокод
  const stateBeforeReplay = await page.storage();
  const completionBefore = stateBeforeReplay.state && stateBeforeReplay.state.completed && stateBeforeReplay.state.completed[brewer.id];
  const applicationsBefore = (stateBeforeReplay.state && stateBeforeReplay.state.applications ? stateBeforeReplay.state.applications.length : 0);
  await driver.completeRoute(brewer.id);
  const replayResult = await driver.resultInfo();
  report.check("replay.stars-stable", replayResult.stars === 3, { on: replayResult.stars, off: replayResult.starsOff });
  const stateAfterReplay = await page.storage();
  const completionAfter = stateAfterReplay.state && stateAfterReplay.state.completed && stateAfterReplay.state.completed[brewer.id];
  report.check(
    "replay.code-unique",
    !!completionAfter && !!completionBefore && completionAfter.code !== completionBefore.code && String(completionAfter.code || "").length >= 6,
    { before: completionBefore && completionBefore.code, after: completionAfter && completionAfter.code }
  );
  report.check("replay.applications-stable", (stateAfterReplay.state.applications || []).length === applicationsBefore, { before: applicationsBefore, after: (stateAfterReplay.state.applications || []).length });
  report.check("replay.single-completion", Object.keys((stateAfterReplay.state && stateAfterReplay.state.completed) || {}).filter((id) => id === brewer.id).length === 1);
  await page.reload();
  await page.waitScreen("landing");
  await sleep(300);

  // 6) звук
  const soundBefore = await page.eval(`(() => ({ pressed: document.querySelector("#soundToggle").getAttribute("aria-pressed"), label: document.querySelector("#soundToggle").getAttribute("aria-label") }))()`, { awaitPromise: false });
  await page.click("#soundToggle");
  await sleep(200);
  const soundAfter = await page.eval(`(() => ({ pressed: document.querySelector("#soundToggle").getAttribute("aria-pressed"), label: document.querySelector("#soundToggle").getAttribute("aria-label") }))()`, { awaitPromise: false });
  report.check("sound.toggle-aria", soundBefore.pressed !== soundAfter.pressed, { before: soundBefore, after: soundAfter });
  await page.reload();
  await page.waitScreen("landing");
  const soundPersisted = await page.eval(`document.querySelector("#soundToggle").getAttribute("aria-pressed")`, { awaitPromise: false });
  report.check("sound.persisted", soundPersisted === soundAfter.pressed, { expected: soundAfter.pressed, actual: soundPersisted });

  // 7) сброс прогресса
  await page.eval(`document.querySelector('[data-action="reset-progress"]').scrollIntoView({ block: "center" })`, { awaitPromise: false });
  await page.click('[data-action="reset-progress"]');
  await sleep(250);
  report.check("reset.modal-open", await page.exists('[data-action="modal-confirm"]'));
  await report.shot(page, "reset-modal");
  await page.press("Escape");
  await sleep(250);
  report.check("reset.escape-closes", !(await page.exists('[data-action="modal-confirm"]')));
  const storageAfterCancel = await page.storage();
  report.check("reset.cancel-keeps-progress", !!(storageAfterCancel.state && storageAfterCancel.state.completed && storageAfterCancel.state.completed[brewer.id]));
  await page.click('[data-action="reset-progress"]');
  await sleep(250);
  await page.click('[data-action="modal-confirm"]');
  await sleep(400);
  const storageAfterReset = await page.storage();
  const resetState = storageAfterReset.state || {};
  report.check("reset.clears-completed", Object.keys(resetState.completed || {}).length === 0, resetState.completed);
  report.check("reset.clears-applications", (resetState.applications || []).length === 0, resetState.applications);
  await page.waitScreen("landing");
  const ctaAfterReset = await page.text('[data-action="start-quest"]');
  report.check("reset.cta-fresh", /начать/i.test(ctaAfterReset || ""), ctaAfterReset);
  await report.shot(page, "after-reset");

  // повреждённый localStorage не должен ронять приложение
  const storageKey = storageAfterReset.stateKey || "ochakovo-brodilka-v1";
  await page.eval(`localStorage.setItem(${JSON.stringify(storageKey)}, "{broken json")`, { awaitPromise: false });
  await page.reload();
  await page.waitScreen("landing", { timeout: 8000 }).catch(() => {});
  const recovered = await page.eval(
    `(() => ({ screenTitle: document.title, hasCta: !!document.querySelector('[data-action="start-quest"], [data-action="resume-quest"]'), body: (document.body.innerText || "").slice(0, 120) }))()`,
    { awaitPromise: false }
  );
  report.check("persistence.corrupted-storage-recovers", recovered.hasCta && recovered.body.length > 0, recovered);
  await page.eval(`localStorage.removeItem(${JSON.stringify(storageKey)})`, { awaitPromise: false });

  await checkConsole(page, report, "desktop-full");
}

async function mobileReloadScenario(page, report, driver) {
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  const characters = driver.characters();
  if (characters.length < 3) throw new Error("BRODILKA_DATA.characters < 3");
  const packer = characters[1];
  const lab = characters[2];

  // старт и сразу пропуск интро
  await page.click('[data-action="start-quest"]');
  await sleep(250);
  await driver.skipIntroIfNeeded();
  await page.waitScreen("characters");

  // маршрут 2: первый этап полностью
  await driver.selectCharacter(packer.id);
  await driver.advanceDialogueToTask();
  const packerStep = packer.steps[0];
  await driver.solveCurrentTask(packerStep.task);
  await page.click('[data-action="next-step"]');
  await sleep(350);
  // теперь мы на этапе 2 (dialogue) — reload
  const beforeReload = await page.storage();
  const activeBefore = beforeReload.state && beforeReload.state.activeQuest;
  report.check("reload.active-quest-saved", !!activeBefore && activeBefore.stepIndex === 1, activeBefore);
  await report.shot(page, "before-reload");

  await page.reload();
  await page.waitScreen("landing");
  await sleep(300);
  const cta = await page.eval(
    `(() => Array.from(document.querySelectorAll('[data-action="start-quest"], [data-action="resume-quest"]')).map((button) => ({ action: button.getAttribute("data-action"), text: button.textContent.trim() })))()`,
    { awaitPromise: false }
  );
  report.check("reload.resume-cta", cta.some((item) => item.action === "resume-quest" || /продолж/i.test(item.text)), cta);
  await checkLayout(page, report, "reload-landing", { mobile: true });
  await page.click('[data-action="resume-quest"]');
  await page.waitScreen("game");
  await sleep(300);
  const resumedStep = await page.eval(
    `(() => { const el = document.querySelector(".step-meta, .game-hud"); return el ? el.innerText : ""; })()`,
    { awaitPromise: false }
  );
  report.check("reload.resumed-step", /(^|\D)0?2\s*\/\s*0?3(\D|$)|этап\s*0?2/i.test(resumedStep), resumedStep.slice(0, 200));

  // смена героя при незавершённой смене → модалка, «Остаться» сохраняет прогресс
  await page.click('[data-action="game-back"]');
  await page.waitScreen("characters");
  await page.click(`[data-action="select-character"][data-char="${lab.id}"]`);
  await sleep(350);
  const switchModal = await page.eval(
    `(() => { const modal = document.querySelector('#modalRoot .modal-card, .modal-card'); return modal ? { open: true, title: (modal.querySelector("h3") || {}).textContent || "", text: (modal.querySelector("p") || {}).textContent || "" } : null; })()`,
    { awaitPromise: false }
  );
  report.check("switch.modal-open", !!switchModal && switchModal.open, switchModal);
  await page.click('[data-action="modal-close"]');
  await sleep(300);
  const activeAfterCancel = await page.storage();
  const activeQuest = activeAfterCancel.state && activeAfterCancel.state.activeQuest;
  report.check("switch.cancel-keeps-progress", !!activeQuest && activeQuest.charId === packer.id && activeQuest.stepIndex === 1, activeQuest);
  await page.click(`[data-action="select-character"][data-char="${packer.id}"]`);
  await page.waitScreen("game");
  await sleep(250);

  // доигрываем маршрут 2
  for (let stepIndex = 1; stepIndex < packer.steps.length; stepIndex += 1) {
    await driver.advanceDialogueToTask();
    await driver.solveCurrentTask(packer.steps[stepIndex].task);
    await page.click('[data-action="next-step"]');
    await sleep(300);
  }
  await page.waitScreen("result");
  let result = await driver.resultInfo();
  report.check("route-packer.stars-3", result.stars === 3, { on: result.stars, off: result.starsOff });
  await checkLayout(page, report, "result-packer", { mobile: true });
  await checkConfettiBehindContent(page, report, "result-packer");

  // маршрут 3 с намеренной ошибкой pH → 2 звезды
  await page.click('[data-action="go-characters"]');
  await page.waitScreen("characters");
  await driver.selectCharacter(lab.id);
  await driver.advanceDialogueToTask();
  await driver.solveCurrentTask(lab.steps[0].task, { mistakeKind: "ph" });
  await page.click('[data-action="next-step"]');
  await sleep(300);
  for (let stepIndex = 1; stepIndex < lab.steps.length; stepIndex += 1) {
    await driver.advanceDialogueToTask();
    await driver.solveCurrentTask(lab.steps[stepIndex].task);
    await page.click('[data-action="next-step"]');
    await sleep(300);
  }
  await page.waitScreen("result");
  result = await driver.resultInfo();
  report.check("route-lab.stars-2-after-mistake", result.stars === 2, { on: result.stars, off: result.starsOff });
  await checkLayout(page, report, "result-lab", { mobile: true });

  // карточка героя показывает звёзды
  await page.click('[data-action="go-characters"]');
  await page.waitScreen("characters");
  const cards = await page.eval(
    `(() => Array.from(document.querySelectorAll(".character-card")).map((card) => ({ text: (card.innerText || "").slice(0, 160), stars: card.querySelectorAll(".char-stars span:not(.off)").length })))()`,
    { awaitPromise: false }
  );
  report.check("characters.stars-visible", cards.some((card) => card.stars > 0), cards);
  await checkLayout(page, report, "characters-completed", { mobile: true });

  await checkConsole(page, report, "mobile-reload");
}

async function keyboardScenario(page, report, driver) {
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");

  // Skip-link: должен быть первым в tab-порядке и появляться при фокусе.
  const tabOrder = await page.eval(
    `(() => {
      const selector = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const focusables = Array.from(document.querySelectorAll(selector)).filter((el) => {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return focusables.map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || ""), action: el.getAttribute("data-action"), id: el.id || null, text: (el.textContent || "").trim().slice(0, 50) }));
    })()`,
    { awaitPromise: false }
  );
  report.check("a11y.skip-link-first", tabOrder.length > 0 && tabOrder[0].cls.includes("skip-link"), tabOrder.slice(0, 3));

  await page.eval(`(() => { const link = document.querySelector(".skip-link"); if (link) link.focus(); return true; })()`, { awaitPromise: false });
  await sleep(350); // CSS transition у skip-link
  const skipFocus = await page.eval(
    `(() => {
      const link = document.querySelector(".skip-link");
      if (!link) return null;
      const rect = link.getBoundingClientRect();
      const style = getComputedStyle(link);
      return { focused: document.activeElement === link, top: Math.round(rect.top), height: Math.round(rect.height), transform: style.transform, visible: rect.top >= 0 && rect.height > 0 };
    })()`,
    { awaitPromise: false }
  );
  report.check("a11y.skip-link-visible-on-focus", !!skipFocus && skipFocus.focused && skipFocus.visible, skipFocus);
  await page.press("Enter");
  await sleep(250);
  const skipTarget = await page.eval(
    `({ hash: location.hash, activeId: document.activeElement ? document.activeElement.id : null })`,
    { awaitPromise: false }
  );
  report.check("a11y.skip-link-activation", skipTarget.hash === "#app" || skipTarget.activeId === "app", skipTarget);

  // Tab с body двигает фокус (не остаётся на body).
  await page.eval("document.body.focus(); if (document.activeElement) document.activeElement.blur();", { awaitPromise: false });
  const beforeTab = await page.activeElement();
  await page.press("Tab");
  const afterTabProbe = await page.activeElement();
  report.check("a11y.tab-moves-focus", !!afterTabProbe && afterTabProbe.tag !== "body" && JSON.stringify(afterTabProbe) !== JSON.stringify(beforeTab), { before: beforeTab, after: afterTabProbe });

  // старт с клавиатуры: фокус на CTA → Enter
  await page.eval(
    `(() => { const button = document.querySelector('[data-action="start-quest"], [data-action="resume-quest"]'); if (button) button.focus(); return true; })()`,
    { awaitPromise: false }
  );
  await page.press("Enter");
  await sleep(300);
  report.check("keyboard.start-enter", (await page.screen()) === "intro", await page.screen());

  // Enter продвигает интро, когда фокус не на кнопке
  await page.eval("document.activeElement && document.activeElement.blur(); document.body.focus();", { awaitPromise: false });
  const counterBefore = await page.text(".intro-counter");
  await page.press("Enter");
  await sleep(250);
  const counterAfter = await page.text(".intro-counter");
  report.check("keyboard.intro-enter", counterBefore !== counterAfter, { before: counterBefore, after: counterAfter });

  // до выбора героя (кнопкой), затем модалка сброса и Esc/Tab
  await page.click('[data-action="intro-skip"]');
  await page.waitScreen("characters");
  await page.eval(`document.querySelector('[data-action="reset-progress"]').scrollIntoView({ block: "center" })`, { awaitPromise: false });
  await page.click('[data-action="reset-progress"]');
  await sleep(300);
  const focusInModal = await page.activeElement();
  report.check("a11y.modal-autofocus", !!focusInModal && focusInModal.action === "modal-confirm", focusInModal);
  await page.press("Tab");
  const afterTab = await page.activeElement();
  report.check("a11y.modal-focus-trap", !!afterTab && afterTab.action === "modal-close", afterTab);
  await page.press("Tab", { modifiers: 8 }); // Shift+Tab
  const afterShiftTab = await page.activeElement();
  report.check("a11y.modal-focus-trap-shift", !!afterShiftTab && afterShiftTab.action === "modal-confirm", afterShiftTab);
  await page.press("Escape");
  await sleep(250);
  report.check("a11y.modal-escape", !(await page.exists('[data-action="modal-confirm"]')));
  const focusAfterClose = await page.activeElement();
  report.check("a11y.focus-return", !!focusAfterClose && focusAfterClose.action === "reset-progress", focusAfterClose);

  // звук с клавиатуры
  await page.eval(`document.querySelector("#soundToggle").focus()`, { awaitPromise: false });
  const soundBefore = await page.eval(`document.querySelector("#soundToggle").getAttribute("aria-pressed")`, { awaitPromise: false });
  await page.press("Enter");
  await sleep(200);
  const soundAfter = await page.eval(`document.querySelector("#soundToggle").getAttribute("aria-pressed")`, { awaitPromise: false });
  report.check("keyboard.sound-toggle", soundBefore !== soundAfter, { before: soundBefore, after: soundAfter });

  // focus-visible
  const focusVisible = await page.eval(
    `(() => { const el = document.activeElement; if (!el || el === document.body) return null; return { tag: el.tagName.toLowerCase(), matches: el.matches(":focus-visible") }; })()`,
    { awaitPromise: false }
  );
  report.check("a11y.focus-visible", !!focusVisible && focusVisible.matches === true, focusVisible);

  await checkConsole(page, report, "keyboard");
}

async function viewportLayoutScenario(page, report, driver, { viewportKey }) {
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await checkLayout(page, report, "landing", { mobile: true });
  await page.click('[data-action="start-quest"]');
  await sleep(300);
  if (await page.screen() === "intro") {
    await page.click('[data-action="intro-skip"]');
    await page.waitScreen("characters");
  }
  await checkLayout(page, report, "characters", { mobile: true });
  const first = driver.characters()[0];
  if (first) {
    await driver.selectCharacter(first.id);
    await checkLayout(page, report, "game-dialogue", { mobile: true });
    await driver.advanceDialogueToTask();
    await checkLayout(page, report, "game-task", { mobile: true });
  }
  await checkConsole(page, report, "layout");
  const viewportMeta = await page.eval(`(document.querySelector('meta[name="viewport"]') || {}).content || ""`, { awaitPromise: false });
  report.check("viewport.meta", /width=device-width/i.test(viewportMeta), viewportMeta);
}

async function standaloneScenario(page, report, driver, context) {
  // Установленный PWA проверяем в отдельном браузере, запущенном в режиме --app:
  // только так Chromium сообщает display-mode: standalone.
  let standaloneBrowser = null;
  try {
    standaloneBrowser = await launchBrowser({
      browserPath: context.browserExecutable,
      headed: false,
      profileRoot: context.profileRoot,
      appUrl: context.baseUrl + "/index.html"
    });
    const { targetInfos } = await standaloneBrowser.cdp.send("Target.getTargets");
    const appTarget = targetInfos.find((target) => target.type === "page" && target.url.startsWith(context.baseUrl));
    report.check("standalone.app-window", !!appTarget, targetInfos.filter((target) => target.type === "page").map((target) => target.url));
    if (!appTarget) return;
    const { sessionId } = await standaloneBrowser.cdp.send("Target.attachToTarget", { targetId: appTarget.targetId, flatten: true });
    const appPage = new Page(standaloneBrowser.cdp, appTarget.targetId, sessionId, {});
    await appPage.init({ width: 390, height: 844, mobile: true, dpr: 3, baseUrl: context.baseUrl });
    await appPage.waitForSelector("#app, body");
    await sleep(700);

    const modes = await appPage.eval(
      `({ standalone: matchMedia("(display-mode: standalone)").matches, fullscreen: matchMedia("(display-mode: fullscreen)").matches, browser: matchMedia("(display-mode: browser)").matches, hasApp: !!document.querySelector('[data-action="start-quest"], [data-action="resume-quest"], #app'), title: document.title, outerHeight: window.outerHeight, innerHeight: window.innerHeight })`,
      { awaitPromise: false }
    );
    report.check("standalone.display-mode", modes.standalone === true, modes);
    report.check("standalone.app-renders", modes.hasApp && modes.title.length > 0, modes);
    report.note("standalone viewport: outer=" + modes.outerHeight + ", inner=" + modes.innerHeight);
    await checkLayout(appPage, report, "standalone-390", { mobile: true });
    await checkImages(appPage, report, "standalone");

    const touch390 = await readTouchTargets(appPage, [
      { name: "brand", selector: ".brand" },
      { name: "footer-reset", selector: '[data-action="reset-progress"]' }
    ]);
    checkTouchTarget(report, "standalone-390-brand", touch390[0]);
    checkTouchTarget(report, "standalone-390-footer-reset", touch390[1]);
    await checkHeaderOverlap(appPage, report, "standalone-390");
    await appPage.eval("window.scrollTo(0, 0)", { awaitPromise: false });

    await appPage.setViewport({ width: 360, height: 740, mobile: true, dpr: 3 });
    await sleep(400);
    await checkLayout(appPage, report, "standalone-360", { mobile: true });
    const touch360 = await readTouchTargets(appPage, [
      { name: "brand", selector: ".brand" },
      { name: "footer-reset", selector: '[data-action="reset-progress"]' }
    ]);
    checkTouchTarget(report, "standalone-360-brand", touch360[0]);
    checkTouchTarget(report, "standalone-360-footer-reset", touch360[1]);
    await appPage.eval("window.scrollTo(0, 0)", { awaitPromise: false });

    await appPage.setViewport({ width: 844, height: 390, mobile: true, dpr: 3 });
    await sleep(400);
    await checkLayout(appPage, report, "standalone-landscape", { mobile: true });
    const touchLandscape = await readTouchTargets(appPage, [
      { name: "brand", selector: ".brand" },
      { name: "footer-reset", selector: '[data-action="reset-progress"]' }
    ]);
    checkTouchTarget(report, "standalone-landscape-brand", touchLandscape[0]);
    checkTouchTarget(report, "standalone-landscape-footer-reset", touchLandscape[1]);
    await checkHeaderOverlap(appPage, report, "standalone-landscape");
    await appPage.eval("window.scrollTo(0, 0)", { awaitPromise: false });

    // в standalone не должно быть горизонтального скролла и ошибок
    const errors = appPage.getConsoleErrors();
    report.check("standalone.console-clean", errors.length === 0, errors.slice(0, 5));
    const network = appPage.networkEntries.filter((entry) => entry.kind === "http" || entry.kind === "failed");
    report.check("standalone.network-clean", network.length === 0, network.slice(0, 5));
  } finally {
    if (standaloneBrowser) await standaloneBrowser.close().catch(() => {});
  }
}


async function postfixTouchScenario(page, report, driver) {
  const viewports = [
    { width: 390, height: 844, label: "390x844" },
    { width: 360, height: 740, label: "360x740" },
    { width: 844, height: 390, label: "landscape-844x390" }
  ];
  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: true, dpr: 3 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    await sleep(400);

    // шапка и футер на лендинге
    await checkHeaderOverlap(page, report, `postfix-${viewport.label}`);
    const headerTargets = await readTouchTargets(page, [
      { name: "brand", selector: ".brand" },
      { name: "start-cta", selector: '[data-action="start-quest"], [data-action="resume-quest"]' }
    ]);
    checkTouchTarget(report, `postfix-${viewport.label}-brand`, headerTargets[0]);
    checkTouchTarget(report, `postfix-${viewport.label}-hero-cta`, headerTargets[1]);

    const landingScroll = await page.horizontalScroll();
    report.check(`postfix-${viewport.label}-landing-hscroll`, !landingScroll.visibleOverflow && !(landingScroll.canScrollX && !landingScroll.hiddenOverflow), landingScroll.visibleOverflow ? landingScroll : undefined);
    await report.shot(page, `landing-${viewport.label}`);

    const footerTargets = await readTouchTargets(page, [
      { name: "footer", selector: ".site-footer" },
      { name: "footer-reset", selector: '[data-action="reset-progress"]' }
    ]);
    checkTouchTarget(report, `postfix-${viewport.label}-footer-reset`, footerTargets[1]);
    const footerProbe = await page.eval(
      `(() => {
        const footer = document.querySelector(".site-footer");
        const reset = document.querySelector('[data-action="reset-progress"]');
        if (!footer || !reset) return null;
        const footerRect = footer.getBoundingClientRect();
        const resetRect = reset.getBoundingClientRect();
        return {
          resetInsideFooter: resetRect.top >= footerRect.top - 1 && resetRect.bottom <= footerRect.bottom + 1,
          gapBottom: Math.round(footerRect.bottom - resetRect.bottom),
          footerHeight: Math.round(footerRect.height)
        };
      })()`,
      { awaitPromise: false }
    );
    report.check(`postfix-${viewport.label}-footer-layout`, !!footerProbe && footerProbe.resetInsideFooter, footerProbe);
    const footerScroll = await page.horizontalScroll();
    report.check(`postfix-${viewport.label}-footer-hscroll`, !footerScroll.visibleOverflow && !(footerScroll.canScrollX && !footerScroll.hiddenOverflow), footerScroll.visibleOverflow ? footerScroll : undefined);
    await report.shot(page, `footer-${viewport.label}`);
    await page.eval("window.scrollTo(0, 0)", { awaitPromise: false });

    // экран выбора героя: CTA карточки
    await page.click('[data-action="start-quest"]');
    await sleep(300);
    if ((await page.screen()) === "intro") {
      await page.click('[data-action="intro-skip"]');
      await page.waitScreen("characters");
    }
    await page.waitScreen("characters");
    const characterCtas = await readTouchTargets(page, [{ name: "select-character", selector: '[data-action="select-character"]' }]);
    checkTouchTarget(report, `postfix-${viewport.label}-character-cta`, characterCtas[0]);
    const charactersScroll = await page.horizontalScroll();
    report.check(`postfix-${viewport.label}-characters-hscroll`, !charactersScroll.visibleOverflow && !(charactersScroll.canScrollX && !charactersScroll.hiddenOverflow), charactersScroll.visibleOverflow ? charactersScroll : undefined);
    await checkHeaderOverlap(page, report, `postfix-${viewport.label}-characters`);
    await report.shot(page, `characters-${viewport.label}`);

    // игровой экран: CTA диалога
    const firstChar = driver.characters()[0];
    await driver.selectCharacter(firstChar.id);
    await page.waitScreen("game");
    await sleep(300);
    const gameCtas = await readTouchTargets(page, [{ name: "next-beat", selector: '[data-action="next-beat"]' }]);
    checkTouchTarget(report, `postfix-${viewport.label}-game-cta`, gameCtas[0]);
    const gameScroll = await page.horizontalScroll();
    report.check(`postfix-${viewport.label}-game-hscroll`, !gameScroll.visibleOverflow && !(gameScroll.canScrollX && !gameScroll.hiddenOverflow), gameScroll.visibleOverflow ? gameScroll : undefined);
    await checkHeaderOverlap(page, report, `postfix-${viewport.label}-game`);
    await report.shot(page, `game-${viewport.label}`);
    await checkConsole(page, report, `postfix-${viewport.label}`);
  }
}


async function pwaScenario(page, report, driver) {
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");

  // --- манифест ---
  const manifestLinks = await page.eval(
    `(() => Array.from(document.querySelectorAll('link[rel="manifest"]')).map((link) => ({ href: link.href, raw: link.getAttribute("href") })))()`,
    { awaitPromise: false }
  );
  report.check("pwa.manifest-link", manifestLinks.length > 0, manifestLinks);
  if (manifestLinks.length) {
    const manifestHref = manifestLinks[0].href;
    const manifestFetch = await page.eval(
      `fetch(${JSON.stringify(manifestHref)}).then(async (response) => {
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch (error) {}
        return { status: response.status, contentType: response.headers.get("content-type"), json };
      })`,
      { awaitPromise: true }
    );
    report.check("pwa.manifest-status", manifestFetch.status === 200, manifestFetch.status);
    const manifest = manifestFetch.json;
    report.check("pwa.manifest-json", !!manifest, manifestFetch.contentType);

    // CDP: ошибки манифеста и установки (как их видит браузер)
    const appManifest = await page.getAppManifest().catch((error) => ({ errors: [{ message: error.message }] }));
    report.check("pwa.cdp-manifest-errors", Array.isArray(appManifest.errors) && appManifest.errors.length === 0, appManifest.errors);
    if (manifest) {
      const required = ["name", "short_name", "start_url", "display", "background_color", "theme_color", "icons"];
      const missing = required.filter((key) => !manifest[key]);
      report.check("pwa.manifest-required-fields", missing.length === 0, { missing, display: manifest.display });
      report.check("pwa.manifest-display", ["standalone", "fullscreen", "minimal-ui"].includes(manifest.display), manifest.display);
      const icons = manifest.icons || [];
      const sizes = icons.map((icon) => String(icon.sizes || ""));
      report.check("pwa.manifest-icons-sizes", sizes.some((size) => /192/.test(size)) && sizes.some((size) => /512/.test(size)), sizes);
      const maskable = icons.some((icon) => /maskable/.test(String(icon.purpose || "")));
      report.check("pwa.manifest-maskable", maskable, icons.map((icon) => icon.purpose));
      const iconChecks = await page.eval(
        `Promise.all(${JSON.stringify(icons)}.map(async (icon) => {
          const url = new URL(icon.src, location.href).href;
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            let width = null;
            let height = null;
            try {
              const bitmap = await createImageBitmap(blob);
              width = bitmap.width;
              height = bitmap.height;
            } catch (error) {
              width = null;
              height = null;
            }
            return { src: icon.src, sizes: icon.sizes, purpose: icon.purpose || "", status: response.status, type: blob.type, bytes: blob.size, width, height };
          } catch (error) {
            return { src: icon.src, status: 0, error: String(error) };
          }
        }))`,
        { awaitPromise: true }
      );
      report.check("pwa.icons-load", iconChecks.every((icon) => icon.status === 200 && icon.bytes > 0), iconChecks);
      const dimensionProblems = iconChecks.filter((icon) => {
        if (!icon.width || !icon.height || !/^\d+x\d+$/.test(String(icon.sizes || ""))) return false;
        const [width, height] = String(icon.sizes).split("x").map(Number);
        return icon.width !== width || icon.height !== height;
      });
      report.check("pwa.icons-dimensions", dimensionProblems.length === 0, dimensionProblems);

      if (manifest.start_url) {
        const startUrl = await page.eval(
          `(async () => {
            const url = new URL(${JSON.stringify(manifest.start_url)}, new URL(${JSON.stringify(manifestLinks[0].href)}).href).href;
            try { const response = await fetch(url); return { url, status: response.status }; }
            catch (error) { return { url, status: 0, error: String(error) }; }
          })()`,
          { awaitPromise: true }
        );
        report.check("pwa.start-url", startUrl.status === 200, startUrl);
      }
      report.check("pwa.manifest-scope", !!manifest.scope, manifest.scope);

      const appleIcon = await page.eval(
        `(async () => {
          const link = document.querySelector('link[rel="apple-touch-icon"]');
          if (!link) return null;
          try { const response = await fetch(link.href); const blob = await response.blob(); return { href: link.href, status: response.status, bytes: blob.size, type: blob.type }; }
          catch (error) { return { href: link.href, status: 0, error: String(error) }; }
        })()`,
        { awaitPromise: true }
      );
      report.check("pwa.apple-touch-icon-load", !!appleIcon && appleIcon.status === 200 && appleIcon.bytes > 0, appleIcon);
    }
  }

  // --- meta / iOS / safe-area ---
  const meta = await page.eval(
    `(() => ({
      themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
      appleCapable: (document.querySelector('meta[name="apple-mobile-web-app-capable"]') || {}).content || null,
      appleStatus: (document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') || {}).content || null,
      appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
      viewport: (document.querySelector('meta[name="viewport"]') || {}).content || ""
    }))()`,
    { awaitPromise: false }
  );
  report.check("pwa.meta-theme-color", !!meta.themeColor, meta.themeColor);
  report.check("pwa.meta-apple-capable", !!meta.appleCapable, meta.appleCapable);
  report.check("pwa.meta-apple-status", !!meta.appleStatus, meta.appleStatus);
  report.check("pwa.meta-apple-icon", meta.appleIcon);
  report.check("pwa.meta-viewport-fit", /viewport-fit=cover/i.test(meta.viewport), meta.viewport);
  const safeAreaCss = await page.eval(
    `(() => {
      let found = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules = [];
        try { rules = Array.from(sheet.cssRules || []); } catch (error) { continue; }
        const text = rules.map((rule) => rule.cssText || "").join("\\n");
        if (/env\\(safe-area-inset/i.test(text)) found.push(sheet.href || "inline");
      }
      return found;
    })()`,
    { awaitPromise: false }
  );
  report.check("pwa.safe-area-css", safeAreaCss.length > 0, safeAreaCss);

  // --- service worker ---
  const sw = await waitUntil(async () => {
    const info = await page.eval(
      `(async () => {
        if (!("serviceWorker" in navigator)) return { supported: false, count: 0 };
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.race([navigator.serviceWorker.ready.catch(() => null), new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => null);
        const controller = navigator.serviceWorker.controller;
        const cacheKeys = await (window.caches ? caches.keys() : Promise.resolve([]));
        return {
          supported: true,
          count: registrations.length,
          registrations: registrations.map((registration) => ({
            scope: registration.scope,
            active: registration.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
            waiting: !!registration.waiting,
            installing: !!registration.installing
          })),
          controller: controller ? { scriptURL: controller.scriptURL, state: controller.state } : null,
          cacheKeys
        };
      })()`,
      { awaitPromise: true }
    );
    if (!info.supported) return info;
    return info.count > 0 && (info.controller || (info.registrations[0] && info.registrations[0].active)) ? info : null;
  }, { timeout: 12000, interval: 300, label: "service worker registration" }).catch(async () => {
    return page.eval(
      `(async () => ({ supported: "serviceWorker" in navigator, count: (await navigator.serviceWorker.getRegistrations()).length }))()`,
      { awaitPromise: true }
    ).catch(() => ({ supported: false, count: 0 }));
  });
  report.check("pwa.sw-supported", sw.supported === true, sw);
  report.check("pwa.sw-registered", (sw.count || 0) > 0, sw);
  let expectedSwInfo = { version: null, number: null };
  if (sw.count) {
    report.check("pwa.sw-active", !!(sw.registrations && sw.registrations[0] && sw.registrations[0].active), sw.registrations);
    const active = sw.registrations && sw.registrations[0] && sw.registrations[0].active;
    if (active && active.scriptURL) {
      const script = await page.eval(
        `fetch(${JSON.stringify(active.scriptURL)}).then(async (response) => ({ status: response.status, contentType: response.headers.get("content-type"), text: await response.text() }))`,
        { awaitPromise: true }
      );
      report.check("pwa.sw-script-200", script.status === 200, { status: script.status, contentType: script.contentType });
      report.check("pwa.sw-has-fetch", /addEventListener\s*\(\s*["']fetch["']/.test(script.text), (script.text || "").slice(0, 120));
      report.check("pwa.sw-cache-strategy", /caches\.|cache\.add|CacheStorage|workbox|precache/i.test(script.text));
      const versionMatch = (script.text || "").match(/VERSION\s*=\s*["']([^"']+)["']/);
      expectedSwInfo = parseSwVersion(script.text);
      report.check("pwa.sw-version", expectedSwInfo.number !== null && expectedSwInfo.number > 5, { version: versionMatch ? versionMatch[1] : null, number: expectedSwInfo.number });
    }
    // reload → контроллер должен появиться
    await page.reload();
    await page.waitScreen("landing");
    await sleep(1200);
    const controller = await page.eval(
      `(async () => { const registration = await navigator.serviceWorker.getRegistration(); return { controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null, active: registration && registration.active ? registration.active.scriptURL : null }; })()`,
      { awaitPromise: true }
    ).catch(() => ({ controller: null, active: null }));
    report.check("pwa.sw-controller", !!controller.controller, controller);
    const cachesInfo = await page.eval(
      `(async () => {
        const keys = await caches.keys();
        const details = [];
        for (const key of keys) {
          const cache = await caches.open(key);
          const requests = await cache.keys();
          details.push({ key, count: requests.length, urls: requests.slice(0, 30).map((request) => request.url) });
        }
        return { keys, details };
      })()`,
      { awaitPromise: true }
    ).catch(() => ({ keys: [], details: [] }));
    const cachedUrls = (cachesInfo.details || []).reduce((acc, cache) => acc.concat(cache.urls || []), []);
    report.check("pwa.cache-populated", cachedUrls.length > 0, cachesInfo);
    report.check(
      "pwa.cache-version",
      expectedSwInfo.version ? (cachesInfo.keys || []).some((key) => key.includes(expectedSwInfo.version)) : false,
      { expected: expectedSwInfo.version, keys: cachesInfo.keys }
    );
    const currentVersionNumber = expectedSwInfo.number || 5;
    report.check(
      "pwa.cache-no-stale",
      !(cachesInfo.keys || []).some((key) => {
        const match = key.match(/brodilka-v(\d+)/);
        return match && Number(match[1]) < currentVersionNumber;
      }),
      cachesInfo.keys
    );
    const cachesShell = cachedUrls.some((url) => /\.(html|css|js)$/i.test(url)) || cachedUrls.some((url) => /localhost|127\.0\.0\.1/.test(url));
    report.check("pwa.cache-shell", cachesShell, cachedUrls.slice(0, 20));
    report.check("pwa.cache-pdf-script", cachedUrls.some((url) => /js\/pdf\.js/i.test(url)), cachedUrls.filter((url) => /\.js$/i.test(url)).slice(0, 15));
    report.check("pwa.cache-share-image", cachedUrls.some((url) => /share-promo\.(png|svg)/i.test(url)), cachedUrls.filter((url) => /share-promo/i.test(url)));
    // offline: скрипт PDF должен отдаваться из кэша
    await page.setOffline(true);
    const offlinePdfScript = await page.eval(`fetch("js/pdf.js").then((response) => response.ok).catch(() => false)`, { awaitPromise: true }).catch(() => false);
    await page.setOffline(false);
    report.check("pwa.offline-pdf-script", offlinePdfScript === true, offlinePdfScript);
  }

  // --- standalone emulation ---
  await page.emulateDisplayMode("standalone");
  const standalone = await page.eval(
    `({ standalone: matchMedia("(display-mode: standalone)").matches, browser: matchMedia("(display-mode: browser)").matches, bodyWidth: document.documentElement.clientWidth, hscroll: (() => { const doc = document.documentElement; return doc.scrollWidth > doc.clientWidth; })() })`,
    { awaitPromise: false }
  );
  report.note("display-mode emulation: " + JSON.stringify(standalone));
  if (standalone.standalone) {
    report.check("pwa.standalone-emulation", true, standalone);
  } else {
    report.skip("pwa.standalone-emulation", "браузер не применил эмуляцию display-mode (проверить вручную в установленном режиме); manifest.display проверен отдельно");
  }
  await report.shot(page, "standalone");
  await page.emulateDisplayMode(null);

  // --- offline reload ---
  await page.setOffline(true);
  await page.reload({ timeout: 25000 }).catch((error) => report.note("offline reload error: " + error.message));
  await sleep(800);
  const offline = await page.eval(
    `(() => ({
      readyState: document.readyState,
      bodyText: (document.body ? document.body.innerText : "").slice(0, 200),
      hasApp: !!document.querySelector('[data-action="start-quest"], [data-action="resume-quest"], .landing, #app'),
      h1: (document.querySelector("h1") || {}).innerText || "",
      storageKeys: (() => { try { return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)); } catch (error) { return []; } })()
    }))()`,
    { awaitPromise: false }
  );
  report.check("pwa.offline-reload-renders", offline.readyState === "complete" && offline.hasApp, offline);
  await report.shot(page, "offline-landing");
  // офлайн-навигация внутри приложения
  if (offline.hasApp) {
    await page.click('[data-action="start-quest"], [data-action="resume-quest"]').catch(() => null);
    await sleep(400);
    const offlineScreen = await page.screen();
    report.check("pwa.offline-navigation", ["intro", "characters", "game"].includes(offlineScreen), offlineScreen);
    await report.shot(page, "offline-navigation");
  }
  await page.setOffline(false);
  await page.reload().catch(() => {});
  await page.waitScreen("landing").catch(() => {});
  await checkConsole(page, report, "pwa", { allow: [] });
  // сетевые ошибки офлайна намеренные — фильтруем
  const networkFailures = page.networkEntries.filter((entry) => !page.offline);
  report.check("pwa.network-clean", networkFailures.length === 0, networkFailures.slice(0, 6));

  // --- установочные критерии (агрегированно) ---
  report.note("Установочные критерии PWA: manifest + иконки 192/512 + SW с fetch. Полноценная установка через UI в headless не проверяется — см. ручной чек-лист.");
}

async function pwaFreshScenario(page, report, driver) {
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");

  // дождаться первой регистрации SW
  await waitUntil(
    async () => {
      const count = await page.eval("navigator.serviceWorker.getRegistrations().then((rs) => rs.length)", { awaitPromise: true }).catch(() => 0);
      return count > 0 ? true : null;
    },
    { timeout: 15000, interval: 300, label: "initial SW registration" }
  ).catch(() => report.note("SW не зарегистрировался до сброса — проверяем повторную регистрацию"));

  // эмулируем «свежий профиль»: unregister + удалить все кэши
  const cleared = await page.eval(
    `(async () => {
      if (!("serviceWorker" in navigator)) return { supported: false };
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      return { supported: true, registrations: (await navigator.serviceWorker.getRegistrations()).length, caches: (await caches.keys()).length };
    })()`,
    { awaitPromise: true }
  );
  report.check("pwa-fresh.reset", cleared.supported === true && cleared.registrations === 0 && cleared.caches === 0, cleared);

  await page.reload();
  await page.waitScreen("landing");
  await sleep(800);

  // повторная регистрация после «чистого профиля»
  const registration = await waitUntil(
    async () => {
      const info = await page.eval(
        `(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          if (!registration) return null;
          return { active: registration.active ? registration.active.scriptURL : null, installing: !!registration.installing, waiting: !!registration.waiting };
        })()`,
        { awaitPromise: true }
      ).catch(() => null);
      return info && (info.active || info.installing) ? info : null;
    },
    { timeout: 15000, interval: 300, label: "SW re-registration" }
  );
  report.check("pwa-fresh.sw-reregister", !!registration, registration || null);

  await page.reload();
  await page.waitScreen("landing");
  await sleep(1200);

  const controller = await page.eval(
    `(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return { controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null, active: registration && registration.active ? registration.active.scriptURL : null };
    })()`,
    { awaitPromise: true }
  ).catch(() => ({ controller: null, active: null }));
  report.check("pwa-fresh.controller", !!controller.controller, controller);

  // CDP installability
  const appManifest = await page.getAppManifest().catch((error) => ({ errors: [{ message: error.message }] }));
  report.check("pwa-fresh.manifest-errors", Array.isArray(appManifest.errors) && appManifest.errors.length === 0, appManifest.errors);
  const installability = await page.getInstallabilityErrors().catch((error) => ({ installabilityErrors: [{ errorId: error.message }] }));
  report.check(
    "pwa-fresh.installability-errors",
    Array.isArray(installability.installabilityErrors) && installability.installabilityErrors.length === 0,
    installability.installabilityErrors
  );

  // иконки: 192/512/maskable/180
  const iconUrls = [
    { url: "assets/icon-192.png", expect: 192, label: "192" },
    { url: "assets/icon-512.png", expect: 512, label: "512" },
    { url: "assets/icon-maskable-512.png", expect: 512, label: "maskable-512" },
    { url: "assets/apple-touch-icon.png", expect: 180, label: "apple-180" }
  ];
  const iconChecks = await page.eval(
    `Promise.all(${JSON.stringify(iconUrls)}.map(async (entry) => {
      try {
        const response = await fetch(entry.url, { cache: "no-store" });
        const blob = await response.blob();
        let width = null;
        let height = null;
        try { const bitmap = await createImageBitmap(blob); width = bitmap.width; height = bitmap.height; } catch (error) {}
        return { ...entry, status: response.status, type: blob.type, bytes: blob.size, width, height };
      } catch (error) {
        return { ...entry, status: 0, error: String(error) };
      }
    }))`,
    { awaitPromise: true }
  );
  report.check("pwa-fresh.icons-200", iconChecks.every((icon) => icon.status === 200 && icon.bytes > 0), iconChecks);
  const iconSizeProblems = iconChecks.filter((icon) => icon.width && icon.width !== icon.expect);
  report.check("pwa-fresh.icons-dimensions", iconSizeProblems.length === 0, iconSizeProblems);

  // версия SW и кэшей (динамически: номер версии должен быть > v5)
  const swText = await page.eval(`fetch("sw.js", { cache: "no-store" }).then((response) => response.text())`, { awaitPromise: true });
  const swInfo = parseSwVersion(swText);
  report.check("pwa-fresh.sw-version", swInfo.number !== null && swInfo.number > 5, { version: swInfo.version, number: swInfo.number });
  const cacheKeys = await page.eval("caches.keys()", { awaitPromise: true });
  report.check("pwa-fresh.cache-version", swInfo.version ? cacheKeys.some((key) => key.includes(swInfo.version)) : false, { expected: swInfo.version, keys: cacheKeys });
  report.check(
    "pwa-fresh.no-stale-cache",
    !cacheKeys.some((key) => {
      const match = key.match(/brodilka-v(\d+)/);
      return match && swInfo.number !== null && Number(match[1]) < swInfo.number;
    }),
    cacheKeys
  );
  const cachedUrlsFresh = await page.eval(
    `(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls;
    })()`,
    { awaitPromise: true }
  ).catch(() => []);
  report.check("pwa-fresh.cache-pdf-script", cachedUrlsFresh.some((url) => /js\/pdf\.js/i.test(url)), cachedUrlsFresh.filter((url) => /\.js$/i.test(url)).slice(0, 15));
  report.check("pwa-fresh.cache-share-image", cachedUrlsFresh.some((url) => /share-promo\.(png|svg)/i.test(url)), cachedUrlsFresh.filter((url) => /share-promo/i.test(url)));

  // install-кнопка присутствует (в headless prompt не вызывается)
  const installButton = await page.eval(
    `(() => { const button = document.getElementById("installApp"); if (!button) return null; return { present: true, hidden: button.hidden, text: (button.textContent || "").trim().slice(0, 60) }; })()`,
    { awaitPromise: false }
  );
  report.check("pwa-fresh.install-button", !!installButton && installButton.present, installButton);
  if (installButton) report.note("install-кнопка: " + JSON.stringify(installButton));

  // offline reload на свежем профиле
  await page.setOffline(true);
  await page.reload({ timeout: 25000 }).catch((error) => report.note("offline reload: " + error.message));
  await sleep(800);
  const offline = await page.eval(
    `(() => ({ readyState: document.readyState, hasApp: !!document.querySelector('[data-action="start-quest"], [data-action="resume-quest"], #app'), body: (document.body ? document.body.innerText : "").slice(0, 120) }))()`,
    { awaitPromise: false }
  );
  report.check("pwa-fresh.offline-reload", offline.readyState === "complete" && offline.hasApp, offline);
  const offlinePdfScript = await page.eval(`fetch("js/pdf.js").then((response) => response.ok).catch(() => false)`, { awaitPromise: true }).catch(() => false);
  report.check("pwa-fresh.offline-pdf-script", offlinePdfScript === true, offlinePdfScript);
  await report.shot(page, "offline-fresh");
  await page.setOffline(false);
  await page.reload().catch(() => {});
  await page.waitScreen("landing").catch(() => {});

  await checkConsole(page, report, "pwa-fresh");
  const networkFailures = page.networkEntries.filter((entry) => entry.kind === "http" || entry.kind === "failed");
  report.check("pwa-fresh.network-clean", networkFailures.length === 0, networkFailures.slice(0, 6));
}

async function historyScenario(page, report, driver) {
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");

  await page.click('[data-action="start-quest"]');
  await sleep(300);
  if ((await page.screen()) === "intro") {
    let guard = 0;
    while ((await page.screen()) === "intro" && guard++ < 10) {
      await page.click('[data-action="intro-next"]');
      await sleep(250);
    }
  }
  await page.waitScreen("characters");
  const characters = driver.characters();
  const brewer = characters[0];

  await driver.selectCharacter(brewer.id);
  await page.waitScreen("game");
  const historyLength = await page.eval("history.length", { awaitPromise: false });
  report.check("history.entries", historyLength >= 3, { historyLength });

  // back на выбор героя, forward обратно в игру
  await page.historyBack();
  await page.waitScreen("characters");
  report.check("history.back-game-characters", (await page.screen()) === "characters");
  const storageAfterBack = await page.storage();
  report.check("history.back-keeps-quest", !!(storageAfterBack.state && storageAfterBack.state.activeQuest), storageAfterBack.state && storageAfterBack.state.activeQuest);
  await page.historyForward();
  await page.waitScreen("game");
  report.check("history.forward-game", (await page.screen()) === "game");
  await report.shot(page, "after-forward");

  // доигрываем смену
  await driver.finishActiveRoute(brewer, { screenshotPrefix: "history-route" });
  await page.waitScreen("result");
  const result = await driver.resultInfo();
  report.check("history.result-code", !!result.code, result.code);

  // back с формы не теряет результат
  await driver.openApplyFromResult();
  await driver.fillApplyForm({ name: "История Тест", phone: "+7 999 111-22-33", email: "history@example.com", link: "https://hh.ru/resume/history" });
  await page.historyBack();
  await page.waitScreen("result");
  const stateAfterFormBack = await page.storage();
  const completedState = stateAfterFormBack.state && stateAfterFormBack.state.completed;
  report.check("history.back-form-result-screen", (await page.screen()) === "result");
  report.check("history.back-form-keeps-completion", !!(completedState && completedState[brewer.id]), completedState && Object.keys(completedState));
  const promoAfterBack = await page.text("#promoCode");
  report.check("history.back-form-keeps-promo", !!promoAfterBack && promoAfterBack.length >= 4, promoAfterBack);

  // forward после back: приложение осознанно фолбэчит apply/success → result
  // (данные формы не сохраняются), поэтому допустимы оба экрана — главное без потери данных.
  await page.historyForward();
  await sleep(500);
  const screenAfterForward = await page.screen();
  report.check("history.forward-form-safe", ["apply", "result"].includes(screenAfterForward), screenAfterForward);
  if (screenAfterForward !== "apply") {
    report.note("history.forward с формы открывает result (fallback приложения), форма не восстанавливается — зафиксировано как наблюдение");
    await driver.openApplyFromResult();
  }
  await page.waitScreen("apply");
  await driver.fillApplyForm({ name: "История Тест", phone: "+7 999 111-22-33", email: "history@example.com", link: "https://hh.ru/resume/history", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 8000 });
  const stateAfterSubmit = await page.storage();
  const applications = (stateAfterSubmit.state && stateAfterSubmit.state.applications) || [];
  report.check("history.application-saved", applications.length >= 1, applications.length);

  // back с экрана успеха: результат и заявка не теряются
  await page.historyBack();
  await sleep(400);
  const screenAfterSuccessBack = await page.screen();
  report.check("history.back-success-no-loss", ["result", "apply", "success"].includes(screenAfterSuccessBack), screenAfterSuccessBack);
  const stateAfterSuccessBack = await page.storage();
  report.check("history.back-success-keeps-application", ((stateAfterSuccessBack.state && stateAfterSuccessBack.state.applications) || []).length >= 1, (stateAfterSuccessBack.state && stateAfterSuccessBack.state.applications || []).length);
  report.check("history.back-success-keeps-completion", !!(stateAfterSuccessBack.state && stateAfterSuccessBack.state.completed && stateAfterSuccessBack.state.completed[brewer.id]));
  await report.shot(page, "after-success-back");

  await checkConsole(page, report, "history");
}

async function contentGuardScenario(page, report, driver) {
  const renderedTexts = [];
  const collect = async (screen) => {
    renderedTexts.push({ screen, text: await page.eval("document.body ? document.body.innerText : ''", { awaitPromise: false }) });
  };

  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await collect("landing");

  await page.click('[data-action="start-quest"]');
  await sleep(300);
  if ((await page.screen()) === "intro") {
    let index = 0;
    while ((await page.screen()) === "intro" && index < 12) {
      index += 1;
      await collect(`intro-${index}`);
      await page.click('[data-action="intro-next"]');
      await sleep(250);
    }
  }
  await page.waitScreen("characters");
  await collect("characters");

  const characters = driver.characters();
  const brewer = characters[0];
  const packer = characters[1];
  const lab = characters[2];
  await driver.selectCharacter(brewer.id);
  for (let stepIndex = 0; stepIndex < brewer.steps.length; stepIndex += 1) {
    await collect(`brewer-step${stepIndex + 1}-dialogue`);
    await driver.advanceDialogueToTask();
    await collect(`brewer-step${stepIndex + 1}-task`);
    await driver.solveCurrentTask(brewer.steps[stepIndex].task);
    await collect(`brewer-step${stepIndex + 1}-feedback`);
    await page.click('[data-action="next-step"]');
    await sleep(300);
  }
  await page.waitScreen("result");
  await collect("result");
  await driver.openApplyFromResult();
  await collect("apply");
  await driver.fillApplyForm({ name: "Контент Тест", phone: "+7 999 000-11-22", email: "content@example.com", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 8000 });
  await collect("success");

  // ещё экраны героев: карточки и первые реплики (роли/теги)
  await page.click('[data-action="go-characters"]');
  await page.waitScreen("characters");
  await collect("characters-after-route");
  if (packer) {
    await driver.selectCharacter(packer.id);
    await collect("packer-dialogue");
  }
  if (lab) {
    await driver.goToCharacters();
    await driver.selectCharacter(lab.id);
    await collect("lab-dialogue");
  }

  // рендер HTML целиком (мета, hidden-тексты) + источники
  const renderedHtml = await page.eval("document.documentElement.outerHTML", { awaitPromise: false });
  const sourceFiles = ["index.html", "manifest.webmanifest", "sw.js", "js/app.js", "js/data.js"];
  const sourceTexts = await page.fetchTexts(sourceFiles);
  const consoleText = page.consoleEntries.map((entry) => `${entry.level}: ${entry.text} ${entry.url || ""}`).join("\n");

  const allRendered = renderedTexts.map((item) => item.text).join("\n");
  const allSources = sourceTexts.map((item) => `\n/* ${item.file} */\n${item.text || ""}`).join("\n");

  for (const rule of CONTENT_RULES) {
    const renderedHits = renderedTexts
      .map((item) => ({ screen: item.screen, hits: scanContent(item.text).filter((hit) => hit.rule === rule.id).flatMap((hit) => hit.samples) }))
      .filter((item) => item.hits.length);
    const htmlHits = (renderedHtml.match(rule.re) || []).slice(0, 5);
    const sourceHits = sourceTexts
      .map((item) => ({ file: item.file, hits: (String(item.text || "").match(rule.re) || []).slice(0, 5) }))
      .filter((item) => item.hits.length);
    const consoleHits = (consoleText.match(rule.re) || []).slice(0, 5);
    const details = { rendered: renderedHits, html: htmlHits, sources: sourceHits, console: consoleHits };
    const found = renderedHits.length || htmlHits.length || sourceHits.length || consoleHits.length;
    if (rule.severity === "fail") {
      report.check(`content.no-${rule.id}`, !found, details);
    } else if (found) {
      report.warnCheck(`content.${rule.id}-review`, details);
    } else {
      report.check(`content.no-${rule.id}`, true);
    }
  }

  const rolesText = allRendered;
  report.check("content.role-machinist", /машинист оборудования/i.test(rolesText));
  report.check("content.no-kvasovar", !/квасовар/i.test(rolesText), (rolesText.match(/квасовар\S*/gi) || []).slice(0, 5));
  report.check("content.role-line-operator", /оператор линии/i.test(rolesText));
  report.check("content.role-lab", /лаборант/i.test(rolesText));
  report.check("content.sources-no-kvasovar", !/квасовар/i.test(allSources), (allSources.match(/квасовар\S*/gi) || []).slice(0, 5));
  report.check("content.no-age-badge", !/(?<!\d)0\s*%/.test(allRendered) && !/18\s*\+/.test(allRendered), { zeroPercent: /(?<!\d)0\s*%/.test(allRendered), eighteen: /18\s*\+/.test(allRendered) });
  report.check("content.sources-no-beer", !/пив|18\s*\+|хмел/i.test(allSources));
  report.check("content.sources-no-age-markers", !/(?<!\d)0\s*%|безалкогольн/i.test(allSources));
  const kbdCount = await page.count("kbd");
  report.check("content.no-enter-hints", !/\bEnter\b/.test(allRendered) && kbdCount === 0, { enterMentions: (allRendered.match(/\bEnter\b/g) || []).length, kbd: kbdCount });
  report.check("content.no-test-phrase", !/не тест на знание|знание напитков/i.test(allRendered));
  // «безалкогольные» допустимо, отдельно фиксируем ручной просмотр
  const alcoholMentions = [...new Set((allRendered + allSources).match(/(?<!без)алкогол\S*/gi) || [])];
  if (alcoholMentions.length) report.note("упоминания алкоголя (ручная проверка): " + JSON.stringify(alcoholMentions.slice(0, 8)));
  report.check("content.no-old-lexicon", !/оптимист|не дам заскучать|заскучать|весёлый пузырь|дружок|малыш/i.test(allRendered + allSources), (allRendered.match(/оптимист|заскучать|дружок|малыш/gi) || []).slice(0, 5));
  report.check("content.bubble-lore-1996", /1996/.test(allRendered), (allRendered.match(/1996/g) || []).length);
  const dataForLore = (driver && driver.data) || {};
  const bubbleTexts = []
    .concat(((dataForLore.intro || []).filter((line) => line.speaker === "bubble") || []).map((line) => line.text || ""))
    .concat(
      ((dataForLore.characters || []) || []).flatMap((char) =>
        (char.steps || []).flatMap((step) => (step.beats || []).filter((beat) => beat.speaker === "bubble").map((beat) => beat.text || ""))
      )
    )
    .join("\n");
  const bubbleManualWork = /(^|[^а-яё])(я|мы)\s+(соберу|сделаю|проверю|настрою|запущу|остановлю|выберу|найду|починю)/i;
  report.check("content.bubble-not-working", !bubbleManualWork.test(bubbleTexts), (bubbleTexts.match(bubbleManualWork) || []).slice(0, 5));
  report.check("content.player-does-shift", /смену проходишь ты|решаешь ты|ты не бери/i.test(bubbleTexts), bubbleTexts.slice(0, 200));
  report.check("content.no-kvasovar-visible", !/квасовар/i.test(allRendered));
  report.check("content.no-machine-role-old", !/пивовар/i.test(allRendered + allSources));
  await report.shot(page, "content-guard-final");

  await checkConsole(page, report, "content-guard");
}

async function mobileCtaScenario(page, report, driver) {
  const viewports = [
    { width: 390, height: 844, label: "390" },
    { width: 360, height: 740, label: "360" }
  ];
  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: true, dpr: 3 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    await page.click('[data-action="start-quest"]');
    await sleep(300);
    if ((await page.screen()) === "intro") {
      await page.click('[data-action="intro-skip"]');
      await page.waitScreen("characters");
    }
    await page.waitScreen("characters");

    const layoutInfo = await page.horizontalScroll();
    report.check(`mobile-cta-${viewport.label}.characters-no-hscroll`, !layoutInfo.visibleOverflow && !(layoutInfo.canScrollX && !layoutInfo.hiddenOverflow), layoutInfo.visibleOverflow ? layoutInfo : undefined);
    await auditCta(page, report, '[data-action="select-character"]', `mobile-cta-${viewport.label}-characters`);
    await report.shot(page, `characters-${viewport.label}`);

    const firstChar = driver.characters()[0];
    await driver.selectCharacter(firstChar.id);
    await page.waitScreen("game");
    const gameLayout = await page.horizontalScroll();
    report.check(`mobile-cta-${viewport.label}.game-no-hscroll`, !gameLayout.visibleOverflow && !(gameLayout.canScrollX && !gameLayout.hiddenOverflow), gameLayout.visibleOverflow ? gameLayout : undefined);
    await auditCta(page, report, '[data-action="next-beat"]', `mobile-cta-${viewport.label}-game-dialogue`);
    await report.shot(page, `game-dialogue-${viewport.label}`);

    await driver.advanceDialogueToTask();
    await auditCta(
      page,
      report,
      '[data-action="check-recipe"], [data-action="ph-submit"], [data-action="next-step"], [data-action="sort-item"]',
      `mobile-cta-${viewport.label}-game-task`
    );
    await report.shot(page, `game-task-${viewport.label}`);
    await checkConsole(page, report, `mobile-cta-${viewport.label}`);
  }
}


/* ------------------------------------------------------------------ */
/* helpers и сценарии новой итерации (task-8…task-11)                   */
/* Запуск — после сигнала лида; до готовности production не прогонять.  */
/* ------------------------------------------------------------------ */

async function introSnapshot(page) {
  return page.eval(
    `(() => {
      const screenSelectors = ['.intro-screen', '.screen.intro-screen', '[data-screen="intro"]'];
      let screen = null;
      for (const selector of screenSelectors) { screen = document.querySelector(selector); if (screen) break; }
      if (!screen) screen = document.querySelector('#app > .screen');
      const textEl = document.querySelector('.dialogue-text, .intro-text, .intro-copy, .intro-line, .intro-screen p');
      const counterEl = document.querySelector('.intro-counter, .intro-step, .intro-progress-text, [data-intro-counter]');
      const nextBtn = document.querySelector('[data-action="intro-next"]');
      const leftSelectors = ['.intro-visual', '.intro-left', '.intro-speaker', '.intro-side', '.intro-mascot', '.speaker-visual', '.dialogue-avatar'];
      let left = null;
      for (const selector of leftSelectors) { left = document.querySelector(selector); if (left) break; }
      const img = left ? (left.tagName === 'IMG' ? left : left.querySelector('img')) : document.querySelector('.dialogue-avatar img');
      const nameSelectors = ['.intro-speaker-tag strong', '.intro-speaker-tag', '.dialogue-speaker-name', '.speaker-name', '.intro-speaker-name', '.speaker-role-name'];
      const names = nameSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((el) => (el.textContent || '').trim())).filter(Boolean);
      const progressEl = document.querySelector('.intro-progress i, .intro-progress span, progress');
      const runningAnimations = screen && typeof screen.getAnimations === "function" ? screen.getAnimations({ subtree: false }).filter((animation) => animation.playState === "running").length : 0;
      return {
        present: !!screen,
        text: textEl ? (textEl.textContent || '').replace(/\\s+/g, ' ').trim() : '',
        counter: counterEl ? (counterEl.textContent || '').replace(/\\s+/g, ' ').trim() : '',
        nextText: nextBtn ? (nextBtn.textContent || '').replace(/\\s+/g, ' ').trim() : '',
        names: names.slice(0, 4),
        leftText: left ? (left.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240) : '',
        imgSrc: img ? img.getAttribute('src') : null,
        animationName: screen ? getComputedStyle(screen).animationName : null,
        runningAnimations,
        scrollY: Math.round(window.scrollY),
        screenCount: document.querySelectorAll('#app .screen').length,
        refSet: !!window.__qaIntroScreen,
        sameRef: window.__qaIntroScreen === screen,
        refConnected: !!(window.__qaIntroScreen && window.__qaIntroScreen.isConnected),
        progress: progressEl ? { width: getComputedStyle(progressEl).width, transform: getComputedStyle(progressEl).transform } : null,
        kbdCount: document.querySelectorAll('kbd').length,
        speakers: ((window.BRODILKA_DATA || {}).intro || []).map((line) => line.speaker),
        speakerData: (window.BRODILKA_DATA || {}).speakers || {}
      };
    })()`,
    { awaitPromise: false }
  );
}

async function chatSnapshot(page) {
  return page.eval(
    `(() => {
      const containerSelectors = ['.chat-list', '.chat-panel', '.chat-log', '.chat-messages', '.dialog-chat', '.quest-chat', '[data-chat]', '.chat', '.dialogue-thread', '.quest-thread', '.messages'];
      let container = null;
      let containerSelector = null;
      for (const selector of containerSelectors) {
        const el = document.querySelector(selector);
        if (el && el.querySelectorAll('*').length > 1) { container = el; containerSelector = selector; break; }
      }
      const scope = container || document.querySelector('#app') || document;
      const messageSelectors = ['.chat-msg', '.chat-message', '.message', '.msg', '.dialogue-message', '[data-message]', '[data-chat-message]', '.bubble'];
      let nodes = [];
      let messageSelector = null;
      for (const selector of messageSelectors) {
        const list = Array.from(scope.querySelectorAll(selector));
        if (list.length) { nodes = list; messageSelector = selector; break; }
      }
      nodes = nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
      const containerRect = container ? container.getBoundingClientRect() : null;
      const previousNode = window.__qaChatNode || null;
      if (!window.__qaChatNode && container) window.__qaChatNode = container;
      const scene = document.querySelector('.scene-panel, .scene');
      const isVisible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const labelInfo = (selectors) => selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).map((el) => ({
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
        visible: isVisible(el),
        fontSize: parseFloat(getComputedStyle(el).fontSize)
      }));
      return {
        hasContainer: !!container,
        containerSelector,
        containerClass: container ? String(container.className || '') : null,
        sameNode: previousNode ? previousNode === container : null,
        count: nodes.length,
        messageSelector,
        containerCenter: containerRect ? Math.round(containerRect.left + containerRect.width / 2) : null,
        containerLeft: containerRect ? Math.round(containerRect.left) : null,
        containerRight: containerRect ? Math.round(containerRect.right) : null,
        messages: nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          const img = node.querySelector('img');
          const nameEl = node.querySelector('.chat-msg-head strong, .chat-msg-head, .chat-name, .message-name, .name, [class*="name"]');
          return {
            text: (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 220),
            center: Math.round(rect.left + rect.width / 2),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            top: Math.round(rect.top),
            isOwn: node.classList.contains("is-own"),
            isSystem: node.classList.contains("is-system"),
            src: img ? img.getAttribute('src') : null,
            name: nameEl ? nameEl.textContent.trim().slice(0, 70) : null,
            cls: String(node.className || '').slice(0, 90)
          };
        }),
        sceneAdviceVisible: ['.scene-bubble', '.scene-tip', '[class*="scene-advice"]'].some((selector) => Array.from(document.querySelectorAll(selector)).some(isVisible)),
        sceneBadgeVisible: !!(scene && Array.from(scene.querySelectorAll('.character-badge, [class*="character-badge"]')).some(isVisible)),
        labels: {
          caption: labelInfo(['.scene-caption']),
          route: labelInfo(['.route-label', '.route-label span']),
          location: labelInfo(['.location-chip']),
          stamp: labelInfo(['.scene-stamp'])
        }
      };
    })()`,
    { awaitPromise: false }
  );
}

async function stubShare(page, { mode = "native" } = {}) {
  return page.eval(
    `(() => {
      window.__qaShare = { calls: [], opens: [], error: null };
      const record = (data) => {
        window.__qaShare.calls.push({
          title: data && data.title,
          text: data && data.text,
          url: data && data.url,
          files: Array.from((data && data.files) || []).map((file) => ({ name: file.name, type: file.type, size: file.size }))
        });
        return Promise.resolve();
      };
      try {
        if (${mode === "native" ? "true" : "false"}) {
          Object.defineProperty(navigator, "canShare", { configurable: true, value: (data) => !!data && Array.isArray(data.files) && data.files.length > 0 });
          Object.defineProperty(navigator, "share", { configurable: true, value: record });
        } else {
          Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
          Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
        }
      } catch (error) {
        window.__qaShare.error = String(error);
      }
      window.open = (url) => { window.__qaShare.opens.push(String(url)); return null; };
      return true;
    })()`,
    { awaitPromise: false }
  );
}

async function assetAudit(page, specs) {
  const result = await page.eval(
    `Promise.all(${JSON.stringify(specs)}.map(async (spec) => {
      try {
        const response = await fetch(spec.path, { cache: "no-store" });
        const text = await response.text();
        const isSvg = /\\.svg($|\\?)/i.test(spec.path);
        let xmlValid = null;
        let viewBox = null;
        let width = null;
        let height = null;
        if (isSvg) {
          const doc = new DOMParser().parseFromString(text, "image/svg+xml");
          const error = doc.querySelector("parsererror");
          xmlValid = !error;
          const svg = doc.querySelector("svg");
          viewBox = svg ? svg.getAttribute("viewBox") : null;
          width = svg ? svg.getAttribute("width") : null;
          height = svg ? svg.getAttribute("height") : null;
        }
        return { ...spec, status: response.status, bytes: text.length, isSvg, xmlValid, viewBox, width, height, text };
      } catch (error) {
        return { ...spec, status: 0, error: String(error) };
      }
    }))`,
    { awaitPromise: true }
  );
  return result.map((item) => ({ ...item, hash: crypto.createHash("sha256").update(String(item.text || "")).digest("hex").slice(0, 16) }));
}

async function fontAudit(page, { mobile = false } = {}) {
  return page.eval(
    `(() => {
      const selectors = ['.eyebrow', '.mono-label', '.hero-tag', '.step-meta', '.scene-stamp', '.location-chip', '.route-label'];
      const sizes = [];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        sizes.push({ selector, fontSize: parseFloat(getComputedStyle(el).fontSize), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) });
      }
      const truncation = [];
      document.querySelectorAll('p, h1, h2, h3, span, b, strong, li, button, a').forEach((el) => {
        if (el.children.length > 0) return;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (!el.getClientRects().length) return;
        if (el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(style.overflowX + style.overflowY)) {
          truncation.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70), client: el.clientWidth, scroll: el.scrollWidth, overflow: style.overflow, textOverflow: style.textOverflow });
        }
      });
      const heroSub = document.querySelector('.hero-sub, .hero-copy p');
      return {
        sizes,
        bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
        heroSubFont: heroSub ? parseFloat(getComputedStyle(heroSub).fontSize) : null,
        truncation: truncation.slice(0, 20),
        mobile: ${mobile ? "true" : "false"}
      };
    })()`,
    { awaitPromise: false }
  );
}

async function contentV2Scenario(page, report, driver) {
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  const data = await driver.loadData();
  report.check("content-v2.data", !!data && Array.isArray(data.characters) && Array.isArray(data.intro), !!data);

  // K1–K2: интро
  const intro = (data && data.intro) || [];
  report.check("content-v2.intro-length", intro.length === 5, intro.length);
  const expectedSpeakers = ["narrator", "bubble", "chief", "bubble", "chief"];
  report.check("content-v2.intro-speaker-order", JSON.stringify(intro.map((line) => line.speaker)) === JSON.stringify(expectedSpeakers), intro.map((line) => line.speaker));
  const introJson = JSON.stringify(intro);
  report.check("content-v2.no-0742", !/0?7:42/.test(introJson), (introJson.match(/0?7:42/g) || []).slice(0, 5));
  const narrator = data && data.speakers && data.speakers.narrator;
  report.check("content-v2.narrator-speaker", !!narrator && narrator.name === "Очаково" && /проходная/i.test(narrator.role || "") && narrator.initials === "О", narrator);
  report.check("content-v2.bubble-first-intro", /б о и т с я Шефа|боится Шефа/i.test(intro[1] ? intro[1].text : ""), intro[1] && intro[1].text);
  report.check("content-v2.chief-capital", /Шеф/.test(intro[1] ? intro[1].text : "") && !/шеф/.test(intro[1] ? intro[1].text.replace(/Шеф/g, "") : ""), intro[1] && intro[1].text);

  // K3: тайминг
  const expectedTimes = {
    brewer: ["08:10", "11:20", "15:40"],
    packer: ["08:20", "12:05", "16:10"],
    lab: ["08:05", "11:35", "15:25"]
  };
  const timingProblems = [];
  for (const char of (data && data.characters) || []) {
    const times = char.steps.map((step) => step.time);
    if (JSON.stringify(times) !== JSON.stringify(expectedTimes[char.id])) timingProblems.push({ charId: char.id, actual: times, expected: expectedTimes[char.id] });
  }
  report.check("content-v2.timing", timingProblems.length === 0, timingProblems);
  const dataJson = JSON.stringify(data || {});
  report.check("content-v2.no-early-end", !/конец[^.]{0,20}10\s*утра/i.test(dataJson));

  // K4: обязанности вакансий
  const vacancyProblems = [];
  for (const char of (data && data.characters) || []) {
    const responsibilities = char.vacancy && char.vacancy.responsibilities;
    if (!Array.isArray(responsibilities) || responsibilities.length !== 3 || responsibilities.some((item) => typeof item !== "string" || item.trim().length < 5)) {
      vacancyProblems.push({ charId: char.id, responsibilities });
    }
  }
  report.check("content-v2.vacancy-responsibilities", vacancyProblems.length === 0, vacancyProblems);

  // K5: контент
  report.check("content-v2.data-no-age-markers", !/(?<!\d)0\s*%|безалкогольн|18\s*\+/.test(dataJson), (dataJson.match(/(?<!\d)0\s*%|безалкогольн|18\s*\+/gi) || []).slice(0, 8));
  report.check("content-v2.data-no-beer", !/пив|хмел/i.test(dataJson));

  // K6: структура и типы заданий
  const expectedTypes = {
    brewer: ["pick", "sort", "choice"],
    packer: ["defect", "choice", "sort"],
    lab: ["ph", "samples", "choice"]
  };
  const structureProblems = [];
  for (const char of (data && data.characters) || []) {
    if (!expectedTypes[char.id]) continue;
    if (char.steps.length !== 3) structureProblems.push({ charId: char.id, steps: char.steps.length });
    const types = char.steps.map((step) => step.task.type);
    if (JSON.stringify(types) !== JSON.stringify(expectedTypes[char.id])) structureProblems.push({ charId: char.id, types, expected: expectedTypes[char.id] });
  }
  report.check("content-v2.structure", structureProblems.length === 0, structureProblems);
  report.check("content-v2.character-ids", JSON.stringify(((data && data.characters) || []).map((char) => char.id)) === JSON.stringify(["brewer", "packer", "lab"]), ((data && data.characters) || []).map((char) => char.id));

  // выраженный контент: все 5 реплик интро и их спикеры
  await page.click('[data-action="start-quest"]');
  await sleep(300);
  const visibleSteps = [];
  for (let index = 0; index < 8; index += 1) {
    const snapshot = await introSnapshot(page);
    if (!snapshot.present) break;
    visibleSteps.push({ index, text: snapshot.text, names: snapshot.names });
    if (!snapshot.nextText) break;
    if (/выбрать героя/i.test(snapshot.nextText)) {
      await page.click('[data-action="intro-next"]');
      break;
    }
    await page.click('[data-action="intro-next"]');
    await sleep(220);
  }
  report.check("content-v2.intro-rendered", visibleSteps.length === 5, visibleSteps.map((step) => step.index));
  report.check("content-v2.intro-no-0742-rendered", !visibleSteps.some((step) => /0?7:42/.test(step.text)));
  const renderedSpeakers = visibleSteps.map((step) => (step.names[0] || ""));
  report.check("content-v2.intro-speakers-visible", renderedSpeakers.filter(Boolean).length >= 3 && renderedSpeakers[0] && /Очаково/i.test(renderedSpeakers[0]), renderedSpeakers);
  await checkConsole(page, report, "content-v2");
}

async function landingIntroV2Scenario(page, report, driver) {
  const data = await driver.loadData();
  const viewports = [
    { width: 1440, height: 1000, mobile: false, label: "desktop" },
    { width: 390, height: 844, mobile: true, label: "mobile-390" },
    { width: 360, height: 740, mobile: true, label: "mobile-360" }
  ];
  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: viewport.mobile, dpr: viewport.mobile ? 3 : 1 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    await sleep(400);

    const landing = await page.eval(
      `(() => {
        const find = (selectors) => { for (const selector of selectors) { const el = document.querySelector(selector); if (el) return el; } return null; };
        const eyebrow = find(['.eyebrow', '.landing .eyebrow']);
        const h1 = find(['.hero-title', '.landing h1', 'h1']);
        const guide = find(['.hero-guide-note', '.hero-guide p', '.hero-guide']);
        const badge = find(['.hero-side-note', '.hero-badge', '.landing-badge']);
        const ageBadge = find(['.age-badge', '[class*="age-badge"]']);
        const rect = (el) => (el ? el.getBoundingClientRect() : null);
        const text = document.body.innerText || '';
        return {
          eyebrow: rect(eyebrow),
          h1: rect(h1),
          guideFont: guide ? parseFloat(getComputedStyle(guide).fontSize) : null,
          badge: badge ? { text: (badge.textContent || '').replace(/\\s+/g, ' ').trim(), fontSize: parseFloat(getComputedStyle(badge).fontSize), rect: rect(badge) } : null,
          ageBadge: !!ageBadge,
          bodyText: text.slice(0, 4000),
          kbdCount: document.querySelectorAll('kbd').length,
          hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        };
      })()`,
      { awaitPromise: false }
    );
    const overlap = landing.eyebrow && landing.h1 ? landing.h1.top < landing.eyebrow.bottom - 2 : null;
    report.check(`landing-v2-${viewport.label}.h1-no-eyebrow-overlap`, overlap === false, { eyebrow: landing.eyebrow, h1: landing.h1 });
    report.check(`landing-v2-${viewport.label}.no-phone-meta`, !/с телефона/i.test(landing.bodyText));
    report.check(`landing-v2-${viewport.label}.no-test-phrase`, !/не тест на знание|знание напитков/i.test(landing.bodyText));
    if (viewport.mobile && landing.guideFont !== null && landing.guideFont < 14) {
      report.warnCheck(`landing-v2-${viewport.label}.guide-size`, { fontSize: landing.guideFont, expected: "14–16 (на мобиле сейчас меньше — P2)" });
    } else {
      report.check(`landing-v2-${viewport.label}.guide-size`, landing.guideFont === null || landing.guideFont >= 14, landing.guideFont);
    }
    report.check(`landing-v2-${viewport.label}.badge`, !!landing.badge && /ПЕРВАЯ СМЕНА/i.test(landing.badge.text) && /7\s*МИНУТ/i.test(landing.badge.text), landing.badge);
    report.check(`landing-v2-${viewport.label}.no-age-badge`, !landing.ageBadge && !/(?<!\d)0\s*%|безалкогольн/i.test(landing.bodyText));
    report.check(`landing-v2-${viewport.label}.no-enter-hints`, !/\bEnter\b/.test(landing.bodyText) && landing.kbdCount === 0, { kbd: landing.kbdCount });
    report.check(`landing-v2-${viewport.label}.no-hscroll`, !landing.hscroll);

    const fonts = await fontAudit(page, { mobile: viewport.mobile });
    const threshold = viewport.mobile ? 10 : 11;
    const tooSmall = fonts.sizes.filter((item) => item.fontSize < threshold);
    report.check(`landing-v2-${viewport.label}.micro-font`, tooSmall.length === 0, tooSmall);
    if (viewport.label === "desktop") report.check("landing-v2.desktop.hero-sub-font", !fonts.heroSubFont || fonts.heroSubFont >= 15, fonts.heroSubFont);
    await report.shot(page, `landing-${viewport.label}`);

    // интро: 5 реплик, in-place, левый спикер
    await page.click('[data-action="start-quest"]');
    await sleep(350);
    const initial = await introSnapshot(page);
    if (!initial.present) {
      report.check(`landing-v2-${viewport.label}.intro-present`, false);
      continue;
    }
    report.check(`landing-v2-${viewport.label}.intro-present`, true);
    const introData = (data && data.intro) || [];
    const speakerInfo = (data && data.speakers) || {};
    const steps = [];
    for (let index = 0; index < 6; index += 1) {
      const snapshot = await introSnapshot(page);
      if (!snapshot.present) break;
      if (index === 0) {
        await page.eval("window.__qaIntroScreen = document.querySelector('.intro-screen, .screen.intro-screen, #app > .screen')", { awaitPromise: false });
      }
      const expectedSpeaker = introData[index] ? introData[index].speaker : null;
      const expected = expectedSpeaker && speakerInfo[expectedSpeaker] ? speakerInfo[expectedSpeaker] : null;
      const expectedAvatar = expected && expected.avatar ? expected.avatar.split("/").pop() : null;
      const leftOk = expectedAvatar ? String(snapshot.imgSrc || "").includes(expectedAvatar) : (snapshot.leftText.includes("Очаково") || /(^|\s)О($|\s)/.test(snapshot.leftText) || (snapshot.names || []).some((name) => /Очаково/i.test(name)));
      steps.push({
        index,
        text: snapshot.text.slice(0, 120),
        expectedSpeaker,
        leftOk,
        animationName: snapshot.animationName,
        runningAnimations: snapshot.runningAnimations,
        scrollY: snapshot.scrollY,
        sameRef: index === 0 ? null : snapshot.sameRef,
        refConnected: index === 0 ? null : snapshot.refConnected,
        screenCount: snapshot.screenCount
      });
      if (index === 0) {
        const initialScroll = snapshot.scrollY;
        await page.eval(`window.__qaIntroInitialScroll = ${initialScroll}`, { awaitPromise: false });
      }
      const isLast = index === 4 || /выбрать героя/i.test(snapshot.nextText);
      if (isLast) break;
      await page.click('[data-action="intro-next"]');
      await sleep(250);
    }
    report.check(`landing-v2-${viewport.label}.intro-5-steps`, steps.length === 5, steps.length);
    report.check(`landing-v2-${viewport.label}.intro-left-speaker`, steps.every((step) => step.leftOk !== false), steps.map((step) => ({ index: step.index, expected: step.expectedSpeaker, leftOk: step.leftOk })));
    const notInPlace = steps.filter((step) => step.index > 0 && (step.sameRef === false || step.refConnected === false || step.screenCount > 1 || step.runningAnimations > 0));
    report.check(`landing-v2-${viewport.label}.intro-in-place`, notInPlace.length === 0, notInPlace);
    const scrolled = steps.filter((step) => step.index > 0 && step.scrollY > 2);
    report.check(`landing-v2-${viewport.label}.intro-no-scroll`, scrolled.length === 0, scrolled);
    await report.shot(page, `intro-${viewport.label}`);
    await checkConsole(page, report, `landing-v2-${viewport.label}`);
  }
}

async function chatV2Scenario(page, report, driver) {
  const viewports = [
    { width: 1440, height: 1000, mobile: false, label: "desktop" },
    { width: 390, height: 844, mobile: true, label: "mobile-390" },
    { width: 844, height: 390, mobile: true, label: "landscape" }
  ];
  const data = await driver.loadData();
  const characters = (data && data.characters) || [];
  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: viewport.mobile, dpr: viewport.mobile ? 3 : 1 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    await page.click('[data-action="start-quest"]');
    await sleep(300);
    if ((await page.screen()) === "intro") {
      await page.click('[data-action="intro-skip"]');
      await page.waitScreen("characters");
    }
    await page.waitScreen("characters");
    const firstChar = characters[0];
    await driver.selectCharacter(firstChar.id);
    await page.waitScreen("game");
    await sleep(300);

    // при входе в этап показано первое сообщение; «Дальше» добавляет второе
    if (await page.exists('[data-action="next-beat"]')) {
      await page.click('[data-action="next-beat"]');
      await sleep(320);
    }
    const first = await chatSnapshot(page);
    report.check(`chat-${viewport.label}.container`, first.hasContainer, { selector: first.containerSelector, cls: first.containerClass });
    report.check(`chat-${viewport.label}.messages`, first.count >= 2, first.count);
    const hasSrc = first.messages.some((message) => message.src);
    const heroMsgs = first.messages.filter((message) => !message.isOwn && !message.isSystem);
    const guideMsgs = first.messages.filter((message) => message.isOwn);
    const alignmentProblems = [];
    for (const message of heroMsgs) {
      if (first.containerLeft !== null && message.left > first.containerLeft + 60) alignmentProblems.push({ kind: "hero-not-left", message });
    }
    for (const message of guideMsgs) {
      if (first.containerRight !== null && message.right < first.containerRight - 60) alignmentProblems.push({ kind: "guide-not-right", message });
    }
    report.check(`chat-${viewport.label}.hero-left-guide-right`, alignmentProblems.length === 0 && heroMsgs.length > 0 && guideMsgs.length > 0, { hero: heroMsgs.length, guide: guideMsgs.length, problems: alignmentProblems });
    report.check(`chat-${viewport.label}.avatars`, hasSrc || first.messages.every((message) => message.name), first.messages.slice(0, 4));
    report.check(`chat-${viewport.label}.names`, first.messages.filter((message) => message.name).length >= 1, first.messages.map((message) => message.name).slice(0, 4));
    report.check(`chat-${viewport.label}.no-scene-advice`, first.sceneAdviceVisible === false);
    report.check(`chat-${viewport.label}.no-scene-badge`, first.sceneBadgeVisible === false);
    const labelsVisible = first.labels.caption.some((label) => label.visible) || first.labels.route.some((label) => label.visible);
    if (viewport.mobile) report.check(`chat-${viewport.label}.labels-visible`, labelsVisible, { caption: first.labels.caption, route: first.labels.route });
    const chips = [...first.labels.location, ...first.labels.stamp].filter((label) => label.fontSize > 0);
    const smallChips = chips.filter((label) => label.fontSize < (viewport.mobile ? 10 : 11));
    report.check(`chat-${viewport.label}.chips-readable`, smallChips.length === 0, smallChips);

    // «Дальше» добавляет сообщение без полной перерисовки
    const beforeCount = first.count;
    const beforeFirstText = first.messages[0] ? first.messages[0].text : "";
    await page.click('[data-action="next-beat"]');
    await sleep(350);
    const second = await chatSnapshot(page);
    report.check(`chat-${viewport.label}.message-appended`, second.count > beforeCount, { before: beforeCount, after: second.count });
    report.check(`chat-${viewport.label}.history-preserved`, second.messages.some((message) => message.text === beforeFirstText), { first: beforeFirstText.slice(0, 60) });
    report.check(`chat-${viewport.label}.in-place`, second.sameNode !== false, second.sameNode);
    const routeLabels = await page.eval(
      `(() => Array.from(document.querySelectorAll('.route-label, .scene-caption')).map((el) => ({ text: (el.textContent || '').trim(), display: getComputedStyle(el).display, visible: el.getBoundingClientRect().width > 0 })))()`,
      { awaitPromise: false }
    );
    if (viewport.mobile) report.check(`chat-${viewport.label}.labels-not-hidden`, routeLabels.filter((label) => label.text).every((label) => label.visible && label.display !== "none"), routeLabels);
    await page.eval("window.scrollTo(0, 0)", { awaitPromise: false });
    await sleep(250);
    const titleInfo = await page.eval(
      `(() => {
        const title = document.querySelector('.quest-title');
        const panel = document.querySelector('.quest-panel, .game-panel, .quest-right');
        const scene = document.querySelector('.scene-panel');
        if (!title) return null;
        const rect = title.getBoundingClientRect();
        const panelRect = panel ? panel.getBoundingClientRect() : null;
        const sceneRect = scene ? scene.getBoundingClientRect() : null;
        const intersects = (a, b) => !!(a && b && a.width > 0 && b.width > 0 && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1);
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const top = document.elementFromPoint(centerX, centerY);
        return {
          rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), height: Math.round(rect.height) },
          panel: panelRect ? { top: Math.round(panelRect.top), bottom: Math.round(panelRect.bottom) } : null,
          sceneOverlap: intersects(rect, sceneRect),
          covered: !!(top && !(title === top || title.contains(top))),
          insidePanel: !panelRect || (rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1)
        };
      })()`,
      { awaitPromise: false }
    );
    if (titleInfo && viewport.mobile) {
      report.check(`chat-${viewport.label}.title-not-clipped`, titleInfo.rect.height > 0 && titleInfo.insidePanel && !titleInfo.sceneOverlap && !titleInfo.covered, titleInfo);
    }
    await report.shot(page, `chat-${viewport.label}`);
    await checkConsole(page, report, `chat-${viewport.label}`);
  }
}

async function formNoFileScenario(page, report, driver) {
  const data = await driver.loadData();
  const characters = (data && data.characters) || [];
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await driver.completeRoute(characters[0].id);
  await page.waitScreen("result");
  await driver.openApplyFromResult();
  await page.waitScreen("apply");
  await sleep(300);

  const formInfo = await page.eval(
    `(() => {
      const apply = document.querySelector('.apply-screen') || document.querySelector('#app');
      const text = apply ? apply.innerText : '';
      const vacancy = document.querySelector('.vacancy-card, aside');
      const responsibilities = [];
      if (vacancy) {
        vacancy.querySelectorAll('li, .vacancy-perk, [class*="responsib"] span, [class*="duty"]').forEach((el) => {
          const value = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (value) responsibilities.push(value.slice(0, 120));
        });
      }
      const fileInputs = document.querySelectorAll('input[type="file"]');
      const linkLabel = document.querySelector('label[for="fieldResumeLink"], .field label[for="fieldResumeLink"]');
      const linkInput = document.querySelector('#fieldResumeLink, input[name="resumeLink"]');
      const birthInput = document.querySelector('#fieldBirthDate, input[name="birthDate"]');
      const educationInput = document.querySelector('#fieldEducation, input[name="education"]');
      const educationLabel = document.querySelector('label[for="fieldEducation"]');
      return {
        fileInputs: fileInputs.length,
        fileField: !!document.querySelector('#fieldResume, input[name="resume"]'),
        applyText: text.slice(0, 6000),
        vacancyText: vacancy ? (vacancy.innerText || '').slice(0, 3000) : '',
        responsibilities: responsibilities.slice(0, 12),
        linkLabel: linkLabel ? (linkLabel.textContent || '').replace(/\\s+/g, ' ').trim() : null,
        linkInput: !!linkInput,
        linkRequired: linkInput ? linkInput.required : null,
        birthDate: birthInput ? { present: true, required: birthInput.required, min: birthInput.getAttribute('min'), type: birthInput.type } : { present: false },
        birthLabel: (document.querySelector('label[for="fieldBirthDate"]') || {}).textContent || '',
        education: educationInput ? { present: true, required: educationInput.required } : { present: false },
        educationLabel: educationLabel ? (educationLabel.textContent || '').replace(/\\s+/g, ' ').trim() : null,
        applyFontSize: apply ? parseFloat(getComputedStyle(apply).fontSize) : null,
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    })()`,
    { awaitPromise: false }
  );
  report.check("form-nofile.no-file-input", formInfo.fileInputs === 0 && formInfo.fileField === false, { fileInputs: formInfo.fileInputs, fileField: formInfo.fileField });
  report.check("form-nofile.no-attach-text", !/прикрепить файл|выбери файл|резюме файлом/i.test(formInfo.applyText), (formInfo.applyText.match(/прикрепить файл|выбери файл|резюме файлом/gi) || []).slice(0, 3));
  report.check("form-nofile.card-title", /карточка стажёра/i.test(formInfo.applyText), formInfo.applyText.slice(0, 160));
  report.check("form-nofile.birthdate-required", formInfo.birthDate.present === true && formInfo.birthDate.min === "1900-01-01" && /\*/.test(String(formInfo.birthLabel || "")), { birthDate: formInfo.birthDate, label: formInfo.birthLabel });
  report.check("form-nofile.education-optional", formInfo.education.present === true && formInfo.education.required === false && /необязательно/i.test(String(formInfo.educationLabel || "")), { education: formInfo.education, label: formInfo.educationLabel });
  report.check("form-nofile.resume-link-optional", formInfo.linkInput === true && formInfo.linkRequired === false, { linkInput: formInfo.linkInput, required: formInfo.linkRequired });
  report.check("form-nofile.resume-link-label", !!formInfo.linkLabel && /необязательно/i.test(formInfo.linkLabel), formInfo.linkLabel);
  const vacancy = characters[0].vacancy;
  const expectedResponsibilities = (vacancy && vacancy.responsibilities) || [];
  const missingResponsibilities = expectedResponsibilities.filter((item) => !formInfo.vacancyText.includes(item) && !formInfo.responsibilities.some((value) => value.includes(item)));
  report.check("form-nofile.vacancy-responsibilities", expectedResponsibilities.length === 3 && missingResponsibilities.length === 0, { expected: expectedResponsibilities, missing: missingResponsibilities, rendered: formInfo.responsibilities });
  const vacancyTextLower = String(formInfo.vacancyText || "").toLowerCase();
  report.check(
    "form-nofile.vacancy-meta",
    !!formInfo.vacancyText && vacancyTextLower.includes(String(vacancy.title).toLowerCase()) && vacancyTextLower.includes(String(vacancy.location).toLowerCase()),
    formInfo.vacancyText.slice(0, 120)
  );
  await report.shot(page, "form-nofile-desktop");

  // мобильная вёрстка формы
  await page.setViewport({ width: 390, height: 844, mobile: true, dpr: 3 });
  await sleep(400);
  const mobileInfo = await page.eval(
    `(() => ({
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      fileInputs: document.querySelectorAll('input[type="file"]').length,
      submitVisible: (() => { const button = document.querySelector('#applyForm button[type="submit"]'); if (!button) return false; const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.height >= 40; })(),
      linkVisible: (() => { const el = document.querySelector('#fieldResumeLink, input[name="resumeLink"]'); if (!el) return false; const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1; })()
    }))()`,
    { awaitPromise: false }
  );
  report.check("form-nofile.mobile-layout", !mobileInfo.hscroll && mobileInfo.fileInputs === 0 && mobileInfo.submitVisible && mobileInfo.linkVisible, mobileInfo);
  await report.shot(page, "form-nofile-mobile");

  // отправка без резюме/ссылки
  await driver.fillApplyForm({ name: "Без Файла", phone: "+7 999 555-44-33", email: "nofile@example.com", education: "МГУ", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 8000 });
  const storage = await page.storage();
  const application = storage.state && (storage.state.applications || [])[0];
  report.check("form-nofile.submit-without-resume", !!application, application ? application.ticket : null);
  report.check("form-nofile.application-no-file", !!application && !application.resumeFile && !application.resume, application);
  report.check("form-nofile.application-birthdate", !!application && application.birthDate === "1996-05-14", application && application.birthDate);
  report.check("form-nofile.application-education", !!application && application.education === "МГУ", application && application.education);
  await report.shot(page, "form-nofile-success");
  await checkConsole(page, report, "form-nofile");
}

async function sharePdfScenario(page, report, driver) {
  await page.configureDownloads(DOWNLOADS_DIR);
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  const data = await driver.loadData();
  const characters = (data && data.characters) || [];
  const brewer = characters[0];

  // уникальные коды: два завершения одной смены
  await driver.completeRoute(brewer.id);
  await page.waitScreen("result");
  const firstCode = await page.text("#promoCode");
  const firstResult = await driver.resultInfo();
  report.check("share-pdf.result", firstResult.hasResultScreen, firstResult);
  report.check("share-pdf.code-format", !!firstCode && firstCode.length >= 6, firstCode);
  const stateFirst = await page.storage();
  const codeFirstStorage = stateFirst.state && stateFirst.state.completed && stateFirst.state.completed[brewer.id] && stateFirst.state.completed[brewer.id].code;

  await driver.completeRoute(brewer.id);
  await page.waitScreen("result");
  const secondCode = await page.text("#promoCode");
  const stateSecond = await page.storage();
  const codeSecondStorage = stateSecond.state && stateSecond.state.completed && stateSecond.state.completed[brewer.id] && stateSecond.state.completed[brewer.id].code;
  report.check("share-pdf.code-unique", !!firstCode && !!secondCode && firstCode !== secondCode && codeFirstStorage !== codeSecondStorage, { first: firstCode, second: secondCode });
  report.check("share-pdf.code-length", String(secondCode || "").length >= 6, secondCode);
  const appSource = await page.eval(`fetch("js/app.js", { cache: "no-store" }).then((response) => response.text())`, { awaitPromise: true });
  report.check("share-pdf.crypto-random", /getRandomValues|crypto\.randomUUID/.test(appSource), (appSource.match(/getRandomValues|crypto\.randomUUID/g) || []).slice(0, 3));

  // share-promo asset
  const shareAsset = await page.eval(
    `(async () => {
      for (const path of ["assets/share-promo.png", "assets/share-promo.svg"]) {
        try {
          const response = await fetch(path, { cache: "no-store" });
          if (response.status !== 200) continue;
          const blob = await response.blob();
          let width = null;
          let height = null;
          if (/\\.png$/i.test(path)) {
            try { const bitmap = await createImageBitmap(blob); width = bitmap.width; height = bitmap.height; } catch (error) {}
          }
          return { path, status: response.status, bytes: blob.size, width, height, type: blob.type };
        } catch (error) {}
      }
      return null;
    })()`,
    { awaitPromise: true }
  );
  report.check("share-pdf.share-asset", !!shareAsset && shareAsset.status === 200 && shareAsset.bytes > 0, shareAsset);
  if (shareAsset && /\.png$/i.test(shareAsset.path)) {
    report.check("share-pdf.share-asset-size", shareAsset.width === 1080 && shareAsset.height === 1350, shareAsset);
  }
  const shareSvgInfo = await page.eval(
    `(async () => {
      try {
        const response = await fetch("assets/share-promo.svg", { cache: "no-store" });
        if (response.status !== 200) return null;
        const text = await response.text();
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const svg = doc.querySelector("svg");
        return { viewBox: svg && svg.getAttribute("viewBox"), width: svg && svg.getAttribute("width"), height: svg && svg.getAttribute("height"), hasMarker: /0\\s*%|безалкогольн|18\\s*\\+/i.test(text) };
      } catch (error) { return null; }
    })()`,
    { awaitPromise: true }
  );
  if (shareSvgInfo) {
    report.check("share-pdf.share-svg-1080x1350", /1080/.test(String(shareSvgInfo.viewBox || shareSvgInfo.width || "")) && /1350/.test(String(shareSvgInfo.viewBox || shareSvgInfo.height || "")), shareSvgInfo);
    report.check("share-pdf.share-svg-no-markers", shareSvgInfo.hasMarker === false, shareSvgInfo);
  }

  // Web Share API: файл есть, кода в тексте нет
  await stubShare(page, { mode: "native" });
  await page.click('[data-action="share-result"]');
  await sleep(700);
  const shareCall = await page.eval("window.__qaShare ? window.__qaShare.calls[0] || null : null", { awaitPromise: false });
  report.check("share-pdf.web-share-called", !!shareCall, shareCall);
  if (shareCall) {
    report.check(
      "share-pdf.web-share-files",
      Array.isArray(shareCall.files) && shareCall.files.some((file) => /brodilka-share|share-promo/i.test(file.name) && /^image\//i.test(String(file.type || ""))),
      shareCall.files
    );
    report.check("share-pdf.web-share-text", /Сыграй в БРОДИЛКУ/i.test(String(shareCall.text || "")), shareCall.text);
    report.check("share-pdf.web-share-url", !!shareCall.url ? /^https?:|^file:/.test(String(shareCall.url)) : /https?:\/\//i.test(String(shareCall.text || "")), { url: shareCall.url, text: shareCall.text });
    const codeInShare = [shareCall.text, shareCall.title].some((value) => String(value || "").includes(secondCode));
    report.check("share-pdf.no-code-in-share", !codeInShare, { text: shareCall.text, code: secondCode });
  }

  // fallback: download/open image + toast, без ошибки
  await stubShare(page, { mode: "fallback" });
  const existing = await fsp.readdir(DOWNLOADS_DIR).catch(() => []);
  await page.click('[data-action="share-result"]');
  await sleep(800);
  const fallbackFiles = await page.waitForDownload({ existing, timeout: 6000 }).catch(() => null);
  const fallback = await page.eval("({ calls: (window.__qaShare || {}).calls || [], opens: (window.__qaShare || {}).opens || [], toast: (document.querySelector('#toast, .toast') || {}).textContent || '' })", { awaitPromise: false });
  const downloadsAfterShare = await fsp.readdir(DOWNLOADS_DIR).catch(() => []);
  const shareImageFile = downloadsAfterShare.find((name) => /^brodilka-share.*\.png$/i.test(name));
  const fallbackWorked = (fallbackFiles && fallbackFiles.length) || (fallback.opens && fallback.opens.length) || fallback.calls.length || /скачан|скопирован/i.test(fallback.toast);
  report.check("share-pdf.fallback", !!fallbackWorked, fallback);
  report.check("share-pdf.fallback-image", !!shareImageFile, { file: shareImageFile, toast: fallback.toast });
  report.check("share-pdf.fallback-no-error", !/не удалось|ошибка/i.test(fallback.toast), fallback.toast);
  await report.shot(page, "share-fallback");

  // PDF заявки
  await driver.openApplyFromResult();
  await page.waitScreen("apply");
  await driver.fillApplyForm({ name: "Пдф Тест", phone: "+7 999 222-33-44", email: "pdf@example.com", city: "Москва", link: "https://hh.ru/resume/pdf", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 8000 });
  const ticket = await page.text(".success-ticket b, .success-ticket");
  const existingBeforePdf = await fsp.readdir(DOWNLOADS_DIR).catch(() => []);
  await page.click('[data-action="download-application"]');
  await sleep(500);
  const pdfFiles = await page.waitForDownload({ existing: existingBeforePdf, timeout: 10000 }).catch(() => null);
  report.check("share-pdf.pdf-downloaded", !!pdfFiles, pdfFiles);
  if (pdfFiles && pdfFiles.length) {
    const fileName = pdfFiles[0];
    const buffer = await fsp.readFile(path.join(DOWNLOADS_DIR, fileName)).catch(() => Buffer.alloc(0));
    const pdf = inspectPdfBuffer(buffer, fileName);
    report.check("share-pdf.pdf-valid", pdf.isPdf && pdf.hasEof && pdf.pages === 1 && pdf.size > 5000, pdf);
    report.check("share-pdf.pdf-has-image", pdf.hasImage || pdf.hasJpeg, pdf);
    report.check("share-pdf.pdf-filename", /ochakovo-zayavka-.+\.pdf$/i.test(fileName), { fileName, ticket });
    report.check("share-pdf.pdf-not-txt", !/\.txt$/i.test(fileName), fileName);
  }
  await report.shot(page, "pdf-success");
  await checkConsole(page, report, "share-pdf");
}

async function artV2Scenario(page, report, driver) {
  const specs = [
    { path: "assets/scene-brew.svg", kind: "scene" },
    { path: "assets/scene-line.svg", kind: "scene" },
    { path: "assets/scene-lab.svg", kind: "scene" },
    { path: "assets/chief.svg", kind: "chief" },
    { path: "assets/share-promo.svg", kind: "share" }
  ];
  const assets = await assetAudit(page, specs);
  const byPath = Object.fromEntries(assets.map((asset) => [asset.path, asset]));
  for (const asset of assets) {
    report.check(`art-v2.${path.basename(asset.path)}.load`, asset.status === 200 && asset.bytes > 500, { status: asset.status, bytes: asset.bytes });
    report.check(`art-v2.${path.basename(asset.path)}.xml`, asset.isSvg ? asset.xmlValid === true : true, { xmlValid: asset.xmlValid });
    report.check(`art-v2.${path.basename(asset.path)}.no-markers`, !/0\s*%|безалкогольн|18\s*\+|пиво|пивовар|хмел/i.test(String(asset.text || "")), (String(asset.text || "").match(/0\s*%|безалкогольн|18\s*\+|пиво|пивовар|хмел/gi) || []).slice(0, 8));
  }
  const sceneAssets = assets.filter((asset) => asset.kind === "scene");
  const sceneDims = sceneAssets.map((asset) => ({ path: asset.path, viewBox: asset.viewBox, width: asset.width, height: asset.height }));
  const sceneDimsOk = sceneAssets.every((asset) => {
    const dims = String(asset.viewBox || asset.width + " " + asset.height || "").match(/(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/);
    if (asset.viewBox) {
      const parts = String(asset.viewBox).split(/[\s,]+/).map(Number);
      return parts[2] >= 1500 && parts[3] >= 900;
    }
    return dims && Number(dims[1]) >= 1500 && Number(dims[2]) >= 900;
  });
  report.check("art-v2.scenes-1600x1000", sceneDimsOk, sceneDims);
  report.check("art-v2.scenes-distinct", new Set(sceneAssets.map((asset) => asset.hash)).size === 3, sceneAssets.map((asset) => ({ path: asset.path, hash: asset.hash })));
  const chief = byPath["assets/chief.svg"];
  report.check("art-v2.chief-512", !!chief && (/512/.test(String(chief.viewBox || "")) || (/512/.test(String(chief.width || "")) && /512/.test(String(chief.height || "")))), chief ? { viewBox: chief.viewBox, width: chief.width, height: chief.height } : null);
  const shareSvg = byPath["assets/share-promo.svg"];
  report.check("art-v2.share-svg", !!shareSvg && shareSvg.status === 200 && /1080/.test(String(shareSvg.viewBox || shareSvg.width || "")) && /1350/.test(String(shareSvg.viewBox || shareSvg.height || "")), shareSvg ? { viewBox: shareSvg.viewBox, width: shareSvg.width, height: shareSvg.height } : null);

  const sharePng = await page.eval(
    `(async () => {
      try {
        const response = await fetch("assets/share-promo.png", { cache: "no-store" });
        if (response.status !== 200) return { status: response.status };
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        return { status: response.status, bytes: blob.size, width: bitmap.width, height: bitmap.height, type: blob.type };
      } catch (error) { return { status: 0, error: String(error) }; }
    })()`,
    { awaitPromise: true }
  );
  report.check("art-v2.share-png", sharePng.status === 200 && sharePng.width === 1080 && sharePng.height === 1350, sharePng);

  // рендер сцен на игровых экранах
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  const characters = (await driver.loadData()).characters;
  const rendered = [];
  for (const char of characters) {
    await driver.selectCharacter(char.id);
    await page.waitScreen("game");
    await sleep(300);
    const sceneImg = await page.eval(
      `(() => { const img = document.querySelector('.scene-panel img, .scene img, .scene-bg'); return img ? { src: img.getAttribute('src'), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete } : null; })()`,
      { awaitPromise: false }
    );
    rendered.push({ charId: char.id, sceneImg });
    await report.shot(page, `art-scene-${char.id}`);
    await driver.goToCharacters();
  }
  const renderedSrcs = rendered.map((item) => item.sceneImg && item.sceneImg.src).filter(Boolean);
  report.check("art-v2.scenes-rendered", rendered.every((item) => item.sceneImg && item.sceneImg.complete && item.sceneImg.naturalWidth > 0), rendered);
  report.check("art-v2.scenes-distinct-rendered", new Set(renderedSrcs).size === 3, renderedSrcs);
  await checkConsole(page, report, "art-v2");
}

async function readabilityV2Scenario(page, report, driver) {
  const data = await driver.loadData();
  const viewports = [
    { width: 1440, height: 1000, mobile: false, label: "desktop" },
    { width: 390, height: 844, mobile: true, label: "mobile-390" },
    { width: 360, height: 740, mobile: true, label: "mobile-360" },
    { width: 844, height: 390, mobile: true, label: "landscape" }
  ];
  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: viewport.mobile, dpr: viewport.mobile ? 3 : 1 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    await sleep(300);
    const landingFonts = await fontAudit(page, { mobile: viewport.mobile });
    const threshold = viewport.mobile ? 10 : 11;
    const smallLabels = landingFonts.sizes.filter((item) => item.fontSize < threshold);
    report.check(`readability-${viewport.label}.landing-fonts`, smallLabels.length === 0, smallLabels);
    report.check(`readability-${viewport.label}.landing-no-truncation`, landingFonts.truncation.length === 0, landingFonts.truncation);

    await page.click('[data-action="start-quest"]');
    await sleep(300);
    if ((await page.screen()) === "intro") {
      await page.click('[data-action="intro-skip"]');
      await page.waitScreen("characters");
    }
    await page.waitScreen("characters");
    const advice = await page.eval(
      `(() => {
        const guides = Array.from(document.querySelectorAll('.character-guide'));
        const grid = document.querySelector('.characters-grid');
        const labels = Array.from(document.body.querySelectorAll('*')).filter((el) => el.children.length === 0 && /Совет Пузыря/i.test(el.textContent || ''));
        return {
          count: guides.length,
          labelCount: labels.length,
          items: guides.map((guide) => {
            const text = guide.querySelector('p, .character-guide-text');
            const rect = guide.getBoundingClientRect();
            const textRect = text ? text.getBoundingClientRect() : rect;
            return {
              text: (guide.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
              fontSize: text ? parseFloat(getComputedStyle(text).fontSize) : null,
              top: Math.round(rect.top),
              textTop: Math.round(textRect.top),
              visible: rect.width > 0 && rect.height > 0
            };
          }),
          gridTop: grid ? Math.round(grid.getBoundingClientRect().top) : null
        };
      })()`,
      { awaitPromise: false }
    );
    report.check(`readability-${viewport.label}.advice-single`, advice.count === 1, advice);
    if (advice.items.length) {
      const item = advice.items[0];
      report.check(`readability-${viewport.label}.advice-size`, item.fontSize === null || item.fontSize >= 15, item);
      if (advice.gridTop !== null) report.check(`readability-${viewport.label}.advice-above-grid`, item.top < advice.gridTop, { adviceTop: item.top, gridTop: advice.gridTop });
    }
    await report.shot(page, `readability-characters-${viewport.label}`);

    await driver.selectCharacter(data.characters[0].id);
    await page.waitScreen("game");
    await sleep(300);
    const gameFonts = await fontAudit(page, { mobile: viewport.mobile });
    const gameSmall = gameFonts.sizes.filter((item) => item.fontSize < threshold);
    const criticalSmall = gameSmall.filter((item) => item.fontSize < (viewport.mobile ? 9 : 10));
    if (criticalSmall.length) {
      report.check(`readability-${viewport.label}.game-fonts`, false, criticalSmall);
    } else if (gameSmall.length) {
      report.warnCheck(`readability-${viewport.label}.game-fonts`, gameSmall);
    } else {
      report.check(`readability-${viewport.label}.game-fonts`, true);
    }
    const labels = await page.eval(
      `(() => {
        const selectors = ['.scene-caption', '.route-label', '.route-label span', '.location-chip', '.scene-stamp'];
        return selectors.map((selector) => ({ selector, items: Array.from(document.querySelectorAll(selector)).map((el) => ({ text: (el.textContent || '').trim().slice(0, 60), display: getComputedStyle(el).display, width: Math.round(el.getBoundingClientRect().width) })) }));
      })()`,
      { awaitPromise: false }
    );
    if (viewport.mobile) {
      const hiddenInformative = labels.filter((entry) => [".scene-caption", ".route-label", ".route-label span"].includes(entry.selector)).flatMap((entry) => entry.items).filter((item) => !item.text || item.display === "none" || item.width === 0);
      report.check(`readability-${viewport.label}.informative-labels`, hiddenInformative.length === 0, hiddenInformative);
    }
    const hscroll = await page.horizontalScroll();
    report.check(`readability-${viewport.label}.no-hscroll`, !hscroll.visibleOverflow && !(hscroll.canScrollX && !hscroll.hiddenOverflow), hscroll.visibleOverflow ? hscroll : undefined);
    await report.shot(page, `readability-game-${viewport.label}`);
    await checkConsole(page, report, `readability-${viewport.label}`);
  }
}



async function designThemeScenario(page, report, driver) {
  const DESIGN_KEY = "ochakovo-brodilka-design";
  const data = await driver.loadData();
  const characters = (data && data.characters) || [];
  const mark = characters[0];

  const readDesign = () =>
    page.eval(
      `(() => {
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
        const logo = document.querySelector('.brand-logo');
        const logoStyle = logo ? getComputedStyle(logo) : null;
        const logoRect = rect(logo);
        const mark = document.querySelector('.brand-mark');
        const mascots = Array.from(document.querySelectorAll('img[src*="mascot"]')).map((img) => ({ src: img.getAttribute('src'), filter: getComputedStyle(img).filter, naturalWidth: img.naturalWidth, visible: rect(img).width > 0 }));
        const primary = document.querySelector('.btn-primary');
        const footer = document.querySelector('.site-footer');
        const switchButtons = Array.from(document.querySelectorAll('.design-switch-btn'));
        const tokens = getComputedStyle(document.documentElement);
        return {
          design: document.documentElement.getAttribute('data-design'),
          theme: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          primaryBg: primary ? getComputedStyle(primary).backgroundColor : null,
          primaryColor: primary ? getComputedStyle(primary).color : null,
          footerBg: footer ? getComputedStyle(footer).backgroundColor : null,
          logo: logo ? { display: logoStyle.display, visibility: logoStyle.visibility, opacity: logoStyle.opacity, src: logo.getAttribute('src'), naturalWidth: logo.naturalWidth, rect: logoRect } : null,
          brandMark: mark ? { src: mark.getAttribute('src'), visible: rect(mark).width > 0 } : null,
          switch: {
            count: switchButtons.length,
            brandPressed: switchButtons.filter((b) => b.getAttribute('data-design-value') === 'brand').map((b) => b.getAttribute('aria-pressed')),
            brodilkaPressed: switchButtons.filter((b) => b.getAttribute('data-design-value') === 'brodilka').map((b) => b.getAttribute('aria-pressed'))
          },
          mascots,
          tokens: { lime: tokens.getPropertyValue('--lime').trim(), forest: tokens.getPropertyValue('--forest').trim(), cream: tokens.getPropertyValue('--cream').trim(), orange: tokens.getPropertyValue('--orange').trim() },
          hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          storedDesign: (() => { try { return localStorage.getItem(${JSON.stringify(DESIGN_KEY)}); } catch (error) { return 'err'; } })()
        };
      })()`,
      { awaitPromise: false }
    );

  const clickDesign = async (value) => {
    await page.eval("window.scrollTo(0, document.body.scrollHeight)", { awaitPromise: false });
    await sleep(150);
    await page.click(`[data-action="design-${value}"]`);
    await sleep(300);
  };

  // --- 1. Статика: brand.css строго под [data-design="brand"], brand assets 200 ---
  const brandCss = (await page.fetchTexts(["css/brand.css"]))[0];
  const cssText = String((brandCss && brandCss.text) || "");
  const preludes = [...cssText.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim().replace(/\s+/g, " "))
    .filter((prelude) => prelude && !prelude.startsWith("@") && !prelude.includes("@media") && !prelude.includes("@supports") && !prelude.startsWith("/*") && !/^(from|to|\d+(?:\.\d+)?%)$/.test(prelude) && !/^\d+%(?:, \d+%)*$/.test(prelude));
  const unscoped = preludes.filter((prelude) => !prelude.includes('html[data-design="brand"]'));
  report.check("design.brand-css-scoped", preludes.length > 50 && unscoped.length === 0, { rules: preludes.length, unscoped: unscoped.slice(0, 8) });

  const brandAssetPaths = [
    "assets/brand/ochakovo-logo.png",
    "assets/brand/ochakovo-logo-white.png",
    "assets/brand/ochakovo-mark.svg",
    "assets/brand/ornament.svg",
    "assets/brand/ornament-red.svg"
  ];
  const brandAssets = await page.eval(
    `Promise.all(${JSON.stringify(brandAssetPaths)}.map(async (path) => {
      try { const response = await fetch(path, { cache: "no-store" }); const blob = await response.blob(); return { path, status: response.status, bytes: blob.size, type: blob.type }; }
      catch (error) { return { path, status: 0, error: String(error) }; }
    }))`,
    { awaitPromise: true }
  );
  report.check("design.brand-assets-200", brandAssets.every((asset) => asset.status === 200 && asset.bytes > 0), brandAssets);

  const manifest = await page.eval(`fetch("manifest.webmanifest", { cache: "no-store" }).then((response) => response.json())`, { awaitPromise: true }).catch(() => null);
  report.check("design.manifest-colors", !!manifest && manifest.theme_color === "#D50032" && manifest.background_color === "#FFFFFF", manifest ? { theme: manifest.theme_color, background: manifest.background_color } : null);

  const swText = await page.eval(`fetch("sw.js", { cache: "no-store" }).then((response) => response.text())`, { awaitPromise: true });
  const swInfo = parseSwVersion(swText);
  report.check("design.sw-version", swInfo.number !== null && swInfo.number >= 10, swInfo);
  report.check("design.brand-css-cached-config", /brand\.css/.test(swText) && /assets\/brand\//.test(swText), { brandCss: /brand\.css/.test(swText), brandAssets: /assets\/brand\//.test(swText) });
  report.check("design.brand-preview-not-cached", !/brand-preview/.test(swText));

  // --- 2. Default brand на 4 viewport: лендинг, интро, герои, игра ---
  const viewports = [
    { width: 1440, height: 1000, mobile: false, label: "desktop" },
    { width: 390, height: 844, mobile: true, label: "mobile-390" },
    { width: 360, height: 740, mobile: true, label: "mobile-360" },
    { width: 844, height: 390, mobile: true, label: "landscape" }
  ];
  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: viewport.mobile, dpr: viewport.mobile ? 3 : 1 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    await sleep(400);
    let info = await readDesign();
    report.check(`design-${viewport.label}.default-brand`, info.design === "brand" && info.theme === "#D50032" && info.bodyBg === "rgb(255, 255, 255)", info);
    report.check(`design-${viewport.label}.brand-logo-visible`, !!info.logo && info.logo.display !== "none" && info.logo.visibility !== "hidden" && Number(info.logo.opacity) > 0.5 && info.logo.rect.width > 20 && info.logo.naturalWidth > 0, info.logo);
    report.check(`design-${viewport.label}.brand-red-cta`, info.primaryBg === "rgb(213, 0, 50)", { primaryBg: info.primaryBg, primaryColor: info.primaryColor });
    report.check(`design-${viewport.label}.switch-present`, info.switch.count === 2 && info.switch.brandPressed[0] === "true" && info.switch.brodilkaPressed[0] === "false", info.switch);
    report.check(`design-${viewport.label}.mascot-present`, info.mascots.some((mascot) => mascot.src && mascot.src.includes("mascot") && mascot.visible && mascot.naturalWidth > 0 && !/grayscale|sepia|hue-rotate|invert|brightness\(0\)/.test(String(mascot.filter))), info.mascots);
    report.check(`design-${viewport.label}.brand-no-hscroll`, !info.hscroll);
    await report.shot(page, `brand-landing-${viewport.label}`);

    await page.click('[data-action="start-quest"]');
    await sleep(300);
    if ((await page.screen()) === "intro") {
      info = await readDesign();
      report.check(`design-${viewport.label}.intro-brand`, info.design === "brand" && info.theme === "#D50032" && info.primaryBg === "rgb(213, 0, 50)", info);
      await report.shot(page, `brand-intro-${viewport.label}`);
      await page.click('[data-action="intro-skip"]');
    }
    await page.waitScreen("characters");
    info = await readDesign();
    report.check(`design-${viewport.label}.characters-brand`, info.design === "brand" && info.theme === "#D50032" && info.bodyBg === "rgb(255, 255, 255)", info);
    report.check(`design-${viewport.label}.characters-switch-footer`, info.switch.count === 2);
    await report.shot(page, `brand-characters-${viewport.label}`);

    await driver.selectCharacter(mark.id);
    await page.waitScreen("game");
    await sleep(300);
    if (await page.exists('[data-action="next-beat"]')) {
      await page.click('[data-action="next-beat"]');
      await sleep(300);
    }
    const gameInfo = await page.eval(
      `(() => ({
        design: document.documentElement.getAttribute('data-design'),
        theme: (document.querySelector('meta[name="theme-color"]') || {}).content,
        chat: !!document.querySelector('.chat-list'),
        mascot: Array.from(document.querySelectorAll('img[src*="mascot"]')).some((img) => img.getBoundingClientRect().width > 0 && !/grayscale|sepia|hue-rotate|invert|brightness\\(0\\)/.test(getComputedStyle(img).filter)),
        mascotInChat: Array.from(document.querySelectorAll('.chat-list img[src*="mascot"]')).some((img) => img.getBoundingClientRect().width > 0),
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      }))()`,
      { awaitPromise: false }
    );
    report.check(`design-${viewport.label}.game-brand`, gameInfo.design === "brand" && gameInfo.theme === "#D50032" && gameInfo.chat === true && gameInfo.mascot === true && gameInfo.hscroll === false, gameInfo);
    report.check(`design-${viewport.label}.mascot-in-chat`, gameInfo.mascotInChat === true, gameInfo);
    await report.shot(page, `brand-game-${viewport.label}`);
    await driver.goToCharacters();
  }

  // --- 3. Переключение темы: persist, reload без сброса прогресса, возврат ---
  await page.setViewport({ width: 390, height: 844, mobile: true, dpr: 3 });
  await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await page.click('[data-action="start-quest"]');
  await sleep(300);
  if ((await page.screen()) === "intro") await page.click('[data-action="intro-skip"]');
  await page.waitScreen("characters");
  await driver.selectCharacter(mark.id);
  await page.waitScreen("game");
  await page.click('[data-action="next-beat"]');
  await sleep(300);
  await page.click('[data-action="game-back"]');
  await page.waitScreen("characters");
  const questBefore = (await page.storage()).state && (await page.storage()).state.activeQuest;
  const stepsBefore = questBefore ? questBefore.stepIndex : null;

  await clickDesign("brodilka");
  let info = await readDesign();
  report.check("design-switch.brodilka", info.design === "brodilka" && info.theme === "#0C3B28" && info.logo.display === "none", info);
  report.check("design-switch.brodilka-tokens", info.tokens.lime === "#d7f35b" && info.tokens.forest === "#0c3b28" && info.tokens.cream === "#f3eedf" && info.tokens.orange === "#ff6b3d", info.tokens);
  report.check("design-switch.brodilka-cta", info.primaryBg === "rgb(215, 243, 91)", info.primaryBg);
  report.check("design-switch.persist-localstorage", info.storedDesign === "brodilka", info.storedDesign);
  report.check("design-switch.aria-pressed", info.switch.brodilkaPressed[0] === "true" && info.switch.brandPressed[0] === "false", info.switch);
  const questAfterSwitch = (await page.storage()).state && (await page.storage()).state.activeQuest;
  report.check("design-switch.no-state-reset", !!questAfterSwitch && questAfterSwitch.charId === mark.id && questAfterSwitch.stepIndex === stepsBefore, { before: questBefore, after: questAfterSwitch });
  await report.shot(page, "brodilka-characters-390");

  await page.reload();
  await page.waitScreen("landing");
  await sleep(400);
  info = await readDesign();
  const ctaAfterReload = await page.eval(
    `(() => ({ design: document.documentElement.getAttribute('data-design'), resume: !!document.querySelector('[data-action="resume-quest"]'), stored: (() => { try { return localStorage.getItem(${JSON.stringify(DESIGN_KEY)}); } catch (e) { return 'err'; } })() }))()`,
    { awaitPromise: false }
  );
  report.check("design-switch.reload-persists", info.design === "brodilka" && info.theme === "#0C3B28" && ctaAfterReload.resume === true && ctaAfterReload.stored === "brodilka", { design: info.design, theme: info.theme, ...ctaAfterReload });
  const questAfterReload = (await page.storage()).state && (await page.storage()).state.activeQuest;
  report.check("design-switch.reload-keeps-progress", !!questAfterReload && questAfterReload.charId === mark.id && questAfterReload.stepIndex === stepsBefore, questAfterReload);

  await page.click('[data-action="resume-quest"]');
  await page.waitScreen("game");
  await page.click('[data-action="game-back"]');
  await page.waitScreen("characters");
  await clickDesign("brand");
  info = await readDesign();
  report.check("design-switch.back-to-brand", info.design === "brand" && info.theme === "#D50032" && info.storedDesign === "brand" && info.logo.display !== "none", info);
  const stateAfterBack = (await page.storage()).state;
  report.check("design-switch.back-keeps-progress", !!(stateAfterBack && stateAfterBack.activeQuest && stateAfterBack.activeQuest.charId === mark.id), stateAfterBack && stateAfterBack.activeQuest);

  // --- 4. Промокод не обрезан на 390/360, финал/заявка в brand ---
  await page.click('[data-action="game-back"]').catch(() => {});
  await page.waitScreen("characters").catch(() => {});
  await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await driver.completeRoute(mark.id);
  await page.waitScreen("result");
  const promo = await page.eval(
    `(() => {
      const el = document.querySelector('#promoCode, .ticket-code');
      const code = el ? el.textContent.trim() : null;
      if (!el) return { missing: true };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        code,
        text: el.innerText.trim(),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        clipped: el.scrollWidth > el.clientWidth + 1 || el.textContent.trim().endsWith("…"),
        rect: { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) },
        viewport: document.documentElement.clientWidth,
        design: document.documentElement.getAttribute('data-design'),
        theme: (document.querySelector('meta[name="theme-color"]') || {}).content
      };
    })()`,
    { awaitPromise: false }
  );
  report.check("design.promo-present", !!promo && !promo.missing && !!promo.code && promo.code.length >= 6, promo);
  report.check("design.promo-not-clipped-390", promo.clipped === false && promo.rect.left >= 0 && promo.rect.right <= promo.viewport + 1, promo);
  report.check("design.result-brand", promo.design === "brand" && promo.theme === "#D50032", promo);
  const resultText = await page.eval("document.body.innerText", { awaitPromise: false });
  report.check("design.role-machinist-result", /машинист оборудования/i.test(resultText) && !/квасовар/i.test(resultText), (resultText.match(/машинист[^\n]*|квасовар[^\n]*/gi) || []).slice(0, 4));
  const resultConfetti = await page.eval(
    `(() => { const c = document.querySelector('.result-screen .confetti, .confetti'); return { count: c ? c.querySelectorAll('i').length : 0, z: c ? getComputedStyle(c).zIndex : null }; })()`,
    { awaitPromise: false }
  );
  report.check("design.result-confetti-bg", !!resultConfetti.count && Number(resultConfetti.z) === 0, resultConfetti);
  await report.shot(page, "brand-result-390");

  await page.setViewport({ width: 360, height: 740, mobile: true, dpr: 3 });
  await sleep(400);
  const promo360 = await page.eval(
    `(() => { const el = document.querySelector('#promoCode, .ticket-code'); if (!el) return null; const r = el.getBoundingClientRect(); return { text: el.innerText.trim(), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, clipped: el.scrollWidth > el.clientWidth + 1 || el.textContent.trim().endsWith("…"), right: Math.round(r.right), viewport: document.documentElement.clientWidth, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; })()`,
    { awaitPromise: false }
  );
  report.check("design.promo-not-clipped-360", !!promo360 && promo360.clipped === false && promo360.right <= promo360.viewport + 1 && promo360.hscroll === false, promo360);
  await report.shot(page, "brand-result-360");

  await page.setViewport({ width: 1440, height: 1000, mobile: false, dpr: 1 });
  await sleep(400);
  await report.shot(page, "brand-result-desktop");
  await page.click('[data-action="open-apply"]');
  await page.waitScreen("apply");
  await sleep(300);
  const applyInfo = await readDesign();
  report.check("design.apply-brand", applyInfo.design === "brand" && applyInfo.theme === "#D50032", applyInfo);
  report.check("design.apply-no-hscroll", !applyInfo.hscroll);
  await report.shot(page, "brand-apply-desktop");
  const vacancyText = await page.eval(`(() => String((document.querySelector('.vacancy-card, aside') || {}).innerText || ''))()`, { awaitPromise: false });
  report.check("design.role-machinist-apply", /машинист оборудования/i.test(vacancyText) && !/квасовар/i.test(vacancyText), String(vacancyText).slice(0, 300));

  // --- 5. PWA v10: кэш brand-ассетов, brand-preview не кэшируется, offline ---
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await page.waitForSelector("#app");
  await waitUntil(
    async () => {
      const info = await page.eval(
        `(async () => {
          const registrations = await navigator.serviceWorker.getRegistrations();
          return { count: registrations.length, active: registrations.some((r) => !!r.active), controller: !!navigator.serviceWorker.controller };
        })()`,
        { awaitPromise: true }
      ).catch(() => null);
      return info && info.count > 0 && info.active ? info : null;
    },
    { timeout: 15000, interval: 300, label: "brand SW registration" }
  ).catch(() => report.note("SW не зарегистрировался в design-theme"));
  await page.reload();
  await page.waitScreen("landing");
  await sleep(1200);
  const cached = await page.eval(
    `(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return { keys: await caches.keys(), urls };
    })()`,
    { awaitPromise: true }
  ).catch(() => ({ keys: [], urls: [] }));
  report.check("design.pwa-cache-brand", ["brand.css", "ochakovo-logo.png", "ochakovo-mark.svg", "ornament.svg", "splat.svg", "pop.svg"].every((needle) => cached.urls.some((url) => url.includes(needle))), { keys: cached.keys, missing: ["brand.css", "ochakovo-logo.png", "ochakovo-mark.svg", "ornament.svg", "splat.svg", "pop.svg"].filter((needle) => !cached.urls.some((url) => url.includes(needle))) });
  report.check("design.pwa-no-raster-patterns", !cached.urls.some((url) => /pattern-(red|white)\.jpg/i.test(url)), cached.urls.filter((url) => /pattern-/i.test(url)));
  const brandReferences = await page.fetchTexts(["index.html", "css/brand.css"]);
  report.check(
    "design.brand-preview-not-referenced",
    brandReferences.every((file) => !/brand-preview/i.test(String(file.text || ""))),
    brandReferences.map((file) => ({ file: file.file, referenced: /brand-preview/i.test(String(file.text || "")) }))
  );
  await page.setOffline(true);
  await page.reload({ timeout: 25000 }).catch((error) => report.note("offline brand reload: " + error.message));
  await sleep(800);
  const offline = await page.eval(
    `(() => ({ hasApp: !!document.querySelector('[data-action="start-quest"], [data-action="resume-quest"], #app'), design: document.documentElement.getAttribute('data-design'), body: (document.body ? document.body.innerText : '').slice(0, 80) }))()`,
    { awaitPromise: false }
  );
  report.check("design.pwa-offline-brand", offline.hasApp === true && offline.design === "brand", offline);
  await report.shot(page, "brand-offline");
  await page.setOffline(false);
  await page.reload().catch(() => {});
  await page.waitScreen("landing").catch(() => {});

  // --- 6. Брендинг: «квасовар» не встречается в видимом UI/README, машинист есть ---
  const readme = await page.fetchTexts(["README.md"]).catch(() => []);
  report.check("design.readme-no-kvasovar", readme.length > 0 && !/квасовар/i.test(String(readme[0].text || "")), (String((readme[0] || {}).text || "").match(/квасовар\S*/gi) || []).slice(0, 5));
  await checkConsole(page, report, "design-theme");
}

function extractPdfJpeg(buffer) {
  let start = -1;
  for (let index = 0; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 0xff && buffer[index + 1] === 0xd8) { start = index; break; }
  }
  if (start < 0) return null;
  for (let index = buffer.length - 2; index >= start; index -= 1) {
    if (buffer[index] === 0xff && buffer[index + 1] === 0xd9) return buffer.subarray(start, index + 2);
  }
  return null;
}

async function v18FinalScenario(page, report, driver) {
  await page.configureDownloads(DOWNLOADS_DIR);
  const data = await driver.loadData();
  const characters = data.characters || [];
  const mark = characters[0];
  const chooseChar = characters[2] || characters[0];
  const quickInfo = async () =>
    page.eval(
      `(() => {
        const form = document.querySelector("#applyForm");
        const role = document.querySelector("#fieldRole");
        return {
          eyebrow: (document.querySelector(".apply-head .eyebrow") || {}).textContent || "",
          title: (document.querySelector(".apply-head h1") || {}).textContent || "",
          quickAttr: form ? form.getAttribute("data-quick") : null,
          rolePresent: !!role,
          roleOptions: role ? Array.from(role.options).map((option) => option.value) : [],
          roleValue: role ? role.value : null,
          roleLabel: (document.querySelector('label[for="fieldRole"]') || {}).textContent || "",
          vacancyCard: !!document.querySelector(".apply-grid .vacancy-card"),
          homeButton: !!document.querySelector('[data-action="home"]'),
          hasBackResult: !!document.querySelector('[data-action="back-result"]'),
          hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        };
      })()`,
      { awaitPromise: false }
    );

  // 1) Лендинг → быстрый отклик без игры (desktop brand)
  await page.setViewport({ width: 1440, height: 1000, mobile: false, dpr: 1 });
  await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await sleep(500);
  const landingQuick = await page.eval(
    `(() => { const button = document.querySelector('[data-action="quick-apply"]'); if (!button) return { present: false }; const r = button.getBoundingClientRect(); return { present: true, text: (button.textContent || "").trim(), width: r.width, height: r.height, visible: r.width > 0 && r.height > 0 }; })()`,
    { awaitPromise: false }
  );
  report.check("v18.quick-landing-button", landingQuick.present && landingQuick.visible && /Заполнить без игры/i.test(landingQuick.text), landingQuick);
  await page.click('[data-action="quick-apply"]');
  await page.waitScreen("apply");
  await sleep(350);
  let info = await quickInfo();
  report.check("v18.quick-screen", /Без мини-игры/i.test(info.eyebrow) && /Сразу/i.test(info.title) && info.quickAttr === "true", info);
  report.check("v18.quick-role", info.rolePresent && info.roleOptions.length === characters.length && /\*/.test(info.roleLabel) && !info.vacancyCard, info);
  report.check("v18.quick-nav", info.homeButton && !info.hasBackResult && !info.hscroll, info);
  await page.eval(`(() => { const select = document.querySelector("#fieldRole"); if (select) { select.value = ${JSON.stringify(chooseChar.id)}; select.dispatchEvent(new Event("change", { bubbles: true })); } return true; })()`, { awaitPromise: false });
  info = await quickInfo();
  report.check("v18.quick-role-change", info.roleValue === chooseChar.id, info);
  await driver.submitApplyForm();
  await sleep(300);
  const emptyForm = await driver.formState();
  report.check("v18.quick-empty-errors", emptyForm.errors.length >= 4, emptyForm.errors);
  await driver.fillApplyForm({ birthDate: "1996-05-14", education: "МГУ", name: "Быстрый Отклик", phone: "+7 999 222-33-44", email: "quick@example.com", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 10000 });
  const successInfo = await page.eval(
    `(async () => {
      const storage = JSON.parse(localStorage.getItem("ochakovo-brodilka-v1") || "{}");
      const application = (storage.applications || [])[0] || null;
      const text = document.body.innerText;
      return {
        delivered: /HR получил карточку|Карточка сохранена/i.test(text),
        hasTicket: /HR-\\d{2}-\\d{4}/.test(text),
        home: !!document.querySelector('[data-action="home"]'),
        charId: application ? application.charId : null,
        vacancy: application ? application.vacancy : null,
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    })()`,
    { awaitPromise: true }
  );
  report.check("v18.quick-success", successInfo.delivered && successInfo.hasTicket && successInfo.home && !successInfo.hscroll, successInfo);
  report.check("v18.quick-data", successInfo.charId === chooseChar.id && String(successInfo.vacancy || "").includes(String(chooseChar.vacancy.title)), successInfo);
  const pdfBefore = fs.readdirSync(DOWNLOADS_DIR);
  await page.click('[data-action="download-application"]');
  await sleep(400);
  const downloaded = await page.waitForDownload({ existing: pdfBefore, timeout: 10000 }).catch(() => null);
  const pdfFiles = (downloaded || []).filter((name) => name.endsWith(".pdf"));
  if (pdfFiles && pdfFiles.length) {
    const pdfBuffer = await fsp.readFile(path.join(DOWNLOADS_DIR, pdfFiles[0])).catch(() => Buffer.alloc(0));
    const pdf = inspectPdfBuffer(pdfBuffer, pdfFiles[0]);
    report.check("v18.quick-pdf", pdf.isPdf && pdf.hasEof && pdf.pages >= 1 && pdf.hasImage, pdf);
  } else {
    report.check("v18.quick-pdf", false, { toast: await page.text("#toast") });
  }
  await report.shot(page, "v18-quick-success-desktop");
  await page.click('[data-action="home"]');
  await page.waitScreen("landing");

  // 2) Мобильный быстрый отклик и обе темы
  for (const viewport of [{ width: 390, height: 844, label: "390", design: "brand" }, { width: 360, height: 740, label: "360", design: "brodilka" }]) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: true, dpr: 3 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    if (viewport.design === "brodilka") {
      await page.eval("window.scrollTo(0, document.body.scrollHeight)", { awaitPromise: false });
      await page.click('[data-action="design-brodilka"]');
      await sleep(300);
      await page.eval("window.scrollTo(0, 0)", { awaitPromise: false });
    }
    const quickVisible = await page.eval(`(() => { const b = document.querySelector('[data-action="quick-apply"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, design: document.documentElement.getAttribute("data-design") }; })()`, { awaitPromise: false });
    report.check(`v18.quick-mobile-${viewport.label}-button`, !!quickVisible && quickVisible.visible && !quickVisible.hscroll && quickVisible.design === viewport.design, quickVisible);
    await page.click('[data-action="quick-apply"]');
    await page.waitScreen("apply");
    await sleep(300);
    const mobileInfo = await quickInfo();
    report.check(`v18.quick-mobile-${viewport.label}`, mobileInfo.rolePresent && mobileInfo.roleOptions.length === characters.length && !mobileInfo.hscroll, mobileInfo);
    await report.shot(page, `v18-quick-apply-${viewport.design}-${viewport.label}`);
  }

  // 3) Диалоги: «Назад» и «К диалогу» на 1440/390/360, обе темы
  const dialogueAudit = async (label, viewport, design) => {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: viewport.mobile, dpr: viewport.dpr });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    if (design === "brodilka") {
      await page.eval("window.scrollTo(0, document.body.scrollHeight)", { awaitPromise: false });
      await page.click('[data-action="design-brodilka"]');
      await sleep(250);
      await page.eval("window.scrollTo(0, 0)", { awaitPromise: false });
    }
    await page.click('[data-action="start-quest"]');
    await sleep(300);
    if ((await page.screen()) === "intro") await page.click('[data-action="intro-skip"]');
    await page.waitScreen("characters");
    await driver.selectCharacter(mark.id);
    await page.waitScreen("game");
    await sleep(300);
    const chatInfo = async () =>
      page.eval(
        `(() => {
          const back = document.getElementById("chatBackBtn");
          const next = document.getElementById("chatNextBtn");
          const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
          const b = rect(back); const n = rect(next);
          return {
            design: document.documentElement.getAttribute("data-design"),
            backPresent: !!back, backDisabled: back ? back.disabled : null, backVisible: !!(b && b.width > 0 && b.height > 0),
            nextText: next ? (next.textContent || "").trim() : null,
            overlap: !!(b && n && b.left < n.right && b.right > n.left && b.top < n.bottom && b.bottom > n.top),
            chatCount: document.querySelectorAll("#chatList .chat-message, #chatList .chat-row, #chatList > *").length,
            stepMeta: (document.querySelector(".step-meta") || {}).textContent || "",
            hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
          };
        })()`,
        { awaitPromise: false }
      );
    const first = await chatInfo();
    report.check(`v18.${label}.back-disabled-first`, first.backPresent && first.backDisabled === true && first.backVisible && !first.overlap && !first.hscroll, first);
    await page.click("#chatNextBtn");
    await sleep(300);
    const second = await chatInfo();
    report.check(`v18.${label}.back-enabled`, second.backDisabled === false && second.backVisible, second);
    const messagesBeforeBack = second.chatCount;
    await page.click("#chatBackBtn");
    await sleep(300);
    const third = await chatInfo();
    report.check(`v18.${label}.back-works`, third.backDisabled === true && third.chatCount < messagesBeforeBack, { before: messagesBeforeBack, after: third.chatCount, third });
    await page.click("#chatNextBtn");
    await sleep(250);
    let guard = 0;
    while ((await page.exists("#chatNextBtn")) && guard < 8) {
      await page.click("#chatNextBtn");
      await sleep(280);
      guard += 1;
    }
    await page.waitScreen("game");
    const taskInfo = await page.eval(
      `(() => {
        const back = document.querySelector('[data-action="back-dialogue"]');
        const r = back ? back.getBoundingClientRect() : null;
        return { present: !!back, visible: !!(r && r.width > 0 && r.height > 0), stepMeta: (document.querySelector(".step-meta") || {}).textContent || "", hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      })()`,
      { awaitPromise: false }
    );
    report.check(`v18.${label}.task-back-dialogue`, taskInfo.present && taskInfo.visible && !taskInfo.hscroll, taskInfo);
    await page.click('[data-action="back-dialogue"]');
    await sleep(350);
    const backInDialogue = await chatInfo();
    const stepAfter = backInDialogue.stepMeta;
    report.check(`v18.${label}.back-to-dialogue`, backInDialogue.backPresent && backInDialogue.backDisabled === false && backInDialogue.chatCount >= 2 && !backInDialogue.hscroll, backInDialogue);
    report.check(`v18.${label}.progress-preserved`, String(taskInfo.stepMeta).trim() === String(stepAfter).trim(), { before: taskInfo.stepMeta, after: stepAfter });
    await report.shot(page, `v18-dialogue-${design}-${viewport.width}`);
  };
  await dialogueAudit("dialogue-1440-brand", { width: 1440, height: 1000, mobile: false, dpr: 1 }, "brand");
  await dialogueAudit("dialogue-390-brodilka", { width: 390, height: 844, mobile: true, dpr: 3 }, "brodilka");
  await dialogueAudit("dialogue-360-brand", { width: 360, height: 740, mobile: true, dpr: 3 }, "brand");

  await checkConsole(page, report, "v18-final");
}

async function v14FinalScenario(page, report, driver, context) {
  await page.configureDownloads(DOWNLOADS_DIR);
  const data = await driver.loadData();
  const mark = data.characters[0];
  const mascotAudit = async (label, { requireSome = true, maxWidth = 120 } = {}) => {
    const mascots = await page.eval(
      `(() => Array.from(document.querySelectorAll('img[src="assets/mascot.svg"], img[src$="/mascot.svg"]')).filter((img) => { if (img.closest('.bubble-scene')) return false; const r = img.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map((img) => { const r = img.getBoundingClientRect(); return { src: img.getAttribute('src'), width: Math.round(r.width), height: Math.round(r.height), naturalWidth: img.naturalWidth, filter: getComputedStyle(img).filter, clipped: img.scrollWidth > img.clientWidth + 1 || img.scrollHeight > img.clientHeight + 1 }; }))()`,
      { awaitPromise: false }
    );
    const bad = mascots.filter((mascot) => mascot.width < 24 || mascot.width > maxWidth || Math.abs(mascot.width - mascot.height) > Math.max(4, mascot.width * 0.18));
    report.check(`${label}.mascot-sizes`, (!requireSome || mascots.length > 0) && bad.length === 0, { mascots, bad });
    return mascots;
  };
  const downloadPdf = async (label) => {
    await page.eval("(() => { const toast = document.querySelector('#toast'); if (toast) toast.classList.remove('is-visible'); return true; })()", { awaitPromise: false });
    const existing = await fsp.readdir(DOWNLOADS_DIR).catch(() => []);
    await page.scrollIntoView('[data-action="download-application"]');
    await sleep(150);
    await page.click('[data-action="download-application"]');
    await sleep(400);
    let files = await page.waitForDownload({ existing, timeout: 10000 }).catch(() => null);
    if (!files || !files.length) {
      // повторный программный клик, если тост/оверлей перехватил первый
      await page.eval(`(() => { const button = document.querySelector('[data-action="download-application"]'); if (button) button.click(); return true; })()`, { awaitPromise: false });
      files = await page.waitForDownload({ existing, timeout: 5000 }).catch(() => null);
    }
    if (!files || !files.length) {
      report.check(`${label}.pdf-downloaded`, false, { toast: await page.text("#toast"), files });
      return null;
    }
    const fileName = files[0];
    const buffer = await fsp.readFile(path.join(DOWNLOADS_DIR, fileName)).catch(() => Buffer.alloc(0));
    const pdf = inspectPdfBuffer(buffer, fileName);
    report.check(`${label}.pdf-valid`, pdf.isPdf && pdf.hasEof && pdf.pages >= 1 && pdf.size > 5000, pdf);
    report.check(`${label}.pdf-filename`, /ochakovo-zayavka-.+\.pdf$/i.test(fileName), fileName);
    const jpeg = extractPdfJpeg(buffer);
    if (jpeg) await fsp.writeFile(path.join(QA_DIR, "artifacts", `pdf-v14-${label}.jpg`), jpeg).catch(() => {});
    report.check(`${label}.pdf-image`, !!jpeg && jpeg.length > 10000, { bytes: jpeg ? jpeg.length : 0 });
    return { fileName, buffer, pdf };
  };

  // 1) Чистый брендовый hero: без растровых паттернов, новый маскот
  await page.setViewport({ width: 1440, height: 1000, mobile: false, dpr: 1 });
  await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await sleep(600);
  const heroInfo = await page.eval(
    `(() => {
      const backgrounds = ['.landing-hero', '.hero-art', '.hero-copy', '.hero-can', '.hero-guide'].map((selector) => {
        const el = document.querySelector(selector);
        return el ? { selector, backgroundImage: getComputedStyle(el).backgroundImage } : null;
      }).filter(Boolean);
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => /pattern-(red|white)|brand-preview/i.test(url));
      return {
        backgrounds,
        rasterRefs: resources,
        title: document.title,
        description: (document.querySelector('meta[name="description"]') || {}).content || '',
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        mascots: Array.from(document.querySelectorAll('img[src*="mascot"]')).filter((img) => img.getBoundingClientRect().width > 0).map((img) => ({ src: img.getAttribute('src'), width: Math.round(img.getBoundingClientRect().width) }))
      };
    })()`,
    { awaitPromise: false }
  );
  const rasterBackground = heroInfo.backgrounds.filter((item) => /\.jpe?g|pattern-/i.test(String(item.backgroundImage)));
  report.check("v14.hero-clean", rasterBackground.length === 0 && heroInfo.rasterRefs.length === 0, { rasterBackground, rasterRefs: heroInfo.rasterRefs });
  report.check("v14.hero-no-hscroll", !heroInfo.hscroll);
  report.check("v14.title-meta", /БРОДИЛКА/i.test(heroInfo.title) && heroInfo.description.length > 40, { title: heroInfo.title, description: heroInfo.description.slice(0, 100) });
  const landingMascots = await mascotAudit("v14-landing");
  report.check("v14.hero-mascot", landingMascots.some((mascot) => mascot.naturalWidth > 0 && mascot.width >= 60), landingMascots);
  const mascotAsset = await page.eval(`fetch("assets/mascot.svg", { cache: "no-store" }).then(async (response) => ({ status: response.status, text: await response.text() }))`, { awaitPromise: true });
  const mascotHash = crypto.createHash("sha256").update(String(mascotAsset.text || "")).digest("hex").toUpperCase();
  report.check(
    "v14.mascot-root-asset",
    mascotAsset.status === 200 && mascotAsset.text.length >= 5500 && mascotAsset.text.length <= 5600 && /gCapTop/.test(mascotAsset.text) && /gCapSide/.test(mascotAsset.text) && mascotHash === "732F89E485985877197D7865DCCF8FECA4E3D7CA59EC21C6B937D8AFFDC57039",
    { status: mascotAsset.status, bytes: mascotAsset.text.length, hash: mascotHash }
  );
  await report.shot(page, "v14-landing-brand");

  // Маскот на интро / героях / чате (новый ассет, 24–120px)
  await page.click('[data-action="start-quest"]');
  await sleep(350);
  if ((await page.screen()) === "intro") {
    if (await page.exists('[data-action="intro-next"]')) {
      await page.click('[data-action="intro-next"]');
      await sleep(350);
    }
    await mascotAudit("v14-intro", { requireSome: false, maxWidth: 360 });
    await report.shot(page, "v14-intro-mascot");
    await page.click('[data-action="intro-skip"]').catch(() => {});
  }
  await page.waitScreen("characters");
  await mascotAudit("v14-characters");
  await driver.selectCharacter(mark.id);
  await page.waitScreen("game");
  if (await page.exists('[data-action="next-beat"]')) {
    await page.click('[data-action="next-beat"]');
    await sleep(350);
  }
  await mascotAudit("v14-chat");
  await report.shot(page, "v14-chat-mascot");
  await driver.goToCharacters();
  await page.waitScreen("characters");

  // 2) Финал: взрыв/клякса, промокод, скрытие сцены ~1.6с
  await driver.completeRoute(mark.id);
  await page.waitScreen("result");
  await sleep(300);
  const splatInfo = await page.eval(
    `(() => {
      const scene = document.querySelector('.bubble-scene');
      const pop = document.querySelector('.bubble-scene-pop');
      const splat = document.querySelector('.promo-splat');
      const splatImg = document.querySelector('.promo-splat-img');
      const code = document.querySelector('#promoCode');
      const copy = document.querySelector('[data-action="copy-code"]');
      const openApply = document.querySelector('[data-action="open-apply"]');
      const stars = document.querySelector('.result-head-stars');
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
      const hit = (el) => { if (!el) return null; const pre = el.getBoundingClientRect(); window.scrollTo({ top: Math.max(0, window.scrollY + pre.top - Math.max(12, (window.innerHeight - pre.height) / 2)), left: 0, behavior: "instant" }); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(top && (el === top || el.contains(top) || top.contains(el))); };
      return {
        scenePresent: !!scene,
        sceneClass: scene ? String(scene.className) : null,
        scenePointerEvents: scene ? getComputedStyle(scene).pointerEvents : null,
        sceneOpacity: scene ? getComputedStyle(scene).opacity : null,
        popLoaded: !!(pop && pop.complete && pop.naturalWidth > 0),
        splatPresent: !!splat,
        splatImgLoaded: !!(splatImg && splatImg.complete && splatImg.naturalWidth > 0),
        code: code ? code.textContent.trim() : null,
        codeRect: rect(code),
        codeClipped: code ? code.scrollWidth > code.clientWidth + 1 || code.textContent.trim().endsWith("…") : null,
        copyHit: hit(copy),
        openApplyHit: hit(openApply),
        starsHit: hit(stars),
        stars: stars ? (stars.textContent || "").trim() : null,
        rewardText: (document.querySelector('.ticket-value strong') || {}).textContent || null,
        viewport: document.documentElement.clientWidth
      };
    })()`,
    { awaitPromise: false }
  );
  report.check("v14.result-splat", splatInfo.splatPresent && splatInfo.splatImgLoaded, splatInfo);
  report.check("v14.result-pop-scene", splatInfo.scenePresent && splatInfo.popLoaded, splatInfo);
  report.check("v14.result-no-overlap", splatInfo.copyHit === true && splatInfo.openApplyHit === true && splatInfo.starsHit === true, splatInfo);
  report.check("v14.result-promo", !!splatInfo.code && splatInfo.code.length >= 6 && splatInfo.codeClipped === false, splatInfo);
  report.check("v14.result-stars-reward", /3\s*\/\s*3/.test(String(splatInfo.stars)) && /150/.test(String(splatInfo.rewardText)), splatInfo);
  await report.shot(page, "v14-result-brand");
  await mascotAudit("v14-result-brand", { requireSome: false });
  const codeBeforeCopy = splatInfo.code;
  await page.click('[data-action="copy-code"]');
  await sleep(400);
  report.check("v14.copy-toast", /скопир/i.test(String(await page.text("#toast"))), await page.text("#toast"));

  await sleep(1600);
  const sceneAfter = await page.eval(
    `(() => { const scene = document.querySelector('.bubble-scene'); if (!scene) return { gone: true }; const style = getComputedStyle(scene); const r = scene.getBoundingClientRect(); const title = document.querySelector('.result-title'); const t = title ? title.getBoundingClientRect() : null; const top = t ? document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2) : null; return { gone: false, className: String(scene.className), opacity: style.opacity, visibility: style.visibility, pointerEvents: style.pointerEvents, display: style.display, width: Math.round(r.width), height: Math.round(r.height), titleBlocked: !!(top && scene.contains(top)) }; })()`,
    { awaitPromise: false }
  );
  report.check("v14.pop-scene-hides", sceneAfter.gone === true || sceneAfter.opacity === "0" || sceneAfter.visibility === "hidden" || sceneAfter.display === "none" || (sceneAfter.pointerEvents === "none" && sceneAfter.className.includes("is-done")) || sceneAfter.width === 0, sceneAfter);
  report.check("v14.pop-scene-not-blocking", sceneAfter.titleBlocked !== true, sceneAfter);
  await report.shot(page, "v14-result-settled");

  // 3) Форма «Карточка стажёра»: дата рождения/ВУЗ, валидации, PDF brand
  await driver.openApplyFromResult();
  await page.waitScreen("apply");
  await sleep(300);
  await mascotAudit("v14-form", { requireSome: false });
  await report.shot(page, "v14-form-mascot");
  const formFields = await page.eval(
    `(() => {
      const name = document.querySelector('#fieldName');
      const birth = document.querySelector('#fieldBirthDate');
      const education = document.querySelector('#fieldEducation');
      const file = document.querySelector('input[type="file"]');
      const labelFor = (id) => { const el = document.querySelector('label[for="' + id + '"]'); return el ? (el.textContent || '').trim() : ''; };
      return {
        title: (document.querySelector('.form-head h2') || {}).textContent || '',
        name: name ? { placeholder: name.placeholder } : null,
        birth: birth ? { min: birth.getAttribute('min'), type: birth.type } : null,
        education: education ? { placeholder: education.placeholder } : null,
        educationLabel: labelFor('fieldEducation'),
        labels: { name: labelFor('fieldName'), birthDate: labelFor('fieldBirthDate'), phone: labelFor('fieldPhone'), email: labelFor('fieldEmail') },
        fileInputs: file ? 1 : 0,
        hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    })()`,
    { awaitPromise: false }
  );
  report.check("v14.form-card", /Карточка стажёра/i.test(formFields.title), formFields);
  const requiredMarkers = ["name", "birthDate", "phone", "email"].every((key) => formFields.labels[key].includes("*"));
  report.check("v14.form-fields", !!formFields.name && !!formFields.birth && !!formFields.education && formFields.birth.type === "date" && formFields.birth.min === "1900-01-01" && /необязательно/i.test(formFields.educationLabel) && requiredMarkers, formFields);
  report.check("v14.form-no-file", formFields.fileInputs === 0);
  report.check("v14.form-no-hscroll", !formFields.hscroll);

  await driver.fillApplyForm({ birthDate: "2999-01-01", name: "Проверка Дат", phone: "+7 999 111-22-33", email: "date@example.com", consent: true });
  await driver.submitApplyForm();
  await sleep(300);
  let formState = await driver.formState();
  report.check("v14.form-future-date", formState.errors.some((error) => error.name === "birthDate"), formState.errors);
  await driver.fillApplyForm({ birthDate: "1899-12-31", name: "Проверка Дат", phone: "+7 999 111-22-33", email: "date@example.com", consent: true });
  await driver.submitApplyForm();
  await sleep(300);
  formState = await driver.formState();
  report.check("v14.form-old-date", formState.errors.some((error) => error.name === "birthDate"), formState.errors);
  await driver.fillApplyForm({ birthDate: "1996-05-14", education: "МГУ", name: "Проверка Дат", phone: "+7 999 111-22-33", email: "date@example.com", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 8000 });
  const storageAfterForm = await page.storage();
  const application = storageAfterForm.state && (storageAfterForm.state.applications || [])[0];
  report.check("v14.storage-birthdate", !!application && application.birthDate === "1996-05-14" && application.education === "МГУ", application);
  const brandPdf = await downloadPdf("brand");
  await report.shot(page, "v14-success-brand");

  // 4) Вторая тема: PDF под brodilka, коды/финал не сломаны
  await page.click('[data-action="home"]');
  await page.waitScreen("landing");
  await page.eval("window.scrollTo(0, document.body.scrollHeight)", { awaitPromise: false });
  await page.click('[data-action="design-brodilka"]');
  await sleep(400);
  const brodilkaTheme = await page.eval(`({ design: document.documentElement.getAttribute('data-design'), theme: (document.querySelector('meta[name="theme-color"]') || {}).content })`, { awaitPromise: false });
  report.check("v14.brodilka-theme", brodilkaTheme.design === "brodilka" && brodilkaTheme.theme === "#0C3B28", brodilkaTheme);
  await driver.completeRoute(mark.id);
  await page.waitScreen("result");
  await sleep(400);
  const brodilkaSplat = await page.eval(
    `(() => { const code = document.querySelector('#promoCode'); const splat = document.querySelector('.promo-splat-img'); const scene = document.querySelector('.bubble-scene'); return { code: code ? code.textContent.trim() : null, clipped: code ? code.scrollWidth > code.clientWidth + 1 : null, splat: !!(splat && splat.complete && splat.naturalWidth > 0), scene: !!scene, design: document.documentElement.getAttribute('data-design') }; })()`,
    { awaitPromise: false }
  );
  report.check("v14.brodilka-result", brodilkaSplat.design === "brodilka" && !!brodilkaSplat.code && brodilkaSplat.clipped === false && brodilkaSplat.splat === true, brodilkaSplat);
  await sleep(1700);
  await report.shot(page, "v14-result-brodilka-settled");
  await driver.openApplyFromResult();
  await page.waitScreen("apply");
  await driver.fillApplyForm({ birthDate: "1996-05-14", education: "МГУ", name: "Проверка Дат", phone: "+7 999 111-22-33", email: "date@example.com", consent: true });
  await driver.submitApplyForm();
  await page.waitScreen("success", { timeout: 8000 });
  const brodilkaPdf = await downloadPdf("brodilka");
  report.check("v14.pdf-theme-diff", !!(brandPdf && brodilkaPdf) && !brandPdf.buffer.equals(brodilkaPdf.buffer), { brand: brandPdf && brandPdf.pdf.size, brodilka: brodilkaPdf && brodilkaPdf.pdf.size });
  await report.shot(page, "v14-success-brodilka");

  // 5) Reduced motion: анимации отключены, контент и промокод доступны
  const reducedApplied = await page.setReducedMotion(true);
  await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await sleep(500);
  const reducedLanding = await page.eval(
    `(() => {
      const animations = document.getAnimations ? document.getAnimations({ subtree: true }) : [];
      const running = animations.filter((animation) => animation.playState === "running");
      const heroTitle = document.querySelector('.hero-title, .display');
      const style = heroTitle ? getComputedStyle(heroTitle) : null;
      return { matches: matchMedia("(prefers-reduced-motion: reduce)").matches, running: running.length, heroDuration: style ? style.animationDuration : null, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    })()`,
    { awaitPromise: false }
  );
  report.check("v14.reduced-motion-media", reducedApplied === true && reducedLanding.matches === true, reducedLanding);
  report.check("v14.reduced-motion-no-anim", reducedLanding.running === 0, reducedLanding);
  await driver.completeRoute(mark.id);
  await page.waitScreen("result");
  await sleep(1900);
  const reducedResult = await page.eval(
    `(() => {
      const running = (document.getAnimations ? document.getAnimations({ subtree: true }) : []).filter((animation) => animation.playState === "running");
      const code = document.querySelector('#promoCode');
      const scene = document.querySelector('.bubble-scene');
      return { running: running.length, code: code ? code.textContent.trim() : null, codeClipped: code ? code.scrollWidth > code.clientWidth + 1 : null, sceneGone: !scene || scene.className.includes("is-done") || getComputedStyle(scene).opacity === "0" || getComputedStyle(scene).display === "none", hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
    })()`,
    { awaitPromise: false }
  );
  report.check("v14.reduced-motion-result", reducedResult.running === 0 && !!reducedResult.code && reducedResult.codeClipped === false && reducedResult.sceneGone === true && !reducedResult.hscroll, reducedResult);
  await report.shot(page, "v14-reduced-motion-result");
  await page.setReducedMotion(false);

  // 6) PWA v14: кэш splat/pop/ornament, без pattern-*.jpg
  await page.navigate(page.baseUrl);
  await page.waitScreen("landing");
  await waitUntil(
    async () => {
      const info = await page.eval(`(async () => { const registrations = await navigator.serviceWorker.getRegistrations(); return { count: registrations.length, active: registrations.some((r) => !!r.active) }; })()`, { awaitPromise: true }).catch(() => null);
      return info && info.count > 0 && info.active ? info : null;
    },
    { timeout: 15000, interval: 300, label: "v14 SW registration" }
  ).catch(() => report.note("SW не зарегистрировался до PWA-проверок"));
  await page.reload();
  await page.waitScreen("landing");
  await sleep(1200);
  const pwaInfo = await page.eval(
    `(async () => {
      const urls = [];
      for (const key of await caches.keys()) { const cache = await caches.open(key); for (const request of await cache.keys()) urls.push(request.url); }
      const swText = await (await fetch("sw.js", { cache: "no-store" })).text();
      return { keys: await caches.keys(), urls, swVersion: (swText.match(/VERSION\\s*=\\s*["']([^"']+)["']/) || [])[1] || null, swTextOldMascot: /assets\\/mascot\\/mascot\\.svg/.test(swText), swTextRootMascot: /\\.\\/assets\\/mascot\\.svg/.test(swText) };
    })()`,
    { awaitPromise: true }
  ).catch(() => ({ keys: [], urls: [], swVersion: null }));
  const swNumber = parseSwVersion(`const VERSION = "${pwaInfo.swVersion || ""}"`).number;
  report.check("v14.sw-version", swNumber !== null && swNumber >= 15, { version: pwaInfo.swVersion, number: swNumber });
  report.check("v14.sw-mascot-path", pwaInfo.swTextRootMascot === true && pwaInfo.swTextOldMascot === false, pwaInfo);
  report.check("v14.cache-splat", ["splat.svg", "pop.svg", "ornament.svg"].every((needle) => pwaInfo.urls.some((url) => url.includes(needle))), { missing: ["splat.svg", "pop.svg", "ornament.svg"].filter((needle) => !pwaInfo.urls.some((url) => url.includes(needle))), keys: pwaInfo.keys });
  report.check("v14.cache-root-mascot", pwaInfo.urls.some((url) => /\/assets\/mascot\.svg$/i.test(url)) && !pwaInfo.urls.some((url) => /assets\/mascot\/mascot\.svg/i.test(url)), pwaInfo.urls.filter((url) => /mascot/i.test(url)));
  report.check("v14.cache-no-patterns", !pwaInfo.urls.some((url) => /pattern-(red|white)\.jpg/i.test(url)), pwaInfo.urls.filter((url) => /pattern-/i.test(url)));
  await page.setOffline(true);
  await page.reload({ timeout: 25000 }).catch((error) => report.note("v14 offline reload: " + error.message));
  await sleep(800);
  const offline = await page.eval(`({ hasApp: !!document.querySelector('[data-action="start-quest"], [data-action="resume-quest"], #app'), design: document.documentElement.getAttribute('data-design') })`, { awaitPromise: false });
  report.check("v14.offline", offline.hasApp === true, offline);
  await page.setOffline(false);
  const oldMascotIssues = page.networkEntries.filter((entry) => /assets\/mascot\/mascot\.svg/i.test(String(entry.url || entry.error || "")));
  report.check("v14.no-old-mascot-404", oldMascotIssues.length === 0, oldMascotIssues);
  await report.shot(page, "v14-offline");
  await checkConsole(page, report, "v14-final");
}

async function finalFixesScenario(page, report, driver) {
  const data = await driver.loadData();
  const characters = (data && data.characters) || [];
  const viewports = [
    { width: 390, height: 844, mobile: true, label: "390" },
    { width: 360, height: 740, mobile: true, label: "360" },
    { width: 844, height: 390, mobile: true, label: "landscape" },
    { width: 1440, height: 1000, mobile: false, label: "desktop" }
  ];

  const sceneBrew = await page.fetchTexts(["assets/scene-brew.svg"]);
  const sceneText = String((sceneBrew[0] && sceneBrew[0].text) || "");
  report.check("final-fixes.scene-time-label", /07:40/.test(sceneText) && /16:10/.test(sceneText), { hasStart: /07:40/.test(sceneText), hasEnd: /16:10/.test(sceneText) });

  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height, mobile: viewport.mobile, dpr: viewport.mobile ? 3 : 1 });
    await page.eval("try { localStorage.clear(); } catch (error) {}", { awaitPromise: false });
    await page.navigate(page.baseUrl);
    await page.waitScreen("landing");
    await sleep(400);

    const badge = await page.eval(
      `(() => {
        const note = document.querySelector('.hero-side-note, .hero-badge, [class*="side-note"]');
        const cta = document.querySelector('[data-action="start-quest"], [data-action="resume-quest"]');
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
        return {
          note: note ? { text: (note.textContent || '').replace(/\\s+/g, ' ').trim(), position: getComputedStyle(note).position, rect: rect(note), inHeroArt: !!note.closest('.hero-art, .hero-art-wrap') } : null,
          cta: rect(cta),
          viewportWidth: document.documentElement.clientWidth
        };
      })()`,
      { awaitPromise: false }
    );
    report.check(`final-fixes-${viewport.label}.badge`, !!badge.note && /ПЕРВАЯ СМЕНА/i.test(badge.note.text) && /7\s*МИНУТ/i.test(badge.note.text), badge.note);
    if (badge.note) {
      report.check(`final-fixes-${viewport.label}.badge-position`, badge.note.position === "absolute" || badge.note.position === "relative", badge.note);
      report.check(`final-fixes-${viewport.label}.badge-right`, badge.note.rect.right >= badge.viewportWidth - (viewport.mobile ? 40 : 100), badge.note);
      report.check(`final-fixes-${viewport.label}.badge-outside-hero-art`, badge.note.inHeroArt === false, badge.note);
      if (badge.cta) report.check(`final-fixes-${viewport.label}.badge-above-cta`, badge.note.rect.bottom <= badge.cta.top + 1, { badge: badge.note.rect, cta: badge.cta });
    }
    await report.shot(page, `landing-${viewport.label}`);

    // интро: header-счётчик обновляется in-place, без перерисовки шапки
    await page.click('[data-action="start-quest"]');
    await sleep(300);
    if ((await page.screen()) === "intro") {
      const before = await page.eval(
        `(() => { const head = document.getElementById('headStatus'); const counter = document.querySelector('#introCounter, .intro-counter span'); window.__qaHeaderNode = head; return { header: head ? head.textContent.replace(/\\s+/g, ' ').trim() : '', counter: counter ? counter.textContent.trim() : '' }; })()`,
        { awaitPromise: false }
      );
      await page.click('[data-action="intro-next"]');
      await sleep(300);
      const after = await page.eval(
        `(() => { const head = document.getElementById('headStatus'); const counter = document.querySelector('#introCounter, .intro-counter span'); return { header: head ? head.textContent.replace(/\\s+/g, ' ').trim() : '', counter: counter ? counter.textContent.trim() : '', sameHeaderNode: window.__qaHeaderNode === head }; })()`,
        { awaitPromise: false }
      );
      report.check(`final-fixes-${viewport.label}.intro-header-counter`, before.counter !== after.counter && /2\s*\/\s*5/.test(after.header + " " + after.counter) && after.sameHeaderNode === true, { before, after });
      await page.click('[data-action="intro-skip"]').catch(() => {});
      await page.waitScreen("characters").catch(() => {});
    }
    await page.waitScreen("characters");
    await driver.selectCharacter(characters[0].id);
    await page.waitScreen("game");
    await sleep(300);

    const hud = await page.eval(
      `(() => {
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
        const hudEl = document.querySelector('.game-hud');
        const back = document.querySelector('.hud-back, [data-action="game-back"]');
        const score = document.querySelector('.hud-score');
        const route = document.querySelector('.route-map');
        const stops = Array.from(document.querySelectorAll('.route-stop'));
        const finish = stops.find((el) => /финиш/i.test(el.textContent || ''));
        const intersects = (a, b) => !!(a && b && a.width > 0 && b.width > 0 && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1);
        const backRect = rect(back);
        const scoreRect = rect(score);
        const routeRect = rect(route);
        const finishRect = rect(finish);
        const firstRowBottom = Math.max(backRect ? backRect.bottom : 0, scoreRect ? scoreRect.bottom : 0);
        return {
          hud: rect(hudEl), back: backRect, score: scoreRect, route: routeRect, finish: finishRect,
          routeSecondRow: !!(routeRect && firstRowBottom > 0 && routeRect.top >= firstRowBottom - 4),
          scoreFinishOverlap: intersects(scoreRect, finishRect),
          routeWithinHud: !!(routeRect && hudEl && routeRect.width <= hudEl.getBoundingClientRect().width + 1),
          wrap: hudEl ? getComputedStyle(hudEl).flexWrap : null
        };
      })()`,
      { awaitPromise: false }
    );
    report.check(`final-fixes-${viewport.label}.hud-present`, !!hud.hud && !!hud.route && !!hud.score && !!hud.finish, hud);
    report.check(`final-fixes-${viewport.label}.hud-score-no-finish-overlap`, hud.scoreFinishOverlap === false, hud);
    report.check(`final-fixes-${viewport.label}.hud-route-fits`, hud.routeWithinHud === true, hud);
    if (viewport.width <= 680) report.check(`final-fixes-${viewport.label}.hud-two-rows`, hud.routeSecondRow === true, hud);

    const stamp = await page.eval(
      `(() => { const el = document.querySelector('.scene-stamp'); if (!el) return null; const r = el.getBoundingClientRect(); const style = getComputedStyle(el); return { display: style.display, visibility: style.visibility, width: Math.round(r.width), height: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 60) }; })()`,
      { awaitPromise: false }
    );
    if (viewport.width <= 680) {
      report.check(`final-fixes-${viewport.label}.scene-stamp-hidden`, !stamp || stamp.display === "none" || stamp.width === 0, stamp);
    } else {
      report.check(`final-fixes-${viewport.label}.scene-stamp-visible`, !!stamp && stamp.display !== "none" && stamp.width > 0, stamp);
    }
    await report.shot(page, `game-hud-${viewport.label}`);
    await checkConsole(page, report, `final-fixes-${viewport.label}`);
  }
}


const SCENARIOS = [
  {
    id: "survey-desktop",
    title: "Обзор: лендинг → интро → герой → первое задание (desktop)",
    viewport: "desktop",
    run: (page, report, driver) => surveyScenario(page, report, driver, { viewportKey: "desktop", screenshotTag: "desktop" })
  },
  {
    id: "survey-mobile",
    title: "Обзор: лендинг → интро → герой → первое задание (mobile 390)",
    viewport: "mobile",
    run: (page, report, driver) => surveyScenario(page, report, driver, { viewportKey: "mobile", screenshotTag: "mobile" })
  },
  {
    id: "survey-compact",
    title: "Обзор и layout (mobile 360×740)",
    viewport: "compact",
    run: (page, report, driver) => viewportLayoutScenario(page, report, driver, { viewportKey: "compact" })
  },
  {
    id: "survey-landscape",
    title: "Обзор и layout (mobile landscape 844×390)",
    viewport: "landscape",
    run: (page, report, driver) => viewportLayoutScenario(page, report, driver, { viewportKey: "landscape" })
  },
  {
    id: "desktop-full",
    title: "Полный маршрут, приз, форма, reload, сброс, звук (desktop)",
    viewport: "desktop",
    run: desktopFullScenario
  },
  {
    id: "mobile-reload",
    title: "Reload/продолжение, маршруты 2–3, звёзды (mobile 390)",
    viewport: "mobile",
    run: mobileReloadScenario
  },
  {
    id: "keyboard",
    title: "Клавиатура, фокус, модалка, звук (desktop)",
    viewport: "desktop",
    run: keyboardScenario
  },
  {
    id: "history",
    title: "History back/forward: интро → герой → игра; back с формы",
    viewport: "desktop",
    run: historyScenario
  },
  {
    id: "content-guard",
    title: "Контент-гард: нет пива/18+ в текстах, консоли и исходниках",
    viewport: "desktop",
    run: contentGuardScenario
  },
  {
    id: "mobile-cta",
    title: "Мобильные CTA и hscroll на 390×844 и 360×740",
    viewport: "mobile",
    run: mobileCtaScenario
  },
  {
    id: "postfix-touch",
    title: "Постфикс: тач-таргеты ≥44px, шапка/футер, hscroll на 390/360/landscape",
    viewport: "mobile",
    run: postfixTouchScenario
  },
  {
    id: "pwa",
    title: "PWA: манифест, SW, кэш, offline, meta/safe-area",
    viewport: "mobile",
    run: pwaScenario
  },
  {
    id: "pwa-fresh",
    title: "PWA на свежем профиле: unregister SW, installability, иконки 192/512/maskable/180",
    viewport: "mobile",
    defaultContext: true,
    run: pwaFreshScenario
  },
  {
    id: "pwa-standalone",
    title: "Установленный PWA (--app): display-mode, layout 390/360/landscape",
    viewport: "mobile",
    run: standaloneScenario
  },
  /* --- сценарии новой итерации (task-8…task-11): подготовлены, ждём готовности сборки --- */
  {
    id: "content-v2",
    title: "Контент v2: интро 5 реплик, тайминг, вакансии, структура data.js",
    viewport: "desktop",
    run: contentV2Scenario
  },
  {
    id: "landing-intro-v2",
    title: "Лендинг/интро v2: интервалы, бейдж, 0%/Enter, in-place интро, левый спикер",
    viewport: "desktop",
    run: landingIntroV2Scenario
  },
  {
    id: "chat-v2",
    title: "Чат-диалог v2: герой слева/Пузырь справа, накопление, метки на мобиле",
    viewport: "desktop",
    run: chatV2Scenario
  },
  {
    id: "form-nofile",
    title: "Форма без файла: нет file-input, ссылка необязательна, обязанности вакансии",
    viewport: "desktop",
    run: formNoFileScenario
  },
  {
    id: "share-pdf",
    title: "Share/PDF v2: уникальные коды, share image, fallback, валидный PDF",
    viewport: "desktop",
    run: sharePdfScenario
  },
  {
    id: "art-v2",
    title: "Арт v2: 3 разных scene-SVG, chief 512, share-promo 1080×1350",
    viewport: "desktop",
    run: artV2Scenario
  },
  {
    id: "readability-v2",
    title: "Читаемость v2: шрифты, обрезания, видимые метки, совет Пузыря сверху",
    viewport: "desktop",
    run: readabilityV2Scenario
  },
  {
    id: "final-fixes",
    title: "Финальные фиксы: HUD в 2 строки, бейдж top-right, скрытый scene-stamp, intro counter, 07:40–16:10",
    viewport: "mobile",
    run: finalFixesScenario
  },
  {
    id: "design-theme",
    title: "Брендовая тема: default brand, переключатель, persist/reload, промокод, PWA v10",
    viewport: "desktop",
    run: designThemeScenario
  },
  {
    id: "v14-final",
    title: "v14: чистый hero, новый Пузырь 24–120, splat/промокод, форма стажёра, PDF обе темы, reduced-motion, PWA v14",
    viewport: "desktop",
    run: v14FinalScenario
  },
  {
    id: "v18-final",
    title: "v18: «Заполнить без игры» + направление, «Назад»/«К диалогу», 1440/390/360, обе темы, PDF",
    viewport: "desktop",
    run: v18FinalScenario
  }
];

async function createPage(browser, viewport, { defaultContext = false } = {}) {
  let browserContextId = null;
  if (!defaultContext) {
    const context = await browser.cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
    browserContextId = context.browserContextId;
  }
  const targetParams = { url: "about:blank" };
  if (browserContextId) targetParams.browserContextId = browserContextId;
  const { targetId } = await browser.cdp.send("Target.createTarget", targetParams);
  const { sessionId } = await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(browser.cdp, targetId, sessionId, { viewport, browserContextId });
  await page.init({
    width: viewport.width,
    height: viewport.height,
    mobile: viewport.mobile,
    dpr: viewport.dpr,
    baseUrl: browser.baseUrl
  });
  page.baseUrl = browser.baseUrl;
  await page.navigate(browser.baseUrl);
  await page.waitScreen("landing");
  return { page, browserContextId };
}

async function runScenario(browser, scenario, report) {
  const viewport = VIEWPORTS[scenario.viewport];
  report.begin(scenario.id, scenario.title, viewport);
  let created = null;
  try {
    created = await createPage(browser, viewport, { defaultContext: !!scenario.defaultContext });
    const driver = new GameDriver(created.page, report);
    await driver.loadData();
    if (!driver.data) report.note("window.BRODILKA_DATA недоступен — сценарий полагается на DOM-эвристики");
    await scenario.run(created.page, report, driver, {
      browser,
      baseUrl: browser.baseUrl,
      browserExecutable: browser.executable,
      profileRoot: browser.profileRoot
    });
  } catch (error) {
    report.fatal(error);
    if (created && created.page) {
      await report.shot(created.page, "fatal").catch(() => {});
    }
  } finally {
    if (created && created.browserContextId) {
      await browser.cdp.send("Target.disposeBrowserContext", { browserContextId: created.browserContextId }).catch(() => {});
    } else if (created) {
      await browser.cdp.send("Target.closeTarget", { targetId: created.page.targetId }).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { scenarios: [], headed: false, url: null, browser: null, list: false, verbose: false, includePending: false };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--include-pending") options.includePending = true;
    else if (arg.startsWith("--url=")) options.url = arg.slice(6);
    else if (arg.startsWith("--browser=")) options.browser = arg.slice(10).replace(/^"|"$/g, "");
    else if (arg.startsWith("--scenario=")) {
      options.scenarios = arg
        .slice(11)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--")) {
      warn("unknown arg", arg);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    console.log("Доступные сценарии:");
    for (const scenario of SCENARIOS) {
      console.log(`  ${scenario.id.padEnd(18)} ${scenario.title} [${scenario.viewport}]${scenario.pending ? " (pending: ждёт готовности итерации)" : ""}`);
    }
    return 0;
  }

  await mkdirp(RUN_DIR);
  await mkdirp(ARTIFACTS_DIR);
  await mkdirp(DOWNLOADS_DIR);
  const report = new Report(RUN_DIR);

  let server = null;
  let browser = null;
  const profileRoot = path.join(os.tmpdir(), "brodilka-qa-" + process.pid);
  await mkdirp(profileRoot);

  try {
    let baseUrl = options.url;
    if (!baseUrl) {
      server = await startStaticServer(ROOT, 0);
      baseUrl = server.url;
      log(`static server: ${baseUrl} (root ${ROOT})`);
    } else {
      log(`using external url: ${baseUrl}`);
    }
    browser = await launchBrowser({ browserPath: options.browser, headed: options.headed, profileRoot });
    browser.baseUrl = baseUrl;
    report.env = {
      runId: RUN_ID,
      node: process.version,
      platform: process.platform,
      browser: browser.version,
      browserPath: browser.executable,
      baseUrl,
      headed: options.headed
    };
    log(`browser: ${browser.version}`);

    const requested = options.scenarios.length
      ? options.scenarios
      : SCENARIOS.filter((scenario) => options.includePending || !scenario.pending).map((scenario) => scenario.id);
    if (!options.scenarios.length && !options.includePending) {
      const pendingCount = SCENARIOS.filter((scenario) => scenario.pending).length;
      if (pendingCount) log(`pending-сценариев пропущено: ${pendingCount} (запуск: --scenario=<id> или --include-pending)`);
    }
    const unknown = requested.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
    if (unknown.length) throw new Error("unknown scenario(s): " + unknown.join(", "));
    const selected = SCENARIOS.filter((scenario) => requested.includes(scenario.id));

    for (const scenario of selected) {
      await runScenario(browser, scenario, report);
    }

    const json = report.toJSON();
    await fsp.writeFile(path.join(ARTIFACTS_DIR, "latest.json"), JSON.stringify(json, null, 2));
    const namedFile = path.join(ARTIFACTS_DIR, `run-${RUN_ID}.json`);
    await fsp.writeFile(namedFile, JSON.stringify(json, null, 2));

    const summary = json.summary;
    log("\n================ QA SUMMARY ================");
    log(`scenarios: ${summary.scenarios}, checks: ${summary.checks}, pass: ${summary.passed}, fail: ${summary.failed}, warn: ${summary.warned}, skip: ${summary.skipped}, fatal: ${summary.fatal}`);
    log(`screenshots: ${path.relative(ROOT, RUN_DIR)}`);
    log(`report: ${path.relative(ROOT, path.join(ARTIFACTS_DIR, "latest.json"))}`);
    if (summary.failures.length) {
      log("\nFAILED CHECKS:");
      for (const failure of summary.failures) {
        log(`  - ${failure.id}: ${JSON.stringify(failure.details).slice(0, 500)}`);
      }
    }
    return summary.failures.length || summary.fatal ? 1 : 0;
  } catch (error) {
    console.error("[qa][fatal]", error && error.stack ? error.stack : error);
    return 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop().catch(() => {});
    await fsp.rm(profileRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error("[qa][fatal]", error);
      process.exitCode = 2;
    });
}

module.exports = { findBrowserPath, startStaticServer, launchBrowser, Page, CdpClient };
