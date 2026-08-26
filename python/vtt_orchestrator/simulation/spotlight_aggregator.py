"""Server-side per-session speaking-score aggregation (GOALS.md Pillar 11).

WHAT THIS IS
------------
The gateway's honest complement to the client-side CRDT speech ledger
(``client/src/sync/speech_ledger.ts`` + ``yjs_doc_client.ts``). Iteration 31
made the browser meter LOCAL-ONLY (each browser's Silero VAD hears only its
own mic) and the client CRDT ledger genuinely CONVERGES per-peer VAD segments
room-wide — but that converged Y.Doc lives on client replicas and a Node
y-sync relay, NOT in the python orchestrator. There is no python read-path
into the Y.Doc, so the server cannot derive room-wide speaking from the CRDT
ledger without new transport wiring (out of scope for the python-only
iteration). The honest aggregation the server CAN do is derived from what
participants self-report: each well-behaved client POSTs its OWN closed VAD
burst (``duration_ms``, ``occurred_at``) to the report channel, and this
module folds those reports into a per-session decayed score table.

HONESTY CONTRACT (stated plainly, mirrors server.py route docstrings)
---------------------------------------------------------------------
* Any nonzero score on this server originates from a client SELF-REPORT.
  An adversarial client can POST any ``duration_ms`` it likes beneath its own
  seat (the route enforces seat == caller for non-staff, and the seat must be
  a real lobby member, but those are soft anti-spoof rules, NOT a security
  boundary). The aggregation is insight tooling for the DM — "who has the
  microphone said little recently" — and must never be treated as an
  authentication or moderation boundary.
* Scores are what a client SAID happened, not what a microphone measured.
  The minute a client is wired to publish its converged CRDT ledger (or the
  python server grows a y-sync relay read-path), the source of these reports
  can become genuinely remote-aware — the route surface stays the same.

STORAGE DECISION (documented precedent, not new machinery)
----------------------------------------------------------
The score table is PROCESS-MEMORY-ONLY, keyed ``session_id -> {user_id:
(score, last_update)}``, exactly the storage model ``SafetyBoundaryRegistry``
(in ``vtt_orchestrator/safety.py``) and ``_NPC_REGISTRY`` already use, and
about which ``server.py`` has already drawn the line ("campaign-scoped
gateway state durability" block): session-scoped singletons deliberately do
not survive a gateway restart. The trade-off, restated plainly: a restart
drops the rolling scores until participants report again — acceptable because
scores are cheap to rebuild from the next few minutes of speaking and are by
definition transient. Like ``ratelimit.py``, N replicas each hold their own
table (a redis-backed cross-replica table would be the fix; none exists yet).

DECAY MODEL
-----------
Each accepted report contributes ``duration_s * 0.5 ** (age / HALF_LIFE_MS)``
seconds, where ``age = max(0, received_now - occurred_at)``. The clamp keeps
a future-dated (clock-skewed or spoofed) report from beating the raw
duration it claims: at worst it counts in full at receipt and then decays
normally as wall-clock passes it. There is deliberately NO hard cutoff window
— the half-life decay IS the rolling behavior (a burst from eight minutes ago
barely registers next to one from thirty seconds ago), so "rolling window"
here means the exponential-decay window, not a bitmask crop. Entries whose
decayed score falls below ``MIN_VISIBLE_SCORE`` and sessions whose newest
report is older than ``prune_half_lives`` half-lives are swept so the
in-process table cannot grow without bound (mirrors the rate limiter's stale
key sweep). The half-life mirrors the client ledger's ``DEFAULT_HALF_LIFE_MS``
so the server view and the client view of the same speaking decay in step.

``is_quiet`` THRESHOLD
----------------------
A seat is flagged quiet when its decayed score is STRICTLY below the session's
low-water line, ``mean - one population standard deviation``, where mean and
sigma are computed over the session's NONZERO score rows (a seat reporting
nothing contributes no measurement to the spread). Seats with zero measured
speech sit at score 0.0 and are compared against that line — so once anyone
at the table has spoken inside the decay horizon, seats that have not are
almost always flagged quiet (that is the intended DM signal). Degenerate
regimes, stated honestly: when NOBODY has a nonzero score there is no spread
to measure, so no seat is flagged; when exactly one seat has a nonzero score
its sigma is 0, the low-water line equals its score, and every silent seat is
flagged (the useful DM cue); when exactly two seats have nonzero scores the
lower one sits
exactly on the low-water line and the strict ``<`` keeps it unflagged; and the
more a lone winner towers over a spread of two-or-more small nonzero seats,
the wider sigma grows and the lower — eventually negative — the low-water line
falls, so in that skewed regime the small-but-present seats slip below the
line and nothing is flagged. This is the crude-statistics tool the pillar
specifies, not a calibrated statistic — it exists to cue the DM, not to
adjudicate.
"""

