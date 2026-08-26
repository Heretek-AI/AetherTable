"""Per-session Lines & Veils safety boundary registry (GOALS.md Pillar 11).

The X-Card (``simulation/safety_gateway.py``) handles mid-play vetoes. This
module is the OTHER half of the pillar: content boundaries declared BEFORE
play —

* a **line** is a hard limit: this content never enters the game at all;
* a **veil** is a fade-to-black topic: it may exist in the fiction, but is
  never depicted on screen.

Storage model — an honest choice
--------------------------------
Boundaries live in an IN-PROCESS dict keyed by engine session id, instantiated
as a module singleton in ``server.py`` (``safety_boundaries``). This mirrors
how the gateway already holds session-scoped shared state today:
``_NPC_REGISTRY``, ``spotlight_tracker``, ``lore_graph`` and the X-card
intervention list are all module state that deliberately does not survive a
gateway restart (see the "campaign-scoped gateway state durability" block in
``server.py`` for the survey that drew exactly this line). Wiring these into
the durable campaign-saves snapshot was considered and rejected: unlike quest
canon, boundaries are cheap to re-declare, they are negotiated in the lobby
BEFORE the table starts, and persisting sensitive line topics to disk creates
a new at-rest exposure for the most privacy-sensitive strings the system
holds. The trade-off, stated plainly: a gateway restart drops declared
boundaries until the table re-declares them.

Redaction lives HERE, not in the route layer, so every consumer gets the same
guarantee: veil topics are shared openly with the whole table; LINE topics are
visible verbatim only to gm/admin (who must adjudicate against the full list)
and to the participant who filed them. Everyone else sees ``[redacted]``.
"""

import secrets
import time
from typing import Any, Dict, List, Optional

# A topic label, not an essay: 120 chars covers any real boundary phrase.
BOUNDARY_TOPIC_MAX_LEN = 120

REDACTED_TOPIC = "[redacted]"

_KINDS = ("line", "veil")


class BoundaryError(Exception):
    """Validation failure carrying a machine-readable code; routes map this
    to a 422 whose detail dict exposes ``error`` verbatim."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize_topic(topic: Any) -> str:
    if not isinstance(topic, str):
        raise BoundaryError(
            "BOUNDARY_TOPIC_REQUIRED", "topic must be a non-empty string"
        )
    normalized = topic.strip()
    if not normalized:
        raise BoundaryError(
            "BOUNDARY_TOPIC_REQUIRED",
            "A lines & veils topic cannot be blank.",
        )
    if len(normalized) > BOUNDARY_TOPIC_MAX_LEN:
        raise BoundaryError(
            "BOUNDARY_TOPIC_TOO_LONG",
            f"Topics cap at {BOUNDARY_TOPIC_MAX_LEN} characters "
            f"(got {len(normalized)}); phrase the boundary as a short label.",
        )
    return normalized


class SafetyBoundaryRegistry:
    """In-memory per-session registry of line and veil declarations."""

    def __init__(self) -> None:
        # engine_session_id -> {"line": [entry...], "veil": [entry...]}
        self._sessions: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}

    def add(
        self, session_id: str, kind: str, topic: Any, added_by: str
    ) -> Dict[str, Any]:
        """Records one declaration; raises BoundaryError(BOUNDARY_DUPLICATE)
        when the SAME list already carries the topic case-insensitively."""
        if kind not in _KINDS:
            raise ValueError(f"unknown boundary kind {kind!r}")
        normalized = _normalize_topic(topic)
        bucket = self._sessions.setdefault(session_id, {k: [] for k in _KINDS})
        lowered = normalized.casefold()
        for existing in bucket[kind]:
            if existing["topic"].casefold() == lowered:
                raise BoundaryError(
                    "BOUNDARY_DUPLICATE",
                    f"'{normalized}' is already declared as a {kind} for this "
                    "session.",
                )
        entry = {
            "entry_id": f"bnd_{secrets.token_hex(6)}",
            "kind": kind,
            "topic": normalized,
            "added_by": added_by,
            "created_at": time.time(),
        }
        bucket[kind].append(entry)
        return dict(entry)

    def remove(self, session_id: str, kind: str, entry_id: str) -> bool:
        """Deletes one declaration by id; False when the id is unknown."""
        bucket = self._sessions.get(session_id)
        if bucket is None or kind not in bucket:
            return False
        before = len(bucket[kind])
        bucket[kind] = [e for e in bucket[kind] if e["entry_id"] != entry_id]
        return len(bucket[kind]) < before

    def view(
        self, session_id: str, viewer_id: str = "", privileged: bool = False
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Returns ``{"lines": [...], "veils": [...]}`` for ONE viewer.

        Veils always carry their real topic. Line topics are verbatim only
        for privileged viewers (gm/admin) or the filing participant;
        everyone else sees REDACTED_TOPIC while entry_id / added_by /
        created_at stay intact so clients can still render WHO declared a
        boundary exists without WHAT it says.
        """
        bucket = self._sessions.get(session_id) or {k: [] for k in _KINDS}
        return {
            "lines": [
                self._project(entry, viewer_id, privileged)
                for entry in bucket.get("line", [])
            ],
            "veils": [dict(entry) for entry in bucket.get("veil", [])],
        }

    @staticmethod
    def _project(
        entry: Dict[str, Any], viewer_id: str, privileged: bool
    ) -> Dict[str, Any]:
        projected = dict(entry)
        if not privileged and entry["added_by"] != viewer_id:
            projected["topic"] = REDACTED_TOPIC
        return projected

    def clear(self, session_id: Optional[str] = None) -> None:
        """Drops one session's declarations, or everything when unspecified
        (test isolation)."""
        if session_id is None:
            self._sessions.clear()
        else:
            self._sessions.pop(session_id, None)

    def summary(
        self, session_id: str, viewer_id: str, privileged: bool
    ) -> Dict[str, Dict[str, int]]:
        """Participant-safe counts ONLY — never the topics, actors, or times.

        Privacy contract (mirrored by tests in tests/test_safety_boundaries.py):

        * ``you`` counts entries the CALLER themselves declared (lines AND
          veils). It is the only field that exposes any signal about a
          specific person, and that signal is about the caller themselves.
        * ``others`` counts entries declared by OTHER participants. For a
          non-staff viewer this collapses lines from N other participants
          into a single integer — the route cannot say whether N=3 means
          three players declared one line each, or one player declared
          three, because that would be a presence oracle.
        * ``redacted.lines`` is the count of OTHER participants' lines that
          appear redacted to THIS caller. For non-staff viewers that equals
          ``others.lines`` (every other line is redacted to a player). For
          gm/admin it is always 0 because staff see every line verbatim and
          nothing is ever redacted in their view.
        * Empty/unknown registry yields all zeros — the summary is never a
          404, because the route already validated the session exists in
          ``_boundary_gate``.
        """
        bucket = self._sessions.get(session_id) or {k: [] for k in _KINDS}
        you_lines = 0
        you_veils = 0
        others_lines = 0
        others_veils = 0
        for entry in bucket.get("line", []):
            if entry["added_by"] == viewer_id:
                you_lines += 1
            else:
                others_lines += 1
        for entry in bucket.get("veil", []):
            if entry["added_by"] == viewer_id:
                you_veils += 1
            else:
                others_veils += 1
        redacted_lines = 0 if privileged else others_lines
        return {
            "you": {"lines": you_lines, "veils": you_veils},
            "others": {"lines": others_lines, "veils": others_veils},
            "redacted": {"lines": redacted_lines},
        }
