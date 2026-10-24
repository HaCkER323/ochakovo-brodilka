"""validate_xlsx.py — проверка XLSX-выгрузки откликов openpyxl."""
import json
import os
import sys

from openpyxl import load_workbook

QA_DIR = os.path.dirname(os.path.abspath(__file__))
meta_path = os.path.join(QA_DIR, "artifacts", "server-admin-qa-results.json")
with open(meta_path, "r", encoding="utf-8") as handle:
    meta = json.load(handle)

xlsx = meta.get("xlsxFile")
expected_rows = int(meta.get("countBeforeExport") or 0)
checks = []


def record(name, ok, details=None):
    checks.append({"id": name, "status": "pass" if ok else "fail", "details": details})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else " " + json.dumps(details, ensure_ascii=False)[:500]))


print("[xlsx] " + str(xlsx))
if not xlsx or not os.path.isfile(xlsx):
    record("xlsx.file", False, {"path": xlsx})
else:
    record("xlsx.file", True, os.path.basename(xlsx))
    wb = load_workbook(xlsx, data_only=True)
    record("xlsx.single-sheet", len(wb.sheetnames) == 1 and wb.sheetnames[0] == "Отклики", wb.sheetnames)
    ws = wb[wb.sheetnames[0]]
    headers = [cell.value for cell in ws[1]]
    expected_headers = [
        "№", "Дата отклика", "ФИО", "Дата рождения", "Телефон", "Email", "Город",
        "ВУЗ / колледж", "Вакансия", "Номер карточки", "Резюме", "Согласие", "Статус",
    ]
    record("xlsx.headers-13", headers == expected_headers, headers)
    record("xlsx.rows", ws.max_row == expected_rows + 1, {"max_row": ws.max_row, "expected": expected_rows + 1})
    record("xlsx.cyrillic", "Иванов" in str(ws.cell(row=2, column=3).value or "") or "Rate" in str(ws.cell(row=2, column=3).value or ""), ws.cell(row=2, column=3).value)
    sample = [str(ws.cell(row=2, column=column).value or "") for column in range(1, 14)]
    record("xlsx.values-filled", all(sample[index] for index in [0, 1, 2, 3, 4, 5, 8, 9]), sample)
    record("xlsx.birthdate-format", "/" in sample[3] or "." in sample[3], sample[3])
    record("xlsx.consent-status", sample[11] in ("да", "нет") and bool(sample[12]), {"consent": sample[11], "status": sample[12]})
    # Тикеты и вакансии
    tickets = [ws.cell(row=row, column=10).value for row in range(2, ws.max_row + 1)]
    record("xlsx.tickets", all(t and str(t).startswith("HR-") for t in tickets), tickets[:3])

out = os.path.join(QA_DIR, "artifacts", "xlsx-validation.json")
with open(out, "w", encoding="utf-8") as handle:
    json.dump({"file": xlsx, "checks": checks}, handle, ensure_ascii=False, indent=2)
failed = [item for item in checks if item["status"] != "pass"]
print(f"\n[xlsx] checks={len(checks)} pass={len(checks) - len(failed)} fail={len(failed)}")
sys.exit(1 if failed else 0)
