(function () {
  "use strict";

  const DATA = window.BRODILKA_DATA;
  const INTRO = DATA.intro;
  const SPEAKERS = DATA.speakers;
  const CHARACTERS = DATA.characters;
  const EMPLOYER_BENEFITS = Array.isArray(DATA.employerBenefits) ? DATA.employerBenefits : [];
  const STORAGE_KEY = "ochakovo-brodilka-v1";
  const DESIGN_KEY = "ochakovo-brodilka-design";
  const DESIGN_DEFAULT = "brand";
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");
  const modalRoot = document.getElementById("modalRoot");
  const soundToggle = document.getElementById("soundToggle");
  const installBtn = document.getElementById("installApp");
  const srStatus = document.getElementById("srStatus");

  let state = loadState();
  let currentScreen = "landing";
  let lastRenderedScreen = null;
  let introIndex = 0;
  let stepState = null;
  let currentResult = null;
  let modalCallback = null;
  let modalPreviousFocus = null;
  let activeTimers = [];
  let toastTimer = null;
  let audioContext = null;
  let installPromptEvent = null;
  let historyBooted = false;
  let suppressHistory = false;
  let lastHistoryScreen = null;

  /* -------------------------------------------------------
     Icons
     ------------------------------------------------------- */

  const icon = {
    arrow: '<svg class="arrow" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowLeft: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12H5M11 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    gift: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 10h16v10H4V10ZM3 7h18v3H3V7ZM12 7v13" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 7c-2.8 0-4.5-1-4.5-2.6C7.5 3.3 8.4 2.5 9.6 2.5c1.8 0 2.4 2.2 2.4 4.5Zm0 0c2.8 0 4.5-1 4.5-2.6 0-1.1-.9-1.9-2.1-1.9-1.8 0-2.4 2.2-2.4 4.5Z" stroke="currentColor" stroke-width="1.5"/></svg>',
    check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.4 4.5L19 6.8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8"/></svg>',
    doc: '<svg width="17" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 2.8h8l4 4V21H6V2.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 2.8V7h4M9 11h6M9 14.5h6M9 18h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    share: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="5.5" r="3" stroke="currentColor" stroke-width="1.7"/><circle cx="18" cy="18.5" r="3" stroke="currentColor" stroke-width="1.7"/><path d="m8.7 10.7 6.6-3.7M8.7 13.3l6.6 3.7" stroke="currentColor" stroke-width="1.6"/></svg>',
    map: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 4-5 2v14l5-2 6 2 5-2V4l-5 2-6-2ZM9 4v14M15 6v14" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    spark: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5c.7 6 3 8.4 9 9.5-6 1.1-8.3 3.5-9 9.5-.7-6-3-8.4-9-9.5 6-1.1 8.3-3.5 9-9.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.1 8.3A7.5 7.5 0 0 1 19.6 12M4.4 12a7.5 7.5 0 0 0 13.5 3.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
  };

  /* -------------------------------------------------------
     Helpers
     ------------------------------------------------------- */

  function defaultState() {
    return {
      version: 1,
      introSeen: false,
      sound: true,
      activeQuest: null,
      completed: {},
      prizes: [],
      applications: [],
      lastResult: null,
      lastApplication: null
    };
  }

  function getCharacter(id) {
    return CHARACTERS.find(function (char) {
      return char.id === id;
    }) || null;
  }

  function getSpeaker(id) {
    return SPEAKERS[id] || SPEAKERS.bubble;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function pad2(number) {
    return String(number).padStart(2, "0");
  }

  function starsHTML(count, total) {
    const max = total || 3;
    let out = "";
    for (let i = 0; i < max; i += 1) {
      out += i < count ? "<span>★</span>" : '<span class="off">★</span>';
    }
    return out;
  }

  function formatPh(value) {
    return Number(value).toFixed(1).replace(".", ",");
  }

  function formatRange(target) {
    if (!Array.isArray(target) || target.length < 2) return "";
    return formatPh(target[0]) + "–" + formatPh(target[1]);
  }

  function formatBirthDate(value) {
    const text = String(value == null ? "" : value).trim();
    const parts = text.split("-");
    if (parts.length !== 3 || parts[0].length !== 4) return "не указана";
    return parts[2] + "." + parts[1] + "." + parts[0];
  }

  function stripTags(value) {
    return String(value == null ? "" : value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function characterRoles() {
    return CHARACTERS.map(function (char) {
      return escapeHtml(String(char.role || "").toLowerCase());
    });
  }

  function parsePh(value) {
    return Number(String(value).replace(",", "."));
  }

  function completedCount() {
    return Object.keys(state.completed).length;
  }

  function allCharactersDone() {
    return CHARACTERS.every(function (char) {
      return Boolean(state.completed[char.id]);
    });
  }

  function getActiveCharacter() {
    return state.activeQuest ? getCharacter(state.activeQuest.charId) : null;
  }

  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function randomCodePart(length) {
    const bytes = new Uint8Array(length);
    const cryptoObj = window.crypto || window.msCrypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      cryptoObj.getRandomValues(bytes);
    } else {
      for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  function collectUsedCodes(sourceState) {
    const used = {};
    if (!sourceState) return used;
    const completed = sourceState.completed || {};
    Object.keys(completed).forEach(function (charId) {
      const code = completed[charId] && completed[charId].code;
      if (code) used[code] = true;
    });
    const prizes = Array.isArray(sourceState.prizes) ? sourceState.prizes : [];
    prizes.forEach(function (prize) {
      if (prize && prize.code) used[prize.code] = true;
    });
    if (sourceState.lastResult && sourceState.lastResult.code) {
      used[sourceState.lastResult.code] = true;
    }
    return used;
  }

  /* 6+ случайных символов из криптостойкого источника; коллизии исключаем. */
  function generateCode(usedMap) {
    const used = usedMap || {};
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidate = "OCHK-" + randomCodePart(8);
      if (!used[candidate]) return candidate;
    }
    return "OCHK-" + randomCodePart(12);
  }

  function generateTicket() {
    const number = Math.floor(1000 + Math.random() * 9000);
    return "HR-" + pad2(new Date().getDate()) + "-" + number;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function addTimeout(fn, delay) {
    const id = window.setTimeout(function () {
      activeTimers = activeTimers.filter(function (timer) {
        return timer.id !== id;
      });
      fn();
    }, delay);
    activeTimers.push({ type: "timeout", id: id });
    return id;
  }

  function addInterval(fn, delay) {
    const id = window.setInterval(fn, delay);
    activeTimers.push({ type: "interval", id: id });
    return id;
  }

  function clearActiveTimers() {
    activeTimers.forEach(function (timer) {
      if (timer.type === "interval") {
        window.clearInterval(timer.id);
      } else {
        window.clearTimeout(timer.id);
      }
    });
    activeTimers = [];
  }

  /* -------------------------------------------------------
     Persistence
     ------------------------------------------------------- */

  function loadState() {
    const fallback = defaultState();
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return fallback;
      const merged = Object.assign(fallback, parsed);

      /* Сценарий мог обновиться: выкидываем прогресс по несуществующим героям. */
      if (merged.activeQuest && !getCharacter(merged.activeQuest.charId)) {
        merged.activeQuest = null;
      }
      if (merged.activeQuest) {
        const activeChar = getCharacter(merged.activeQuest.charId);
        if (!Number.isInteger(merged.activeQuest.stepIndex) || merged.activeQuest.stepIndex < 0) {
          merged.activeQuest = null;
        } else {
          if (activeChar && merged.activeQuest.stepIndex >= activeChar.steps.length) {
            /* Битый индекс (например, после смены сценария) — начинаем смену заново. */
            merged.activeQuest.stepIndex = 0;
          }
          if (!Number.isFinite(merged.activeQuest.stars) || merged.activeQuest.stars < 0) {
            merged.activeQuest.stars = 0;
          }
          if (!Array.isArray(merged.activeQuest.rewardedSteps)) {
            merged.activeQuest.rewardedSteps = [];
          }
        }
      }

      const prizes = Array.isArray(merged.prizes)
        ? merged.prizes.filter(function (prize) {
            return prize && typeof prize === "object" && prize.code;
          })
        : [];
      const usedCodes = {};
      prizes.forEach(function (prize) {
        if (usedCodes[prize.code]) prize.code = generateCode(usedCodes);
        usedCodes[prize.code] = true;
      });

      const completed = merged.completed && typeof merged.completed === "object" ? merged.completed : {};
      Object.keys(completed).forEach(function (charId) {
        const char = getCharacter(charId);
        const record = completed[charId];
        if (!char || !record || typeof record !== "object") {
          delete completed[charId];
          return;
        }
        const stars = Number(record.stars);
        record.stars = Number.isFinite(stars) ? Math.max(0, Math.min(char.steps.length, Math.round(stars))) : 0;
        if (!record.code || usedCodes[record.code]) record.code = generateCode(usedCodes);
        usedCodes[record.code] = true;
      });
      merged.completed = completed;
      merged.prizes = prizes;

      merged.applications = Array.isArray(merged.applications)
        ? merged.applications.filter(function (entry) {
            return entry && typeof entry === "object" && entry.ticket;
          })
        : [];
      if (merged.lastResult && (!merged.lastResult.charId || !getCharacter(merged.lastResult.charId))) {
        merged.lastResult = null;
      }
      if (merged.lastApplication && !stateHasApplication(merged, merged.lastApplication.ticket)) {
        merged.lastApplication = null;
      }
      merged.sound = merged.sound !== false;
      return merged;
    } catch (error) {
      return fallback;
    }
  }

  function stateHasApplication(candidate, ticket) {
    return candidate.applications.some(function (entry) {
      return entry.ticket === ticket;
    });
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      /* localStorage may be unavailable in private mode */
    }
  }

  /* -------------------------------------------------------
     Audio
     ------------------------------------------------------- */

  function playSound(kind) {
    if (!state.sound) return;
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!audioContext) audioContext = new AudioCtor();
      if (audioContext.state === "suspended") audioContext.resume();

      const patterns = {
        click: { notes: [430], duration: 0.035, type: "sine", volume: 0.035 },
        good: { notes: [523.25, 659.25, 783.99], duration: 0.09, type: "sine", volume: 0.055 },
        bad: { notes: [190, 145], duration: 0.11, type: "triangle", volume: 0.045 },
        win: { notes: [523.25, 659.25, 783.99, 1046.5], duration: 0.13, type: "sine", volume: 0.055 }
      };
      const pattern = patterns[kind] || patterns.click;
      let start = audioContext.currentTime;

      pattern.notes.forEach(function (frequency) {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = pattern.type;
        osc.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(pattern.volume, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + pattern.duration);
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(start);
        osc.stop(start + pattern.duration + 0.02);
        start += pattern.duration * 0.72;
      });
    } catch (error) {
      /* Audio should never block the game */
    }
  }

  function applySoundState() {
    if (!soundToggle) return;
    soundToggle.classList.toggle("is-muted", !state.sound);
    soundToggle.setAttribute("aria-pressed", state.sound ? "true" : "false");
    soundToggle.setAttribute("aria-label", state.sound ? "Выключить звук" : "Включить звук");
  }

  /* -------------------------------------------------------
     Screen shell
     ------------------------------------------------------- */

  function setScreen(html, options) {
    const opts = options || {};
    clearActiveTimers();
    app.innerHTML = html;
    updateHeader();
    applySoundState();

    /* Каждый верхнеуровневый экран — отдельная запись истории:
       системная кнопка «Назад» в PWA не должна выбрасывать из игры. */
    if (!historyBooted) {
      historyBooted = true;
      lastHistoryScreen = currentScreen;
      try {
        window.history.replaceState({ screen: currentScreen }, "", window.location.href);
      } catch (error) {
        /* file:// и старые браузеры могут запрещать history API */
      }
    } else if (!suppressHistory && opts.replaceHistory) {
      lastHistoryScreen = currentScreen;
      try {
        window.history.replaceState({ screen: currentScreen }, "", window.location.href);
      } catch (error) {
        /* noop */
      }
    } else if (!suppressHistory && currentScreen !== lastHistoryScreen) {
      lastHistoryScreen = currentScreen;
      try {
        window.history.pushState({ screen: currentScreen }, "", window.location.href);
      } catch (error) {
        /* noop */
      }
    }

    if (opts.scroll !== false) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
    /* Перевели на новый экран — сообщаем об этом клавиатуре и скринридеру. */
    if (lastRenderedScreen !== currentScreen) {
      lastRenderedScreen = currentScreen;
      try {
        app.focus({ preventScroll: true });
      } catch (error) {
        app.focus();
      }
    }
  }

  function announce(message) {
    if (!srStatus) return;
    srStatus.textContent = "";
    window.setTimeout(function () {
      srStatus.textContent = message;
    }, 60);
  }

  function updateHeader() {
    const headStatus = document.getElementById("headStatus");
    if (!headStatus) return;
    let html = "";

    if (currentScreen === "intro") {
      html = '<div class="hs-row"><span class="hs-dot"></span><span>Введение</span><span class="hs-strong">' + (introIndex + 1) + " / " + INTRO.length + "</span></div>";
    } else if (currentScreen === "characters") {
      html = '<div class="hs-row"><span class="hs-dot"></span><span>Выбор героя</span><span class="hs-strong">' + completedCount() + " / " + CHARACTERS.length + " смены</span></div>";
    } else if (currentScreen === "game") {
      const char = getActiveCharacter();
      if (char && state.activeQuest) {
        html = '<div class="hs-row"><span class="hs-dot"></span><span>Смена ' + char.order + " · " + escapeHtml(char.name) + '</span><span class="hs-stars">' + starsHTML(state.activeQuest.stars) + "</span></div>";
      }
    } else if (currentScreen === "result") {
      html = '<div class="hs-row"><span class="hs-dot"></span><span>Смена закрыта</span><span class="hs-strong">' + ((state.lastResult && state.lastResult.reward) || 150) + " баллов</span></div>";
    } else if (currentScreen === "apply") {
      html = '<div class="hs-row"><span class="hs-dot"></span><span>Отклик на вакансию</span><span class="hs-strong">HR</span></div>';
    } else if (currentScreen === "success") {
      const delivered = Boolean(state.lastApplication && state.lastApplication.delivered);
      html = '<div class="hs-row"><span class="hs-dot"></span><span>' + (delivered ? "Карточка отправлена" : "Карточка сохранена") + '</span><span class="hs-strong">HR</span></div>';
    }

    headStatus.innerHTML = html;
    applySoundState();

    const titles = {
      landing: "БРОДИЛКА: первая смена на Очаково",
      intro: "Введение · БРОДИЛКА",
      characters: "Выбор героя · БРОДИЛКА",
      game: getActiveCharacter() ? "Смена · " + getActiveCharacter().name + " · БРОДИЛКА" : "Смена · БРОДИЛКА",
      result: "Смена закрыта · БРОДИЛКА",
      apply: "Отклик на вакансию · БРОДИЛКА",
      success: "Карточка отправлена · БРОДИЛКА"
    };
    if (titles[currentScreen]) document.title = titles[currentScreen];
  }

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove("is-visible");
    }, 2800);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (error) {
      return false;
    }
  }

  /* -------------------------------------------------------
     Share (общая промо-картинка, без кода и личных данных)
     ------------------------------------------------------- */

  const SHARE_IMAGE = "assets/share-promo.png";

  function sharePageUrl() {
    const config = window.BRODILKA_CONFIG || {};
    const configured = String(config.shareUrl || "").trim();
    return configured || window.location.href;
  }

  function shareMessage() {
    return "Сыграй в БРОДИЛКУ: квест Очаково о квасе и лимонадах. " + sharePageUrl();
  }

  function loadShareImage() {
    return fetch(SHARE_IMAGE, { cache: "force-cache" })
      .then(function (response) {
        if (!response.ok) throw new Error("share image " + response.status);
        return response.blob();
      })
      .then(function (blob) {
        const type = blob.type && blob.type.indexOf("image/") === 0 ? blob.type : "image/png";
        const file = new File([blob], "brodilka-share.png", { type: type });
        return { blob: blob, file: file };
      })
      .catch(function () {
        return null;
      });
  }

  function triggerDownload(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function sharePromo() {
    const text = shareMessage();
    return loadShareImage().then(function (image) {
      const canShareFiles =
        image &&
        navigator.canShare &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [image.file] });
      if (navigator.share && typeof navigator.share === "function") {
        const payload = { title: "БРОДИЛКА", text: text };
        if (canShareFiles) payload.files = [image.file];
        return navigator
          .share(payload)
          .then(function () {
            return true;
          })
          .catch(function (error) {
            if (error && error.name === "AbortError") return true;
            return shareFallback(image, text);
          });
      }
      return shareFallback(image, text);
    });
  }

  function shareFallback(image, text) {
    let imageSaved = false;
    if (image) {
      const url = URL.createObjectURL(image.blob);
      try {
        triggerDownload(url, "brodilka-share.png");
        imageSaved = true;
      } catch (error) {
        imageSaved = false;
      }
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 5000);
    } else {
      try {
        triggerDownload(SHARE_IMAGE, "brodilka-share.png");
        imageSaved = true;
      } catch (error) {
        imageSaved = false;
      }
    }
    return copyText(text).then(function (copied) {
      if (imageSaved && copied) {
        showToast("Картинка скачана, текст со ссылкой скопирован.");
      } else if (copied) {
        showToast("Текст со ссылкой скопирован.");
      } else {
        showToast("Ссылка на игру: " + sharePageUrl());
      }
      return true;
    });
  }

  /* -------------------------------------------------------
     Modal
     ------------------------------------------------------- */

  function openModal(options) {
    modalPreviousFocus = document.activeElement;
    modalCallback = options.onConfirm || null;
    modalRoot.innerHTML =
      '<div class="modal-backdrop" data-modal-backdrop="true">' +
        '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="modalText">' +
          '<div class="mono-label">' + escapeHtml(options.eyebrow || "Подтверждение") + "</div>" +
          '<h3 id="modalTitle">' + escapeHtml(options.title || "Уверен?") + "</h3>" +
          '<p id="modalText">' + escapeHtml(options.text || "") + "</p>" +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost" type="button" data-action="modal-close">' + escapeHtml(options.cancelLabel || "Остаться") + "</button>" +
            '<button class="btn ' + (options.danger ? "btn-orange" : "btn-primary") + '" type="button" data-action="modal-confirm">' + escapeHtml(options.confirmLabel || "Продолжить") + "</button>" +
          "</div>" +
        "</div>" +
      "</div>";
    document.body.classList.add("is-locked");
    window.requestAnimationFrame(function () {
      const confirm = modalRoot.querySelector('[data-action="modal-confirm"]');
      if (confirm) confirm.focus();
    });
    announce((options.title || "Подтверждение") + ". " + (options.text || ""));
  }

  function closeModal() {
    modalRoot.innerHTML = "";
    document.body.classList.remove("is-locked");
    modalCallback = null;
    if (modalPreviousFocus && document.contains(modalPreviousFocus)) {
      try {
        modalPreviousFocus.focus();
      } catch (error) {
        /* noop */
      }
    }
    modalPreviousFocus = null;
  }

  /* -------------------------------------------------------
     Fatal / empty state
     ------------------------------------------------------- */

  function renderFatal(message) {
    currentScreen = "fatal";
    const html =
      '<section class="screen fatal-screen">' +
        '<div class="fatal-card">' +
          '<div class="eyebrow">БРОДИЛКА</div>' +
          '<h1 class="display">Смена<br><em>не загрузилась.</em></h1>' +
          "<p>" + escapeHtml(message || "Сценарий не прочитался. Обнови страницу. Если не помогло, проверь js/data.js и папку assets.") + "</p>" +
          '<button class="btn btn-primary" type="button" data-action="reload-app">Обновить страницу ' + icon.refresh + "</button>" +
        "</div>" +
      "</section>";
    setScreen(html);
  }

  /* -------------------------------------------------------
     Landing
     ------------------------------------------------------- */

  function footerMarkup() {
    return (
      '<footer class="site-footer">' +
        '<div class="site-footer-left">' +
          '<span class="footer-mark">ОЧАКОВО × БРОДИЛКА</span>' +
          '<span class="footer-dot"></span>' +
          "<span>Демо, не публичная оферта</span>" +
        "</div>" +
        '<div class="site-footer-left">' +
          "<span>Прогресс живёт в этом браузере</span>" +
          '<span class="footer-dot"></span>' +
          '<button class="footer-reset" type="button" data-action="reset-progress">Сбросить прогресс</button>' +
        "</div>" +
        designSwitchMarkup() +
      "</footer>"
    );
  }

  /* -------------------------------------------------------
     Design switch (Очаково / БРОДИЛКА)
     ------------------------------------------------------- */

  function currentDesign() {
    const value = document.documentElement.getAttribute("data-design");
    return value === "brodilka" ? "brodilka" : DESIGN_DEFAULT;
  }

  function designThemeColor(design) {
    return design === "brodilka" ? "#0C3B28" : "#D50032";
  }

  function applyDesign(design, persist) {
    const next = design === "brodilka" ? "brodilka" : "brand";
    document.documentElement.setAttribute("data-design", next);
    const theme = document.getElementById("themeColor");
    if (theme) theme.setAttribute("content", designThemeColor(next));
    const buttons = document.querySelectorAll(".design-switch-btn");
    Array.prototype.forEach.call(buttons, function (button) {
      const active = button.getAttribute("data-design-value") === next;
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (persist !== false) {
      try {
        window.localStorage.setItem(DESIGN_KEY, next);
      } catch (error) {
        /* localStorage может быть недоступен */
      }
    }
  }

  function designSwitchMarkup() {
    const design = currentDesign();
    const isBrand = design === "brand";
    return (
      '<div class="design-switch" role="group" aria-label="Оформление сайта">' +
        '<span class="design-switch-label">Дизайн</span>' +
        '<button class="design-switch-btn" type="button" data-action="design-brand" data-design-value="brand" aria-pressed="' + (isBrand ? "true" : "false") + '">Очаково</button>' +
        '<button class="design-switch-btn" type="button" data-action="design-brodilka" data-design-value="brodilka" aria-pressed="' + (isBrand ? "false" : "true") + '">БРОДИЛКА</button>' +
      "</div>"
    );
  }

  function renderLanding() {
    currentScreen = "landing";
    const activeChar = getActiveCharacter();
    const active = state.activeQuest && activeChar;
    const primaryLabel = active ? "Продолжить смену-квест" : (allCharactersDone() ? "Пройти смену-квест ещё раз" : "Начать смену-квест");
    const primaryAction = active ? "resume-quest" : "start-quest";
    const metaText = active
      ? "Смена " + activeChar.order + " · " + escapeHtml(activeChar.name) + " · этап " + (state.activeQuest.stepIndex + 1) + " из " + activeChar.steps.length
      : "7 минут";
    const guideText = active
      ? "Этап " + (state.activeQuest.stepIndex + 1).toString() + ". Не потерялся? Фух. Продолжим?"
      : "Погнали. Смена не ждёт. Я Пузырь, гид. С 1996 года на заводе. Показываю, объясняю. Смену проходишь ты.";

    const roleTags = characterRoles()
      .map(function (role) {
        return '<span class="hero-tag">#' + role.split(" ")[0] + "</span>";
      })
      .join("") + '<span class="hero-tag">#приз за смену</span>';
    const rolesText = CHARACTERS.map(function (char) {
      return escapeHtml(String(char.role || "").toLowerCase());
    }).join(", ");
    const marqueeGroup =
      '<div class="marquee-group">' +
        CHARACTERS.map(function (char) {
          return "<span>Смена " + escapeHtml(char.order) + " · " + escapeHtml(char.role) + '</span><span class="star">✦</span>';
        }).join("") +
        "<span>Приз: 150 баллов</span><span class=\"star\">✦</span>" +
      "</div>";

    const html =
      '<section class="screen landing">' +
        '<div class="landing-hero">' +
          '<div class="hero-side-note"><span class="dot"></span>Первая смена · 7 минут</div>' +
          '<div class="hero-copy">' +
            '<div class="eyebrow">Интерактивный квест · первая смена</div>' +
            '<h1 class="hero-title">' +
              '<span class="line">Зайди</span>' +
              '<span class="line">на завод<span style="color:var(--orange)">.</span></span>' +
              '<span class="accent">Не на<br>экскурсию.</span>' +
            "</h1>" +
            '<p class="hero-sub">Три смены, три характера, один завод: квас, лимонады и вода. Выбери героя, пройди смену и забери приз. <strong>Без лекций и тестов.</strong></p>' +
            '<div class="hero-actions">' +
              '<button class="btn btn-primary btn-lg" type="button" data-action="' + primaryAction + '">' + primaryLabel + " " + icon.arrow + "</button>" +
              '<span class="hero-or" aria-hidden="true">или</span>' +
              '<button class="btn btn-ghost btn-lg hero-quick" type="button" data-action="quick-apply">Перейти к вакансиям</button>' +
              '<span class="hero-meta">' + icon.clock + " " + metaText + "</span>" +
            "</div>" +
            '<div class="hero-tags">' + roleTags + "</div>" +
          "</div>" +
          '<div class="hero-art">' +
            '<img class="hero-can" src="assets/hero-can.svg" alt="Бутылка кваса и банка лимонада БРОДИЛКА">' +
            '<div class="hero-guide">' +
              '<img src="assets/mascot.svg" alt="Пузырь, гид по заводу">' +
              '<div class="hero-guide-note">' + guideText + "</div>" +
            "</div>" +
          "</div>" +
        "</div>" +

        '<div class="marquee" aria-hidden="true">' +
          '<div class="marquee-track">' +
            marqueeGroup +
            marqueeGroup +
          "</div>" +
        "</div>" +

        '<section class="how" id="how">' +
          '<div class="how-head">' +
            '<div class="how-title-block">' +
              '<div class="eyebrow">Как это работает</div>' +
              '<h2 class="display">Три шага<br><em>до приза.</em></h2>' +
            "</div>" +
          "</div>" +
          '<div class="how-grid">' +
            '<article class="how-card">' +
              '<div class="how-num">01 / ВЫБОР</div>' +
              "<h3>Выбери героя</h3>" +
              "<p>" + escapeHtml(rolesText.charAt(0).toUpperCase() + rolesText.slice(1)) + ". У каждого свой маршрут и свой взгляд на завод.</p>" +
              '<div class="how-icon">' + icon.map + "</div>" +
            "</article>" +
            '<article class="how-card">' +
              '<div class="how-num">02 / СМЕНА</div>' +
              "<h3>Пройди смену</h3>" +
              "<p>Короткие диалоги, рабочие задачки и мини-игры. Лекций на сорок минут не будет.</p>" +
              '<div class="how-icon">' + icon.spark + "</div>" +
            "</article>" +
            '<article class="how-card">' +
              '<div class="how-num">03 / ПРИЗ</div>' +
              "<h3>Забери приз</h3>" +
              "<p>150 баллов на продукцию Очаково на маркетплейсах. Захочешь, откликнешься на вакансию.</p>" +
              '<div class="how-icon">' + icon.gift + "</div>" +
            "</article>" +
          "</div>" +
          '<div class="how-reward">' +
            '<div class="how-reward-left">' +
              '<span class="how-reward-icon">' + icon.gift + "</span>" +
              "<div>" +
                "<h3>Приз за пройденную смену</h3>" +
                "<p>150 баллов на продукцию Очаково. Промокод появится сразу после финала.</p>" +
              "</div>" +
            "</div>" +
            '<button class="btn btn-dark" type="button" data-action="' + primaryAction + '">' + primaryLabel + " " + icon.arrow + "</button>" +
          "</div>" +
        "</section>" +
        footerMarkup() +
      "</section>";

    setScreen(html);
  }

  /* -------------------------------------------------------
     Intro
     ------------------------------------------------------- */

  function introSpeakerVisual(speaker) {
    if (speaker.avatar) {
      return '<img class="intro-speaker-img" src="' + speaker.avatar + '" alt="">';
    }
    return '<span class="intro-monogram" aria-hidden="true">' + escapeHtml(speaker.initials || "О") + "</span>";
  }

  function introSpeakerMarkup(speakerId) {
    const speaker = getSpeaker(speakerId);
    return (
      '<div class="intro-speaker-media">' + introSpeakerVisual(speaker) + "</div>" +
      '<div class="intro-speaker-tag">' +
        '<span class="intro-speaker-kicker">говорит</span>' +
        "<strong>" + escapeHtml(speaker.name) + "</strong>" +
        '<span class="intro-speaker-role">' + escapeHtml(speaker.role) + "</span>" +
      "</div>"
    );
  }

  function updateIntroLine() {
    if (!INTRO.length) return;
    const line = INTRO[introIndex] || INTRO[0];
    const speaker = getSpeaker(line.speaker);
    const isLast = introIndex === INTRO.length - 1;
    const progress = Math.round(((introIndex + 1) / INTRO.length) * 100);

    const speakerEl = document.getElementById("introSpeaker");
    if (speakerEl) speakerEl.innerHTML = introSpeakerMarkup(line.speaker);
    const textEl = document.getElementById("introText");
    if (textEl) textEl.innerHTML = line.text;
    const counterEl = document.getElementById("introCounter");
    if (counterEl) counterEl.textContent = pad2(introIndex + 1) + " / " + pad2(INTRO.length);
    const progressEl = document.getElementById("introProgressBar");
    if (progressEl) progressEl.style.width = progress + "%";
    const nextBtn = document.getElementById("introNextBtn");
    if (nextBtn) nextBtn.innerHTML = (isLast ? "Выбрать героя" : "Дальше") + " " + icon.arrow;

    /* Шапка тоже показывает прогресс интро: обновляем её без перерисовки экрана. */
    updateHeader();
    announce(speaker.name + ": " + stripTags(line.text));
  }

  function renderIntro() {
    if (!INTRO.length) {
      finishIntro();
      return;
    }
    currentScreen = "intro";
    const progress = Math.round(((introIndex + 1) / INTRO.length) * 100);
    const isLast = introIndex === INTRO.length - 1;

    const html =
      '<section class="screen intro-screen" style="--intro-progress:' + progress + '%">' +
        '<div class="intro-bg">' +
          '<img src="assets/scene-brew.svg" alt="Квасной цех Очаково">' +
        "</div>" +
        '<div class="intro-top">' +
          '<div class="intro-counter">' +
            "<strong>Введение</strong>" +
            '<span id="introCounter">' + pad2(introIndex + 1) + " / " + pad2(INTRO.length) + "</span>" +
            '<span class="intro-progress"><i id="introProgressBar" style="width:' + progress + '%"></i></span>' +
          "</div>" +
          '<button class="intro-skip" type="button" data-action="intro-skip">Пропустить интро ' + icon.arrow + "</button>" +
        "</div>" +
        '<div class="intro-content">' +
          '<div class="intro-speaker" id="introSpeaker" aria-hidden="true"></div>' +
          '<div class="dialogue-card">' +
            '<div class="intro-quote-mark" aria-hidden="true">“</div>' +
            '<p class="dialogue-text" id="introText" aria-live="polite"></p>' +
            '<div class="dialogue-footer">' +
              '<button class="btn btn-primary" id="introNextBtn" type="button" data-action="intro-next">' + (isLast ? "Выбрать героя" : "Дальше") + " " + icon.arrow + "</button>" +
            "</div>" +
          "</div>" +
        "</div>" +
        '<div class="intro-footnote">ОЧАКОВО × БРОДИЛКА / ПЕРВАЯ СМЕНА</div>' +
      "</section>";

    setScreen(html);
    updateIntroLine();
  }

  function advanceIntro() {
    if (introIndex < INTRO.length - 1) {
      introIndex += 1;
      updateIntroLine();
      playSound("click");
    } else {
      finishIntro();
    }
  }

  function finishIntro() {
    state.introSeen = true;
    introIndex = 0;
    saveState();
    playSound("good");
    renderCharacters();
  }

  /* -------------------------------------------------------
     Character select
     ------------------------------------------------------- */

  function renderCharacters() {
    currentScreen = "characters";
    const done = completedCount();
    const allDone = allCharactersDone();

    const cards = CHARACTERS.map(function (char) {
      const completion = state.completed[char.id];
      const active = state.activeQuest && state.activeQuest.charId === char.id;
      let status = '<span class="char-status">' + char.steps.length + " этапа</span>";
      if (active) {
        status = '<span class="char-status is-active">В процессе</span>';
      } else if (completion) {
        status = '<span class="char-status is-done">Пройдено</span>';
      }

      let cta = "Пойти с " + escapeHtml(char.name);
      if (active) cta = "Продолжить";
      else if (completion) cta = "Пройти снова";

      let stars = '<span class="char-stars"><span class="off">★★★</span></span>';
      if (completion) {
        stars = '<span class="char-stars" title="Точность: ' + completion.stars + ' из 3">' + starsHTML(completion.stars, 3) + "</span>";
      } else if (active) {
        stars = '<span class="char-stars" title="Точность: ' + state.activeQuest.stars + ' из 3">' + starsHTML(state.activeQuest.stars, 3) + "</span>";
      }

      return (
        '<article class="character-card" style="--char-accent:' + char.accent + ";--char-deep:" + char.deep + '">' +
          '<div class="char-media">' +
            '<span class="char-num">Смена ' + char.order + "</span>" +
            status +
            '<img src="' + char.image + '" alt="' + escapeHtml(char.name) + ", " + escapeHtml(char.role) + '">' +
          "</div>" +
          '<div class="char-body">' +
            '<div class="char-tag">' + escapeHtml(char.tag) + "</div>" +
            '<div class="char-name"><h3>' + escapeHtml(char.name) + '</h3><span class="char-age">' + escapeHtml(char.age) + " лет</span></div>" +
            '<div class="char-role">' + escapeHtml(char.role) + "</div>" +
            '<p class="char-quote">' + escapeHtml(char.quote) + "</p>" +
            '<ul class="char-route">' +
              char.route.map(function (item) { return "<li>" + escapeHtml(item) + "</li>"; }).join("") +
            "</ul>" +
            '<div class="char-footer">' +
              stars +
              '<button class="btn btn-primary" type="button" data-action="select-character" data-char="' + char.id + '">' + cta + " " + icon.arrow + "</button>" +
            "</div>" +
          "</div>" +
        "</article>"
      );
    }).join("");

    const html =
      '<section class="screen character-screen">' +
        '<div class="character-wrap">' +
          '<div class="character-head">' +
            '<div class="character-title-block">' +
              '<div class="eyebrow">Смена ' + pad2(Math.min(done + 1, CHARACTERS.length)) + " из " + pad2(CHARACTERS.length) + " · выбор героя</div>" +
              '<h1 class="display">С кем<br><em>на смену?</em></h1>' +
            "</div>" +
            '<p class="character-intro">Ошибиться нельзя, а попробовать всех можно. <strong>У каждого свой маршрут и свой повод остаться.</strong> Начни с того, кто ближе. Или с того, кто страшнее.</p>' +
          "</div>" +
          '<div class="character-guide">' +
            '<img src="assets/mascot.svg" alt="">' +
            '<div class="character-guide-text">' +
              '<span class="character-guide-label">Совет Пузыря</span>' +
              "<p>Порядок любой. Приз за каждую смену. Ошибки не страшно. Я видел много смен, волнуюсь всё равно. Ты не бери с меня пример.</p>" +
            "</div>" +
          "</div>" +
          (allDone
            ? '<div class="all-done-banner"><div><span class="mono-label">' + CHARACTERS.length + " / " + CHARACTERS.length + ' смены</span><p>Ты прошёл завод вдоль и поперёк. Теперь знаешь его лучше некоторых сотрудников.</p></div><span class="mono-label">СВОЙ ЧЕЛОВЕК</span></div>'
            : "") +
          '<div class="characters-grid">' + cards + "</div>" +
          '<div class="character-foot">' +
            '<button class="icon-link" type="button" data-action="home">' + icon.arrowLeft + " На главную</button>" +
          "</div>" +
        "</div>" +
        footerMarkup() +
      "</section>";

    setScreen(html);
  }

  /* -------------------------------------------------------
     Quest start / steps
     ------------------------------------------------------- */

  function startNewQuest(charId) {
    state.activeQuest = {
      charId: charId,
      stepIndex: 0,
      stars: 0,
      rewardedSteps: [],
      startedAt: new Date().toISOString()
    };
    stepState = null;
    saveState();
    currentScreen = "game";
    playSound("good");
    renderGame();
  }

  function handleSelectCharacter(charId) {
    const char = getCharacter(charId);
    if (!char) return;
    const active = state.activeQuest;

    if (active && active.charId === charId) {
      currentScreen = "game";
      renderGame();
      return;
    }

    if (active) {
      const activeChar = getCharacter(active.charId);
      if (activeChar) {
        openModal({
          eyebrow: "Смена не закончена",
          title: "Начать другую?",
          text: "Путь за " + activeChar.name + " сбросится на этапе " + (active.stepIndex + 1) + ". Пройти можно заново, но прогресс этой смены пропадёт.",
          cancelLabel: "Остаться",
          confirmLabel: "Начать новую",
          onConfirm: function () {
            startNewQuest(charId);
          }
        });
        return;
      }
    }

    startNewQuest(charId);
  }

  function createStepState(charId, stepIndex) {
    return {
      charId: charId,
      stepIndex: stepIndex,
      phase: "dialogue",
      beat: 0,
      attempts: 0,
      perfect: true,
      starAwarded: false,
      selected: [],
      picked: [],
      disabledChoices: [],
      phValue: null,
      taskData: {},
      defect: null
    };
  }

  function stepRouteMarkup(char, quest) {
    let out = "";
    char.steps.forEach(function (step, index) {
      const isDone = index < quest.stepIndex || (index === quest.stepIndex && stepState.phase === "feedback");
      const isActive = index === quest.stepIndex && stepState.phase !== "feedback";
      if (index > 0) {
        out += '<span class="route-line ' + (index <= quest.stepIndex ? "is-done" : "") + '"></span>';
      }
      out +=
        '<div class="route-stop ' + (isDone ? "is-done" : "") + " " + (isActive ? "is-active" : "") + '"' + (isActive ? ' aria-current="step"' : "") + ">" +
          '<span class="route-dot">' + (isDone ? "✓" : index + 1) + "</span>" +
          '<span class="route-label">' + escapeHtml(char.route[index] || step.title) + "</span>" +
        "</div>";
    });
    out += '<span class="route-line ' + (quest.stepIndex >= char.steps.length - 1 && stepState.phase === "feedback" ? "is-done" : "") + '"></span>';
    out +=
      '<div class="route-stop is-finish ' + (stepState.phase === "feedback" && quest.stepIndex === char.steps.length - 1 ? "is-active" : "") + '"' + (stepState.phase === "feedback" && quest.stepIndex === char.steps.length - 1 ? ' aria-current="step"' : "") + ">" +
        '<span class="route-dot">' + (stepState.phase === "feedback" && quest.stepIndex === char.steps.length - 1 ? "★" : "Ф") + "</span>" +
        '<span class="route-label">Финиш</span>' +
      "</div>";
    return out;
  }

  function sceneMarkup(char, step, quest) {
    return (
      '<div class="scene-panel">' +
        '<img class="scene-bg" src="' + char.scene + '" alt="' + escapeHtml(step.place) + ', сцена смены">' +
        '<div class="scene-top">' +
          '<span class="location-chip">' + escapeHtml(step.place) + " · " + escapeHtml(step.time) + "</span>" +
          '<span class="scene-stamp">Смена ' + char.order + " · Этап " + pad2(quest.stepIndex + 1) + " / " + pad2(char.steps.length) + "</span>" +
        "</div>" +
        '<div class="scene-index" aria-hidden="true">' + pad2(quest.stepIndex + 1) + "</div>" +
        '<div class="scene-bottom">' +
          '<div class="scene-caption"><strong>Что происходит</strong><span>' + escapeHtml(step.sceneNote) + "</span></div>" +
        "</div>" +
      "</div>"
    );
  }

  function gameHeaderMarkup(char, quest) {
    return (
      '<div class="game-hud">' +
        '<button class="icon-link hud-back" type="button" data-action="game-back">' + icon.arrowLeft + " На карту</button>" +
        '<div class="route-map" role="group" aria-label="Маршрут смены">' + stepRouteMarkup(char, quest) + "</div>" +
        '<div class="hud-right">' +
          '<div class="hud-accuracy"><span>Точность</span><span class="hud-stars" role="img" aria-label="' + quest.stars + ' из ' + char.steps.length + '">' + starsHTML(quest.stars, 3) + "</span></div>" +
          '<span class="hud-score" aria-label="Этап ' + (quest.stepIndex + 1) + ' из ' + char.steps.length + '">' + pad2(quest.stepIndex + 1) + " / " + pad2(char.steps.length) + "</span>" +
        "</div>" +
      "</div>"
    );
  }

  function stepMetaMarkup(char, quest, step) {
    return (
      '<div class="step-meta">' +
        '<div class="step-meta-left"><span class="step-bullet"></span>Смена ' + char.order + " · Этап " + pad2(quest.stepIndex + 1) + " / " + pad2(char.steps.length) + "</div>" +
        '<div class="step-meta-right">' + escapeHtml(step.place) + " · " + escapeHtml(step.time) + "</div>" +
      "</div>"
    );
  }

  function chatAvatarMarkup(speaker, extraClass) {
    const cls = "chat-avatar" + (extraClass ? " " + extraClass : "");
    if (speaker.avatar) {
      return '<span class="' + cls + '"><img src="' + speaker.avatar + '" alt=""></span>';
    }
    return '<span class="' + cls + ' is-text">' + escapeHtml(speaker.initials || "?") + "</span>";
  }

  function chatMessageMarkup(beat) {
    const speaker = getSpeaker(beat.speaker);
    const isOwn = beat.speaker === "bubble";
    const isSystem = beat.speaker === "narrator";
    return (
      '<div class="chat-msg' + (isOwn ? " is-own" : "") + (isSystem ? " is-system" : "") + '">' +
        chatAvatarMarkup(speaker) +
        '<div class="chat-msg-body">' +
          '<div class="chat-msg-head"><strong>' + escapeHtml(speaker.name) + "</strong><span>" + escapeHtml(speaker.role) + "</span></div>" +
          '<p class="chat-text">' + beat.text + "</p>" +
        "</div>" +
      "</div>"
    );
  }

  function chatMessagesMarkup(step, upto) {
    const limit = Math.max(0, Math.min(upto, step.beats.length - 1));
    let out = "";
    for (let i = 0; i <= limit; i += 1) {
      out += chatMessageMarkup(step.beats[i]);
    }
    return out;
  }

  function dialogueNextLabel(step) {
    return stepState.beat >= step.beats.length - 1 ? "К заданию" : "Дальше";
  }

  function updateChatNav(step) {
    const next = document.getElementById("chatNextBtn");
    if (next) next.innerHTML = dialogueNextLabel(step) + " " + icon.arrow;
    const back = document.getElementById("chatBackBtn");
    if (back) back.disabled = stepState.beat <= 0;
  }

  function renderDialoguePanel(char, step, quest) {
    return (
      stepMetaMarkup(char, quest, step) +
      '<h2 class="quest-title">' + escapeHtml(step.title) + "</h2>" +
      '<div class="chat-panel">' +
        '<div class="chat-list" id="chatList" role="log" aria-live="polite" aria-label="Диалог смены">' +
          chatMessagesMarkup(step, stepState.beat) +
        "</div>" +
        '<div class="chat-actions">' +
          '<button class="btn btn-ghost chat-back" id="chatBackBtn" type="button" data-action="prev-beat"' + (stepState.beat <= 0 ? " disabled" : "") + '>' + icon.arrowLeft + " Назад</button>" +
          '<button class="btn btn-primary" id="chatNextBtn" type="button" data-action="next-beat">' + dialogueNextLabel(step) + " " + icon.arrow + "</button>" +
        "</div>" +
      "</div>"
    );
  }

  function scrollChatToBottom() {
    const list = document.getElementById("chatList");
    if (list) list.scrollTop = list.scrollHeight;
  }

  function mountTaskGame(step) {
    if (!stepState || !step.task) return;
    if (step.task.type === "ph") {
      mountPhGame(step);
    } else if (step.task.type === "defect") {
      mountDefectGame(step);
    }
  }

  function refreshPanelInPlace(char, step, quest) {
    const panel = document.querySelector(".quest-panel");
    if (!panel) {
      renderGame({ scroll: false });
      return;
    }
    panel.classList.remove("is-dialogue", "is-task", "is-feedback");
    panel.classList.add("is-" + stepState.phase);
    if (stepState.phase === "task") {
      panel.innerHTML = renderTaskPanel(char, step, quest);
    } else if (stepState.phase === "feedback") {
      panel.innerHTML = renderFeedbackPanel(char, step, quest);
    } else {
      panel.innerHTML = renderDialoguePanel(char, step, quest);
    }
    const routeMap = document.querySelector(".route-map");
    if (routeMap) routeMap.innerHTML = stepRouteMarkup(char, quest);
    updateHeader();
    if (stepState.phase === "task") mountTaskGame(step);
    else if (stepState.phase === "dialogue") scrollChatToBottom();
  }

  function renderGame(options) {
    const opts = options || {};
    if (!state.activeQuest) {
      renderCharacters();
      return;
    }
    const quest = state.activeQuest;
    const char = getCharacter(quest.charId);
    if (!char) {
      state.activeQuest = null;
      saveState();
      renderCharacters();
      return;
    }
    if (quest.stepIndex >= char.steps.length) {
      completeQuest();
      return;
    }

    const step = char.steps[quest.stepIndex];
    if (!stepState || stepState.charId !== char.id || stepState.stepIndex !== quest.stepIndex) {
      stepState = createStepState(char.id, quest.stepIndex);
    }
    currentScreen = "game";

    let panel = "";
    if (stepState.phase === "dialogue") {
      panel = renderDialoguePanel(char, step, quest);
    } else if (stepState.phase === "task") {
      panel = renderTaskPanel(char, step, quest);
    } else {
      panel = renderFeedbackPanel(char, step, quest);
    }

    const html =
      '<section class="screen game-screen">' +
        '<div class="game-wrap">' +
          gameHeaderMarkup(char, quest) +
          '<div class="game-layout">' +
            sceneMarkup(char, step, quest) +
            '<div class="quest-panel is-' + stepState.phase + '" data-step="' + pad2(quest.stepIndex + 1) + '">' + panel + "</div>" +
          "</div>" +
        "</div>" +
      "</section>";

    setScreen(html, { scroll: opts.scroll !== false });

    if (stepState.phase === "task") {
      mountTaskGame(step);
    } else if (stepState.phase === "dialogue") {
      scrollChatToBottom();
    }
  }

  function advanceBeat() {
    if (!state.activeQuest || !stepState || stepState.phase !== "dialogue") return;
    const char = getCharacter(state.activeQuest.charId);
    const step = char.steps[state.activeQuest.stepIndex];
    playSound("click");
    if (stepState.beat < step.beats.length - 1) {
      stepState.beat += 1;
      const list = document.getElementById("chatList");
      if (list) {
        list.insertAdjacentHTML("beforeend", chatMessageMarkup(step.beats[stepState.beat]));
      }
      updateChatNav(step);
      scrollChatToBottom();
      const beat = step.beats[stepState.beat];
      const speaker = getSpeaker(beat.speaker);
      announce(speaker.name + ": " + stripTags(beat.text));
    } else {
      stepState.phase = "task";
      stepState.attempts = 0;
      initializeTaskState(step);
      refreshPanelInPlace(char, step, state.activeQuest);
      announce("Задание: " + stripTags(step.task.prompt) + ". " + stripTags(step.task.sub));
    }
  }

  function retreatBeat() {
    if (!state.activeQuest || !stepState || stepState.phase !== "dialogue" || stepState.beat <= 0) return;
    const char = getCharacter(state.activeQuest.charId);
    const step = char.steps[state.activeQuest.stepIndex];
    playSound("click");
    stepState.beat -= 1;
    refreshPanelInPlace(char, step, state.activeQuest);
    scrollChatToBottom();
    const beat = step.beats[stepState.beat];
    const speaker = getSpeaker(beat.speaker);
    announce("Назад. " + speaker.name + ": " + stripTags(beat.text));
  }

  function backToDialogue() {
    if (!state.activeQuest || !stepState || stepState.phase !== "task") return;
    const char = getCharacter(state.activeQuest.charId);
    const step = char.steps[state.activeQuest.stepIndex];
    playSound("click");
    stepState.phase = "dialogue";
    stepState.beat = step.beats.length - 1;
    refreshPanelInPlace(char, step, state.activeQuest);
    scrollChatToBottom();
    announce("Вернулся к диалогу. Можно перечитать последнюю реплику.");
  }

  function initializeTaskState(step) {
    if (step.task.type === "sort") {
      stepState.picked = [];
      if (!stepState.taskData.order) {
        stepState.taskData.order = step.task.displayOrder.slice();
      }
    }
    if (step.task.type === "pick") {
      stepState.selected = [];
    }
    if (step.task.type === "ph" && stepState.phValue == null) {
      stepState.phValue = step.task.start;
    }
    if (step.task.type === "defect" && !stepState.defect) {
      const types = ["low", "cap", "label"];
      const shuffledTypes = types.slice().sort(function () {
        return Math.random() - 0.5;
      });
      const indexes = [];
      const used = [];
      for (let i = 0; i < step.task.rounds; i += 1) {
        let next = Math.floor(Math.random() * 8);
        while (used.includes(next)) {
          next = Math.floor(Math.random() * 8);
        }
        used.push(next);
        indexes.push(next);
      }
      stepState.defect = {
        round: 0,
        types: shuffledTypes,
        indexes: indexes,
        resolved: false,
        wrong: 0
      };
    }
  }

  function registerMistake() {
    if (!stepState) return;
    stepState.perfect = false;
    stepState.attempts += 1;
    playSound("bad");
  }

  function showInlineFeedback(message, type) {
    const box = document.getElementById("inlineFeedback");
    if (!box) return;
    box.textContent = message;
    box.classList.remove("is-error", "is-good", "is-visible");
    box.classList.add(type === "good" ? "is-good" : "is-error", "is-visible");
  }

  function hideInlineFeedback() {
    const box = document.getElementById("inlineFeedback");
    if (box) {
      box.classList.remove("is-visible", "is-error", "is-good");
    }
  }

  function finishTask() {
    if (!stepState || stepState.phase !== "task") return;
    stepState.phase = "feedback";
    const rewarded = state.activeQuest.rewardedSteps || [];
    if (stepState.perfect && !stepState.starAwarded && !rewarded.includes(state.activeQuest.stepIndex)) {
      state.activeQuest.stars += 1;
      rewarded.push(state.activeQuest.stepIndex);
      state.activeQuest.rewardedSteps = rewarded;
      stepState.starAwarded = true;
    }
    saveState();
    playSound("good");
    const char = getActiveCharacter();
    const step = char ? char.steps[state.activeQuest.stepIndex] : null;
    if (char && step) refreshPanelInPlace(char, step, state.activeQuest);
    else renderGame({ scroll: false });
    announce("Этап закрыт." + (step ? " " + stripTags(step.task.success) : ""));
  }

  function nextStep() {
    if (!state.activeQuest || !stepState || stepState.phase !== "feedback") return;
    const quest = state.activeQuest;
    const char = getCharacter(quest.charId);
    playSound("click");
    quest.stepIndex += 1;
    stepState = null;
    saveState();
    if (quest.stepIndex >= char.steps.length) {
      completeQuest();
    } else {
      renderGame();
      const step = char.steps[quest.stepIndex];
      announce("Этап " + (quest.stepIndex + 1) + " из " + char.steps.length + ". " + stripTags(step.title));
    }
  }

  function completeQuest() {
    const quest = state.activeQuest;
    if (!quest) return;
    const char = getCharacter(quest.charId);
    if (!char) return;

    const previous = state.completed[char.id];
    const bestStars = Math.max(previous ? previous.stars : 0, quest.stars);
    const code = generateCode(collectUsedCodes(state));
    const completedAt = new Date().toISOString();
    const completion = {
      charId: char.id,
      stars: bestStars,
      lastStars: quest.stars,
      code: code,
      completedAt: completedAt,
      reward: 150
    };
    state.completed[char.id] = completion;
    state.prizes = Array.isArray(state.prizes) ? state.prizes : [];
    state.prizes.push({
      code: code,
      charId: char.id,
      stars: quest.stars,
      reward: completion.reward,
      createdAt: completedAt
    });
    if (state.prizes.length > 100) state.prizes = state.prizes.slice(-100);
    state.lastResult = completion;
    state.activeQuest = null;
    stepState = null;
    currentResult = completion;
    saveState();
    playSound("win");
    renderResult();
    announce("Смена закрыта. Промокод " + completion.code + ".");
  }

  /* -------------------------------------------------------
     Task renderers
     ------------------------------------------------------- */

  function renderTaskPanel(char, step, quest) {
    const task = step.task;
    let widget = "";
    let footer = "";
    let inline = '<div class="inline-feedback" id="inlineFeedback" role="status" aria-live="polite"></div>';

    if (task.type === "pick") {      widget = renderPickWidget(task);
      const count = stepState.selected.length;
      footer =
        '<div class="task-footer">' +
          '<span class="task-counter" id="pickCount">Выбрано <strong>' + count + " / " + task.required + "</strong></span>" +
          '<button class="btn btn-primary" type="button" data-action="check-recipe"' + (count === task.required ? "" : " disabled") + ">" + escapeHtml(task.check) + " " + icon.arrow + "</button>" +
        "</div>";
    } else if (task.type === "sort") {
      widget = renderSortWidget(task);
      footer =
        '<div class="task-footer">' +
          '<span class="task-counter" id="sortCount">Собрано <strong>' + stepState.picked.length + " / " + task.correct.length + "</strong></span>" +
          '<button class="icon-link" type="button" data-action="sort-reset">' + icon.refresh + " Сбросить</button>" +
        "</div>";
    } else if (task.type === "choice") {
      widget = renderChoiceWidget(task);
      footer =
        '<div class="task-footer">' +
          '<span class="task-counter">Выбери один вариант</span>' +
          '<span class="task-counter">Без таймера</span>' +
        "</div>";
    } else if (task.type === "samples") {
      widget = renderSamplesWidget(task);
      footer =
        '<div class="task-footer">' +
          '<span class="task-counter">Нажми на пробу с отклонением</span>' +
          '<span class="task-counter">Норма: в задании</span>' +
        "</div>";
    } else if (task.type === "ph") {
      widget = renderPhWidget(task);
      footer =
        '<div class="task-footer">' +
          '<span class="task-counter">Цель <strong>' + formatRange(task.target) + " pH</strong></span>" +
          '<button class="btn btn-primary" type="button" data-action="ph-submit">Сделать замер ' + icon.arrow + "</button>" +
        "</div>";
    } else if (task.type === "defect") {
      widget = renderDefectWidget(task);
      footer =
        '<div class="task-footer">' +
          '<span class="task-counter" id="defectRound">Раунд <strong>1 / ' + task.rounds + "</strong></span>" +
          '<div class="round-dots" id="defectDots" aria-hidden="true">' +
            Array.from({ length: task.rounds }, function (_, i) {
              return '<i class="' + (i < stepState.defect.round ? "is-passed" : "") + '"></i>';
            }).join("") +
          "</div>" +
        "</div>";
    }

    return (
      stepMetaMarkup(char, quest, step) +
      '<h2 class="quest-title">' + escapeHtml(step.title) + "</h2>" +
      '<button class="icon-link task-back" type="button" data-action="back-dialogue">' + icon.arrowLeft + " К диалогу</button>" +
      '<div class="task-block">' +
        '<div class="task-eyebrow">Задание</div>' +
        '<h3 class="task-prompt">' + escapeHtml(task.prompt) + "</h3>" +
        '<p class="task-sub">' + escapeHtml(task.sub) + "</p>" +
        '<div class="task-content">' + widget + "</div>" +
        inline +
        footer +
      "</div>"
    );
  }

  function renderPickWidget(task) {
    return (
      '<div class="pick-grid">' +
        task.options.map(function (option) {
          const selected = stepState.selected.includes(option.id);
          return (
            '<button class="pick-card ' + (selected ? "is-selected" : "") + '" type="button" data-action="pick-option" data-id="' + option.id + '" aria-pressed="' + (selected ? "true" : "false") + '">' +
              '<span class="pick-code">' + escapeHtml(option.code) + "</span>" +
              '<span class="pick-copy"><b>' + escapeHtml(option.label) + "</b><small>" + escapeHtml(option.note) + "</small></span>" +
              '<span class="pick-check">' + (selected ? "✓" : "") + "</span>" +
            "</button>"
          );
        }).join("") +
      "</div>"
    );
  }

  function renderSortWidget(task) {
    const order = stepState.taskData.order || task.displayOrder;
    return (
      '<div class="sort-grid">' +
        order.map(function (id) {
          const item = task.items.find(function (entry) { return entry.id === id; });
          if (!item) return "";
          const pickedIndex = stepState.picked.indexOf(id);
          const picked = pickedIndex !== -1;
          return (
            '<button class="sort-card ' + (picked ? "is-picked" : "") + '" type="button" data-action="sort-item" data-id="' + id + '"' + (picked ? " disabled" : "") + ">" +
              '<span class="sort-num">' + (picked ? pickedIndex + 1 : "•") + "</span>" +
              '<span class="sort-copy"><b>' + escapeHtml(item.label) + "</b><small>" + escapeHtml(item.note) + "</small></span>" +
            "</button>"
          );
        }).join("") +
      "</div>" +
      '<div class="sort-progress" aria-label="Порядок">' +
        Array.from({ length: task.correct.length }, function (_, i) {
          return '<span class="sp-step ' + (i < stepState.picked.length ? "is-filled" : "") + '">' + (i < stepState.picked.length ? "✓" : i + 1) + "</span>";
        }).join("") +
        '<span style="margin-left:6px">' + (stepState.picked.length === 0 ? "Начни с первого этапа" : "Продолжай") + "</span>" +
      "</div>"
    );
  }

  function renderChoiceWidget(task) {
    const letters = ["A", "B", "C", "D"];
    return (
      '<div class="choice-list">' +
        task.options.map(function (option, index) {
          const disabled = stepState.disabledChoices.includes(option.id);
          return (
            '<button class="choice-btn ' + (disabled ? "is-wrong" : "") + '" type="button" data-action="choice-option" data-id="' + option.id + '"' + (disabled ? " disabled" : "") + ">" +
              '<span class="choice-letter">' + letters[index] + "</span>" +
              '<span class="choice-copy">' + escapeHtml(option.text) + "</span>" +
            "</button>"
          );
        }).join("") +
      "</div>"
    );
  }

  function renderSamplesWidget(task) {
    return (
      '<div class="samples-grid">' +
        task.options.map(function (option) {
          const disabled = stepState.disabledChoices.includes(option.id);
          return (
            '<button class="sample-card ' + (disabled ? "is-wrong" : "") + '" type="button" data-action="sample-option" data-id="' + option.id + '"' + (disabled ? " disabled" : "") + ">" +
              '<span class="sample-tank">' + escapeHtml(option.tank) + "</span>" +
              '<span class="sample-data"><b>Проба ' + escapeHtml(option.tank) + "</b><strong>" + escapeHtml(option.value) + "</strong><small>pH</small></span>" +
            "</button>"
          );
        }).join("") +
      "</div>"
    );
  }

  function renderPhWidget(task) {
    const value = stepState.phValue == null ? task.start : stepState.phValue;
    const min = task.min;
    const max = task.max;
    const left = ((value - min) / (max - min)) * 100;
    const targetLeft = ((task.target[0] - min) / (max - min)) * 100;
    const targetWidth = ((task.target[1] - task.target[0]) / (max - min)) * 100;
    const ticks = Array.from({ length: 5 }, function (_, index) {
      const tick = min + ((max - min) * index) / 4;
      return "<span>" + formatPh(Math.round(tick * 10) / 10) + "</span>";
    }).join("");
    return (
      '<div class="ph-widget" id="phWidget">' +
        '<div class="ph-readout">' +
          '<div class="ph-value"><strong id="phValue">' + formatPh(value) + '</strong><span>pH</span></div>' +
          '<div class="ph-norm">рабочий диапазон<b>' + formatRange(task.target) + "</b></div>" +
        "</div>" +
        '<div class="ph-track-wrap" aria-hidden="true">' +
          '<div class="ph-scale">' +
            '<span class="ph-target" style="left:' + targetLeft + "%;width:" + targetWidth + '%"></span>' +
            '<span class="ph-marker" id="phMarker" style="left:' + left + '%"></span>' +
          "</div>" +
          '<div class="ph-ticks">' + ticks + "</div>" +
        "</div>" +
        '<input class="ph-range" id="phRange" type="range" min="' + min + '" max="' + max + '" step="' + task.step + '" value="' + value + '" aria-label="Уровень pH" aria-valuetext="' + formatPh(value) + ' pH">' +
        '<div class="ph-controls">' +
          '<button class="btn btn-ghost" type="button" data-action="ph-adjust" data-delta="-0.1">− 0,1</button>' +
          '<button class="btn btn-ghost" type="button" data-action="ph-adjust" data-delta="0.1">+ 0,1</button>' +
        "</div>" +
      "</div>"
    );
  }

  function renderDefectWidget(task) {
    const defect = stepState.defect;
    const round = defect.round;
    const defectIndex = defect.indexes[round];
    const defectType = defect.types[round];
    return (
      '<div class="defect-hud">' +
        '<span class="defect-status"><i></i> Линия работает</span>' +
        '<span class="defect-timer">' +
          '<span class="timer-track"><span class="timer-fill" id="timerFill"></span></span>' +
          '<span id="timerValue">' + task.seconds.toFixed(1).replace(".", ",") + "</span>" +
        "</span>" +
      "</div>" +
      '<div class="conveyor" id="conveyor">' +
        Array.from({ length: 8 }, function (_, index) {
          const isDefect = index === defectIndex;
          return (
            '<button class="bottle-btn" type="button" data-action="defect-bottle" data-index="' + index + '" aria-label="Бутылка ' + (index + 1) + '">' +
              '<span class="bottle ' + (isDefect ? "is-" + defectType : "") + '">' +
                '<span class="bottle-cap"></span>' +
                '<span class="bottle-neck"></span>' +
                '<span class="bottle-body">' +
                  '<span class="bottle-fill"></span>' +
                  '<span class="bottle-label">БРОДИЛКА</span>' +
                  '<span class="bottle-highlight"></span>' +
                "</span>" +
              "</span>" +
            "</button>"
          );
        }).join("") +
      "</div>" +
      '<div class="defect-result" id="defectResult"></div>'
    );
  }

  /* -------------------------------------------------------
     Task interactions
     ------------------------------------------------------- */

  function updatePickUI(task) {
    const count = stepState.selected.length;
    document.querySelectorAll(".pick-card").forEach(function (card) {
      const id = card.getAttribute("data-id");
      const selected = stepState.selected.includes(id);
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-pressed", selected ? "true" : "false");
      const check = card.querySelector(".pick-check");
      if (check) check.textContent = selected ? "✓" : "";
    });
    const countEl = document.getElementById("pickCount");
    if (countEl) countEl.innerHTML = "Выбрано <strong>" + count + " / " + task.required + "</strong>";
    const button = document.querySelector('[data-action="check-recipe"]');
    if (button) button.disabled = count !== task.required;
  }

  function handlePickOption(id) {
    const char = getActiveCharacter();
    if (!char || !stepState) return;
    const step = char.steps[state.activeQuest.stepIndex];
    const task = step.task;
    if (stepState.phase !== "task") return;
    const index = stepState.selected.indexOf(id);
    if (index !== -1) {
      stepState.selected.splice(index, 1);
    } else {
      if (stepState.selected.length >= task.required) {
        showToast("Уже " + task.required + ". Сними один компонент.");
        return;
      }
      stepState.selected.push(id);
    }
    hideInlineFeedback();
    playSound("click");
    updatePickUI(task);
  }

  function checkRecipe() {
    const char = getActiveCharacter();
    if (!char || !stepState) return;
    const step = char.steps[state.activeQuest.stepIndex];
    const task = step.task;
    if (stepState.selected.length !== task.required) return;
    const correctIds = task.options.filter(function (option) { return option.correct; }).map(function (option) { return option.id; });
    const allCorrect = stepState.selected.every(function (id) { return correctIds.includes(id); }) && stepState.selected.length === correctIds.length;
    if (allCorrect) {
      finishTask();
      return;
    }
    registerMistake();
    showInlineFeedback(task.fail, "error");
    const widget = document.querySelector(".task-block");
    if (widget) {
      widget.classList.remove("shake");
      void widget.offsetWidth;
      widget.classList.add("shake");
    }
  }

  function handleSortItem(id) {
    const char = getActiveCharacter();
    if (!char || !stepState) return;
    const step = char.steps[state.activeQuest.stepIndex];
    const task = step.task;
    if (stepState.phase !== "task" || stepState.picked.includes(id)) return;
    const nextExpected = task.correct[stepState.picked.length];
    if (id === nextExpected) {
      stepState.picked.push(id);
      hideInlineFeedback();
      playSound("click");
      if (stepState.picked.length === task.correct.length) {
        finishTask();
      } else {
        renderGame({ scroll: false });
      }
    } else {
      registerMistake();
      showInlineFeedback(task.fail, "error");
      const card = document.querySelector('.sort-card[data-id="' + id + '"]');
      if (card) {
        card.classList.add("is-wrong");
        window.setTimeout(function () {
          card.classList.remove("is-wrong");
        }, 420);
      }
    }
  }

  function resetSort() {
    if (!stepState || stepState.phase !== "task") return;
    stepState.picked = [];
    hideInlineFeedback();
    playSound("click");
    renderGame({ scroll: false });
  }

  function handleChoice(id) {
    const char = getActiveCharacter();
    if (!char || !stepState) return;
    const step = char.steps[state.activeQuest.stepIndex];
    const task = step.task;
    const option = task.options.find(function (entry) { return entry.id === id; });
    if (!option || stepState.phase !== "task" || stepState.disabledChoices.includes(id)) return;
    if (option.correct) {
      finishTask();
    } else {
      registerMistake();
      stepState.disabledChoices.push(id);
      const button = document.querySelector('.choice-btn[data-id="' + id + '"]');
      if (button) {
        button.classList.add("is-wrong");
        button.disabled = true;
      }
      showInlineFeedback(option.feedback || task.fail, "error");
    }
  }

  function handleSample(id) {
    const char = getActiveCharacter();
    if (!char || !stepState) return;
    const step = char.steps[state.activeQuest.stepIndex];
    const task = step.task;
    const option = task.options.find(function (entry) { return entry.id === id; });
    if (!option || stepState.phase !== "task" || stepState.disabledChoices.includes(id)) return;
    if (option.correct) {
      finishTask();
    } else {
      registerMistake();
      stepState.disabledChoices.push(id);
      const button = document.querySelector('.sample-card[data-id="' + id + '"]');
      if (button) {
        button.classList.add("is-wrong");
        button.disabled = true;
      }
      showInlineFeedback(task.fail, "error");
    }
  }

  function updatePhUI(task) {
    const value = stepState.phValue;
    const valueEl = document.getElementById("phValue");
    const marker = document.getElementById("phMarker");
    const range = document.getElementById("phRange");
    if (valueEl) valueEl.textContent = formatPh(value);
    if (marker) marker.style.left = ((value - task.min) / (task.max - task.min)) * 100 + "%";
    if (range) {
      if (Number(range.value) !== Number(value)) range.value = value;
      range.setAttribute("aria-valuetext", formatPh(value) + " pH");
    }
  }

  function mountPhGame(step) {
    if (!stepState) return;
    const task = step.task;
    if (stepState.phValue == null) stepState.phValue = task.start;
    const range = document.getElementById("phRange");
    if (range) {
      range.addEventListener("input", function () {
        stepState.phValue = Number(range.value);
        updatePhUI(task);
        hideInlineFeedback();
      });
    }
  }

  function adjustPh(delta) {
    const char = getActiveCharacter();
    if (!char || !stepState) return;
    const task = char.steps[state.activeQuest.stepIndex].task;
    if (stepState.phase !== "task") return;
    const next = Math.min(task.max, Math.max(task.min, Math.round((stepState.phValue + delta) * 10) / 10));
    stepState.phValue = next;
    updatePhUI(task);
    hideInlineFeedback();
    playSound("click");
  }

  function submitPh() {
    const char = getActiveCharacter();
    if (!char || !stepState) return;
    const step = char.steps[state.activeQuest.stepIndex];
    const task = step.task;
    if (stepState.phase !== "task") return;
    const value = Number(stepState.phValue);
    if (value >= task.target[0] - 0.0001 && value <= task.target[1] + 0.0001) {
      finishTask();
    } else {
      registerMistake();
      showInlineFeedback(task.fail + " Сейчас на приборе " + formatPh(value) + ".", "error");
      const widget = document.querySelector(".ph-widget");
      if (widget) {
        widget.classList.remove("shake");
        void widget.offsetWidth;
        widget.classList.add("shake");
      }
    }
  }

  function mountDefectGame(step) {
    const task = step.task;
    if (!stepState.defect || stepState.defect.resolved) return;
    const fill = document.getElementById("timerFill");
    const valueEl = document.getElementById("timerValue");
    const roundEl = document.getElementById("defectRound");
    const dots = document.getElementById("defectDots");
    const conveyor = document.getElementById("conveyor");
    if (!fill || !valueEl || !conveyor) return;

    if (roundEl) roundEl.innerHTML = "Раунд <strong>" + (stepState.defect.round + 1) + " / " + task.rounds + "</strong>";
    if (dots) {
      Array.from(dots.children).forEach(function (dot, index) {
        dot.classList.toggle("is-passed", index < stepState.defect.round);
      });
    }

    const duration = task.seconds * 1000;
    let deadline = Date.now() + duration;
    let intervalId = null;

    const updateTimer = function () {
      const left = Math.max(0, deadline - Date.now());
      const ratio = left / duration;
      fill.style.transform = "scaleX(" + ratio + ")";
      fill.classList.toggle("is-low", ratio < 0.3);
      valueEl.textContent = (left / 1000).toFixed(1).replace(".", ",");
      if (left <= 0) {
        window.clearInterval(intervalId);
        handleTimeout();
      }
    };

    intervalId = addInterval(updateTimer, 80);
    updateTimer();

    const finishRound = function () {
      if (stepState.defect.resolved) return;
      stepState.defect.resolved = true;
      window.clearInterval(intervalId);
      if (stepState.defect.round + 1 >= task.rounds) {
        addTimeout(function () {
          finishTask();
        }, 800);
      } else {
        addTimeout(function () {
          stepState.defect.round += 1;
          stepState.defect.resolved = false;
          renderGame({ scroll: false });
        }, 850);
      }
    };

    const handleTimeout = function () {
      if (stepState.defect.resolved) return;
      stepState.defect.resolved = true;
      registerMistake();
      const correct = conveyor.querySelector('.bottle-btn[data-index="' + stepState.defect.indexes[stepState.defect.round] + '"]');
      if (correct) {
        correct.classList.add("is-correct");
        correct.disabled = true;
      }
      Array.from(conveyor.querySelectorAll(".bottle-btn")).forEach(function (button) {
        button.disabled = true;
      });
      showToast("Время. Брак был здесь, линия встала.");
      fill.style.transform = "scaleX(0)";
      addTimeout(function () {
        if (stepState.defect.round + 1 >= task.rounds) {
          finishTask();
        } else {
          stepState.defect.round += 1;
          stepState.defect.resolved = false;
          renderGame({ scroll: false });
        }
      }, 1400);
    };

    conveyor.addEventListener("click", function (event) {
      const button = event.target.closest(".bottle-btn");
      if (!button || stepState.defect.resolved) return;
      const index = Number(button.getAttribute("data-index"));
      if (index === stepState.defect.indexes[stepState.defect.round]) {
        button.classList.add("is-correct");
        button.disabled = true;
        playSound("good");
        finishRound();
      } else {
        button.classList.remove("is-miss");
        void button.offsetWidth;
        button.classList.add("is-miss");
        registerMistake();
        stepState.defect.wrong += 1;
        deadline -= 1500;
        showToast("Мимо, это не брак. Минус 1,5 секунды.");
        window.setTimeout(function () {
          button.classList.remove("is-miss");
        }, 400);
      }
    });
  }

  function renderFeedbackPanel(char, step, quest) {
    const task = step.task;
    return (
      stepMetaMarkup(char, quest, step) +
      '<div class="feedback-wrap">' +
        '<span class="feedback-mark"><span class="check">✓</span> Этап закрыт</span>' +
        '<h2 class="feedback-title">' + escapeHtml(step.title) + "</h2>" +
        '<p class="feedback-text">' + escapeHtml(task.success) + "</p>" +
        '<div class="fact-card">' +
          '<span class="fact-label">Запомни</span>' +
          "<p>" + escapeHtml(step.fact) + "</p>" +
        "</div>" +
        '<div class="feedback-footer">' +
          '<span class="feedback-stars" title="Точность этапа">' + starsHTML(stepState.perfect ? 1 : 0, 1) + (stepState.perfect ? " чисто" : " без звезды") + "</span>" +
          '<button class="btn btn-primary" type="button" data-action="next-step">' + (quest.stepIndex === char.steps.length - 1 ? "Завершить смену" : "Следующий этап") + " " + icon.arrow + "</button>" +
        "</div>" +
      "</div>"
    );
  }

  /* -------------------------------------------------------
     Result
     ------------------------------------------------------- */

  function confettiMarkup() {
    const colors = ["#d7f35b", "#ff6b3d", "#f6c94c", "#0c3b28", "#b7e4c7"];
    let html = '<div class="confetti" aria-hidden="true">';
    for (let i = 0; i < 54; i += 1) {
      const left = Math.round(Math.random() * 100);
      const delay = (Math.random() * 0.7).toFixed(2);
      const duration = (2.8 + Math.random() * 1.8).toFixed(2);
      const drift = Math.round(-120 + Math.random() * 240);
      const rotate = Math.round(360 + Math.random() * 900);
      const color = colors[i % colors.length];
      html += '<i style="left:' + left + "%;--confetti-color:" + color + ";--confetti-delay:" + delay + "s;--confetti-duration:" + duration + "s;--confetti-drift:" + drift + "px;--confetti-rotate:" + rotate + 'deg"></i>';
    }
    return html + "</div>";
  }

  function renderResult() {
    const result = currentResult || state.lastResult;
    if (!result) {
      renderLanding();
      return;
    }
    const char = getCharacter(result.charId);
    if (!char) {
      renderLanding();
      return;
    }
    currentScreen = "result";
    currentResult = result;
    const allDone = allCharactersDone();
    const alreadyApplied = state.applications.some(function (application) {
      return application.charId === char.id;
    });
    const completion = state.completed[char.id] || result;
    const reward = completion.reward || 150;
    const totalSteps = char.steps.length;

    const html =
      '<div class="bubble-scene" aria-hidden="true">' +
        '<div class="bubble-scene-inner">' +
          '<img class="bubble-scene-mascot" src="assets/mascot.svg" alt="">' +
          '<img class="bubble-scene-pop" src="assets/mascot/pop.svg" alt="">' +
        "</div>" +
      "</div>" +
      '<section class="screen result-screen">' +
        confettiMarkup() +
        '<div class="result-wrap">' +
          '<div class="result-head">' +
            '<div class="result-head-copy">' +
              '<div class="result-kicker">Смена ' + char.order + " · " + escapeHtml(char.name) + " · " + escapeHtml(char.role) + "</div>" +
              '<h1 class="result-title">Смена<br><span>закрыта.</span></h1>' +
              '<p class="result-sub">' + escapeHtml(char.resultLine) + "</p>" +
            "</div>" +
            '<div class="result-head-stars" role="img" aria-label="Точность ' + completion.stars + ' из 3">' + starsHTML(completion.stars, 3) + "<small>Точность " + completion.stars + " / 3</small></div>" +
          "</div>" +

          '<div class="result-grid">' +
            '<div class="reward-ticket">' +
              '<div class="ticket-top">' +
                '<span class="ticket-label">Промокод за смену</span>' +
                '<span class="ticket-num">ОЧАКОВО × БРОДИЛКА</span>' +
              "</div>" +
              '<div class="ticket-value"><strong>' + escapeHtml(reward) + '</strong><span>баллов на продукцию на маркетплейсах</span></div>' +
              '<div class="ticket-code-label">Твой промокод</div>' +
              '<div class="promo-splat" id="promoSplat">' +
                '<img class="promo-splat-img" src="assets/mascot/splat.svg" alt="">' +
                '<div class="promo-splat-inner">' +
                  '<div class="ticket-code-row">' +
                    '<span class="ticket-code" id="promoCode">' + escapeHtml(completion.code) + "</span>" +
                    '<button class="copy-btn" type="button" data-action="copy-code" data-code="' + escapeHtml(completion.code) + '">' + icon.copy + " Копировать</button>" +
                  "</div>" +
                "</div>" +
              "</div>" +
              '<p class="ticket-note">' + icon.spark + " Пузырь не выдержал. Лопнул. Впервые с 1996 года. Буль. На месте осталась клякса, а в ней промокод. Баллы начисляются на продукцию Очаково.</p>" +
            "</div>" +

            '<div class="result-info">' +
              '<div class="result-story">' +
                '<div class="result-story-label">Что ты сделал</div>' +
                "<h2>" + escapeHtml(char.name) + ", смена закрыта</h2>" +
                "<p>" + escapeHtml(char.resultLine) + " " + totalSteps + " этапа, " + totalSteps + " решения. Пузырь держался тридцать лет. На этой смене не вышло.</p>" +
                '<div class="result-stat-row">' +
                  '<span class="result-stat">Этапы <b>' + totalSteps + " / " + totalSteps + "</b></span>" +
                  '<span class="result-stat">Точность <b>' + completion.stars + " / 3</b></span>" +
                  '<span class="result-stat">Приз <b>' + escapeHtml(reward) + " баллов</b></span>" +
                "</div>" +
              "</div>" +
              '<div class="vacancy-mini">' +
                '<div class="vacancy-mini-left">' +
                  '<span class="vacancy-mini-icon">' + icon.doc + "</span>" +
                  "<div>" +
                    '<div class="vacancy-mini-label">Открытая вакансия</div>' +
                    "<b>" + escapeHtml(char.vacancy.title) + "</b>" +
                    '<div class="vacancy-mini-meta">' + escapeHtml(char.vacancy.location) + " · " + escapeHtml(char.vacancy.schedule) + "</div>" +
                  "</div>" +
                "</div>" +
                (alreadyApplied ? '<span class="result-badge is-done">Карточка у HR</span>' : '<span class="result-badge">HR ждёт</span>') +
              "</div>" +
              '<div class="result-actions">' +
                '<button class="btn btn-primary" type="button" data-action="open-apply" data-char="' + char.id + '">Откликнуться на вакансию ' + icon.arrow + "</button>" +
                '<button class="btn btn-ghost" type="button" data-action="go-characters">Другая история</button>' +
              "</div>" +
              '<div class="result-alt">' +
                "<p>Пузырь лопнул впервые с 1996 года, но завод остался. Выбери другую смену и посмотри, как всё устроено изнутри.</p>" +
                '<button class="btn btn-ghost result-share" type="button" data-action="share-result" data-char="' + char.id + '">' + icon.share + " Поделиться картинкой</button>" +
              "</div>" +
              (allDone
                ? '<div class="all-complete">' + icon.spark + "<div><b>" + CHARACTERS.length + " из " + CHARACTERS.length + ". Свой человек.</b><span>Ты прошёл все " + CHARACTERS.length + " смены. Я же говорил: ты справишься. Не лопни от восторга.</span></div></div>"
                : "") +
            "</div>" +
          "</div>" +
        "</div>" +
        footerMarkup() +
      "</section>";

    setScreen(html);
    updateHeader();

    /* Страховка: сцена не должна залипать, даже если анимация не доиграла. */
    addTimeout(function () {
      const scene = document.querySelector(".bubble-scene");
      if (scene) scene.classList.add("is-done");
    }, 1620);
  }

  /* -------------------------------------------------------
     Apply
     ------------------------------------------------------- */

  function employerBenefitsMarkup() {
    if (!EMPLOYER_BENEFITS.length) return "";
    return (
      '<h3 class="vacancy-section-title">Условия и бонусы от работодателя</h3>' +
      '<ul class="benefits-list">' +
        EMPLOYER_BENEFITS.map(function (item) {
          return "<li><b>" + escapeHtml(item.title) + "</b><span>" + escapeHtml(item.text) + "</span></li>";
        }).join("") +
      "</ul>" +
      '<p class="vacancy-disclaimer">Условия демонстрационные. Детали обсуждаем на интервью.</p>'
    );
  }

  function renderApply(charId, options) {
    const quick = Boolean(options && options.quick);
    const char = getCharacter(charId) || (quick ? CHARACTERS[0] : (state.lastResult ? getCharacter(state.lastResult.charId) : null));
    if (!char) {
      renderCharacters();
      return;
    }
    currentScreen = "apply";
    const vacancy = char.vacancy;

    const responsibilities = Array.isArray(vacancy.responsibilities) && vacancy.responsibilities.length
      ? vacancy.responsibilities
      : [vacancy.about];

    const html =
      '<section class="screen apply-screen">' +
        '<div class="apply-wrap">' +
          '<div class="apply-head">' +
            "<div>" +
              '<div class="eyebrow">' + (quick ? "Без мини-игры" : "Последний шаг") + "</div>" +
              '<h1 class="display">' + (quick ? "Сразу<br><em>к делу.</em>" : "Отклик<br><em>на смену.</em>") + "</h1>" +
            "</div>" +
            (quick
              ? '<button class="icon-link" type="button" data-action="home">' + icon.arrowLeft + " На главную</button>"
              : '<button class="icon-link" type="button" data-action="back-result">' + icon.arrowLeft + " Назад к результату</button>") +
          "</div>" +
          '<div class="apply-grid' + (quick ? " is-quick" : "") + '">' +
            (!quick
              ? '<aside class="vacancy-card">' +
                  '<div class="vacancy-card-top">' +
                    '<span class="vacancy-label">Вакансия открыта</span>' +
                    "<h2>" + escapeHtml(vacancy.title) + "</h2>" +
                    '<p class="vacancy-role">' + escapeHtml(vacancy.team) + "</p>" +
                    '<div class="vacancy-meta-list">' +
                      '<div class="vacancy-meta-row"><span>Локация</span><b>' + escapeHtml(vacancy.location) + "</b></div>" +
                      '<div class="vacancy-meta-row"><span>График</span><b>' + escapeHtml(vacancy.schedule) + "</b></div>" +
                      '<div class="vacancy-meta-row"><span>Оплата</span><b>' + escapeHtml(vacancy.salary) + "</b></div>" +
                    "</div>" +
                  "</div>" +
                  '<div class="vacancy-card-section">' +
                    '<h3 class="vacancy-section-title">Что будешь делать</h3>' +
                    '<ul class="vacancy-list">' +
                      responsibilities.map(function (item) { return "<li>" + escapeHtml(item) + "</li>"; }).join("") +
                    "</ul>" +
                  "</div>" +
                  '<div class="vacancy-card-bottom">' +
                    employerBenefitsMarkup() +
                  "</div>" +
                "</aside>"
              : "") +

            '<div class="form-card">' +
              (quick
                ? '<div class="quick-roles">' +
                    '<div class="quick-roles-head">' +
                      '<span class="eyebrow">Направление</span>' +
                      '<h2>Кем хочешь на завод?</h2>' +
                      '<p>Играть не обязательно. Выбери роль и заполни карточку.</p>' +
                    "</div>" +
                    '<div class="quick-role-list" role="radiogroup" aria-label="Направление">' +
                      CHARACTERS.map(function (item, index) {
                        return '<button class="quick-role' + (index === 0 ? " is-selected" : "") + '" type="button" role="radio" aria-checked="' + (index === 0 ? "true" : "false") + '" data-quick-role="' + escapeHtml(item.id) + '">' +
                          '<img src="' + escapeHtml(item.image) + '" alt="">' +
                          '<span class="quick-role-body">' +
                            '<span class="quick-role-tag">' + escapeHtml(item.tag) + "</span>" +
                            "<b>" + escapeHtml(item.name) + " · " + escapeHtml(item.role) + "</b>" +
                            "<span>" + escapeHtml(item.vacancy.about) + "</span>" +
                          "</span>" +
                        "</button>";
                      }).join("") +
                    "</div>" +
                  "</div>"
                : "") +
              (quick
                ? '<div class="quick-benefits">' + employerBenefitsMarkup() + "</div>"
                : "") +
              '<div class="form-head">' +
                "<div><h2>Карточка стажёра</h2><p>" + (quick
                  ? "Без игры и тестов. Заполни карточку, и она уйдёт в HR. Резюме не нужно."
                  : "Заполни карточку. Пара минут, и она уйдёт в HR. Резюме не нужно.") + "</p></div>" +
                '<span class="form-step">Стажёр / 01</span>' +
              "</div>" +
              '<form id="applyForm" data-char="' + char.id + '"' + (quick ? ' data-quick="true"' : "") + ' novalidate>' +
                (quick ? '<input type="hidden" id="fieldRole" name="charId" value="' + escapeHtml(char.id) + '">' : "") +
                '<div class="form-grid">' +
                  '<div class="field is-full">' +
                    '<label for="fieldName">ФИО <span class="req">*</span></label>' +
                    '<input id="fieldName" name="name" type="text" autocomplete="name" placeholder="Иванов Иван Иванович" maxlength="80">' +
                    '<span class="field-hint">Как в паспорте, так проще оформить.</span>' +
                    '<span class="field-error">Напиши ФИО, как в паспорте</span>' +
                  "</div>" +
                  '<div class="field">' +
                    '<label for="fieldBirthDate">Дата рождения <span class="req">*</span></label>' +
                    '<input id="fieldBirthDate" name="birthDate" type="date" autocomplete="bday" min="1900-01-01">' +
                    '<span class="field-hint">Нужна для оформления. Без неё не получится оформить смену.</span>' +
                    '<span class="field-error">Укажи дату рождения</span>' +
                  "</div>" +
                  '<div class="field">' +
                    '<label for="fieldPhone">Телефон <span class="req">*</span></label>' +
                    '<input id="fieldPhone" name="phone" type="tel" autocomplete="tel" placeholder="+7 999 000-00-00" maxlength="30">' +
                    '<span class="field-error">Оставь номер для связи</span>' +
                  "</div>" +
                  '<div class="field">' +
                    '<label for="fieldEmail">Email <span class="req">*</span></label>' +
                    '<input id="fieldEmail" name="email" type="email" autocomplete="email" placeholder="you@example.com" maxlength="120">' +
                    '<span class="field-error">Проверь адрес почты</span>' +
                  "</div>" +
                  '<div class="field">' +
                    '<label for="fieldCity">Город <span class="optional">необязательно</span></label>' +
                    '<input id="fieldCity" name="city" type="text" autocomplete="address-level2" placeholder="Москва" maxlength="80">' +
                    '<span class="field-error"></span>' +
                  "</div>" +
                  '<div class="field is-full">' +
                    '<label for="fieldEducation">ВУЗ или колледж <span class="optional">необязательно</span></label>' +
                    '<input id="fieldEducation" name="education" type="text" autocomplete="organization" placeholder="МГУ, РТУ МИРЭА, колледж связи" maxlength="120">' +
                    '<span class="field-hint">Можно не заполнять, если не учишься.</span>' +
                  "</div>" +
                  '<div class="field is-full">' +
                    '<label for="fieldResumeLink">Ссылка на резюме <span class="optional">необязательно</span></label>' +
                    '<input id="fieldResumeLink" name="resumeLink" type="url" placeholder="https://hh.ru/resume/..." maxlength="300">' +
                    '<span class="field-hint">Без резюме тоже можно. Оставь поле пустым.</span>' +
                    '<span class="field-error">Ссылка должна начинаться с http:// или https://</span>' +
                  "</div>" +
                  '<label class="consent" id="consentLabel">' +
                    '<input name="consent" type="checkbox">' +
                    "<span>Согласен на обработку персональных данных. Это демо: карточка уйдёт в тестовую админку проекта.</span>" +
                  "</label>" +
                  '<div class="form-error-general" id="formError"></div>' +
                  '<div class="form-submit-row">' +
                    '<button class="btn btn-primary" type="submit">Отправить карточку ' + icon.arrow + "</button>" +
                    '<p class="form-note"><img class="form-note-mascot" src="assets/mascot.svg" alt=""><span>Карточка уйдёт в HR. Заполняешь ты, я рядом.</span></p>' +
                  "</div>" +
                "</div>" +
              "</form>" +
            "</div>" +
          "</div>" +
        "</div>" +
      "</section>";

    setScreen(html);
    mountApplyForm();
  }

  function mountApplyForm() {
    const form = document.getElementById("applyForm");
    if (!form) return;
    const birthInput = form.elements.birthDate;
    if (birthInput) {
      const now = new Date();
      const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      birthInput.max = today;
    }
    const roleInput = form.elements.charId;
    const roleButtons = document.querySelectorAll("[data-quick-role]");
    roleButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const value = button.getAttribute("data-quick-role");
        const selected = getCharacter(value);
        if (roleInput) roleInput.value = value;
        roleButtons.forEach(function (item) {
          const active = item === button;
          item.classList.toggle("is-selected", active);
          item.setAttribute("aria-checked", active ? "true" : "false");
        });
        form.setAttribute("data-char", value);
        if (selected) announce("Направление: " + selected.vacancy.title + ".");
      });
    });
    form.addEventListener("input", function (event) {
      const target = event.target;
      if (!target || !target.name) return;
      const general = document.getElementById("formError");
      if (general) {
        general.textContent = "";
        general.classList.remove("is-visible");
      }
      if (target.name === "consent") {
        const label = document.getElementById("consentLabel");
        if (label) label.classList.remove("has-error");
        return;
      }
      clearFieldError(form, target.name);
    });
  }

  function clearFieldError(form, name) {
    const input = form.elements[name];
    if (!input) return;
    const field = input.closest(".field");
    if (field) field.classList.remove("has-error");
    input.removeAttribute("aria-invalid");
  }

  function setFieldError(form, name, message) {
    const input = form.elements[name];
    if (!input) return;
    const field = input.closest(".field");
    if (!field) return;
    field.classList.add("has-error");
    input.setAttribute("aria-invalid", "true");
    const error = field.querySelector(".field-error");
    if (error && message) error.textContent = message;
  }

  function validateApplyForm(form) {
    form.querySelectorAll(".field").forEach(function (field) {
      field.classList.remove("has-error");
      const control = field.querySelector("input, textarea, select");
      if (control) control.removeAttribute("aria-invalid");
    });
    const consentLabel = document.getElementById("consentLabel");
    if (consentLabel) consentLabel.classList.remove("has-error");
    if (form.elements.consent) form.elements.consent.removeAttribute("aria-invalid");
    const general = document.getElementById("formError");
    if (general) {
      general.textContent = "";
      general.classList.remove("is-visible");
    }

    const name = form.elements.name.value.trim();
    const birthDate = form.elements.birthDate.value;
    const phone = form.elements.phone.value.trim();
    const email = form.elements.email.value.trim();
    const education = form.elements.education.value.trim();
    const resumeLink = form.elements.resumeLink.value.trim();
    const consent = form.elements.consent.checked;
    let firstInvalid = null;

    if (name.length < 2) {
      setFieldError(form, "name", "Напиши ФИО, как в паспорте");
      firstInvalid = firstInvalid || form.elements.name;
    }

    let birthDateValid = /^\d{4}-\d{2}-\d{2}$/.test(birthDate);
    if (birthDateValid) {
      const parsed = new Date(birthDate + "T00:00:00");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const earliest = new Date(1900, 0, 1);
      birthDateValid = !Number.isNaN(parsed.getTime()) && parsed <= today && parsed >= earliest;
    }
    if (!birthDate) {
      setFieldError(form, "birthDate", "Укажи дату рождения");
      firstInvalid = firstInvalid || form.elements.birthDate;
    } else if (!birthDateValid) {
      setFieldError(form, "birthDate", "Проверь дату: не в будущем и не раньше 1900 года");
      firstInvalid = firstInvalid || form.elements.birthDate;
    }

    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setFieldError(form, "phone", "Нужен номер, минимум 10 цифр");
      firstInvalid = firstInvalid || form.elements.phone;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) {
      setFieldError(form, "email", "Проверь адрес почты");
      firstInvalid = firstInvalid || form.elements.email;
    }
    if (resumeLink && !/^https?:\/\/.+/i.test(resumeLink)) {
      setFieldError(form, "resumeLink", "Ссылка должна начинаться с http:// или https://");
      firstInvalid = firstInvalid || form.elements.resumeLink;
    }
    if (!consent) {
      if (consentLabel) consentLabel.classList.add("has-error");
      if (form.elements.consent) form.elements.consent.setAttribute("aria-invalid", "true");
      if (general) {
        general.textContent = "Поставь галочку, иначе карточку не отправить.";
        general.classList.add("is-visible");
      }
      firstInvalid = firstInvalid || form.elements.consent;
    }

    if (firstInvalid) {
      firstInvalid.focus();
      return null;
    }

    return {
      name: name,
      birthDate: birthDate,
      education: education,
      phone: phone,
      email: email,
      city: form.elements.city.value.trim(),
      resumeLink: resumeLink,
      consent: true
    };
  }

  async function handleApplySubmit(form) {
    if (form.dataset.submitting === "true") return;
    const data = validateApplyForm(form);
    if (!data) {
      announce("Форма не отправлена. Проверь отмеченные поля.");
      return;
    }
    const charId = form.elements.charId ? form.elements.charId.value : form.getAttribute("data-char");
    const char = getCharacter(charId);
    if (!char) return;
    const submit = form.querySelector('button[type="submit"]');
    form.dataset.submitting = "true";
    form.setAttribute("aria-busy", "true");
    if (submit) {
      submit.disabled = true;
      submit.classList.add("is-loading");
    }

    const endpoint = String((window.BRODILKA_CONFIG && window.BRODILKA_CONFIG.applyEndpoint) || "").trim();
    let delivered = false;
    let ticket = generateTicket();

    try {
      if (endpoint) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: data.name,
            birthDate: data.birthDate,
            education: data.education,
            phone: data.phone,
            email: data.email,
            city: data.city,
            resumeLink: data.resumeLink,
            consent: true,
            vacancy: char.vacancy.title,
            charId: char.id,
            source: "brodilka-site"
          })
        });
        if (!response.ok) throw new Error("HR endpoint returned " + response.status);
        const payload = await response.json().catch(function () { return {}; });
        if (payload && (payload.ticket || payload.id)) ticket = payload.ticket || payload.id;
        delivered = true;
      } else {
        await wait(900);
      }
    } catch (error) {
      form.dataset.submitting = "false";
      form.removeAttribute("aria-busy");
      if (submit) {
        submit.disabled = false;
        submit.classList.remove("is-loading");
      }
      const general = document.getElementById("formError");
      if (general) {
        general.textContent = "Не получилось отправить. Проверь связь и попробуй ещё раз.";
        general.classList.add("is-visible");
      }
      announce("Не получилось отправить. Проверь связь и попробуй ещё раз.");
      return;
    }

    const application = {
      id: ticket,
      ticket: ticket,
      charId: char.id,
      vacancy: char.vacancy.title,
      name: data.name,
      birthDate: data.birthDate,
      education: data.education,
      phone: data.phone,
      email: data.email,
      city: data.city,
      resumeLink: data.resumeLink,
      delivered: delivered,
      createdAt: new Date().toISOString()
    };
    state.applications.push(application);
    state.lastApplication = application;
    saveState();
    playSound("win");
    renderSuccess(application);
  }

  /* -------------------------------------------------------
     Success
     ------------------------------------------------------- */

  function renderSuccess(application) {
    currentScreen = "success";
    const char = getCharacter(application.charId);
    const date = new Date(application.createdAt);
    const dateText = date.toLocaleDateString("ru-RU", { day: "2-digit", month: "long" });
    const delivered = Boolean(application.delivered);
    const applicationCopy = delivered
      ? "Карточка на «" + escapeHtml(application.vacancy) + "» ушла в HR. Напишут, если профиль подойдёт."
      : "Карточка на «" + escapeHtml(application.vacancy) + "» сохранена. HR напишет, если профиль подойдёт.";

    const html =
      '<section class="screen success-screen">' +
        '<div class="success-card">' +
          '<div class="success-icon">' + icon.check + "</div>" +
          '<div class="mono-label">Карточка принята · ' + escapeHtml(dateText) + "</div>" +
          "<h1>Карточка<br>у HR.</h1>" +
          "<p>Спасибо, " + escapeHtml(application.name) + ". " + applicationCopy + "</p>" +
          '<div class="success-ticket">' +
            "<div><span>Номер карточки</span><b>" + escapeHtml(application.ticket) + "</b></div>" +
            '<span class="status-chip">' + (delivered ? "Отправлено в HR" : "В очереди у HR") + "</span>" +
          "</div>" +
          '<div class="success-applicant">' +
            '<div class="success-applicant-row"><span>ФИО</span><b>' + escapeHtml(application.name) + "</b></div>" +
            '<div class="success-applicant-row"><span>Дата рождения</span><b>' + escapeHtml(formatBirthDate(application.birthDate)) + "</b></div>" +
            (application.education ? '<div class="success-applicant-row"><span>ВУЗ или колледж</span><b>' + escapeHtml(application.education) + "</b></div>" : "") +
          "</div>" +
          '<div class="success-steps">' +
            '<div class="success-step"><span>01</span><div><b>' + (delivered ? "HR получил карточку" : "Карточка сохранена") + '</b><p>ФИО и контакты уже в одном месте.</p></div></div>' +
            '<div class="success-step"><span>02</span><div><b>2 рабочих дня</b><p>Обычно этого хватает, чтобы ответить.</p></div></div>' +
            '<div class="success-step"><span>03</span><div><b>Знакомство</b><p>Если всё совпадёт, позовём на интервью.</p></div></div>' +
          "</div>" +
          '<div class="success-actions">' +
            '<button class="btn btn-primary" type="button" data-action="home">На главную ' + icon.arrow + "</button>" +
            '<button class="btn btn-ghost" type="button" data-action="go-characters">Другая история</button>' +
            '<button class="btn btn-ghost" type="button" data-action="download-application" data-ticket="' + escapeHtml(application.ticket) + '">' + icon.download + " Скачать карточку в PDF</button>" +
          "</div>" +
          '<p class="success-note">' + (delivered
            ? "Карточка ушла в HR-систему. В рабочей версии сюда добавят уведомление рекрутеру."
            : "Это демо: карточка лежит в браузере и никуда не ушла. В рабочей версии её отправят в HR-систему" + (char ? " и вакансии «" + escapeHtml(char.vacancy.title) + "»" : "") + ".") + "</p>" +
        "</div>" +
      "</section>";

    setScreen(html, { replaceHistory: true });
  }

  /* -------------------------------------------------------
     PWA
     ------------------------------------------------------- */

  function initServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const isHttp = window.location.protocol === "http:" || window.location.protocol === "https:";
    if (!isHttp) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("sw.js", { scope: "./" })
        .catch(function () {
          /* офлайн-режим не критичен для игры */
        });
    });
  }

  function showInstallButton(show) {
    if (!installBtn) return;
    installBtn.hidden = !show;
  }

  function initInstallPrompt() {
    if (!installBtn) return;
    const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    const iosStandalone = window.navigator.standalone === true;
    if (standalone || iosStandalone) showInstallButton(false);

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      installPromptEvent = event;
      showInstallButton(true);
    });

    window.addEventListener("appinstalled", function () {
      installPromptEvent = null;
      showInstallButton(false);
      showToast("БРОДИЛКА установлена. Открывай с домашнего экрана.");
    });

    installBtn.addEventListener("click", function () {
      if (!installPromptEvent || typeof installPromptEvent.prompt !== "function") {
        showToast("Открой меню браузера и выбери «Установить приложение».");
        return;
      }
      const prompt = installPromptEvent;
      installPromptEvent = null;
      showInstallButton(false);
      prompt.prompt();
      if (prompt.userChoice && typeof prompt.userChoice.then === "function") {
        prompt.userChoice.then(function (choice) {
          if (choice && choice.outcome === "accepted") {
            showToast("Ставим…");
          }
        }).catch(function () {
          /* пользователь закрыл системный диалог */
        });
      }
    });
  }

  function initPwa() {
    initServiceWorker();
    initInstallPrompt();
  }

  /* -------------------------------------------------------
     Events
     ------------------------------------------------------- */

  function handleAction(action, element) {
    switch (action) {
      case "home":
        currentScreen = "landing";
        renderLanding();
        break;

      case "reload-app":
        window.location.reload();
        break;

      case "design-brand":
        if (currentDesign() !== "brand") {
          applyDesign("brand");
          showToast("Оформление: Очаково");
        }
        break;

      case "design-brodilka":
        if (currentDesign() !== "brodilka") {
          applyDesign("brodilka");
          showToast("Оформление: БРОДИЛКА");
        }
        break;

      case "start-quest":
        if (state.activeQuest) {
          currentScreen = "game";
          renderGame();
        } else if (!state.introSeen) {
          introIndex = 0;
          renderIntro();
        } else {
          renderCharacters();
        }
        break;

      case "resume-quest":
        if (state.activeQuest) {
          currentScreen = "game";
          renderGame();
        } else {
          renderLanding();
        }
        break;

      case "intro-next":
        advanceIntro();
        break;

      case "intro-skip":
        playSound("click");
        finishIntro();
        break;

      case "select-character":
        playSound("click");
        handleSelectCharacter(element.getAttribute("data-char"));
        break;

      case "next-beat":
        advanceBeat();
        break;

      case "prev-beat":
        retreatBeat();
        break;

      case "back-dialogue":
        backToDialogue();
        break;

      case "game-back":
        currentScreen = "characters";
        renderCharacters();
        if (state.activeQuest) showToast("Смена на паузе. Продолжить можно с карты героя.");
        break;

      case "pick-option":
        handlePickOption(element.getAttribute("data-id"));
        break;

      case "check-recipe":
        checkRecipe();
        break;

      case "sort-item":
        handleSortItem(element.getAttribute("data-id"));
        break;

      case "sort-reset":
        resetSort();
        break;

      case "choice-option":
        handleChoice(element.getAttribute("data-id"));
        break;

      case "sample-option":
        handleSample(element.getAttribute("data-id"));
        break;

      case "ph-adjust":
        adjustPh(Number(element.getAttribute("data-delta")));
        break;

      case "ph-submit":
        submitPh();
        break;

      case "next-step":
        nextStep();
        break;

      case "go-characters":
        currentScreen = "characters";
        renderCharacters();
        break;

      case "open-apply":
        playSound("click");
        renderApply(element.getAttribute("data-char"));
        break;

      case "quick-apply":
        playSound("click");
        renderApply(null, { quick: true });
        break;

      case "back-result":
        if (state.lastResult || currentResult) {
          currentResult = state.lastResult || currentResult;
          renderResult();
        } else {
          renderCharacters();
        }
        break;

      case "copy-code":
        copyText(element.getAttribute("data-code") || "").then(function (ok) {
          showToast(ok ? "Промокод скопирован" : "Не получилось скопировать. Выдели код вручную.");
          if (!ok) return;
          const splat = element.closest(".promo-splat");
          if (!splat) return;
          splat.classList.remove("is-copied");
          void splat.offsetWidth;
          splat.classList.add("is-copied");
          window.setTimeout(function () {
            splat.classList.remove("is-copied");
          }, 700);
        });
        break;

      case "share-result": {
        sharePromo();
        break;
      }

      case "reset-progress":
        openModal({
          eyebrow: "Сброс прогресса",
          title: "Начать с нуля?",
          text: "Пропадут все смены, промокоды и заявки. Отменить нельзя.",
          cancelLabel: "Остаться",
          confirmLabel: "Сбросить",
          danger: true,
          onConfirm: function () {
            try {
              window.localStorage.removeItem(STORAGE_KEY);
            } catch (error) {
              /* noop */
            }
            state = defaultState();
            stepState = null;
            currentResult = null;
            introIndex = 0;
            saveState();
            renderLanding();
            showToast("Прогресс сброшен. Можно начать заново.");
          }
        });
        break;

      case "modal-close":
        closeModal();
        break;

      case "modal-confirm": {
        const callback = modalCallback;
        closeModal();
        if (callback) callback();
        break;
      }

      case "download-application": {
        const ticket = element.getAttribute("data-ticket");
        const application = state.applications.find(function (entry) {
          return entry.ticket === ticket;
        });
        if (!application) break;
        const pdfChar = getCharacter(application.charId) || (state.lastResult ? getCharacter(state.lastResult.charId) : null);
        let pdfReady = false;
        try {
          pdfReady = Boolean(window.BRODILKA_PDF && window.BRODILKA_PDF.download(application, pdfChar));
        } catch (error) {
          pdfReady = false;
        }
        showToast(pdfReady ? "PDF с карточкой скачан" : "PDF не собрался, открыли версию для печати.");
        break;
      }

      default:
        break;
    }
  }

  document.addEventListener("click", function (event) {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) return;
    if (actionEl.disabled) return;
    const action = actionEl.getAttribute("data-action");
    if (action !== "modal-close" && action !== "modal-confirm") {
      playSound("click");
    }
    handleAction(action, actionEl);
  });

  modalRoot.addEventListener("click", function (event) {
    if (event.target === modalRoot) closeModal();
    if (event.target.closest("[data-modal-backdrop]") && !event.target.closest(".modal-card")) {
      closeModal();
    }
  });

  document.addEventListener("submit", function (event) {
    if (event.target && event.target.id === "applyForm") {
      event.preventDefault();
      handleApplySubmit(event.target);
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) return;
    if (event.key === "Escape" && modalRoot.innerHTML) {
      closeModal();
      return;
    }
    if (modalRoot.innerHTML) {
      if (event.key === "Tab") {
        const focusable = modalRoot.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (event.key === "Enter" && currentScreen === "intro") {
      const active = document.activeElement;
      if (active && (active.tagName === "BUTTON" || active.tagName === "A")) return;
      event.preventDefault();
      advanceIntro();
      return;
    }
    if (event.key === "Enter" && currentScreen === "game" && stepState && stepState.phase === "dialogue") {
      const active = document.activeElement;
      if (active && (active.tagName === "BUTTON" || active.tagName === "A" || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      event.preventDefault();
      advanceBeat();
    }
  });

  soundToggle.addEventListener("click", function () {
    state.sound = !state.sound;
    saveState();
    applySoundState();
    if (state.sound) playSound("click");
  });

  window.addEventListener("popstate", function (event) {
    const target = event.state && event.state.screen ? event.state.screen : "landing";
    suppressHistory = true;
    lastHistoryScreen = target;
    try {
      if (target === "intro") {
        introIndex = 0;
        renderIntro();
      } else if (target === "characters") {
        renderCharacters();
      } else if (target === "game") {
        if (state.activeQuest) {
          renderGame();
        } else {
          renderCharacters();
        }
      } else if (target === "result") {
        if (state.lastResult) {
          renderResult();
        } else {
          renderCharacters();
        }
      } else if (target === "apply" || target === "success") {
        if (state.lastResult) {
          renderResult();
        } else {
          renderLanding();
        }
      } else {
        renderLanding();
      }
    } finally {
      suppressHistory = false;
    }

    /* Если состояние истории больше не соответствует экрану
       (например, заявка уже очищена), не оставляем битую запись. */
    if (currentScreen !== target) {
      lastHistoryScreen = currentScreen;
      try {
        window.history.replaceState({ screen: currentScreen }, "", window.location.href);
      } catch (error) {
        /* noop */
      }
    }
  });

  /* Boot */
  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }
  applySoundState();
  applyDesign(currentDesign(), false);
  initPwa();
  if (!DATA || !Array.isArray(CHARACTERS) || !CHARACTERS.length || !SPEAKERS) {
    renderFatal();
  } else {
    renderLanding();
  }
})();
