"""Ambience preset registry integrity (pure data, no network).

Iteration 17 of Loop 3 adds a curated set of D&D environment soundscapes
(tavern murmur, dungeon drips, forest night, ...) that the gateway generates
on demand through the SFX capability. This module pins the REGISTRY contract
only — the routes and their cache live in ``test_media_routes.py``'s sibling
coverage there.

The registry is deliberately pure data + pure functions: no I/O, no clock,
no environment reads — every assertion here runs without touching the media
gateway.
"""

from vtt_orchestrator.compendium.ambience_presets import (
    AmbiencePreset,
    AMBIENCE_PRESETS,
    get_preset,
    preset_slugs,
)

import pytest


class TestRegistryIntegrity:
    def test_registry_is_nonempty(self):
        assert len(AMBIENCE_PRESETS) >= 6

    def test_slugs_are_unique(self):
        slugs = [p.slug for p in AMBIENCE_PRESETS]
        assert len(slugs) == len(set(slugs))

    def test_slugs_are_url_safe(self):
        # Slugs travel in the POST path (/api/v1/media/ambience/{slug}); they
        # must never carry characters that need escaping or case-folding.
        import re

        for preset in AMBIENCE_PRESETS:
            assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", preset.slug), (
                f"{preset.slug!r} is not a lowercase kebab-case slug"
            )

    @pytest.mark.parametrize("field", ["label", "description", "prompt"])
    def test_text_fields_are_nonempty(self, field):
        for preset in AMBIENCE_PRESETS:
            value = getattr(preset, field)
            assert isinstance(value, str) and value.strip(), (
                f"{preset.slug}.{field} must be a nonempty string"
            )

    def test_prompts_fit_the_sfx_request_cap(self):
        # POST /api/v1/media/sfx validates prompts to max_length=300; the
        # ambience route builds its upstream call from these prompts, so the
        # registry must respect the same ceiling or the curated text silently
        # diverges from what a hand-rolled sfx call may say.
        for preset in AMBIENCE_PRESETS:
            assert len(preset.prompt) <= 300, preset.slug

    def test_loop_durations_are_positive_and_bounded(self):
        # A soundscape shorter than a second is a glitch; longer than ten
        # minutes suggests the author meant a playlist, not a loop.
        for preset in AMBIENCE_PRESETS:
            assert 1.0 <= preset.loop_seconds <= 600.0, preset.slug

    def test_prompts_are_layered_soundscape_prose(self):
        # Engineered for the SFX model: each prompt should read as an
        # ambience bed ("continuous", layered sources), not a single hit.
        for preset in AMBIENCE_PRESETS:
            assert len(preset.prompt.split()) >= 8, preset.slug


class TestDocumentedPresetsPresent:
    """The advertised tabletop staples must actually exist."""

    @pytest.mark.parametrize("slug", [
        "tavern-murmur",
        "dungeon-drips",
        "forest-night",
        "battle-clash",
        "thunderstorm",
        "campfire",
    ])
    def test_core_preset_exists(self, slug):
        assert get_preset(slug) is not None, slug

    def test_every_preset_has_a_distinct_prompt(self):
        prompts = [p.prompt for p in AMBIENCE_PRESETS]
        assert len(prompts) == len(set(prompts))


class TestLookupFunctions:
    def test_get_preset_returns_instance(self):
        preset = get_preset("tavern-murmur")
        assert isinstance(preset, AmbiencePreset)
        assert preset.slug == "tavern-murmur"

    def test_get_preset_unknown_slug_is_none(self):
        assert get_preset("no-such-soundscape") is None
        assert get_preset("") is None

    def test_preset_slugs_matches_registry_order(self):
        assert preset_slugs() == tuple(p.slug for p in AMBIENCE_PRESETS)

    def test_lookup_is_case_sensitive_no_partial_match(self):
        assert get_preset("Tavern-Murmur") is None
        assert get_preset("tavern") is None
