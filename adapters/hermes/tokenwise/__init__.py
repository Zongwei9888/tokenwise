"""TokenWise for Hermes Agent: Token Economy on the terminal tool, and
LightShadow as a context engine.

Hermes hands ``transform_terminal_output`` the merged output of a finished
foreground command, after its capture window and before its output limit,
ANSI stripping and secret redaction. This plugin passes the command, output
and exit code to ``tokenwise hook hermes`` (the TokenWise CLI), which saves the
original under ``~/.tokenwise``, journals the decision, and answers with a
smaller, deterministic projection when a filter recognizes the output.

Background processes: Hermes hands their output to ``transform_terminal_output``
too (with an empty ``env_type``), but only as a tail of it (the last 200 to 2000
characters), even once the process exited; that is left alone. The complete
output of a finished process, read with ``process_manage`` action ``wait`` and
not cut, goes to ``tokenwise hook hermes`` from ``transform_tool_result``.

Fail-open: no ``tokenwise``, a timeout, an error or an unrecognized output leaves
the output exactly as Hermes captured it. ``TOKENWISE_DISABLE=1`` turns it
off.

The startup notice (a learning run finished, or a command keeps coming back
long) comes from ``tokenwise notice hermes`` when a session starts, and is
posted into that conversation with ``ctx.post_message``; so is what TokenWise saved
in the conversation, at the end of a turn when it grew (``tokenwise notice hermes
--session``).

LightShadow (``shadow.py``): with ``context.engine: tokenwise`` in Hermes's
config, ``register`` also calls ``ctx.register_context_engine`` with Hermes's
own compressor plus recoverable tool results and a ``tokenwise_recall`` tool.
"""

from __future__ import annotations

import json
import logging
import contextvars
import os
import shutil
import subprocess
import threading
from collections import OrderedDict
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Shorter output cannot save enough to be worth starting `tokenwise` (Economy admits a projection only when it saves 16+ tokens).
_MIN_CHARS = 256
# Output larger than this is past anything Hermes captures in the foreground; it is left alone.
_MAX_CHARS = 32 * 1024 * 1024
_TIMEOUT_S = 10
_FALLBACKS = ("~/.local/bin/tokenwise", "/opt/homebrew/bin/tokenwise", "/usr/local/bin/tokenwise")
# transform_terminal_output carries no session ID; pre_tool_call does, under the same tool_call_id.
_SESSIONS: "OrderedDict[str, str]" = OrderedDict()
_SESSIONS_LOCK = threading.Lock()
_MAX_SESSIONS = 512


def _lc() -> Optional[str]:
    """The `tokenwise` command: $TOKENWISE_BIN, else PATH, else where npm puts global binaries (a gateway started at login may lack them on PATH)."""
    explicit = os.environ.get("TOKENWISE_BIN", "").strip()
    if explicit:
        return explicit if os.access(explicit, os.X_OK) else None
    found = shutil.which("tokenwise")
    if found:
        return found
    for candidate in _FALLBACKS:
        path = os.path.expanduser(candidate)
        if os.access(path, os.X_OK):
            return path
    return None


def _remember_session(tool_name: str = "", session_id: str = "", tool_call_id: str = "", **_: Any) -> None:
    """Observe pre_tool_call (no directive): which session a terminal call belongs to."""
    if tool_name != "terminal" or not tool_call_id or not session_id:
        return None
    with _SESSIONS_LOCK:
        _SESSIONS[str(tool_call_id)] = str(session_id)
        while len(_SESSIONS) > _MAX_SESSIONS:
            _SESSIONS.popitem(last=False)
    return None


def _project(payload: dict) -> Optional[str]:
    """``tokenwise hook hermes`` on *payload*: the projection of its output, or None when nothing changes."""
    if not (_MIN_CHARS <= len(payload["output"]) <= _MAX_CHARS) or os.environ.get("TOKENWISE_DISABLE", "").strip() in ("1", "true", "yes"):
        return None
    tokenwise = _lc()
    if not tokenwise:
        return None
    try:
        done = subprocess.run([tokenwise, "hook", "hermes"], input=json.dumps({**payload, "cwd": os.getcwd()}), capture_output=True,
                              text=True, encoding="utf-8", timeout=_TIMEOUT_S)
        if done.returncode != 0 or not done.stdout.strip():
            return None
        projected = json.loads(done.stdout).get("output")
    except Exception:  # Fail-open: Hermes keeps its own output.
        logger.debug("tokenwise: tokenwise hook hermes failed", exc_info=True)
        return None
    return projected if isinstance(projected, str) and projected != payload["output"] else None


def _transform(command: str = "", output: str = "", returncode: Any = None, task_id: str = "", env_type: str = "",
               tool_call_id: str = "", **_: Any) -> Optional[str]:
    if not isinstance(command, str) or not isinstance(output, str) or not isinstance(returncode, int) or isinstance(returncode, bool):
        return None
    # A background process's output comes here with no environment, and only as its tail: not the whole output.
    if not env_type:
        return None
    with _SESSIONS_LOCK:
        session_id = _SESSIONS.pop(str(tool_call_id), "") if tool_call_id else ""
    return _project({"hook_event_name": "transform_terminal_output", "command": command, "output": output, "returncode": returncode,
                     "session_id": session_id, "task_id": task_id or "", "tool_call_id": tool_call_id or "", "env_type": env_type})


