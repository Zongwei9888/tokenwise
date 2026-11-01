<div align="center">

<h1>
  <img src="../../docs/assets/logo.svg" width="48" height="48" align="absmiddle" alt="">
  TokenWise：让 agent 的每个 token 都物有所值
</h1>

<p>
  <a href="../../LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-0F766E?style=flat-square&labelColor=0E2A26"></a>
  <img alt="支持 8 个 agent 和任意 shell" src="https://img.shields.io/badge/agents-8_%2B_any_shell-0F766E?style=flat-square&labelColor=0E2A26">
  <img alt="零运行时依赖" src="https://img.shields.io/badge/runtime_deps-0-0F766E?style=flat-square&labelColor=0E2A26">
</p>

[English](../../README.md) · **简体中文**

### 给 AI agent 用的自进化省 token 层

**上下文按需读取，越用越省，所有 agent 共用。**

</div>

## 为什么需要 TokenWise

编程 agent 的上下文，大部分花在读它根本用不上的东西上：通过的测试、进度条、下载日志、第一百次出现的同一段构建横幅。每一个 token 你都在付费，活还没干完，上下文就先满了。

上下文满了，agent 会压缩历史腾地方，那一行关键信息可能就此丢失。靠"扔掉内容"来省 token，代价只是换了个地方出现。

而且每个项目都不一样，有自己的脚本、自己的日志、自己的噪音，一套固定的规则永远学不会这些。你还可能同时在用好几个 agent，每个都要从头来过。

**TokenWise 位于你的 agent 和模型之间，让每一个 agent 都拥有：**

- **按需读取**：模型只读它当下需要的部分。其余内容原样留在你的电脑上，一次调用就能取回，agent 压缩记忆之后也一样。省掉的是 token，不是信息。
- **自进化**：TokenWise 从你自己的使用记录里学会你的项目，越用越省。新规则要在全部历史记录上验证通过才会启用，碍事了会自己关掉。
- **跨平台**：装一次，Claude Code、Codex、Hermes、OpenCode、CodeBuddy、Grok、DeepSeek Harness、pi 和任何 shell 都能用，更多 agent 陆续接入。一个 agent 学会的，所有 agent 共享。

### token 最多省一半，效果一次没变差

| 你的 agent 在… | token 账单 | 活干得怎么样 |
|---|---|---|
| **修 bug、写功能**<br><sub>日常编码</sub> | **砍掉 14–38%** | 解决的任务持平，甚至更多 |
| **在终端里连跑几十步**<br><sub>长程命令行任务</sub> | **砍掉 25–50%**<br><sub>同样的预算，最多多跑一倍</sub> | 通过率最高提升 7.5 个百分点 |
| **聊到上下文装不下**<br><sub>超长会话</sub> | **砍掉 21–45%** | 记得更牢：反复修改的事实，记对率从 45% 升到 98% |

**12 组对比，12 次更省，0 次变差。** 4 个模型 × 3 类工作。

**同一个编程任务，token 少用 38%，** 成功率还从 83% 升到 85%。

<sub>数据来自我们论文的评测：在 DeepSeek Harness 里用 DeepSeek V4 Flash、MiniMax-M3、GLM-5.3 Flash、Qwen3.8 Flash 四个模型，和它自带的上下文管理对比，统计全部 token（含缓存读取）。论文即将公开。</sub>

<p align="center"><img src="../../media/images/story-how-zh.png" alt="你的 agent 要读的一切都经过 TokenWise，一套机制所有 agent 共用。按需读取：模型现在需要的留在上下文里，其余原样留在你的电脑上，一次调用取回。自进化：使用、学习、验证、所有 agent 生效，每一轮都更省。模型只读它需要的部分。" width="100%"></p>

## 🧬 自进化

内置规则认识常用工具，而你的项目有它自己的东西。你发起学习后，你正在用的 agent 会在后台研究会话里记录下的内容，为其中的噪音写出规则，不打断你手上的工作。

一条规则必须在**每一次**历史记录上都更省、一条报错都不丢，在没见过的记录上也成立，TokenWise 才会采用。从下一条命令起，所有 agent 都用上它。如果某个 agent 总要绕开一条规则去看原文，这条规则会自己关掉；任何一次采用都可以撤回。学到的规则在从没见过的任务上，还能再省 12–27% 的 token。

在哪儿工作就在哪儿发起学习：Claude Code、CodeBuddy 和 Grok 里用 `/tokenwise:learn`，Codex 里用 `$tokenwise learn`，pi 和 DeepSeek Harness 里用 TokenWise 面板，任何终端里都可以运行 `tokenwise learn`。有值得学的内容时，agent 也会主动提醒你。

