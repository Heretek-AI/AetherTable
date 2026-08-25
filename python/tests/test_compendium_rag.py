"""Backlog 4.7 — Qdrant-backed hybrid RAG over the rules compendium.

No real Qdrant runs in CI: the REST surface is mocked with
``httpx.MockTransport`` and a tiny in-test "vector store" computes cosine
scores against whatever the implementation upserted, so we can assert both
request well-formedness (collection settings straight out of
database/qdrant/01_collections_config.json) and scored-search semantics.

Honesty contract under test:

* ``QDRANT_ENABLED`` unset/false  -> zero network attempts ever, provenance
  ``"substring"``;
* enabled but the startup probe fails -> ONE honest fallback log, the
  substring scan serves reads, provenance ``"substring"``;
* enabled, indexed, but Qdrant fails mid-request -> that request degrades to
  the substring scan with provenance ``"substring_fallback"`` (read-path
  degradation is acceptable here, unlike canon writes).
"""

import json
import logging
import math
import os
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.lore.compendium_rag import (
    COLLECTION_NAME,
    QDRANT_ENABLED_ENV,
    CompendiumRagIndex,
    build_compendium_rag_index,
    hash_embed,
)

PROJECT_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
CONFIG_PATH = os.path.join(
    PROJECT_ROOT, "database", "qdrant", "01_collections_config.json"
)


# ---------------------------------------------------------------------------
# Fixtures: a miniature compendium with the same shapes as the loaded JSON
# lists server.py passes in.
# ---------------------------------------------------------------------------

SPELLS = [
    {
        "id": "spell_fireball",
        "name": "Fireball",
        "level": 3,
        "school": "Evocation",
        "description": (
            "A bright streak flashes from your pointing finger to a point you "
            "choose and blossoms with a low roar into an explosion of flame."
        ),
        "classes": ["Wizard", "Sorcerer"],
    },
    {
        "id": "spell_mage_armor",
        "name": "Mage Armor",
        "level": 1,
        "school": "Abjuration",
        "description": (
            "You touch a willing creature who isn't wearing armor and weave a "
            "protective magical force around it."
        ),
        "classes": ["Wizard"],
    },
]

MONSTERS = [
    {
        "id": "monster_goblin",
        "name": "Goblin",
        "ac": 15,
        "hp": 7,
        "challenge_rating": "1/4",
        "creature_type": "humanoid (goblinoid)",
        "actions": [{"name": "Scimitar"}, {"name": "Shortbow"}],
    },
    {
        "id": "monster_aboleth",
        "name": "Aboleth",
        "ac": 17,
        "hp": 135,
        "challenge_rating": "10",
        "creature_type": "aberration",
        "actions": [{"name": "Tentacle"}, {"name": "Tail"}, {"name": "Enslave"}],
    },
]

MAGIC_ITEMS = [
    {
        "id": "item_adamantine_armor",
        "name": "Adamantine Armor",
        "item_type": "Armor (medium)",
        "rarity": "uncommon",
        "description": (
            "This suit of armor is reinforced with adamantine, one of the "
            "hardest substances in existence."
        ),
    },
]


# ---------------------------------------------------------------------------
# A fake Qdrant REST endpoint over an in-memory vector store.
# ---------------------------------------------------------------------------

_COLLECTION_PATH = f"/collections/{COLLECTION_NAME}"


class ExplodingTransport(httpx.BaseTransport):
    """Detonates on ANY network attempt — proves 'no network when disabled'."""

    def __init__(self, label="network attempted"):
        self.label = label
        self.attempts = 0

    def handle_request(self, request):
        self.attempts += 1
        raise AssertionError(f"{self.label}: {request.method} {request.url}")


