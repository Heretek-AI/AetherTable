-- ============================================================================
-- PostgreSQL DDL for Transactional Event Sourcing & Session State (Phases 1, 5, 6)
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS narrative_state;

DO $$ BEGIN
    CREATE TYPE narrative_state.assertion_epistemic_tier AS ENUM (
        'SUBJECTIVE_RUMOR',
        'PROPOSED_FACT',
        'VALIDATED_CANON'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE narrative_state.assertion_status AS ENUM (
        'STAGED',
        'COMMITTED',
        'REJECTED_PARADOX',
        'SUPERSEDED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Active Game Sessions
CREATE TABLE IF NOT EXISTS narrative_state.sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL,
    session_name VARCHAR(128) NOT NULL,
    current_tick BIGINT NOT NULL DEFAULT 0,
    round_number INT NOT NULL DEFAULT 1,
    active_combat_state JSONB NOT NULL DEFAULT '{"in_combat": false, "initiative_order": [], "turn_index": 0}',
    environmental_tags TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Append-Only Event Sourcing Log
CREATE TABLE IF NOT EXISTS narrative_state.event_sourcing_log (
    sequence_id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES narrative_state.sessions(session_id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    state_hash VARCHAR(64) NOT NULL,
    is_reverted BOOLEAN NOT NULL DEFAULT FALSE,
    revert_reason TEXT,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Character & Entity Dynamic State
CREATE TABLE IF NOT EXISTS narrative_state.characters (
    character_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES narrative_state.sessions(session_id) ON DELETE CASCADE,
    compendium_entity_id VARCHAR(64) NOT NULL,
    owner_player_id VARCHAR(64),
    name VARCHAR(128) NOT NULL,
    current_hp INT NOT NULL,
    max_hp INT NOT NULL,
    temp_hp INT NOT NULL DEFAULT 0,
    ac INT NOT NULL,
    position_x FLOAT NOT NULL DEFAULT 0.0,
    position_y FLOAT NOT NULL DEFAULT 0.0,
    position_z FLOAT NOT NULL DEFAULT 0.0,
    zone_id VARCHAR(64) NOT NULL DEFAULT 'Zone_Default',
    spell_slots_remaining JSONB NOT NULL DEFAULT '{"1":4, "2":3, "3":2}',
    action_budget JSONB NOT NULL DEFAULT '{"action": true, "bonus_action": true, "reaction": true, "movement_remaining": 30.0, "free_interaction": true}',
    conditions TEXT[] NOT NULL DEFAULT '{}',
    is_conscious BOOLEAN NOT NULL DEFAULT TRUE,
    is_dead BOOLEAN NOT NULL DEFAULT FALSE,
    is_visible BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Nested Dynamic Inventory Supporting Container Hierarchy
CREATE TABLE IF NOT EXISTS narrative_state.inventories (
    inventory_entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id UUID NOT NULL REFERENCES narrative_state.characters(character_id) ON DELETE CASCADE,
    item_compendium_id VARCHAR(64) NOT NULL,
    parent_container_id UUID REFERENCES narrative_state.inventories(inventory_entry_id) ON DELETE CASCADE,
    quantity INT NOT NULL DEFAULT 1,
    is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
    is_attuned BOOLEAN NOT NULL DEFAULT FALSE,
    custom_state JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Epistemic Lore Assertions (Sanctioned Retcon Protocol)
CREATE TABLE IF NOT EXISTS narrative_state.lore_assertions (
    assertion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL,
    session_id UUID NOT NULL REFERENCES narrative_state.sessions(session_id) ON DELETE CASCADE,
    proposing_entity_id VARCHAR(64) NOT NULL,
    subject_node_id VARCHAR(128) NOT NULL,
    predicate_relation VARCHAR(64) NOT NULL,
    object_node_id VARCHAR(128) NOT NULL,
    epistemic_tier narrative_state.assertion_epistemic_tier NOT NULL DEFAULT 'SUBJECTIVE_RUMOR',
    status narrative_state.assertion_status NOT NULL DEFAULT 'STAGED',
    confidence_score NUMERIC(3, 2) CHECK (confidence_score BETWEEN 0.00 AND 1.00),
    assertion_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resolved_at TIMESTAMPTZ
);

-- Safety & X-Card Auditing Ledger
CREATE TABLE IF NOT EXISTS narrative_state.safety_audit_log (
    incident_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES narrative_state.sessions(session_id) ON DELETE CASCADE,
    trigger_type VARCHAR(32) NOT NULL, -- 'X_CARD', 'FAST_FORWARD', 'REWIND', 'VEIL'
    triggered_by_player VARCHAR(64) NOT NULL,
    topic_tag VARCHAR(64),
    target_sequence_id_rewind BIGINT REFERENCES narrative_state.event_sourcing_log(sequence_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Performance Indices
CREATE INDEX IF NOT EXISTS idx_assertions_lookup ON narrative_state.lore_assertions (campaign_id, subject_node_id, status);
CREATE INDEX IF NOT EXISTS idx_event_sourcing_session ON narrative_state.event_sourcing_log (session_id, sequence_id);
CREATE INDEX IF NOT EXISTS idx_characters_session ON narrative_state.characters (session_id);
CREATE INDEX IF NOT EXISTS idx_inventory_char ON narrative_state.inventories (character_id, parent_container_id);