## 💾 按需读取

可以把它理解成 agent 上下文的"虚拟内存"：模型现在需要的留在上下文里，其余的暂放到你的电脑上，一次调用就原样取回。不管是一条输出很长的命令，还是 agent 刚压缩掉的整段历史，都是如此，所以 agent 不必为了看一行内容把测试再跑一遍。

<p align="center"><img src="../../media/video/fold-zh.gif" alt="260 行的 pytest 输出折叠成模型实际读到的 17 行，失败信息完整保留" width="100%"></p>

## 🤖 支持的 agent

<table width="100%">
  <tr>
    <td align="center" width="20%"><img src="../../media/agents/claude-code.svg" width="48" height="48" alt=""><br><strong>Claude Code</strong></td>
    <td align="center" width="20%"><img src="../../media/agents/codex.svg" width="48" height="48" alt=""><br><strong>Codex</strong></td>
    <td align="center" width="20%"><img src="../../media/agents/hermes.svg" width="48" height="48" alt=""><br><strong>Hermes Agent</strong></td>
    <td align="center" width="20%"><img src="../../media/agents/opencode.svg" width="48" height="48" alt=""><br><strong>OpenCode</strong></td>
    <td align="center" width="20%"><img src="../../media/agents/codebuddy.svg" width="48" height="48" alt=""><br><strong>CodeBuddy</strong></td>
  </tr>
  <tr>
    <td align="center" width="20%"><img src="../../media/agents/grok.svg" width="48" height="48" alt=""><br><strong>Grok Build</strong></td>
    <td align="center" width="20%"><img src="../../media/agents/dsh.svg" width="48" height="48" alt=""><br><strong>DeepSeek Harness</strong></td>
    <td align="center" width="20%"><img src="../../media/agents/pi.svg" width="48" height="48" alt=""><br><strong>pi</strong></td>
    <td align="center" width="20%"><img src="../../media/images/icons/agent-shell.png" width="48" height="48" alt=""><br><strong>任何 shell</strong></td>
    <td align="center" width="20%"><a href="#接下来"><img src="../../media/images/icons/agent-more.png" width="48" height="48" alt=""><br><strong>更多接入中</strong></a></td>
  </tr>
</table>

