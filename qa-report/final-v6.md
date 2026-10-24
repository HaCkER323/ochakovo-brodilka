# Финальная регрессия «БРОДИЛКА» — v18: быстрый отклик и навигация по диалогу

**Verdict: PASS** — «Заполнить без игры» с выбором направления, «Назад»/«К диалогу» и вся регрессия работают; открытых P0/P1/P2 нет. Сборка готова к пушу.

- **Задача:** task-34 (v18: быстрый отклик без игры + prev-beat/back-dialogue), production не изменялся.
- **Сборка:** SW `brodilka-v18`; лендинг `data-action="quick-apply"`; форма «Карточка стажёра» с `select#fieldRole` (3 направления, required); `prev-beat` с `disabled` на первой реплике; «К диалогу» из задания; Node API `/api/applications`; админка/XLSX без изменений.
- **Стенд:** **`PORT=4517 ADMIN_PASSWORD=qa-admin-password node serve.js`**; полный прогон 25 сценариев против сервера + API/auth + админка UI + XLSX (`openpyxl 3.1.5`).
- **Итог:** полный прогон — **770 проверок: 769 pass, 0 fail, 0 warn, 1 skip, 0 fatal**; `v18-final` — **32/32**; API/Auth — **38/38**; админка UI — **16/16**; XLSX — **9/9**. Skip — CDP display-mode (standalone отдельно).
- **Артефакты:** `artifacts/server-full-v18-final.txt`, `artifacts/server-qa-results.json`, `artifacts/server-admin-qa-results.json`, `artifacts/xlsx-validation.json`, `artifacts/server-v18.log`, `artifacts/downloads-admin/ochakovo-applications-2026-10-24.xlsx`, скриншоты `screens/2026-10-24T16-18-55/v18-final/`, `screens/server-admin/`.

## Быстрый отклик без игры

| Проверка | Результат |
|---|---|
| Кнопка «Заполнить без игры» на лендинге видна и кликабельна (desktop + 390/360, обе темы) | PASS |
| Открывается форма «Карточка стажёра» сразу, без квеста: eyebrow «Без мини-игры», заголовок «Сразу к делу», `data-quick="true"`, кнопка «На главную», нет панели вакансии | PASS |
| `select#fieldRole` с 3 направлениями, label с `*`, выбор меняется; `charId`/`vacancy` в заявке = выбранному (проверено: lab → «Лаборант контроля качества», тикет `HR-26-…`) | PASS |
| Пустая отправка → ошибки обязательных полей (ФИО/дата/телефон/email/consent); валидная → success «Карточка у HR», тикет, PDF скачался и валиден | PASS |
| Запись в `data/applications.json`: name/birthDate/education/phone/email/city/vacancy/charId/source/consent/ticket/createdAt/status | PASS (4 быстрых отклика в прогоне) |
| На мобиле 390/360 и в обеих темах — без горизонтального скролла, форма читаема | PASS |

## Навигация по диалогу

| Проверка | Результат |
|---|---|
| «Назад» (`prev-beat`) есть, на первой реплике **disabled**, после «Дальше» активна | PASS на 1440/390/360, brand и brodilka |
| «Назад» возвращает на предыдущую реплику, счётчик сообщений уменьшается, повторный «Дальше» снова ведёт вперёд | PASS |
| Кнопки «Назад»/«Дальше» не перекрываются (проверка bounding rect), нет hscroll | PASS |
| «К диалогу» из задания возвращает к последней реплике, «Назад» снова активна, этап/шаг не изменился | PASS |
| Прогресс не теряется: `step-meta` до задания и после возврата к диалогу совпадает | PASS |
| Клавиатура/тач: тач-таргеты ≥40 px, существующие keyboard/тач-сценарии без регрессий | PASS |

## Регрессия

| Блок | Результат |
|---|---|
| Форма/PDF: карточка, тикет, PDF с кириллицей, обе темы | PASS |
| Все 3 маршрута, reload/продолжение, звёзды, финал/splat/промокод | PASS |
| PWA v18: SW active, кэш v18, offline reload, manifest/installability, админка/API не кэшируются | PASS |
| Админка: вход/cookie/logout, count + 6 последних, экспорт XLSX с удалением, мобильная | PASS |
| API: 201/400/429, rate limit 30/час, скрытые `/data`/`/server`, noindex | PASS |
| XLSX: 1 лист «Отклики», 13 колонок, кириллица/даты/тикеты, после экспорта count=0 | PASS |
| Темы/вёрстка: 1440/390/360/landscape, reduced-motion, без hscroll/перекрытий | PASS |

## Остаточные риски

1. **Хранилище:** JSON-файл без БД/шифрования; для продакшена нужна БД и политика хранения ПДн.
2. **Один процесс:** `Store` держит состояние в памяти; для нескольких инстансов нужна общая БД.
3. **Excel:** XLSX собирается вручную; проверены значения/типы/кириллица, сложное форматирование не поддерживается.
4. **Быстрый отклик** не требует прохождения квеста — это осознанный сценарий, но стоит смотреть конверсию/качество лидов.
5. **Ручные проверки:** установка PWA через UI, системный back-gesture, экранная клавиатура, VoiceOver/TalkBack.

## Скриншоты и файлы

- [Быстрый отклик, brand 390](../preview/12-quick-apply.png)
- [Диалог с «Назад»/«Дальше», brand 1440](../preview/13-dialogue-back.png)
- Остальные скриншоты и XLSX содержат тестовые ПДн и в поставку не входят.
- Логи/результаты: `artifacts/server-full-v18-final.txt`, `server-qa-results.json`, `server-admin-qa-results.json`, `xlsx-validation.json`.

## Как воспроизвести

```powershell
$env:PORT='4517'; $env:ADMIN_PASSWORD='qa-admin-password'; node serve.js

node qa-report/server-qa.js http://127.0.0.1:4517
node qa-report/run-qa.js --url=http://127.0.0.1:4517
node qa-report/server-admin-qa.js http://127.0.0.1:4517
$env:PYTHONIOENCODING='utf-8'
& "C:\Users\alexa\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" qa-report/validate_xlsx.py
```

План: [test-plan.md](test-plan.md) — S35 + блок U1–U5.

## Вывод

Быстрый отклик без игры с выбором направления, кнопки «Назад»/«К диалогу» с сохранением прогресса, адаптив 1440/390/360 в обеих темах, форма/PDF, все 3 маршрута, PWA v18, админка/API и XLSX — работают. **Verdict: PASS**, открытых дефектов нет; можно пушить (с учётом демо-ограничений хранилища).