# What ``process_manage`` keeps of a process's output (``MAX_OUTPUT_CHARS``); ``wait`` returns at most its last 2000.
_PROCESS_KEPT = 200_000


def _transform_result(tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "", tool_call_id: str = "",
                      **_: Any) -> Optional[str]:
    """transform_tool_result: the complete output of a finished background process, read with ``process_manage``
    action ``wait``: exited on its own, an exit code, and nothing cut (Hermes adds ``output_cut`` when it returns
    only a tail). Every other key of the result stays as Hermes wrote it."""
    if tool_name != "process_manage" or not isinstance(args, dict) or args.get("action") != "wait" or not isinstance(result, str):
        return None
    try:
        value = json.loads(result)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("status") != "exited" or value.get("completion_reason") != "exited":
        return None
    command, output, code = value.get("command"), value.get("output"), value.get("exit_code")
    if "output_cut" in value or "detached" in value or not isinstance(command, str) or not command:
        return None
    if not isinstance(output, str) or len(output) >= _PROCESS_KEPT or not isinstance(code, int) or isinstance(code, bool):
        return None
    projected = _project({"hook_event_name": "process_output", "command": command, "output": output, "returncode": code,
                          "session_id": session_id or "", "tool_call_id": tool_call_id or ""})
    if projected is None:
        return None
    value["output"] = projected
    return json.dumps(value, ensure_ascii=False)


def _notice(*flags: str) -> Optional[str]:
    """``tokenwise notice hermes`` with *flags*: the notice's text, or None."""
    if os.environ.get("TOKENWISE_DISABLE", "").strip() in ("1", "true", "yes"):
        return None
    tokenwise = _lc()
    if not tokenwise:
        return None
    try:
        done = subprocess.run([tokenwise, "notice", "hermes", *flags], capture_output=True, text=True, encoding="utf-8", timeout=_TIMEOUT_S)
    except Exception:
        return None
    text = done.stdout.strip() if done.returncode == 0 else ""
    return text or None


def _shown(handle: Any) -> bool:
    """Whether Hermes showed a posted message: posted (``ok``), and, for a local session, ``delivered`` to a
    viewer that was watching it."""
    if not getattr(handle, "ok", False):
        return False
    result = getattr(handle, "result", None)
    return not (isinstance(result, dict) and result.get("delivered") is False)


def _session_notice(ctx):
    """on_session_start: post the notice into the new conversation, off the turn's path. It counts as told only
    once Hermes has posted it (a one-shot ``hermes -q`` may exit first, and no live conversation refuses it)."""
    def post() -> None:
        try:
            text = _notice("--peek")
            if text and _shown(ctx.post_message(text)):
                _notice("--told")
        except Exception:  # The notice is a courtesy.
            logger.debug("tokenwise: startup notice failed", exc_info=True)

    def start(**_: Any) -> None:
        # The copied context keeps the session binding post_message needs.
        threading.Thread(target=contextvars.copy_context().run, args=(post,), daemon=True, name="tokenwise-notice").start()
        return None
    return start


def _turn_notice(ctx):
    """post_llm_call (once per turn, after its tool loop): what TokenWise saved in this conversation so far, posted
    when it grew since it was last said. Told only once Hermes has shown it. Posted before the hook returns, while
    the turn is still open: the classic CLI reads notices only during a turn (and prints them with the answer), so
    one posted after the turn would be delivered but never shown. ``tokenwise notice`` takes about 0.1 s."""
    def post(session_id: str) -> None:
        try:
            text = _notice("--session", session_id, "--peek")
            if text and _shown(ctx.post_message(text)):
                _notice("--session", session_id, "--told")
        except Exception:  # A courtesy.
            logger.debug("tokenwise: conversation notice failed", exc_info=True)

    def end(session_id: str = "", **_: Any) -> None:
        if session_id and isinstance(session_id, str):
            post(session_id)
        return None
    return end


def _engine_selected() -> bool:
    try:
        from hermes_cli.config import load_config_readonly
        context = (load_config_readonly() or {}).get("context") or {}
        return isinstance(context, dict) and context.get("engine") == "tokenwise"
    except Exception:
        return False


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _remember_session)
    ctx.register_hook("transform_terminal_output", _transform)
    try:  # Hermes 0.22.5+ (older ones refuse an unknown hook name).
        ctx.register_hook("transform_tool_result", _transform_result)
    except Exception:
        logger.debug("tokenwise: transform_tool_result unavailable", exc_info=True)
    if hasattr(ctx, "post_message"):
        ctx.register_hook("on_session_start", _session_notice(ctx))
        ctx.register_hook("post_llm_call", _turn_notice(ctx))
    # Only when chosen: Hermes holds one plugin context engine, and another plugin's must keep its slot.
    if hasattr(ctx, "register_context_engine") and _engine_selected():
        try:
            from .shadow import engine_class
            ctx.register_context_engine(engine_class(_lc)())
        except Exception:  # Hermes falls back to its built-in compressor.
            logger.warning("tokenwise: compaction engine unavailable", exc_info=True)
