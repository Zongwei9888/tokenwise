# Changelog

## 0.3.0 (unreleased)

First open-source release line: compact tool output on nine hosts and any shell,
recoverable compaction on every host whose plugin interface
allows it (in full on five, assisted on three), and self-evolving filters. (0.1.0 and 0.2.0 were never published; their contents are part of this release.)

- `tokenwise saved` and `tokenwise dashboard` show what TokenWise saved you:
  the tokens the model did not have to read, this week, in the last 30 days or
  since you installed it, today, per day, and in which agents. In the terminal
  a pixel jar fills with falling coins and the number appears in pixel digits
  (plain text when piped; `--json` for the numbers). In the browser the same
  jar fills as it saves more, a coin dropping in whenever today grows; English
  and Chinese, light and dark. The page only reads, listens on 127.0.0.1 only,
  answers only its own host name and the random token in the address it
  prints, and ships inside the CLI.
- GitHub Copilot CLI joins as the ninth agent (`tokenwise setup copilot`): a
  `postToolUse` hook replaces the model's copy of a bash result, failed
  commands included. Where Copilot shortened the output itself, TokenWise works
  on the original Copilot kept and replaces Copilot's version only when its
  own is shorter. The startup notice shows in Copilot's timeline, `/tokenwise`
  opens the skill, and `tokenwise doctor --probe` covers Copilot too.
- `tokenwise doctor` starts with your agents: for each, whether TokenWise's
  plugin is on in that agent's own settings, whether its `tokenwise` skill is
  current, and when TokenWise last saw one of its commands. `tokenwise doctor
  --probe` goes further: it asks each agent, without a terminal and allowed only
  that command, to run `tokenwise probe <mark>`, and passes it only when the
  agent's own TokenWise records hold that command. `tokenwise setup` ends by
  suggesting it. DeepSeek Harness runs prompts in its own app only and is
  skipped.
- OpenCode and Hermes show the startup notice too (a learning run finished,
  a command keeps coming back long): a toast in OpenCode, a line posted into
  the conversation in Hermes, both from the new `tokenwise notice <agent>`.
  In Grok the notice now appears at the end of a new session's first turn:
  Grok showed a startup message only when the session was reopened.
- Learned rules leave alone what the agent looked up (`grep`, `ls`, `find`,
  `git diff`/`show`/`log`, `curl`, ...), as they do file contents: its output is
  the answer the agent asked for. Such commands are not evidence, are never
  suggested for teaching, and `tokenwise teach` says why.
