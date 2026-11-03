# TokenWise for OpenCode

An OpenCode plugin. Its `tool.execute.after` hook receives each `bash`
result before OpenCode stores it and the model reads it; when a TokenWise
filter recognizes the output (test runners, compilers, `git status/diff`,
`grep`/`rg`, `find`, `ls`, build tools, …) the result is replaced by a
smaller, deterministic projection. The original is saved under
`~/.tokenwise` first. The command runs as the model wrote it, so OpenCode's
permissions are untouched.

Verified against OpenCode 1.19.4 in real `opencode run` sessions:

- A failing `pytest -v` run (150 passed, 1 failed): the model read 1,243
  bytes instead of 13,326 and still named the failing test and its
  assertion; a passing run went from 12,659 to 576 bytes. Failed commands are
  filtered like any other.
- OpenCode's own display (`metadata.output`) keeps what the command printed;
  its session database stores what the model read, and `tokenwise show <sha256>`
  prints the original.
- OpenCode merges stdout and stderr. Output OpenCode already cut to its tail
  (its full text goes to a file), and results of a timeout or an abort, pass
  through unchanged.
- OpenCode starts every function a plugin module exports, so the bundle
  exports only `TokenWise`.

## Compaction (full)

Through OpenCode's compaction hooks (all `experimental.*`; verified on
1.19.4): `session.compacting` adds a paragraph to the summarizer's prompt,
`chat.messages.transform` reads the span being summarized, and
`text.complete` on the summary turns it into the checkpoint (OpenCode's
summary, your messages word for word, the catalog), which OpenCode stores
and replays. The plugin also registers the `tokenwise_recall` tool. Every
hook catches everything: an uncaught error would abort OpenCode's
compaction. In a real run with two automatic compactions in one turn, the
model answered from one recall.

## The tokenwise skill and the startup notice

`tokenwise setup opencode` also copies the tokenwise skill into
`~/.config/opencode/skills`. Ask for it with `@tokenwise`: it shows what
TokenWise shortens and which commands are worth teaching it, and teaches it
one with you (your agent writes the rule, shows you the before and after on
your own output, and keeps it only when you say so).

When a session starts, a toast says once when a learning run has finished
or when a command keeps coming back long (the text comes from `tokenwise
notice opencode`, so it needs the `tokenwise` command; without it there is
no toast). OpenCode cannot be the learner of a background run; the skill
uses another installed agent for that.

## Install

Build the bundle from a checkout (`pnpm install && pnpm build`), then copy it
into OpenCode's global plugin directory:

```sh
cp adapters/opencode/dist/index.js ~/.config/opencode/plugins/tokenwise.js
```

Or into one project's `.opencode/plugins/` to try it there only. New
sessions (and `opencode serve` instances, per directory) load it. Check
savings with `tokenwise report --host opencode` (`npm install -g @tokenwise/cli`).

Remove the file to uninstall; `TOKENWISE_DISABLE=1` turns it off for one run,
and `{"output": {"mode": "observe"}}` in `~/.tokenwise/config.json` records
what would change without changing anything.
