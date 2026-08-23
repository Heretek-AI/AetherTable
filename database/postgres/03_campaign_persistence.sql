-- Wave 12: Campaign Persistence
-- Idempotent DDL for identity and campaign save/load. The orchestrator also
-- executes this at startup (storage.py::_ensure_tables) because the docker
-- compose init directory only runs on first volume creation.

CREATE SCHEMA IF NOT EXISTS narrative_state;

CREATE TABLE IF NOT EXISTS narrative_state.users (
    user_id            TEXT PRIMARY KEY,
    email              TEXT UNIQUE NOT NULL,
    username           TEXT NOT NULL,
    display_name       TEXT NOT NULL,
    role               TEXT NOT NULL DEFAULT 'player'
                       CHECK (role IN ('gm', 'player', 'spectator', 'admin')),
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