支持 macOS 和 Linux。每个 agent 按它的插件接口允许的方式接入，深度略有不同，详见下方的[各 agent 的接入方式](#各-agent-的接入方式)。

## 🚀 开始使用

把这个仓库交给你的 agent，说：

> 帮我给这台电脑上所有的 agent 装上 TokenWise。

也可以自己装（需要 Node.js 22 和 pnpm；TokenWise 还没发布到 npm）：

```sh
git clone https://github.com/HKUDS/TokenWise.git
cd TokenWise && pnpm install && pnpm build
npm install -g ./packages/cli
tokenwise setup        # 自动找到本机的 agent，逐个装好
```

不用任何配置，下一条命令就生效。想让它学你的项目时，运行 `/tokenwise:learn`（或上面对应的方式）。`tokenwise report` 查看省了多少，`tokenwise uninstall` 可以卸载。

## ✨ 技术要点

- **不编造内容**：模型读到的每个字都来自真实输出；删减都有计数，原文随时一次调用取回。
- **报错一行不丢**：失败、警告和总数一律保留；认不出的内容原样放过。
- **结果确定**：同样的输出永远得到同样的结果，prompt cache 照常命中。
- **出错就给原文**：任何环节出错，模型拿到的都是原始内容。
- **只在本机**：原文只存在你的电脑上，只有你能读；TokenWise 自己不发任何网络请求。
- **在真实 agent 上测试**：单元测试、由真实工具输出组成的逐字节一致性语料，以及在全部 8 个 agent 上用真实模型跑的测试。
- **MIT 许可，零运行时依赖。**

## 📰 动态

- **2026-10** · TokenWise 开源：每个 agent 里都能发起自进化，一条命令完成安装，所有过滤规则都改为 TokenWise 自己的代码。

## 接下来

- 接入更多 agent：GitHub Copilot CLI、Gemini CLI、Cursor 等。
- 为常用工具补充更多内置规则，每一条都在真实输出上验证。
- 发布 TokenWise 背后的论文和完整评估。

## 给 agent 和想深入了解的人

<details>
<summary><strong>逐个 agent 手动安装</strong></summary>
<br>

在源码目录下，先执行 `npm install -g ./packages/cli`，然后：

```sh
pi install "$PWD/adapters/pi"                                   # pi
dsh plugin --profile web add -w "$PWD/adapters/dsh"             # DeepSeek Harness（换成你的 profile）
claude plugin marketplace add "$PWD" && claude plugin install tokenwise@tokenwise
codex plugin marketplace add "$PWD" && codex plugin add tokenwise@tokenwise    # 然后在 /hooks 里信任它的钩子
codebuddy plugin marketplace add "$PWD" && codebuddy plugin install tokenwise@tokenwise
grok plugin marketplace add "$PWD" && grok plugin install tokenwise@tokenwise --trust

# OpenCode
mkdir -p ~/.config/opencode/plugins
cp adapters/opencode/dist/index.js ~/.config/opencode/plugins/tokenwise.js

# Hermes Agent
mkdir -p ~/.hermes/plugins
cp -R adapters/hermes/tokenwise ~/.hermes/plugins/tokenwise
hermes plugins enable tokenwise && hermes config set context.engine tokenwise

# 其他任何 agent：用它包一层命令
tokenwise run -c 'cargo test'
```

`tokenwise setup` 会替你执行这些命令；`tokenwise setup --dry-run` 只打印不执行。

</details>

<details>
<summary><strong id="各-agent-的接入方式">各 agent 的接入方式</strong></summary>
<br>

| Agent | 按需读取 | 在 agent 里发起学习 |
|---|---|---|
| pi 1.1+ | 进程内；压缩后的上下文由 TokenWise 生成 | `/tokenwise` 面板 |
| DeepSeek Harness 0.2.x | 进程内；压缩后的上下文由 TokenWise 生成 | 插件页 **Learn now** |
| OpenCode 1.19+ | 进程内；压缩后的上下文由 TokenWise 生成 | `tokenwise learn` |
| Hermes Agent 0.22+ | Python 插件和上下文引擎 | `tokenwise learn` |
| Claude Code 2.1+ | hook；目录跟在 Claude 自己的摘要后面 | `/tokenwise:learn` |
| Codex 0.162+ | hook；目录跟在 Codex 自己的摘要后面 | `$tokenwise learn` |
| CodeBuddy 2.175+ | hook，以及改写已存摘要的 mod | `/tokenwise:learn` |
| Grok Build 1.0+ | hook；目录跟在 Grok 自己的摘要后面 | `/tokenwise:learn` |
| 任何 agent 或 shell | `tokenwise run`，通过 MCP 取回原文 | `tokenwise learn` |

各 agent 的细节见 [`adapters/`](../../adapters) 下对应的目录；[docs/adapters.md](../adapters.md) 介绍如何接入新的 agent。

</details>

<details>
<summary><strong>命令</strong></summary>
<br>

| 命令 | 作用 |
|---|---|
| `tokenwise setup [agent...]`、`uninstall [--purge]` | 装进你的 agent，或卸载 |
| `tokenwise report [--host H] [--session S]` | 按会话或 agent 查看省了多少 |
| `tokenwise learn --learner L`、`learn status\|cancel` | 在后台开始学习、查看进度、停止 |
| `tokenwise rules [list\|off\|on\|rollback]` | 学到的规则 |
| `tokenwise filters` | 所有内置规则，以及各自保证保留什么 |
| `tokenwise recall <id>` | 取回暂放的原文 |
| `tokenwise run -c '<命令>'` | 让任何命令经过 TokenWise |
| `tokenwise doctor` | 配置，以及每个 agent 支持哪些功能 |

所有地方都可以用 `tw` 代替 `tokenwise`。

</details>

<details>
<summary><strong>配置与隐私</strong></summary>
<br>

不需要任何配置。想调整时写 `~/.tokenwise/config.json`；`TOKENWISE_DISABLE=1` 可以在一次运行里关掉全部功能。

所有内容都留在你的电脑上：原文只有你能读，14 天后自动删除。唯一会离开你电脑的，是你自己发起的学习：学习者就是你自己的 agent，它读到的记录会发给该 agent 的模型服务商，和这个 agent 当初运行命令时一样。设置 `"evidence": false` 就什么都不记录。

</details>

[架构](../architecture.md) · [接入新 agent](../adapters.md) · [更新日志](../../CHANGELOG.md) · [宣传素材](../../media/README.md) · [MIT 许可证](../../LICENSE)

<sub>图标来自 <a href="https://www.flaticon.com/authors/magnific">Magnific</a> / <a href="https://www.flaticon.com/">Flaticon</a>（Icons made by <a href="https://www.magnific.com" title="Magnific">Magnific</a> from <a href="https://www.flaticon.com/" title="Flaticon">www.flaticon.com</a>）；agent 图标归各产品所有，来源见 <a href="../../media/agents/NOTICE.md">media/agents/NOTICE.md</a>。</sub>
