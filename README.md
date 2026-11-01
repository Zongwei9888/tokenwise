<div align="center">

<h1>
  <img src="docs/assets/logo.svg" width="48" height="48" align="absmiddle" alt="">
  TokenWise: Make every token count for your agent
</h1>

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0F766E?style=flat-square&labelColor=0E2A26"></a>
  <img alt="Agents: 8 and any shell" src="https://img.shields.io/badge/agents-8_%2B_any_shell-0F766E?style=flat-square&labelColor=0E2A26">
  <img alt="Runtime dependencies: 0" src="https://img.shields.io/badge/runtime_deps-0-0F766E?style=flat-square&labelColor=0E2A26">
</p>

**English** · [简体中文](docs/zh/README.md)

### The self-evolving token layer for AI agents

**Context on demand. Savings that grow with use. One install for every agent.**

</div>

## Why TokenWise

Coding agents spend most of their context reading what they never needed:
passing tests, progress bars, download logs, the same build banner for the
hundredth time. You pay for every one of those tokens, and the context fills up
before the work is done.

Then the agent compacts its history to make room, and the one line that
mattered is gone. Saving tokens by throwing things away just moves the cost.

And every project is different. Its own scripts, its own logs, its own noise —
a fixed list of rules never learns any of it. Meanwhile you use more than one
agent, and each of them starts from zero.

**TokenWise sits between your agents and the model, and gives every one of them:**

- **Context on demand.** The model reads only what it needs right now. Everything
  else stays intact on your machine, one call away, even after the agent compacts
  its memory. You save tokens, not information.
- **Self-evolving.** TokenWise learns your project from your own sessions and
  saves more every round. A new rule is used only after it is checked against
  everything recorded, and it switches itself off if it ever gets in the way.
- **Cross-platform.** One install for Claude Code, Codex, Hermes, OpenCode,
  CodeBuddy, Grok, DeepSeek Harness, pi and any shell, with more on the way.
  What one agent learns, all of them use.

### Up to half the tokens. Never a worse result.

| While your agent is… | Token bill | How the work turns out |
|---|---|---|
| **fixing bugs, building features**<br><sub>everyday coding</sub> | **14–38% smaller** | as many tasks solved, or more |
| **grinding through long terminal jobs**<br><sub>dozens of commands in a row</sub> | **25–50% smaller**<br><sub>the same budget goes up to twice as far</sub> | up to 7.5 points more tasks solved |
| **in sessions that outgrow the context**<br><sub>very long conversations</sub> | **21–45% smaller** | remembers better: a fact that kept changing is recalled right 98% of the time, not 45% |

**12 comparisons. 12 times cheaper. 0 times worse.** Four models, three kinds of work.

**Same coding task, 38% fewer tokens,** and it was solved more often (83% → 85%).

<sub>From our paper's evaluation: DeepSeek V4 Flash, MiniMax-M3, GLM-5.3 Flash and Qwen3.8 Flash in DeepSeek Harness, against the harness's own context management, counting every token including cache reads. Paper coming soon.</sub>

<p align="center"><img src="media/images/story-how.png" alt="Your agents send everything they read through TokenWise, one layer shared by every agent. Context on demand: what the model needs stays in context, everything else stays on your machine, one call back. Self-evolving: use, learn, verify, every agent; saves more each round. The model reads only what it needs." width="100%"></p>

## 🧬 Self-evolving

Built-in rules know the common tools. Your project has its own. When you ask,
the agent you already use studies what your sessions recorded and writes a rule
for the noise it finds — in the background, without interrupting your work.

TokenWise adopts a rule only if it saves more on **every** recorded run, drops no
error and also works on runs it has not seen. From the next command on, every
agent uses it. If an agent keeps having to look past a rule, the rule switches
itself off, and any adoption can be undone.
On tasks it has never seen, the learned rules save another 12–27% of tokens.

Start a round from wherever you work: `/tokenwise:learn` in Claude Code,
CodeBuddy and Grok, `$tokenwise learn` in Codex, the TokenWise panel in pi and
DeepSeek Harness, or `tokenwise learn` in any terminal. Your agents also tell you
when recorded output is worth learning from.

