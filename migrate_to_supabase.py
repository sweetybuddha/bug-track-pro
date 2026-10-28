
"""
BugTrack Pro: migrate JSON + SQLite data to Supabase Postgres.

Run from the project root:
    pip install supabase
    python migrate_to_supabase.py

Required environment variables:
    SUPABASE_URL
    SUPABASE_SECRET_KEY

Back up your source files before running this script.
This copies data; it does not change your application's database connection.
"""
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent

# Load .env strictly from the project root without overriding explicitly passed env vars
load_dotenv(ROOT / ".env", override=False)

JSON_PATH = Path(
    os.environ.get("BUGTRACK_JSON_PATH", ROOT / "bugtrack.json")
)
SQLITE_PATH = Path(
    os.environ.get(
        "BUGTRACK_SQLITE_PATH",
        ROOT / "backend" / "data" / "analyzer.sqlite3",
    )
)

BATCH_SIZE = 100


def env_required(name: str) -> str:
    value = os.getenv(name)
    if not value or not value.strip():
        raise RuntimeError(
            f"Missing or empty environment variable: {name}. "
            "Check the .env file in the project root."
        )
    return value.strip()


def create_supabase_client():
    supabase_url = env_required("SUPABASE_URL")
    supabase_key = env_required("SUPABASE_SECRET_KEY")

    if supabase_key.startswith("sb_publishable_"):
        raise RuntimeError(
            "SUPABASE_SECRET_KEY is configured with a publishable key ('sb_publishable_...'). "
            "The migration requires an authorized server-side secret/service-role key with "
            "write permissions to bypass RLS."
        )

    return create_client(supabase_url, supabase_key)


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(
            f"Source JSON file not found: {path}\n"
            "Set BUGTRACK_JSON_PATH if your file is elsewhere."
        )

    with path.open("r", encoding="utf-8") as file:
        data = json.load(file)

    if not isinstance(data, dict):
        raise ValueError(
            "The source JSON must contain a JSON object."
        )

    return data


def batches(items, size=BATCH_SIZE):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def upsert_rows(client, table, rows, conflict="id", max_retries=3):
    if not rows:
        print(f"{table}: nothing to import")
        return

    import time
    total = 0

    for batch in batches(rows):
        last_error = None
        for attempt in range(1, max_retries + 1):
            try:
                (
                    client.table(table)
                    .upsert(batch, on_conflict=conflict)
                    .execute()
                )
                total += len(batch)
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                message = str(exc)

                if "42501" in message or "row-level security" in message.lower():
                    raise RuntimeError(
                        f"RLS blocked the migration into '{table}'. "
                        "Check that SUPABASE_SECRET_KEY contains the "
                        "correct server-side secret/service-role key, "
                        "that it belongs to this Supabase project, "
                        "and that the database permissions are correct. "
                        "Do not create a public INSERT policy to bypass this."
                    ) from exc

                if attempt < max_retries:
                    time.sleep(1.0)
                    continue

        if last_error:
            raise RuntimeError(
                f"Failed importing table '{table}': {last_error}"
            ) from last_error

        print(
            f"{table}: imported batch of {len(batch)} rows"
        )

    print(f"{table}: total imported/upserted {total} rows")


def json_obj(value: Any) -> Any:
    if value is None:
        return None

    if isinstance(value, (dict, list, int, float, bool)):
        return value

    if not isinstance(value, str):
        return value

    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {"raw": value}


