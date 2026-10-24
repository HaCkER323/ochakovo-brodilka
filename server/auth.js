/* Пароль, подписанная cookie и простой rate limit для админки. */
const crypto = require("crypto");

const COOKIE = "brodilka_admin";
const MAX_AGE = 8 * 60 * 60;
const attempts = new Map();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function createAuth(options) {
  const password = String(options.password || "");
  const secret = Buffer.from(options.secret || crypto.randomBytes(32).toString("hex"));
  if (!password) throw new Error("Не задан пароль администратора");

  function issue() {
    const exp = Date.now() + MAX_AGE * 1000;
    const payload = Buffer.from(JSON.stringify({ exp: exp }), "utf8").toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return payload + "." + sig;
  }

  function valid(token) {
    if (!token || token.indexOf(".") < 0) return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest("base64url");
    if (!safeEqual(parts[1], expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      return Number(data.exp) > Date.now();
    } catch (error) {
      return false;
    }
  }

  function parseCookies(req) {
    const raw = req.headers.cookie || "";
    const out = {};
    raw.split(";").forEach(function (part) {
      const i = part.indexOf("=");
      if (i < 0) return;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
  }

  function isAuthenticated(req) {
    return valid(parseCookies(req)[COOKIE]);
  }

  function cookie(token, secure) {
    return COOKIE + "=" + encodeURIComponent(token) + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
      MAX_AGE + (secure ? "; Secure" : "");
  }

  function clearCookie(secure) {
    return COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + (secure ? "; Secure" : "");
  }

  function checkPassword(value) {
    return safeEqual(hash(value), hash(password));
  }

  function allowAttempt(ip) {
    const now = Date.now();
    const entry = attempts.get(ip) || { count: 0, first: now };
    if (now - entry.first > 10 * 60 * 1000) {
      entry.count = 0;
      entry.first = now;
    }
    entry.count += 1;
    attempts.set(ip, entry);
    return entry.count <= 8;
  }

  function resetAttempt(ip) {
    attempts.delete(ip);
  }

  return {
    issue: issue,
    isAuthenticated: isAuthenticated,
    cookie: cookie,
    clearCookie: clearCookie,
    checkPassword: checkPassword,
    allowAttempt: allowAttempt,
    resetAttempt: resetAttempt
  };
}

module.exports = { createAuth: createAuth };
