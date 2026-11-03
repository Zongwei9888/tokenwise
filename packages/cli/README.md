# tokenwise — the TokenWise command

```sh
npm install -g @tokenwise/cli
tokenwise doctor
```

`tokenwise` runs any command with TokenWise's output filtering, serves the Codex
hook, reports what TokenWise saved on every host (pi, DeepSeek Harness,
Codex), and learns new filter rules from your own sessions (`tokenwise evolve`).

```
tokenwise run -c '<script>'            run with your shell, print the filtered output (exit code and signals pass through)
tokenwise run -- <program> [args...]   run a program directly
tokenwise hook codex                   Codex PreToolUse hook handler (reads hook JSON on stdin)
tokenwise report [--host H] [--session S] [--json]   savings; a session includes its subagent sessions
tokenwise filters [--json]             every filter and what it preserves
tokenwise show <sha256>                print a saved original
tokenwise gc [--days N]                delete saved originals older than N days
tokenwise doctor [--json]              configuration and per-host capability negotiation
tokenwise evolve --learner pi|dsh|claude|codex|"<command>" [--since 7d] [--max-cases N] [--timeout 30m] [--dry-run] [--json]
                                one evolution step: the learner writes rules from your evidence;
                                they are adopted only if replaying every recorded output shows a gain
                                with no output saving less, and every preservation requirement holds
tokenwise rules [list|show|path|off|rollback] [--json]
                                the adopted rules; new sessions on every host use the active set
tokenwise checkup [--json]             what it shortens, its learned rules, and the commands worth teaching it
tokenwise teach "<command>"            teach it one command from your own agent (the tokenwise skill runs this);
                                then teach check | preview | keep | drop
tokenwise preview "<command>"          a recorded output of that command: the original and what the model reads
```

Requires Node.js 22 or newer. The package is a single self-contained file
with no dependencies. See the
[TokenWise README](https://github.com/HKUDS/TokenWise#readme) for
configuration and the [Codex plugin](https://github.com/HKUDS/TokenWise/tree/main/adapters/codex).