class FakeQdrant:
    """Records traffic; answers the Qdrant REST endpoints like the real thing."""

    def __init__(self, fail_connect=False, fail_search=False, search_status=500):
        self.existing_collections = set()
        self.points = {}
        self.requests = []
        self.create_body = None
        self.index_fields = []
        self.fail_connect = fail_connect
        self.fail_search = fail_search
        self.search_status = search_status

    # -- handlers ----------------------------------------------------------

    def transport(self):
        fake = self

        def handler(request: httpx.Request) -> httpx.Response:
            if fake.fail_connect:
                raise httpx.ConnectError("connection refused", request=request)
            method = request.method
            path = request.url.path
            fake.requests.append((method, path))

            if method == "GET" and path == _COLLECTION_PATH:
                exists = COLLECTION_NAME in fake.existing_collections
                return httpx.Response(
                    200 if exists else 404,
                    json={"result": {"status": "green"}} if exists else {},
                )

            if method == "PUT" and path == _COLLECTION_PATH:
                body = json.loads(request.content.decode())
                fake.create_body = body
                fake.existing_collections.add(COLLECTION_NAME)
                return httpx.Response(200, json={"result": True, "status": "ok"})

            if method == "PUT" and path.startswith(_COLLECTION_PATH + "/index/"):
                field = path.rsplit("/", 1)[-1]
                body = json.loads(request.content.decode())
                fake.index_fields.append((field, body.get("field_schema")))
                return httpx.Response(200, json={"result": True, "status": "ok"})

            if method == "PUT" and path == _COLLECTION_PATH + "/points":
                body = json.loads(request.content.decode())
                assert body.get("wait") is True, "upserts must be acknowledged"
                for point in body["points"]:
                    fake.points[point["id"]] = {
                        "vector": point["vector"],
                        "payload": point["payload"],
                    }
                return httpx.Response(
                    200,
                    json={"result": {"operation_id": 1, "status": "completed"}},
                )

            if method == "POST" and path == _COLLECTION_PATH + "/points/search":
                if fake.fail_search:
                    return httpx.Response(
                        fake.search_status, json={"err": {"code": "internal"}}
                    )
                body = json.loads(request.content.decode())
                return httpx.Response(200, json={"result": fake._search(body)})

            return httpx.Response(404, json={"err": f"unexpected {method} {path}"})

        return httpx.MockTransport(handler)

    def _search(self, body):
        """Cosine-score stored points honoring the category payload filter."""
        query = body["vector"]
        allowed = None
        for clause in (body.get("filter") or {}).get("must", []):
            if clause.get("key") == "category":
                allowed = set(clause["match"]["any"])

        scored = []
        for pid, point in self.points.items():
            payload = point["payload"]
            if allowed is not None and payload["category"] not in allowed:
                continue
            dot = sum(a * b for a, b in zip(query, point["vector"]))
            scored.append({"id": pid, "score": round(dot, 6), "payload": payload})
        scored.sort(key=lambda hit: hit["score"], reverse=True)
        return scored[: body.get("limit", 5)]

    def client(self):
        return httpx.Client(transport=self.transport(), timeout=2.0)

    def upserted_categories(self):
        return {p["payload"]["category"] for p in self.points.values()}


@pytest.fixture()
def fake():
    return FakeQdrant()


def make_index(fake, **kwargs):
    return CompendiumRagIndex(SPELLS, MONSTERS, MAGIC_ITEMS, client=fake.client(),
                              **kwargs)


# ---------------------------------------------------------------------------
# The lexical-hash embedder (honest, deterministic, normalized)
# ---------------------------------------------------------------------------


class TestHashEmbedder:
    def test_embedding_is_l2_normalized(self):
        for text in ("fireball", "a bright streak of flame", ""):
            vec = hash_embed(text)
            norm = math.sqrt(sum(v * v for v in vec))
            assert norm == pytest.approx(1.0) or norm == 0.0

    def test_embedding_is_deterministic_across_calls(self):
        assert hash_embed("evocation fireball") == hash_embed("evocation fireball")

    def test_different_text_yields_different_vectors(self):
        assert hash_embed("fireball") != hash_embed("mage armor")

    def test_hashing_avoids_python_randomized_hash(self):
        """Built-in hash() is salted per process; the embedder must not use it
        or vectors would not survive a restart (and re-index would churn)."""
        import hashlib

        token = "fireball"
        expected = int.from_bytes(hashlib.md5(token.encode()).digest()[:8], "big")
        vec = hash_embed(token)
        nonzero = [i for i, v in enumerate(vec) if v > 0]
        assert len(nonzero) == 1
        assert nonzero[0] == expected % len(vec)


