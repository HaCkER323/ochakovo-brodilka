# Финальная регрессия «БРОДИЛКА» — v11: брендовая тема и «машинист оборудования»

**Verdict: PASS** — брендовая тема, переключатель, PWA v11 и замена роли работают; открытых P0/P1/P2 нет. P2 из v10 (hero-guide 12 px в brand на мобиле) исправлен и перепроверен.

- **Задача:** task-18 (брендовая тема, переключатель, роль «машинист оборудования») + постфикс v11, production не изменялся.
- **Сборка:** `html[data-design="brand"]` по умолчанию + inline boot; `css/brand.css` (только под `html[data-design="brand"]`, `hero-guide-note` 14 px/1.38 на ≤680); официальные логотип/знак/паттерны в `assets/brand/`; красный корпоративный стиль (#D50032/#FFFFFF); переключатель «Очаково / БРОДИЛКА» в футере; SW `brodilka-v11`; Марк — «Машинист оборудования» (роль, вакансия, README).
- **Стенд:** `qa-report/run-qa.js`, 23 сценария (добавлен `design-theme`).
- **Итог (полный прогон v10 + постфикс v11):** полный — **679 проверок: 676 pass, 0 fail, 2 warn (тот P2), 1 skip, 0 fatal**; постфикс v11 (design-theme + landing-intro-v2 + pwa + pwa-fresh, свежий профиль) — **176 проверок: 175 pass, 0 fail, 0 warn, 1 skip, 0 fatal, exit 0**. Skip — CDP-эмуляция display-mode (standalone проверяется отдельным `--app`-сценарием).
- **Артефакты:** `artifacts/latest.json`, `artifacts/full-run-v10-final.txt`, `artifacts/postfix-v11.txt`, `artifacts/pdf-page-v10.jpg`. Полные скриншоты генерируются прогоном и в поставку не входят.

## Проверено — брендовая тема (task-18)

| Блок | Результат |
|---|---|
| Default brand на чистом `localStorage` | PASS: `data-design=brand`, `theme-color #D50032`, body #FFFFFF, красные CTA/hero (#D50032), бейдж «ПЕРВАЯ СМЕНА · 7 МИНУТ» top-right |
| Официальный логотип/знак/паттерн | PASS: `.brand-logo`/`.brand-mark` видны, `naturalWidth>0`, паттерны на hero; brand-ассеты 200; `brand-preview` нигде не referenced и не в SHELL |
| `brand.css` изолирован | PASS: 341 правило, 0 не scoped под `html[data-design="brand"]` |
| Переключатель «Очаково / БРОДИЛКА» | PASS: 2 кнопки в футере, `aria-pressed` корректен, тост «Оформление: БРОДИЛКА» |
| Переключение на «БРОДИЛКА» | PASS: `data-design=brodilka`, theme #0C3B28, brand-логотип скрыт, вернулись наши токены (`--lime #d7f35b`, `--forest #0c3b28`, `--cream #f3eedf`, `--orange #ff6b3d`), CTA лаймовый `rgb(215,243,91)` |
| Persist / reload без сброса | PASS: тема в `localStorage`, reload сохраняет; активная смена/этап не сбрасываются; возврат на brand работает и не теряет прогресс |
| Все экраны 1440×1000, 390×844, 360×740, landscape | PASS: лендинг, интро, выбор героя, чат/задание — brand по умолчанию, без горизонтального скролла; финал/заявка — brand, без overflow |
| Промокод на 390/360 | PASS: код виден целиком (12 символов, `scrollWidth=clientWidth`, без `…`, в пределах viewport) |
| Пузырь/маскот | PASS: виден на лендинге и в чате, не заменён; filter без grayscale/sepia/hue-rotate/invert |
| Конфетти на финале | PASS: 54 частицы, z-index 0 / pointer-events none, текст/карточки не перекрыты |
| PWA v11 | PASS: SW `brodilka-v11` active, кэш v11, brand.css + brand-ассеты в кэше, `brand-preview` не кэшируется приложением; manifest theme #D50032/background #FFFFFF, installability errors `[]`, offline reload в brand |
| Роль «Машинист оборудования» | PASS: «квасовар» — 0 вхождений в UI, source-файлах и README; «Машинист оборудования» виден в карточке героя, результате, карточке вакансии, PDF; структура data.js/ID/типы заданий не сломаны |
| Регресс остального | PASS: 3 маршрута, все мини-игры, форма без файла, уникальные коды, share без кода, PDF (валидный, 1 страница, кириллица), reload/сброс/клавиатура/звук/история — без регрессий |

## P2 — исправлен в v11

| ID | Проблема (v10) | Статус v11 | Измерение v11 |
|---|---|---|---|
| P2-1 | В brand-теме на мобиле блок «Я Пузырь…» — 12 px | ✅ Исправлено | **14 px** на 390/360 (desktop 15 px), `line-height 1.38`, `max-width 220px`; `landing-intro-v2.guide-size` — pass без warn |

## Постфикс v11 (свежий профиль)

- `design-theme` + `landing-intro-v2` + `pwa` + `pwa-fresh`: **176 проверок, 175 pass, 0 fail, 0 warn, 1 skip, 0 fatal**.
- `.hero-guide-note` в brand на 390/360 — **14 px**, `line-height 1.38`, `max-width 220` (было 12 px).
- SW **brodilka-v11** active, кэш `brodilka-v11-shell/runtime` (v10 не залипает), manifest #D50032/#FFFFFF, installability `[]`, offline reload и `js/pdf.js` офлайн — PASS.
- Регрессий нет: default brand/переключатель/persist/промокод/маскот/конфетти/роли — все проверки проходят.

## Наблюдения

1. Переключатель дизайна живёт в футере; на экранах без футера (игра, заявка) его нет — соответствует «переключатель в футере», не баг.
2. `brand-preview.png` — служебный превью-ассет, приложением не запрашивается; в SW SHELL не входит (проверено). Кэширование при нашем тестовом fetch — артефакт стенда, не приложения.
3. Конфетти на финале в brand рисуется над красной карточкой только как фон (z-index 0); текст и промокод не перекрываются.
4. PWA: CDP display-mode не эмулируется; standalone проверен отдельным `--app`-прогоном (PASS).

## Остаточные риски

1. **HR-интеграция:** `applyEndpoint` пуст → заявка только в localStorage («В очереди у HR»).
2. **Данные:** localStorage без шифрования; политика хранения/удаления — продуктовая задача.
3. **PDF:** страница-картинка (текст не выделяется), кириллица визуально корректна.
4. **Ручные проверки:** установка PWA через UI (Chrome/Edge, iOS), системный back-gesture, экранная клавиатура, VoiceOver/TalkBack.
5. **Демо-контент:** вакансии/зарплаты/приз/промокоды демонстрационные; юридические формулировки согласовать с брендом.
6. **Аналитика/UTM** не подключены — вне рамок QA.

## Скриншоты

Ключевые экраны v11 — в [preview](../preview/):

- [Брендовый лендинг](../preview/01-cover.png)
- [Выбор героя](../preview/02-characters.png)
- [Чат-диалог](../preview/03-game.png)
- [Задание](../preview/04-task.png)
- [Финал и промокод](../preview/05-result.png)
- [Мобильный HUD](../preview/07-mobile-game.png)
- [Наш дизайн «БРОДИЛКА»](../preview/09-brodilka.png)
- [Страница PDF](artifacts/pdf-page-v10.jpg)

Полный набор скриншотов (desktop, mobile, 360, landscape, standalone, offline, оба дизайна) генерируется командой `node qa-report/run-qa.js`; в поставку не входит, чтобы не раздувать архив.

## Как воспроизвести

```powershell
node qa-report/run-qa.js                                  # все 23 сценария
node qa-report/run-qa.js --scenario=design-theme           # брендовая тема/переключатель/PWA v11
node qa-report/run-qa.js --scenario=content-guard,mobile-reload,pwa,pwa-fresh
```

План обновлён: [test-plan.md](test-plan.md) (S32 + блок B1–B9). Предыдущий отчёт: [final-v2.md](final-v2.md) (v9).

## Вывод

Брендовая тема v11 работает: brand по умолчанию, официальный логотип/паттерн и красный стиль на всех экранах и viewport, переключатель «Очаково / БРОДИЛКА» сохраняется и не сбрасывает игру, наш дизайн после переключения идентичен прежнему, промокод на мобиле не обрезан, Пузырь на месте, PWA v11 и offline работают; роль «Машинист оборудования» заменила прежнюю роль в UI, README и PDF. P2 с hero-guide (12 px) исправлен — 14 px на 390/360, постфикс без warn. **Verdict: PASS**; открытых P0/P1/P2 нет, остаются только ограничения демо-прототипа.

