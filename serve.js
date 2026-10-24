/* БРОДИЛКА: статический сайт + приём карточек + скрытая админка.
   Запуск: node serve.js
   Переменные: PORT, HOST, ADMIN_PASSWORD, SESSION_SECRET.
   Без ADMIN_PASSWORD пароль создаётся в .admin-password. */
const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Store, createTicket, normalizeApplication } = require("./server/store");
const { createAuth } = require("./server/auth");
const { buildXlsx } = require("./server/xlsx");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_FILE = path.join(ROOT, "data", "applications.json");
const PASSWORD_FILE = path.join(ROOT, ".admin-password");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf"
};

const DENY_PREFIXES = ["/data/", "/server/", "/.git/", "/.admin-password"];

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
}

function sendJson(res, status, payload, extra) {
  securityHeaders(res);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, extra || {}));
  res.end(JSON.stringify(payload));
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > (limit || 120000)) {
        reject(Object.assign(new Error("too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error("bad json"), { statusCode: 400 });
  }
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function isSecure(req) {
  return req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
}

async function getAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    const saved = (await fsp.readFile(PASSWORD_FILE, "utf8")).trim();
    if (saved) return saved;
  } catch (error) {}
  const generated = crypto.randomBytes(9).toString("base64url");
  await fsp.writeFile(PASSWORD_FILE, generated + "\n", { encoding: "utf8", mode: 0o600 });
  return generated;
}

function safePath(urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(path.resolve(ROOT))) return null;
  if (DENY_PREFIXES.some(function (prefix) { return file.startsWith(path.resolve(ROOT, prefix.replace(/^\//, ""))); })) {
    return null;
  }
  return file;
}

function serveFile(req, res, file, extraHeaders) {
  const ext = path.extname(file).toLowerCase();
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  securityHeaders(res);
  res.writeHead(200, Object.assign({
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Service-Worker-Allowed": "/"
  }, extraHeaders || {}));
  fs.createReadStream(file).pipe(res);
  return true;
}

async function main() {
  const store = await new Store(DATA_FILE).init();
  const password = await getAdminPassword();
  const auth = createAuth({
    password: password,
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")
  });

  const submissions = new Map();
  function allowSubmission(ip) {
    const now = Date.now();
    const entry = submissions.get(ip) || { count: 0, first: now };
    if (now - entry.first > 60 * 60 * 1000) {
      entry.count = 0;
      entry.first = now;
    }
    entry.count += 1;
    submissions.set(ip, entry);
    return entry.count <= 30;
  }

  const server = http.createServer(async function (req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (pathname === "/admin" || pathname === "/admin/") {
        const file = path.join(ROOT, "admin.html");
        if (serveFile(req, res, file, { "X-Robots-Tag": "noindex, nofollow" })) return;
      }

      if (pathname === "/api/applications" && req.method === "POST") {
        if (!allowSubmission(requestIp(req))) {
          sendJson(res, 429, { ok: false, error: "rate limit" });
          return;
        }
        const input = await readJson(req);
        const normalized = normalizeApplication(input);
        if (normalized.errors.length) {
          sendJson(res, 400, { ok: false, error: "validation", fields: normalized.errors });
          return;
        }
        const record = normalized.data;
        const ticket = createTicket(store.all());
        const application = Object.assign({}, record, {
          id: crypto.randomUUID(),
          ticket: ticket,
          createdAt: new Date().toISOString(),
          status: "new"
        });
        await store.add(application);
        sendJson(res, 201, { ok: true, ticket: ticket, id: application.id });
        return;
      }

      if (pathname === "/api/admin/login" && req.method === "POST") {
        if (!auth.allowAttempt(requestIp(req))) {
          sendJson(res, 429, { ok: false, error: "too many attempts" });
          return;
        }
        const input = await readJson(req);
        if (!auth.checkPassword(input.password)) {
          sendJson(res, 401, { ok: false, error: "wrong password" });
          return;
        }
        auth.resetAttempt(requestIp(req));
        sendJson(res, 200, { ok: true }, {
          "Set-Cookie": auth.cookie(auth.issue(), isSecure(req))
        });
        return;
      }

      if (pathname === "/api/admin/logout" && req.method === "POST") {
        sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie(isSecure(req)) });
        return;
      }

      if (pathname === "/api/admin/state" && req.method === "GET") {
        if (!auth.isAuthenticated(req)) {
          sendJson(res, 401, { ok: false, error: "auth required" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          count: store.count(),
          latest: store.latest(6)
        });
        return;
      }

      if (pathname === "/api/admin/export" && req.method === "POST") {
        if (!auth.isAuthenticated(req)) {
          sendJson(res, 401, { ok: false, error: "auth required" });
          return;
        }
        const snapshot = store.all();
        if (!snapshot.length) {
          sendJson(res, 409, { ok: false, error: "no applications" });
          return;
        }
        const ids = snapshot.map(function (item) { return item.id; });
        const workbook = buildXlsx(snapshot);
        const stamp = new Date().toISOString().slice(0, 10);
        securityHeaders(res);
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="ochakovo-applications-' + stamp + '.xlsx"',
          "Content-Length": workbook.length,
          "Cache-Control": "no-store"
        });
        res.end(workbook, async function () {
          try { await store.remove(ids); } catch (error) { console.error("[admin] не удалось очистить выгруженные отклики", error); }
        });
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }

      if (DENY_PREFIXES.some(function (prefix) { return pathname.startsWith(prefix); })) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }

      const file = safePath(pathname);
      if (!file) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
        return;
      }
      const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
      if (!serveFile(req, res, target)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      }
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? "bad request" : "server error" });
      } else {
        res.end();
      }
    }
  });

  server.listen(PORT, HOST, function () {
    console.log("БРОДИЛКА: http://" + (HOST === "0.0.0.0" ? "127.0.0.1" : HOST) + ":" + PORT + "/");
    console.log("Админка: http://" + (HOST === "0.0.0.0" ? "127.0.0.1" : HOST) + ":" + PORT + "/admin");
    if (!process.env.ADMIN_PASSWORD) console.log("Пароль админки: " + password);
  });
}

main().catch(function (error) {
  console.error("Не удалось запустить сервер:", error);
  process.exit(1);
});
