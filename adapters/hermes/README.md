# TokenWise for Hermes Agent

A Hermes plugin (`tokenwise/`) on the `transform_terminal_output` hook. Hermes
hands it the merged output of each finished foreground `terminal` command
after bounding the capture, before its output limit, ANSI stripping and
secret redaction. The plugin passes the command, output and exit code to
`tokenwise hook hermes`; when a TokenWise filter recognizes the output (test
runners, compilers, `git status/diff`, `grep`/`rg`, `find`, `ls`, build
tools, …) the model reads a smaller, deterministic projection, and the
original is saved under `~/.tokenwise`. Commands run as the model wrote
them, so Hermes's approvals are untouched.

Verified against Hermes Agent 0.22.5 by loading the plugin through Hermes's
own plugin manager and running real commands through its `terminal` tool:
the model-bound result of `ls -la pkg` went from 4,197 to 1,350 bytes, and
`find . -name '*.py'` from 1,252 to 1,037.

- Output Hermes cut to a head and tail (`... [OUTPUT TRUNCATED - …] ...`),
  commands it stopped (`[Command interrupted]`, `[Command timed out …]`) and
  background-process output pass through. Output under 256 characters is
  left alone without starting `tokenwise`.
- `transform_terminal_output` carries no session ID, so the plugin also
  observes `pre_tool_call` (without a directive) to journal each call under
  its session.
- Fail-open: no `tokenwise`, a timeout (10 s) or any error leaves Hermes's output
  as it was. The plugin finds `tokenwise` on `PATH`, else in `~/.local/bin`,
  `/opt/homebrew/bin` or `/usr/local/bin` (a gateway started at login may
  have a shorter `PATH`); `TOKENWISE_BIN` names it explicitly.

## The tokenwise skill and the startup notice

`tokenwise setup hermes` also copies the tokenwise skill into
`~/.hermes/skills`. Ask for it with `/tokenwise`: it shows what TokenWise
shortens and which commands are worth teaching it, and teaches it one with
you, keeping the rule only when you say so.

When a session starts (`on_session_start`), the plugin posts a line into the
conversation once when a learning run has finished or a command keeps
coming back long (from `tokenwise notice hermes`; Hermes 0.22.5's
`ctx.post_message`: the TUI's status line, or a line after the turn in the
classic CLI). Hermes cannot be the learner of a background run; the skill
uses another installed agent for that.

## Compaction (full, as a context engine)

```sh
hermes config set context.engine tokenwise     # back: hermes config set context.engine compressor
```

The `tokenwise` engine (`tokenwise/shadow.py`) is Hermes's own
`ContextCompressor` with your `compression:` settings, plus: the summarizer
is told the tool results stay recoverable; before Hermes assembles the
compacted history, every tool result it compacted or shortened is saved
(`tokenwise shadow checkpoint`) and the summary gets the catalog; results Hermes
shortened in the kept head are marked with their ID; and the model gets a
`tokenwise_recall` tool (`tokenwise recall`). Verified on 0.22.5 with a real model.
Any failure falls back to Hermes's own compaction.

## Install

Hermes runs every session in one gateway process, and user plugins are off
until enabled:

```sh
npm install -g @tokenwise/cli            # or: npm install -g ./packages/cli from a checkout
cp -R adapters/hermes/tokenwise ~/.hermes/plugins/tokenwise
hermes plugins enable tokenwise
```

Check savings with `tokenwise report --host hermes`. `hermes plugins disable
tokenwise` turns it off; `TOKENWISE_DISABLE=1` turns it off for one process.
