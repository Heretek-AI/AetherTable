"""Qdrant-backed hybrid RAG over the rules compendiums (backlog 4.7).

The ``qdrant-client`` pip package is treated as absent on purpose: all
database access goes through Qdrant's REST API with ``httpx`` only — zero new
dependencies, and the transport is trivially mockable in tests:

* ``PUT  /collections/{name}``                 ensure the collection exists
* ``PUT  /collections/{name}/index/{field}``   keyword payload index for filtering
* ``PUT  /collections/{name}/points``          batched upsert of compendium vectors
* ``POST /collections/{name}/points/search``   cosine top-K with a payload filter

Collection naming follows ``database/qdrant/01_collections_config.json`` (the
config docker-compose mounts into qdrant): the single ``compendium_rules``
collection is the namespace, vector size/distance and optimizer settings are
copied verbatim from that file, and multi-tenant / per-content-type namespacing
is expressed as payload filters on the config's declared ``category`` keyword
field (``spell`` | ``monster`` | ``magic_item``) plus ``system_id`` — exactly
the fields the config's ``payload_schema`` declares.

EMBEDDING HONESTY: retrieval quality depends entirely on which embedding
backend produced the vectors, so provenance names it explicitly:

* ``"qdrant-dense-sparse"`` — real hybrid embeddings: dense via fastembed
  (``TextEmbedding``, default ``BAAI/bge-small-en-v1.5``, 384 dims) plus a
  sparse lexical vector (default ``Qdrant/bm25``) stored as Qdrant *named*
  vectors (``dense`` + ``sparse``); search fuses both legs with reciprocal
  rank fusion.
* ``"qdrant-dense"`` — real dense embeddings via fastembed but sparse init
  failed/unavailable; named-vector upsert/search on the ``dense`` vector only.
* ``"qdrant-hash-fallback"`` — the deterministic *lexical-hash* embedder:
  tokens are hashed into fixed-size buckets (MD5-derived, stable across
  processes/restarts), counted as bag-of-words and L2-normalized.
  Similarity measures term overlap, NOT meaning: "fire" shares no signal with
  "flame". This is the DEFAULT backend (opt in with ``QDRANT_EMBEDDINGS=1``)
  and the fallback whenever fastembed is not installed or its model download
  fails — operators must be able to tell pseudo-embeddings from real ones,
  so the route reports the label verbatim instead of a generic "qdrant".

fastembed itself is an OPTIONAL dependency (``pip install
vtt-orchestrator[embeddings]``): it pulls ONNX runtime and downloads model
weights from HuggingFace on first use, neither of which may happen in offline
CI. Import/init failures degrade to the hash backend with ONE honest log;
the suite stays green without network because tests inject fake backends.

FAILURE POLICY (deliberate, mirrors neo4j_graph but for a read path): reads
may degrade where canon writes may not. If Qdrant is unreachable at startup we
log ONE honest fallback and serve every lookup from the existing substring
scan forever (provenance ``"substring"``). If Qdrant was healthy at startup
but fails mid-request, only that request degrades to the substring scan with
provenance ``"substring_fallback"`` so callers can tell grounded-but-degraded
results from normal ones.
"""

import hashlib
import json
import logging
import math
import os
import re
import uuid
from typing import Any, Dict, List, Optional, Sequence

import httpx

logger = logging.getLogger("vtt_orchestrator.lore")

QDRANT_ENABLED_ENV = "QDRANT_ENABLED"
QDRANT_HOST_ENV = "QDRANT_HOST"
DEFAULT_QDRANT_HOST = "http://localhost:6333"
# Opt-in real embeddings. Default (unset/false) keeps the deterministic hash
# embedder so no model download can ever happen uninvited (offline CI).
QDRANT_EMBEDDINGS_ENV = "QDRANT_EMBEDDINGS"
FASTEMBED_DENSE_MODEL_ENV = "FASTEMBED_DENSE_MODEL"
FASTEMBED_SPARSE_MODEL_ENV = "FASTEMBED_SPARSE_MODEL"

# fastembed models (see https://github.com/qdrant/fastembed): bge-small-en-v1.5
# is 384 dims / ~67 MB ONNX and runs comfortably on CPU; Qdrant/bm25 is the
# smallest supported sparse model (~10 MB).
DEFAULT_DENSE_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_SPARSE_MODEL = "Qdrant/bm25"

