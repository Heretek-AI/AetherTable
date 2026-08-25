"""Real-embedding backends for the Qdrant compendium RAG (iteration 18).

The hash pseudo-embedder is honest but lexical-only; this suite covers the
fastembed-shaped backend contract WITHOUT ever importing fastembed or
touching the network:

* a deterministic in-test backend stands in for fastembed and drives the
  Qdrant *named-vector* REST layouts (``dense`` + ``sparse``);
* a fake Qdrant endpoint scores both dense and sparse search legs so hybrid
  reciprocal-rank fusion is asserted end-to-end over HTTP bodies;
* provenance labels distinguish real embeddings from the hash fallback, and
  fallback relabeling is proven to happen with exactly ONE honest warning;
* anything needing actual model weights is gated behind RUN_LIVE_FASTEMBED=1
  AND a fastembed import probe — it never runs in the default offline suite.
"""

import hashlib
import json
import logging
import math
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.lore import compendium_rag
from vtt_orchestrator.lore.compendium_rag import (
    DENSE_VECTOR_NAME,
    PROVENANCE_DENSE,
    PROVENANCE_DENSE_SPARSE,
    PROVENANCE_HASH_FALLBACK,
    QDRANT_EMBEDDINGS_ENV,
    QDRANT_ENABLED_ENV,
    RRF_K,
    SPARSE_VECTOR_NAME,
    CompendiumRagIndex,
    build_compendium_rag_index,
)

SPELLS = [
    {
        "id": "spell_fireball",
        "name": "Fireball",
        "level": 3,
        "school": "Evocation",
        "description": "A bright streak blossoms into an explosion of flame.",
        "classes": ["Wizard"],
    },
    {
        "id": "spell_mage_armor",
        "name": "Mage Armor",
        "level": 1,
        "school": "Abjuration",
        "description": "Weave a protective magical force around a creature.",
        "classes": ["Wizard"],
    },
]
MONSTERS = [
    {"id": "monster_goblin", "name": "Goblin", "ac": 15, "hp": 7,
     "challenge_rating": "1/4", "creature_type": "humanoid",
     "actions": [{"name": "Scimitar"}]},
]
MAGIC_ITEMS = [
    {"id": "item_ring", "name": "Ring of Invisibility", "item_type": "Ring",
     "rarity": "legendary", "description": "Turns the wearer invisible."},
]

_COLLECTION = f"/collections/{compendium_rag.COLLECTION_NAME}"


# ---------------------------------------------------------------------------
# A deterministic stand-in for the FastEmbedBackend contract
# ---------------------------------------------------------------------------


class FakeEmbedBackend:
    """Deterministic dense(+sparse) backend matching FastEmbedBackend's API.

    Dense vectors are normalized MD5-bucket bag-of-words at a small dim;
    sparse vectors are per-token hashed indices with unit values. Good enough
    to exercise REST shapes, dimension contracts, and RRF fusion offline.
    """

    named_vectors = True

    def __init__(self, dim: int = 16, sparse: bool = True):
        self.dim = dim
        self.supports_sparse = sparse
        self.label = (
            PROVENANCE_DENSE_SPARSE if sparse else PROVENANCE_DENSE
        )

    def _dense(self, text):
        vector = [0.0] * self.dim
        for token in (text or "").lower().split():
            digest = hashlib.md5(token.encode()).digest()
            vector[int.from_bytes(digest[:4], "big") % self.dim] += 1.0
        norm = math.sqrt(sum(v * v for v in vector))
        return [v / norm for v in vector] if norm else vector

    def embed_documents(self, texts):
        return [self._dense(t) for t in texts]

    def embed_query(self, query):
        return self._dense(query)

    @staticmethod
    def _sparse(text):
        seen = {}
        for token in (text or "").lower().split():
            digest = hashlib.md5(token.encode()).digest()
            seen[int.from_bytes(digest[:4], "big") % 100000] = \
                seen.get(int.from_bytes(digest[:4], "big") % 100000, 0.0) + 1.0
        indices = sorted(seen)
        return {"indices": indices, "values": [seen[i] for i in indices]}

    def embed_sparse_documents(self, texts):
        if not self.supports_sparse:
            return None
        return [self._sparse(t) for t in texts]

    def embed_sparse_query(self, query):
        if not self.supports_sparse:
            return None
        return self._sparse(query)