## 💾 Context on demand

Think of it as virtual memory for your agent's context. What the model needs now
stays in context; the rest is set aside on your machine and comes back with one
call, exactly as it was. That holds for a single noisy command and for a whole
history the agent has just compacted, so the agent never has to run the tests
again to see one line.

<p align="center"><img src="media/video/fold.gif" alt="A 260-line pytest run folds into the 17 lines the model reads; the failure stays" width="100%"></p>

## 🤖 Supported agents

<table width="100%">
  <tr>
    <td align="center" width="20%"><img src="media/agents/claude-code.svg" width="48" height="48" alt=""><br><strong>Claude Code</strong></td>
    <td align="center" width="20%"><img src="media/agents/codex.svg" width="48" height="48" alt=""><br><strong>Codex</strong></td>
    <td align="center" width="20%"><img src="media/agents/hermes.svg" width="48" height="48" alt=""><br><strong>Hermes Agent</strong></td>
    <td align="center" width="20%"><img src="media/agents/opencode.svg" width="48" height="48" alt=""><br><strong>OpenCode</strong></td>
    <td align="center" width="20%"><img src="media/agents/codebuddy.svg" width="48" height="48" alt=""><br><strong>CodeBuddy</strong></td>
  </tr>
  <tr>
    <td align="center" width="20%"><img src="media/agents/grok.svg" width="48" height="48" alt=""><br><strong>Grok Build</strong></td>
    <td align="center" width="20%"><img src="media/agents/dsh.svg" width="48" height="48" alt=""><br><strong>DeepSeek Harness</strong></td>
    <td align="center" width="20%"><img src="media/agents/pi.svg" width="48" height="48" alt=""><br><strong>pi</strong></td>
    <td align="center" width="20%"><img src="media/images/icons/agent-shell.png" width="48" height="48" alt=""><br><strong>Any shell</strong></td>
    <td align="center" width="20%"><a href="#whats-next"><img src="media/images/icons/agent-more.png" width="48" height="48" alt=""><br><strong>More coming</strong></a></td>
  </tr>
</table>

