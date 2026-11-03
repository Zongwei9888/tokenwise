# TokenWise for DeepSeek Harness

[中文](#中文说明)

A DeepSeek Harness (DSH) plugin that makes the agent spend fewer tokens on
`bash` output without hiding evidence from it. When the agent runs `pytest`,
`cargo test`, `git diff`, `grep -rn`, `tsc`, `find`, a package install or one
of ~80 other recognized commands, the model reads a smaller, deterministic
**projection**: passing tests are counted instead of listed, progress bars and
repeated rows are folded, oversized search results and diff hunks are previewed
with explicit omission counts. Failures, diagnostics, warnings, unknown lines
and the exit status are always kept.

- **Strictly smaller or nothing**: a projection is used only if it is smaller
  in bytes and saves tokens; otherwise the original passes through.
- **The original is kept** on this machine (`~/.tokenwise`, user-only
  permissions, 14 days) with a source map from projection to original.
- **Fail-open**: any TokenWise error delivers the original output.
- **No network access.**

It also makes DSH's **compaction recoverable**: when DSH
compacts a long conversation, tool results in the compacted part become
references the model can read again with the `tokenwise_recall` tool, your
messages are kept word for word in the checkpoint, and results DSH cuts to a
head and tail keep their complete text. Rules learned from your own sessions
with `tokenwise evolve` apply here too.

Requires DeepSeek Harness **0.2.x** (tested with 0.2.0-rc.2 and
0.2.1-alpha.2 — the Web UI and CLI on macOS and Linux, and the Desktop app on
macOS, both the signed 0.2.0-rc.2 release and a 0.2.1-alpha.2 build; Windows
is not tested yet) and the Node.js versions DeepSeek Harness
itself supports (22.19+ or 24+). `dsh plugin` needs pnpm 11 or later.

## Install

**From the Web UI or Desktop app**: open **Plugins** in the sidebar, choose
**Add plugin**, enter `@tokenwise/dsh` and **Install**, then **Enable now**.

**From a terminal**:

```sh
dsh plugin --profile web add -w @tokenwise/dsh
```

Use the profile you run (`web` for `dsh web`, `headless` for
`dsh headless`, …). The Desktop app manages its own profile: install from its
**Plugins** page (it brings its own pnpm), or quit it and run its bundled
`dsh plugin --profile desktop add -w @tokenwise/dsh`. A downloaded tarball or a checkout works the same way:
`dsh plugin --profile web add -w ./tokenwise-dsh-0.3.0.tgz` or
`dsh plugin --profile web add -w /absolute/path/to/tokenwise/adapters/dsh`
(after `pnpm install && pnpm build` in the checkout).

## Use

Nothing to do: recognized output is filtered from the next tool call on. In a
session, type `/tokenwise` to see what it saved there.

On the plugin's page in **Plugins**, **Mode** switches between:

| Mode | Effect |
|---|---|
| **Apply** (default) | the model reads the projection; compaction keeps tool results recallable |
| **Observe** | the model reads the original and DSH compacts as usual; TokenWise records what it would have saved |
| **Off** | TokenWise does nothing |

The change applies to the next tool result and compaction; no restart. The same setting can
be written in the profile's `cordis.patch.yml`:

```yaml
- id: tokenwise
  config:
    mode: observe
```

TokenWise's own configuration (`~/.tokenwise/config.json`, a project's
`.tokenwise/config.json`, `TOKENWISE_OUTPUT`, `TOKENWISE_COMPACTION`,
`TOKENWISE_DISABLE=1`; DSH leaves variables with TOKEN in their name out of
the shells it runs, so there write them `TW_HOME`, `TW_DISABLE`) can lower
this setting further but never raise it; see the
[main README](https://github.com/HKUDS/TokenWise#for-agents-and-the-curious).

## What it changes, exactly

- DSH's own `grep` and `glob` results, when the model called them directly and
  DSH delivered them complete: each match row loses its `Line ` prefix and
  consecutive paths are grouped under their directory; every match, line
  number and path stays. A search DSH capped or saved to a file is left alone.
- Only the model's own `bash` calls that finished in the foreground. Background
  jobs, `run_code` sub-calls, other tools, failed tool calls and results
  another plugin already rewrote are left alone.
- The projection replaces one output stream (stdout, or a Cargo report on
  stderr) inside the result text; the `[stderr]` section, `[exit code: N]` and
  every other marker stay byte-for-byte.
- Output DSH already cut to its tail (64 KB per stream by default), and runs
  that timed out, were killed or hit the sandbox, pass through unchanged.
- TokenWise runs before DSH's spill policy: a large recognized output is
  projected first and the model reads the projection. If even the projection
  would be over DSH's inline budget (12,500 tokens by default), TokenWise
  passes the original, so DSH's spill file keeps the complete text. If you
  raise `spill-policy`'s `maxInlineTokens`, raise `inlineLimitChars` on the
  `tokenwise` entry to about four times that.
- With `tools.mode: ptc` every `bash` call is a `run_code` sub-call whose
  value goes to the program, so TokenWise leaves it alone.
- Subagents started with the built-in `subagent` and `subagent_fork` tools run
  in the same process, and their `bash` output is filtered the same way.
  `/tokenwise` in the parent session adds what its subagents saved.
  Out-of-process subagents (Codex, Claude Code, ACP, a separate Harness)
  run their own tools outside this plugin.
- The session log and the tool card show the text the model read. The
  original is kept in `$TOKENWISE_HOME` (default `~/.tokenwise`; when that is
  not writable, `$TMPDIR/tokenwise-<uid>`); with the
  [`tokenwise` command](https://www.npmjs.com/package/@tokenwise/cli),
  `tokenwise report --host dsh` summarizes savings and `tokenwise show <sha256>` prints an
  original.
- Edits to TokenWise's own configuration files apply to the next tool call.

## Compaction

DSH compacts with its own compaction engine, which the Web app and Desktop
mount separately inside each agent preset; DSH offers plugins no hook for it.
TokenWise finds each engine when an agent starts (through the engine's own
`agent/pre-step` listener) and takes over one step of it, the summary:

- DSH's summarizer (the same call and model DSH would use) writes the
  summary, asked to keep the findings of tool results rather than their
  bodies; the tool results are saved and replaced by short references;
- the checkpoint is that summary, your messages verbatim, and a catalog of
  the references; DSH still selects the range, checks the size and writes
  the session log;
- `tokenwise_recall` returns a result exactly as the model read it, a window
  of up to 8 KB around a string, or the complete original when TokenWise had
  shortened it;
- DSH's tool-result pruner, which cuts results over 8,192 characters to their
  head and tail, now leaves a note naming the observation, and the complete
  text is kept.

If the checkpoint would not be smaller, or anything fails, DSH compacts the
original way. `/tokenwise` shows how many engines TokenWise attached to,
compactions, cut results and recalls.

## Learned rules

**Plugins** → TokenWise has a *Self-evolution* section (Web and Desktop):

- what TokenWise has recorded, the learned rules and what each saved, and the
  commands worth learning from;
- **Learn now** starts a run in the background after you confirm. The
  learner is DSH itself (`dsh --profile headless`, with your default model and
  the providers of your profile). It reads up to 40 recorded outputs, so they
  go to that model's provider;
- the run's steps (prepare, learn, verify) and the learner's checks, live,
  with **Cancel**; a toast anywhere in the app when it ends, and once when
  recorded output becomes worth learning from (again only when the tokens to
  save on a command have doubled, or after the next run);
- a switch for the learned rules and **Roll back**.

In a session, `/tokenwise learn | cancel | rules | rollback | off | on` do
the same, and `tokenwise evolve --learner dsh` (from `@tokenwise/cli`) runs it from
a terminal. Running sessions use adopted rules from their next output on. See
the [main README](https://github.com/HKUDS/TokenWise#-self-evolving).

## Remove

**Plugins** → TokenWise → uninstall, or
`dsh plugin --profile web remove @tokenwise/dsh`. Saved originals expire on
their own; delete `~/.tokenwise` to remove them at once.

---

## 中文说明

TokenWise 是 DeepSeek Harness（DSH）的插件，在模型读取之前精简可识别的 `bash`
输出（测试、构建、diff、搜索、安装等约 80 类命令），原文保留，失败信息、诊断、
警告和退出码一律保留。精简结果必须在字节和 token 上都严格变小才会使用，否则原样
交付；TokenWise 出任何错都交付原文；不联网。

需要 DSH **0.2.x**（已在 0.2.0-rc.2 和 0.2.1-alpha.2 上测试：Web 界面和命令行覆盖 macOS 与 Linux，桌面版覆盖 macOS，包括官方签名的 0.2.0-rc.2 安装包和 0.2.1-alpha.2 源码构建；Windows 尚未测试）；`dsh plugin` 需要 pnpm 11 及以上。

**安装**：侧边栏 **插件** → **添加插件** → 输入 `@tokenwise/dsh` → **安装** →
**立即启用**；或在终端执行 `dsh plugin --profile web add -w @tokenwise/dsh`。

**使用**：装好即生效。在会话里输入 `/tokenwise` 查看本会话省下的 token、压缩和找回情况，以及正在用的学到的规则。

**可找回的压缩**：DSH 压缩长对话时，被压缩部分的工具结果换成引用，模型可以用 `tokenwise_recall` 原样读回；你的原话逐字保留在检查点里；DSH 把超过 8192 字符的结果截成首尾两段时，完整内容也会保存并在截断处注明编号。检查点没有变小或出错时，DSH 按原方式压缩。网页版和桌面版里每个 agent 预设各有一个压缩模块，TokenWise 在 agent 启动时自动接上。

**自进化**：插件 → TokenWise 页面有“自进化”一节（网页版和桌面版）：显示已记录的输出、学到的规则及各自省下的 token、值得学习的命令；点**开始学习**并确认后在后台运行，学习者是 DSH 自己（`dsh --profile headless`，使用你的默认模型和当前配置里的模型服务），会读取最多 40 条记录的输出并发送给该模型的服务商；页面实时显示准备、学习、验证三步和自检次数，可以**取消**；结束时在应用里弹出提示；学到的规则可以开关、可以**回滚**。会话里也可以用 `/tokenwise learn | cancel | rules | rollback | off | on`，终端里用 `tokenwise evolve --learner dsh`。正在运行的会话从下一条输出起使用新规则。

DSH 自带的 `grep`、`glob` 工具的完整结果做无损排版（去掉每行的 `Line ` 前缀、同一目录的路径归到一起）。用内置 `subagent`、`subagent_fork` 工具启动的子 agent 同样生效，父会话的 `/tokenwise` 会把子 agent 省下的一起算上。在
**插件** 页的 TokenWise 详情里可以切换 **模式**：精简（默认）/ 只记录 / 关闭，
保存后下一次工具调用即生效，无需重启。

**卸载**：**插件** → TokenWise → 卸载，或
`dsh plugin --profile web remove @tokenwise/dsh`。