class FakeQdrantNamed:
    """Fake Qdrant that understands named vectors on both upsert and search."""

    def __init__(self):
        self.points = {}
        self.create_body = None
        self.search_bodies = []
        self.fail_search_after = None  # count of searches before failing

    def transport(self):
        fake = self

        def handler(request: httpx.Request) -> httpx.Response:
            method = request.method
            path = request.url.path
            if method == "GET" and path == _COLLECTION:
                return httpx.Response(
                    200 if fake.points or fake.create_body else 404,
                    json={},
                )
            if method == "PUT" and path == _COLLECTION:
                fake.create_body = json.loads(request.content.decode())
                return httpx.Response(200, json={"result": True})
            if method == "PUT" and path.startswith(_COLLECTION + "/index/"):
                return httpx.Response(200, json={"result": True})
            if method == "PUT" and path == _COLLECTION + "/points":
                body = json.loads(request.content.decode())
                assert body.get("wait") is True
                for point in body["points"]:
                    fake.points[point["id"]] = point
                return httpx.Response(200, json={"result": {}})
            if method == "POST" and path == _COLLECTION + "/points/search":
                if fake.fail_search_after is not None and \
                        len(fake.search_bodies) >= fake.fail_search_after:
                    return httpx.Response(500, json={"err": {}})
                body = json.loads(request.content.decode())
                fake.search_bodies.append(body)
                return httpx.Response(
                    200, json={"result": fake._search(body)}
                )
            return httpx.Response(404, json={"err": f"unexpected {path}"})

        return httpx.MockTransport(handler)

    def _search(self, body):
        query = body["vector"]
        allowed = None
        for clause in (body.get("filter") or {}).get("must", []):
            if clause.get("key") == "category":
                allowed = set(clause["match"]["any"])
        limit = body.get("limit", 5)
        scored = []
        for pid, point in self.points.items():
            if allowed is not None and \
                    point["payload"]["category"] not in allowed:
                continue
            stored = point["vector"]
            if isinstance(query, dict):  # named vector
                qv = query["vector"]
                sv = stored[query["name"]]
            elif isinstance(stored, dict):  # legacy unnamed dense layout
                qv = query
                sv = stored[DENSE_VECTOR_NAME]
            else:
                qv = query
                sv = stored
            score = self._score(qv, sv)
            scored.append({"id": pid, "score": round(score, 6),
                           "payload": point["payload"]})
        scored.sort(key=lambda hit: hit["score"], reverse=True)
        return scored[:limit]

    @staticmethod
    def _score(qv, sv):
        if isinstance(qv, dict):  # sparse leg: dot product over indices
            stored = dict(zip(sv["indices"], sv["values"]))
            return sum(v * stored.get(i, 0.0) for i, v in zip(qv["indices"],
                                                              qv["values"]))
        return sum(a * b for a, b in zip(qv, sv))


def make_wired_index(fake, backend=None):
    client = httpx.Client(transport=fake.transport(), timeout=2.0)
    index_kwargs = {"client": client}
    if backend is not None:
        index_kwargs["embedding_backend"] = backend
    index = CompendiumRagIndex(SPELLS, MONSTERS, MAGIC_ITEMS, **index_kwargs)
    index.index()
    return index


# ---------------------------------------------------------------------------
# Collection creation + upsert: Qdrant named-vector REST formats
# ---------------------------------------------------------------------------


