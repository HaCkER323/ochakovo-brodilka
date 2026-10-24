# Финальная регрессия «БРОДИЛКА» — v17: сбор откликов, админка, Excel

**Verdict: PASS** — P1 (кэширование админки/API) и P2 (rate limit успешных логинов) закрыты, регрессий нет. Сборка готова к пушу.

- **Задача:** task-33 (постфикс v17 после task-32), production не изменялся.
- **Сборка:** SW `brodilka-v17`; `serve.js` + `server/store.js|auth.js|xlsx.js`; форма шлёт JSON на `/api/applications`; админка `/admin` (noindex, `ADMIN_PASSWORD`, cookie HttpOnly/SameSite=Strict, rate limit); XLSX на 13 колонок; `/data`, `/server`, `.git`, `.admin-password` закрыты.
- **Стенд:** **`PORT=4517 ADMIN_PASSWORD=qa-admin-password node serve.js`** (не статический харнесс); Node-fetch API + CDP-браузер (админка/PWA/кэш), XLSX проверен `openpyxl 3.1.5`.
- **Итог:** API/Auth — **37/37 pass**; живые сценарии против сервера (`form-nofile`, `v14-final`, `design-theme`, `pwa`, `pwa-fresh`, `mobile-reload`) — **213 проверок: 212 pass, 0 fail, 1 skip**; админка UI — **16/16 pass**; XLSX — **9/9 pass**. Кэш SW чист: `cachedAdminApi = []`.
- **Артефакты:** `artifacts/server-qa-results.json`, `artifacts/server-admin-qa-results.json`, `artifacts/xlsx-validation.json`, `artifacts/server-v17.log`, `artifacts/server-browser-v17.txt`. XLSX и скриншоты с тестовыми ПДн в поставку не входят.

## P1 — закрыт: админка и API больше не кэшируются

| | |
|---|---|
| **Было (v16)** | SW кэшировал `/admin`, `admin.css/js`, `/api/admin/state` (ПДн); после экспорта UI показывал count 34 и активную кнопку |
| **Фикс v17** | В fetch-обработчике SW: без перехвата для `/admin`, `/admin/`, `/admin.html`, `/admin.css`, `/admin.js` и всего `/api/` |
| **Проверка на свежем профиле** | SW `brodilka-v17` active; в Cache Storage **нет** `/admin`, `admin.*`, `/api/admin/*`, `/api/applications`; `cachedAdminApi = []`; `admin.not-cached-by-sw` и `admin.assets-not-cached` — PASS |
| **Экспорт через UI** | POST export → XLSX скачан; UI count **0**, слово «откликов», кнопка экспорта **disabled**; state=0; `data/applications.json` пуст — PASS |
| **Скриншот** | Админка после экспорта: count 0, кнопка disabled. Скриншот содержит тестовые ПДн и в поставку не входит. |

## P2 — закрыт: успешный логин сбрасывает счётчик

- 10 успешных логинов подряд с одного IP → все **200**, без 429 (`auth.success-login-no-429`).
- 6 неверных → успешный вход → ещё 6 неверных: 401×6, 200, 401×6 — без 429 (`auth.success-resets-failures`).
- Неверные пароли по-прежнему лимитируются: 8 попыток → 9-я **429** (`auth.rate-limit-login`).
- Причина: `auth.resetAttempt(ip)` после успешной проверки пароля.

## Что прошло

| Блок | Результат |
|---|---|
| API: валидная заявка → 201, тикет `HR-YY-NNNN`, запись в `data/applications.json` (все поля, birthDate/education, статус) | PASS |
| API: невалидные (пусто/будущая дата/1899/плохой email/короткий телефон/consent=false) → 400 с полями; кривой JSON → 400 | PASS |
| Rate limit заявок: 30/час на IP, 31-я → 429 (отдельный X-Forwarded-For) | PASS |
| `/admin` 200 + `X-Robots-Tag: noindex, nofollow` + meta robots; ссылок `/admin` из `index.html`/`app.js` нет | PASS |
| `/data/applications.json`, `/data/`, `/server/*`, `/.admin-password`, `/.git/config` → 404 | PASS |
| Auth: state/export без cookie → 401; неверный пароль → 401; cookie `HttpOnly; SameSite=Strict; Path=/`; logout `Max-Age=0`; лимит ошибок работает, успехи сбрасывают счётчик | PASS |
| Админка: count + слово по русским правилам, ровно 6 последних, только вход/выход/экспорт, без фильтров/редактирования/точечного удаления; мобильная вёрстка без hscroll | PASS |
| Excel: 200 + корректный MIME/имя; openpyxl — 1 лист «Отклики», 13 колонок, строки = 31+заголовок, кириллица/даты/тикеты; после экспорта count=0 в UI/state/на диске; пустой экспорт → 409 | PASS |
| Форма с сайта против сервера: успех, карточки в data, PDF; оба дизайна, 1440/390/360, все 3 маршрута | PASS |
| PWA v17: SW active, offline reload, manifest/installability, кэш без админки/API | PASS |

## Остаточные риски

1. **Хранилище:** JSON-файл без БД/шифрования; для продакшена нужна нормальная БД и политика хранения ПДн.
2. **Один процесс:** `Store` держит состояние в памяти; при нескольких инстансах/рестартах нужна общая БД.
3. **Excel:** XLSX собирается вручную без внешних библиотек — проверен openpyxl и значениями, сложное форматирование/формулы не поддерживаются.
4. **Новые записи во время экспорта:** удаляется только снимок `ids`, новые не должны удаляться; гонку детерминированно не воспроизводили — стоит покрыть тестом в проде.
5. **Ручные проверки:** установка PWA через UI, системный back-gesture, экранная клавиатура, VoiceOver/TalkBack.

## Скриншоты и файлы

Админка и XLSX проверялись на живом сервере. Скриншоты и выгрузка содержат тестовые персональные данные и в поставку не входят. Артефакты прогона: `artifacts/server-qa-results.json`, `artifacts/server-admin-qa-results.json`, `artifacts/xlsx-validation.json`, `artifacts/server-v17.log`, `artifacts/server-browser-v17.txt`.

## Как воспроизвести

```powershell
# 1) сервер (отдельный порт, не статический харнесс)
$env:PORT='4517'; $env:ADMIN_PASSWORD='qa-admin-password'; node serve.js

# 2) API/Auth seed
node qa-report/server-qa.js http://127.0.0.1:4517

# 3) живые сценарии против сервера
node qa-report/run-qa.js --url=http://127.0.0.1:4517 --scenario=form-nofile,v14-final,design-theme,pwa,pwa-fresh,mobile-reload

# 4) админка через браузер (UI, кэш SW, экспорт)
node qa-report/server-admin-qa.js http://127.0.0.1:4517

# 5) проверка XLSX
$env:PYTHONIOENCODING='utf-8'
& "C:\Users\alexa\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" qa-report/validate_xlsx.py
```

План: [test-plan.md](test-plan.md) — S34 + блок T1–T8.

## Вывод

Сбор откликов, авторизация, скрытая админка, 6 последних, XLSX на 13 колонок с удалением выгруженных и PWA v17 работают. P1 (кэш админки/API) и P2 (лимит успешных логинов) закрыты и перепроверены на свежем профиле: в Cache Storage нет админки/API, после экспорта UI показывает 0 и кнопка disabled, 10 успешных логинов проходят без 429, неверные по-прежнему лимитируются. **Verdict: PASS** — можно пушить.
