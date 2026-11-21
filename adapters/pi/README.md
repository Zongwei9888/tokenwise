# TokenWise for pi

[中文](#中文说明)

A [pi](https://pi.dev) package that makes the agent spend fewer tokens on
`bash` output without hiding evidence from it. When the agent runs `pytest`,
`cargo test`, `git diff`, `grep -rn`, `tsc`, `find`, a package install or one
of ~80 other recognized commands, the model reads a smaller, deterministic
**projection**: passing tests are counted instead of listed, progress bars and
repeated rows are folded, oversized search results and diff hunks are previewed
with explicit omission counts. Failures, diagnostics, warnings, unknown lines
and the exit status are always kept.

- **pi's session keeps the original.** The projection reaches the model
  through pi's `context_edit` entries; the session file and the TUI still show
  the full output.
- **Strictly smaller or nothing**: a projection is used only if it is smaller
  in bytes and saves tokens; otherwise the original passes through.
- TokenWise also keeps a private copy of each projected original
  (`~/.tokenwise`, user-only permissions, 14 days) with a source map.
- **Fail-open**: any TokenWise error delivers the original output.
- **No network access.**

It also makes pi's **compaction recoverable**: when pi
compacts a long session, tool results in the compacted part become
references the model can read again with the `tokenwise_recall` tool, and
your messages are kept word for word in the summary. And rules learned from
your own sessions with `tokenwise evolve` apply here too.

Requires pi **1.1 or newer** (tested with 1.1.0 and 1.2.0) and Node.js 22.

## Install

```sh
pi install npm:@tokenwise/pi
```

Add `-l` to install it for the current project only. To try it for one run
without installing: `pi -e npm:@tokenwise/pi`.

## Use

Nothing to do: from the next `bash`, `grep` or `find` call on, recognized output is filtered.

- The status bar shows the tokens saved in the session (*TokenWise saved 5.8k tokens*), and
  when an answer ends with more saved, a card above the editor fills in about a second (the coins drop into a
  small jar, the number counts up, the bar fills) and stays until your next prompt: *TokenWise · saved 2,973
  tokens in this conversation*, *tool output 90% shorter*.
- `/tokenwise` opens TokenWise's panel: the session's savings and
  compactions, the learned rules and what each saved, the commands worth
  learning from, and a learning run in progress. Keys: `l` learn now, `c`
  cancel, `r` roll back, `o` switch learned rules off or on, `esc` close.
  `/tokenwise status` prints the same as text (also in `-p` and RPC mode);
  `/tokenwise learn | cancel | rules | rollback | off | on` act directly.
- While a run goes, the status bar shows it (`◐ learning 2:31`); it shows
  `✦ ready to learn` when there is enough new output to learn from.
- `pi --tokenwise observe` (or `off`) lowers the mode for one run: `observe`
  records what would change without changing anything.
- `pi config` lists the package; switching its extension off unloads
  TokenWise completely.

TokenWise also normalizes a few commands before they run so their output is
recognizable and colour-free: plain `rg`/`grep` searches gain `-n -H`,
`git diff` gains `--no-color`, `pytest` gains `--color=no`. The assistant
message in pi's session keeps the command as the model wrote it, and
TokenWise's journal records every rewrite.

Configuration (`~/.tokenwise/config.json`, a project's
`.tokenwise/config.json`, `TOKENWISE_OUTPUT`, `TOKENWISE_COMPACTION`,
`TOKENWISE_DISABLE=1`) is shared
with the other TokenWise hosts; see the
[main README](https://github.com/HKUDS/TokenWise#for-agents-and-the-curious).

## What it changes, exactly

- pi's `bash` tool, and its own `grep` and `find`; only the model's own
  calls, so calls nested inside another tool (such as a codemode script) are
  left alone. `grep` rows of one file are grouped under its path and `find`
  paths under their directory; every row, path and limit notice stays, in
  order. `read`, `edit`, `write` and `ls` are never changed.
- `bash` output pi already truncated (over 2000 lines or 50 KB), commands that
  timed out or were aborted, and anything not recognized pass through
  unchanged. `grep` and `find` results pi capped are still laid out, with pi's
  limit notice kept as it is.
- pi merges stdout and stderr and appends `Command exited with code N` on
  failure; that footer is always kept.

## Every tool, and a file read again

Every other tool's text is journaled as it is. For every request,
`context_with_system` looks at the list pi is about to send: a `read` with
the same path, range and text as an earlier one still in that list goes as a
one-line note pointing back to it, and the read right after a note goes
whole. pi's session keeps every read whole, so after a compaction the later
read is sent whole again. Verified on pi 1.1.0: a 122-line file read twice
was sent once (2,744 → 77 tokens for the repeat).

## Compaction

When pi compacts (automatically near the context limit, or with `/compact`),
TokenWise supplies the summary through `session_before_compact`:

- pi's own summarizer (the same `compact()` call and model pi would use)
  writes the summary, asked to keep the findings of tool results rather than
  their bodies;
- each tool result in the compacted part is saved and replaced by a short
  reference;
- the summary is followed by your messages, verbatim, and a catalog of the
  references; pi's own file tracking is kept;
- `tokenwise_recall` becomes available to the model: it returns a result
  exactly as the model read it, a window of up to 8 KB around a string or a
  line number (numbered, the asked line marked), or
  the complete original when TokenWise had shortened it. The references are
  stored in pi's compaction entry, so `/fork` and `/resume` keep them.

If the result would not be smaller, or anything fails, pi compacts as it
always does. `pi --tokenwise observe` records what a checkpoint would keep
without changing pi's compaction. If you restrict tools with `--tools`,
include `tokenwise_recall` for the model to be able to recall.

## Learned rules

Press `l` in the `/tokenwise` panel (or run `/tokenwise learn`) and confirm:
TokenWise starts pi itself as the learner, in the background, with the
session's model (`pi -p --provider <yours> --model <yours>`). It reads up to
40 recorded outputs, so they go to that model's provider. The panel shows the
steps (prepare, learn, verify) and the learner's checks; pi tells you the
result when it ends, and the running session uses adopted rules from its next
output on. Runs need Node.js (pi's own, or `node` on PATH) and stop after 20
minutes. `tokenwise evolve --learner pi` (from `@tokenwise/cli`) does the same in a
terminal. See the
[architecture notes](https://github.com/HKUDS/TokenWise/blob/main/docs/architecture.md#self-evolution).

## Subagents

pi has no built-in subagents. Subagent extensions that run each subagent as a
separate `pi` process, such as the subagent example that ships with pi
(`examples/extensions/subagent` in `@earendil-works/pi-coding-agent`), load TokenWise in that process as well, so the subagent's `bash` output is
filtered the same way. The parent's status bar and `/tokenwise` include what
its subagents saved: TokenWise hands the parent session's ID to the processes
pi starts in the `TOKENWISE_PARENT_SESSION` environment variable, and only a
direct child process of that pi takes it up, so a later session in the same pi
(`/new`, `/resume`, `/fork`) is not counted as a subagent. Tested with
the subagent example in single and parallel mode; subagents that run inside the
parent's process are not covered.

## Remove

```sh
pi remove npm:@tokenwise/pi
```

Saved originals expire on their own; delete `~/.tokenwise` to remove them at
once.

---

## 中文说明

TokenWise 的 pi 扩展包：在模型读取之前精简可识别的 `bash` 输出（测试、构建、
diff、搜索、安装等约 80 类命令），失败信息、诊断、警告和退出码一律保留。投影通过
pi 的 `context_edit` 交付，**pi 自己的会话文件、TUI 和导出仍是完整原文**。精简结果
必须在字节和 token 上都严格变小才会使用；TokenWise 出任何错都交付原文；不联网。

需要 pi **1.1 及以上**（已在 1.1.0 和 1.2.0 上测试）。

- 安装：`pi install npm:@tokenwise/pi`（加 `-l` 只装到当前项目）
- 可找回的压缩：pi 压缩长会话时，被压缩部分的工具结果换成引用，模型可以用 `tokenwise_recall` 原样读回；你的原话逐字保留在摘要里；结果没变小或出错时交给 pi 自己压缩
- `/tokenwise` 打开面板：本会话的节省和压缩、学到的规则及各自省下的 token、值得学习的命令、正在进行的学习。按键：`l` 开始学习，`c` 取消，`r` 回滚，`o` 开关学到的规则，`esc` 关闭；`/tokenwise status` 输出文字版
- 学到的规则：在面板里按 `l` 并确认，TokenWise 会在后台用当前会话的模型启动 pi 作为学习者，从记录的输出里学新规则，验证通过才采用，正在运行的会话从下一条输出起生效；也可以用 `tokenwise evolve --learner pi`
- 状态栏显示本会话省下的 token；每轮回答结束时如果又省下了，输入框上方会出现一张小卡片，大约一秒内装满（硬币落进小罐子、数字往上数、进度条填满），一直留到你下一次提问；`/tokenwise` 查看明细
- pi 自带的 `grep`、`find` 工具的结果做无损排版（同一文件的匹配、同一目录的路径归到一起，每行、每个路径和提示都保留）；`read`、`edit`、`write`、`ls` 从不改动
- 子 agent：每个子 agent 单独起一个 `pi` 进程的子 agent 扩展（如 pi 自带的 subagent 示例）里，TokenWise 同样生效；父会话的状态栏和 `/tokenwise` 会把子 agent 省下的一起算上（通过环境变量 `TOKENWISE_PARENT_SESSION` 传递父会话 ID，只有该 pi 直接启动的子进程才会认领；同一个 pi 里 `/new`、`/resume`、`/fork` 出来的会话不算子 agent）
- `pi --tokenwise observe` 本次运行只记录不改动；`pi config` 里可以关闭扩展
- 卸载：`pi remove npm:@tokenwise/pi`