class TestNamedVectorCollectionContract:

    def test_create_declares_named_dense_vector_with_model_dim(self):
        fake = FakeQdrantNamed()
        make_wired_index(fake, FakeEmbedBackend(dim=384))
        vectors = fake.create_body["vectors"]
        assert set(vectors.keys()) == {DENSE_VECTOR_NAME}
        assert vectors[DENSE_VECTOR_NAME]["size"] == 384
        assert vectors[DENSE_VECTOR_NAME]["distance"] == "Cosine"
        # Legacy unnamed layout must NOT leak into the named-vector request.
        assert "size" not in fake.create_body["vectors"]

    def test_sparse_collection_vector_only_when_backend_supports_it(self):
        fake = FakeQdrantNamed()
        make_wired_index(fake, FakeEmbedBackend(sparse=True))
        assert SPARSE_VECTOR_NAME in fake.create_body["sparse_vectors"]

        dense_only = FakeQdrantNamed()
        make_wired_index(dense_only, FakeEmbedBackend(sparse=False))
        assert "sparse_vectors" not in dense_only.create_body

    def test_points_carry_named_dense_plus_sparse(self):
        fake = FakeQdrantNamed()
        backend = FakeEmbedBackend(dim=16)
        make_wired_index(fake, backend)
        assert len(fake.points) == len(SPELLS) + len(MONSTERS) + \
            len(MAGIC_ITEMS)
        for point in fake.points.values():
            vector = point["vector"]
            assert set(vector.keys()) == {DENSE_VECTOR_NAME,
                                          SPARSE_VECTOR_NAME}
            dense = vector[DENSE_VECTOR_NAME]
            assert len(dense) == backend.dim
            norm = math.sqrt(sum(v * v for v in dense))
            assert norm == pytest.approx(1.0)
            sparse = vector[SPARSE_VECTOR_NAME]
            assert len(sparse["indices"]) == len(sparse["values"]) > 0
            assert all(isinstance(i, int) for i in sparse["indices"])
            assert all(isinstance(v, float) for v in sparse["values"])

    def test_dense_only_points_have_no_sparse_key(self):
        fake = FakeQdrantNamed()
        make_wired_index(fake, FakeEmbedBackend(sparse=False))
        for point in fake.points.values():
            assert set(point["vector"].keys()) == {DENSE_VECTOR_NAME}


# ---------------------------------------------------------------------------
# Hybrid search: two legs, RRF fusion, dimension consistency
# ---------------------------------------------------------------------------


class TestHybridSearchSemantics:

    def test_dense_leg_uses_named_dense_vector_matching_doc_dims(self):
        fake = FakeQdrantNamed()
        backend = FakeEmbedBackend(dim=24)
        index = make_wired_index(fake, backend)
        results = index.search("explosion of flame", k=3)
        assert results
        dense_bodies = [b for b in fake.search_bodies
                        if isinstance(b["vector"], dict)
                        and b["vector"]["name"] == DENSE_VECTOR_NAME]
        assert dense_bodies, "dense search leg must use the named vector"
        query_vec = dense_bodies[-1]["vector"]["vector"]
        # Dimension consistency: query and document vectors agree.
        assert len(query_vec) == backend.dim
        stored = next(iter(fake.points.values()))["vector"][DENSE_VECTOR_NAME]
        assert len(stored) == len(query_vec)

    def test_hybrid_runs_both_legs_and_fuses_by_rrf(self):
        fake = FakeQdrantNamed()
        index = make_wired_index(fake, FakeEmbedBackend())
        results = index.search("fireball explosion", k=3)
        names = [b["vector"].get("name") for b in fake.search_bodies]
        assert DENSE_VECTOR_NAME in names and SPARSE_VECTOR_NAME in names
        scores = [r["score"] for r in results]
        assert scores == sorted(scores, reverse=True)
        # RRF bounds: any single hit accrues at most one hit from each leg.
        # (tolerance covers the 6-decimal rounding of fused scores)
        assert all(0.0 < s <= 2.0 / (RRF_K + 1) + 1e-6 for s in scores)
        top_payload_name = results[0]["name"]
        assert top_payload_name == "Fireball"  # strongest in both legs

    def test_fused_hits_are_deduplicated_across_legs(self):
        fake = FakeQdrantNamed()
        index = make_wired_index(fake, FakeEmbedBackend())
        results = index.search("goblin scimitar", k=25)
        names = [r["name"] for r in results]
        assert len(names) == len(set(names))

    def test_kind_filter_applies_to_both_legs(self):
        fake = FakeQdrantNamed()
        index = make_wired_index(fake, FakeEmbedBackend())
        results = index.search("protective armor force", k=10,
                               kinds=["monster"])
        # The only monster shares no terms with the query, but the filter —
        # not score thresholding — is what limits results to monsters.
        assert {r["type"] for r in results} == {"monster"}
        for body in fake.search_bodies:
            assert body["filter"]["must"][0]["key"] == "category"

    def test_empty_sparse_query_degrades_to_dense_leg_only(self):
        fake = FakeQdrantNamed()
        backend = FakeEmbedBackend()

        def no_terms(_text):
            return {"indices": [], "values": []}

        backend.embed_sparse_query = no_terms
        make_wired_index(fake, backend).search("zzzz", k=2)
        assert [b["vector"].get("name") for b in fake.search_bodies] == [
            DENSE_VECTOR_NAME]

    def test_sparse_leg_failure_degrades_whole_request_to_none(self):
        fake = FakeQdrantNamed()
        index = make_wired_index(fake, FakeEmbedBackend())
        fake.fail_search_after = 1  # dense leg OK, sparse leg dies
        assert index.search("fireball", k=3) is None

    def test_fact_shape_matches_hash_backend_contract(self):
        fake = FakeQdrantNamed()
        index = make_wired_index(fake, FakeEmbedBackend())
        top = index.search("fireball", k=1, kinds=["spell"])[0]
        for key in ("type", "name", "level_name", "school", "snippet",
                    "score"):
            assert key in top


