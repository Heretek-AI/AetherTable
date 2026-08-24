-- Recursive nested-inventory queries (GOALS.md Pillar 7).
--
-- The schema already supports container nesting via the self-referencing
-- parent_container_id FK on characters.inventory; these functions provide the
-- recursive traversal the platform spec requires, with cycle protection.

CREATE SCHEMA IF NOT EXISTS narrative_state;

CREATE TABLE IF NOT EXISTS narrative_state.characters (
    character_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  UUID,
    name         TEXT NOT NULL,
    max_hp       INT  NOT NULL DEFAULT 1,
    inventory    JSONB NOT NULL DEFAULT '[]'
);

-- items: (item_id, parent_container_id, name, base_weight_lbs, quantity, is_container, container_capacity_lbs)
CREATE TABLE IF NOT EXISTS narrative_state.items (
    item_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_character_id      UUID REFERENCES narrative_state.characters(character_id) ON DELETE CASCADE,
    parent_container_id     UUID REFERENCES narrative_state.items(item_id),
    name                    TEXT NOT NULL,
    base_weight_lbs         REAL NOT NULL DEFAULT 0,
    quantity                INT  NOT NULL DEFAULT 1,
    is_container            BOOLEAN NOT NULL DEFAULT FALSE,
    container_capacity_lbs  REAL
);

-- Effective weight of one subtree, cycle-safe: a visited-set stops infinite
-- recursion when crafted data forms a parent/child loop.
CREATE OR REPLACE FUNCTION narrative_state.item_effective_weight(root UUID)
RETURNS REAL AS $$
WITH RECURSIVE tree AS (
    SELECT i.*, ARRAY[i.item_id] AS path
    FROM narrative_state.items i WHERE i.item_id = root
UNION ALL
    SELECT nxt.*, t.path || nxt.item_id
    FROM narrative_state.items nxt
    JOIN tree t ON nxt.parent_container_id = t.item_id
    WHERE NOT nxt.item_id = ANY(t.path)          -- cycle guard
)
SELECT COALESCE(SUM(base_weight_lbs * quantity), 0)::REAL FROM tree;
$$ LANGUAGE SQL STABLE;

-- Full character load: every root-level item expanded to its effective weight.
CREATE OR REPLACE FUNCTION narrative_state.character_total_weight(owner UUID)
RETURNS REAL AS $$
WITH RECURSIVE roots AS (
    SELECT i.item_id
    FROM narrative_state.items i
    WHERE i.owner_character_id = owner AND i.parent_container_id IS NULL
),
weights AS (
    SELECT r.item_id, narrative_state.item_effective_weight(r.item_id) AS w
    FROM roots r
)
SELECT COALESCE(SUM(w), 0)::REAL FROM weights;
$$ LANGUAGE SQL STABLE;

-- Depth-first listing of every container path for UI display.
CREATE OR REPLACE FUNCTION narrative_state.inventory_tree(owner UUID)
RETURNS TABLE (item_id UUID, depth INT, path TEXT, name TEXT, weight REAL) AS $$
WITH RECURSIVE walk AS (
    SELECT i.*, 0 AS lvl, i.name::TEXT AS p, ARRAY[i.item_id] AS seen
    FROM narrative_state.items i
    WHERE i.owner_character_id = owner AND i.parent_container_id IS NULL
UNION ALL
    SELECT nxt.*, w.lvl + 1, w.p || ' > ' || nxt.name, w.seen || nxt.item_id
    FROM narrative_state.items nxt
    JOIN walk w ON nxt.parent_container_id = w.item_id
    WHERE NOT nxt.item_id = ANY(w.seen)         -- cycle guard
)
SELECT item_id, lvl, p, name,
       narrative_state.item_effective_weight(item_id)
FROM walk;
$$ LANGUAGE SQL STABLE;
