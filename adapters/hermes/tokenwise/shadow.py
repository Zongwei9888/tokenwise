"""LightShadow for Hermes Agent: recoverable compaction as a context engine.

Hermes lets one context engine own compaction (``context.engine`` in
config.yaml). ``LightShadowEngine`` is Hermes's own ``ContextCompressor`` with
three additions, so Hermes's thresholds, windows, pruning and summarizer all
stay as they are:

- the summarizer is told that the tool results stay recoverable
  (``_build_summary_prompt``);
- before Hermes assembles the compacted history, every tool result it
  compacted or shortened is saved by ``tokenwise shadow checkpoint``, and the summary
  becomes Hermes's summary plus the catalog of observation IDs
  (``_assemble_compressed``); shortened results in the kept head are marked
  with their ID;
- the model gets a ``tokenwise_recall`` tool that reads any of them again
  (``tokenwise recall``).

Fail-open: any error, a missing ``tokenwise``, a timeout or a checkpoint that is not
smaller leaves Hermes's own compaction exactly as it would have been.

Verified against Hermes Agent 0.22.5: ``ContextCompressor.compress``,
``_build_summary_prompt`` and ``_assemble_compressed`` keep these
signatures; if they change, the engine behaves as the plain compressor.
"""

from __future__ import annotations

import inspect
import json
import logging
import subprocess
from types import SimpleNamespace
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

ENGINE_NAME = "tokenwise"
_TIMEOUT_S = 20
RECALL_TOOL_NAME = "tokenwise_recall"

# Kept equal to SHADOW_ASSISTED_INSTRUCTION in @tokenwise/mechanisms (a test compares them):
# Hermes's lean summary keeps the user's messages itself, and the catalog follows the summary.
SUMMARY_INSTRUCTION = (
    "After this compaction every tool result in this span stays recoverable: TokenWise adds a catalog of them after your summary, "
    "and the agent can read any of them again with its recall tool. So write the summary the agent needs to carry on "
    "without re-running anything: the findings from the tool results (facts, file paths with line numbers, values, "
    "errors, what passed and what failed) and the decisions made. Do not paste whole files, logs or test output; "
    "say what they showed. Do not list observation IDs."
)

# Kept equal to RECALL_TOOL_DESCRIPTION and RECALL_INPUT_SCHEMA in @tokenwise/mechanisms.
RECALL_DESCRIPTION = (
    "Read again a tool result TokenWise kept, by the observation_id in the observation catalog. "
    "Results over 8 KB come back a window at a time."
)
RECALL_PARAMETERS = {
    "type": "object",
    "properties": {
        "observation_id": {"type": "string", "description": "Such as o-1a2b3c4d5e6f."},
        "query": {"type": "string", "description": "An exact string it contains: read around its first match."},
        "line": {"type": "integer", "minimum": 1, "description": "A 1-based line to read around."},
        "original": {"type": "boolean", "description": "For a catalog entry marked original: the output before TokenWise shortened it."},
    },
    "required": ["observation_id"],
    "additionalProperties": False,
}

# The overrides below call these with exactly these parameters.
_EXPECTED = {
    "compress": ["messages", "current_tokens", "focus_topic", "force", "memory_context", "bypass_cooldown"],
    "_build_summary_prompt": ["content_to_summarize", "summary_budget", "focus_topic", "memory_context", "has_user_turn"],
    "_assemble_compressed": ["messages", "compress_start", "compress_end", "scan", "summary"],
}


