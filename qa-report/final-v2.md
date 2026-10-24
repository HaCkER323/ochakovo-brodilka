# Финальная регрессия «БРОДИЛКА» — итерация v9 (контент, чат, PDF, share)

**Verdict: PASS** — все пункты заказчика выполнены, открытых P0/P1/P2 нет. Три P2 из v6 исправлены и перепроверены, финальный мобильный бейдж проверен на v9.

- **Задачи:** task-12 (финальная регрессия итерации) + task-13 (постфикс P2, конфетти, SW v8) + финальная проверка бейджа v9; production не изменялся.
- **Сборка:** SW `brodilka-v9`; мобильный бейдж «ПЕРВАЯ СМЕНА · 7 МИНУТ» в потоке сверху справа (не перекрывает eyebrow); `js/pdf.js`; `assets/share-promo.png/svg`; новые scene-SVG/chief; HUD в две строки на мобиле; скрытый `scene-stamp` ≤680; header-counter интро; время сцены 07:40–16:10; конфетти на финале — фон (z-index 0, контент z-index 2). P2: `.hero-guide-note` 14 px на 390/360, `.route-label` 10 px, `.char-footer .btn` 44 px.
- **Стенд:** `qa-report/run-qa.js` (Node 24.17, headless Edge/155, локальный http-сервер), 22 сценария.
- **Итог (v8, постфикс):** **333 проверки: 332 pass, 0 fail, 0 warn, 1 skip, 0 fatal, exit 0** на свежих профилях (8 сценариев: `final-fixes`, `postfix-touch`, `readability-v2`, `landing-intro-v2`, `mobile-reload`, `desktop-full`, `pwa`, `pwa-fresh`). Полный регресс v6 до микро-пасса: 595 проверок, 589 pass, 0 fail, 5 warn (все три P2), 1 skip.
- **Финальный бейдж v9:** `final-fixes` — 47/47 pass, 0 fail, 0 warn, 0 fatal; бейдж relative/absolute, справа сверху, вне hero-art, выше CTA.
- **Машинные артефакты:** `artifacts/latest.json`, `artifacts/postfix-v8.txt`, `artifacts/full-run-v6-final.txt`, извлечённая страница PDF — `artifacts/pdf-page.jpg`. Полные скриншоты генерируются прогоном и в поставку не входят.

## Пункты заказчика (task-8…task-11)

