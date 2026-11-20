import type { Capability } from './capabilities.ts'

export interface HostProfile {
  readonly id: string
  readonly name: string
  readonly integration: 'in-process' | 'hooks' | 'command'
  /** What the host offers to TokenWise without patches. */
  readonly capabilities: readonly Capability[]
  readonly notes: readonly string[]
}

const local: Capability[] = ['journal', 'artifacts', 'tokens']

/** Capability profiles of supported hosts, as verified against their sources. */
export const HOST_PROFILES: Readonly<Record<string, HostProfile>> = Object.freeze({
  pi: {
    id: 'pi', name: 'pi coding agent (@earendil-works/pi-coding-agent 1.x)', integration: 'in-process',
    capabilities: [...local, 'toolResults', 'toolResultsPreserveRaw', 'toolCalls', 'compaction', 'context', 'tools', 'toolVisibility', 'models', 'sessions', 'ui'],
    notes: [
      'turn_end context_edit replaces what the model sees; the session file keeps the original',
      'bash merges stdout and stderr; outputs pi already truncated (2000 lines / 50KB) pass through',
      'its own grep and find results are laid out losslessly (rows by file, paths by directory)',
      'every tool\'s text is journaled; a read repeating one still in the list being sent is a note there, decided anew for every request (context_with_system)',
      'subagent pi processes inherit TOKENWISE_PARENT_SESSION, so a session reports what its subagents saved',
    ],
  },
  codex: {
    id: 'codex', name: 'OpenAI Codex CLI (0.162+)', integration: 'hooks',
    capabilities: [...local, 'toolCalls', 'commandWrapper', 'compactionShaping', 'compactionContext', 'tools', 'models', 'sessions'],
    notes: [
      'PreToolUse rewrites recognized shell commands to `tokenwise run`; the model history keeps the original command',
      'plugin hooks run only after the user trusts them (/hooks), again after each plugin update; rewritten commands still go through approval',
      'Compaction, assisted: Codex writes the summary; SessionStart(compact) adds the catalog of the tool results TokenWise kept, and the plugin\'s MCP server offers mcp__tokenwise__tokenwise_recall (read-only, so exec runs it without asking)',
      'subagent threads get no SessionStart(compact), so no catalog',
    ],
  },
  claude: {
    id: 'claude', name: 'Claude Code (2.1+)', integration: 'hooks',
    capabilities: [...local, 'toolResults', 'commandWrapper', 'compactionShaping', 'compactionContext', 'tools', 'models', 'sessions'],
    notes: [
      'PostToolUse replaces the output of a successful Bash call; failed calls go to PostToolUseFailure, which cannot replace it',
      'in bypassPermissions mode PreToolUse wraps recognized commands in `tokenwise run`, so failed calls are filtered too; other modes never rewrite a command, which would no longer match permission rules',
      'Compaction, assisted: Claude Code writes the summary (PreCompact adds a line to its instructions); SessionStart(compact) adds the catalog, under its 10,000-character limit; the plugin\'s MCP server offers mcp__plugin_tokenwise_tokenwise__tokenwise_recall',
      'a background command is remembered when it starts; once it exited, a Read (or cat) of its whole task output file is filtered as that command\'s output',
      'Read, WebFetch, WebSearch, Agent and MCP results are journaled; a Read repeating one the transcript still shows whole (no compaction or clearing since) is a note',
    ],
  },
  codebuddy: {
    id: 'codebuddy', name: 'CodeBuddy Code (2.175+)', integration: 'hooks',
    capabilities: [...local, 'toolCalls', 'commandWrapper', 'compaction', 'tools', 'models', 'sessions'],
    notes: [
      'PreToolUse wraps recognized commands in `tokenwise run` with no permission decision, so CodeBuddy\'s own permission check still runs',
      'its PostToolUse event carries no command output, so results cannot be replaced after the fact',
      'its own Grep and Glob results (a JSON array) are laid out losslessly through PostToolUse; calls from its REPL are left alone',
      'background commands are not wrapped; TaskOutput holding the whole stdout of one that finished is filtered through PostToolUse (TaskOutput shows no exit code: failed reads as 1 unless the completion notice gave it)',
      'Read and other tools\' results are journaled; a Read repeating one still in the transcript (no compaction since) is a note',
      'Compaction through the plugin\'s mod: session.compact reads the span, session.append turns the stored summary into the checkpoint; tokenwise_recall is a mod tool',
    ],
  },
  grok: {
    id: 'grok', name: 'Grok Build (1.0+)', integration: 'hooks',
    capabilities: [...local, 'toolResults', 'toolResultsPreserveRaw', 'compactionContext', 'tools', 'models', 'sessions'],
    notes: [
      'PostToolUse replaces the model\'s copy of a shell result, failed commands included; the scrollback and transcript keep the original',
      'Compaction, assisted: Grok writes the summary and lets nothing in at compaction; PostCompact saves the span, the next tool result (or Stop) carries the catalog; the MCP tool tokenwise__tokenwise_recall is reached through use_tool',
      'results Grok already cut, and results over 128 KiB, pass through',
      'get_command_or_subagent_output holding the whole output of a finished background command (not cut, the same as its log) is filtered as that command\'s',
      'read_file and list_dir are journaled; a read_file repeating one in chat_history fewer than three prompts ago (Grok trims older results untraced) is a note',
      'hooks run only in trusted folders; `grok -p` counts its folder as trusted',
    ],
  },
  copilot: {
    id: 'copilot', name: 'GitHub Copilot CLI (1.0+)', integration: 'hooks',
    capabilities: [...local, 'toolResults', 'toolResultsPreserveRaw', 'models', 'sessions'],
    notes: [
      'postToolUse replaces the model\'s copy of a bash result (modifiedResult), failed commands included; Copilot\'s own status line is kept',
      'output Copilot saved to a file because it was too large passes through',
      'a shell that goes on running is remembered; read_bash of it once finished, holding its whole output and status line, is filtered (Copilot\'s own reads in an idle session fire no hook)',
      'every tool\'s text is journaled; a view repeating one in the session events under five minutes old (no compaction, truncation or clear since) is a note',
      'no compaction hook lets anything in, so Copilot compacts with its own summary',
    ],
  },
  hermes: {
    id: 'hermes', name: 'Hermes Agent (0.22+)', integration: 'hooks',
    // Hermes also offers argument rewrites (pre_tool_call); the adapter does not use them.
    capabilities: [...local, 'toolResults', 'compaction', 'tools', 'models', 'sessions'],
    notes: [
      'Compaction as a context engine (`hermes config set context.engine tokenwise`): Hermes\'s own compressor, whose summary becomes the checkpoint; tokenwise_recall is an engine tool',
      'its plugin hands transform_terminal_output to `tokenwise hook hermes`: the terminal output is replaced before Hermes limits, strips and redacts it',
      'output Hermes cut to a head and tail, and commands it stopped, pass through',
      'background-process output reaches transform_terminal_output only as a tail (no env_type) and passes; process_manage wait holding a finished process\'s whole output goes through transform_tool_result (at most 2,000 characters)',
    ],
  },
  opencode: {
    id: 'opencode', name: 'OpenCode (1.19+)', integration: 'in-process',
    capabilities: [...local, 'toolResults', 'compaction', 'compactionShaping', 'tools', 'models', 'sessions'],
    notes: [
      'tool.execute.after replaces the bash result before OpenCode stores it and the model reads it; TokenWise keeps the original',
      'Compaction through the experimental compaction hooks (session.compacting, chat.messages.transform, text.complete): the summary becomes the checkpoint; tokenwise_recall is a plugin tool',
      'stdout and stderr arrive merged; output OpenCode already cut to its tail passes through',
      'commands run as the model wrote them, so permissions are untouched',
      'its own glob and grep results are laid out losslessly (common directory once, paths by directory, rows by file)',
      'every tool\'s text is journaled; a read repeating one still in the list being sent is a note there, decided anew for every request (chat.messages.transform)',
    ],
  },
  dsh: {
    id: 'dsh', name: 'DeepSeek Harness (0.2.x)', integration: 'in-process',
    // 0.2 excludes argument rewriting from tools/pre-execute (arguments are logged before it runs).
    capabilities: [...local, 'toolResults', 'compaction', 'tools', 'models', 'sessions', 'ui'],
    notes: [
      'tools/post-execute replaces the bash result the model and the session log receive; TokenWise keeps the original',
      'stdout and stderr stay apart; output DSH already cut to its tail (64 KB per stream by default) passes through',
      'tool arguments cannot be rewritten before execution, so command normalization is off',
      'complete results of its own grep and glob are laid out losslessly; searches DSH capped pass through',
      'job_output of a finished background bash job is filtered when its bytes are every byte the job wrote (the job registry counts them)',
      'in-process subagents (subagent, subagent_fork) are filtered too and counted in their parent session',
      'every other tool\'s text is journaled as it is',
    ],
  },
  shell: {
    id: 'shell', name: 'Any agent or terminal via `tokenwise run`', integration: 'command',
    capabilities: [...local, 'commandWrapper'],
    notes: ['the agent (or you) must call `tokenwise run -c <command>` explicitly'],
  },
})