from math import isfinite, sqrt
from typing import Any, Dict, List, Optional, Tuple

#: Half-life of one reported second (ms). Mirrors the client ledger's
#: ``DEFAULT_HALF_LIFE_MS`` so server and client decay in step.
HALF_LIFE_MS = 3 * 60_000
#: A stale session is swept once its NEWEST report is this many half-lives
#: old — by then every contribution has decayed below 0.0244% of itself.
PRUNE_HALF_LIVES = 12
#: Below this decayed score a seat is indistinguishable from a silent one.
MIN_VISIBLE_SCORE = 1e-3
#: Hard cap on distinct sessions in the in-process table. Mirrors
#: ``MAX_TRACKED_KEYS`` in ``ratelimit.py`` / the Rust twin: a flood of
#: invented session ids must not grow process memory without bound.
DEFAULT_MAX_SESSIONS = 20_000


class SpotlightReportError(Exception):
    """A validated-away report carrying a machine-readable ``code``; routes
    map this to 422 whose ``detail`` dict exposes ``error`` verbatim, exactly
    like ``BoundaryError`` does for the lines & veils registry."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _decayed(score: float, age_ms: float, half_life_ms: float = HALF_LIFE_MS) -> float:
    """Decay one accumulator the given age under the half-life model.

    Age is clamped at zero so a snapshot taken before a row's last-update
    stamp (clock skew) can never inflate a score above its stored value —
    the same future-proofing the report path applies to ``occurred_at``.
    """
    if score <= 0:
        return 0.0
    return score * (0.5 ** (max(0.0, age_ms) / half_life_ms))


class SpotlightAggregator:
    """In-memory per-session decayed speaking scores (one true source of
    truth; the server, not any client, owns the projection)."""

    def __init__(
        self,
        half_life_ms: float = HALF_LIFE_MS,
        prune_half_lives: int = PRUNE_HALF_LIVES,
        max_sessions: int = DEFAULT_MAX_SESSIONS,
    ):
        self._half_life_ms = float(half_life_ms)
        self._prune_half_lives = max(1, int(prune_half_lives))
        self._max_sessions = max(1, int(max_sessions))
        # session_id -> user_id -> (decayed_score, last_update_ms) where
        # last_update_ms is the server's RECEIVE time (observed_at), not the
        # client's claimed occurred_at — the accumulator can only age from a
        # clock the server controls.
        self._sessions: Dict[str, Dict[str, Tuple[float, float]]] = {}
        # session_id -> newest occurred_at across that session's reports, for
        # the GET route's ``observed_at`` staleness stamp. None when the
        # session has no reports.
        self._latest_occurred_at: Dict[str, float] = {}

    def record(
        self,
        session_id: str,
        user_id: str,
        duration_ms: float,
        occurred_at: float,
        received_at: float,
    ) -> None:
        """Fold ONE self-reported burst into the session's decayed scores.

        Validation (shape) is the caller's job upstream; here we only do the
        arithmetic. ``received_at`` is the server's clock at receipt and is
        used BOTH for the age clamp on this report and as the accumulator's
        last-update stamp.
        """
        if not (isfinite(received_at) and isfinite(occurred_at)):
            return
        age_ms = max(0.0, received_at - occurred_at)
        contribution = (duration_ms / 1000.0) * (
            0.5 ** (age_ms / self._half_life_ms)
        )

        table = self._sessions.setdefault(session_id, {})
        prior = table.get(user_id)
        if prior is not None:
            score = _decayed(prior[0], received_at - prior[1], self._half_life_ms)
        else:
            score = 0.0
        table[user_id] = (score + contribution, received_at)

        prior_latest = self._latest_occurred_at.get(session_id)
        if prior_latest is None or occurred_at > prior_latest:
            self._latest_occurred_at[session_id] = occurred_at

        self._sweep_if_over_cap(received_at)

    def _sweep_if_over_cap(self, now_ms: float) -> None:
        if len(self._sessions) <= self._max_sessions:
            return
        # Drop whatever is stale first; if still over the cap, drop the
        # least-recently-updated session so the table stays bounded.
        self.sweep_stale(now_ms)
        while len(self._sessions) > self._max_sessions:
            oldest = min(
                self._sessions,
                key=lambda s: max(
                    (t[1] for t in self._sessions[s].values()), default=0.0
                ),
            )
            self._drop_session(oldest)

    def latest_occurred_at(self, session_id: str) -> Optional[float]:
        """Newest ``occurred_at`` self-reported for a session, or None when
        nobody has reported yet (clients render this as 'no data')."""
        return self._latest_occurred_at.get(session_id)

    def snapshot(
        self,
        session_id: str,
        now_ms: float,
        roster: List[str],
    ) -> List[Dict[str, Any]]:
        """Recompute the session's current spotlight rows from the decayed
        accumulator.

        Every roster seat is returned (score 0.0 when it never reported), so
        the DM sees the whole table — including the seats whose silence IS
        the signal — not just the seats with recent speech. Ordering is
        deterministic: descending score, ties broken by user_id (mirrors the
        client ledger's ``computeSpotlightWeights`` sort).
        """
        if not isfinite(now_ms):
            now_ms = 0.0
        table = self._sessions.get(session_id, {})

        rows: List[Dict[str, Any]] = []
        for uid in roster:
            prior = table.get(uid)
            score = _decayed(prior[0], now_ms - prior[1], self._half_life_ms) if prior else 0.0
            if score < MIN_VISIBLE_SCORE:
                score = 0.0
            rows.append({"user_id": uid, "score": score, "is_quiet": False})

        nonzero = [row["score"] for row in rows if row["score"] > 0.0]
        if nonzero:
            mean = sum(nonzero) / len(nonzero)
            variance = sum((x - mean) ** 2 for x in nonzero) / len(nonzero)
            low_water = mean - sqrt(variance)
            for row in rows:
                # Strict ``<`` per spec; documented degenerate regimes above.
                row["is_quiet"] = row["score"] < low_water

        return sorted(rows, key=lambda r: (-r["score"], r["user_id"]))

    def clear(self, session_id: str) -> None:
        """Drop a session's scores (GM/admin reset)."""
        self._drop_session(session_id)

    def clear_all(self) -> None:
        """Wipe the whole table (test harness isolation across tests)."""
        self._sessions.clear()
        self._latest_occurred_at.clear()

    def sweep_stale(self, now_ms: float) -> None:
        """Drop sessions whose newest report is older than the prune horizon,
        and per-seat rows that have decayed below visibility."""
        horizon = self._prune_half_lives * self._half_life_ms
        stale_sessions = []
        for sid, table in self._sessions.items():
            newest = max((t[1] for t in table.values()), default=0.0)
            if not isfinite(now_ms) or now_ms - newest > horizon:
                stale_sessions.append(sid)
                continue
            dying = [uid for uid, (score, _t) in table.items() if score < MIN_VISIBLE_SCORE]
            for uid in dying:
                del table[uid]
            if not table:
                stale_sessions.append(sid)
        for sid in stale_sessions:
            self._drop_session(sid)

    def _drop_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
        self._latest_occurred_at.pop(session_id, None)