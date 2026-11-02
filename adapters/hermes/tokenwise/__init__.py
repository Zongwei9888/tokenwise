"""TokenWise for Hermes Agent: Token Economy on the terminal tool, and
LightShadow as a context engine.

Hermes hands ``transform_terminal_output`` the merged output of a finished
foreground command, after its capture window and before its output limit,
ANSI stripping and secret redaction. This plugin passes the command, output
and exit code to ``tokenwise hook hermes`` (the TokenWise CLI), which saves the
original under ``~/.tokenwise``, journals the decision, and answers with a
smaller, deterministic projection when a filter recognizes the output.

Fail-open: no ``tokenwise``, a timeout, an error or an unrecognized output leaves
the output exactly as Hermes captured it. ``TOKENWISE_DISABLE=1`` turns it
off. Background-process output (no exit code yet) is left alone.

The startup notice (a learning run finished, or a command keeps coming back
long) comes from ``tokenwise notice hermes`` when a session starts, and is
posted into that conversation with ``ctx.post_message``.

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


def _transform(command: str = "", output: str = "", returncode: Any = None, task_id: str = "", env_type: str = "",
               tool_call_id: str = "", **_: Any) -> Optional[str]:
    if not isinstance(command, str) or not isinstance(output, str) or not isinstance(returncode, int) or isinstance(returncode, bool):
        return None
    if not (_MIN_CHARS <= len(output) <= _MAX_CHARS) or os.environ.get("TOKENWISE_DISABLE", "").strip() in ("1", "true", "yes"):
        return None
    tokenwise = _lc()
    if not tokenwise:
        return None
    with _SESSIONS_LOCK:
        session_id = _SESSIONS.pop(str(tool_call_id), "") if tool_call_id else ""
    payload = {"hook_event_name": "transform_terminal_output", "command": command, "output": output, "returncode": returncode,
               "session_id": session_id, "task_id": task_id or "", "tool_call_id": tool_call_id or "", "env_type": env_type or "",
               "cwd": os.getcwd()}
    try:
        done = subprocess.run([tokenwise, "hook", "hermes"], input=json.dumps(payload), capture_output=True, text=True,
                              encoding="utf-8", timeout=_TIMEOUT_S)
        if done.returncode != 0 or not done.stdout.strip():
            return None
        projected = json.loads(done.stdout).get("output")
    except Exception:  # Fail-open: Hermes keeps its own output.
        logger.debug("tokenwise: tokenwise hook hermes failed", exc_info=True)
        return None
    return projected if isinstance(projected, str) and projected != output else None


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


def _session_notice(ctx):
    """on_session_start: post the notice into the new conversation, off the turn's path. It counts as told only
    once Hermes has posted it (a one-shot ``hermes -q`` may exit first, and no live conversation refuses it)."""
    def post() -> None:
        try:
            text = _notice("--peek")
            if text and getattr(ctx.post_message(text), "ok", False):
                _notice("--told")
        except Exception:  # The notice is a courtesy.
            logger.debug("tokenwise: startup notice failed", exc_info=True)

    def start(**_: Any) -> None:
        # The copied context keeps the session binding post_message needs.
        threading.Thread(target=contextvars.copy_context().run, args=(post,), daemon=True, name="tokenwise-notice").start()
        return None
    return start


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
    if hasattr(ctx, "post_message"):
        ctx.register_hook("on_session_start", _session_notice(ctx))
    # Only when chosen: Hermes holds one plugin context engine, and another plugin's must keep its slot.
    if hasattr(ctx, "register_context_engine") and _engine_selected():
        try:
            from .shadow import engine_class
            ctx.register_context_engine(engine_class(_lc)())
        except Exception:  # Hermes falls back to its built-in compressor.
            logger.warning("tokenwise: compaction engine unavailable", exc_info=True)
