# TokenWise for Claude Code

A Claude Code plugin with two hooks on the `Bash` tool, both running
`tokenwise hook claude`:

- **`PostToolUse`** replaces the output of a successful Bash call with
  TokenWise's projection when a filter recognizes it (test runners,
  compilers, `git status/diff`, `grep`/`rg`, `find`, `ls`, build tools, …).
  The command runs exactly as the model wrote it; the original output is
  saved under `~/.tokenwise`.
- **`PreToolUse`**, in `bypassPermissions` mode only, wraps a recognizable
  command as `tokenwise run --host claude --session <id> --call <id> -c '<command>'`,
  so failed calls are filtered too (see below).

Verified against Claude Code 2.1.310 in real `claude -p` sessions:

- A passing `pytest -v` run (150 tests): the model read 575 bytes instead of
  12,658, and answered from them. In `bypassPermissions` mode a failing run
  went from 13,328 to 1,245 bytes, keeping the failing test's node id and
  assertion. In both, the model's history keeps the original command.
- Claude Code sends a failed call (non-zero exit) to `PostToolUseFailure`,
  which cannot replace output, so outside `bypassPermissions` failed calls
  reach the model unchanged.
- Commands are never rewritten outside `bypassPermissions`: a wrapped command
  would no longer match your permission rules (`Bash(pytest:*)` would not
  match `tokenwise run … -c 'pytest'`, and neither would Claude Code's built-in
  read-only commands), so it would prompt where it did not before, and a deny
  rule would stop matching. The hook never returns a permission decision.
- Claude Code's transcript keeps what the model read (the projection);
  `tokenwise show <sha256>` prints the original.
- A command run in the background (`run_in_background`) is remembered when it
  starts. Once it has exited, its output file (`…/tasks/<id>.output`, which
  then ends `[exited with code N]`) is filtered as that command's output when
  the model reads it whole with `Read` or `cat`; read while running, in part,
  or after `[killed]`, it passes. Verified on Claude Code 2.1.325: a
  background `pytest -v` read through its output file went from 3,299 to 326
  tokens, and the model named the failing test and its assertion.
- `PostToolUse` also sees `Read`, `WebFetch`, `WebSearch`, `Agent` and MCP
  tools: their text is journaled as it is. A `Read` that repeats an earlier
  one (same file and range, same text) whose result the transcript still
  shows, with no compaction or clearing after it, comes back as a one-line
  note pointing to it; read again right after, the file comes back whole. A
  subagent's reads are always whole. Verified on Claude Code 2.1.325: a
  122-line file read twice cost 2,896 tokens once, and the model answered
  from the first read.
- Grok and CodeBuddy also run Claude Code hooks. `tokenwise hook claude` recognizes
  their events and leaves them to their own TokenWise plugin, so nothing is
  filtered twice.
- `tokenwise` must be on the `PATH` Claude Code runs hooks with
  (`npm install -g @tokenwise/cli`, then `tokenwise doctor`).

## At the end of an answer

When an answer ends and the conversation saved more than when it was last
said, a `Stop` hook adds a small card: a jar with as many coins as the share it saved, *saved 2,973 tokens in this conversation*, and a bar for *tool output 90% shorter*. The share is of all the tool output TokenWise saw in
the conversation, shortened or not; it is in English whatever your locale.

## Compaction (assisted)

Claude Code writes the compaction summary itself and no plugin may replace
it, so TokenWise works around it (verified on 2.1.312):

- **PreCompact** adds one paragraph to the summarizer's instructions: keep
  the findings, the tool results stay recoverable.
- **SessionStart** with source `compact` reads the transcript, saves every
  tool result of the span Claude Code just compacted (the subagent's
  transcript when a subagent compacted), and adds the catalog of everything
  the session can recall, under Claude Code's 10,000-character limit for
  added context. It is stored in the transcript, so it survives a resume.
- The plugin's MCP server (`.mcp.json`: `tokenwise mcp --host claude`, always
  loaded) gives the model `mcp__plugin_tokenwise_tokenwise__tokenwise_recall`;
  a PreToolUse hook lets it run without a prompt, since it only reads what
  TokenWise saved.

In a real run (Haiku, compaction forced at ~35k tokens) the model answered a
question about a file it no longer had in context by calling the recall tool.

## Learning

`tokenwise setup` also installs the `tokenwise` skill: `/tokenwise` shows what
TokenWise shortens and which commands are worth teaching it, and teaches it one
with you (your agent writes the rule, shows you the before and after on your
own output, and keeps it only when you say so).

`/tokenwise:learn` starts a learning run in the background with this agent as
the learner (`tokenwise learn --learner claude`); `/tokenwise:learn status`
and `/tokenwise:learn cancel` follow and stop it, and `/tokenwise:rules` lists
the learned filters (`off`, `on`, `rollback`). At startup the plugin says when
recorded output is worth learning from and when a run has finished.

## Install

From a checkout of this repository (it doubles as a Claude Code marketplace):

```sh
claude plugin marketplace add /path/to/tokenwise
claude plugin install tokenwise@tokenwise
```

New sessions load it. To try it in one session only:
`claude --plugin-dir /path/to/tokenwise/adapters/claude-code`.
Check savings with `tokenwise report --host claude`.

Turn it off with `claude plugin disable tokenwise@tokenwise`, or for one run
with `TOKENWISE_DISABLE=1`. Set `{"output": {"mode": "observe"}}` in
`~/.tokenwise/config.json` to record what would change without changing
anything.