| # | Пункт | Статус / доказательство |
|---|---|---|
| 1 | Интервалы hero/how, H1 не наезжает на eyebrow | PASS — `landing-intro-v2` (desktop/390/360), скриншоты `01-landing-*` |
| 2 | Убрано «с телефона», блок Пузыря крупнее | PASS — текст меты «7 минут · без регистрации»; guide 15 px desktop (на мобиле 12 px — P2) |
| 3 | Удалён абзац «Это не тест на знание напитков…» | PASS — `landing-intro-v2`, `content-guard` |
| 4 | Убраны «0%», «безалкогольные», возрастной бейдж | PASS — 0 вхождений в UI, console, HTML/JS/manifest/SW; `content.no-*` |
| 5 | Крупный бейдж «ПЕРВАЯ СМЕНА · 7 МИНУТ», top-right, вне hero-art | PASS — `final-fixes-*` (position:absolute, справа сверху, над CTA, не в hero-art) |
| 6 | Микро-лейблы ≥11 desktop / ≥10 mobile, body 16–18 | PASS в основном; P2: `route-label` 9.5 px на 390/360 |
| 7 | Убраны подсказки Enter/`<kbd>` | PASS — нет `kbd`, нет «Enter» в UI |
| 8 | Интро: 5 реплик, новый порядок (4/5 — Пузырь), без 07:42 | PASS — `content-v2` (порядок narrator→bubble→chief→bubble→chief) |
| 9 | Интро обновляется in-place без перерисовки/scrollTo | PASS — тот же DOM-узел, без running-анимаций, scrollY не меняется; header-counter обновляется (`final-fixes-*.intro-header-counter`) |
| 10 | Слева — текущий говорящий (Очаково/Пузырь/Дядя Витя) | PASS — `landing-intro-v2` (аватар/инициалы соответствуют реплике) |
| 11 | Новый `chief.svg`, читаемый | PASS — `art-v2`, скриншоты интро |
| 12 | «Совет Пузыря» сверху, крупный, без дубля | PASS — `readability-*` (один блок, 15+ px, выше сетки героев) |
| 13 | Карточки героев и CTA на 390×844 | PASS — `survey-mobile`, `mobile-cta`, `postfix-touch` |
| 14 | Игровой диалог как чат: герой слева, Пузырь справа, история | PASS — `chat-v2` (desktop/390/landscape): аватары/имена, накопление, тот же контейнер |
| 15 | «Дальше» без полной перерисовки | PASS — `chat-v2.in-place`, `intro-in-place` |
| 16 | Убраны плавающий совет на сцене и дубль-бейдж | PASS — `chat-v2.no-scene-advice`, `no-scene-badge` |
| 17 | Чипы/локация/тайминг выровнены | PASS — `chat-v2.chips-readable`; время сцены 07:40–16:10 (`final-fixes.scene-time-label`) |
| 18 | Новые scene-SVG интегрированы, фоны разные | PASS — `art-v2`: 3 валидных SVG 1600×1000, разные хеши, рендерятся на всех маршрутах |
| 19 | На мобиле не скрыты scene-caption/route-label | PASS — `chat-v2.labels-*`, `readability-*.informative-labels` |
| 20 | Мини-игры читаемы, без обрезаний | PASS — `readability-v2`, скриншоты игр 390/360/landscape |
| 21 | «Смена закрыта» — стабильная сетка, читаемый промокод | PASS — `desktop-full` result, `mobile-reload` result (desktop+mobile) |
| 22 | Уникальный код на каждое завершение (в т.ч. повторное) | PASS — `share-pdf.code-unique` (коды разные, ≥6 символов, crypto.getRandomValues) |
| 23 | Код не попадает в share | PASS — `share-pdf.no-code-in-share` |
| 24 | Web Share с картинкой/текстом без кода + fallback | PASS — `share-pdf.web-share-*`, `.fallback`, `.fallback-no-error`; share image 1080×1350, 200 OK |
| 25 | PDF заявки (не txt), одна страница, кириллица, все поля | PASS — `share-pdf.pdf-valid` (%PDF, %%EOF, 1 страница, JPEG), имя `ochakovo-zayavka-<ticket>.pdf`; визуально проверено `artifacts/pdf-page.jpg` |
| 26 | Форма без файла: только необязательная ссылка | PASS — `form-nofile` (нет input[type=file]/«Прикрепить файл», отправка без резюме) |
| 27 | Левая карточка вакансии с обязанностями | PASS — 3 responsibilities отображаются, роль/локация/график/условия |
| 28 | HUD в 2 строки, 01/03 не наезжает на «Финиш» | PASS — `final-fixes-390/360` (route во второй строке, пересечения нет) |
| 29 | `scene-stamp` скрыт ≤680 | PASS — hidden на 390/360, видим на 844/1440 |
| 30 | PWA v6: manifest/icons/SW/offline/installability | PASS — `pwa`, `pwa-fresh`, `pwa-standalone`; кэш содержит `js/pdf.js` и `share-promo`, offline работает |
| 31 | История back/forward, форма, localStorage | PASS — `history`, `desktop-full`, `mobile-reload` |

## P2-замечания — исправлены в v8

| ID | Проблема (v6) | Статус v8 | Измерение v8 |
|---|---|---|---|
| P2-1 | CTA карточки героя в landscape 148×43 px | ✅ Исправлено | **148×44 px** (390: 194×44, 360: 164×44), `min-height: 44px` |
| P2-2 | Блок «Я Пузырь…» на 390/360 — 12 px | ✅ Исправлено | **14 px** на 390 и 360 (desktop 15 px) |
| P2-3 | `route-label` в мобильном HUD 9.5 px | ✅ Исправлено | **10 px** на 390/360, проверка шрифтов проходит без warn |

## Постфикс v8 (task-13)

