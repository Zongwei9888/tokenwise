# TokenWise for CodeBuddy Code

A CodeBuddy plugin. Its `PreToolUse` hook on the `Bash` tool does the main
work: for a command that a TokenWise filter may recognize (test runners, compilers,
`git status/diff`, `grep`/`rg`, `find`, `ls`, build tools, …) the hook
rewrites

```
python3 -m pytest -v
```

to

```
tokenwise run --host codebuddy --session <id> --call <id> -c 'python3 -m pytest --color=no -v'
```

`tokenwise run` executes the script with your shell, keeps the exit code and
signals, saves the original output under `~/.tokenwise`, and prints a
smaller projection when one is admitted. Every other command is left alone.

Verified against CodeBuddy Code 2.175.0 in real `codebuddy -p` sessions:

- A failing `pytest -v` run (150 passed, 1 failed): the model read 1,245
  bytes instead of 13,328, and still named the failing test and its
  assertion. Its history keeps the original command.
- The hook returns no permission decision: an `allow` would skip
  CodeBuddy's permission check entirely, deny rules included. CodeBuddy
  checks the command as the model wrote it, so your rules keep working: with
  `--allowedTools "Bash(python3 -m pytest:*)"` the wrapped run went ahead,
  and with `--disallowedTools "Bash(python3 -m pytest:*)"` it was blocked.
- For `Bash`, CodeBuddy's `PostToolUse` event carries the exit code but not
  the command's output, so results cannot be replaced after the fact;
  wrapping is the only route.
- Background commands (`run_in_background`) are not wrapped: `tokenwise run`
  would hold their output back until they end. Their output is filtered when
  the model reads it with `TaskOutput` (a `PostToolUse` hook) and the read
  holds the whole stdout of the finished command (`chars=0-N`, nothing
  omitted, filtered or still to come); the header, labels and stderr stay.
  `TaskOutput` shows no exit code: a `failed` one is read as exit 1 unless
  CodeBuddy's completion notice gave it. Verified on CodeBuddy 2.184: a
  background `pytest -v` went from 3,300 to 327 tokens.
- `Read`, `WebFetch`, `WebSearch`, `Task` and MCP results are journaled as
  they are. A `Read` that repeats an earlier one (same file and range, same
  text) still in the model's copy of the transcript, with no compaction or
  prompt-too-long recovery since, is a one-line note (2,896 → 79 tokens
  verified); the read right after a note is whole.
- `tokenwise` must be on the `PATH` CodeBuddy runs hooks with
  (`npm install -g @tokenwise/cli`, then `tokenwise doctor`).

## CodeBuddy's own Grep and Glob

Their results reach the model as one line of JSON: an array of absolute paths
(`Glob`, and `Grep` in files_with_matches mode) or of ripgrep rows (`Grep` in
content mode). A `PostToolUse` hook lays them out instead: the common
directory once, then paths grouped by directory, or rows grouped by file,
every path and row kept, in CodeBuddy's order. Verified on CodeBuddy 2.184:
the model read the layout and answered with the same counts and line numbers.
A call made from code in CodeBuddy's REPL is left alone, since that program
reads the array; the hook tells the two apart by CodeBuddy's transcript,
which lists only the model's own calls.

## At the end of an answer

When an answer ends and the conversation saved more than when it was last
said, a `Stop` hook adds a small card: a jar with as many coins as the share it saved, *saved 2,973 tokens in this conversation*, and a bar for *tool output 90% shorter*. The share is of all the tool output TokenWise saw in
the conversation, shortened or not; it is in English whatever your locale.

## Compaction (full, through a mod)

`hooks/compaction.js` is a CodeBuddy mod (an in-process module the plugin's
`hooks.json` lists under `modules`). Verified on 2.175.0:

- `session.compact` sees the span CodeBuddy is about to summarize and adds
  one paragraph to the summarizer's instructions;
- `session.append` sees the summary row as it is stored and rewrites its
  summary into the checkpoint: CodeBuddy's summary, your messages word for
  word, and the catalog of the tool results TokenWise kept (`tokenwise shadow
  checkpoint`). Both shapes CodeBuddy stores are handled: `/compact` (an
  assistant row) and automatic compaction when the context would overflow
  (a user row);
- `tokenwise_recall`, registered as a mod tool, reads any of them again
  (`tokenwise recall`); `tool.check` lets it run without a prompt.

A mod cannot import anything, so the work is done by `tokenwise`; on any failure
CodeBuddy's own summary stays. (CodeBuddy 2.175 ignores messages a
`session.compact` hook hands back, which is why the stored row is rewritten.)

## Learning

`tokenwise setup` also installs the `tokenwise` skill: `/tokenwise` shows what
TokenWise shortens and which commands are worth teaching it, and teaches it one
with you (your agent writes the rule, shows you the before and after on your
own output, and keeps it only when you say so).

`/tokenwise:learn` starts a learning run in the background with this agent as
the learner (`tokenwise learn --learner codebuddy`); `/tokenwise:learn status`
and `/tokenwise:learn cancel` follow and stop it, and `/tokenwise:rules` lists
the learned filters (`off`, `on`, `rollback`). At startup the plugin says when
recorded output is worth learning from and when a run has finished.

## Install

From a checkout of this repository (it doubles as a CodeBuddy marketplace;
CodeBuddy reads `.codebuddy-plugin/` before `.claude-plugin/`):

```sh
codebuddy plugin marketplace add /path/to/tokenwise
codebuddy plugin install tokenwise@tokenwise
```

To try it in one session only:
`codebuddy --plugin-dir /path/to/tokenwise/adapters/codebuddy`.
Check savings with `tokenwise report --host codebuddy`. Turn it off with
`codebuddy plugin disable tokenwise@tokenwise`, or for one run with
`TOKENWISE_DISABLE=1`.