# Named-vector names on the Qdrant collection when a real embedder is active.
DENSE_VECTOR_NAME = "dense"
SPARSE_VECTOR_NAME = "sparse"
# Reciprocal-rank-fusion constant for hybrid dense+sparse search.
RRF_K = 60

# Provenance labels reported through CompendiumRagIndex.retrieval_provenance
# and surfaced verbatim as the lore-lookup route's ``retrieval`` field.
PROVENANCE_HASH_FALLBACK = "qdrant-hash-fallback"
PROVENANCE_DENSE = "qdrant-dense"
PROVENANCE_DENSE_SPARSE = "qdrant-dense-sparse"

# From database/qdrant/01_collections_config.json (see load_collection_config).
COLLECTION_NAME = "compendium_rules"
DEFAULT_EMBED_DIM = 1536
DEFAULT_DISTANCE = "Cosine"
CONFIG_REL_PARTS = ("database", "qdrant", "01_collections_config.json")

SYSTEM_ID = "srd_5_2"
KIND_SPELL = "spell"
KIND_MONSTER = "monster"
KIND_MAGIC_ITEM = "magic_item"
BATCH_SIZE = 128
SNIPPET_LEN = 140
_NAME_REPEAT = 2  # name terms weigh double in the lexical hash

_TOKEN_RE = re.compile(r"[a-z0-9']+")
_UUID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "aethertable:compendium")


class QdrantRequestError(RuntimeError):
    """A non-2xx or malformed response from the Qdrant REST API."""


# ---------------------------------------------------------------------------
# Collection config (docker-compose-mounted)
# ---------------------------------------------------------------------------