# ---------------------------------------------------------------------------
# Startup indexing: requests well-formed per the collections config file
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def configured_fake():
    fake = FakeQdrant()
    idx = CompendiumRagIndex(SPELLS, MONSTERS, MAGIC_ITEMS,
                             client=fake.client())
    assert idx.index() is True
    return fake


class TestStartupIndexingPerConfigFile:

    def test_collection_settings_match_config_file(self, configured_fake):
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            config = json.load(fh)
        entry = next(
            c for c in config["collections"] if c["name"] == COLLECTION_NAME
        )
        body = configured_fake.create_body
        assert body is not None
        assert body["vectors"]["size"] == entry["vectors"]["size"]
        assert body["vectors"]["distance"] == entry["vectors"]["distance"]
        assert body["optimizers_config"] == entry["optimizers_config"]

    def test_all_entries_upserted_with_expected_kinds(self, configured_fake):
        assert configured_fake.upserted_categories() == {
            "spell", "monster", "magic_item"
        }
        assert len(configured_fake.points) == len(SPELLS) + len(MONSTERS) + \
            len(MAGIC_ITEMS)

    def test_points_carry_full_dim_vector_and_config_payload_schema(
        self, configured_fake
    ):
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            entry = next(
                c for c in json.load(fh)["collections"]
                if c["name"] == COLLECTION_NAME
            )
        declared = set((entry.get("payload_schema") or {}).keys())
        for point in configured_fake.points.values():
            assert len(point["vector"]) == entry["vectors"]["size"]
            # The fields we filter on (declared keyword fields in the config)
            # are present and well-typed on every point.
            for field in ("category", "system_id", "tags"):
                assert field in declared
                assert field in point["payload"]
            assert isinstance(point["payload"]["system_id"], str)
            tags = point["payload"]["tags"]
            assert isinstance(tags, list) and tags

    def test_keyword_payload_index_requested_for_filter_field(
        self, configured_fake
    ):
        assert ("category", "keyword") in configured_fake.index_fields

    def test_point_ids_are_stable_uuids(self, configured_fake):
        ids = set(configured_fake.points.keys())
        assert len(ids) == len(configured_fake.points)  # no id collisions
        for pid in ids:
            assert re.fullmatch(r"[0-9a-f-]{36}", pid)
        # Re-indexing the same corpus produces identical ids (overwrite, not dup).
        again = make_index(configured_fake)
        again.index()
        assert set(configured_fake.points.keys()) == ids


# ---------------------------------------------------------------------------
# Search semantics: scored entries + kind filtering
# ---------------------------------------------------------------------------