macOS and Linux. Each agent connects through what its own plugin interface
allows, so the depth varies a little; the details are under [How each agent is connected](#how-each-agent-is-connected).

## 🚀 Get started

Give your agent this repository and ask:

> Install TokenWise for every agent on this machine.

Or do it yourself (Node.js 22 and pnpm; TokenWise is not on npm yet):

```sh
git clone https://github.com/HKUDS/TokenWise.git
cd TokenWise && pnpm install && pnpm build
npm install -g ./packages/cli
tokenwise setup        # finds your agents and adds TokenWise to each
```

There is nothing to configure: it works from the next command. When you want it
to learn your project, run `/tokenwise:learn` (or the equivalent above).
`tokenwise report` shows what was saved; `tokenwise uninstall` takes it out again.

## ✨ Technical highlights

- **Nothing is invented.** Every character the model reads comes from the real
  output; every cut is counted, and the original is always one call away.
- **Errors are never cut.** Failures, warnings and totals always stay; anything
  TokenWise does not recognize passes through untouched.
- **Deterministic.** The same output always reads the same, so prompt caches keep
  hitting.
- **Fails open.** Any error delivers the original.
- **Local.** Originals stay on your machine, readable only by you. TokenWise makes
  no network requests of its own.
- **Tested on real agents.** Unit tests, a byte-for-byte conformance corpus of
  real tool outputs, and rounds with real models on all eight agents.
- **MIT, zero runtime dependencies.**

## 📰 News

- **2026-10** · TokenWise is open source: self-evolution reachable from every agent,
  one-command setup, and every filter rewritten as TokenWise code.

## What's next

- More agents: GitHub Copilot CLI, Gemini CLI, Cursor and others.
- More built-in rules for common tools, each one checked on real output.
- The paper behind TokenWise, with a full evaluation.

## For agents and the curious

<details>
<summary><strong>Install by hand, agent by agent</strong></summary>
<br>

From the checkout, after `npm install -g ./packages/cli`:

```sh
pi install "$PWD/adapters/pi"                                   # pi
dsh plugin --profile web add -w "$PWD/adapters/dsh"             # DeepSeek Harness (your profile)
claude plugin marketplace add "$PWD" && claude plugin install tokenwise@tokenwise
codex plugin marketplace add "$PWD" && codex plugin add tokenwise@tokenwise    # then trust its hooks in /hooks
codebuddy plugin marketplace add "$PWD" && codebuddy plugin install tokenwise@tokenwise
grok plugin marketplace add "$PWD" && grok plugin install tokenwise@tokenwise --trust

# OpenCode
mkdir -p ~/.config/opencode/plugins
cp adapters/opencode/dist/index.js ~/.config/opencode/plugins/tokenwise.js

# Hermes Agent
mkdir -p ~/.hermes/plugins
cp -R adapters/hermes/tokenwise ~/.hermes/plugins/tokenwise
hermes plugins enable tokenwise && hermes config set context.engine tokenwise

# Anything else: wrap the command
tokenwise run -c 'cargo test'
```

`tokenwise setup` runs these for you; `tokenwise setup --dry-run` only prints them.

</details>

<details>
<summary><strong id="how-each-agent-is-connected">How each agent is connected</strong></summary>
<br>

| Agent | Context on demand | Learning from inside the agent |
|---|---|---|
| pi 1.1+ | in-process; TokenWise writes the compacted context | `/tokenwise` panel |
| DeepSeek Harness 0.2.x | in-process; TokenWise writes the compacted context | Plugins page, **Learn now** |
| OpenCode 1.19+ | in-process; TokenWise writes the compacted context | `tokenwise learn` |
| Hermes Agent 0.22+ | Python plugin and context engine | `tokenwise learn` |
| Claude Code 2.1+ | hooks; the catalog follows Claude's own summary | `/tokenwise:learn` |
| Codex 0.162+ | hooks; the catalog follows Codex's own summary | `$tokenwise learn` |
| CodeBuddy 2.175+ | hooks and a mod that rewrites the stored summary | `/tokenwise:learn` |
| Grok Build 1.0+ | hooks; the catalog follows Grok's own summary | `/tokenwise:learn` |
| Any agent or shell | `tokenwise run`, recall over MCP | `tokenwise learn` |

Each agent's folder under [`adapters/`](adapters) has the details;
[docs/adapters.md](docs/adapters.md) shows how to connect another agent.

</details>

<details>
<summary><strong>Commands</strong></summary>
<br>

| Command | What it does |
|---|---|
| `tokenwise setup [agent...]`, `uninstall [--purge]` | add TokenWise to your agents, or take it out |
| `tokenwise report [--host H] [--session S]` | what was saved, per session or agent |
| `tokenwise learn --learner L`, `learn status\|cancel` | start learning in the background, follow it, stop it |
| `tokenwise rules [list\|off\|on\|rollback]` | the learned rules |
| `tokenwise filters` | every built-in rule and what it guarantees to keep |
| `tokenwise recall <id>` | read a set-aside original back |
| `tokenwise run -c '<command>'` | run any command through TokenWise |
| `tokenwise doctor` | configuration, and what each agent supports |

`tw` works in place of `tokenwise` everywhere.

</details>

<details>
<summary><strong>Configuration and privacy</strong></summary>
<br>

Nothing needs configuring. To change something, write `~/.tokenwise/config.json`;
`TOKENWISE_DISABLE=1` switches everything off for one run.

Everything stays on your machine: originals are readable only by you and deleted
after 14 days. The one thing that leaves your machine is a learning round you
start yourself: the learner is your own agent, so the recorded output it reads
goes to that agent's model provider, as it did when the agent first ran the
commands. Set `"evidence": false` to record nothing.

</details>

[Architecture](docs/architecture.md) · [Adding an agent](docs/adapters.md) · [Changelog](CHANGELOG.md) · [Media kit](media/README.md) · [MIT License](LICENSE)

<sub>Icons made by <a href="https://www.magnific.com" title="Magnific">Magnific</a> from <a href="https://www.flaticon.com/" title="Flaticon">www.flaticon.com</a>. Agent icons belong to their products; sources in <a href="media/agents/NOTICE.md">media/agents/NOTICE.md</a>.</sub>