def load_collection_config(
    config_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Return the ``compendium_rules`` entry from the collections config file.

    Returns ``None`` when the file is missing or does not declare the
    collection — callers then fall back to the same values as defaults.
    """
    if config_path is None:
        # .../lore/compendium_rag.py -> lore -> vtt_orchestrator -> python
        # -> repo root
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__)))))
        config_path = os.path.join(root, *CONFIG_REL_PARTS)
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except (OSError, ValueError):
        return None
    for entry in config.get("collections", []):
        if entry.get("name") == COLLECTION_NAME:
            return entry
    return None


# ---------------------------------------------------------------------------
# Embedding backends
#
# A backend owns the whole vector contract: how documents/queries become
# dense vectors (and optionally sparse ones), which provenance label the
# route must report, and whether the Qdrant collection uses named vectors.
# The deterministic hash backend is always importable; the fastembed backend
# imports its dependency lazily so absence degrades instead of crashing.
# ---------------------------------------------------------------------------


def _bucket(token: str, dim: int) -> int:
    digest = hashlib.md5(token.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % dim


def hash_embed(text: str, dim: int = DEFAULT_EMBED_DIM) -> List[float]:
    """Deterministic hashed bag-of-words vector, L2-normalized.

    Lexical, not semantic: token overlap drives similarity. See the module
    docstring for why this is an honest stand-in for real embeddings.
    """
    vector = [0.0] * dim
    for token in _TOKEN_RE.findall((text or "").lower()):
        vector[_bucket(token, dim)] += 1.0
    norm = math.sqrt(sum(v * v for v in vector))
    if norm > 0.0:
        vector = [v / norm for v in vector]
    return vector


class HashEmbeddingBackend:
    """The documented non-semantic fallback embedder.

    Provenance ``"qdrant-hash-fallback"``: when this backend serves results,
    similarity is term overlap and callers must be able to tell.
    """

    label = PROVENANCE_HASH_FALLBACK
    named_vectors = False       # legacy single-vector collection layout
    supports_sparse = False

    def __init__(self, dim: int = DEFAULT_EMBED_DIM):
        self.dim = dim

    def embed_documents(self, texts: Sequence[str]) -> List[List[float]]:
        # Title-ish terms are repeated for extra weight, matching the
        # historical behaviour of the entry text builder.
        return [
            hash_embed(
                " ".join([text] + [text] * (_NAME_REPEAT - 1)), self.dim
            )
            for text in texts
        ]

    def embed_query(self, query: str) -> List[float]:
        """Public alias so callers embed queries with the identical function."""
        return hash_embed(query, self.dim)

    def embed_sparse_documents(self, texts):
        raise NotImplementedError("hash backend has no sparse vectors")

    def embed_sparse_query(self, query: str):
        raise NotImplementedError("hash backend has no sparse vectors")


def _sparse_to_rest(sparse_embedding) -> Dict[str, Any]:
    """Convert a fastembed SparseEmbedding into Qdrant REST JSON."""
    return {
        "indices": [int(i) for i in sparse_embedding.indices],
        "values": [float(v) for v in sparse_embedding.values],
    }


class FastEmbedBackend:
    """Real embeddings via qdrant/fastembed (optional dependency).

    Dense is always produced; sparse is best-effort — if the sparse model
    cannot be loaded the backend still works dense-only and relabels
    provenance to ``"qdrant-dense"``. Model weights download from HuggingFace
    on first init, which is exactly why this backend is env-gated off by
    default and why any failure here must fall back to :class:`HashEmbeddingBackend`
    rather than breaking startup.
    """

    named_vectors = True

    def __init__(
        self,
        dense_model: str = DEFAULT_DENSE_MODEL,
        sparse_model: Optional[str] = DEFAULT_SPARSE_MODEL,
    ):
        # Imported here so `pip install vtt-orchestrator` without the
        # [embeddings] extra keeps working everywhere else in the codebase.
        from fastembed import TextEmbedding

        self.dense_model_name = dense_model
        self.sparse_model_name = None
        self._dense = TextEmbedding(model_name=dense_model)

        self.supports_sparse = False
        if sparse_model:
            try:
                from fastembed import SparseTextEmbedding

                self._sparse = SparseTextEmbedding(model_name=sparse_model)
                self.sparse_model_name = sparse_model
                self.supports_sparse = True
            except Exception as exc:  # noqa: BLE001 - degrade, never crash startup
                logger.warning(
                    "compendium rag: fastembed sparse model %r unavailable "
                    "(%s); continuing DENSE-ONLY with provenance %r",
                    sparse_model, exc, PROVENANCE_DENSE,
                )

        self.label = (
            PROVENANCE_DENSE_SPARSE if self.supports_sparse else PROVENANCE_DENSE
        )
        # Dimension consistency contract: probe once at init so collection
        # creation uses the true model dimensionality.
        probe = next(iter(self._dense.embed(["dimension probe"])))
        self.dim = len(probe)

    def embed_documents(self, texts: Sequence[str]) -> List[List[float]]:
        return [[float(x) for x in vec]
                for vec in self._dense.embed(list(texts))]

    def embed_query(self, query: str) -> List[float]:
        # query_embed applies the asymmetric-query handling some models
        # (e.g. bge) recommend for retrieval; fall back if unavailable.
        embedder = getattr(self._dense, "query_embed", None)
        if embedder is None:
            embedder = self._dense.embed
        return [float(x) for x in next(iter(embedder([query])))]

    def embed_sparse_documents(self, texts: Sequence[str]):
        if not self.supports_sparse:
            return None
        return [_sparse_to_rest(se)
                for se in self._sparse.embed(list(texts))]

    def embed_sparse_query(self, query: str):
        if not self.supports_sparse:
            return None
        return _sparse_to_rest(next(iter(self._sparse.embed([query]))))


def build_embedding_backend(
    env: Optional[Dict[str, str]] = None,
) -> HashEmbeddingBackend:
    """Select the embedding backend per env, honestly.

    ``QDRANT_EMBEDDINGS`` truthy attempts fastembed; ANY failure (package
    absent, no network for weights, ONNX runtime missing) logs ONE warning
    and returns the hash backend with its honest
    ``qdrant-hash-fallback`` label.
    """
    environment = os.environ if env is None else env
    if str(environment.get(QDRANT_EMBEDDINGS_ENV, "")).strip().lower() \
            not in {"1", "true", "yes", "on"}:
        return HashEmbeddingBackend()
    try:
        backend = FastEmbedBackend(
            dense_model=environment.get(
                FASTEMBED_DENSE_MODEL_ENV, DEFAULT_DENSE_MODEL),
            sparse_model=environment.get(
                FASTEMBED_SPARSE_MODEL_ENV, DEFAULT_SPARSE_MODEL),
        )
    except Exception as exc:  # noqa: BLE001 - offline/no-deps is expected
        logger.warning(
            "compendium rag: fastembed unavailable (%s); falling back to the "
            "deterministic lexical-hash embedder with provenance %r — these "
            "are NOT semantic embeddings",
            exc, PROVENANCE_HASH_FALLBACK,
        )
        return HashEmbeddingBackend()
    logger.info(
        "compendium rag: real embeddings active via fastembed "
        "(dense=%s%s), provenance %r",
        backend.dense_model_name,
        f", sparse={backend.sparse_model_name}" if backend.supports_sparse
        else ", sparse=None",
        backend.label,
    )
    return backend


# ---------------------------------------------------------------------------
# Entry normalization: loaded JSON lists -> points + display facts
# ---------------------------------------------------------------------------


def _snippet(text: str) -> str:
    text = text or ""
    return text[:SNIPPET_LEN] + ("..." if len(text) > SNIPPET_LEN else "")


def _level_name(level: Any) -> str:
    level = level if isinstance(level, int) else 0
    return "Cantrip" if level == 0 else f"Level {level}"


def _point_id(kind: str, key: str) -> str:
    return str(uuid.uuid5(_UUID_NAMESPACE, f"{kind}:{key}"))


def _normalize_spell(spell: Dict[str, Any]) -> Dict[str, Any]:
    name = spell.get("name", "")
    school = spell.get("school", "")
    description = spell.get("description", "")
    classes = [str(c) for c in spell.get("classes", [])]
    text = " ".join([name, school] + classes + [description])
    return {
        "kind": KIND_SPELL,
        "id": _point_id(KIND_SPELL, str(spell.get("id") or name)),
        "text": text,
        "payload": {
            "category": KIND_SPELL,
            "system_id": SYSTEM_ID,
            "tags": classes,
            "name": name,
            "school": school,
            "level": spell.get("level", 0),
            "description": description,
        },
    }


def _normalize_monster(monster: Dict[str, Any]) -> Dict[str, Any]:
    name = monster.get("name", "")
    creature_type = monster.get("creature_type", "")
    action_names = [
        str(a.get("name", "")) for a in monster.get("actions", [])
    ]
    immunities = [str(d) for d in (monster.get("damage_immunities") or [])]
    resistances = [str(d) for d in (monster.get("damage_resistances") or [])]
    text = " ".join(
        [name, creature_type, str(monster.get("alignment", "")),
         str(monster.get("category", ""))]
        + action_names + immunities + resistances
    )
    return {
        "kind": KIND_MONSTER,
        "id": _point_id(KIND_MONSTER, str(monster.get("id") or name)),
        "text": text,
        "payload": {
            "category": KIND_MONSTER,
            "system_id": SYSTEM_ID,
            "tags": ([creature_type] if creature_type else []),
            "name": name,
            "ac": monster.get("ac"),
            "hp": monster.get("hp"),
            "challenge_rating": monster.get("challenge_rating"),
            "action_names": action_names[:3],
        },
    }


def _normalize_magic_item(item: Dict[str, Any]) -> Dict[str, Any]:
    name = item.get("name", "")
    item_type = item.get("item_type", "")
    rarity = item.get("rarity", "")
    description = item.get("description", "")
    text = " ".join([name, item_type, rarity, description])
    return {
        "kind": KIND_MAGIC_ITEM,
        "id": _point_id(KIND_MAGIC_ITEM, str(item.get("id") or name)),
        "text": text,
        "payload": {
            "category": KIND_MAGIC_ITEM,
            "system_id": SYSTEM_ID,
            "tags": [t for t in (item_type, rarity) if t],
            "name": name,
            "item_type": item_type,
            "rarity": rarity,
            "description": description,
        },
    }


def build_points(spells, monsters, magic_items) -> List[Dict[str, Any]]:
    """Normalize the loaded compendium lists into upsertable Qdrant points."""
    entries: List[Dict[str, Any]] = []
    for spell in spells or []:
        entries.append(_normalize_spell(spell))
    for monster in monsters or []:
        entries.append(_normalize_monster(monster))
    for item in magic_items or []:
        entries.append(_normalize_magic_item(item))
    return entries


def fact_from_payload(payload: Dict[str, Any], score: float) -> Dict[str, Any]:
    """Rebuild a lore-lookup fact dict from a stored point payload."""
    kind = payload.get("category", "")
    fact: Dict[str, Any] = {"type": kind, "kind": kind}
    if kind == KIND_SPELL:
        fact.update({
            "name": payload.get("name", ""),
            "level_name": _level_name(payload.get("level")),
            "school": payload.get("school", ""),
            "snippet": _snippet(payload.get("description", "")),
        })
    elif kind == KIND_MONSTER:
        fact.update({
            "name": payload.get("name", ""),
            "ac": payload.get("ac"),
            "hp": payload.get("hp"),
            "challenge_rating": payload.get("challenge_rating"),
            "action_names": payload.get("action_names", []),
        })
    elif kind == KIND_MAGIC_ITEM:
        fact.update({
            "name": payload.get("name", ""),
            "rarity": payload.get("rarity", ""),
            "item_type": payload.get("item_type", ""),
            "snippet": _snippet(payload.get("description", "")),
        })
    else:
        fact["name"] = payload.get("name", "")
    fact["score"] = round(float(score), 6)
    return fact


def _rrf_fuse(
    dense_hits: Sequence[Dict[str, Any]],
    sparse_hits: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Reciprocal-rank fusion of the dense and sparse legs (Cormack et al.).

    score(d) = sum over legs of 1 / (RRF_K + rank). Hits found by both legs
    — the genuinely hybrid signal — accumulate from each.
    """
    fused: Dict[str, Dict[str, Any]] = {}
    for hits in (dense_hits, sparse_hits):
        for rank, hit in enumerate(hits, start=1):
            point_id = str(hit.get("id", ""))
            if not point_id:
                continue
            entry = fused.setdefault(
                point_id, {"payload": hit.get("payload") or {}, "score": 0.0}
            )
            entry["score"] += 1.0 / (RRF_K + rank)
    ranked = sorted(fused.values(), key=lambda e: e["score"], reverse=True)
    for entry in ranked:
        entry["score"] = round(entry["score"], 6)
    return ranked


class CompendiumRagIndex:
    """Hybrid-RAG index over the SRD compendium, served from Qdrant REST.

    Lifecycle: construct once at startup with the already-loaded JSON lists,
    call :meth:`index` (via :func:`build_compendium_rag_index`) to probe +
    create + upsert, then let routes call :meth:`search`. ``available`` is the
    single honest flag the route layer consults for provenance.
    """

    def __init__(
        self,
        spells: Sequence[Dict[str, Any]],
        monsters: Sequence[Dict[str, Any]],
        magic_items: Sequence[Dict[str, Any]],
        host: Optional[str] = None,
        client: Optional[httpx.Client] = None,
        timeout_seconds: float = 2.0,
        batch_size: int = BATCH_SIZE,
        collection_config: Optional[Dict[str, Any]] = None,
        embedding_backend: Optional[Any] = None,
    ):
        self.host = (
            host or os.environ.get(QDRANT_HOST_ENV) or DEFAULT_QDRANT_HOST
        ).rstrip("/")
        self._client = client or httpx.Client(timeout=timeout_seconds)
        self._batch_size = max(1, batch_size)

        config = (
            collection_config
            if collection_config is not None
            else load_collection_config()
        )
        vectors = (config or {}).get("vectors", {})
        self.collection_name = COLLECTION_NAME
        self.distance = vectors.get("distance", DEFAULT_DISTANCE)
        self.optimizers_config = (config or {}).get("optimizers_config")
        # The hash backend keeps the config file's declared vector size so the
        # docker-compose-created collection needs no migration; a real embedder
        # dictates its own model dimensionality instead.
        self.embedding_backend = embedding_backend or HashEmbeddingBackend(
            dim=int(vectors.get("size", DEFAULT_EMBED_DIM))
        )
        self.vector_size = self.embedding_backend.dim
        # Keyword fields from the config's payload_schema that we actually
        # filter on get explicit keyword indexes at startup.
        declared_fields = set((config or {}).get("payload_schema") or {})
        self.index_fields = sorted(declared_fields & {"category", "system_id",
                                                      "tags"})

        self.points = build_points(spells, monsters, magic_items)
        self.available = False

    @property
    def retrieval_provenance(self) -> str:
        """Honest label for what kind of vectors actually served results."""
        return self.embedding_backend.label

    # ------------------------------------------------------------------
    # Startup indexing
    # ------------------------------------------------------------------

    def index(self) -> bool:
        """Probe, ensure the collection, and upsert the whole corpus.

        Sets ``available`` True/False; never raises. Returns True only when
        Qdrant answered every step and the corpus is searchable.
        """
        try:
            response = self._client.get(
                self._url(f"/collections/{self.collection_name}")
            )
            if response.status_code == 404:
                # docker-compose creates it from 01_collections_config.json;
                # a missing collection means we create it with the same
                # config-file-derived settings.
                self._create_collection()
            elif response.status_code // 100 != 2:
                raise QdrantRequestError(
                    f"probe returned HTTP {response.status_code}"
                )
            for field in self.index_fields:
                self._create_payload_index(field)
            self._upsert_all()
        except (httpx.HTTPError, ValueError, KeyError, QdrantRequestError) as exc:
            logger.warning(
                "compendium rag: substring fallback (QDRANT_ENABLED=1 but "
                "Qdrant at %s failed startup indexing: %s)",
                self.host, exc,
            )
            self.available = False
            return False
        self.available = True
        return True

    def probe(self) -> bool:
        """True when the Qdrant REST endpoint answers at startup."""
        try:
            response = self._client.get(self._url("/collections"))
        except httpx.HTTPError:
            return False
        return response.status_code < 500

    def _create_collection(self) -> None:
        if self.embedding_backend.named_vectors:
            # Qdrant named-vectors layout: a dense vector plus, when the
            # backend provides one, a sparse vector in the same points.
            body: Dict[str, Any] = {
                "vectors": {
                    DENSE_VECTOR_NAME: {
                        "size": self.vector_size,
                        "distance": self.distance,
                    },
                },
            }
            if self.embedding_backend.supports_sparse:
                body["sparse_vectors"] = {SPARSE_VECTOR_NAME: {}}
        else:
            body = {"vectors": {"size": self.vector_size,
                                "distance": self.distance}}
        if self.optimizers_config:
            body["optimizers_config"] = self.optimizers_config
        response = self._client.put(
            self._url(f"/collections/{self.collection_name}"), json=body
        )
        if response.status_code // 100 != 2:
            raise QdrantRequestError(
                f"collection create returned HTTP {response.status_code}"
            )

    def _create_payload_index(self, field: str) -> None:
        response = self._client.put(
            self._url(f"/collections/{self.collection_name}/index/{field}"),
            json={"field_schema": "keyword"},
        )
        if response.status_code // 100 != 2:
            raise QdrantRequestError(
                f"payload index {field!r} returned HTTP {response.status_code}"
            )

    def _upsert_all(self) -> None:
        texts = [point["text"] for point in self.points]
        dense_vectors = self.embedding_backend.embed_documents(texts)
        sparse_vectors = (
            self.embedding_backend.embed_sparse_documents(texts)
            if self.embedding_backend.supports_sparse else None
        )
        embedded = []
        for index, point in enumerate(self.points):
            vector: Any
            if self.embedding_backend.named_vectors:
                vector = {DENSE_VECTOR_NAME: dense_vectors[index]}
                if sparse_vectors is not None:
                    vector[SPARSE_VECTOR_NAME] = sparse_vectors[index]
            else:
                vector = dense_vectors[index]
            embedded.append({
                "id": point["id"],
                "vector": vector,
                "payload": point["payload"],
            })
        for start in range(0, len(embedded), self._batch_size):
            batch = embedded[start:start + self._batch_size]
            response = self._client.put(
                self._url(f"/collections/{self.collection_name}/points"),
                json={"points": batch, "wait": True},
            )
            if response.status_code // 100 != 2:
                raise QdrantRequestError(
                    f"upsert returned HTTP {response.status_code}"
                )

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        k: int = 5,
        kinds: Optional[Sequence[str]] = None,
    ) -> Optional[List[Dict[str, Any]]]:
        """Top-K scored compendium entries, or ``None`` when Qdrant can't serve.

        ``None`` means "use the substring scan"; the route decides whether that
        is plain substring (index unavailable) or ``substring_fallback``
        (transient failure). An empty list is a legitimate "no hits".
        """
        if not self.available:
            return None

        fetch = min(max(k * (2 if self.embedding_backend.supports_sparse
                             else 1), k), 100)
        filter_clause = None
        if kinds:
            filter_clause = {
                "must": [{
                    "key": "category",
                    "match": {"any": sorted(set(kinds))},
                }],
            }

        try:
            dense_hits = self._search_dense(query, fetch, filter_clause)
            sparse_hits: List[Dict[str, Any]] = []
            if self.embedding_backend.supports_sparse:
                sparse_hits = self._search_sparse(query, fetch, filter_clause)
        except (httpx.HTTPError, ValueError, QdrantRequestError) as exc:
            logger.warning(
                "compendium rag: request-time failure (%s); degrading this "
                "lookup to the substring scan", exc,
            )
            return None

        hits = (
            _rrf_fuse(dense_hits, sparse_hits)
            if sparse_hits else dense_hits
        )
        return [
            fact_from_payload(hit["payload"], hit["score"])
            for hit in hits[:max(1, k)]
        ]

    def _post_search(self, body: Dict[str, Any]) -> List[Dict[str, Any]]:
        response = self._client.post(
            self._url(f"/collections/{self.collection_name}/points/search"),
            json=body,
        )
        if response.status_code // 100 != 2:
            raise QdrantRequestError(
                f"search returned HTTP {response.status_code}"
            )
        return response.json().get("result") or []

    def _search_dense(
        self, query: str, limit: int, filter_clause: Optional[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        body: Dict[str, Any] = {
            "limit": max(1, limit),
            "with_payload": True,
        }
        if self.embedding_backend.named_vectors:
            body["vector"] = {
                "name": DENSE_VECTOR_NAME,
                "vector": self.embedding_backend.embed_query(query),
            }
        else:
            body["vector"] = self.embedding_backend.embed_query(query)
        if filter_clause:
            body["filter"] = filter_clause
        return self._post_search(body)

    def _search_sparse(
        self, query: str, limit: int, filter_clause: Optional[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        sparse_query = self.embedding_backend.embed_sparse_query(query)
        if not sparse_query or not sparse_query.get("indices"):
            # An out-of-vocabulary query legitimately produces no sparse
            # terms; the dense leg alone then serves the lookup.
            return []
        body: Dict[str, Any] = {
            "vector": {
                "name": SPARSE_VECTOR_NAME,
                "vector": sparse_query,
            },
            "limit": max(1, limit),
            "with_payload": True,
        }
        if filter_clause:
            body["filter"] = filter_clause
        return self._post_search(body)

    # ------------------------------------------------------------------

    def _url(self, path: str) -> str:
        return self.host + path


def build_compendium_rag_index(
    spells: Sequence[Dict[str, Any]],
    monsters: Sequence[Dict[str, Any]],
    magic_items: Sequence[Dict[str, Any]],
    env: Optional[Dict[str, str]] = None,
    host: Optional[str] = None,
    client: Optional[httpx.Client] = None,
) -> CompendiumRagIndex:
    """Select the retrieval backend ONCE at startup.

    ``QDRANT_ENABLED`` truthy plus successful indexing → a live index;
    anything else → the same object with ``available=False`` and ONE honest
    log, so the route keeps serving the substring scan without branching.
    The embedding backend is chosen separately via ``QDRANT_EMBEDDINGS``:
    real fastembed dense(+sparse) vectors when opted in AND loadable, the
    hash pseudo-embedder (provenance ``qdrant-hash-fallback``) otherwise —
    never silently.
    """
    environment = os.environ if env is None else env
    enabled = str(environment.get(QDRANT_ENABLED_ENV, "")).strip().lower() in {
        "1", "true", "yes", "on"
    }
    index = CompendiumRagIndex(
        spells, monsters, magic_items, host=host, client=client,
        embedding_backend=build_embedding_backend(environment),
    )
    if not enabled:
        logger.info(
            "compendium rag: substring fallback (%s unset/false) — lore "
            "lookups use the deterministic substring scan, no vector search",
            QDRANT_ENABLED_ENV,
        )
        return index

    count = len(index.points)
    if index.index():
        logger.info(
            "compendium rag: indexed %d compendium entries into %s@%s "
            "(embeddings=%s, %d dims%s)",
            count, index.collection_name, index.host,
            index.embedding_backend.label, index.vector_size,
            ", hybrid dense+sparse"
            if index.embedding_backend.supports_sparse else "",
        )
    # On failure CompendiumRagIndex.index() has already emitted the ONE honest
    # fallback warning for this startup — do not double-log.
    return index
