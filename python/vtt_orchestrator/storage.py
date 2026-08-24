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

CREATE TABLE IF NOT EXISTS narrative_state.lobbies (
    lobby_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invite_code       VARCHAR(8) UNIQUE NOT NULL,
    name              TEXT NOT NULL,
    host_user_id      TEXT NOT NULL,
    engine_session_id UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS narrative_state.lobby_members (
    lobby_id     UUID REFERENCES narrative_state.lobbies(lobby_id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role         TEXT NOT NULL DEFAULT 'player',
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (lobby_id, user_id)
);

CREATE TABLE IF NOT EXISTS narrative_state.player_characters (
    character_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id   TEXT NOT NULL,
    name            TEXT NOT NULL,
    character_class TEXT NOT NULL DEFAULT 'fighter',
    level           INT  NOT NULL DEFAULT 1,
    data            JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_characters_owner
    ON narrative_state.player_characters (owner_user_id);

CREATE TABLE IF NOT EXISTS narrative_state.handouts (
    handout_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES narrative_state.campaigns(campaign_id) ON DELETE SET NULL,
    lobby_id    UUID REFERENCES narrative_state.lobbies(lobby_id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    content_md  TEXT NOT NULL DEFAULT '',
    revealed_to TEXT NOT NULL DEFAULT 'all'
                CHECK (revealed_to IN ('all', 'party', 'gm_only')),
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_handouts_campaign
    ON narrative_state.handouts (campaign_id, created_at DESC);
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
        self.lobbies: Dict[str, Dict[str, Any]] = {}           # lobby_id -> record
        self.characters: Dict[str, Dict[str, Any]] = {}        # character_id -> record
        self.handouts: Dict[str, Dict[str, Any]] = {}          # handout_id -> record
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

    async def create_lobby(self, host_user_id: str, host_display_name: str,
                           name: str, invite_code: str) -> Dict[str, Any]:
        lobby_id = f"lob_{secrets.token_hex(6)}"
        record = {
            "lobby_id": lobby_id,
            "invite_code": invite_code,
            "name": name,
            "host_user_id": host_user_id,
            "engine_session_id": None,
            "created_at": time.time(),
            "members": [{
                "user_id": host_user_id,
                "display_name": host_display_name,
                "role": "gm",
                "joined_at": time.time(),
            }],
        }
        self.lobbies[lobby_id] = record
        return self._lobby_public(record)

    async def join_lobby(self, lobby_id: str, user_id: str,
                         display_name: str, role: str) -> bool:
        record = self.lobbies.get(lobby_id)
        if record is None:
            return False
        for m in record["members"]:
            if m["user_id"] == user_id:
                return True  # idempotent rejoin
        record["members"].append({
            "user_id": user_id, "display_name": display_name,
            "role": role, "joined_at": time.time(),
        })
        return True

    async def get_lobby(self, lobby_id: str) -> Optional[Dict[str, Any]]:
        record = self.lobbies.get(lobby_id)
        return self._lobby_public(record) if record else None

    async def list_lobbies_for_user(self, user_id: str) -> List[Dict[str, Any]]:
        out = []
        for record in self.lobbies.values():
            if any(m["user_id"] == user_id for m in record["members"]):
                out.append(self._lobby_public(record))
        out.sort(key=lambda l: l["created_at"], reverse=True)
        return out

    async def set_lobby_session(self, lobby_id: str, engine_session_id: str) -> None:
        record = self.lobbies.get(lobby_id)
        if record is not None:
            record["engine_session_id"] = engine_session_id

    @staticmethod
    def _lobby_public(record: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "lobby_id": record["lobby_id"],
            "invite_code": record["invite_code"],
            "name": record["name"],
            "host_user_id": record["host_user_id"],
            "engine_session_id": record["engine_session_id"],
            "created_at": record["created_at"],
            "members": [
                {"user_id": m["user_id"], "display_name": m["display_name"], "role": m["role"]}
                for m in record["members"]
            ],
        }

    async def create_character(self, owner_user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        character_id = f"chr_{secrets.token_hex(6)}"
        record = {
            "character_id": character_id,
            "owner_user_id": owner_user_id,
            "name": payload["name"],
            "character_class": payload.get("character_class", "fighter"),
            "level": int(payload.get("level", 1)),
            "data": payload,
            "created_at": time.time(),
        }
        self.characters[record["character_id"]] = record
        return {k: v for k, v in record.items() if k != "data"}

    async def list_characters(self, owner_user_id: str) -> List[Dict[str, Any]]:
        rows = [c for c in self.characters.values() if c["owner_user_id"] == owner_user_id]
        return [{k: v for k, v in c.items() if k != "data"} for c in
                sorted(rows, key=lambda r: r["created_at"], reverse=True)]

    async def get_character(self, character_id: str) -> Optional[Dict[str, Any]]:
        return self.characters.get(character_id)

    async def delete_character(self, character_id: str, owner_user_id: str) -> bool:
        record = self.characters.get(character_id)
        if record is None or record["owner_user_id"] != owner_user_id:
            return False
        del self.characters[character_id]
        return True

    # -- handouts --

    async def create_handout(self, title: str, content_md: str, revealed_to: str,
                             created_by: str, campaign_id: Optional[str] = None,
                             lobby_id: Optional[str] = None) -> Dict[str, Any]:
        handout_id = f"hnd_{secrets.token_hex(6)}"
        record = {
            "handout_id": handout_id,
            "campaign_id": campaign_id,
            "lobby_id": lobby_id,
            "title": title,
            "content_md": content_md,
            "revealed_to": revealed_to,
            "created_by": created_by,
            "created_at": time.time(),
        }
        self.handouts[handout_id] = record
        return dict(record)

    async def list_handouts(self, campaign_id: Optional[str] = None,
                            visible_only_for_role: Optional[str] = None) -> List[Dict[str, Any]]:
        rows = [
            h for h in self.handouts.values()
            if campaign_id is None or h["campaign_id"] == campaign_id
        ]
        rows.sort(key=lambda h: h["created_at"], reverse=True)
        if visible_only_for_role is not None and visible_only_for_role not in ("gm", "admin"):
            rows = [h for h in rows if h["revealed_to"] in ("all", "party")]
        return [dict(h) for h in rows]

    async def get_handout(self, handout_id: str) -> Optional[Dict[str, Any]]:
        record = self.handouts.get(handout_id)
        return dict(record) if record else None

    async def update_handout(self, handout_id: str, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        record = self.handouts.get(handout_id)
        if record is None:
            return None
        record.update(fields)
        return dict(record)

    async def delete_handout(self, handout_id: str) -> bool:
        return self.handouts.pop(handout_id, None) is not None


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

    async def create_lobby(self, host_user_id: str, host_display_name: str,
                           name: str, invite_code: str) -> Dict[str, Any]:
        row = await self.pool.fetchrow(
            """INSERT INTO narrative_state.lobbies (invite_code, name, host_user_id)
               VALUES ($1, $2, $3)
               RETURNING lobby_id, invite_code, name, host_user_id,
                         engine_session_id, created_at""",
            invite_code, name, host_user_id,
        )
        await self.pool.execute(
            """INSERT INTO narrative_state.lobby_members (lobby_id, user_id, display_name, role)
               VALUES ($1, $2, $3, 'gm') ON CONFLICT DO NOTHING""",
            row["lobby_id"], host_user_id, host_display_name,
        )
        members = await self.pool.fetch(
            "SELECT user_id, display_name, role FROM narrative_state.lobby_members WHERE lobby_id = $1",
            row["lobby_id"],
        )
        return {
            "lobby_id": str(row["lobby_id"]),
            "invite_code": row["invite_code"],
            "name": row["name"],
            "host_user_id": row["host_user_id"],
            "engine_session_id": None,
            "created_at": str(row["created_at"]),
            "members": [dict(m) for m in members],
        }

    async def join_lobby(self, lobby_id: str, user_id: str,
                         display_name: str, role: str) -> bool:
        result = await self.pool.execute(
            """INSERT INTO narrative_state.lobby_members (lobby_id, user_id, display_name, role)
               VALUES ($1, $2, $3, $4) ON CONFLICT (lobby_id, user_id) DO NOTHING""",
            lobby_id, user_id, display_name, role,
        )
        return True  # idempotent; unknown lobby surfaces via get_lobby

    async def get_lobby(self, lobby_id: str) -> Optional[Dict[str, Any]]:
        try:
            row = await self.pool.fetchrow(
                """SELECT lobby_id, invite_code, name, host_user_id,
                          engine_session_id, created_at
                   FROM narrative_state.lobbies WHERE lobby_id = $1""",
                lobby_id,
            )
        except Exception:
            return None
        if row is None:
            return None
        members = await self.pool.fetch(
            "SELECT user_id, display_name, role FROM narrative_state.lobby_members WHERE lobby_id = $1",
            lobby_id,
        )
        return {
            "lobby_id": str(row["lobby_id"]),
            "invite_code": row["invite_code"],
            "name": row["name"],
            "host_user_id": row["host_user_id"],
            "engine_session_id": str(row["engine_session_id"]) if row["engine_session_id"] else None,
            "created_at": str(row["created_at"]),
            "members": [dict(m) for m in members],
        }

    async def list_lobbies_for_user(self, user_id: str) -> List[Dict[str, Any]]:
        rows = await self.pool.fetch(
            """SELECT l.lobby_id FROM narrative_state.lobbies l
               JOIN narrative_state.lobby_members m ON m.lobby_id = l.lobby_id
               WHERE m.user_id = $1 ORDER BY l.created_at DESC""",
            user_id,
        )
        out = []
        for r in rows:
            lobby = await self.get_lobby(str(r["lobby_id"]))
            if lobby:
                out.append(lobby)
        return out

    async def set_lobby_session(self, lobby_id: str, engine_session_id: str) -> None:
        await self.pool.execute(
            "UPDATE narrative_state.lobbies SET engine_session_id = $2 WHERE lobby_id = $1",
            lobby_id, engine_session_id,
        )

    async def create_character(self, owner_user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        row = await self.pool.fetchrow(
            """INSERT INTO narrative_state.player_characters
                   (owner_user_id, name, character_class, level, data)
               VALUES ($1, $2, $3, $4, $5::jsonb)
               RETURNING character_id, owner_user_id, name, character_class,
                         level, created_at""",
            owner_user_id, payload["name"],
            payload.get("character_class", "fighter"), int(payload.get("level", 1)),
            json_dumps(payload),
        )
        meta = dict(row)
        meta["character_id"] = str(meta["character_id"])
        return meta

    async def list_characters(self, owner_user_id: str) -> List[Dict[str, Any]]:
        rows = await self.pool.fetch(
            """SELECT character_id, owner_user_id, name, character_class, level, created_at
               FROM narrative_state.player_characters WHERE owner_user_id = $1
               ORDER BY created_at DESC""",
            owner_user_id,
        )
        out = []
        for r in rows:
            meta = dict(r)
            meta["character_id"] = str(meta["character_id"])
            out.append(meta)
        return out

    async def get_character(self, character_id: str) -> Optional[Dict[str, Any]]:
        row = await self.pool.fetchrow(
            """SELECT character_id, owner_user_id, name, character_class, level, data, created_at
               FROM narrative_state.player_characters WHERE character_id = $1""",
            character_id,
        )
        if row is None:
            return None
        record = dict(row)
        record["character_id"] = str(record["character_id"])
        data = record["data"]
        record["data"] = json.loads(data) if isinstance(data, str) else data
        return record

    async def delete_character(self, character_id: str, owner_user_id: str) -> bool:
        status = await self.pool.execute(
            "DELETE FROM narrative_state.player_characters WHERE character_id = $1 AND owner_user_id = $2",
            character_id, owner_user_id,
        )
        return status.endswith("1")

    # -- handouts --

    _HANDOUT_COLUMNS = """handout_id, campaign_id, lobby_id, title, content_md,
                          revealed_to, created_by, created_at"""

    @staticmethod
    def _handout_row(row: Any) -> Dict[str, Any]:
        record = dict(row)
        record["handout_id"] = str(record["handout_id"])
        for key in ("campaign_id", "lobby_id"):
            if record[key] is not None:
                record[key] = str(record[key])
        return record

    async def create_handout(self, title: str, content_md: str, revealed_to: str,
                             created_by: str, campaign_id: Optional[str] = None,
                             lobby_id: Optional[str] = None) -> Dict[str, Any]:
        row = await self.pool.fetchrow(
            f"""INSERT INTO narrative_state.handouts
                    (title, content_md, revealed_to, created_by, campaign_id, lobby_id)
                VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid)
                RETURNING {self._HANDOUT_COLUMNS}""",
            title, content_md, revealed_to, created_by, campaign_id, lobby_id,
        )
        return self._handout_row(row)

    async def list_handouts(self, campaign_id: Optional[str] = None,
                            visible_only_for_role: Optional[str] = None) -> List[Dict[str, Any]]:
        visibility = ""
        if visible_only_for_role is not None and visible_only_for_role not in ("gm", "admin"):
            visibility = "AND revealed_to IN ('all', 'party')"
        rows = await self.pool.fetch(
            f"""SELECT {self._HANDOUT_COLUMNS}
                FROM narrative_state.handouts
                WHERE (($1::uuid IS NULL) OR (campaign_id = $1::uuid)) {visibility}
                ORDER BY created_at DESC""",
            campaign_id,
        )
        return [self._handout_row(r) for r in rows]

    async def get_handout(self, handout_id: str) -> Optional[Dict[str, Any]]:
        try:
            row = await self.pool.fetchrow(
                f"SELECT {self._HANDOUT_COLUMNS} FROM narrative_state.handouts WHERE handout_id = $1",
                handout_id,
            )
        except Exception:
            return None
        return self._handout_row(row) if row else None

    async def update_handout(self, handout_id: str, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        # Only whitelisted columns can be patched; the route validates values.
        allowed = {"title", "content_md", "revealed_to", "campaign_id", "lobby_id"}
        sets, params = [], []
        for key in allowed & fields.keys():
            params.append(fields[key])
            if key in ("campaign_id", "lobby_id"):
                sets.append(f"{key} = ${len(params)}::uuid")
            else:
                sets.append(f"{key} = ${len(params)}")
        if not sets:
            row = await self.pool.fetchrow(
                f"""SELECT {self._HANDOUT_COLUMNS} FROM narrative_state.handouts
                    WHERE handout_id = $1""", handout_id)
            return self._handout_row(row) if row else None
        params.append(handout_id)
        row = await self.pool.fetchrow(
            f"""UPDATE narrative_state.handouts SET {', '.join(sets)}
                WHERE handout_id = ${len(params)}
                RETURNING {self._HANDOUT_COLUMNS}""",
            *params,
        )
        return self._handout_row(row) if row else None

    async def delete_handout(self, handout_id: str) -> bool:
        status = await self.pool.execute(
            "DELETE FROM narrative_state.handouts WHERE handout_id = $1",
            handout_id,
        )
        return status.endswith("1")


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
