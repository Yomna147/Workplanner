#!/usr/bin/env python3
"""
Convert Workplanner v1 phpMyAdmin dump to WP 2.0 SQL.

Usage:
  # Data-only import (requires existing schema from php artisan migrate):
  python convert_v1_sql_dump.py "path/to/WorkplannerMain.sql" database/workplanner_2_0_import.sql

  # Full standalone install for an empty MySQL server (creates DB + schema + data):
  python convert_v1_sql_dump.py "path/to/WorkplannerMain.sql" database/workplanner_2_0_full_install.sql --standalone
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
PASSWORD_HELPER = SCRIPT_DIR / "v1_password.php"
DEFAULT_SCHEMA_FILE = BACKEND_DIR / "database" / "workplanner_2_0_schema.sql"
DEFAULT_DATABASE_NAME = "workplanner_2_0"

SKIP_TABLES = {
    "migrations",
    "personal_access_tokens",
    "gantt",
    "task_assignments",
}

TABLE_RENAME = {
    "availabilities": "employee_availabilities",
    "nrm": "nrms",
    "subs": "project_tasks",
    "rolepermissions": "role_permissions",
    "user": "users",
}

PAGE_NAME_MAP = {
    "Home": "Dashboard",
    "Dashbored": "Dashboard",
    "ProjectDataEntry": "Project Data Entry",
    "ResourceHistogram": "Resource Histogram",
}

PAGE_ROUTE_MAP = {
    "Dashboard": "/",
    "Access Permissions": "/admin/access-permissions",
    "Activity Log": "/admin/activity-log",
    "Role": "/admin/roles",
    "Project Data Entry": "/projects",
    "Resource Histogram": "/resource-histogram",
    "User Availability": "/user-availability",
    "DL Input Hours": "/dl-input-hours",
    "Operatives Allocation": "/operatives-allocation",
}

IMPORT_ORDER = [
    "teams",
    "nrms",
    "roles",
    "pages",
    "employees",
    "employee_nrm",
    "projects",
    "parts",
    "project_tasks",
    "employee_availabilities",
    "role_permissions",
    "users",
]

UPDATE_RE = re.compile(
    r"^UPDATE `(?P<table>[^`]+)` SET (?P<set>.+?) WHERE `(?P<table2>[^`]+)`\.`id` = (?P<id>\d+);?\s*$"
)
INSERT_HEADER_RE = re.compile(
    r"^INSERT INTO `(?P<table>[^`]+)` \((?P<cols>.+?)\) VALUES\s*$",
    re.IGNORECASE,
)


def parse_sql_value(raw: str) -> Any:
    raw = raw.strip()
    if raw.upper() == "NULL":
        return None
    if raw.startswith("b'") and raw.endswith("'"):
        return 1 if raw[2:-1] == "1" else 0
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'").replace("\\'", "'")
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+\.\d+", raw):
        return float(raw)
    return raw


def parse_set_clause(set_clause: str) -> dict[str, Any]:
    pairs: dict[str, Any] = {}
    i = 0
    length = len(set_clause)
    while i < length:
        if set_clause[i] != "`":
            i += 1
            continue
        end = set_clause.find("`", i + 1)
        if end == -1:
            break
        key = set_clause[i + 1 : end]
        i = end + 1
        while i < length and set_clause[i] in " \t":
            i += 1
        if i >= length or set_clause[i] != "=":
            continue
        i += 1
        while i < length and set_clause[i] in " \t":
            i += 1
        if i >= length:
            break
        if set_clause[i] == "'":
            i += 1
            chars: list[str] = []
            while i < length:
                ch = set_clause[i]
                if ch == "\\" and i + 1 < length:
                    chars.append(set_clause[i + 1])
                    i += 2
                    continue
                if ch == "'":
                    if i + 1 < length and set_clause[i + 1] == "'":
                        chars.append("'")
                        i += 2
                        continue
                    i += 1
                    break
                chars.append(ch)
                i += 1
            pairs[key] = "".join(chars)
            continue
        if set_clause.startswith("b'", i):
            end_bit = set_clause.find("'", i + 2)
            pairs[key] = 1 if set_clause[i + 2 : end_bit] == "1" else 0
            i = end_bit + 1
            continue
        j = i
        while j < length and set_clause[j] not in ",":
            j += 1
        pairs[key] = parse_sql_value(set_clause[i:j])
        i = j
    return pairs


def parse_column_list(cols: str) -> list[str]:
    return [part.strip().strip("`") for part in cols.split(",") if part.strip()]


def parse_sql_tuple(raw: str) -> list[Any]:
    raw = raw.strip().rstrip(",;")
    if not raw.startswith("(") or not raw.endswith(")"):
        return []

    inner = raw[1:-1]
    values: list[Any] = []
    i = 0
    length = len(inner)

    while i < length:
        while i < length and inner[i] in " \t\n\r":
            i += 1
        if i >= length:
            break
        if inner[i] == ",":
            i += 1
            continue
        if inner.startswith("b'", i):
            end = inner.find("'", i + 2)
            if end == -1:
                break
            values.append(1 if inner[i + 2 : end] == "1" else 0)
            i = end + 1
            continue
        if inner[i] == "'":
            i += 1
            chars: list[str] = []
            while i < length:
                ch = inner[i]
                if ch == "\\" and i + 1 < length:
                    chars.append(inner[i + 1])
                    i += 2
                    continue
                if ch == "'":
                    if i + 1 < length and inner[i + 1] == "'":
                        chars.append("'")
                        i += 2
                        continue
                    i += 1
                    break
                chars.append(ch)
                i += 1
            values.append("".join(chars))
            continue
        if inner[i : i + 4].upper() == "NULL":
            values.append(None)
            i += 4
            continue
        j = i
        while j < length and inner[j] != ",":
            j += 1
        values.append(parse_sql_value(inner[i:j]))
        i = j

    return values


def finalize_tables(tables: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    if "pages" in tables:
        tables["pages"] = dedupe_pages(tables["pages"])
    if "role_permissions" in tables:
        tables["role_permissions"] = dedupe_role_permissions(tables["role_permissions"])
    if "employee_availabilities" in tables:
        tables["employee_availabilities"] = dedupe_employee_availabilities(
            tables["employee_availabilities"]
        )

    for table_name, rows in tables.items():
        rows.sort(key=lambda row: row["id"])

    return tables


def ingest_source_row(
    source_table: str,
    row: dict[str, Any],
    tables: dict[str, list[dict[str, Any]]],
    gantt_by_task: dict[int, str],
) -> None:
    if source_table == "gantt":
        task_id = row.get("task_id")
        employee = row.get("employee_name")
        if task_id and employee and int(task_id) not in gantt_by_task:
            gantt_by_task[int(task_id)] = str(employee)
        return

    if source_table in SKIP_TABLES:
        return

    target_table = TABLE_RENAME.get(source_table, source_table)
    transformed = transform_row(target_table, row, gantt_by_task, tables.get("nrms", []))
    if transformed is None:
        return
    tables.setdefault(target_table, []).append(transformed)


def find_matching_nrm_pri(task_name: Any, nrms: list[dict[str, Any]]) -> str | None:
    if not task_name:
        return None
    task_lower = str(task_name).lower()
    without_prefix = re.sub(r"^\d+\.?\d*\s*[-–—]\s*", "", task_lower, flags=re.I).strip()
    for nrm in nrms:
        sc = str(nrm.get("sc_name") or nrm.get("Sc_Name") or "").lower()
        name = str(nrm.get("name") or nrm.get("Name") or "").lower()
        pri = nrm.get("pri") if nrm.get("pri") is not None else nrm.get("Pri")
        if sc and (task_lower in sc or sc in task_lower or without_prefix in sc):
            return str(pri) if pri is not None else None
        if name and (without_prefix in name or name in without_prefix):
            return str(pri) if pri is not None else None
    return None


def normalize_imported_rap(rap: Any, task_name: Any, nrms: list[dict[str, Any]]) -> Any:
    rap_num = None
    if rap is not None and rap != "":
        try:
            rap_num = float(rap)
        except (TypeError, ValueError):
            rap_num = None
    if rap_num is not None and rap_num < 1.0:
        return rap
    from_nrm = find_matching_nrm_pri(task_name, nrms)
    return from_nrm if from_nrm is not None else rap


def recalculate_imported_pri(pp: Any, rap: Any, stored_pri: Any) -> Any:
    try:
        pp_f = float(pp or 0)
        rap_f = float(rap or 0)
    except (TypeError, ValueError):
        return stored_pri
    if pp_f == 0.0 and rap_f == 0.0:
        return stored_pri
    return str(round(pp_f + rap_f, 2))


def normalize_time(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    match = re.fullmatch(r"(\d{2}):(\d{2})(?::\d{2})?", value.strip())
    if not match:
        return value
    return f"{match.group(1)}:{match.group(2)}"


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("\\", "\\\\").replace("'", "''")
    return f"'{text}'"


@lru_cache(maxsize=256)
def convert_v1_password(encrypted: str) -> tuple[str | None, str | None]:
    if not encrypted:
        return None, None
    try:
        result = subprocess.run(
            ["php", str(PASSWORD_HELPER), encrypted],
            check=True,
            capture_output=True,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return encrypted, None

    bcrypt_hash = result.stdout.strip()
    try:
        payload = json.loads(bcrypt_hash)
        bcrypt_hash = payload.get("hash")
        plain = payload.get("plain")
    except json.JSONDecodeError:
        plain = None

    if not bcrypt_hash or not str(bcrypt_hash).startswith("$2y$"):
        return encrypted, None

    return str(bcrypt_hash), plain


def transform_row(
    table: str,
    row: dict[str, Any],
    gantt_by_task: dict[int, str],
    nrms: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    if table == "teams":
        return {
            "id": row["id"],
            "name": row["name"],
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "nrms":
        pri = row.get("Pri")
        return {
            "id": row["id"],
            "number": row.get("number"),
            "name": row.get("Name"),
            "sc_name": row.get("Sc_Name"),
            "pri": None if pri is None else str(pri),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "roles":
        return {
            "id": row["id"],
            "name": row["name"],
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "pages":
        name = PAGE_NAME_MAP.get(row.get("name"), row.get("name"))
        route = PAGE_ROUTE_MAP.get(name, row.get("route"))
        return {
            "id": row["id"],
            "name": name,
            "route": route,
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "employees":
        return {
            "id": row["id"],
            "first_name": row.get("first_name"),
            "last_name": row.get("last_name"),
            "email": row.get("email"),
            "position": row.get("position", 1),
            "team_id": row.get("team_id"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "employee_nrm":
        return {
            "id": row["id"],
            "employee_id": row["employee_id"],
            "nrm_id": row["nrm_id"],
            "OAP": row.get("OAP") or "",
            "performance_percentage": row.get("performance_percentage"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "projects":
        color = row.get("Color") or "#3B82F6"
        return {
            "id": row["id"],
            "name": row.get("ProjectName"),
            "color": color,
            "status": "active",
            "description": None,
            "team_id": None,
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "parts":
        return {
            "id": row["id"],
            "project_id": row.get("projects_id"),
            "name": row.get("PartName"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "project_tasks":
        task_id = row["id"]
        algorithm_1 = row.get("Algorithm_1") or ""
        algorithm_2 = row.get("Algorithm_2") or ""
        algorithm_3 = row.get("Algorithm_3") or ""
        if not algorithm_1 and task_id in gantt_by_task:
            algorithm_1 = gantt_by_task[task_id]

        def clean(value: Any) -> Any:
            if isinstance(value, str) and value.strip() == "":
                return None
            return value

        done = row.get("Done")
        if isinstance(done, str) and done.isdigit():
            done = int(done)

        pp = clean(row.get("PP"))
        rap = normalize_imported_rap(clean(row.get("RAP")), row.get("TaskName"), nrms or [])
        pri = recalculate_imported_pri(pp, rap, clean(row.get("Pri")))

        return {
            "id": task_id,
            "part_id": row.get("parts_id"),
            "task_name": clean(row.get("TaskName")),
            "est": clean(row.get("Est")),
            "hrs_per": clean(row.get("hrsPer")),
            "red": clean(row.get("Red")),
            "dl": clean(row.get("DL")),
            "rfi": clean(row.get("RFI")),
            "pd": clean(row.get("PD")),
            "buf": clean(row.get("Buf")),
            "adj": clean(row.get("Adj")),
            "plan": clean(row.get("Plan")),
            "doc_supply": clean(row.get("Doc_Supply")),
            "con": None,
            "completion": clean(row.get("Completion")),
            "pp": pp,
            "rap": rap,
            "pri": pri,
            "hbs": None,
            "ats": None,
            "ots": None,
            "dd": clean(row.get("DD")),
            "sp": clean(row.get("SP")),
            "ts": clean(row.get("TS")),
            "sh": clean(row.get("SH")),
            "al": clean(row.get("AL")),
            "algorithm_1": algorithm_1 or None,
            "algorithm_2": algorithm_2 or None,
            "algorithm_3": algorithm_3 or None,
            "override_1": clean(row.get("Override_1")),
            "override_2": clean(row.get("Override_2")),
            "override_3": clean(row.get("Override_3")),
            "dl_override_1": clean(row.get("DL_Override1")),
            "dl_override_2": clean(row.get("DL_Override2")),
            "dl_override_3": clean(row.get("DL_Override3")),
            "dl_dl": clean(row.get("DL_DL")),
            "dl_rfi": clean(row.get("DL_RFI")),
            "dl_con": clean(row.get("DL_C_per")),
            "dl_progress_updated": clean(row.get("DL_Updated")),
            "dl_progress_per": clean(row.get("DL_per")),
            "dl_done": clean(row.get("DL_Done")),
            "dl_owner": clean(row.get("DL_Owner")),
            "dl_project_completion_date": clean(row.get("DL_Project_Completion_Date")),
            "progress_updated": clean(row.get("Updated")),
            "progress_per": clean(row.get("C_per")),
            "progress_left_hours": clean(row.get("left_1")),
            "progress_plan": clean(row.get("Plan2")),
            "act": clean(row.get("Act")),
            "pre": clean(row.get("Pre")),
            "duration_left": clean(row.get("left_2")),
            "done": 1 if done in (1, True, "1") else 0,
            "owner": clean(row.get("Owner")),
            "project_completion_date": clean(row.get("Project_Completion_Date")),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "employee_availabilities":
        return {
            "id": row["id"],
            "date": row.get("date"),
            "strt1": row.get("strt1"),
            "end1": row.get("end1"),
            "strt2": row.get("strt2"),
            "end2": row.get("end2"),
            "strt3": row.get("strt3"),
            "end3": row.get("end3"),
            "strt4": row.get("strt4"),
            "end4": row.get("end4"),
            "total": normalize_time(row.get("Total") or "00:00"),
            "total_ava": normalize_time(row.get("total_ava") or "00:00"),
            "employee_id": row.get("employee_id"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "role_permissions":
        page = PAGE_NAME_MAP.get(row.get("page"), row.get("page"))
        return {
            "id": row["id"],
            "role_id": row.get("roleid"),
            "page": page,
            "permission": row.get("permission", 0),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    if table == "users":
        first = (row.get("firstname") or "").strip()
        last = (row.get("lastname") or "").strip()
        login = (row.get("loginname") or "").strip()
        display = " ".join(part for part in [first, last] if part).strip() or login
        email = f"{login.lower()}@workplanner.local" if login else None
        is_admin = row.get("superadmin") in (1, "1", True) or login.lower() == "admin"
        encrypted_password = row.get("password")
        bcrypt_password, plain_password = convert_v1_password(str(encrypted_password or ""))
        return {
            "id": row["id"],
            "name": display,
            "email": email,
            "email_verified_at": None,
            "password": bcrypt_password or encrypted_password,
            "password_plain": plain_password,
            "remember_token": None,
            "is_admin": 1 if is_admin else 0,
            "first_name": first or None,
            "last_name": last or None,
            "login_name": login or None,
            "active": 1 if row.get("active") in (1, "1", True, b"\x01") else 0,
            "role_id": row.get("roleid"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }

    return None


def dedupe_pages(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_name: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = row["name"]
        existing = by_name.get(name)
        if not existing:
            by_name[name] = row
            continue
        if row.get("route") and not existing.get("route"):
            by_name[name] = row
    merged = list(by_name.values())
    if not any(row["name"] == "Activity Log" for row in merged):
        merged.append(
            {
                "id": max((row["id"] for row in merged), default=0) + 1,
                "name": "Activity Log",
                "route": PAGE_ROUTE_MAP["Activity Log"],
                "created_at": None,
                "updated_at": None,
            }
        )
    return sorted(merged, key=lambda row: row["id"])


def dedupe_role_permissions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[int, str], dict[str, Any]] = {}
    for row in rows:
        key = (int(row["role_id"]), row["page"])
        existing = merged.get(key)
        if not existing or int(row.get("permission") or 0) > int(existing.get("permission") or 0):
            merged[key] = row
    return sorted(merged.values(), key=lambda row: (row["role_id"], row["page"], row["id"]))


def dedupe_employee_availabilities(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """WP 2.0 enforces unique (employee_id, date); v1 dump can contain duplicate keys."""
    merged: dict[tuple[int, str], dict[str, Any]] = {}
    for row in rows:
        key = (int(row["employee_id"]), str(row["date"]))
        existing = merged.get(key)
        if not existing or int(row["id"]) > int(existing["id"]):
            merged[key] = row
    return sorted(merged.values(), key=lambda row: row["id"])


def build_insert(table: str, rows: list[dict[str, Any]], batch_size: int = 300) -> str:
    if not rows:
        return ""
    columns = list(rows[0].keys())
    chunks: list[str] = []

    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        label = (
            f" (rows {start + 1}-{start + len(batch)})"
            if len(rows) > batch_size
            else ""
        )
        lines = [
            "--",
            f"-- Data for table `{table}`{label}",
            "--",
            f"INSERT INTO `{table}` (`{'`, `'.join(columns)}`) VALUES",
        ]
        value_lines = []
        for row in batch:
            values = ", ".join(sql_literal(row.get(col)) for col in columns)
            value_lines.append(f"({values})")
        lines.append(",\n".join(value_lines) + ";")
        chunks.append("\n".join(lines))

    return "\n\n".join(chunks)


def parse_dump(path: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[int, str]]:
    tables: dict[str, list[dict[str, Any]]] = {}
    gantt_by_task: dict[int, str] = {}

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = UPDATE_RE.match(line.strip())
        if not match:
            continue
        source_table = match.group("table")
        row = parse_set_clause(match.group("set"))
        row["id"] = int(match.group("id"))
        ingest_source_row(source_table, row, tables, gantt_by_task)

    return finalize_tables(tables), gantt_by_task


def parse_insert_dump(path: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[int, str]]:
    tables: dict[str, list[dict[str, Any]]] = {}
    gantt_by_task: dict[int, str] = {}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    i = 0

    while i < total:
        line = lines[i].strip()
        header_match = INSERT_HEADER_RE.match(line)
        if not header_match:
            i += 1
            continue

        source_table = header_match.group("table")
        columns = parse_column_list(header_match.group("cols"))
        i += 1

        while i < total:
            row_line = lines[i].strip()
            if row_line == "" or row_line.startswith("--"):
                i += 1
                continue
            if INSERT_HEADER_RE.match(row_line) or row_line.startswith("CREATE TABLE"):
                break
            if row_line.startswith("ALTER TABLE") or row_line.startswith("SET "):
                break

            values = parse_sql_tuple(row_line)
            if values and len(values) == len(columns):
                row = dict(zip(columns, values))
                if "id" in row and row["id"] is not None:
                    row["id"] = int(row["id"])
                ingest_source_row(source_table, row, tables, gantt_by_task)

            i += 1
            if row_line.endswith(";"):
                break

    return finalize_tables(tables), gantt_by_task


def load_source_dump(path: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[int, str]]:
    tables, gantt_by_task = parse_dump(path)
    if not any(tables.values()):
        tables, gantt_by_task = parse_insert_dump(path)
    return tables, gantt_by_task


def load_schema_sql(schema_path: Path) -> str:
    if not schema_path.exists():
        raise FileNotFoundError(
            f"Schema file not found: {schema_path}\n"
            "Run: php scripts/export_wp20_schema.php"
        )

    text = schema_path.read_text(encoding="utf-8").strip()
    return re.sub(r"\nSET FOREIGN_KEY_CHECKS=1;\s*$", "", text)


def render_migrations_seed() -> str:
    migrations_dir = BACKEND_DIR / "database" / "migrations"
    names = sorted(path.stem for path in migrations_dir.glob("*.php"))
    if not names:
        return ""

    values = [f"({index}, '{name}', 1)" for index, name in enumerate(names, start=1)]
    return (
        "/* Mark Laravel migrations as already applied */\n"
        "INSERT INTO `migrations` (`id`, `migration`, `batch`) VALUES\n"
        + ",\n".join(values)
        + ";\n"
    )


def render_data_header(tables: dict[str, list[dict[str, Any]]], gantt_by_task: dict[int, str]) -> list[str]:
    header = [
        "-- WP 2.0 data import (requires existing schema)",
        f"-- Target database: {DEFAULT_DATABASE_NAME}",
        "--",
        "-- Import steps:",
        "--   1. php artisan migrate   (creates empty WP 2.0 schema)",
        "--   2. php artisan db:import-wp-sql database/workplanner_2_0_import.sql --full",
        "--",
        "-- For a brand-new empty server database, use workplanner_2_0_full_install.sql instead.",
        "--",
        "-- Skipped v1 tables (not used by WP 2.0 schema):",
        "--   migrations, personal_access_tokens, gantt, task_assignments",
        f"-- Gantt rows used to back-fill algorithm_1 on tasks: {len(gantt_by_task)}",
        "-- User passwords converted from v1 AES to WP 2.0 bcrypt",
        "--",
    ]
    for table in IMPORT_ORDER:
        header.append(f"--   {table}: {len(tables.get(table, []))} rows")
    return header


def render_standalone_header(
    tables: dict[str, list[dict[str, Any]]],
    gantt_by_task: dict[int, str],
    database_name: str,
) -> list[str]:
    header = [
        "-- WP 2.0 full install for an empty MySQL server",
        f"-- Creates database `{database_name}`, all tables, and seed data",
        "--",
        "-- Import (phpMyAdmin / MySQL client):",
        f"--   Import this entire file into the server (no database selected is OK).",
        "--   Or: mysql -u root -p < workplanner_2_0_full_install.sql",
        "--",
        "-- After import:",
        "--   Set .env DB_DATABASE to match, run php artisan config:clear",
        "--   Do NOT run php artisan migrate (migrations are recorded as applied).",
        "--",
        "-- Skipped v1 tables:",
        "--   personal_access_tokens, gantt, task_assignments",
        f"-- Gantt rows used to back-fill algorithm_1 on tasks: {len(gantt_by_task)}",
        "-- User passwords converted from v1 AES to WP 2.0 bcrypt",
        "--",
    ]
    for table in IMPORT_ORDER:
        header.append(f"--   {table}: {len(tables.get(table, []))} rows")
    return header


def append_data_sections(
    chunks: list[str],
    tables: dict[str, list[dict[str, Any]]],
    *,
    include_migrations_seed: bool,
) -> None:
    for table in IMPORT_ORDER:
        rows = tables.get(table, [])
        insert = build_insert(table, rows)
        if insert:
            chunks.extend(["", insert])

    if include_migrations_seed:
        seed = render_migrations_seed()
        if seed:
            chunks.extend(["", seed.rstrip()])

    chunks.extend(["", "-- Restore auto-increment counters"])
    for table in IMPORT_ORDER:
        rows = tables.get(table, [])
        if rows:
            next_id = max(row["id"] for row in rows) + 1
            chunks.append(f"ALTER TABLE `{table}` AUTO_INCREMENT = {next_id};")


def render_data_sql(tables: dict[str, list[dict[str, Any]]], gantt_by_task: dict[int, str]) -> str:
    chunks = render_data_header(tables, gantt_by_task) + [
        "",
        "SET NAMES utf8mb4;",
        "SET FOREIGN_KEY_CHECKS=0;",
        "START TRANSACTION;",
        "",
        "/* Clear seeded/default rows before import */",
        "",
        "DELETE FROM `role_permissions`;",
        "DELETE FROM `users`;",
        "DELETE FROM `employee_availabilities`;",
        "DELETE FROM `project_tasks`;",
        "DELETE FROM `parts`;",
        "DELETE FROM `projects`;",
        "DELETE FROM `employee_nrm`;",
        "DELETE FROM `employees`;",
        "DELETE FROM `pages`;",
        "DELETE FROM `roles`;",
        "DELETE FROM `nrms`;",
        "DELETE FROM `teams`;",
        "",
    ]

    append_data_sections(chunks, tables, include_migrations_seed=False)
    chunks.extend(["", "SET FOREIGN_KEY_CHECKS=1;", "COMMIT;", ""])
    return "\n".join(chunks)


def render_standalone_sql(
    tables: dict[str, list[dict[str, Any]]],
    gantt_by_task: dict[int, str],
    *,
    database_name: str,
    schema_path: Path,
) -> str:
    schema_sql = load_schema_sql(schema_path)
    chunks = render_standalone_header(tables, gantt_by_task, database_name) + [
        "",
        "SET NAMES utf8mb4;",
        "SET FOREIGN_KEY_CHECKS=0;",
        "",
        f"CREATE DATABASE IF NOT EXISTS `{database_name}` "
        "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
        f"USE `{database_name}`;",
        "",
        "/* --- schema --- */",
        schema_sql,
        "",
        "START TRANSACTION;",
        "",
        "/* --- data --- */",
    ]

    append_data_sections(chunks, tables, include_migrations_seed=True)
    chunks.extend(["", "SET FOREIGN_KEY_CHECKS=1;", "COMMIT;", ""])
    return "\n".join(chunks)


def render_sql(tables: dict[str, list[dict[str, Any]]], gantt_by_task: dict[int, str]) -> str:
    return render_data_sql(tables, gantt_by_task)


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert Workplanner v1 dump to WP 2.0 SQL")
    parser.add_argument("source", type=Path, help="Path to WorkplannerMain.sql")
    parser.add_argument(
        "target",
        type=Path,
        nargs="?",
        help="Output SQL path (default depends on --standalone)",
    )
    parser.add_argument(
        "--standalone",
        action="store_true",
        help="Generate full install SQL (CREATE DATABASE + schema + data) for an empty server",
    )
    parser.add_argument(
        "--database",
        default=DEFAULT_DATABASE_NAME,
        help=f"Database name for standalone install (default: {DEFAULT_DATABASE_NAME})",
    )
    parser.add_argument(
        "--schema",
        type=Path,
        default=DEFAULT_SCHEMA_FILE,
        help="Path to WP 2.0 schema SQL used by --standalone",
    )
    args = parser.parse_args()

    source: Path = args.source
    if not source.exists():
        print(f"Source file not found: {source}")
        return 1

    target: Path = args.target or (
        BACKEND_DIR / "database" / (
            "workplanner_2_0_full_install.sql" if args.standalone else "workplanner_2_0_import.sql"
        )
    )

    tables, gantt_by_task = load_source_dump(source)
    if args.standalone:
        sql = render_standalone_sql(
            tables,
            gantt_by_task,
            database_name=args.database,
            schema_path=args.schema,
        )
    else:
        sql = render_data_sql(tables, gantt_by_task)

    target.write_text(sql, encoding="utf-8")

    print(f"Wrote {target}")
    print(f"  mode: {'standalone full install' if args.standalone else 'data-only import'}")
    if args.standalone:
        print(f"  database: {args.database}")
    for table in IMPORT_ORDER:
        print(f"  {table}: {len(tables.get(table, []))} rows")
    print(f"  gantt assignees applied: {len(gantt_by_task)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
