"""SLA report honesty: honest row labels, sample floors, and summary tallies.

Contracts under test (audit notes):

1. The ``/api/v1/intent/classify`` endpoint is the DETERMINISTIC KEYWORD
   REGEX classifier — the SLA row must say so (``intent_parsing_keyword``),
   never claim to measure "intent parsing" in general.
2. The LLM-assisted classification row (``intent_parsing_llm``, real
   ``classify_with_llm`` round-trips) exists ONLY under RUN_LIVE_LLM=1 with a
   live key; without that it is OMITTED, never simulated. Without a key even
   an opt-in run omits it rather than timing the keyword fallback.
3. The SSE first-token verdict needs at least MIN_SSE_SAMPLES valid samples;
   fewer prints WITHHELD instead of PASS.
4. The final summary distinguishes explicit "SLA FAILURES: n" from
   "WITHHELD (unmeasurable): m" so an all-withheld run cannot read as green.

No unit test touches the network: measurement functions are either fed
synthetic Measurement objects through judge()/print_report(), or gated off
before any request is made.
"""

import pytest

from vtt_orchestrator.playtest import sla_measurement as sla
from vtt_orchestrator.playtest.sla_measurement import (
    MIN_SSE_SAMPLES,
    RowVerdict,
    Measurement,
    judge,
    measure_llm_classification,
    print_report,
)


def _samples(*ms: float) -> Measurement:
    return Measurement(samples_ms=list(ms))


# ---------------------------------------------------------------------------
# 1. Intent rows honestly disclose what they measure
# ---------------------------------------------------------------------------

class TestIntentRowLabelling:
    def test_keyword_row_is_named_for_the_keyword_path(self):
        assert "intent_parsing_keyword" in sla.SLA_TARGETS_MS
        # The old generic label must be gone: it claimed to cover intent
        # parsing while only ever exercising the keyword regex classifier.
        assert "intent_parsing" not in sla.SLA_TARGETS_MS

    def test_judge_accepts_relabelled_keyword_category(self):
        verdict = judge("intent_parsing_keyword", "POST :8000/api/v1/intent/classify",
                        _samples(*[10.0] * 40))
        assert verdict.category == "intent_parsing_keyword"
        assert verdict.verdict == "PASS"

    def test_llm_row_has_its_own_target(self):
        assert sla.SLA_TARGETS_MS["intent_parsing_llm"] == 150.0

    def test_run_measurement_labels_keyword_endpoint_disclosed(self, monkeypatch):
        monkeypatch.setenv("ENGINE_API_URL", "http://127.0.0.1:1")
        monkeypatch.setenv("GATEWAY_API_URL", "http://127.0.0.1:2")
        monkeypatch.delenv("RUN_LIVE_LLM", raising=False)
        rows = sla.run_measurement(n_calls=1, sse_streams=1)
        keyword_rows = [r for r in rows if r.category == "intent_parsing_keyword"]
        assert len(keyword_rows) == 1
        assert "keyword regex" in keyword_rows[0].endpoint


# ---------------------------------------------------------------------------
# 2. LLM row is opt-in and never simulated
# ---------------------------------------------------------------------------

class TestLLMRowGating:
    def test_row_omitted_without_opt_in(self, monkeypatch):
        monkeypatch.setenv("ENGINE_API_URL", "http://127.0.0.1:1")
        monkeypatch.setenv("GATEWAY_API_URL", "http://127.0.0.1:2")
        monkeypatch.delenv("RUN_LIVE_LLM", raising=False)
        rows = sla.run_measurement(n_calls=1, sse_streams=1)
        assert not [r for r in rows if r.category == "intent_parsing_llm"]

    def test_measure_llm_classification_returns_none_without_key(self, monkeypatch):
        for var in ("LLM_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
                    "GEMINI_API_KEY", "OLLAMA_BASE_URL"):
            monkeypatch.delenv(var, raising=False)
        # No key -> classify_with_llm would silently answer from keywords;
        # measuring that under an "llm" label would be simulation.
        assert measure_llm_classification("I attack", n=5) is None


# ---------------------------------------------------------------------------
# 3. SSE first-token needs >= MIN_SSE_SAMPLES or WITHHELD
# ---------------------------------------------------------------------------

class TestSSESampleFloor:
    def test_single_stream_is_withheld_not_pass(self):
        verdict = judge("sse_first_token", "POST :8000/api/v1/narrative/stream",
                        _samples(400.0))
        assert verdict.verdict == "WITHHELD"

    def test_two_streams_still_withheld(self):
        verdict = judge("sse_first_token", "POST :8000/api/v1/narrative/stream",
                        _samples(400.0, 500.0))
        assert verdict.verdict == "WITHHELD"
        assert str(MIN_SSE_SAMPLES) in verdict.detail

    def test_three_fast_samples_pass(self):
        verdict = judge("sse_first_token", "POST :8000/api/v1/narrative/stream",
                        _samples(400.0, 410.0, 420.0))
        assert verdict.verdict == "PASS"

    def test_three_slow_samples_fail(self):
        verdict = judge("sse_first_token", "POST :8000/api/v1/narrative/stream",
                        _samples(2000.0, 2100.0, 2200.0))
        assert verdict.verdict == "FAIL"


# ---------------------------------------------------------------------------
# 4. Summary tallies keep withheld runs from reading green
# ---------------------------------------------------------------------------

def _withheld(category: str) -> RowVerdict:
    return RowVerdict(category, "ep", "", None, None, None, 0,
                      "WITHHELD", "service unreachable")


class TestSummaryTallies:
    def test_all_withheld_run_prints_both_counts_and_fails(self, capsys):
        ok = print_report([_withheld("rules_engine"), _withheld("spatial_los")])
        out = capsys.readouterr().out
        assert "SLA FAILURES: 0" in out
        assert "PASSED: 0" in out
        assert "WITHHELD (unmeasurable): 2" in out
        assert ok is False  # everything withheld can NEVER read as green

    def test_failures_and_withheld_are_counted_separately(self, capsys):
        fail_row = judge("rules_engine", "ep", _samples(*[999.0] * 40))
        pass_row = judge("spatial_los", "ep", _samples(*[1.0] * 40))
        ok = print_report([fail_row, pass_row, _withheld("sse_first_token")])
        out = capsys.readouterr().out
        assert "SLA FAILURES: 1" in out
        assert "PASSED: 1" in out
        assert "WITHHELD (unmeasurable): 1" in out
        assert ok is False

    def test_clean_run_reports_zero_failures_and_returns_true(self, capsys):
        rows = [
            judge("rules_engine", "ep", _samples(*[1.0] * 40)),
            judge("intent_parsing_keyword", "ep", _samples(*[5.0] * 40)),
            judge("intent_parsing_llm", "ep", _samples(*[90.0] * 40)),
            judge("sse_first_token", "ep", _samples(300.0, 310.0, 320.0)),
        ]
        ok = print_report(rows)
        out = capsys.readouterr().out
        assert "SLA FAILURES: 0" in out
        assert "WITHHELD (unmeasurable): 0" in out
        assert ok is True