class TestSearchScoring:
    def test_search_returns_scored_best_match_first(self, fake):
        index = make_index(fake)
        index.index()
        results = index.search("explosion of flame evocation", k=3)
        assert results is not None and results
        scores = [r["score"] for r in results]
        assert scores == sorted(scores, reverse=True)
        assert all(isinstance(r["score"], float) and 0.0 <= r["score"] <= 1.0
                   for r in results)
        assert results[0]["score"] > 0.0  # best match genuinely overlaps
        names = [r["name"] for r in results]
        assert "Fireball" in names

    def test_kind_filter_narrows_to_requested_types(self, fake):
        index = make_index(fake)
        index.index()
        spells = index.search("armor protection", k=5, kinds=["spell"])
        assert spells is not None
        assert spells and {e["type"] for e in spells} == {"spell"}
        monsters = index.search("armor protection", k=5, kinds=["monster"])
        assert monsters is not None
        assert {e["type"] for e in monsters} <= {"monster"}

    def test_kind_filter_sent_as_category_payload_filter(self, fake):
        index = make_index(fake)
        index.index()
        captured = {}

        real_transport = fake.transport()

        def spy_handler(request):
            if request.url.path.endswith("/points/search"):
                captured["body"] = json.loads(request.content.decode())
            return real_transport.handle_request(request)

        spy_client = httpx.Client(transport=httpx.MockTransport(spy_handler),
                                  timeout=2.0)
        index._client = spy_client
        index.search("goblin", k=2, kinds=["monster", "spell"])
        flt = captured["body"]["filter"]
        assert flt["must"][0]["key"] == "category"
        assert set(flt["must"][0]["match"]["any"]) == {"monster", "spell"}

    def test_identical_queries_score_identically(self, fake):
        index = make_index(fake)
        index.index()
        first = index.search("tentacled aberration enslave", k=4)
        second = index.search("tentacled aberration enslave", k=4)
        assert first == second

    def test_result_limit_respected(self, fake):
        index = make_index(fake)
        index.index()
        results = index.search("flame armor tentacle", k=2)
        assert len(results) == 2

    def test_fact_shape_mirrors_substring_contract_plus_score(self, fake):
        index = make_index(fake)
        index.index()
        results = index.search("fireball explosion", k=1, kinds=["spell"])
        top = results[0]
        for key in ("type", "name", "level_name", "school", "snippet", "score"):
            assert key in top
        monster = index.search("goblin scimitar", k=1, kinds=["monster"])[0]
        for key in ("type", "name", "ac", "hp", "challenge_rating",
                    "action_names", "score"):
            assert key in monster


# ---------------------------------------------------------------------------
# Backend selection & honesty: three fallback modes
# ---------------------------------------------------------------------------


class TestBackendSelectionAndHonesty:
    def test_disabled_means_zero_network_attempts(self):
        exploding = ExplodingTransport("network attempted while disabled")
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={},  # QDRANT_ENABLED unset
            client=httpx.Client(transport=exploding),
        )
        assert index.available is False
        assert exploding.attempts == 0
        assert index.search("fireball", k=3) is None

    @pytest.mark.parametrize("value", ["0", "false", "", "off"])
    def test_disabled_values_skip_startup_entirely(self, value):
        exploding = ExplodingTransport()
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={QDRANT_ENABLED_ENV: value},
            client=httpx.Client(transport=exploding),
        )
        assert index.available is False
        assert exploding.attempts == 0

    def test_enabled_but_unreachable_logs_one_honest_fallback(self, caplog):
        dead = FakeQdrant(fail_connect=True)
        with caplog.at_level(logging.WARNING, logger="vtt_orchestrator.lore"):
            index = build_compendium_rag_index(
                SPELLS, MONSTERS, MAGIC_ITEMS,
                env={QDRANT_ENABLED_ENV: "1"},
                client=dead.client(),
            )
        assert index.available is False
        fallback_logs = [
            r for r in caplog.records if "fallback" in r.message.lower()
        ]
        assert len(fallback_logs) == 1  # logged ONCE at startup, never per request
        assert "QDRANT_ENABLED" in fallback_logs[0].getMessage()

    def test_enabled_and_reachable_indexes_and_serves(self, fake):
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={QDRANT_ENABLED_ENV: "1"},
            client=fake.client(),
        )
        assert index.available is True
        assert len(fake.points) == len(SPELLS) + len(MONSTERS) + len(MAGIC_ITEMS)
        results = index.search("fireball", k=2)
        assert results and results[0]["name"] == "Fireball"


# ---------------------------------------------------------------------------
# Route contract: GET /api/v1/compendium/lore-lookup
# ---------------------------------------------------------------------------


def wired_route_client(monkeypatch, index):
    from vtt_orchestrator import server as server_module

    monkeypatch.setattr(server_module, "compendium_rag", index)
    return TestClient(server_module.app)


