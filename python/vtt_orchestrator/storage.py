"""
Dual-Mode Persistence Layer (Wave 12)

PostgresStore (asyncpg) when DATABASE_URL is set and reachable;
MemoryStore otherwise — mirroring the graceful-degradation pattern of the
engine proxy so CI and benchmarks run without a database.
"""

import hashlib
import os
import secrets
import time
from typing import Any, Dict, List, Optional

try:
    import asyncpg
except ImportError:  # Memory-only deployments don't need the driver.
    asyncpg = None

DATABASE_URL = os.environ.get("DATABASE_URL", "")
PROBE_TIMEOUT_SECONDS = 2.0

# Mirrors database/postgres/03_campaign_persistence.sql; executed idempotently
# at startup because compose init scripts only run on first volume creation.
_ENSURE_DDL = """
CREATE SCHEMA IF NOT EXISTS narrative_state;

CREATE TABLE IF NOT EXISTS narrative_state.users (
    user_id            TEXT PRIMARY KEY,
    email              TEXT UNIQUE NOT NULL,
    username           TEXT NOT NULL,
    display_name       TEXT NOT NULL,
    role               TEXT NOT NULL DEFAULT 'player',
    password_hash      TEXT NOT NULL,
    salt_hex           TEXT NOT NULL,
    assigned_token_ids JSONB NOT NULL DEFAULT '[]',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS narrative_state.campaigns (
    campaign_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL REFERENCES narrative_state.users(user_id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS narrative_state.campaign_saves (
    save_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id   UUID REFERENCES narrative_state.campaigns(campaign_id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES narrative_state.users(user_id) ON DELETE CASCADE,
    save_name     TEXT NOT NULL,
    snapshot      JSONB NOT NULL,
    round_number  INT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_saves_owner_updated
    ON narrative_state.campaign_saves (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS narrative_state.engine_session_snapshots (
    session_id    UUID PRIMARY KEY,
    owner_user_id TEXT,
    snapshot      JSONB NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


# --- Credential helpers ------------------------------------------------------

def hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000).hex()


def new_salt() -> bytes:
    return secrets.token_bytes(16)


# --- Backends ----------------------------------------------------------------

class MemoryStore:
    """In-process fallback; shape-compatible with PostgresStore."""

    def __init__(self) -> None:
        self.users: Dict[str, Dict[str, Any]] = {}       # email.lower() -> record
        self.saves: Dict[str, Dict[str, Any]] = {}        # save_id -> record
        self.campaign_names: Dict[str, Dict[str, str]] = {}  # owner -> {name -> campaign_id}
        self.engine_snapshots: Dict[str, Dict[str, Any]] = {}  # session_id -> snapshot
        self._counter = 0

    @property
    def backend(self) -> str:
        return "memory"

    # -- users --

    async def create_user(self, email: str, username: str, display_name: str,
                          role: str, password: str, assigned_token_ids: List[str]) -> Dict[str, Any]:
        salt = new_salt()
        record = {
            "user_id": f"usr_{secrets.token_hex(6)}",
            "email": email.strip().lower(),
            "username": username,
            "display_name": display_name,
            "role": role,
            "salt_hex": salt.hex(),
            "password_hash": hash_password(password, salt),
            "assigned_token_ids": assigned_token_ids,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        self.users[record["email"]] = record
        return dict(record)

    async def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        return self.users.get(email.strip().lower())

    async def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        for record in self.users.values():
            if record["user_id"] == user_id:
                return record
        return None

    def verify_password(self, record: Dict[str, Any], password: str) -> bool:
        return hash_password(password, bytes.fromhex(record["salt_hex"])) == record["password_hash"]

    # -- campaign saves --

    async def upsert_campaign_save(self, owner_user_id: str, name: str,
                                   snapshot: Dict[str, Any], round_number: int) -> Dict[str, Any]:
        existing = next(
            (s for s in self.saves.values()
             if s["owner_user_id"] == owner_user_id and s["save_name"] == name),
            None,
        )
        if existing:
            existing["snapshot"] = snapshot
            existing["round_number"] = round_number
            existing["updated_at"] = time.time()
            return self._save_meta(existing)
        self._counter += 1
        save_id = f"save_{self._counter:08d}"
        record = {
            "save_id": save_id,
            "owner_user_id": owner_user_id,
            "save_name": name,
            "snapshot": snapshot,
            "round_number": round_number,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        self.saves[save_id] = record
        return self._save_meta(record)

    async def list_campaign_saves(self, owner_user_id: str) -> List[Dict[str, Any]]:
        rows = [s for s in self.saves.values() if s["owner_user_id"] == owner_user_id]
        rows.sort(key=lambda s: s["updated_at"], reverse=True)
        return [self._save_meta(s) for s in rows]

    async def get_campaign_save(self, owner_user_id: str, save_id: str) -> Optional[Dict[str, Any]]:
        record = self.saves.get(save_id)
        if record is None or record["owner_user_id"] != owner_user_id:
            return None
        return record

    async def delete_campaign_save(self, owner_user_id: str, save_id: str) -> bool:
        record = self.saves.get(save_id)
        if record is None or record["owner_user_id"] != owner_user_id:
            return False
        del self.saves[save_id]
        return True

    @staticmethod
    def _save_meta(record: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "save_id": record["save_id"],
            "save_name": record["save_name"],
            "round_number": record["round_number"],
            "updated_at": record["updated_at"],
        }

    # -- engine session snapshots (durability bridge to vtt-server) --

    async def save_engine_snapshot(self, session_id: str, owner_user_id: Optional[str],
                                   snapshot: Dict[str, Any]) -> None:
        self.engine_snapshots[session_id] = {
            "session_id": session_id,
            "owner_user_id": owner_user_id,
            "snapshot": snapshot,
            "updated_at": time.time(),
        }

    async def load_engine_snapshot(self, session_id: str) -> Optional[Dict[str, Any]]:
        record = self.engine_snapshots.get(session_id)
        return record["snapshot"] if record else None


class PostgresStore:
    """Durable backend backed by narrative_state.{users,campaign_saves}."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    @property
    def backend(self) -> str:
        return "postgres"

    # -- users --

    async def create_user(self, email: str, username: str, display_name: str,
                          role: str, password: str, assigned_token_ids: List[str]) -> Dict[str, Any]:
        salt = new_salt()
        row = await self.pool.fetchrow(
            """
            INSERT INTO narrative_state.users
                (user_id, email, username, display_name, role, password_hash, salt_hex, assigned_token_ids)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING user_id, email, username, display_name, role,
                      password_hash, salt_hex, assigned_token_ids, created_at
            """,
            f"usr_{secrets.token_hex(6)}",
            email.strip().lower(),
            username,
            display_name,
            role,
            hash_password(password, salt),
            salt.hex(),
            json_dumps(assigned_token_ids),
        )
        return dict(row)

    async def get_user_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        row = await self.pool.fetchrow(
            "SELECT * FROM narrative_state.users WHERE email = $1", email.strip().lower()
        )
        return dict(row) if row else None

    async def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        row = await self.pool.fetchrow(
            "SELECT * FROM narrative_state.users WHERE user_id = $1", user_id
        )
        return dict(row) if row else None

    def verify_password(self, record: Dict[str, Any], password: str) -> bool:
        return hash_password(password, bytes.fromhex(record["salt_hex"])) == record["password_hash"]

    # -- campaign saves --

    async def upsert_campaign_save(self, owner_user_id: str, name: str,
                                   snapshot: Dict[str, Any], round_number: int) -> Dict[str, Any]:
        campaign_id = await self._ensure_campaign(owner_user_id, name)
        # Upsert by (owner_user_id, save_name): update in place when present.
        row = await self.pool.fetchrow(
            """UPDATE narrative_state.campaign_saves
               SET snapshot = $3::jsonb, round_number = $4, updated_at = now()
               WHERE owner_user_id = $1 AND save_name = $2
               RETURNING save_id, save_name, round_number, updated_at""",
            owner_user_id, name, json_dumps(snapshot), round_number,
        )
        if row is None:
            row = await self.pool.fetchrow(
                """INSERT INTO narrative_state.campaign_saves
                       (campaign_id, owner_user_id, save_name, snapshot, round_number)
                   VALUES ($1, $2, $3, $4::jsonb, $5)
                   RETURNING save_id, save_name, round_number, updated_at""",
                campaign_id, owner_user_id, name, json_dumps(snapshot), round_number,
            )
        return {
            "save_id": str(row["save_id"]),
            "save_name": row["save_name"],
            "round_number": row["round_number"],
            "updated_at": str(row["updated_at"]),
        }

    async def _ensure_campaign(self, owner_user_id: str, name: str):
        row = await self.pool.fetchval(
            "SELECT campaign_id FROM narrative_state.campaigns WHERE owner_user_id = $1 LIMIT 1",
            owner_user_id,
        )
        if row:
            return row
        return await self.pool.fetchval(
            "INSERT INTO narrative_state.campaigns (owner_user_id, name) VALUES ($1, $2) RETURNING campaign_id",
            owner_user_id, name,
        )

    async def list_campaign_saves(self, owner_user_id: str) -> List[Dict[str, Any]]:
        rows = await self.pool.fetch(
            """SELECT save_id, save_name, round_number, updated_at
               FROM narrative_state.campaign_saves WHERE owner_user_id = $1
               ORDER BY updated_at DESC""",
            owner_user_id,
        )
        return [
            {"save_id": str(r["save_id"]), "save_name": r["save_name"],
             "round_number": r["round_number"], "updated_at": str(r["updated_at"])}
            for r in rows
        ]

    async def get_campaign_save(self, owner_user_id: str, save_id: str) -> Optional[Dict[str, Any]]:
        row = await self.pool.fetchrow(
            """SELECT save_id, save_name, round_number, snapshot
               FROM narrative_state.campaign_saves
               WHERE owner_user_id = $1 AND save_id = $2""",
            owner_user_id, save_id,
        )
        if row is None:
            return None
        return {
            "save_id": str(row["save_id"]),
            "save_name": row["save_name"],
            "round_number": row["round_number"],
            "snapshot": json.loads(row["snapshot"]),
        }

    async def delete_campaign_save(self, owner_user_id: str, save_id: str) -> bool:
        status = await self.pool.execute(
            "DELETE FROM narrative_state.campaign_saves WHERE owner_user_id = $1 AND save_id = $2",
            owner_user_id, save_id,
        )
        return status.endswith("1")

    # -- engine session snapshots (durability bridge to vtt-server) --

    async def save_engine_snapshot(self, session_id: str, owner_user_id: Optional[str],
                                   snapshot: Dict[str, Any]) -> None:
        await self.pool.execute(
            """INSERT INTO narrative_state.engine_session_snapshots
                   (session_id, owner_user_id, snapshot, updated_at)
               VALUES ($1, $2, $3::jsonb, now())
               ON CONFLICT (session_id)
               DO UPDATE SET snapshot = EXCLUDED.snapshot,
                             owner_user_id = EXCLUDED.owner_user_id,
                             updated_at = now()""",
            session_id, owner_user_id, json_dumps(snapshot),
        )

    async def load_engine_snapshot(self, session_id: str) -> Optional[Dict[str, Any]]:
        row = await self.pool.fetchrow(
            "SELECT snapshot FROM narrative_state.engine_session_snapshots WHERE session_id = $1",
            session_id,
        )
        if row is None:
            return None
        snap = row["snapshot"]
        if isinstance(snap, str):
            return json.loads(snap)
        return snap


def json_dumps(value: Any) -> str:
    import json

    return json.dumps(value)


import json  # noqa: E402  (used by helpers below)


def public_user(record: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize an internal user record (either backend) to the API shape."""
    tokens = record.get("assigned_token_ids", [])
    if isinstance(tokens, str):
        tokens = json.loads(tokens)
    return {
        "id": record["user_id"],
        "email": record["email"],
        "username": record["username"],
        "displayName": record["display_name"],
        "role": record["role"],
        "assignedTokenIds": tokens,
        "createdAt": str(record.get("created_at", "")),
    }


async def init_storage(database_url: str = DATABASE_URL) -> MemoryStore | PostgresStore:
    """Probe DATABASE_URL; fall back to MemoryStore when unset or unreachable."""
    if database_url:
        try:
            pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5,
                                             command_timeout=PROBE_TIMEOUT_SECONDS)
            async with pool.acquire() as conn:
                await conn.execute(_ENSURE_DDL)
            print("[Storage] Postgres persistence active.")
            return PostgresStore(pool)
        except Exception as exc:
            print(f"[Storage] DATABASE_URL unreachable ({exc}); using in-memory store.")
    return MemoryStore()