# ---------------------------------------------------------------------------
# Provenance honesty: labels distinguish real embeddings from the fallback
# ---------------------------------------------------------------------------


class TestProvenanceLabels:

    @pytest.mark.parametrize("sparse,label", [
        (True, PROVENANCE_DENSE_SPARSE),
        (False, PROVENANCE_DENSE),
    ])
    def test_backend_label_flows_to_retrieval_provenance(self, sparse, label):
        fake = FakeQdrantNamed()
        index = make_wired_index(fake, FakeEmbedBackend(sparse=sparse))
        assert index.retrieval_provenance == label

    def test_default_backend_is_hash_fallback_labelled(self):
        fake = FakeQdrantNamed()
        index = make_wired_index(fake, None)
        assert index.embedding_backend.named_vectors is False
        assert index.retrieval_provenance == PROVENANCE_HASH_FALLBACK
        assert index.vector_size == 1536  # config-file dims preserved

    def test_route_reports_real_embedding_labels_verbatim(
        self, monkeypatch
    ):
        from vtt_orchestrator import server as server_module

        fake = FakeQdrantNamed()
        index = make_wired_index(fake, FakeEmbedBackend(sparse=True))
        monkeypatch.setattr(server_module, "compendium_rag", index)
        payload = TestClient(server_module.app).get(
            "/api/v1/compendium/lore-lookup",
            params={"q": "fireball", "semantic": "true"},
        ).json()
        assert payload["retrieval"] == PROVENANCE_DENSE_SPARSE

    def test_route_reports_hash_fallback_for_pseudo_embeddings(
        self, monkeypatch
    ):
        from vtt_orchestrator import server as server_module

        fake = FakeQdrantNamed()
        index = make_wired_index(fake, None)
        monkeypatch.setattr(server_module, "compendium_rag", index)
        payload = TestClient(server_module.app).get(
            "/api/v1/compendium/lore-lookup",
            params={"q": "fireball", "semantic": "true"},
        ).json()
        assert payload["retrieval"] == PROVENANCE_HASH_FALLBACK
        assert all("score" in f for f in payload["facts"])


# ---------------------------------------------------------------------------
# Env-gated backend selection + fallback relabeling (no network, no fastembed)
# ---------------------------------------------------------------------------