class TestLoreLookupRouteProvenance:
    LEGACY_QUERY = "the goblin chief casts Fireball at the party"

    def test_default_mode_is_substring_with_provenance(self, monkeypatch):
        from vtt_orchestrator import server as server_module

        client = wired_route_client(monkeypatch, server_module.compendium_rag)
        payload = client.get(
            "/api/v1/compendium/lore-lookup", params={"q": self.LEGACY_QUERY}
        ).json()
        assert payload["retrieval"] == "substring"
        assert payload["query"] == self.LEGACY_QUERY
        names = [f["name"] for f in payload["facts"]]
        assert "Fireball" in names

    def test_mode_disabled_semantic_request_degrades_to_substring(
        self, monkeypatch
    ):
        exploding = ExplodingTransport()
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={}, client=httpx.Client(transport=exploding),
        )
        client = wired_route_client(monkeypatch, index)
        payload = client.get(
            "/api/v1/compendium/lore-lookup",
            params={"q": self.LEGACY_QUERY, "semantic": "true", "k": 5},
        ).json()
        assert payload["retrieval"] == "substring"
        assert exploding.attempts == 0  # degraded BEFORE any network attempt

    def test_mode_unreachable_at_startup_reports_plain_substring(
        self, monkeypatch
    ):
        dead = FakeQdrant(fail_connect=True)
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={QDRANT_ENABLED_ENV: "1"}, client=dead.client(),
        )
        client = wired_route_client(monkeypatch, index)
        payload = client.get(
            "/api/v1/compendium/lore-lookup",
            params={"q": self.LEGACY_QUERY, "semantic": "true"},
        ).json()
        # Startup-unreachable is a permanent state: plain substring, not a
        # per-request degradation marker.
        assert payload["retrieval"] == "substring"

    def test_mode_qdrant_returns_scored_facts_with_qdrant_provenance(
        self, monkeypatch, fake
    ):
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={QDRANT_ENABLED_ENV: "1"}, client=fake.client(),
        )
        client = wired_route_client(monkeypatch, index)
        payload = client.get(
            "/api/v1/compendium/lore-lookup",
            params={"q": "an explosion of flame", "semantic": "true", "k": 3},
        ).json()
        # Default embedding backend is the lexical-hash pseudo-embedder; the
        # route must say so rather than claiming real ("qdrant") embeddings.
        assert payload["retrieval"] == "qdrant-hash-fallback"
        assert payload["facts"]
        assert all("score" in f for f in payload["facts"])
        scores = [f["score"] for f in payload["facts"]]
        assert scores == sorted(scores, reverse=True)

    def test_mode_request_failure_falls_back_with_marker(self, monkeypatch, fake):
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={QDRANT_ENABLED_ENV: "1"}, client=fake.client(),
        )
        fake.fail_search = True  # Qdrant dies AFTER successful indexing
        client = wired_route_client(monkeypatch, index)
        payload = client.get(
            "/api/v1/compendium/lore-lookup",
            params={"q": self.LEGACY_QUERY, "semantic": "true", "k": 5},
        ).json()
        assert payload["retrieval"] == "substring_fallback"
        names = [f["name"] for f in payload["facts"]]
        assert "Fireball" in names  # still grounded, honestly labelled

    def test_connection_drop_mid_request_also_marks_fallback(
        self, monkeypatch, fake
    ):
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={QDRANT_ENABLED_ENV: "1"}, client=fake.client(),
        )
        original_transport = fake.transport()

        def dropping_handler(request):
            if request.url.path.endswith("/points/search"):
                raise httpx.ConnectError("reset by peer", request=request)
            return original_transport.handle_request(request)

        index._client = httpx.Client(
            transport=httpx.MockTransport(dropping_handler), timeout=2.0
        )
        client = wired_route_client(monkeypatch, index)
        payload = client.get(
            "/api/v1/compendium/lore-lookup",
            params={"q": self.LEGACY_QUERY, "semantic": "true"},
        ).json()
        assert payload["retrieval"] == "substring_fallback"

    def test_k_parameter_bounds_are_enforced(self, monkeypatch, fake):
        index = build_compendium_rag_index(
            SPELLS, MONSTERS, MAGIC_ITEMS,
            env={QDRANT_ENABLED_ENV: "1"}, client=fake.client(),
        )
        client = wired_route_client(monkeypatch, index)
        response = client.get(
            "/api/v1/compendium/lore-lookup",
            params={"q": "fireball", "semantic": "true", "k": 0},
        )
        assert response.status_code == 422
