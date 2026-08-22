-- ============================================================================
-- PostgreSQL DDL for Immutable Compendium & Static Assets (Phase 1 & Phase 3)
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS compendium;

-- Entity Category Enumeration
DO $$ BEGIN
    CREATE TYPE compendium.entity_type AS ENUM (
        'tile', 'blueprint', 'monster', 'spell', 'equipment', 'condition', 'class_feature', 'class'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Master Compendium Registry
CREATE TABLE IF NOT EXISTS compendium.entities (
    entity_id VARCHAR(64) PRIMARY KEY,
    entity_type compendium.entity_type NOT NULL,
    system_identifier VARCHAR(32) NOT NULL DEFAULT 'dnd_5e_srd',
    name VARCHAR(128) NOT NULL,
    version VARCHAR(16) NOT NULL DEFAULT '1.0.0',
    properties JSONB NOT NULL,
    search_vector TSVECTOR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- WFC Tile Definitions
CREATE TABLE IF NOT EXISTS compendium.wfc_tiles (
    tile_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity_id) ON DELETE CASCADE,
    socket_north VARCHAR(32) NOT NULL,
    socket_east VARCHAR(32) NOT NULL,
    socket_south VARCHAR(32) NOT NULL,
    socket_west VARCHAR(32) NOT NULL,
    socket_top VARCHAR(32) DEFAULT 'solid',
    socket_bottom VARCHAR(32) DEFAULT 'solid',
    symmetry_type VARCHAR(16) NOT NULL CHECK (symmetry_type IN ('X', 'I', 'L', 'T', '\\', 'F')),
    weight FLOAT NOT NULL DEFAULT 1.0,
    movement_cost_modifier NUMERIC(3,2) NOT NULL DEFAULT 1.00,
    blocks_line_of_sight BOOLEAN NOT NULL DEFAULT FALSE,
    is_door BOOLEAN NOT NULL DEFAULT FALSE,
    tags TEXT[] NOT NULL DEFAULT '{}'
);

-- Monster Archetypes
CREATE TABLE IF NOT EXISTS compendium.monsters (
    monster_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity_id) ON DELETE CASCADE,
    challenge_rating NUMERIC(4,2) NOT NULL,
    size_category VARCHAR(16) NOT NULL,
    creature_type VARCHAR(32) NOT NULL,
    alignment VARCHAR(32) NOT NULL DEFAULT 'unaligned',
    base_ac INT NOT NULL,
    hit_dice_count INT NOT NULL,
    hit_dice_sides INT NOT NULL,
    base_speed INT NOT NULL,
    burrow_speed INT NOT NULL DEFAULT 0,
    fly_speed INT NOT NULL DEFAULT 0,
    swim_speed INT NOT NULL DEFAULT 0,
    str_score INT NOT NULL,
    dex_score INT NOT NULL,
    con_score INT NOT NULL,
    int_score INT NOT NULL,
    wis_score INT NOT NULL,
    cha_score INT NOT NULL,
    saving_throws TEXT[] NOT NULL DEFAULT '{}',
    skills TEXT[] NOT NULL DEFAULT '{}',
    resistances TEXT[] NOT NULL DEFAULT '{}',
    immunities TEXT[] NOT NULL DEFAULT '{}',
    vulnerabilities TEXT[] NOT NULL DEFAULT '{}',
    condition_immunities TEXT[] NOT NULL DEFAULT '{}',
    senses VARCHAR(128) NOT NULL DEFAULT '',
    languages VARCHAR(128) NOT NULL DEFAULT '',
    traits JSONB NOT NULL DEFAULT '[]',
    action_deck JSONB NOT NULL DEFAULT '[]',
    legendary_actions JSONB NOT NULL DEFAULT '[]',
    reactions JSONB NOT NULL DEFAULT '[]'
);

-- Spells Repository
CREATE TABLE IF NOT EXISTS compendium.spells (
    spell_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity_id) ON DELETE CASCADE,
    level INT NOT NULL CHECK (level BETWEEN 0 AND 9),
    school VARCHAR(32) NOT NULL,
    casting_time VARCHAR(32) NOT NULL,
    range_feet INT NOT NULL,
    area_of_effect_shape VARCHAR(16),
    area_of_effect_size_feet INT,
    verbal_component BOOLEAN NOT NULL,
    somatic_component BOOLEAN NOT NULL,
    material_component_desc TEXT,
    is_material_costly BOOLEAN NOT NULL DEFAULT FALSE,
    save_attribute VARCHAR(3),
    damage_formula VARCHAR(32),
    damage_type VARCHAR(32),
    duration_rounds INT NOT NULL DEFAULT 0,
    is_concentration BOOLEAN NOT NULL DEFAULT FALSE,
    is_ritual BOOLEAN NOT NULL DEFAULT FALSE,
    description TEXT NOT NULL DEFAULT '',
    higher_levels_scaling TEXT
);

-- Classes Repository
CREATE TABLE IF NOT EXISTS compendium.classes (
    class_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity_id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    hit_die VARCHAR(8) NOT NULL,
    primary_ability VARCHAR(32) NOT NULL,
    saving_throws TEXT[] NOT NULL DEFAULT '{}',
    armor_proficiencies TEXT[] NOT NULL DEFAULT '{}',
    weapon_proficiencies TEXT[] NOT NULL DEFAULT '{}',
    spellcasting_ability VARCHAR(32),
    spell_slots_progression JSONB,
    features JSONB NOT NULL DEFAULT '[]'
);

-- Equipment and Items Repository
CREATE TABLE IF NOT EXISTS compendium.equipment (
    item_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity_id) ON DELETE CASCADE,
    item_category VARCHAR(32) NOT NULL,
    cost_gp NUMERIC(8,2) NOT NULL DEFAULT 0.0,
    weight_lbs NUMERIC(6,2) NOT NULL DEFAULT 0.0,
    rarity VARCHAR(16) NOT NULL DEFAULT 'common',
    attunement_required BOOLEAN NOT NULL DEFAULT FALSE,
    damage_formula VARCHAR(16),
    damage_type VARCHAR(16),
    properties TEXT[] NOT NULL DEFAULT '{}',
    ac_base INT,
    armor_category VARCHAR(16),
    stealth_disadvantage BOOLEAN NOT NULL DEFAULT FALSE,
    strength_requirement INT,
    is_cursed BOOLEAN NOT NULL DEFAULT FALSE,
    curse_reveal_dc INT DEFAULT 15,
    true_state JSONB NOT NULL DEFAULT '{}',
    perceived_state JSONB NOT NULL DEFAULT '{}',
    description TEXT NOT NULL DEFAULT ''
);

-- Rules and Conditions Repository
CREATE TABLE IF NOT EXISTS compendium.conditions (
    condition_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity_id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    description TEXT NOT NULL,
    mechanical_effects JSONB NOT NULL DEFAULT '[]'
);

-- Full-Text Search and Latency Optimization Indexes (<15ms SLA)
CREATE INDEX IF NOT EXISTS idx_compendium_system ON compendium.entities(system_identifier, entity_type);
CREATE INDEX IF NOT EXISTS idx_compendium_search ON compendium.entities USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_wfc_sockets ON compendium.wfc_tiles(socket_north, socket_east, socket_south, socket_west);
CREATE INDEX IF NOT EXISTS idx_monsters_cr ON compendium.monsters(challenge_rating);
CREATE INDEX IF NOT EXISTS idx_spells_level ON compendium.spells(level, school);
CREATE INDEX IF NOT EXISTS idx_equipment_category ON compendium.equipment(item_category, rarity);
