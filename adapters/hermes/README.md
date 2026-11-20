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

- Output Hermes cut to a head and tail (`... [OUTPUT TRUNCATED - …] ...`) and
  commands it stopped (`[Command interrupted]`, `[Command timed out …]`) pass
  through. Output under 256 characters is left alone without starting
  `tokenwise`.
- Background processes: Hermes hands their output to `transform_terminal_output`
  too, but only its last 200 to 2,000 characters, so that passes. A finished
  process's whole output, read with `process_manage` action `wait` (it exited
  on its own, with an exit code, and Hermes cut nothing), goes to TokenWise
  through `transform_tool_result`. `wait` returns at most the last 2,000
  characters, so this covers short outputs only.
- A file read again unchanged is left to Hermes: its `read_file` already
  answers "unchanged since last read" while the first read is in context.
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
you, keeping the rule only when you say so. Hermes has no switch that keeps a
skill from the model, so here the model can also pick it on its own.

When a session starts (`on_session_start`), the plugin posts a line into the
conversation once when a learning run has finished or a command keeps
coming back long (from `tokenwise notice hermes`; Hermes 0.22.5's
`ctx.post_message`: the TUI's status line, or a line after the turn in the
classic CLI). Hermes cannot be the learner of a background run; the skill
uses another installed agent for that.

## At the end of an answer

When an answer ends and the conversation saved more than when it was last
said, the plugin posts a small card: a jar with as many coins as the share it saved, *saved 2,973 tokens in this conversation*, and a bar for *tool output 90% shorter* into the conversation (at `post_llm_call`,
before the turn closes). The TUI (`hermes --tui`) shows it in its status
line, the classic CLI with the answer. The share is of all the tool output
TokenWise saw in the conversation, shortened or not; it is in English
whatever your locale.

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
