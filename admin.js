(function () {
  "use strict";

  const loginView = document.getElementById("loginView");
  const panelView = document.getElementById("panelView");
  const loginForm = document.getElementById("loginForm");
  const loginError = document.getElementById("loginError");
  const passwordInput = document.getElementById("password");
  const countEl = document.getElementById("count");
  const countWord = document.getElementById("countWord");
  const previewEl = document.getElementById("preview");
  const exportBtn = document.getElementById("exportBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  let count = 0;

  function word(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "отклик";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "отклика";
    return "откликов";
  }

  function formatDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) +
      " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function formatBirth(value) {
    const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[3] + "." + m[2] + "." + m[1] : (value || "");
  }

  function showLogin() {
    panelView.hidden = true;
    loginView.hidden = false;
    passwordInput.value = "";
    passwordInput.focus();
  }

  function showPanel() {
    loginView.hidden = true;
    panelView.hidden = false;
  }

  function card(item) {
    const el = document.createElement("article");
    el.className = "card";

    const who = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = item.name || "Без имени";
    const meta = document.createElement("span");
    meta.textContent = "ДР: " + (formatBirth(item.birthDate) || "не указана") +
      (item.city ? " · " + item.city : "");
    const education = document.createElement("small");
    education.textContent = item.education || "ВУЗ не указан";
    who.append(name, meta, education);

    const role = document.createElement("div");
    const vacancy = document.createElement("span");
    vacancy.className = "vacancy";
    vacancy.textContent = item.vacancy || "Вакансия не указана";
    const ticket = document.createElement("span");
    ticket.className = "ticket";
    ticket.textContent = item.ticket || "";
    role.append(vacancy, ticket);

    const contact = document.createElement("div");
    contact.className = "contact";
    const phone = document.createElement("b");
    phone.textContent = item.phone || "телефон не указан";
    const email = document.createElement("span");
    email.textContent = item.email || "";
    contact.append(phone, email);

    el.append(who, role, contact);
    return el;
  }

  function render(data) {
    count = data.count || 0;
    countEl.textContent = String(count);
    countWord.textContent = word(count);
    previewEl.replaceChildren();
    (data.latest || []).forEach(function (item) {
      previewEl.append(card(item));
    });
    exportBtn.disabled = count === 0;
    showPanel();
  }

  async function request(url, options) {
    const response = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
    if (response.status === 401) {
      showLogin();
      throw new Error("auth");
    }
    return response;
  }

  async function loadState() {
    try {
      const response = await request("/api/admin/state");
      if (!response.ok) throw new Error("state");
      render(await response.json());
    } catch (error) {
      if (error.message !== "auth") {
        loginError.textContent = "Не удалось загрузить отклики. Обнови страницу.";
      }
    }
  }

  loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    loginError.textContent = "";
    const button = loginForm.querySelector("button");
    button.disabled = true;
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passwordInput.value })
      });
      if (!response.ok) {
        loginError.textContent = response.status === 429
          ? "Слишком много попыток. Подожди немного."
          : "Неверный пароль.";
        return;
      }
      passwordInput.value = "";
      await loadState();
    } catch (error) {
      loginError.textContent = "Сервер недоступен. Проверь, запущен ли он.";
    } finally {
      button.disabled = false;
    }
  });

  exportBtn.addEventListener("click", async function () {
    if (exportBtn.disabled) return;
    if (!window.confirm("Выгрузить все отклики в Excel и удалить их с сайта?")) return;
    exportBtn.disabled = true;
    const oldText = exportBtn.textContent;
    exportBtn.textContent = "Собираю файл…";
    try {
      const response = await request("/api/admin/export", { method: "POST" });
      if (response.status === 409) {
        exportBtn.textContent = oldText;
        exportBtn.disabled = true;
        return;
      }
      if (!response.ok) throw new Error("export");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : "ochakovo-applications.xlsx";
      const link = document.createElement("a");
      const href = URL.createObjectURL(blob);
      link.href = href;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 30000);
      // Сервер удаляет записи после отдачи файла; даём ему завершить запись.
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      await loadState();
    } catch (error) {
      if (error.message !== "auth") {
        exportBtn.textContent = "Не получилось. Попробуй ещё раз";
        setTimeout(function () {
          exportBtn.textContent = oldText;
          exportBtn.disabled = count === 0;
        }, 2500);
      }
    }
  });

  logoutBtn.addEventListener("click", async function () {
    try {
      await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
    } catch (error) {}
    showLogin();
  });

  loadState();
})();
