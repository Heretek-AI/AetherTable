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


@pytest.fixture(autouse=True)
def _isolate_rate_limiter_windows():
    """Reset the orchestrator's in-process sliding-window rate limiter around
    EVERY test.

    ``vtt_orchestrator.server`` keeps its 60 s windows in module state
    (``_rate_windows``), keyed by ``(client_ip, bucket)``. Every TestClient in
    the suite shares one source address ("testclient"), and several modules
    hammer the auth bucket, whose limit is only 30 requests / 60 s. Without a
    reset owned by the harness itself, whether a given module passes depends on
    how many auth requests OTHER modules happened to make within the last
    minute of wall clock — a nondeterministic flake that no single test can fix
    from inside.

    Two modules (test_campaign_sim, test_ai_companion) already carried their
    own copies of this fixture; it lives here so no module's green-ness depends
    on another module remembering to clean up. Per-test scope is deliberate:
    clearing costs a dict clear (~microseconds), while module-scope would still
    let one long test starve its siblings inside the same file.
    """
    from vtt_orchestrator import server as server_module

    server_module._rate_windows.clear()
    yield
    # Also clear on exit so hits recorded by a test never leak into ambient
    # state (e.g. a later test asserting on window contents).
    server_module._rate_windows.clear()
