# Финальная регрессия «БРОДИЛКА» — v20: мобильный Пузырь, CTA, выбор персонажа

**Verdict: PASS** — P1 v19 (карточки персонажа не кликались) закрыт, выбор роли работает мышью и клавиатурой, регрессий нет. Сборка готова к пушу.

- **Задача:** task-36 (постфикс v20 после task-35), production не изменялся.
- **Сборка:** SW `brodilka-v20`; `mountApplyForm()` ищет `[data-quick-role]` через `document.querySelectorAll` (карточки вне формы теперь обрабатываются); лендинг/CTA/мобильный Пузырь — из v19.
- **Стенд:** **`PORT=4517 ADMIN_PASSWORD=qa-admin-password node serve.js`**; полный прогон 26 сценариев, API/auth, админка UI, XLSX (`openpyxl 3.1.5`).
- **Итог:** полный прогон — **796 проверок: 795 pass, 0 fail, 0 warn, 1 skip, 0 fatal**; `v19-final` — **26/26**; API/Auth — **38/38**; админка — **16/16**; XLSX — **9/9**. Skip — CDP display-mode (standalone отдельно).
- **Артефакты:** `artifacts/server-full-v20.txt`, `artifacts/server-qa-results.json`, `artifacts/server-admin-qa-results.json`, `artifacts/xlsx-validation.json`, `artifacts/server-v20.log`. Скриншоты и XLSX с тестовыми ПДн в поставку не входят.

## P1 — закрыт: выбор персонажа работает

| | |
|---|---|
| **Было (v19)** | Клик по «Даша»/«Лев» игнорировался: hidden `#fieldRole` оставался `brewer`, выделена первая карточка, в API/PDF/data уходил «Машинист оборудования». Причина — `form.querySelectorAll("[data-quick-role]")` возвращал пустой NodeList, т.к. карточки вне формы |
| **Фикс v20** | `mountApplyForm()`: `const roleButtons = document.querySelectorAll("[data-quick-role]")` (по документу); клик обновляет hidden, `is-selected`, `aria-checked`, `data-char` и announce |
| **Проверка кликов** | Клик «Даша» → hidden `packer`, выделена только она; клик «Лев» → hidden `lab`, выделена только она; `aria-checked` переезжает | ✅ PASS |
| **Клавиатура / radiogroup** | Контейнер `role="radiogroup"`, карточки `role="radio"`, ровно один `aria-checked="true"`; Tab фокусирует карточку, `:focus-visible` и outline видны; Enter выбирает роль, hidden/aria/selected обновляются | ✅ PASS |
| **Мобильные 390/360, обе темы** | Клик по второй карточке на 390 brand и 360 brodilka → hidden `packer`, выделена только она; без hscroll, форма ниже | ✅ PASS |
| **Отправка с выбранным** | Выбран «Лев» → success + PDF + запись в data: `charId: "lab"`, `vacancy: "Лаборант контроля качества"` (не brewer) | ✅ PASS |
| **Скриншот** | [После кликов выделен «Лев»](../preview/12-quick-apply.png); клавиатурный фокус проверен в прогоне |

## Что проверено

| Блок | Результат |
|---|---|
| Мобильный лендинг 390/360/landscape, brand и brodilka: нет hscroll; `.hero-guide-note` в потоке внутри `.hero-art`, не пересекает CTA/теги | PASS |
| CTA: «Начать смену-квест» (resume/all-done с «смену-квест»), «Перейти к вакансиям», видимое «или», без наложений | PASS |
| Быстрый отклик: 3 карточки с портретом/именем/ролью/`vacancy.about`; старого select нет; hidden `#fieldRole`; форма ниже; desktop 3 колонки, mobile 1 колонка | PASS |
| Выбор любой роли: hidden/стиль/aria, клавиатура, мобильные, обе темы; `charId`/`vacancy` в API/PDF/data | PASS |
| Регрессия: форма/PDF, диалоги/«Назад»/«К диалогу», 3 маршрута, финал/сплэш, PWA v20/offline, админка/API/XLSX | PASS |

## Остаточные риски

1. **Хранилище:** JSON-файл без БД/шифрования; для продакшена нужна БД и политика хранения ПДн.
2. **Один процесс:** `Store` в памяти; для нескольких инстансов нужна общая БД.
3. **Excel:** ручная сборка; проверены значения/типы/кириллица, сложное форматирование не поддерживается.
4. **Ручные проверки:** установка PWA через UI, back-gesture, экранная клавиатура, VoiceOver/TalkBack.

## Скриншоты и файлы

- [Лендинг, brand 1440](../preview/01-cover.png)
- [Мобильный лендинг, brand 390 (Пузырь в потоке)](../preview/06-mobile.png)
- [Карточки персонажей, выбран «Лев»](../preview/12-quick-apply.png)
- Остальные скриншоты, XLSX и админка содержат тестовые ПДн и в поставку не входят.
- Логи/результаты: `artifacts/server-full-v20.txt`, `server-qa-results.json`, `server-admin-qa-results.json`, `xlsx-validation.json`.

## Как воспроизвести

```powershell
$env:PORT='4517'; $env:ADMIN_PASSWORD='qa-admin-password'; node serve.js
node qa-report/server-qa.js http://127.0.0.1:4517
node qa-report/run-qa.js --url=http://127.0.0.1:4517
node qa-report/server-admin-qa.js http://127.0.0.1:4517
$env:PYTHONIOENCODING='utf-8'
& "C:\Users\alexa\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" qa-report/validate_xlsx.py
```

План: [test-plan.md](test-plan.md) — S36 + блок V1–V5 (v20: P1 закрыт).

## Вывод

Выбор персонажа на «Сразу к делу» исправлен: клики, клавиатура/radiogroup, мобильные 390/360 в обеих темах обновляют hidden `charId`, выделение и aria, а в API/PDF/data уходит выбранная вакансия. Мобильный лендинг, CTA, PWA v20, форма/PDF, диалоги, админка/API/XLSX — без регрессий. **Verdict: PASS** — можно пушить (с учётом демо-ограничений хранилища).
