import os
import json
import time
import asyncio
from typing import Dict, Any, AsyncGenerator, Optional, List
import httpx


LLM_LOG_PATH = os.environ.get("LLM_LOG_PATH", "logs/llm_calls.jsonl")


def _log_llm_call(record: Dict[str, Any]) -> None:
    """Appends one structured JSONL record per upstream LLM interaction.

    Durable run artifact for the campaign harness; complements (does not
    replace) mitmproxy-level capture of the wire traffic.
    """
    try:
        directory = os.path.dirname(LLM_LOG_PATH)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(LLM_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, default=str) + "\n")
    except OSError:
        pass  # observability must never break inference


class ToolCallRound:
    """One assistant message that requests tool executions."""

    def __init__(self, tool_calls: List[Dict[str, Any]], content: Optional[str] = None):
        self.tool_calls = tool_calls
        self.content = content


class LLMConfig:
    """
    Resolves LLM Provider configuration from environment variables and organization secrets.
    Precedence:
    1. LLM_KEY, LLM_API, LLM_MODEL (GitHub Organization Secrets)
    2. OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OLLAMA_BASE_URL
    3. Deterministic Mock Fallback (if no API keys are provided)
    """

    def __init__(self):
        self.api_key: Optional[str] = (
            os.getenv("LLM_KEY")
            or os.getenv("OPENAI_API_KEY")
            or os.getenv("ANTHROPIC_API_KEY")
            or os.getenv("GEMINI_API_KEY")
        )
        self.base_url: str = (
            os.getenv("LLM_API")
            or os.getenv("OLLAMA_BASE_URL")
            or "https://api.openai.com/v1"
        )
        self.model: str = (
            os.getenv("LLM_MODEL")
            or ("claude-3-5-sonnet" if os.getenv("ANTHROPIC_API_KEY") else "gpt-4o")
        )
        self.is_mock: bool = not bool(self.api_key)


