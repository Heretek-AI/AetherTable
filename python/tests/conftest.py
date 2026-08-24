"""Shared pytest configuration for the orchestrator test suite.

Implements the opt-in gate for the LIVE LLM suite (``pytest.mark.live``):

A test marked ``@pytest.mark.live`` runs ONLY when BOTH hold:
  1. ``LLM_KEY`` is set in the environment (a real external endpoint is
     configured -- see ``LLMConfig`` in
     ``vtt_orchestrator/routing/llm_client.py``), AND
  2. ``RUN_LIVE_LLM=1`` is exported explicitly.

CI never exports ``RUN_LIVE_LLM``, so live tests can never execute there;
locally they are skipped (not failed) unless the operator opts in. The skip
decision lives here so every test in the live module gets it for free and no
individual test has to duplicate the guard.
"""

import os

import pytest


def _live_llm_enabled() -> bool:
    """True only when a key is configured AND the opt-in flag is exported."""
    if not os.environ.get("LLM_KEY"):
        return False
    return os.environ.get("RUN_LIVE_LLM", "0").strip().lower() == "1"


def pytest_collection_modifyitems(config, items):
    if _live_llm_enabled():
        return
    skip_live = pytest.mark.skip(
        reason="live LLM test: requires LLM_KEY set AND RUN_LIVE_LLM=1 "
        "(opt-in; never runs in CI)"
    )
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)