def _text(content: Any) -> Optional[str]:
    """A message's content as text, or None when it is not all text (images)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") in ("text", "input_text", "output_text") and isinstance(part.get("text"), str):
                parts.append(part["text"])
            else:
                return None
        return "\n".join(parts)
    return None


def _key(message: dict) -> Optional[str]:
    """A tool row's identity: Hermes's per-call UID, else the call ID (which can repeat across turns)."""
    uid = message.get("_tool_call_uid")
    if isinstance(uid, str) and uid:
        return uid
    call_id = message.get("tool_call_id")
    return call_id if isinstance(call_id, str) and call_id else None


def _call_label(arguments: Any) -> Optional[str]:
    """One line naming what a call did: its command, else the path it read, else its arguments (callLabel in TypeScript)."""
    value = arguments
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            pass
    label = None
    if isinstance(value, dict):
        for key in ("command", "cmd", "path", "file_path", "filePath", "target_file", "file", "pattern", "query", "url"):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                label = item
                break
        if label is None:
            label = json.dumps(value, ensure_ascii=False)
    elif isinstance(value, str):
        label = value
    if not label:
        return None
    line = " ".join(label.split())
    if not line or line == "{}":
        return None
    return line if len(line) <= 160 else line[:159] + "…"


def segment_messages(original: list, pruned: list, start: int, end: int, is_summary: Callable[[Any], bool]) -> list:
    """The span as LightShadow reads it: the compacted window with each tool row's original text, then every
    tool row outside it that Hermes shortened (it prunes results outside the kept tail before summarizing)."""
    by_key = {}
    calls = {}
    for message in original:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "tool" and _key(message):
            by_key[_key(message)] = message
        for call in message.get("tool_calls") or []:
            if isinstance(call, dict) and isinstance(call.get("id"), str):
                function = call.get("function") or {}
                calls[call["id"]] = (function.get("name") or "tool", _call_label(function.get("arguments")))

    def tool_row(message: dict) -> Optional[dict]:
        source = by_key.get(_key(message) or "", message)
        text = _text(source.get("content"))
        if text is None:
            return None
        call_id = source.get("tool_call_id")
        name, label = calls.get(call_id, (source.get("tool_name") or source.get("name") or "tool", None))
        row = {"role": "tool", "text": text, "tool_name": name}
        if isinstance(call_id, str):
            row["call_id"] = call_id
        if label:
            row["call"] = label
        return row

    out = []
    for index, message in enumerate(pruned):
        if not isinstance(message, dict):
            continue
        inside = start <= index < end
        role = message.get("role")
        if role == "tool":
            original_row = by_key.get(_key(message) or "")
            shortened = original_row is not None and _text(original_row.get("content")) != _text(message.get("content"))
            if inside or shortened:
                row = tool_row(message)
                if row:
                    out.append(row)
            continue
        if not inside:
            continue
        text = _text(message.get("content")) or ""
        if is_summary(message):
            out.append({"role": "summary", "text": text})
        elif role == "user":
            out.append({"role": "user", "text": text})
        elif role == "assistant":
            names = [f"{(c.get('function') or {}).get('name', 'tool')} {(c.get('function') or {}).get('arguments', '')}"
                     for c in message.get("tool_calls") or [] if isinstance(c, dict)]
            out.append({"role": "assistant", "text": "\n".join(filter(None, [text, *names]))})
        else:
            out.append({"role": "other", "text": text})
    return out


def _run_lc(tokenwise: Optional[str], args: list, payload: Optional[dict] = None) -> Optional[subprocess.CompletedProcess]:
    if not tokenwise:
        return None
    try:
        return subprocess.run([tokenwise, *args], input=json.dumps(payload) if payload is not None else None, capture_output=True,
                              text=True, encoding="utf-8", timeout=_TIMEOUT_S)
    except Exception:  # Fail-open.
        logger.debug("tokenwise: tokenwise %s failed", args[:2], exc_info=True)
        return None


def _signature_ok(cls: type) -> bool:
    for name, params in _EXPECTED.items():
        method = getattr(cls, name, None)
        if method is None:
            return False
        try:
            names = list(inspect.signature(method).parameters)[1:]
        except (TypeError, ValueError):
            return False
        if names[:len(params)] != params:
            return False
    return True


def _compressor_kwargs(compressor_cls: type) -> dict:
    """The built-in compressor's settings from the user's ``compression:`` section, as Hermes builds them for itself.
    Hermes configures only its own compressor from config; an engine must read it."""
    kwargs: dict = {"model": "", "quiet_mode": True}
    try:
        from hermes_cli.config import load_config_readonly
        from agent.agent_init import _parse_compression_config
        cs = _parse_compression_config(SimpleNamespace(model="", provider="", api_mode=None, base_url="", quiet_mode=True), load_config_readonly())
        kwargs.update(threshold_percent=cs.threshold, protect_first_n=cs.protect_first, protect_last_n=cs.protect_last,
                      summary_target_ratio=cs.target_ratio, abort_on_summary_failure=cs.abort_on_summary_failure,
                      model_thresholds=cs.model_thresholds, threshold_tokens_cap=cs.threshold_tokens,
                      proactive_prune_tokens=cs.proactive_prune_tokens, proactive_prune_min_result_chars=cs.proactive_prune_min_chars,
                      proactive_prune_min_reclaim_tokens=cs.proactive_prune_min_reclaim, min_tail_user_messages=cs.min_tail_users,
                      tail_mode=cs.tail_mode)
    except Exception:
        logger.debug("tokenwise: could not read compression settings; using the compressor defaults", exc_info=True)
    try:
        accepted = set(inspect.signature(compressor_cls.__init__).parameters)
        kwargs = {key: value for key, value in kwargs.items() if key in accepted}
    except (TypeError, ValueError):
        pass
    return kwargs


def engine_class(find_lc: Callable[[], Optional[str]]):
    """Build the engine class (Hermes's modules are imported only when Hermes asks for the engine)."""
    from agent.context_compressor import ContextCompressor, is_compaction_summary_message

    compatible = _signature_ok(ContextCompressor)

    class LightShadowEngine(ContextCompressor):
        def __init__(self) -> None:
            super().__init__(**_compressor_kwargs(ContextCompressor))
            self._lc_input: Optional[list] = None
            self._lc_refs: dict = {}

        @property
        def name(self) -> str:
            return ENGINE_NAME

        def compress(self, messages, current_tokens=None, focus_topic=None, force=False, memory_context="", bypass_cooldown=False):
            self._lc_input, self._lc_refs = messages, {}
            try:
                out = super().compress(messages, current_tokens=current_tokens, focus_topic=focus_topic, force=force,
                                       memory_context=memory_context, bypass_cooldown=bypass_cooldown)
                return self._mark_shortened(out) if compatible else out
            finally:
                self._lc_input = None

        def _build_summary_prompt(self, content_to_summarize, summary_budget, focus_topic, memory_context, has_user_turn):
            prompt = super()._build_summary_prompt(content_to_summarize, summary_budget, focus_topic, memory_context, has_user_turn)
            return prompt + "\n\n" + SUMMARY_INSTRUCTION if compatible else prompt

        def _assemble_compressed(self, messages, compress_start, compress_end, scan, summary):
            if compatible and self._lc_input is not None and isinstance(summary, str) and summary.strip():
                try:
                    summary = self._checkpoint(messages, compress_start, compress_end, summary)
                except Exception:  # Fail-open: Hermes's summary stays.
                    logger.debug("tokenwise: compaction checkpoint failed", exc_info=True)
            return super()._assemble_compressed(messages, compress_start, compress_end, scan, summary)

        def _checkpoint(self, messages, start, end, summary):
            span = segment_messages(self._lc_input or [], messages, start, end, is_compaction_summary_message)
            if not any(row["role"] == "tool" for row in span):
                return summary
            done = _run_lc(find_lc(), ["shadow", "checkpoint"], {"host": "hermes", "session_id": getattr(self, "_session_id", None),
                                                                 "messages": span, "summary": summary, "user_messages": False})
            if done is None or done.returncode != 0:
                return summary
            reply = json.loads(done.stdout or "{}")
            text = reply.get("text")
            if not isinstance(text, str) or not text.strip():
                return summary
            self._lc_refs = {ref["call_id"]: ref["id"] for ref in reply.get("refs") or [] if isinstance(ref, dict) and ref.get("call_id") and ref.get("id")}
            return text

        def _mark_shortened(self, out):
            """A result Hermes shortened outside the summary keeps its place; say how to read it in full."""
            if not self._lc_refs:
                return out
            originals = {_key(m): m for m in self._lc_input or [] if isinstance(m, dict) and m.get("role") == "tool"}
            for message in out:
                if not isinstance(message, dict) or message.get("role") != "tool" or not isinstance(message.get("content"), str):
                    continue
                ref = self._lc_refs.get(message.get("tool_call_id"))
                original = originals.get(_key(message))
                if ref and original is not None and _text(original.get("content")) != message["content"]:
                    message["content"] += f" [full output: {RECALL_TOOL_NAME} {ref}]"
            return out

        def get_tool_schemas(self):
            schemas = list(super().get_tool_schemas() or [])
            return schemas + [{"name": RECALL_TOOL_NAME, "description": RECALL_DESCRIPTION, "parameters": RECALL_PARAMETERS}]

        def handle_tool_call(self, name, args, **kwargs):
            if name != RECALL_TOOL_NAME:
                return super().handle_tool_call(name, args, **kwargs)
            args = args if isinstance(args, dict) else {}
            ident = args.get("observation_id")
            if not isinstance(ident, str) or not ident.strip():
                return json.dumps({"error": "pass an observation_id from the observation catalog"})
            argv = ["recall", ident.strip(), "--host", "hermes"]
            session = getattr(self, "_session_id", None)
            if isinstance(session, str) and session:
                argv += ["--session", session]
            if isinstance(args.get("query"), str) and args["query"]:
                argv += ["--query", args["query"]]
            if isinstance(args.get("line"), (int, str)) and str(args["line"]).strip().isdigit():
                argv += ["--line", str(args["line"]).strip()]
            if args.get("original") in (True, "true"):
                argv.append("--original")
            done = _run_lc(find_lc(), argv)
            if done is None:
                return json.dumps({"error": "TokenWise (tokenwise) is not available"})
            return json.dumps({"result": done.stdout} if done.returncode == 0 else {"error": done.stdout.strip()})

    return LightShadowEngine
