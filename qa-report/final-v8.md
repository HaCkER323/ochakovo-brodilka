# Финальная регрессия «БРОДИЛКА» — v23: бонусы работодателя в обоих откликах

**Verdict: PASS** — P2 v22 (невидимый заголовок блока бонусов в быстром отклике) закрыт: заголовок контрастен в brand и brodilka, обычный отклик не сломан, регрессий нет. Сборка готова к пушу.

- **Задачи:** task-37 (v22: `employerBenefits` + `employerBenefitsMarkup()`) + task-38 (постфикс v23: контраст заголовка), production не изменялся.
- **Сборка:** SW `brodilka-v23`; `.quick-benefits .vacancy-section-title { color: var(--ink); }`, в brand — `var(--brand-ink)`; 6 бонусов в обычном (`.vacancy-card-bottom`) и быстром (`.quick-benefits`) отклике.
- **Стенд:** **`PORT=4517 ADMIN_PASSWORD=qa-admin-password node serve.js`**; целевой прогон v23 (`v22-final`, `v19-final`, `pwa`, `pwa-fresh`) + полный прогон v22 (27 сценариев), API/auth, админка UI, XLSX (`openpyxl 3.1.5`).
- **Итог:** целевой v23 — **130 проверок: 129 pass, 0 fail, 0 warn, 1 skip, 0 fatal**; все `heading-visible` (quick/normal, 1440/390/360, обе темы) — PASS. Полный прогон v22 — **844 проверки: 840 pass, 3 fail** (те самые P2, теперь закрыты), 1 skip. API — **38/38**, админка — **16/16**, XLSX — **9/9**. SW v23 подтверждён (`brodilka-v23`).
- **Артефакты:** `artifacts/server-v23-targeted.txt`, `artifacts/server-full-v22.txt`, `artifacts/server-qa-results.json`, `artifacts/server-admin-qa-results.json`, `artifacts/xlsx-validation.json`, `artifacts/server-v23.log`. Скриншоты и XLSX с тестовыми ПДн в поставку не входят.

## P2 — закрыт: заголовок блока бонусов читается

| | |
|---|---|
| **Было (v22)** | В быстром отклике `.quick-benefits .vacancy-section-title`: brand — белый на белом (контраст **1.0**), brodilka — lime на кремовом (контраст **1.17**); заголовок «Условия и бонусы от работодателя» визуально отсутствовал |
| **Фикс v23** | `.quick-benefits .vacancy-section-title { color: var(--ink); }`; `html[data-design="brand"] .quick-benefits .vacancy-section-title { color: var(--brand-ink); }` |
| **Проверка v23** | `v22.quick-desktop.heading-visible`, `v22.quick-mobile-390`, `v22.quick-mobile-360` — PASS (контраст ≥3:1, заголовок виден); скриншот подтверждает тёмный заголовок на светлом фоне |
| **Обычный отклик** | `v22.normal-brand/normal-brodilka/normal-mobile-*` — PASS; заголовок остаётся светлым на тёмной `.vacancy-card` (контраст 21 / 16.9), регрессии нет |

Скриншот: [быстрый отклик brand 1440 — заголовок виден](../preview/14-benefits-quick.png).

## Что прошло

| Блок | Результат |
|---|---|
| `DATA.employerBenefits` — 6 пунктов (карьерный рост, развитие навыков, опытный коллектив, соцпакет/льготы, наставники, другие условия) | PASS |
| Обычный отклик: блок в `.vacancy-card-bottom`, 6 пунктов, заголовок «Условия и бонусы от работодателя», disclaimer, на тёмной карточке читается | PASS |
| Быстрый отклик: `.quick-benefits` под карточками персонажей, те же 6 пунктов/заголовок/disclaimer, форма ниже, роли выше | PASS |
| Списки совпадают: заголовки/тексты/порядок идентичны в обычном и быстром отклике (desktop brand/brodilka) | PASS |
| 1440/390/360, обе темы: нет hscroll, обрезки текста, перекрытий с ролями/формой; длинные пункты переносятся; desktop 3 колонки, mobile 1 | PASS |
| Выбор роли/форма после блока работают (клик, hidden/aria, success/PDF/data) | PASS |
| Регрессия: PWA v23/offline, форма/PDF, диалоги/«Назад», 3 маршрута, финал, админка/API/XLSX | PASS |

## Остаточные риски

1. **Хранилище:** JSON-файл без БД/шифрования; для продакшена нужна БД и политика хранения ПДн.
2. **Один процесс:** `Store` в памяти; для нескольких инстансов нужна общая БД.
3. **Excel:** ручная сборка; проверены значения/типы/кириллица, сложное форматирование не поддерживается.
4. **Ручные проверки:** установка PWA через UI, back-gesture, экранная клавиатура, VoiceOver/TalkBack.

## Скриншоты и файлы

- [Быстрый отклик: заголовок «Условия и бонусы от работодателя» виден](../preview/14-benefits-quick.png)
- [Обычный отклик, brand](../preview/15-benefits-normal.png)
- Остальные скриншоты, админка и XLSX содержат тестовые ПДн и в поставку не входят.
- Логи/результаты: `artifacts/server-v23-targeted.txt`, `server-full-v22.txt`, `server-qa-results.json`, `server-admin-qa-results.json`, `xlsx-validation.json`.

## Как воспроизвести

```powershell
$env:PORT='4517'; $env:ADMIN_PASSWORD='qa-admin-password'; node serve.js
node qa-report/server-qa.js http://127.0.0.1:4517
node qa-report/run-qa.js --url=http://127.0.0.1:4517
node qa-report/server-admin-qa.js http://127.0.0.1:4517
$env:PYTHONIOENCODING='utf-8'
& "C:\Users\alexa\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" qa-report/validate_xlsx.py
```

План: [test-plan.md](test-plan.md) — S37 + блок W1–W5.

## Вывод

Общий `employerBenefits` и `employerBenefitsMarkup()` работают: 6 пунктов с одинаковым заголовком/текстами/disclaimer выводятся в обычном (`.vacancy-card-bottom`) и быстром (`.quick-benefits`) отклике, списки совпадают, 1440/390/360 и обе темы без обрезки/перекрытий/hscroll, заголовок быстрого блока теперь контрастен в обеих темах, обычный отклик не сломан. Выбор роли/форма/PDF/API/data, PWA v23/offline, админка/API/XLSX, диалоги — PASS. **Verdict: PASS** — можно пушить (с учётом демо-ограничений хранилища).
