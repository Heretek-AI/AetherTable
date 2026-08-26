"""Curated D&D environment soundscapes generated on demand via the SFX model.

Iteration 17 of Loop 3. This module is deliberately PURE: a frozen dataclass
registry plus two lookup helpers — no I/O, no clock, no environment reads, no
network. The FastAPI routes that consume it live in
``vtt_orchestrator/server.py`` (``GET/POST /api/v1/media/ambience*``); keeping
the catalog here means every assertion about slugs, prompt engineering, and
loop durations runs in microseconds with zero gateway contact.

Prompt discipline: each preset's ``prompt`` is written for the SFX upstream
(``MEDIA_SFX_MODEL``, default ThinkSound-SFX) as a layered, continuous
ambience BED — several simultaneous low-arousal sources plus one or two
sporadic accents — rather than a single hit effect, because these clips loop
under a whole scene for minutes at a time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["AmbiencePreset", "AMBIENCE_PRESETS", "get_preset", "preset_slugs"]


@dataclass(frozen=True)
class AmbiencePreset:
    """One curated soundscape.

    Attributes:
        slug: Stable URL-safe id used in ``POST /api/v1/media/ambience/{slug}``.
            Lowercase kebab-case; never renamed once shipped (clients and saved
            scenes may reference it).
        label: Human-facing name shown in the GM's ambience picker.
        description: One-line flavor/usage hint for the picker UI.
        prompt: Text engineered for the SFX model (see module docstring). Must
            respect the 300-character ceiling enforced on POST /media/sfx so
            the curated text is always accepted by the same validation.
        loop_seconds: Suggested seamless-loop length in seconds. A hint for
            clients that crossfade/repeat the clip; not enforced anywhere.
    """

    slug: str
    label: str
    description: str
    prompt: str
    loop_seconds: float


def _preset(
    slug: str,
    label: str,
    description: str,
    prompt: str,
    loop_seconds: float,
) -> AmbiencePreset:
    return AmbiencePreset(
        slug=slug,
        label=label,
        description=description,
        prompt=prompt.strip(),
        loop_seconds=loop_seconds,
    )


#: The curated catalog. Order is display order (registry order is part of the
#: GET contract); append-only by policy — reordering reshuffles every client's
#: picker for no gain.
AMBIENCE_PRESETS: tuple[AmbiencePreset, ...] = (
    _preset(
        "tavern-murmur",
        "Tavern Murmur",
        "Warm common-room bed for social scenes.",
        (
            "Continuous cozy tavern interior ambience: low crowd murmur of "
            "dozens of quiet conversations overlapping, occasional warm "
            "laughter bursts, clinking tankards and ceramic mugs on wooden "
            "tables, creaking floorboards, crackling fireplace hiss, distant "
            "fiddle playing softly."
        ),
        120.0,
    ),
    _preset(
        "dungeon-drips",
        "Dungeon Drips",
        "Cold stone depths; dread and echo.",
        (
            "Deep underground stone dungeon ambience: irregular echoing water "
            "drips from unseen heights into shallow pools, faint subterranean "
            "air movement, occasional distant rock settling groan, sparse "
            "hollow wind through narrow passages, oppressive low-frequency "
            "room tone, no wildlife, no music."
        ),
        180.0,
    ),
    _preset(
        "forest-night",
        "Forest Night",
        "Moonlit wilderness; travel and watch shifts.",
        (
            "Nocturnal deciduous forest soundscape: layered cricket and "
            "katydid chorus, sporadic owl hoots far apart, gentle leaves "
            "rustling in light wind, occasional twig snap, distant frog "
            "croaks near water, calm continuous night-insects bed, no human "
            "activity."
        ),
        150.0,
    ),
    _preset(
        "battle-clash",
        "Battle Clash",
        "Melee din for combat set pieces.",
        (
            "Distant large battle ambience: rolling waves of clashing steel "
            "swords and shields, muffled war drums pounding steadily, shouted "
            "commands and battle cries from many voices, occasional horse "
            "whinny, arrows whooshing overhead, low continuous rumble of "
            "chaotic melee, tense and loud but not deafening."
        ),
        90.0,
    ),
    _preset(
        "thunderstorm",
        "Thunderstorm",
        "Storm front over the party's camp.",
        (
            "Heavy rainstorm ambience: steady dense rainfall on leaves and "
            "wet earth, periodic rolling thunder claps with long natural "
            "decay separated by quiet gaps, gusting wind surges through "
            "trees, occasional close lightning crack, continuous rain white-"
            "noise bed underneath throughout."
        ),
        120.0,
    ),
    _preset(
        "campfire",
        "Campfire",
        "Long-rest warmth; quiet conversation backdrop.",
        (
            "Intimate campfire ambience at night: close crackling flames "
            "with popping embers, wood occasionally settling with soft "
            "thumps, faint intermittent cricket chirps beyond the firelight, "
            "gentle night breeze stirring grass, very sparse distant owl "
            "call, warm continuous fire bed, calm and safe feeling."
        ),
        90.0,
    ),
)

_SLUG_PATTERN = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")

_PRESETS_BY_SLUG: dict[str, AmbiencePreset] = {p.slug: p for p in AMBIENCE_PRESETS}


def get_preset(slug: str) -> AmbiencePreset | None:
    """Exact-match lookup by slug; ``None`` when unknown (no fuzzy match).

    Case-sensitive on purpose: slugs are identifiers, and silently accepting
    ``"Tavern-Murmur"`` would let a client typo survive to production.
    """
    return _PRESETS_BY_SLUG.get(slug)


def preset_slugs() -> tuple[str, ...]:
    """Registry slugs in display order."""
    return tuple(p.slug for p in AMBIENCE_PRESETS)


def validate_registry() -> None:
    """Import-time integrity guard (defense in depth behind the test suite).

    Raises ``ValueError`` if any invariant the route layer relies on breaks:
    unique URL-safe slugs, nonempty text fields, prompts within the 300-char
    SFX ceiling, sane loop bounds, distinct prompts.
    """
    seen: set[str] = set()
    seen_prompts: set[str] = set()
    for preset in AMBIENCE_PRESETS:
        if preset.slug in seen:
            raise ValueError(f"duplicate ambience preset slug: {preset.slug!r}")
        if not _SLUG_PATTERN.fullmatch(preset.slug):
            raise ValueError(f"ambience slug not URL-safe: {preset.slug!r}")
        for field in ("label", "description", "prompt"):
            if not getattr(preset, field).strip():
                raise ValueError(f"ambience preset {preset.slug}: empty {field}")
        if len(preset.prompt) > 300:
            raise ValueError(
                f"ambience preset {preset.slug}: prompt exceeds the 300-char "
                f"SFX ceiling ({len(preset.prompt)} chars)"
            )
        if not 1.0 <= preset.loop_seconds <= 600.0:
            raise ValueError(
                f"ambience preset {preset.slug}: loop_seconds out of range "
                f"({preset.loop_seconds})"
            )
        if preset.prompt in seen_prompts:
            raise ValueError(
                f"ambience preset {preset.slug}: duplicate prompt text"
            )
        seen.add(preset.slug)
        seen_prompts.add(preset.prompt)


validate_registry()
