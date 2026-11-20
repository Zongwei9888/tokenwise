# TokenWise for GitHub Copilot CLI

A Copilot CLI plugin with a `postToolUse` hook on the `bash` tool, running
`tokenwise hook copilot`. When a TokenWise filter or learned rule recognizes a
shell result, the hook's `modifiedResult` replaces the model's copy of it with
TokenWise's projection, keeping Copilot's own status line
(`<shellId: N completed with exit code X>`). The command runs exactly as the
model wrote it, and permissions are untouched.

Verified against Copilot CLI 1.0.103 in `copilot -p`:

- Failed commands reach `postToolUse` too (a result of type `success` whose
  status line carries the exit code), so a failing test run is shortened with
  its failure intact.
- Copilot shortens some output itself and keeps the original in a file it
  names (`Shell output was automatically compacted … Original at …`). TokenWise
  reads that original (only a file of Copilot's naming in your temporary
  folder), records it, and replaces Copilot's version only when its own
  projection is shorter. On a failing `pytest -v` with 151 tests, the model
  read 1,108 bytes instead of Copilot's 1,227 (13,191 originally).
- Output Copilot saved to a file because it was too large and other tools
  pass through. A shell that goes on running (`mode: async`, detached, or
  still running after its wait) is remembered; its output is filtered when the
  model's `read_bash` finds the command finished, the read holding its whole
  output and the status line `<shellId: X completed with exit code N>`.
  Verified on Copilot 1.0.107: a background `pytest -v` went from 3,299 to 279
  tokens (Copilot had compacted it itself first). When a background shell
  finishes while the session is idle, Copilot reads it on its own, without a
  hook, so that read is not filtered.
- Every other tool's text is journaled as it is. A `view` that repeats an
  earlier one (same path and range, same text) still in the session's events,
  under five minutes old and with no compaction, truncation or clear since,
  is a one-line note (2,744 → 78 tokens verified); the view after a note is
  whole.
- At the start of a session a `sessionStart` hook says, as a line in Copilot's
  timeline, when the `tokenwise` command is missing, when a command keeps
  coming back long, and when a learning run finished.
- No Copilot hook lets anything into a compaction, so Copilot compacts with its
  own summary; TokenWise's originals stay readable with `tokenwise show`.
- Copilot cannot be the learner; `tokenwise learn --learner <another agent>`
  learns from Copilot's recorded output as well.

## At the end of an answer

When an answer ends and the conversation saved more than when it was last
said, an `agentStop` hook adds to Copilot's timeline a small card: a jar with as many coins as the share it saved, *saved 2,973 tokens in this conversation*, and a bar for *tool output 90% shorter* (without colour: Copilot drops it). The share is of all the tool output TokenWise saw in
the conversation, shortened or not; it is in English whatever your locale.

## Install

`tokenwise setup copilot` adds the marketplace in this repository
(`.github/plugin/marketplace.json`, which lists `adapters/copilot`), installs
`tokenwise@tokenwise` from it and copies the `tokenwise` skill to
`~/.copilot/skills`. By hand, from a checkout:

```sh
copilot plugin marketplace add "$PWD" && copilot plugin install tokenwise@tokenwise
cp -R skills/tokenwise ~/.copilot/skills/
```

In Copilot, type `/tokenwise` for a checkup or to teach TokenWise a command.

## Checking it

`tokenwise doctor` reads `enabledPlugins` in `~/.copilot/settings.json`.
`tokenwise doctor --probe copilot` asks Copilot to run `tokenwise probe
<mark>`: Copilot's permission rules match only a whole program, so during the
probe (and only then, when `TOKENWISE_PROBE` is set) the plugin's `preToolUse`
hook allows that one command and denies every other tool call.