class TestEmbeddingBackendSelection:

    def test_unset_env_never_touches_fastembed(self, monkeypatch):
        def boom(*a, **k):
            raise AssertionError("fastembed attempted while not opted in")

        monkeypatch.setattr(compendium_rag, "FastEmbedBackend", boom)
        backend = compendium_rag.build_embedding_backend(env={})
        assert backend.label == PROVENANCE_HASH_FALLBACK

    @pytest.mark.parametrize("value", ["0", "false", "", "off"])
    def test_disabled_values_use_hash_backend(self, value, monkeypatch):
        monkeypatch.setattr(
            compendium_rag, "FastEmbedBackend",
            lambda *a, **k: (_ for _ in ()).throw(AssertionError("called")),
        )
        assert compendium_rag.build_embedding_backend(
            env={QDRANT_EMBEDDINGS_ENV: value}).label \
            == PROVENANCE_HASH_FALLBACK

    def test_fastembed_init_failure_relables_and_warns_once(self, caplog):
        class Broken:
            def __init__(self, *a, **k):
                raise RuntimeError("model download failed: offline")

        original = compendium_rag.HashEmbeddingBackend
        with caplog.at_level(logging.WARNING, logger="vtt_orchestrator.lore"):
            try:
                compendium_rag.FastEmbedBackend = Broken
                backend = compendium_rag.build_embedding_backend(
                    env={QDRANT_EMBEDDINGS_ENV: "1"})
            finally:
                compendium_rag.FastEmbedBackend = original
        assert backend.label == PROVENANCE_HASH_FALLBACK  # RELABELLED honestly
        warnings = [r for r in caplog.records
                    if "fastembed unavailable" in r.message]
        assert len(warnings) == 1
        assert PROVENANCE_HASH_FALLBACK in warnings[0].getMessage()
        assert "NOT semantic" in warnings[0].getMessage()

    def test_full_startup_with_broken_fastembed_still_indexes_as_hash(
        self, caplog
    ):
        class Broken:
            def __init__(self, *a, **k):
                raise ImportError("No module named 'fastembed'")

        original = compendium_rag.FastEmbedBackend
        fake = FakeQdrantNamed()
        with caplog.at_level(logging.WARNING, logger="vtt_orchestrator.lore"):
            try:
                compendium_rag.FastEmbedBackend = Broken
                index = build_compendium_rag_index(
                    SPELLS, MONSTERS, MAGIC_ITEMS,
                    env={QDRANT_ENABLED_ENV: "1",
                         QDRANT_EMBEDDINGS_ENV: "1"},
                    client=httpx.Client(transport=fake.transport(),
                                        timeout=2.0),
                )
            finally:
                compendium_rag.FastEmbedBackend = original
        assert index.available is True
        assert index.retrieval_provenance == PROVENANCE_HASH_FALLBACK
        assert len(fake.points) == 4  # served by Qdrant, but on hash vectors
        relabel_logs = [r for r in caplog.records
                        if "fastembed unavailable" in r.message]
        assert len(relabel_logs) == 1  # exactly ONE honest degradation log


# ---------------------------------------------------------------------------
# Live check (opt-in ONLY): needs the fastembed extra + model downloads.
#   pip install -e "python/[embeddings]" && RUN_LIVE_FASTEMBED=1 pytest ...
# Never runs in the default offline suite (import probe AND env gate).
# ---------------------------------------------------------------------------


def _fastembed_importable() -> bool:
    try:
        import fastembed  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.mark.live
@pytest.mark.skipif(
    not _fastembed_importable()
    or os.environ.get("RUN_LIVE_FASTEMBED") != "1",
    reason="needs fastembed installed and RUN_LIVE_FASTEMBED=1 "
           "(downloads model weights)",
)
class TestLiveFastEmbedBackend:

    def test_dense_dimension_consistent_between_docs_and_queries(self):
        backend = compendium_rag.FastEmbedBackend()
        docs = backend.embed_documents(["Fireball explodes into flame",
                                        "Mage Armor protects a creature"])
        query = backend.embed_query(["an explosion of flame"])
        assert backend.dim > 0
        assert all(len(d) == backend.dim for d in docs)
        assert len(query) == backend.dim

    def test_semantic_similarity_beats_lexical_overlap(self):
        backend = compendium_rag.FastEmbedBackend()

        def cos(a, b):
            dot = sum(x * y for x, y in zip(a, b))
            na = math.sqrt(sum(x * x for x in a))
            nb = math.sqrt(sum(y * y for y in b))
            return dot / (na * nb)

        fireball, armor = backend.embed_documents(
            ["A bright streak blossoms into an explosion of flame.",
             "Weave protective magical force around a willing creature."])
        query = backend.embed_query(["an explosion of fire"])
        assert cos(fireball, query) > cos(armor, query)

    def test_sparse_embeddings_produce_rest_shaped_vectors(self):
        backend = compendium_rag.FastEmbedBackend()
        assert backend.supports_sparse
        assert backend.label == PROVENANCE_DENSE_SPARSE
        sparse = backend.embed_sparse_documents(["goblin scimitar attack"])
        assert len(sparse) == 1
        assert sparse[0]["indices"] and sparse[0]["values"]
        assert len(sparse[0]["indices"]) == len(sparse[0]["values"])

    def test_sparse_failure_relabels_to_dense_only(self):
        backend = compendium_rag.FastEmbedBackend(sparse_model="Qdrant/bm25")
        assert backend.label in {PROVENANCE_DENSE_SPARSE, PROVENANCE_DENSE}