- Teaching happens in a private temporary directory, so in an agent's sandbox
  (Codex, DSH, Claude Code's) only `tokenwise teach keep` needs escalated
  permissions, and it finds the workspace even when the sandbox had a TMPDIR
  of its own. `teach keep` and `teach preview` verify against the data
  directory, never against checker files the teaching agent could edit; a
  `teach` with nothing to teach leaves a teaching in progress alone; reading a
  file (`cat`, `sed -n`) is refused with that reason.
- Commands are grouped past wrappers and their options (`nice -n 10 make`,
  `sudo -u pg psql`, `env FOO=1 npm test`, `timeout 60 npm test`), and a
  script with a subcommand is a tool of its own (`python manage.py test`,
  `node --test`). Quoted text no longer splits a command into steps when
  telling lookups and file reads apart.
- Learning with Codex works with current Codex releases, which dropped
  `--full-auto`: the learner runs with `--sandbox workspace-write`.
- In an agent's sandbox (Codex, DSH), a `tokenwise` command that cannot write
  its data says so in one line and asks to be run again with escalated
  permissions, instead of failing with a stack trace; `tokenwise checkup` works
  there as it only reads.
- Every `TOKENWISE_*` setting can also be written `TW_*` (`TW_HOME`,
  `TW_DISABLE`): Codex and DSH drop variables with TOKEN in their name from the
  shells they run, so `tokenwise` commands there never saw `TOKENWISE_HOME`.
- The `tokenwise` skill, which `tokenwise setup` installs in every agent
  (`/tokenwise`, `$tokenwise` in Codex): a checkup of what TokenWise shortens
  and which commands are worth teaching it, and teaching a command with the
  person watching. Their agent writes the rule (`tokenwise teach`), shows the
  before and after on their own recorded output (`tokenwise teach preview`),
  and keeps it only on their yes (`tokenwise teach keep`, verified exactly
  like a learning run and marked as taught). The Codex plugin no longer ships
  its own copy. The startup notices name what was learned and point to the
  skill.
- TokenWise's own output (a checkup, a preview) is never shortened, and is
  not evidence to learn from.
- New filters, each with a written contract (`tokenwise filters`) and real
  captured outputs in the conformance corpus (filter runtime `static-v13`;
  every earlier case unchanged):
  - `git-log` (long default and `--oneline` logs: first and last commits
    kept, the middle counted; commits mentioning errors, conflicts or
    reverts always kept) and `git-blame` (repeated hash, author and date
    dropped within a run; every line number and code line kept).
  - `search-context`: grep/rg/git grep `-A/-B/-C` output grouped by file,
    losslessly.
  - `pip-install` and `yarn-install`: dependency-resolution, download and
    progress rows counted; named requirements, warnings and errors kept.
    npm's non-TTY output has nothing safe to remove and is left alone.
  - `docker-build` (BuildKit progress rows counted; every step header and
    every line a step printed kept) and `container-logs` (`docker logs`,
    `docker compose logs`, `kubectl logs`: runs of identical lines folded,
    problem lines never).
  - `make` (idle sub-make directory lines and up-to-date messages counted)
    and `maven` (download and transfer progress counted; a first build went
    from 142 KB to 2 KB).
- `pytest` reads runs behind `| tee` (the summary decides the outcome) and
  folds passing rows in `| tail` and `| head` slices.
- `git-show`: `git show <commit>` and `git log -p` keep every commit header
  and message verbatim and preview oversized hunks exactly as `git diff`
  does; merge diffs and other layouts pass through.
- Every filter is TokenWise code under the MIT license: the 63 declarative
  rules adapted from RTK, which never applied in real sessions recorded on
  eight agents, are gone, with their Apache-2.0 notices. Filter runtime
  `static-v12`: the remaining conformance cases are unchanged.
- Claude Code filters failed commands outside bypassPermissions mode too:
  PostToolUse sees only successful calls, so a command is wrapped in
  `tokenwise run` (and allowed) when it is one simple command the user's own
  permission rules allow and no deny or ask rule could match. Anything else
  runs as written. (RTK solves the same problem by reimplementing each agent's
  permission checks; this is the conservative part of that.) A trailing
  `2>&1` counts as one simple command (seen in a live session, where the
  failing run otherwise went to Claude Code's own 10,000-character cut).
- Commands worth learning from are named by the command inside a loop or a
  condition (`for t in …; do pytest …; done` reads as `pytest`, not `for t`).
- Commands are recognized behind runner prefixes, as RTK and snip do:
  `uv run`, `poetry run`, `pipenv run`, `pdm run`, `rye run`, `hatch run`,
  `bundle exec`, `time` and leading `VAR=value` assignments.
- Learning from every agent: `tokenwise learn --learner L` starts a run in
  the background (`learn status`, `learn cancel` follow and stop it). Claude
  Code, CodeBuddy and Grok get `/tokenwise:learn` and `/tokenwise:rules`;
  Codex gets a `tokenwise` skill. At startup these plugins say once when
  recorded output is worth learning from and when a run finished. New
  learners: `codebuddy` and `grok`, with the shell limited to `./check` and
  `./try`.
- Found in real sessions and fixed:
  - Claude Code, Grok and Hermes now pass every shell output they report
    after the fact through the full decision, not only commands a built-in
    filter recognizes: a learned rule for a project's own script, or for
    output piped through `tail`, never reached those agents, and they
    recorded no evidence for it.
  - Claude Code cuts Bash output over 30,000 characters, saves the whole of
    it and shows the model a preview. TokenWise filtered the cut text as if it
    were complete; it now filters the saved whole output, and replaces the
    preview only when the result is shorter than the cut.
  - Grok names a new session's start `new`; the startup notice now fires there.
  - The `/tokenwise:learn` and `/tokenwise:rules` commands no longer paste
    their arguments into the shell command: CodeBuddy fills empty arguments
    with the command's own name.
  - `tokenwise setup`: DeepSeek Harness installs with `-w` (pnpm before 11
    refuses to add to a profile's workspace root without it), and CodeBuddy
    drops TokenWise's cached copy first, which it otherwise reinstalls
    unchanged when the version is the same.
- Learned rules never shorten file contents: output of `cat`, `head`, `tail`,
  `sed`, `bat`, `jq` and similar readers (not when they read a pipe) is left
  to the built-in filters, and is not shown to learners.
- `tokenwise setup [agent...]` adds TokenWise to every supported agent found
  on PATH (or the ones named) with each agent's own plugin commands, printing
  each one first (`--dry-run` only prints); `tokenwise uninstall [--purge]`
  takes it out again. From a checkout the plugins come from the checkout; from
  the published package, the marketplaces from GitHub, pi and DeepSeek
  Harness from npm, and OpenCode and Hermes from copies the CLI package
  carries.
- The Claude Code, Codex, CodeBuddy and Grok plugins say at startup when the
  `tokenwise` command is missing, instead of doing nothing silently (Codex
  asks to trust the changed hooks again).
- Names: packages `@tokenwise/*`, the `tokenwise` command (alias `tw`), plugin
  ids `tokenwise@tokenwise`, the `tokenwise_recall` tool, data in
  `~/.tokenwise` (`TOKENWISE_HOME`) and `TOKENWISE_*` variables. The
  configuration has an `output` section (compact output and learning) and a
  `compaction` section (`TOKENWISE_OUTPUT`, `TOKENWISE_COMPACTION`). Learned
  rules get their helpers as `tw`. The filter runtime is `static-v11`.
- Recoverable compaction: when pi or DeepSeek Harness compacts, tool results in the
  compacted span are saved and replaced by references with a 320-byte
  excerpt; the host's own summarizer reads the span in full and keeps the
  findings; the checkpoint keeps
  the user's messages verbatim and lists the references; `tokenwise_recall`
  reads any of them again (exactly, or a window of up to 8 KB around a
  string or around a line, numbered, or the complete original TokenWise
  shortened). A checkpoint that is
  not smaller, or any failure, leaves the compaction to the host. On pi
  through `session_before_compact` (references also stored in the compaction
  entry); on DeepSeek Harness by wrapping `summarize` of each preset's
  compaction engine, and the tool-result pruner keeps the complete text of
  results it cuts. `compaction.mode`, `TOKENWISE_COMPACTION`; `/tokenwise`,
  `tokenwise report` and `tokenwise doctor` report it. Each reference names the call that
  produced it (command or path), and the catalog lists every reference of a
  long session within 8% of the span's tokens (only the newest 40 in full,
  older ones by their call), instead of the newest 200. A result DeepSeek
  Harness's pruner had cut is referenced by its complete text. On pi, a
  summary that fails (it ran past pi's output budget once in a real ~1M-token
  span) is redone with pi's own instructions and the references are kept; a
  checkpoint that falls back records the error in the journal.
  A compaction right after another, whose span is mostly the previous
  checkpoint, lists the carried references by their call alone when the full
  catalog leaves no room for a summary, instead of falling back to the host's
  summary, which dropped every observation_id.
- Recoverable compaction on every host whose plugin interface allows it, in two tiers
  (`tokenwise doctor` shows which). **Full** (the checkpoint replaces the host's
  summary): OpenCode through its experimental compaction hooks
  (`session.compacting`, `chat.messages.transform`, `text.complete`, plus a
  `tokenwise_recall` plugin tool); Hermes as a context engine
  (`context.engine: tokenwise`) that is Hermes's own compressor with the
  checkpoint, recall as an engine tool, and results Hermes shortened outside
  the summary marked with their ID; CodeBuddy through a mod in the plugin
  (`session.append` rewrites the stored summary, recall is a mod tool).
  **Assisted** (the host keeps writing its summary; a new `compactionContext`
  capability): Claude Code (`SessionStart(compact)` adds the catalog under its
  10,000-character limit, read from the transcript, the subagent's when a
  subagent compacted; PreCompact adds a line to the summarizer's
  instructions), Codex (`SessionStart(compact)` with a raised
  `additionalContextLimit`; the catalog shows the code-mode call) and Grok
  (PostCompact reads the span from the session's `updates.jsonl`, which also
  covers automatic compaction in segments mode, where Grok writes no
  `compaction_requests/`; the next tool result, or Stop, carries the
  catalog). Their recall tool is the plugin's MCP server. Each
  assisted catalog lists every reference of the session, since hosts drop
  the previous one. Verified on each host with a real model.
- `tokenwise mcp`: a dependency-free MCP server (stdio) with `tokenwise_recall`
  (read-only annotations, so Codex runs it without asking); `tokenwise recall`;
  `tokenwise shadow checkpoint|catalog|instruction|tool` (JSON on stdin) for
  adapters that are not JavaScript or run outside the host. The service
  behind them (`shadowCheckpoint`, `shadowCatalog`, `recallFromJournal`) is in
  `@tokenwise/mechanisms`; `docs/adapters.md` explains how to connect a
  new agent.
- A command ending in `2>&1` or `| tee <file>` (agents add them to most
  test runs, as in `cd /repo && python3 -m pytest -v 2>&1 | tee run.txt`) is
  recognized like the command without them; before, its output passed
  through unfiltered. Found in real
  agent sessions, where it hid the largest outputs (a 31 KB pytest run).
- A shortened output ends with one line naming its original's ID
  (`[TokenWise shortened this output. The complete output is observation
  o-…: read it with tokenwise_recall …, or run tokenwise recall o-….]`), placed
  before the host's own footer, and only when the projection still saves
  enough with it; lossless layouts get none. The recall tool and `tokenwise recall`
  read these originals by that ID before any compaction (pi shows its recall
  tool when the first one appears). A learned rule's original read this way
  counts toward switching the rule off.
- A program given by its path (`.venv/bin/pytest`,
  `/opt/homebrew/bin/python3 -m pytest`, `/usr/bin/git diff`) is recognized
  by the built-in filters like the bare name; learned rules still see the
  command as written.
- A recall query that does not occur exactly is matched again ignoring
  case: Kimi K2.6 on OpenCode searched a spec it had read for "archived"
  where the text said "Archived", and got nothing.
- Recall on a line longer than its 8 KB window (minified JSON, a
  JSON-escaped log) returns the part around the match, not the line's start.
- An assisted catalog under a tight limit (Claude Code's 10,000 characters)
  gives fewer lines an excerpt when that lists more IDs: 128 instead of 43
  in a 1,000-result session.
- A recall through `tokenwise mcp`, which does not know its session, is journaled
  under the session whose checkpoint (or output decision) holds the ID, so
  `tokenwise report` and learning count it.
- A compaction whose span has no tool result to keep records `standard`
  with reason `nothing-recallable` instead of an empty catalog.
- A `TOKENWISE_HOME` gets its own sandbox fallback directory in `$TMPDIR`
  (`tokenwise-<uid>-<hash>`); before, every home shared one, so a separate
  home (a test, a second profile) read journals other homes' sandboxed
  sessions kept there.
- CodeBuddy: an automatic (emergency) compaction's summary, stored as a user
  row with `input_text` and no inner `<summary>`, is rewritten like a
  `/compact` one; before, TokenWise skipped it. The mod starts `tokenwise` through
  `/bin/sh` or `cmd.exe` when CodeBuddy's launcher does not find it on PATH.
- Claude Code, CodeBuddy Code and Grok Build plugins (`adapters/claude-code`,
  `adapters/codebuddy`, `adapters/grok`; the checkout is a marketplace for
  each), all running `tokenwise hook <host>`. Claude Code: `PostToolUse` replaces a
  successful Bash call's output, and in `bypassPermissions` mode `PreToolUse`
  wraps commands in `tokenwise run`, so failed calls are filtered too; it never
  returns a permission decision. CodeBuddy: `PreToolUse` wraps commands in
  `tokenwise run` with no permission decision (CodeBuddy checks the command as
  written, so allow and deny rules keep working; its `PostToolUse` carries no
  output). Grok: `PostToolUse` replaces the model's copy of a shell result,
  failed commands included. The Claude Code hook leaves Grok's and
  CodeBuddy's events to their own plugin. Journal records of result-replacing
  hooks have `delivery: "result-hook"`.
- OpenCode plugin (`@tokenwise/opencode`, one file for
  `~/.config/opencode/plugins/`): `tool.execute.after` replaces a recognized
  bash result before OpenCode stores it, failed commands included; output
  OpenCode already cut, and timeouts, pass through.
- Hermes Agent plugin (`adapters/hermes/tokenwise`, Python): hands
  `transform_terminal_output` to `tokenwise hook hermes`, before Hermes limits,
  strips and redacts the output; output Hermes cut, stopped commands and
  background output pass through; `pre_tool_call` (observed, no directive)
  supplies the session ID. Fail-open when `tokenwise` is missing or slow.
- Self-evolving filters: the engine keeps the original of every complete
  shell output as evidence (`output.evidence`), with its stream layout.
  `tokenwise evolve --learner pi|dsh|claude|codex|<command>` writes a workspace
  with the most promising evidence, runs the learner, replays every recorded
  observation with the current and the proposed rules plus a set of
  preservation requirements, and adopts the proposal only if every
  requirement holds, no rule fails, and the total saving grows with no
  observation saving less. Learned rules run before the built-in filters, in
  a sandboxed V8 context, and a result that drops a diagnostic line or has an
  invalid source map is discarded. `tokenwise rules` lists, shows, switches off and
  rolls back adoptions; `output.learnedRules` switches them off.
- Learning from the hosts' own interfaces. pi: `/tokenwise` opens a panel
  (savings, learned rules and their use, commands worth learning from, a run
  in progress; `l` learn, `c` cancel, `r` roll back, `o` off/on), the status
  bar follows a run, and pi announces its result; the learner is pi on the
  session's model. DeepSeek Harness: a *Self-evolution* section on the
  plugin's Plugins page (Web and Desktop) with **Learn now**, live progress,
  the learned rules with a switch and **Roll back**, a toast when a run
  ends, and one when recorded output becomes worth learning from (the scan
  runs again two minutes after new output, otherwise every ten; commands
  newly worth learning from are named first); the learner is DSH headless on the default model and the profile's
  providers. Both run learning as a separate process (one at a time across
  hosts, 20 minutes at most, cancellable); running sessions use adopted rules
  from their next output on. `/tokenwise learn | cancel | rules | rollback |
  off | on` on both hosts.
- Verification holds observations back: the learner sees at most 70% of each
  command's observations, and a proposal whose improved commands save
  nothing more on the held-back ones is rejected (`did-not-generalize`).
- In-use monitor: a learned rule whose original the agent asks
  `tokenwise_recall` for 3 times and in at least 1 of 5 uses is switched off
  (an adoption that can be rolled back), and the next learner is told.
- Switching learned rules back on restores the ones in use when they were
  switched off.

- `@tokenwise/core`: the deterministic output filters of the TokenWise
  research runtime — 17 shell-output filters plus 2 host-native search
  formats, all TokenWise code — source maps, the strict-shrink admission rule
  and command normalization, with no host dependency. A conformance corpus
  pins them byte-for-byte to the research runtime; `static-v12` keeps every
  research-runtime result and adds `git-show`.
- `@tokenwise/protocol`: host capability vocabulary, verified host profiles
  and mode negotiation (`off` / `observe` / `apply`).
- `@tokenwise/store`: private journal, content-addressed original store with
  retention, and configuration (a project's file can only lower the mode).
- `@tokenwise/mechanisms`: the compact-output engine (save original → journal →
  deliver projection; fail-open) and session receipts.
- `@tokenwise/cli`: `tokenwise run`, `tokenwise hook codex|claude|codebuddy|grok|hermes`, `tokenwise report`, `tokenwise doctor`,
  `tokenwise filters`, `tokenwise show`, `tokenwise gc`.
  `tokenwise <command> --help` prints the usage, and an unknown option prints one
  line (exit 2) instead of a stack trace.
- `@tokenwise/pi`: pi package (`pi install npm:@tokenwise/pi`) using
  `context_edit`, so pi's session keeps the original output; status bar,
  `/tokenwise`, `--tokenwise` flag. Tested on pi 1.1.0 and 1.2.0.
- `@tokenwise/dsh`: DeepSeek Harness 0.2.x bundle, installable from the
  Plugins page or `dsh plugin add`; filters the `bash` tool in
  `tools/post-execute` before DSH's spill policy; live Mode setting on its
  Plugins page; `/tokenwise`; display metadata and icon. Tested on
  0.2.0-rc.2 and 0.2.1-alpha.2 (CLI and Web UI on macOS and Linux, the
  Desktop app on macOS: the signed 0.2.0-rc.2 release and a 0.2.1-alpha.2
  build).
- Native search tools: results of pi's `grep` / `find` and DeepSeek
  Harness's `grep` / `glob` are laid out losslessly (`native-grep`,
  `native-glob`): rows grouped by file, paths by directory, every match,
  line number, path and notice kept. They go through the same admission,
  original store and journal as shell output.
- Subagents: both plugins filter the `bash` output of subagents (DSH's
  in-process `subagent` / `subagent_fork`; pi subagent extensions that start
  `pi` processes). A `session/subagent` journal record links each subagent
  session to its parent, so `/tokenwise`, pi's status bar and
  `tokenwise report --session` include what subagents saved. On pi the parent's
  session ID is handed to direct child processes only, so `/new`, `/resume`
  and `/fork` never count as subagents.
- `adapters/codex`: Codex plugin whose `PreToolUse` hook wraps recognizable
  shell commands in `tokenwise run`; the repository doubles as a Codex marketplace.
- The published packages are self-contained bundles with their licenses and
  notices; `e2e/` installs them into published host releases and runs real
  sessions, the DSH Web UI and Desktop app, and pi's TUI (CI on Ubuntu and
  macOS).
