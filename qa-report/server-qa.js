#!/usr/bin/env node
/**
 * server-qa.js — проверки API приёма карточек для запущенного `node serve.js`.
 * Запуск: node qa-report/server-qa.js [baseUrl]
 * Скрипт создаёт тестовые записи, но не выгружает их (экспорт проверяется
 * отдельно в server-admin-qa.js, чтобы админка сначала увидела данные).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BASE = (process.argv[2] || "http://127.0.0.1:4517").replace(/\/$/, "");
const QA_DIR = path.resolve(__dirname);
const ARTIFACTS = path.join(QA_DIR, "artifacts");
const PASSWORD = process.env.ADMIN_PASSWORD || "qa-admin-password";
const results = [];

function record(id, ok, details) {
  results.push({ id, status: ok ? "pass" : "fail", details });
  console.log((ok ? "  ✓ " : "  ✗ ") + id + (ok || details === undefined ? "" : " " + JSON.stringify(details).slice(0, 600)));
}

async function request(method, pathname, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(BASE + pathname, {
    method,
    headers,
    body: options.body,
    redirect: "manual"
  });
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  if (/json/.test(contentType)) {
    try { json = JSON.parse(buffer.toString("utf8")); } catch (error) {}
  }
  return { status: response.status, headers: response.headers, buffer, json, text: buffer.toString("utf8") };
}

function validPayload(overrides = {}) {
  return Object.assign({
    name: "Иванов Иван Иванович",
    birthDate: "1996-05-14",
    education: "МГУ",
    phone: "+7 999 123-45-67",
    email: "ivan@example.com",
    city: "Москва",
    resumeLink: "https://hh.ru/resume/qa",
    vacancy: "Машинист оборудования",
    charId: "brewer",
    source: "qa-test",
    consent: true
  }, overrides);
}

async function submit(payload, headers = {}) {
  return request("POST", "/api/applications", {
    headers: Object.assign({ "content-type": "application/json" }, headers),
    body: JSON.stringify(payload)
  });
}

async function main() {
  console.log("[server-qa] base " + BASE);

  // 1) Статика, скрытые пути, noindex
  const site = await request("GET", "/");
  record("site.index-200", site.status === 200 && /БРОДИЛКА/.test(site.text), site.status);
  const swFile = (await request("GET", "/sw.js")).text;
  const swMatch = swFile.match(/VERSION\s*=\s*["']brodilka-v(\d+)["']/);
  const swNumber = swMatch ? Number(swMatch[1]) : 0;
  record("site.sw-v24", swNumber >= 24, { version: swMatch ? "brodilka-v" + swNumber : null });
  const adminPage = await request("GET", "/admin");
  record("admin.page-200", adminPage.status === 200, adminPage.status);
  record("admin.noindex", /noindex/i.test(adminPage.headers.get("x-robots-tag") || "") && /noindex/i.test(adminPage.text), { header: adminPage.headers.get("x-robots-tag") });
  const hiddenPaths = ["/data/applications.json", "/data/", "/server/store.js", "/server/xlsx.js", "/.admin-password", "/.git/config"];
  for (const hidden of hiddenPaths) {
    const response = await request("GET", hidden);
    record("hidden." + hidden, response.status === 404, { status: response.status, body: response.text.slice(0, 80) });
  }
  const indexText = site.text;
  const appJs = (await request("GET", "/js/app.js")).text;
  const adminJs = (await request("GET", "/admin.js")).text;
  record("admin.no-game-links", !/\/admin/.test(indexText) && !/\/admin/.test(appJs), { index: indexText.includes("/admin"), app: appJs.includes("/admin") });
  record("admin.assets-load", (await request("GET", "/admin.css")).status === 200 && (await request("GET", "/admin.js")).status === 200);

  // 2) Авторизация
  const stateAnon = await request("GET", "/api/admin/state");
  const exportAnon = await request("POST", "/api/admin/export");
  record("auth.state-401", stateAnon.status === 401, stateAnon.status);
  record("auth.export-401", exportAnon.status === 401, exportAnon.status);
  const wrong = await request("POST", "/api/admin/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
  record("auth.wrong-password-401", wrong.status === 401, wrong.status);
  const login = await request("POST", "/api/admin/login", { headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  const setCookie = login.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  record("auth.login-200", login.status === 200 && /brodilka_admin=/.test(cookie), { status: login.status, cookie: cookie.slice(0, 24) + "…" });
  record("auth.cookie-flags", /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Path=\//.test(setCookie), setCookie);
  const stateAuthed = await request("GET", "/api/admin/state", { cookie });
  record("auth.state-200", stateAuthed.status === 200 && typeof stateAuthed.json.count === "number", { status: stateAuthed.status, count: stateAuthed.json && stateAuthed.json.count });
  const emptyExport = await request("POST", "/api/admin/export", { cookie });
  record("export.empty-409", emptyExport.status === 409, emptyExport.status);
  const wrongJson = await request("POST", "/api/applications", { headers: { "content-type": "application/json" }, body: "{bad json" });
  record("api.bad-json-400", wrongJson.status === 400, wrongJson.status);
  const logout = await request("POST", "/api/admin/logout", { cookie });
  record("auth.logout-clears-cookie", logout.status === 200 && /Max-Age=0/.test(logout.headers.get("set-cookie") || ""), logout.headers.get("set-cookie"));

  // 3) Валидная и невалидные заявки
  const valid = await submit(validPayload());
  record("api.valid-201", valid.status === 201 && !!valid.json && /^HR-\d{2}-\d{4}$/.test(valid.json.ticket || ""), { status: valid.status, body: valid.json });
  const ticket = valid.json && valid.json.ticket;
  record("api.valid-ticket", !!ticket);

  const invalidCases = [
    { id: "empty", payload: {} },
    { id: "future-birthdate", payload: validPayload({ birthDate: "2999-01-01" }) },
    { id: "old-birthdate", payload: validPayload({ birthDate: "1899-12-31" }) },
    { id: "bad-email", payload: validPayload({ email: "not-an-email" }) },
    { id: "short-phone", payload: validPayload({ phone: "123" }) },
    { id: "no-consent", payload: validPayload({ consent: false }) }
  ];
  for (const testCase of invalidCases) {
    const response = await submit(testCase.payload);
    record("api.invalid-" + testCase.id + "-400", response.status === 400 && Array.isArray(response.json && response.json.fields) && response.json.fields.length > 0, { status: response.status, fields: response.json && response.json.fields });
  }
  const missingFieldChecks = {};
  const emptyResponse = await submit({});
  (emptyResponse.json && emptyResponse.json.fields || []).forEach((field) => { missingFieldChecks[field] = true; });
  record("api.empty-fields", ["name", "birthDate", "phone", "email", "consent"].every((field) => missingFieldChecks[field]), missingFieldChecks);

  // 4) Rate limit подачи (свой IP через X-Forwarded-For)
  const rlHeaders = { "x-forwarded-for": "198.51.100.77" };
  let createdByRate = 0;
  let lastRateStatus = 0;
  for (let index = 0; index < 31; index += 1) {
    const response = await submit(validPayload({ name: "Rate Limit " + index }), rlHeaders);
    lastRateStatus = response.status;
    if (response.status === 201) createdByRate += 1;
  }
  record("api.rate-limit-30", createdByRate === 30 && lastRateStatus === 429, { created: createdByRate, lastStatus: lastRateStatus });

  // 5) Rate limit логина (свой IP)
  const authHeaders = { "content-type": "application/json", "x-forwarded-for": "198.51.100.88" };
  let loginFailures = 0;
  let lastLoginStatus = 0;
  for (let index = 0; index < 9; index += 1) {
    const response = await request("POST", "/api/admin/login", { headers: authHeaders, body: JSON.stringify({ password: "nope-" + index }) });
    lastLoginStatus = response.status;
    if (response.status === 401) loginFailures += 1;
  }
  record("auth.rate-limit-login", loginFailures >= 8 && lastLoginStatus === 429, { failures: loginFailures, lastStatus: lastLoginStatus });

  // 5b) Успешный вход сбрасывает счётчик: 10 успешных логинов подряд без 429
  const successHeaders = { "content-type": "application/json", "x-forwarded-for": "198.51.100.99" };
  const successStatuses = [];
  for (let index = 0; index < 10; index += 1) {
    const response = await request("POST", "/api/admin/login", { headers: successHeaders, body: JSON.stringify({ password: PASSWORD }) });
    successStatuses.push(response.status);
  }
  record("auth.success-login-no-429", successStatuses.every((status) => status === 200), successStatuses);

  // 5c) Успех сбрасывает серию ошибок: 6 ошибок → успех → ещё 6 ошибок без 429
  const resetHeaders = { "content-type": "application/json", "x-forwarded-for": "198.51.100.111" };
  const resetStatuses = [];
  for (let index = 0; index < 6; index += 1) resetStatuses.push((await request("POST", "/api/admin/login", { headers: resetHeaders, body: JSON.stringify({ password: "bad" }) })).status);
  resetStatuses.push((await request("POST", "/api/admin/login", { headers: resetHeaders, body: JSON.stringify({ password: PASSWORD }) })).status);
  for (let index = 0; index < 6; index += 1) resetStatuses.push((await request("POST", "/api/admin/login", { headers: resetHeaders, body: JSON.stringify({ password: "bad" }) })).status);
  record("auth.success-resets-failures", resetStatuses.slice(0, 6).every((status) => status === 401) && resetStatuses[6] === 200 && resetStatuses.slice(7).every((status) => status === 401), resetStatuses);

  // 6) Данные на диске и состояние
  const dataFile = path.join(path.resolve(QA_DIR, ".."), "data", "applications.json");
  const disk = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const expectedCount = 1 + 30;
  record("store.persisted", Array.isArray(disk.applications) && disk.applications.length === expectedCount, { onDisk: disk.applications && disk.applications.length });
  const stored = disk.applications.find((item) => item.ticket === ticket);
  const fieldsOk = ["name", "birthDate", "education", "phone", "email", "city", "resumeLink", "vacancy", "charId", "source", "status", "createdAt", "id"].every((key) => stored && stored[key] !== undefined);
  record("store.fields", !!stored && fieldsOk && stored.birthDate === "1996-05-14" && stored.education === "МГУ", stored);
  const stateBeforeExport = await request("GET", "/api/admin/state", { cookie });
  const latest = (stateBeforeExport.json && stateBeforeExport.json.latest) || [];
  record("admin.state-latest-6", stateBeforeExport.json.count === expectedCount && latest.length === 6, { count: stateBeforeExport.json.count, latest: latest.length });
  const newestFirst = latest.every((item, index) => index === 0 || new Date(latest[index - 1].createdAt) >= new Date(item.createdAt));
  record("admin.latest-newest-first", newestFirst, latest.map((item) => item.createdAt));

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const output = {
    base: BASE,
    cookie,
    ticket,
    expectedCount,
    checks: results,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(ARTIFACTS, "server-qa-results.json"), JSON.stringify(output, null, 2));
  const failed = results.filter((item) => item.status !== "pass");
  console.log(`\n[server-qa] checks=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  console.log(`[server-qa] cookie and metadata: artifacts/server-qa-results.json`);
  if (failed.length) {
    console.log("FAILED:", failed.map((item) => item.id).join(", "));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[server-qa][fatal]", error);
  process.exitCode = 2;
});
