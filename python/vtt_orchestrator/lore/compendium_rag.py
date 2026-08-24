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

EMBEDDING HONESTY: this module ships a deterministic *lexical-hash* embedder,
NOT a semantic embedding model. Text tokens are hashed into fixed-size
buckets (MD5-derived, so vectors are stable across processes/restarts —
Python's salted ``hash()`` would not be), counted as bag-of-words, and
L2-normalized. Similarity therefore measures term overlap, not meaning; two
entries about "fire" share no signal with one about "flame" unless the words
co-occur. Swapping in a real embedding model is an upgrade path that touches
only :func:`hash_embed` plus a re-index — the collection contract, search API,
and fallback policy are unchanged. The configured 1536 dimensions match the
config file so a drop-in model replacement needs no collection migration.

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
# Deterministic lexical-hash embedder (documented non-semantic stand-in)
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


def _embed_entry_text(text: str, dim: int) -> List[float]:
    """Embed with name terms repeated for extra weight on titles."""
    return hash_embed(" ".join([text] + [text] * (_NAME_REPEAT - 1)), dim)


def embed_query(query: str, dim: int = DEFAULT_EMBED_DIM) -> List[float]:
    """Public alias so callers embed queries with the identical function."""
    return hash_embed(query, dim)


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
        self.vector_size = int(vectors.get("size", DEFAULT_EMBED_DIM))
        self.distance = vectors.get("distance", DEFAULT_DISTANCE)
        self.optimizers_config = (config or {}).get("optimizers_config")
        # Keyword fields from the config's payload_schema that we actually
        # filter on get explicit keyword indexes at startup.
        declared_fields = set((config or {}).get("payload_schema") or {})
        self.index_fields = sorted(declared_fields & {"category", "system_id",
                                                      "tags"})

        self.points = build_points(spells, monsters, magic_items)
        self.available = False

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
        body: Dict[str, Any] = {
            "vectors": {"size": self.vector_size, "distance": self.distance},
        }
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
        embedded = [
            {
                "id": point["id"],
                "vector": _embed_entry_text(point["text"], self.vector_size),
                "payload": point["payload"],
            }
            for point in self.points
        ]
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

        body: Dict[str, Any] = {
            "vector": embed_query(query, self.vector_size),
            "limit": max(1, k),
            "with_payload": True,
        }
        if kinds:
            body["filter"] = {
                "must": [{
                    "key": "category",
                    "match": {"any": sorted(set(kinds))},
                }],
            }

        try:
            response = self._client.post(
                self._url(f"/collections/{self.collection_name}/points/search"),
                json=body,
            )
            if response.status_code // 100 != 2:
                raise QdrantRequestError(
                    f"search returned HTTP {response.status_code}"
                )
            hits = response.json().get("result") or []
        except (httpx.HTTPError, ValueError, QdrantRequestError) as exc:
            logger.warning(
                "compendium rag: request-time failure (%s); degrading this "
                "lookup to the substring scan", exc,
            )
            return None

        return [
            fact_from_payload(hit.get("payload") or {}, hit.get("score", 0.0))
            for hit in hits
        ]

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
    """
    environment = os.environ if env is None else env
    enabled = str(environment.get(QDRANT_ENABLED_ENV, "")).strip().lower() in {
        "1", "true", "yes", "on"
    }
    index = CompendiumRagIndex(spells, monsters, magic_items,
                               host=host, client=client)
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
            "(lexical-hash embeddings, %d dims)",
            count, index.collection_name, index.host, index.vector_size,
        )
    # On failure CompendiumRagIndex.index() has already emitted the ONE honest
    # fallback warning for this startup — do not double-log.
    return index