def main():
    # Migration has been decommissioned. BugTrack Pro is configured to start with a fresh database.
    # Source files (bugtrack.json and backend/data/analyzer.sqlite3) are preserved as local backups.
    if os.getenv("ALLOW_MIGRATION", "").lower() not in ("true", "1", "yes"):
        print("Migration workflow is disabled.")
        print("BugTrack Pro is configured to start with a fresh database.")
        print("Old records are preserved as backups in 'bugtrack.json' and 'backend/data/analyzer.sqlite3'.")
        print("No migration actions were executed.")
        return

    # 1. Connect to Supabase.
    client = create_supabase_client()
    print("Supabase client initialized.")


    # 2. Read source JSON.
    source = read_json(JSON_PATH)

    users = source.get("users") or []
    bugs = source.get("bugs") or []
    comments = source.get("comments") or []
    activity = source.get("activity") or []
    test_cases = source.get("test_cases") or []
    json_analyses = source.get("analyses") or []

    print(f"Source JSON: {JSON_PATH}")
    print(f"Users: {len(users)}")
    print(f"Bugs: {len(bugs)}")
    print(f"Comments: {len(comments)}")

    # 3. Migrate profiles first.
    profiles = []
    known_user_ids = set()

    for user in users:
        if not isinstance(user, dict):
            continue

        email = str(user.get("email") or "").strip().lower()

        if not email:
            print("Skipping a profile without an email.")
            continue

        user_id = str(user.get("id") or "").strip()

        if not user_id:
            user_id = (
                "usr_"
                + hashlib.sha256(
                    email.encode("utf-8")
                ).hexdigest()[:24]
            )

        known_user_ids.add(user_id)

        reserved = {
            "id",
            "name",
            "email",
            "role",
            "passwordHash",
            "password_hash",
            "emailVerified",
            "email_verified",
            "createdAt",
            "created_at",
            "passwordResetTokenHash",
            "passwordResetExpiresAt",
            "passwordResetToken",
            "verificationToken",
            "verificationTokenHash",
        }

        extra = {
            key: value
            for key, value in user.items()
            if key not in reserved
        }

        profiles.append({
            "id": user_id,
            "name": str(user.get("name") or email),
            "email": email,
            "password_hash": (
                user.get("passwordHash")
                or user.get("password_hash")
            ),
            "email_verified": bool(
                user.get(
                    "emailVerified",
                    user.get("email_verified", False),
                )
            ),
            "created_at": (
                user.get("createdAt")
                or user.get("created_at")
            ),
            "role": user.get("role"),
            "extra_data": extra,
        })

    upsert_rows(client, "profiles", profiles)

    def valid_user_id(value):
        if value is None:
            return None

        candidate = str(value)

        if candidate in known_user_ids:
            return candidate

        return None

    # 4. Migrate bugs.
    bug_rows = []
    valid_bug_ids = set()

    for item in bugs:
        if not isinstance(item, dict):
            continue

        if not item.get("title") or item.get("id") is None:
            continue

        bug_id = int(item["id"])
        valid_bug_ids.add(bug_id)

        bug_rows.append({
            "id": bug_id,
            "user_id": valid_user_id(item.get("user_id")),
            "bug_key": item.get("bug_key"),
            "title": str(item["title"]),
            "description": item.get("description"),
            "module": item.get("module"),
            "severity": item.get("severity"),
            "priority": item.get("priority"),
            "status": item.get("status") or "Open",
            "assignee": item.get("assignee"),
            "details": item,
            "created_at": item.get("created_at"),
            "updated_at": (
                item.get("updated_at")
                or item.get("created_at")
            ),
        })

    upsert_rows(client, "bugs", bug_rows)

    # 5. Migrate comments.
    comment_rows = []

    for item in comments:
        if not isinstance(item, dict):
            continue

        if not item.get("body") or item.get("id") is None:
            continue

        bug_id = item.get("bug_id")

        if (
            bug_id is not None
            and int(bug_id) not in valid_bug_ids
        ):
            print(
                f"Skipping comment {item['id']}: "
                "its bug was not imported."
            )
            continue

        comment_rows.append({
            "id": int(item["id"]),
            "bug_id": (
                int(bug_id) if bug_id is not None else None
            ),
            "user_id": valid_user_id(item.get("user_id")),
            "author": item.get("author"),
            "body": str(item["body"]),
            "created_at": item.get("created_at"),
            "details": item,
        })

    upsert_rows(client, "comments", comment_rows)

    # 6. Migrate activity.
    activity_rows = []
    seen_activity_ids = set()
    max_activity_id = max(
        (int(item["id"]) for item in activity if isinstance(item, dict) and item.get("id") is not None),
        default=0,
    )

    for item in activity:
        if not isinstance(item, dict) or item.get("id") is None:
            continue

        bug_id = item.get("bug_id")

        if (
            bug_id is not None
            and int(bug_id) not in valid_bug_ids
        ):
            print(
                f"Skipping activity {item['id']}: "
                "its bug was not imported."
            )
            continue

        act_id = int(item["id"])
        if act_id in seen_activity_ids:
            max_activity_id += 1
            print(
                f"Reassigning duplicate activity ID {act_id} -> {max_activity_id}"
            )
            act_id = max_activity_id
        seen_activity_ids.add(act_id)

        activity_rows.append({
            "id": act_id,
            "bug_id": (
                int(bug_id) if bug_id is not None else None
            ),
            "user_id": valid_user_id(item.get("user_id")),
            "type": item.get("type"),
            "message": item.get("message"),
            "actor": item.get("actor"),
            "created_at": item.get("created_at"),
            "details": item,
        })

    upsert_rows(client, "activity", activity_rows)

    # 7. Migrate test cases.
    test_rows = []
    seen_test_ids = set()
    seen_case_keys = set()
    max_test_id = max(
        (int(item["id"]) for item in test_cases if isinstance(item, dict) and item.get("id") is not None),
        default=0,
    )

    for item in test_cases:
        if not isinstance(item, dict):
            continue

        if not item.get("title") or item.get("id") is None:
            continue

        case_key = item.get("case_key")
        if case_key and case_key in seen_case_keys:
            print(f"Skipping test case with duplicate case_key: {case_key}")
            continue
        if case_key:
            seen_case_keys.add(case_key)

        test_id = int(item["id"])
        if test_id in seen_test_ids:
            max_test_id += 1
            print(
                f"Reassigning duplicate test_case ID {test_id} -> {max_test_id} (case_key={case_key})"
            )
            test_id = max_test_id
        seen_test_ids.add(test_id)

        test_rows.append({
            "id": test_id,
            "user_id": valid_user_id(item.get("user_id")),
            "case_key": case_key,
            "title": str(item["title"]),
            "details": item,
            "created_at": item.get("created_at"),
            "updated_at": (
                item.get("updated_at")
                or item.get("created_at")
            ),
        })

    upsert_rows(client, "test_cases", test_rows)

    # 8. Combine JSON analyses and SQLite analyses.
    analysis_by_id = {}

    for item in json_analyses:
        if not isinstance(item, dict) or not item.get("id"):
            continue

        analysis_id = str(item["id"])

        analysis_by_id[analysis_id] = {
            "id": analysis_id,
            "user_id": valid_user_id(item.get("user_id")),
            "language": item.get("language") or "Unknown",
            "status": item.get("status") or "Imported",
            "report": item,
            "result": item,
            "details": item,
            "created_at": item.get("created_at"),
        }

    fix_rows = []

    if SQLITE_PATH.is_file():
        with sqlite3.connect(SQLITE_PATH) as conn:
            conn.row_factory = sqlite3.Row

            tables = {
                row["name"]
                for row in conn.execute(
                    """
                    SELECT name
                    FROM sqlite_master
                    WHERE type = 'table'
                    """
                ).fetchall()
            }

            if "analyses" in tables:
                for row in conn.execute(
                    "SELECT * FROM analyses"
                ).fetchall():
                    record = dict(row)
                    analysis_id = str(record["id"])

                    input_summary = json_obj(
                        record.get("input_summary")
                    )
                    result = json_obj(
                        record.get("result_json")
                    )

                    prior = analysis_by_id.get(
                        analysis_id, {}
                    )

                    analysis_by_id[analysis_id] = {
                        "id": analysis_id,
                        "user_id": prior.get("user_id"),
                        "language": (
                            record.get("language")
                            or prior.get("language")
                            or "Unknown"
                        ),
                        "status": (
                            record.get("status")
                            or prior.get("status")
                            or "Imported"
                        ),
                        "report": input_summary,
                        "result": result,
                        "details": record,
                        "created_at": (
                            record.get("created_at")
                            or prior.get("created_at")
                        ),
                    }

            if "fixes" in tables:
                for row in conn.execute(
                    "SELECT * FROM fixes"
                ).fetchall():
                    record = dict(row)

                    fix_rows.append({
                        "id": str(record["id"]),
                        "analysis_id": str(
                            record["analysis_id"]
                        ),
                        "details": record,
                        "created_at": record.get("created_at"),
                    })

    else:
        print(
            f"SQLite file not found: {SQLITE_PATH}. "
            "Skipping SQLite import."
        )

    analysis_rows = list(analysis_by_id.values())
    upsert_rows(client, "analyses", analysis_rows)

    # 9. Import fixes only when their parent analysis is present.
    analysis_ids = {
        row["id"] for row in analysis_rows
    }

    fix_rows = [
        row for row in fix_rows
        if row["analysis_id"] in analysis_ids
    ]

    upsert_rows(client, "fixes", fix_rows)

    print("\nMigration script finished.")
    print("Verify row counts in Supabase before removing any source data.")
    print(
        "Note: your application must be configured separately "
        "to use Supabase after migration."
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nMIGRATION FAILED: {exc}", file=sys.stderr)
        print(
            "No source files were deleted. Check the error, "
            "Supabase credentials, table schema, and policies.",
            file=sys.stderr,
        )
        sys.exit(1)