class LLMStreamingGateway:
    """
    Unified LLM Streaming Gateway supporting token-by-token Server-Sent Events (SSE),
    Outlines/Pydantic logit constraints, and deterministic offline fallbacks.
    """

    def __init__(self, config: Optional[LLMConfig] = None):
        self.config = config or LLMConfig()

    async def complete_with_tools(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """One non-streaming chat-completions round with function/tool schemas.

        Returns the raw assistant message dict, which may contain either
        `content` or `tool_calls` per the OpenAI-compatible contract.
        Raises RuntimeError when only mock mode is configured — a tool-calling
        agent must NEVER silently fall back to canned strings.
        """
        if self.config.is_mock:
            raise RuntimeError(
                "NO_LLM_KEY: configure LLM_KEY/OPENAI_API_KEY for the tool-calling agent"
            )

        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.config.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "max_tokens": 600,
            "temperature": 0.4,
        }
        endpoint = f"{self.config.base_url.rstrip('/')}/chat/completions"
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(endpoint, headers=headers, json=payload)
                latency_ms = (time.perf_counter() - started) * 1000.0
                resp.raise_for_status()
                data = resp.json()
            message = data["choices"][0]["message"]
            _log_llm_call({
                "ts": time.time(),
                "kind": "tools",
                "model": self.config.model,
                "base_url": self.config.base_url,
                "latency_ms": round(latency_ms, 1),
                "status": resp.status_code,
                "tool_calls_emitted": len(message.get("tool_calls") or []),
                "prompt_chars": len(json.dumps(messages)),
                "response_chars": len(message.get("content") or ""),
                "response_excerpt": (message.get("content") or "")[:2000],
            })
            return message
        except Exception as exc:
            _log_llm_call({
                "ts": time.time(),
                "kind": "tools",
                "model": self.config.model,
                "base_url": self.config.base_url,
                "latency_ms": round((time.perf_counter() - started) * 1000.0, 1),
                "status": getattr(locals().get("resp"), "status_code", None),
                "error": str(exc)[:2000],
                "prompt_chars": len(json.dumps(messages)),
            })
            raise

    async def stream_narrative(
        self,
        user_intent: str,
        engine_payload: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[str, None]:
        """
        Yields SSE formatted chunks: `data: {"token": "...", "done": false}\n\n`
        """
        context = context or {}
        action_name = engine_payload.get("action_name", "Action")
        is_hit = engine_payload.get("is_hit", True)
        total_dmg = engine_payload.get("total_damage", 0)

        # If real API key is present, attempt live upstream OpenAI-compatible streaming
        if not self.config.is_mock:
            try:
                system_prompt = (
                    "You are the Encounter Dungeon Master for an authoritative Virtual Tabletop. "
                    "Narrate the resolved combat action vividly in 2-3 sentences based strictly on the deterministic engine facts. "
                    "Do not contradict the engine payload."
                )
                user_prompt = (
                    f"Player Action: {user_intent}\n"
                    f"Engine Resolution: {action_name}, Hit: {is_hit}, Damage: {total_dmg} HP.\n"
                    f"Context: {json.dumps(context)}"
                )

                headers = {
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                }
                payload = {
                    "model": self.config.model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "stream": True,
                    "max_tokens": 150,
                    "temperature": 0.7,
                }

                endpoint = f"{self.config.base_url.rstrip('/')}/chat/completions"
                stream_started = time.perf_counter()
                streamed_chars = 0
                async with httpx.AsyncClient(timeout=10.0) as client:
                    async with client.stream("POST", endpoint, headers=headers, json=payload) as response:
                        if response.status_code == 200:
                            async for line in response.aiter_lines():
                                if line.startswith("data: ") and not line.startswith("data: [DONE]"):
                                    try:
                                        chunk_json = json.loads(line[6:])
                                        delta = chunk_json.get("choices", [{}])[0].get("delta", {})
                                        token = delta.get("content", "")
                                        streamed_chars += len(token)
                                        if token:
                                            yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"
                                    except Exception:
                                        continue
                            yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"
                            _log_llm_call({
                                "ts": time.time(),
                                "kind": "stream",
                                "model": self.config.model,
                                "base_url": self.config.base_url,
                                "latency_ms": round((time.perf_counter() - stream_started) * 1000.0, 1),
                                "status": 200,
                                "prompt_chars": len(user_prompt),
                                "response_chars": streamed_chars,
                            })
                            return
                        _log_llm_call({
                            "ts": time.time(),
                            "kind": "stream",
                            "model": self.config.model,
                            "base_url": self.config.base_url,
                            "status": response.status_code,
                            "error": "non-200 streaming response",
                        })
            except Exception as e:
                # Structured record + smooth failover to deterministic mock.
                _log_llm_call({
                    "ts": time.time(),
                    "kind": "stream",
                    "model": self.config.model,
                    "base_url": self.config.base_url,
                    "status": None,
                    "error": str(e)[:2000],
                })

        # High-Speed Deterministic Generator Fallback
        # Weave SRD compendium facts into the narration so even the offline
        # generator stays mechanically faithful to the stat blocks.
        srd_tail: list = []
        for fact in (context or {}).get("srd", [])[:2]:
            if fact.get("type") == "monster":
                actions = ", ".join(fact.get("action_names", [])[:2]) or "melee attacks"
                srd_tail.extend([
                    f"The {fact['name']} ", f"looms ", "over ", "the ",
                    f"battlefield ", f"(AC {fact.get('ac')}, HP {fact.get('hp')}) ",
                    f"trading ", f"{actions}! ",
                ])
            elif fact.get("type") == "spell":
                srd_tail.extend([
                    f"{fact['name']} ", f"is ", f"a {fact.get('level_name')} ",
                    f"{fact.get('school')} ", f"spell ", f"— ", f"{fact.get('snippet', '')} ",
                ])

        if is_hit:
            tokens = [
                "With ", "unwavering ", "conviction, ", "the ", "strike ", f"of {action_name} ",
                "rips ", "through ", "the ", "gloom, ", "landing ", "with ", "shattering ",
                f"force ", "for ", f"{total_dmg} damage! ", "The ", "target ", "reels ", "backward ",
                "as ", "shards ", "of ", "armor ", "scatter ", "across ", "the ", "stone ", "flags."
            ]
        else:
            tokens = [
                "Lunging ", "forward ", "with ", f"{action_name}, ", "the ", "blow ", "scrapes ",
                "harmlessly ", "across ", "the ", "iron-banded ", "shield ", "with ", "a ",
                "shower ", "of ", "defiant ", "sparks!"
            ]

        if srd_tail:
            tokens = tokens + ["\n\n"] + srd_tail

        for tok in tokens:
            await asyncio.sleep(0.02)  # Simulate 50 tokens/sec streaming
            yield f"data: {json.dumps({'token': tok, 'done': False})}\n\n"

        yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"
