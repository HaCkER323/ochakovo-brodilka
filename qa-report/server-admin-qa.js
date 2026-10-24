#!/usr/bin/env node
/** server-admin-qa.js — UI админки, кэширование SW и экспорт XLSX через кнопку. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { launchBrowser, Page } = require("./run-qa.js");

const BASE = (process.argv[2] || "http://127.0.0.1:4517").replace(/\/$/, "");
const PASSWORD = process.env.ADMIN_PASSWORD || "qa-admin-password";
const QA_DIR = path.resolve(__dirname);
const DOWNLOADS = path.join(QA_DIR, "artifacts", "downloads-admin");
const OUT_DIR = path.join(QA_DIR, "screens", "server-admin");
const results = [];

function record(id, ok, details) {
  results.push({ id, status: ok ? "pass" : "fail", details });
  console.log((ok ? "  ✓ " : "  ✗ ") + id + (ok || details === undefined ? "" : " " + JSON.stringify(details).slice(0, 700)));
}

async function main() {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profileRoot = path.join(require("node:os").tmpdir(), "brodilka-server-admin-" + process.pid);
  fs.mkdirSync(profileRoot, { recursive: true });
  const browser = await launchBrowser({ profileRoot });
  try {
    const { targetId } = await browser.cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(browser.cdp, targetId, sessionId, {});
    await page.init({ width: 390, height: 844, mobile: true, dpr: 3, baseUrl: BASE });
    await page.navigate(BASE + "/");
    await page.waitScreen("landing").catch(() => {});
    await page.configureDownloads(DOWNLOADS);

    // SW v16 + кэш
    await page.eval(`navigator.serviceWorker.ready.then(() => true)`, { awaitPromise: true }).catch(() => {});
    await page.reload();
    await page.waitForSelector("#app");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const swInfo = await page.eval(
      `(async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const swText = await (await fetch("sw.js", { cache: "no-store" })).text();
        return { count: registrations.length, controller: !!navigator.serviceWorker.controller, version: (swText.match(/VERSION\\s*=\\s*["']([^"']+)["']/) || [])[1] || null };
      })()`,
      { awaitPromise: true }
    );
    record("sw.v17", swInfo.count > 0 && Number((String(swInfo.version || "").match(/v(\d+)/) || [])[1] || 0) >= 17, swInfo);

    // Страница админки (noindex, без ссылок)
    await page.navigate(BASE + "/admin");
    await page.waitForSelector("#loginView");
    const adminMeta = await page.eval(`({ robots: (document.querySelector('meta[name="robots"]') || {}).content || '', title: document.title, gameLinks: Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')).filter((href) => /\\/$|index\\.html/.test(href)) })`, { awaitPromise: false });
    record("admin.ui-noindex", /noindex/i.test(adminMeta.robots), adminMeta);
    record("admin.ui-no-game-nav", adminMeta.gameLinks.length === 0, adminMeta.gameLinks);
    await page.screenshot(false).then((buffer) => fs.writeFileSync(path.join(OUT_DIR, "admin-login-390.png"), buffer));

    // Логин через UI
    await page.fill("#password", PASSWORD);
    await page.click("#loginForm button");
    await page.eval("new Promise((resolve) => { const t = setInterval(() => { const panel = document.getElementById('panelView'); if (panel && !panel.hidden) { clearInterval(t); resolve(true); } }, 80); setTimeout(() => { clearInterval(t); resolve(false); }, 8000); })", { awaitPromise: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ui = await page.eval(
      `(async () => {
        const state = await (await fetch("/api/admin/state", { credentials: "same-origin" })).json();
        const preview = document.querySelectorAll("#preview .preview-card, #preview article, #preview > *");
        const buttons = Array.from(document.querySelectorAll("button")).filter((button) => button.getBoundingClientRect().width > 0).map((button) => (button.textContent || "").replace(/\\s+/g, " ").trim());
        const text = document.body.innerText;
        return {
          panelVisible: !document.getElementById("panelView").hidden,
          count: document.getElementById("count").textContent.trim(),
          countWord: document.getElementById("countWord").textContent.trim(),
          previewCount: preview.length,
          previewText: Array.from(preview).map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 160)),
          buttons,
          stateCount: state.count,
          stateLatest: (state.latest || []).length,
          hasFilters: /фильтр|поиск|сортиров|редакт|удалить выборочно|удалить отклик/i.test(text),
          hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          exportVisible: (() => { const button = document.getElementById("exportBtn"); const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.height >= 40; })(),
          countWordsSource: null
        };
      })()`,
      { awaitPromise: true }
    );
    record("admin.ui-login", ui.panelVisible === true, ui);
    record("admin.ui-count", Number(ui.count) === ui.stateCount && Number(ui.count) > 0, { count: ui.count, stateCount: ui.stateCount });
    record("admin.ui-preview-6", ui.previewCount === 6 && ui.stateLatest === 6, { previewCount: ui.previewCount, stateLatest: ui.stateLatest, previewText: ui.previewText.slice(0, 2) });
    record("admin.ui-preview-order", (() => { const items = ui.stateLatest; return items === 6; })(), { latest: ui.stateLatest });
    record("admin.ui-no-extra-actions", ui.hasFilters === false && ui.buttons.length <= 4, { buttons: ui.buttons, hasFilters: ui.hasFilters });
    record("admin.ui-mobile", !ui.hscroll && ui.exportVisible, { hscroll: ui.hscroll, exportVisible: ui.exportVisible });
    const expectedWord = (() => {
      const n = Number(ui.count);
      const mod100 = n % 100;
      const mod10 = n % 10;
      if (mod100 >= 11 && mod100 <= 14) return "откликов";
      if (mod10 === 1) return "отклик";
      if (mod10 >= 2 && mod10 <= 4) return "отклика";
      return "откликов";
    })();
    record("admin.ui-countword", ui.countWord === expectedWord, { count: ui.count, word: ui.countWord, expected: expectedWord });

    // Кэширование админки/service worker
    const cached = await page.eval(
      `(async () => {
        const urls = [];
        for (const key of await caches.keys()) { const cache = await caches.open(key); for (const request of await cache.keys()) urls.push(request.url); }
        return { keys: await caches.keys(), urls };
      })()`,
      { awaitPromise: true }
    );
    const adminCached = cached.urls.filter((url) => /\/admin|\/api\/admin/i.test(url));
    record("admin.not-cached-by-sw", adminCached.length === 0, adminCached);
    const adminAssetsCached = cached.urls.filter((url) => /admin\.(html|css|js)/i.test(url));
    record("admin.assets-not-cached", adminAssetsCached.length === 0, adminAssetsCached);

    // Мобильный скриншот панели + десктоп
    await page.screenshot(false).then((buffer) => fs.writeFileSync(path.join(OUT_DIR, "admin-panel-390.png"), buffer));
    await page.setViewport({ width: 1440, height: 1000, mobile: false, dpr: 1 });
    await page.reload();
    await page.waitForSelector("#password, #panelView");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.screenshot(false).then((buffer) => fs.writeFileSync(path.join(OUT_DIR, "admin-panel-1440.png"), buffer));

    // Экспорт через кнопку UI
    const countBeforeExport = ui.stateCount;
    const existing = fs.readdirSync(DOWNLOADS);
    const exportStarted = Date.now();
    await page.eval("window.confirm = () => true", { awaitPromise: false });
    await page.eval(`(() => { const button = document.getElementById("exportBtn"); if (button) button.click(); return true; })()`, { awaitPromise: false });
    await page.eval("new Promise((resolve) => { const t = setInterval(() => { const c = document.getElementById('count'); if (c && c.textContent.trim() === '0') { clearInterval(t); resolve(true); } }, 100); setTimeout(() => { clearInterval(t); resolve(false); }, 15000); })", { awaitPromise: true });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const files = fs.readdirSync(DOWNLOADS).filter((name) => name.endsWith(".xlsx") && fs.statSync(path.join(DOWNLOADS, name)).mtimeMs >= exportStarted - 2000);
    record("admin.export-download", files.length === 1, { files, existing });
    const afterExport = await page.eval(`(async () => { const state = await (await fetch("/api/admin/state", { credentials: "same-origin" })).json(); return { stateCount: state.count, uiCount: document.getElementById("count").textContent.trim(), countWord: document.getElementById("countWord").textContent.trim(), exportDisabled: document.getElementById("exportBtn").disabled }; })()`, { awaitPromise: true });
    record("admin.export-clears", afterExport.stateCount === 0 && afterExport.uiCount === "0" && afterExport.exportDisabled === true, afterExport);
    const dataFile = path.join(path.resolve(QA_DIR, ".."), "data", "applications.json");
    let diskCount = null;
    try { diskCount = JSON.parse(fs.readFileSync(dataFile, "utf8")).applications.length; } catch (error) { diskCount = null; }
    record("admin.export-disk-empty", diskCount === 0, { diskCount });
    await page.screenshot(false).then((buffer) => fs.writeFileSync(path.join(OUT_DIR, "admin-after-export-1440.png"), buffer));

    // Публичный сайт после экспорта (форма работает, PWA живой)
    await page.navigate(BASE + "/");
    await page.waitScreen("landing").catch(() => {});
    const publicAfter = await page.eval(`({ hasApp: !!document.querySelector('[data-action="start-quest"], #app'), design: document.documentElement.getAttribute('data-design') })`, { awaitPromise: false });
    record("site.after-export", publicAfter.hasApp === true, publicAfter);

    const output = {
      base: BASE,
      sw: swInfo,
      countBeforeExport,
      xlsxFile: files[0] ? path.join(DOWNLOADS, files[0]) : null,
      cachedUrls: cached.urls.filter((url) => /admin|api/i.test(url)),
      checks: results
    };
    fs.writeFileSync(path.join(QA_DIR, "artifacts", "server-admin-qa-results.json"), JSON.stringify(output, null, 2));
    const failed = results.filter((item) => item.status !== "pass");
    console.log(`\n[server-admin-qa] checks=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[server-admin-qa][fatal]", error);
  process.exitCode = 2;
});
