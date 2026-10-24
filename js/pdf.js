/* =========================================================
   БРОДИЛКА — PDF заявки без внешних зависимостей.
   A4-макет рисуется на canvas (1240×1754), кодируется в JPEG
   и встраивается в минимальный валидный PDF (DCTDecode).
   ========================================================= */

(function () {
  "use strict";

  const CANVAS_W = 1240;
  const CANVAS_H = 1754;
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const M = 90;

  const BASE_PALETTE = {
    bg: "#f3eedf",
    card: "#fbf8ee",
    ink: "#10251a",
    muted: "#5e6b62",
    border: "#10251a",
    headerBg: "#0c3b28",
    headerStrip: "#d7f35b",
    headerText: "#f3eedf",
    headerMuted: "rgba(243,238,223,0.7)",
    brandAccent: "#d7f35b",
    headerLabel: "#d7f35b",
    titleAccent: "#0c3b28",
    accent: "#0c3b28",
    statusDeliveredBg: "#d7f35b",
    statusDeliveredFg: "#10251a",
    statusPendingBg: "#ebf9ae",
    statusPendingFg: "#10251a",
    statusBorder: "#10251a",
    footerBg: "#0c3b28",
    footerText: "#d7f35b",
    footerMuted: "rgba(243,238,223,0.6)",
    pillBg: "#fbf8ee",
    pillFg: "#10251a",
    pillBorder: "#10251a"
  };

  const BRAND_PALETTE = {
    bg: "#ffffff",
    card: "#ffffff",
    ink: "#1a1a1a",
    muted: "#626262",
    border: "#a2aaad",
    headerBg: "#d50032",
    headerStrip: "#ab2328",
    headerText: "#ffffff",
    headerMuted: "rgba(255,255,255,0.78)",
    brandAccent: "#ffffff",
    headerLabel: "#ffffff",
    titleAccent: "#ab2328",
    accent: "#ab2328",
    statusDeliveredBg: "#ab2328",
    statusDeliveredFg: "#ffffff",
    statusPendingBg: "#ffffff",
    statusPendingFg: "#626262",
    statusBorder: "#a2aaad",
    footerBg: "#d50032",
    footerText: "#ffffff",
    footerMuted: "rgba(255,255,255,0.72)",
    pillBg: "#ffffff",
    pillFg: "#1a1a1a",
    pillBorder: "#a2aaad"
  };

  let COLOR = BASE_PALETTE;

  function applyPalette() {
    const design = document.documentElement ? document.documentElement.getAttribute("data-design") : null;
    COLOR = design === "brand" ? BRAND_PALETTE : BASE_PALETTE;
  }

  const FONT_DISPLAY = '800 62px Bahnschrift, "DIN Condensed", "Arial Narrow", "Segoe UI", sans-serif';
  const FONT_DISPLAY_SM = '800 38px Bahnschrift, "DIN Condensed", "Arial Narrow", "Segoe UI", sans-serif';
  const FONT_BODY = '400 26px "Segoe UI", "Helvetica Neue", Arial, sans-serif';
  const FONT_BODY_BOLD = '700 26px "Segoe UI", "Helvetica Neue", Arial, sans-serif';
  const FONT_SMALL = '400 21px "Segoe UI", "Helvetica Neue", Arial, sans-serif';
  const FONT_MONO = '700 17px Consolas, "Courier New", monospace';
  const FONT_MONO_SM = '600 15px Consolas, "Courier New", monospace';

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function wrapLines(ctx, value, maxWidth, maxLines) {
    const text = String(value == null ? "" : value).trim() || "нет данных";
    const words = text.split(/\s+/);
    const lines = [];
    let current = "";
    words.forEach(function (word) {
      const candidate = current ? current + " " + word : word;
      if (ctx.measureText(candidate).width <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    });
    if (current) lines.push(current);
    const result = [];
    lines.forEach(function (line) {
      if (line.length > 1 && ctx.measureText(line).width > maxWidth) {
        let chunk = "";
        for (let i = 0; i < line.length; i += 1) {
          if (ctx.measureText(chunk + line[i]).width > maxWidth && chunk) {
            result.push(chunk);
            chunk = line[i];
          } else {
            chunk += line[i];
          }
        }
        if (chunk) result.push(chunk);
      } else {
        result.push(line);
      }
    });
    if (maxLines && result.length > maxLines) {
      const clipped = result.slice(0, maxLines);
      let last = clipped[maxLines - 1];
      while (ctx.measureText(last + "…").width > maxWidth && last.length > 1) {
        last = last.slice(0, -1);
      }
      clipped[maxLines - 1] = last + "…";
      return clipped;
    }
    return result;
  }

  function drawWrapped(ctx, value, x, y, maxWidth, lineHeight, options) {
    const opts = options || {};
    const lines = wrapLines(ctx, value, maxWidth, opts.maxLines);
    lines.forEach(function (line, index) {
      ctx.fillText(line, x, y + index * lineHeight);
    });
    return y + lines.length * lineHeight;
  }

  function drawLabel(ctx, text, x, y, color) {
    ctx.font = FONT_MONO;
    ctx.fillStyle = color || COLOR.accent;
    ctx.fillText(text.toUpperCase(), x, y);
  }

  function drawCard(ctx, x, y, w, h) {
    ctx.fillStyle = COLOR.card;
    ctx.strokeStyle = COLOR.border;
    ctx.lineWidth = 2.5;
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();
  }

  function drawPill(ctx, text, x, y, options) {
    const opts = options || {};
    ctx.font = opts.font || FONT_MONO_SM;
    const padding = opts.padding || 18;
    const width = ctx.measureText(text).width + padding * 2;
    const height = opts.height || 36;
    ctx.fillStyle = opts.bg || COLOR.pillBg;
    ctx.strokeStyle = opts.border || COLOR.pillBorder;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, width, height, height / 2);
    ctx.fill();
    if (opts.border !== "none") ctx.stroke();
    ctx.fillStyle = opts.fg || COLOR.pillFg;
    ctx.textAlign = "left";
    ctx.fillText(text, x + padding, y + height / 2 + 6);
    return width;
  }

  function formatDate(value) {
    try {
      return new Date(value).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (error) {
      return String(value || "");
    }
  }

  function formatBirthDate(value) {
    const text = String(value == null ? "" : value).trim();
    const parts = text.split("-");
    if (parts.length !== 3 || parts[0].length !== 4) return "не указана";
    return parts[2] + "." + parts[1] + "." + parts[0];
  }

  function renderCanvas(application, char) {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");

    const vacancy = (char && char.vacancy) || {};
    const team = vacancy.team || "";
    const location = vacancy.location || "";
    const schedule = vacancy.schedule || "";
    const salary = vacancy.salary || "";
    const perks = Array.isArray(vacancy.perks) ? vacancy.perks : [];
    const responsibilities = Array.isArray(vacancy.responsibilities) ? vacancy.responsibilities : [];
    const delivered = Boolean(application.delivered);
    const statusText = delivered ? "Отправлено в HR" : "Сохранено в браузере";
    const resumeText = application.resumeLink || "не приложено";
    const dateText = formatDate(application.createdAt);

    applyPalette();

    /* Фон */
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    /* Шапка */
    ctx.fillStyle = COLOR.headerBg;
    ctx.fillRect(0, 0, CANVAS_W, 250);
    ctx.fillStyle = COLOR.headerStrip;
    ctx.fillRect(0, 0, CANVAS_W, 12);

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = COLOR.headerText;
    ctx.font = '800 34px Bahnschrift, "Segoe UI", sans-serif';
    ctx.fillText("ОЧАКОВО", M, 108);
    ctx.fillStyle = COLOR.brandAccent;
    ctx.font = '800 48px Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif';
    ctx.fillText("БРОДИЛКА", M, 168);
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = COLOR.headerMuted;
    ctx.fillText("КВЕСТ О ПЕРВОЙ СМЕНЕ", M, 208);

    ctx.textAlign = "right";
    ctx.font = FONT_MONO;
    ctx.fillStyle = COLOR.headerLabel;
    ctx.fillText("КАРТОЧКА СТАЖЁРА", CANVAS_W - M, 108);
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = COLOR.headerMuted;
    ctx.fillText("ДЕМО · НЕ ОФЕРТА", CANVAS_W - M, 146);
    ctx.textAlign = "left";

    /* Заголовок */
    ctx.fillStyle = COLOR.ink;
    ctx.font = FONT_DISPLAY;
    ctx.fillText("Карточка", M, 356);
    ctx.fillStyle = COLOR.titleAccent;
    ctx.fillText("стажёра", M, 420);

    /* Номер карточки + статус */
    drawCard(ctx, CANVAS_W - M - 380, 300, 380, 148);
    drawLabel(ctx, "номер карточки", CANVAS_W - M - 380 + 24, 336);
    ctx.fillStyle = COLOR.ink;
    ctx.font = '700 32px "Segoe UI", Arial, sans-serif';
    ctx.fillText(application.ticket || "нет номера", CANVAS_W - M - 380 + 24, 382);
    drawPill(ctx, statusText, CANVAS_W - M - 380 + 24, 398, {
      bg: delivered ? COLOR.statusDeliveredBg : COLOR.statusPendingBg,
      fg: delivered ? COLOR.statusDeliveredFg : COLOR.statusPendingFg,
      border: COLOR.statusBorder
    });

    /* Кандидат */
    drawLabel(ctx, "ФИО", M, 500);
    drawCard(ctx, M, 522, CANVAS_W - M * 2, 322);
    ctx.fillStyle = COLOR.ink;
    ctx.font = FONT_DISPLAY_SM;
    drawWrapped(ctx, application.name, M + 30, 584, CANVAS_W - M * 2 - 60, 46, { maxLines: 1 });

    const rows = [
      ["Дата рождения", formatBirthDate(application.birthDate)],
      ["Телефон", application.phone],
      ["Email", application.email],
      ["Город", application.city || "не указан"],
      ["ВУЗ / колледж", application.education || "не указано"]
    ];
    rows.forEach(function (row, index) {
      const y = 636 + index * 40;
      ctx.font = FONT_MONO_SM;
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(row[0].toUpperCase(), M + 30, y);
      ctx.font = FONT_BODY;
      ctx.fillStyle = COLOR.ink;
      drawWrapped(ctx, row[1], M + 210, y, CANVAS_W - M * 2 - 240, 22, { maxLines: 1 });
    });

    /* Вакансия */
    drawLabel(ctx, "вакансия", M, 890);
    drawCard(ctx, M, 912, CANVAS_W - M * 2, 394);
    ctx.fillStyle = COLOR.ink;
    ctx.font = FONT_DISPLAY_SM;
    drawWrapped(ctx, application.vacancy || vacancy.title || "не указана", M + 30, 968, 780, 46, { maxLines: 1 });
    ctx.font = FONT_SMALL;
    ctx.fillStyle = COLOR.muted;
    drawWrapped(ctx, team, M + 30, 1006, 780, 26, { maxLines: 1 });

    const meta = [
      ["Локация", location],
      ["График", schedule],
      ["Оплата", salary]
    ];
    meta.forEach(function (row, index) {
      const y = 1058 + index * 42;
      ctx.font = FONT_MONO_SM;
      ctx.fillStyle = COLOR.muted;
      ctx.fillText(row[0].toUpperCase(), M + 30, y);
      ctx.font = FONT_BODY;
      ctx.fillStyle = COLOR.ink;
      drawWrapped(ctx, row[1], M + 210, y, 760, 24, { maxLines: 1 });
    });

    if (responsibilities.length) {
      ctx.font = FONT_MONO_SM;
      ctx.fillStyle = COLOR.accent;
      ctx.fillText("ЧТО БУДЕШЬ ДЕЛАТЬ", M + 30, 1190);
      let y = 1222;
      responsibilities.slice(0, 3).forEach(function (item) {
        ctx.fillStyle = COLOR.accent;
        ctx.fillRect(M + 34, y - 16, 10, 10);
        ctx.font = FONT_SMALL;
        ctx.fillStyle = COLOR.ink;
        drawWrapped(ctx, item, M + 60, y, CANVAS_W - M * 2 - 100, 24, { maxLines: 1 });
        y += 26;
      });
    }

    /* Резюме + статус */
    drawLabel(ctx, "резюме", M, 1350);
    drawCard(ctx, M, 1372, CANVAS_W - M * 2, 104);
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = COLOR.muted;
    ctx.fillText("ССЫЛКА", M + 30, 1406);
    ctx.font = FONT_BODY;
    ctx.fillStyle = application.resumeLink ? COLOR.accent : COLOR.ink;
    drawWrapped(ctx, resumeText, M + 30, 1440, CANVAS_W - M * 2 - 60, 24, { maxLines: 2 });

    /* Условия */
    drawLabel(ctx, "условия", M, 1518);
    let pillX = M;
    perks.forEach(function (perk) {
      ctx.font = FONT_MONO_SM;
      const pillWidth = ctx.measureText(perk).width + 36;
      if (pillX + pillWidth > CANVAS_W - M) return;
      drawPill(ctx, perk, pillX, 1532, { bg: COLOR.pillBg, fg: COLOR.pillFg, border: COLOR.pillBorder, height: 38 });
      pillX += pillWidth + 12;
    });
    if (!perks.length) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = COLOR.muted;
      ctx.fillText("Условия обсуждаем на интервью.", M, 1560);
    }

    /* Подвал */
    ctx.fillStyle = COLOR.footerBg;
    ctx.fillRect(0, 1660, CANVAS_W, CANVAS_H - 1660);
    ctx.fillStyle = COLOR.footerText;
    ctx.font = '800 24px Bahnschrift, "Segoe UI", sans-serif';
    ctx.fillText("ОЧАКОВО × БРОДИЛКА", M, 1706);
    ctx.font = FONT_MONO_SM;
    ctx.fillStyle = COLOR.footerMuted;
    ctx.fillText("Демо · карточка сохранена локально · " + dateText, M, 1738);

    return canvas;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function buildPdf(jpegBytes) {
    const encoder = new TextEncoder();
    const chunks = [];
    let size = 0;
    const pushBytes = function (bytes) {
      chunks.push(bytes);
      size += bytes.length;
    };
    const pushString = function (value) {
      pushBytes(encoder.encode(value));
    };

    pushString("%PDF-1.4\n");
    pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const offsets = [0, 0, 0, 0, 0, 0];

    offsets[1] = size;
    pushString("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    offsets[2] = size;
    pushString("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

    offsets[3] = size;
    pushString(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] " +
        "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
    );

    offsets[4] = size;
    pushString(
      "4 0 obj\n<< /Type /XObject /Subtype /Image /Width " +
        CANVAS_W +
        " /Height " +
        CANVAS_H +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        jpegBytes.length +
        " >>\nstream\n"
    );
    pushBytes(jpegBytes);
    pushString("\nendstream\nendobj\n");

    const content = "q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ";
    offsets[5] = size;
    pushString("5 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream\nendobj\n");

    const xrefOffset = size;
    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 1; i <= 5; i += 1) {
      xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    pushString(xref);
    pushString("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n");

    const output = new Uint8Array(size);
    let offset = 0;
    chunks.forEach(function (chunk) {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }

  function safeFilename(ticket) {
    const clean = String(ticket || "application").replace(/[^A-Za-z0-9_-]+/g, "-");
    return "ochakovo-zayavka-" + clean + ".pdf";
  }

  function create(application, char) {
    const canvas = renderCanvas(application, char);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const base64 = dataUrl.indexOf(",") !== -1 ? dataUrl.split(",")[1] : dataUrl;
    const jpegBytes = base64ToBytes(base64);
    const pdfBytes = buildPdf(jpegBytes);
    return {
      bytes: pdfBytes,
      jpegBytes: jpegBytes,
      filename: safeFilename(application.ticket),
      canvas: canvas
    };
  }

  function escapeHtmlLocal(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fallbackPrint(application, char) {
    applyPalette();
    const vacancy = (char && char.vacancy) || {};
    const rows = [
      ["Номер карточки", application.ticket],
      ["Дата", formatDate(application.createdAt)],
      ["Вакансия", application.vacancy || vacancy.title],
      ["ФИО", application.name],
      ["Дата рождения", formatBirthDate(application.birthDate)],
      ["Телефон", application.phone],
      ["Email", application.email],
      ["Город", application.city || "не указан"],
      ["ВУЗ / колледж", application.education || "не указано"],
      ["Резюме", application.resumeLink || "не приложено"],
      ["Статус", application.delivered ? "Отправлено в HR" : "Сохранено в браузере (демо)"]
    ];
    const html =
      "<!DOCTYPE html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>Карточка " +
      escapeHtmlLocal(application.ticket) +
      "</title><style>body{font-family:'Segoe UI',Arial,sans-serif;padding:40px;color:" + COLOR.ink + "}" +
      "h1{font-size:28px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid " + COLOR.border + ";padding:10px 6px}" +
      "td:first-child{color:" + COLOR.muted + ";width:180px}p{margin-top:24px;color:" + COLOR.muted + "}</style></head><body>" +
      "<h1>ОЧАКОВО × БРОДИЛКА: карточка стажёра</h1><table>" +
      rows
        .map(function (row) {
          return "<tr><td>" + escapeHtmlLocal(row[0]) + "</td><td>" + escapeHtmlLocal(row[1] || "нет данных") + "</td></tr>";
        })
        .join("") +
      "</table><p>Демо, не публичная оферта. Карточка сохранена локально.</p>" +
      "<script>window.print();</script></body></html>";
    const win = window.open("", "_blank");
    if (!win) return false;
    win.document.open();
    win.document.write(html);
    win.document.close();
    return true;
  }

  function download(application, char) {
    try {
      const result = create(application, char);
      const blob = new Blob([result.bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 5000);
      return true;
    } catch (error) {
      try {
        return fallbackPrint(application, char);
      } catch (fallbackError) {
        return false;
      }
    }
  }

  window.BRODILKA_PDF = {
    create: create,
    download: download,
    renderCanvas: renderCanvas,
    buildPdf: buildPdf,
    filename: safeFilename
  };
})();
