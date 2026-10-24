/* Хранилище откликов. Для демо — один JSON-файл и один процесс.
   Для продакшена замените на БД; API снаружи останется тем же. */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const MAX_RECORDS = 5000;

function emptyState() {
  return { applications: [] };
}

function normalizeText(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max || 300);
}

class Store {
  constructor(file) {
    this.file = file;
    this.dir = path.dirname(file);
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.applications)) {
        this.state.applications = parsed.applications.filter(function (item) {
          return item && typeof item === "object" && item.ticket;
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        const backup = this.file + ".broken-" + Date.now();
        try { await fsp.copyFile(this.file, backup); } catch (copyError) {}
        console.error("[store] не удалось прочитать базу, создана резервная копия", backup);
      }
      this.state = emptyState();
    }
    return this;
  }

  all() {
    return this.state.applications.slice();
  }

  count() {
    return this.state.applications.length;
  }

  latest(limit) {
    return this.state.applications.slice(-Math.max(1, limit || 1)).reverse();
  }

  async add(record) {
    if (this.state.applications.length >= MAX_RECORDS) {
      throw new Error("Слишком много откликов для демо-хранилища");
    }
    this.state.applications.push(record);
    await this.persist();
    return record;
  }

  async remove(ids) {
    const set = new Set(ids);
    const before = this.state.applications.length;
    this.state.applications = this.state.applications.filter(function (item) {
      return !set.has(item.id);
    });
    if (this.state.applications.length !== before) await this.persist();
    return before - this.state.applications.length;
  }

  async persist() {
    const payload = JSON.stringify(this.state, null, 2) + "\n";
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = this.file + ".tmp-" + process.pid + "-" + Date.now();
      await fsp.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(tmp, this.file);
    });
    return this.writeQueue;
  }
}

function createTicket(existing) {
  const used = new Set(existing.map(function (item) { return item.ticket; }));
  const year = String(new Date().getFullYear()).slice(-2);
  for (let i = 0; i < 50; i += 1) {
    const n = crypto.randomInt(1000, 9999);
    const ticket = "HR-" + year + "-" + n;
    if (!used.has(ticket)) return ticket;
  }
  return "HR-" + year + "-" + crypto.randomUUID().slice(0, 8).toUpperCase();
}

function normalizeApplication(input) {
  const name = normalizeText(input.name, 120);
  const birthDate = normalizeText(input.birthDate, 10);
  const education = normalizeText(input.education, 180);
  const phone = normalizeText(input.phone, 40);
  const email = normalizeText(input.email, 160);
  const city = normalizeText(input.city, 120);
  const resumeLink = normalizeText(input.resumeLink, 500);
  const vacancy = normalizeText(input.vacancy, 120);
  const charId = normalizeText(input.charId, 40);
  const source = normalizeText(input.source, 80) || "brodilka-site";

  const errors = [];
  if (name.length < 2) errors.push("name");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) errors.push("birthDate");
  else {
    const d = new Date(birthDate + "T00:00:00Z");
    const year = d.getUTCFullYear();
    if (Number.isNaN(d.getTime()) || year < 1900 || d > new Date()) errors.push("birthDate");
  }
  if (phone.replace(/\D/g, "").length < 10) errors.push("phone");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) errors.push("email");
  if (input.consent !== true && input.consent !== "true" && input.consent !== "on") errors.push("consent");

  return {
    errors: errors,
    data: {
      name: name,
      birthDate: birthDate,
      education: education,
      phone: phone,
      email: email,
      city: city,
      resumeLink: resumeLink,
      vacancy: vacancy,
      charId: charId,
      source: source,
      consent: true
    }
  };
}

module.exports = {
  Store: Store,
  createTicket: createTicket,
  normalizeApplication: normalizeApplication
};
