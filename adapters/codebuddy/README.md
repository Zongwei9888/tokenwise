# TokenWise for CodeBuddy Code

A CodeBuddy plugin with one `PreToolUse` hook on the `Bash` tool. For a
command that a TokenWise filter may recognize (test runners, compilers,
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
- CodeBuddy's `PostToolUse` event carries the exit code but not the
  command's output, so results cannot be replaced after the fact; wrapping
  is the only route.
- Background commands (`run_in_background`) are not wrapped: `tokenwise run`
  would hold their output back until they end.
- `tokenwise` must be on the `PATH` CodeBuddy runs hooks with
  (`npm install -g @tokenwise/cli`, then `tokenwise doctor`).

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