- **Конфетти на финале — только фон:** 54 частицы, `position: absolute`, `pointer-events: none`, `z-index: 0`; контент `.result-wrap` — `position: relative; z-index: 2`, футер z-index 3. `elementFromPoint` по заголовку и карточке промокода не находит перекрытия — проверено на desktop 1440×1000 и mobile 390×844 (`result.confetti-*`, `result-packer.confetti-*`).
- **P2 закрыты** (см. таблицу выше); HUD 390/360 в две строки, 01/03 не пересекается с «Финиш», badge top-right, scene-stamp скрыт ≤680, header-counter интро и время сцены 07:40–16:10 — все проверки PASS.
- **PWA v8:** SW `brodilka-v8` active, кэш v8, `Page.getAppManifest.errors = []`, `Page.getInstallabilityErrors = []`, иконки 192/512/maskable/180 — 200, книжный кэш содержит `js/pdf.js` и `share-promo`, offline reload и standalone работают.

## Что исправлено в итерации (проверено)

- Контент полностью без пива/алкоголя/18+, роли машинист оборудования/оператор линии/лаборант, тайминг 07:40–16:10.
- Интро: 5 реплик, Пузырь представляется до Шефа, 4/5 говорит Пузырь, левый спикер, in-place обновление и header-счётчик.
- Лендинг: интервалы, новый бейдж top-right, убраны «0%»/«безалкогольные»/Enter.
- Игровой экран: чат-переписка, история сообщений, мобильный HUD в 2 строки, скрыт дубль scene-stamp.
- Финал/шаринг/PDF: уникальные криптокоды, share-картинка без кода, fallback, валидный PDF с кириллицей.
- Форма: файл убран, ссылка «необязательно», карточка вакансии с обязанностями.
- PWA: SW v6, кэш pdf.js/share-promo, offline reload, installability без ошибок, standalone.

## Остаточные риски

1. **HR-интеграция:** `applyEndpoint` пуст → заявка только в localStorage, статус «В очереди у HR». Нужен реальный вебхук и обработка ошибок сети.
2. **Данные:** заявки/прогресс в localStorage без шифрования; политика хранения/удаления — продуктовая задача.
3. **PDF:** страница-картинка (текст не выделяется и не индексируется), но визуально кириллица корректна; для цифрового PDF нужен текстовый слой.
4. **Ручные проверки:** установка PWA через UI (Chrome/Edge, iOS «На экран Домой»), системный back-gesture, экранная клавиатура, VoiceOver/TalkBack — headless не воспроизводит.
5. **Демо-контент:** вакансии/зарплаты/приз/промокоды демонстрационные; юридические формулировки согласовать с брендом.
6. **Аналитика/UTM** не подключены — вне рамок QA.

## Скриншоты

Ключевые экраны v8 — в [preview](../preview/):

- [Лендинг](../preview/01-cover.png)
- [Выбор героя](../preview/02-characters.png)
- [Чат-диалог](../preview/03-game.png)
- [Задание](../preview/04-task.png)
- [Смена закрыта / промокод](../preview/05-result.png)
- [Мобильный лендинг](../preview/06-mobile.png)
- [Мобильный HUD и чат](../preview/07-mobile-game.png)
- [Страница PDF](artifacts/pdf-page.jpg)

Полный набор скриншотов (desktop, mobile, 360, landscape, standalone, offline, постфикс P2) генерируется командой `node qa-report/run-qa.js`; в архив он не включён, чтобы не раздувать поставку.

## Как воспроизвести

```powershell
node qa-report/run-qa.js                                  # все 22 сценария
node qa-report/run-qa.js --scenario=final-fixes,share-pdf,pwa-fresh
node qa-report/run-qa.js --scenario=mobile-reload,chat-v2,readability-v2
```

Подробный план — [test-plan.md](test-plan.md).

## Вывод

Сборка v9 закрывает все пункты заказчика: контент без алкоголя, интро с новым порядком и левым спикером, чат-диалог, мобильный HUD без наездов, бейдж сверху, форма без файла, уникальные коды, share без кода, валидный PDF с кириллицей, PWA v9 с offline, конфетти только в фоне. Три P2 из v6 исправлены и перепроверены; открытых P0/P1/P2 нет. **Verdict: PASS**; остаются только ограничения демо-прототипа (HR-вебхук, localStorage, ручная установка PWA/iOS).
