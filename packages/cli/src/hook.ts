import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { mayProject, nativeJsonGrepRows, nativeJsonPaths } from '@tokenwise/core'
import type { NativeResult } from '@tokenwise/core'
import { backgroundCommand, describeToolCall, normalizeShellCommand, rememberBackground } from '@tokenwise/mechanisms'
import { claudeAfterCompact, claudeAllowRecall, claudePreCompact } from './claude-shadow.ts'
import { codexAfterCompact } from './codex-shadow.ts'
import { grokAfterCompact, grokPendingCatalog } from './grok-shadow.ts'
import { cliContext, onPath, shellQuote } from './context.ts'
import { allowedByRules } from './claude-permissions.ts'
import { conversationNotice } from './conversation.ts'
import { startupNotice } from './learn.ts'
import { keepPending, takePending } from './shadow.ts'
import { projectNative, projectOutput } from './project.ts'
import { passToolOutput } from './tools.ts'

/**
 * Hook input fields TokenWise reads. Codex, Claude Code and CodeBuddy send
 * these names; Grok sends them too (for Claude Code compatibility) beside its
 * own camelCase ones.
 */
interface HookInput {
  readonly hook_event_name?: unknown
  readonly session_id?: unknown
  readonly tool_use_id?: unknown
  readonly tool_name?: unknown
  readonly tool_input?: { readonly command?: unknown; readonly run_in_background?: unknown; readonly [key: string]: unknown } | null
  readonly tool_response?: unknown
  readonly permission_mode?: unknown
  readonly cwd?: unknown
  readonly [key: string]: unknown
}

/** Back-compat name for the Codex hook's input. */
type CodexHookInput = HookInput

const MAX_INPUT = 4 * 1024 * 1024

/** The wrapper prefix; a command that already starts with it is never wrapped twice. */
export const WRAPPER = 'tokenwise run'

/** Hosts `tokenwise hook` serves. */
export const HOOK_HOSTS = ['codex', 'claude', 'codebuddy', 'grok', 'hermes', 'copilot'] as const
export type HookHost = typeof HOOK_HOSTS[number]

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null
const text_ = text

/** Copilot shows a hook's progress line in its timeline; the others show a `systemMessage`. */
const notice = (host: string, message: string | undefined) => message === undefined ? undefined
  : JSON.stringify(host === 'copilot' ? { type: 'progress', message } : { systemMessage: message })

/**
 * The end of a turn (Stop) in Claude Code, CodeBuddy and Codex: what TokenWise saved in this conversation so far,
 * as a `systemMessage` they show at once, when it grew since it was last said (Grok's Stop adds it in grokEntry,
 * Copilot's agentStop in copilotHook). A Stop the hook itself continued (`stop_hook_active`) says nothing.
 */
function turnEnd(host: HookHost, input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (input.stop_hook_active === true) return undefined
  return notice(host, conversationNotice(host, text(input.session_id) ?? undefined, env))
}

/**
 * Which Claude-Code-compatible host sent this event, when it is not Claude
 * Code itself. Grok and CodeBuddy both run hooks written for Claude Code
 * (Grok imports `~/.claude` settings and plugins), so a Claude Code hook
 * must recognize their events and leave them to their own TokenWise hook.
 */
export function eventHost(input: HookInput, env: NodeJS.ProcessEnv = process.env): 'grok' | 'codebuddy' | undefined {
  if (typeof input.hookEventName === 'string' || typeof env.GROK_HOOK_EVENT === 'string') return 'grok'
  if (typeof input.generation_id === 'string' || (env.CODEBUDDY_SESSION_ID !== undefined && env.CODEBUDDY_SESSION_ID === input.session_id)) return 'codebuddy'
  return undefined
}

/**
 * The `tokenwise run` command a recognizable shell script becomes, or undefined to
 * leave it alone: empty or huge scripts, scripts already wrapped, patches, a
 * script no filter could shorten, no `tokenwise` on PATH, or Economy off.
 */
const PROBE = /^\s*(?:\S*\/)?tokenwise probe tw[0-9a-f]{8}\s*$/u

function wrapScript(host: HookHost, input: HookInput, env: NodeJS.ProcessEnv, options: { normalize: boolean; tool: string }): string | undefined {
  const script = input.tool_input?.command
  if (typeof script !== 'string' || script.trim() === '' || script.length > 65_536) return undefined
  // A background command is read while it runs; `tokenwise run` would hold its output back until it ends.
  if (input.tool_input?.run_in_background === true) return undefined
  const trimmed = script.trimStart()
  if (trimmed.startsWith(`${WRAPPER} `) || /\bapply_?patch\b/.test(script)) return undefined
  // `tokenwise doctor --probe` asks the agent to run `tokenwise probe <mark>`, and looks for it in the records: wrap it too.
  if (!mayProject(script) && !PROBE.test(script)) return undefined
  // A rewrite to an unresolvable `tokenwise` would turn every wrapped command into "command not found".
  if (!onPath('tokenwise', env)) return undefined
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined
  const context = cliContext({ ...cwd === undefined ? {} : { cwd }, env })
  const { economy } = context.loaded.config
  if (economy.mode === 'off') return undefined
  const sessionId = text(input.session_id)
  const callId = text(input.tool_use_id)
  // Normalization changes what runs, so it is an `apply` action; observe mode only wraps to record.
  const store = options.normalize && economy.commandNormalization && economy.mode === 'apply' ? context.writable() : undefined
  const normalized = store
    ? normalizeShellCommand({ host, journal: store.journal }, { sessionId, callId, tool: options.tool, command: script })
    : undefined
  const flags = ['--host', host, ...sessionId ? ['--session', sessionId] : [], ...callId ? ['--call', callId] : []]
  return `${WRAPPER} ${flags.map(shellQuote).join(' ')} -c ${shellQuote(normalized ?? script)}`
}

/**
 * Codex PreToolUse: wrap a recognizable shell script as
 * `tokenwise run --host codex --session <id> --call <id> -c '<script>'`.
 * Everything else, and any error, produces no output (Codex passthrough).
 * The model's history keeps the original command; Codex re-applies its
 * exec policy and approval to the rewritten one.
 */
export function codexPreToolUse(input: CodexHookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return undefined
  const command = wrapScript('codex', input, env, { normalize: true, tool: 'exec_command' })
  if (command === undefined) return undefined
  // Codex applies `updatedInput` only next to `permissionDecision: "allow"`, and that is all `allow` does: a hook's
  // result is either "continue (with this input)" or "block"; the rewritten command still goes through Codex's
  // exec policy, approval and sandbox (codex-rs 0.165 core/src/hook_runtime.rs, PreToolUseHookResult).
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command } } })
}

/**
 * CodeBuddy's own Grep and Glob: PostToolUse hands over their result as the
 * array the model reads as one line of JSON (absolute paths, or ripgrep rows in
 * content mode), and a string `updatedToolOutput` replaces what the model reads
 * (CodeBuddy 2.179). Glob and files_with_matches are laid out as paths, content
 * mode as rows by file; count mode and anything else pass.
 */
function codebuddySearch(input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  const tool = input.tool_name
  if ((tool !== 'Grep' && tool !== 'Glob') || !Array.isArray(input.tool_response) || !input.tool_response.every(item => typeof item === 'string')) return undefined
  // A call from code the model wrote (CodeBuddy's REPL) hands its value to that program, which may need the array.
  if (!codebuddyModelCall(input)) return undefined
  const rendered = JSON.stringify(input.tool_response)
  const mode = tool === 'Grep' ? input.tool_input?.output_mode ?? 'files_with_matches' : 'paths'
  const projection = mode === 'content' ? nativeJsonGrepRows(rendered) : mode === 'files_with_matches' || mode === 'paths' ? nativeJsonPaths(rendered) : undefined
  return nativeReply('codebuddy', input, tool, { rendered, projection }, env)
}

/**
 * Whether the model itself made this call: CodeBuddy records the model's own calls in the session transcript
 * (`"type":"function_call"` with the call's id) before PostToolUse runs; calls from inside its REPL are not
 * recorded so (seen on CodeBuddy 2.184). An unreadable transcript counts as no.
 */
function codebuddyModelCall(input: HookInput): boolean {
  const id = input.tool_use_id
  if (typeof id !== 'string' || !/^[\w-]{1,128}$/u.test(id)) return false
  const call = `"callId":"${id}"`
  return transcriptTail(input.transcript_path)?.some(line => line.includes(call) && line.includes('"type":"function_call"')) ?? false
}

/**
 * The last 8 MB of an agent's JSONL transcript, as lines: the call a hook runs for was made moments ago, and a
 * result the model still has in its context is recent enough to be there. Undefined when unreadable.
 */
function transcriptTail(path: unknown): string[] | undefined {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return undefined
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return undefined
    const size = Math.min(stat.size, 8 * 1024 * 1024)
    const buffer = Buffer.alloc(size)
    const fd = openSync(path, 'r')
    try { readSync(fd, buffer, 0, size, stat.size - size) } finally { closeSync(fd) }
    return buffer.toString('utf8').split('\n')
  } catch { return undefined }
}

/**
 * Whether an earlier tool result is still in the model's context, by the transcript: the text the model was given
 * for that call is there, whole (not cleared or saved to a file), and no row after it records a compaction or a
 * clearing. `result` reads a row's model-facing text for the call (undefined for other rows), `gone` names the rows
 * that mean context was taken away. A result too old to be in the transcript's tail counts as gone.
 */
function stillInTranscript(lines: readonly string[] | undefined, id: string, result: (row: unknown) => string | undefined, gone: (line: string) => boolean): boolean {
  if (!lines) return false
  let at = -1, body: string | undefined
  for (let i = 0; i < lines.length && at < 0; i++) {
    if (!lines[i]!.includes(id)) continue
    try { body = result(JSON.parse(lines[i]!)) } catch { continue }
    if (body !== undefined) at = i
  }
  if (at < 0 || /Old tool result content cleared|<persisted-output>/u.test(body!)) return false
  return !lines.slice(at + 1).some(gone)
}

/** Claude Code: the text of the `tool_result` block for call `id` in a transcript row. */
const claudeResult = (id: string) => (row: unknown) => {
  const content = (row as { message?: { content?: unknown } } | null)?.message?.content
  const block = Array.isArray(content) ? content.find(item => item?.type === 'tool_result' && item.tool_use_id === id) : undefined
  return block === undefined ? undefined : typeof block.content === 'string' ? block.content : contentText(block.content) ?? JSON.stringify(block.content)
}

/** CodeBuddy: the text the model was given for call `id` (`output.text` of its `function_call_result` row; `providerData` is the screen's copy). */
const codebuddyResult = (id: string) => (row: unknown) => {
  const value = row as { type?: unknown; callId?: unknown; output?: { text?: unknown } } | null
  return value?.type === 'function_call_result' && value.callId === id && typeof value.output?.text === 'string' ? value.output.text : undefined
}

/** Claude Code: a compaction (`compact_boundary`), or tool results the API cleared (`context_management.applied_edits`). */
const CLAUDE_CONTEXT_GONE = (line: string) => line.includes('"subtype":"compact_boundary"') || /"applied_edits":\[\{/u.test(line)
/** CodeBuddy: a compaction (`"agent":"compact"`), or history dropped when the prompt was too long. */
const CODEBUDDY_CONTEXT_GONE = (line: string) => line.includes('"agent":"compact"') || line.includes('"isPtlRecovery":true') || line.includes('"isPtlRetryMarker":true')

/** One key per distinct read: the agent (a subagent has its own context), the file and the range. */
const readKey = (tool: string, agent: unknown, ...what: unknown[]) => `${tool} ${JSON.stringify([typeof agent === 'string' ? agent : null, ...what.map(item => item ?? null)])}`

/**
 * CodeBuddy's Read (the numbered text the model reads): journaled, and a repeat of one still in context becomes a
 * note. A subagent's read is never a repeat (the transcript is its parent's). Its other tools' text is journaled.
 */
function codebuddyTool(input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  const tool = input.tool_name, result = input.tool_response
  if (typeof tool !== 'string' || !codebuddyModelCall(input)) return undefined
  const text = typeof result === 'string' ? result : contentText(result)
  if (text === undefined) return undefined
  const args = input.tool_input as { file_path?: unknown; offset?: unknown; limit?: unknown } | null | undefined
  const base = { host: 'codebuddy', tool, sessionId: text_(input.session_id), callId: text_(input.tool_use_id), args: input.tool_input, text,
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env }
  if (tool !== 'Read' || typeof args?.file_path !== 'string' || text.includes('<persisted-output>')) { passToolOutput(base); return undefined }
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== ''
  const lines = subagent ? undefined : transcriptTail(input.transcript_path)
  const note = passToolOutput({ ...base, read: { key: readKey('Read', input.agent_id, args.file_path, args.offset, args.limit), what: args.file_path,
    stillInContext: id => stillInTranscript(lines, id, codebuddyResult(id), CODEBUDDY_CONTEXT_GONE) } })
  return note === undefined ? undefined : JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: note } })
}

/** The text of a tool result given as MCP-style content blocks (`[{type:'text', text}]`). */
function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const texts = value.filter((block): block is { type: 'text'; text: string } => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
  return texts.length === value.length && texts.length > 0 ? texts.map(block => block.text).join('\n') : undefined
}

/**
 * CodeBuddy's TaskOutput of a background command (2.184, `executeBackgroundShellTask`): a header, then each stream
 * under a label. A header with `Exit code: unknown` (between Status and Duration) does not match.
 */
const CODEBUDDY_TASK = /^Shell ID: ([\w-]{1,64})\nCommand: ([\s\S]+?)\nStatus: (completed|failed)\nDuration: [^\n]*\nTimestamp: [^\n]*\n\n/u
/** The stdout label of an output read from its start, with nothing cut, filtered or still to come. */
const CODEBUDDY_STDOUT = /^Stdout \((?:full snapshot|delta); chars=0-(\d+); caught_up=true; more_expected=false\):\n/u
const CODEBUDDY_STDERR = /^\n\nStderr \((?:full snapshot|delta); chars=\d+-\d+; caught_up=true; more_expected=false(?:; omitted=\d+)?\):\n/u

/**
 * A failed background command's exit code: TaskOutput does not show it, but CodeBuddy's completion notice
 * (`Background command "…" failed with exit code N`, naming `task_id="<id>"`) is in the transcript once sent,
 * which is not yet the case when the model waits for the command with TaskOutput itself.
 */
function codebuddyExitCode(input: HookInput, taskId: string): number | undefined {
  const path = input.transcript_path
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return undefined
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return undefined
    const size = Math.min(stat.size, 8 * 1024 * 1024)
    const buffer = Buffer.alloc(size)
    const fd = openSync(path, 'r')
    try { readSync(fd, buffer, 0, size, stat.size - size) } finally { closeSync(fd) }
    const named = new RegExp(`task_id=\\\\*"${taskId}\\\\*"`, 'u')
    for (const line of buffer.toString('utf8').split('\n').reverse()) {
      if (!named.test(line)) continue
      const code = /\bfailed with exit code (-?\d+)/u.exec(line)
      if (code) return Number(code[1])
    }
  } catch { /* Unknown. */ }
  return undefined
}

/**
 * CodeBuddy's TaskOutput: the stdout of a finished background command, read whole, filtered as that command's
 * output; the header, labels and stderr stay as they are. A command still running, cut, filtered or read in part,
 * one whose exit status CodeBuddy did not capture, or one TokenWise already shortened, is left alone.
 */
function codebuddyTaskOutput(input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  const result = input.tool_response
  if (input.tool_name !== 'TaskOutput' || typeof result !== 'string' || input.tool_input?.filter !== undefined) return undefined
  if (!codebuddyModelCall(input)) return undefined
  const head = CODEBUDDY_TASK.exec(result)
  const label = head ? CODEBUDDY_STDOUT.exec(result.slice(head[0].length)) : null
  if (!head || !label) return undefined
  const start = head[0].length + label[0].length, length = Number(label[1])
  const stdout = result.slice(start, start + length)
  if (length === 0 || stdout.length !== length || !CODEBUDDY_STDERR.test(result.slice(start + length))) return undefined
  const command = head[2]!
  if (command.trimStart().startsWith(`${WRAPPER} `)) return undefined
  // `failed` is any non-zero exit. Unknown, it is read as 1: the filters that take a failed run (test runners, linters)
  // tell only 0 from 1, and every other filter declines a non-zero exit.
  const exitCode = head[3] === 'completed' ? 0 : codebuddyExitCode(input, head[1]!) ?? 1
  const projected = projectOutput({ host: 'codebuddy', delivery: 'result-hook', tool: 'TaskOutput', sessionId: text(input.session_id),
    callId: text(input.tool_use_id), command, exitCode, interrupted: false, stdout, stderr: '',
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  if (!projected) return undefined
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
    updatedToolOutput: result.slice(0, start) + projected.stdout + result.slice(start + length) } })
}

/** Economy on a host tool's own result, answered as a PostToolUse `updatedToolOutput` string. */
function nativeReply(host: HookHost, input: HookInput, tool: string, native: NativeResult, env: NodeJS.ProcessEnv): string | undefined {
  if (native.projection === undefined) return undefined
  const delivered = projectNative({ host, tool, sessionId: text(input.session_id), callId: text(input.tool_use_id),
    command: describeToolCall(tool, input.tool_input), native, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  return delivered === undefined ? undefined : JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: delivered } })
}

/**
 * CodeBuddy PreToolUse: wrap like Codex, without a permission decision.
 * CodeBuddy's permission check runs on the command as the model wrote it and
 * an `allow` would skip it, deny rules included. Its PostToolUse event carries
 * no command output, so the wrapper is the only way to filter.
 */
export function codebuddyHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (input.hook_event_name === 'Stop') return turnEnd('codebuddy', input, env)
  if (input.hook_event_name === 'PostToolUse') {
    if (input.tool_name === 'TaskOutput') return codebuddyTaskOutput(input, env)
    if (input.tool_name === 'Grep' || input.tool_name === 'Glob') return codebuddySearch(input, env)
    return codebuddyTool(input, env)
  }
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return undefined
  const command = wrapScript('codebuddy', input, env, { normalize: true, tool: 'Bash' })
  if (command === undefined) return undefined
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command } } })
}

/**
 * Claude Code. PostToolUse replaces a successful Bash call's output with its
 * projection; Claude Code sends failed calls to PostToolUseFailure, which
 * cannot replace output. PreToolUse wraps the command in `tokenwise run`
 * instead, which also filters failed calls, where that changes no permission:
 * in `bypassPermissions` mode, and elsewhere for one simple command the user's
 * own rules allow and no deny or ask rule could match (claude-permissions.ts),
 * answered with `allow`. Every other command runs as written.
 */
export function claudeHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (eventHost(input, env) !== undefined) return undefined
  // LightShadow (see claude-shadow.ts): shape the summary, add the catalog after it, let the recall tool run.
  if (input.hook_event_name === 'PreCompact') return claudePreCompact(input)
  if (input.hook_event_name === 'SessionStart') return claudeAfterCompact(input)
  if (input.hook_event_name === 'Stop') return turnEnd('claude', input, env)
  if (input.hook_event_name === 'PreToolUse' && input.tool_name !== 'Bash') return claudeAllowRecall(input.tool_name)
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Read') return claudeTaskRead(input, env) ?? claudeRead(input, env)
  if (input.hook_event_name === 'PostToolUse' && input.tool_name !== 'Bash') { claudeTool(input, env); return undefined }
  if (input.tool_name !== 'Bash') return undefined
  if (input.hook_event_name === 'PreToolUse') {
    // Wrapped, a command is filtered even when it fails (PostToolUse sees only successful calls). Outside
    // bypassPermissions mode, only a command the user's own rules already allow is wrapped, and allowed as such.
    const original = input.tool_input?.command
    const bypass = input.permission_mode === 'bypassPermissions'
    const allowed = !bypass && typeof original === 'string' && input.permission_mode !== 'plan'
      && allowedByRules(original, env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' ? input.cwd : undefined), env)
    if (!bypass && !allowed) return undefined
    const command = wrapScript('claude', input, env, { normalize: false, tool: 'Bash' })
    if (command === undefined) return undefined
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...allowed ? { permissionDecision: 'allow' } : {},
      updatedInput: { ...input.tool_input, command } } })
  }
  if (input.hook_event_name !== 'PostToolUse') return undefined
  const command = input.tool_input?.command
  if (typeof command !== 'string' || command.trimStart().startsWith(`${WRAPPER} `)) return undefined
  const response = input.tool_response as { stdout?: unknown; stderr?: unknown; interrupted?: unknown; isImage?: unknown
    persistedOutputPath?: unknown; persistedOutputSize?: unknown; backgroundTaskId?: unknown } | null | undefined
  // Started in the background: its output comes later, in the task's output file. Remember what it runs.
  if (input.tool_input?.run_in_background === true) {
    const sessionId = text(input.session_id), taskId = text(response?.backgroundTaskId)
    const store = sessionId && taskId ? cliContext({ ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env }).writable() : undefined
    if (store) rememberBackground(store.dataDir, 'claude', sessionId!, taskId!, { command, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {} })
    return undefined
  }
  if (!response || typeof response.stdout !== 'string' || typeof response.stderr !== 'string' || response.isImage === true) return undefined
  // `cat` of a finished background task's output file: that task's command's output.
  const catted = CLAUDE_CAT_TASK.exec(command)
  if (catted && response.stderr === '' && response.persistedOutputPath === undefined) {
    const projected = claudeTaskOutput(input, catted[2]!, response.stdout, env)
    return projected === undefined ? undefined
      : JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, stdout: projected } } })
  }
  // Over its output limit (30,000 characters by default), Claude Code cuts `stdout`, saves the whole output to a file and
  // shows the model a preview of it. Filter the whole output, and hand it over only if it fits where the cut text was.
  let stdout = response.stdout
  const persisted = response.persistedOutputPath
  if (persisted !== undefined) {
    if (typeof persisted !== 'string') return undefined
    try { stdout = readFileSync(persisted, 'utf8') } catch { return undefined }
    if (typeof response.persistedOutputSize === 'number' && Buffer.byteLength(stdout) !== response.persistedOutputSize) return undefined
  }
  // No mayProject gate after the fact: the output is here, and a learned rule or the evidence for one may need any command.
  const projected = projectOutput({ host: 'claude', delivery: 'result-hook', tool: 'Bash', sessionId: text(input.session_id), callId: text(input.tool_use_id),
    command, exitCode: 0, interrupted: response.interrupted === true, stdout, stderr: response.stderr,
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  if (!projected) return undefined
  const { persistedOutputPath: _path, persistedOutputSize: _size, ...rest } = response
  if (persisted !== undefined && projected.stdout.length >= response.stdout.length) return undefined
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...rest, ...projected } } })
}

/** A background command's output file: `<tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output`. */
const CLAUDE_TASK_FILE = /\/tasks\/([A-Za-z0-9]{6,32})\.output$/u
/** `cat` of one such file, as the model writes it. */
const CLAUDE_CAT_TASK = /^\s*cat\s+(['"]?)(\/[^'"\s]*\/tasks\/[A-Za-z0-9]{6,32}\.output)\1\s*$/u
/** What Claude Code writes after the output once the command exited (a killed one ends `[killed]`, and is left alone). */
const CLAUDE_TASK_END = /\n?\[exited with code (-?\d+)\]\n?$/u

/**
 * The complete output of a finished background task, read from its output
 * file, filtered as the output of the command that started it (remembered
 * when it started, in this conversation). Undefined when the task is still
 * running, was killed, was not seen start, or nothing changes.
 */
function claudeTaskOutput(input: HookInput, path: string, content: string, env: NodeJS.ProcessEnv): string | undefined {
  const sessionId = text(input.session_id)
  const taskId = CLAUDE_TASK_FILE.exec(path)?.[1]
  const end = CLAUDE_TASK_END.exec(content)
  if (!sessionId || !taskId || !end) return undefined
  const context = cliContext({ ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  const started = backgroundCommand(context.dataDirs, 'claude', sessionId, taskId)
  if (!started) return undefined
  const projected = projectOutput({ host: 'claude', delivery: 'result-hook', tool: 'Bash', sessionId, callId: text(input.tool_use_id),
    command: started.command, exitCode: Number(end[1]), interrupted: false, stdout: content.slice(0, end.index),
    ...started.cwd === undefined ? {} : { cwd: started.cwd }, env })
  return projected === undefined ? undefined : projected.stdout + content.slice(end.index)
}

/** Claude Code's Read of a whole background task output file: its `file.content` replaced, the line counts kept consistent. */
function claudeTaskRead(input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  const args = input.tool_input as { file_path?: unknown; offset?: unknown; limit?: unknown } | null | undefined
  const response = input.tool_response as { type?: unknown; file?: { content?: unknown; startLine?: unknown; numLines?: unknown; totalLines?: unknown } } | null | undefined
  const path = args?.file_path
  const file = response?.file
  if (typeof path !== 'string' || !CLAUDE_TASK_FILE.test(path) || response?.type !== 'text' || !file || typeof file.content !== 'string') return undefined
  // Only a read of the whole file holds the whole output.
  if (args?.offset !== undefined || args?.limit !== undefined || file.startLine !== 1 || typeof file.numLines !== 'number' || file.numLines !== file.totalLines) return undefined
  const content = claudeTaskOutput(input, path, file.content, env)
  if (content === undefined) return undefined
  const lines = content.split('\n').length + (file.numLines - file.content.split('\n').length)
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
    updatedToolOutput: { ...response, file: { ...file, content, numLines: lines, totalLines: lines } } } })
}

/**
 * Claude Code's Read of a text file: journaled, and a repeat of one still in context (by the transcript) becomes a
 * note, which Claude Code shows the model as one numbered line. A subagent's read is never a repeat (the
 * transcript is the main conversation's).
 */
function claudeRead(input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  const args = input.tool_input as { file_path?: unknown; offset?: unknown; limit?: unknown; pages?: unknown } | null | undefined
  const response = input.tool_response as { type?: unknown; file?: { content?: unknown; startLine?: unknown } } | null | undefined
  const file = response?.file
  if (typeof args?.file_path !== 'string' || response?.type !== 'text' || !file || typeof file.content !== 'string') return undefined
  const subagent = typeof input.agent_id === 'string' && input.agent_id !== ''
  const lines = subagent ? undefined : transcriptTail(input.transcript_path)
  const note = passToolOutput({ host: 'claude', tool: 'Read', sessionId: text(input.session_id), callId: text(input.tool_use_id), args: input.tool_input,
    text: file.content, read: { key: readKey('Read', input.agent_id, args.file_path, args.offset, args.limit, args.pages), what: args.file_path,
      stillInContext: id => stillInTranscript(lines, id, claudeResult(id), CLAUDE_CONTEXT_GONE) },
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  if (note === undefined) return undefined
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, file: { ...file, content: note, numLines: 1 } } } })
}

/** The text the model reads from one of Claude Code's other tools, where the result holds it; TokenWise's own recall is not counted. */
function claudeTool(input: HookInput, env: NodeJS.ProcessEnv): void {
  const tool = input.tool_name, response = input.tool_response as { result?: unknown; results?: unknown; content?: unknown } | string | null | undefined
  if (typeof tool !== 'string' || tool.endsWith('__tokenwise_recall') || response === null || response === undefined) return
  const text = typeof response === 'string' ? response
    : tool === 'WebFetch' && typeof response.result === 'string' ? response.result
    : tool === 'WebSearch' && Array.isArray(response.results) ? JSON.stringify(response.results)
    : contentText(Array.isArray(response) ? response : response.content)
  if (text === undefined) return
  passToolOutput({ host: 'claude', tool, sessionId: text_(input.session_id), callId: text_(input.tool_use_id), args: input.tool_input, text,
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
}

/** Grok's shell result (`toolResult` of a `run_terminal_command` PostToolUse event). */
interface GrokShellResult {
  readonly type?: unknown
  readonly command?: unknown
  readonly output?: unknown
  readonly output_for_prompt?: unknown
  readonly exit_code?: unknown
  readonly truncated?: unknown
  readonly signal?: unknown
  readonly timed_out?: unknown
  readonly pre_formatted?: unknown
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Grok PostToolUse: replace the model's copy of a shell result with its
 * projection. Grok fires PostToolUse for failed commands too, and keeps the
 * original in its scrollback and transcript. The model reads
 * `exit: N\n<output>`; any other layout is left alone.
 */
export function grokHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'get_command_or_subagent_output') return grokTaskOutput(input, env)
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'read_file') return grokRead(input, env)
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'list_dir') {
    // Its text (`Content.content`, what the model reads) journaled as it is.
    const listing = (input.toolResult as { type?: unknown; Content?: { content?: unknown } } | null | undefined)
    if (listing?.type === 'ListDir' && typeof listing.Content?.content === 'string') {
      passToolOutput({ host: 'grok', tool: 'list_dir', sessionId: text(input.session_id), callId: text(input.tool_use_id), args: input.tool_input,
        text: listing.Content.content, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
    }
    return undefined
  }
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'run_terminal_command' || input.isBackgrounded === true) return undefined
  const result = (input.toolResult ?? input.tool_response) as GrokShellResult | string | null | undefined
  // Results over 128 KiB arrive as their model-facing text, already cut to Grok's limits: left alone.
  if (!result || typeof result !== 'object' || result.type !== 'Bash' || result.pre_formatted) return undefined
  const command = typeof result.command === 'string' ? result.command : input.tool_input?.command
  const exitCode = result.exit_code
  if (typeof command !== 'string' || typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || !Array.isArray(result.output)) return undefined
  let output: string
  try { output = utf8.decode(Uint8Array.from(result.output as number[])) } catch { return undefined }
  const status = `exit: ${exitCode}\n`
  if (result.output_for_prompt !== status + output) return undefined
  // No mayProject gate after the fact: the output is here, and a learned rule or the evidence for one may need any command.
  const projected = projectOutput({ host: 'grok', delivery: 'result-hook', tool: 'run_terminal_command', sessionId: text(input.session_id),
    callId: text(input.tool_use_id), command, exitCode, interrupted: result.timed_out === true || (result.signal !== null && result.signal !== undefined),
    truncated: result.truncated === true, stdout: output, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  if (!projected) return undefined
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: status + projected.stdout } })
}

/** A background command's result in a `get_command_or_subagent_output` read (Grok 1.0.77, `TaskOutputResult`). */
interface GrokTaskResult {
  readonly command?: unknown
  readonly status?: unknown
  readonly exit_code?: unknown
  readonly output?: unknown
  readonly output_file?: unknown
  readonly truncated?: unknown
  readonly raw_output_bytes?: unknown
}

/** A background command's log under a Grok session (`…/terminal/call-<id>.log`); monitors and subagents log elsewhere. */
const GROK_TASK_LOG = /\/terminal\/call-[^/]+\.log$/u

/**
 * Grok's read of one background command (`get_command_or_subagent_output`): when the command finished (completed or
 * failed, with an exit code) and the read holds all of its output (not cut: as many bytes as the command wrote, and
 * the same text as its log), that output is filtered as the command's, and Grok renders the edited result as usual.
 * A command still running, timed out or cancelled, a cut read, several tasks at once, a monitor or a subagent is
 * left alone.
 */
function grokTaskOutput(input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  if (input.toolResultTruncated === true) return undefined
  const result = (input.toolResult ?? input.tool_response) as { type?: unknown; Result?: GrokTaskResult } | string | null | undefined
  if (!result || typeof result !== 'object' || result.type !== 'TaskOutput' || !result.Result || typeof result.Result !== 'object') return undefined
  const task = result.Result
  const { command, status, exit_code: exitCode, output, output_file: file } = task
  if (typeof command !== 'string' || command === '' || command.startsWith('[monitor] ')) return undefined
  if ((status !== 'completed' && status !== 'failed') || typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode)) return undefined
  if (task.truncated !== false || typeof output !== 'string' || output === '' || Buffer.byteLength(output) !== task.raw_output_bytes) return undefined
  if (typeof file !== 'string' || !GROK_TASK_LOG.test(file)) return undefined
  try { if (readFileSync(file, 'utf8') !== output) return undefined } catch { return undefined }
  const projected = projectOutput({ host: 'grok', delivery: 'result-hook', tool: 'get_command_or_subagent_output', sessionId: text(input.session_id),
    callId: text(input.tool_use_id), command, exitCode, interrupted: false, stdout: output, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  if (!projected) return undefined
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...result, Result: { ...task, output: projected.stdout } } } })
}

/**
 * Grok's read_file (`toolResult` ReadFile, whose `content` is the text the model reads): journaled, and a repeat of
 * one still in context becomes a note. Still in context, by the session's `chat_history.jsonl` (the model's copy):
 * the earlier result is there whole, before the call being answered, and fewer than three of your prompts came
 * since (Grok trims older results without a trace when its context fills). A compaction rewrites the history, so
 * the earlier result is then gone. A subagent's read is never a repeat.
 */
function grokRead(input: HookInput, env: NodeJS.ProcessEnv): string | undefined {
  if (input.toolResultTruncated === true) return undefined
  const result = (input.toolResult ?? input.tool_response) as { type?: unknown; FileContent?: { content?: unknown; absolute_path?: unknown; offset?: unknown } } | null | undefined
  const file = result && typeof result === 'object' ? result.FileContent : undefined
  if (result?.type !== 'ReadFile' || !file || typeof file.content !== 'string' || typeof file.absolute_path !== 'string') return undefined
  const args = input.tool_input as { limit?: unknown; pages?: unknown } | null | undefined
  const callId = text(input.tool_use_id)
  const history = typeof input.subagentType === 'string' || typeof input.transcript_path !== 'string' ? undefined
    : grokHistory(join(dirname(input.transcript_path), 'chat_history.jsonl'))
  const note = passToolOutput({ host: 'grok', tool: 'read_file', sessionId: text(input.session_id), callId, args: input.tool_input, text: file.content,
    read: { key: readKey('read_file', input.subagentType, file.absolute_path, file.offset, args?.limit, args?.pages), what: file.absolute_path,
      stillInContext: id => history !== undefined && callId !== null && grokStillInContext(history, id, callId) },
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  return note === undefined ? undefined : JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: note } })
}

/** Grok's chat history rows: tool results, your prompts, and the calls the model made. */
function grokHistory(path: string): { readonly type?: unknown; readonly tool_call_id?: unknown; readonly content?: unknown; readonly prompt_index?: unknown
  readonly tool_calls?: readonly { readonly id?: unknown }[] }[] | undefined {
  const lines = transcriptTail(path)
  if (!lines) return undefined
  return lines.flatMap(line => { try { return line.trim() === '' ? [] : [JSON.parse(line)] } catch { return [] } })
}

function grokStillInContext(rows: NonNullable<ReturnType<typeof grokHistory>>, earlier: string, current: string): boolean {
  const at = rows.findIndex(row => row.type === 'tool_result' && row.tool_call_id === earlier)
  if (at < 0 || typeof rows[at]!.content !== 'string' || /^\[TokenWise: |\[…trimmed…\]|Tool result omitted/u.test(rows[at]!.content as string)) return false
  // Before the model asked again (a read in the same batch was not in front of it yet).
  const asked = rows.findIndex(row => row.type === 'assistant' && Array.isArray(row.tool_calls) && row.tool_calls.some(call => call?.id === current))
  if (asked >= 0 && asked < at) return false
  return rows.slice(at + 1).filter(row => row.type === 'user' && typeof row.prompt_index === 'number').length < 3
}

/** Copilot CLI ends a bash result with its own status line (seen on 1.0.103). */
const COPILOT_STATUS = /\n?<shellId: [^>\n]* completed with exit code (-?\d+)>\s*$/u
/** Copilot saves output too large for the model to a file and shows a preview instead. */
const COPILOT_SAVED = 'Output too large to read at once'
/** Copilot 1.0.103 shortens some output itself, and keeps the original in a file it names. */
const COPILOT_COMPACTED = /^Shell output was automatically compacted\. Compacted output below\. Original at ([^\n;]+); only use if exact omitted lines are needed\.\n/u
const COPILOT_ORIGINAL = /^original-output-\d+-[0-9a-f]{32}\.txt$/u

/**
 * The original Copilot kept, read only from a file of Copilot's naming in this
 * user's temporary folder (a command could print that header itself).
 */
function copilotOriginal(path: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const folders = new Set([resolve(tmpdir()), ...env.TMPDIR ? [resolve(env.TMPDIR)] : []])
    if (!COPILOT_ORIGINAL.test(basename(path)) || !folders.has(resolve(dirname(path)))) return undefined
    const stat = lstatSync(path)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || stat.size > 32 * 1024 * 1024) return undefined
    return readFileSync(path, 'utf8').replace(/\n$/u, '')
  } catch { return undefined }
}

/**
 * GitHub Copilot CLI: postToolUse of its bash tool. Its camelCase events carry
 * no event name: a tool result has `toolResult`. The reply's `modifiedResult`
 * replaces what the model reads, failed commands included (they are results of
 * type success with a non-zero exit code in the status line, which stays).
 */
export function copilotHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // agentStop, the end of a turn: what TokenWise saved in this conversation, as a progress line in Copilot's timeline.
  if (typeof input.stopReason === 'string' && input.toolName === undefined) {
    if (input.stopReason !== 'end_turn' || input.stop_hook_active === true) return undefined
    return notice('copilot', conversationNotice('copilot', text(input.sessionId) ?? undefined, env))
  }
  const args = input.toolArgs as { command?: unknown } | null | undefined
  // preToolUse, during `tokenwise doctor --probe` only: Copilot's rules cannot allow one tokenwise subcommand, so this does.
  if (input.toolResult === undefined && typeof env.TOKENWISE_PROBE === 'string' && /^tw[0-9a-f]{8}$/u.test(env.TOKENWISE_PROBE)) {
    const probe = input.toolName === 'bash' && typeof args?.command === 'string' && args.command.trim() === `tokenwise probe ${env.TOKENWISE_PROBE}`
    return JSON.stringify(probe ? { permissionDecision: 'allow' }
      : { permissionDecision: 'deny', permissionDecisionReason: 'TokenWise probe: only the probe command may run.' })
  }
  const result = input.toolResult as { resultType?: unknown; textResultForLlm?: unknown } | null | undefined
  if (!result || result.resultType !== 'success' || typeof result.textResultForLlm !== 'string') return undefined
  if (input.toolName === 'read_bash') return copilotReadBash(input, result.textResultForLlm, env)
  if (input.toolName === 'view') return copilotView(input, result.textResultForLlm, env)
  if (input.toolName !== 'bash') {
    // Any other tool: the text the model reads, journaled as it is (TokenWise's own recall aside).
    if (typeof input.toolName === 'string' && !input.toolName.endsWith('tokenwise_recall')) {
      passToolOutput({ host: 'copilot', tool: input.toolName, sessionId: text(input.sessionId), callId: text(input.toolCallId), args: input.toolArgs,
        text: result.textResultForLlm, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
    }
    return undefined
  }
  const command = args?.command
  const output = result.textResultForLlm
  if (typeof command !== 'string' || output.startsWith(COPILOT_SAVED)) return undefined
  const status = COPILOT_STATUS.exec(output)
  // Started in the background, or still running when bash returned: its output comes later, through read_bash.
  if (!status) { copilotRememberShell(input, command, output, env); return undefined }
  const projected = copilotProject(input, 'bash', command, Number(status[1]), output.slice(0, status.index), input.cwd, env)
  if (projected === undefined) return undefined
  return JSON.stringify({ modifiedResult: { resultType: 'success', textResultForLlm: projected + output.slice(status.index) } })
}

/**
 * A finished Copilot command's output (what Copilot shows before its status line), projected. Output Copilot
 * shortened itself: TokenWise works on the original it kept, and its projection replaces Copilot's only when shorter.
 */
function copilotProject(input: HookInput, tool: string, command: string, exitCode: number, shown: string, cwd: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const compacted = COPILOT_COMPACTED.exec(shown)
  const original = compacted ? copilotOriginal(compacted[1]!.trim(), env) : undefined
  if (compacted && original === undefined) return undefined
  const projected = projectOutput({ host: 'copilot', delivery: 'result-hook', tool, sessionId: text(input.sessionId), callId: tool === 'bash' ? null : text(input.toolCallId),
    command, exitCode, interrupted: false, truncated: false, stdout: original ?? shown,
    ...compacted ? { maxProjectedChars: shown.length - 1 } : {}, ...typeof cwd === 'string' ? { cwd } : {}, env })
  return projected?.stdout
}

/** Copilot's bash result for a command that goes on running: started in the background, or still running after its wait (1.0.107). */
const COPILOT_RUNNING = /<command (?:started in (?:detached )?background with shellId: ([^>\s]+)|with shellId: ([^>\s]+) is still running after )/u
/** The end of a read_bash of a finished shell: `<shellId: X completed with exit code N>`, or `<detached command with shellId: …>`. */
const COPILOT_READ_END = /\n?<(detached command with )?shellId: ([^>\s]+) completed with exit code (-?\d+)>\s*$/u

/** Remember which command a Copilot shell runs, so a later read_bash of it can be filtered as that command's output. */
function copilotRememberShell(input: HookInput, command: string, output: string, env: NodeJS.ProcessEnv): void {
  const running = COPILOT_RUNNING.exec(output)
  const sessionId = text(input.sessionId), shellId = running?.[1] ?? running?.[2]
  if (!sessionId || !shellId) return
  const store = cliContext({ ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env }).writable()
  if (store) rememberBackground(store.dataDir, 'copilot', sessionId, shellId, { command, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {} })
}

/**
 * Copilot's read_bash of a shell whose command finished: the read holds the command's whole output (from its start)
 * and the status line with its exit code. That output is filtered as the command's (remembered when bash started
 * it); the status line, and a detached shell's `Output:` lead, stay. A shell still running, stopped, saved to a file,
 * read again after its output was read, or started outside this conversation, is left alone. Output Copilot
 * compacted itself is handled as for bash.
 */
function copilotReadBash(input: HookInput, output: string, env: NodeJS.ProcessEnv): string | undefined {
  const sessionId = text(input.sessionId)
  const end = COPILOT_READ_END.exec(output)
  const shellId = (input.toolArgs as { shellId?: unknown } | null | undefined)?.shellId
  if (!sessionId || !end || end[2] !== shellId || output.startsWith(COPILOT_SAVED)) return undefined
  const lead = end[1] ? 'Output:\n' : ''
  if (!output.startsWith(lead)) return undefined
  const shown = output.slice(lead.length, end.index)
  if (shown.trim() === '') return undefined
  const context = cliContext({ ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  const started = backgroundCommand(context.dataDirs, 'copilot', sessionId, end[2]!)
  if (!started) return undefined
  const projected = copilotProject(input, 'read_bash', started.command, Number(end[3]), shown, started.cwd, env)
  if (projected === undefined) return undefined
  return JSON.stringify({ modifiedResult: { resultType: 'success', textResultForLlm: lead + projected + output.slice(end.index) } })
}

/** A view whose earlier copy is older than this may have been cleared by Copilot without a trace (its cache-cold clearing). */
const COPILOT_RECENT_MS = 5 * 60_000
/** Copilot events after which earlier results are no longer what the model has. */
const COPILOT_CONTEXT_GONE = new Set(['session.compaction_start', 'session.compaction_complete', 'session.truncation', 'session.context_cleared', 'session.resume'])

/**
 * Copilot's view of a file (the text the model reads): journaled, and a repeat of one still in context becomes a
 * note. Still in context, by the session's events (the model's copy of each result): the earlier view is there whole,
 * from this conversation's own agent, before the call being answered, less than five minutes old, and no event since
 * compacted, truncated or cleared the conversation.
 */
function copilotView(input: HookInput, output: string, env: NodeJS.ProcessEnv): string | undefined {
  const args = input.toolArgs as { path?: unknown; view_range?: unknown } | null | undefined
  if (typeof args?.path !== 'string' || output.startsWith('Path does not exist') || output.includes('File is too large to view')) return undefined
  const sessionId = text(input.sessionId), callId = text(input.toolCallId)
  const home = env.COPILOT_HOME || join(env.HOME || homedir(), '.copilot')
  const events = sessionId ? copilotEvents(join(home, 'session-state', sessionId, 'events.jsonl')) : undefined
  const note = passToolOutput({ host: 'copilot', tool: 'view', sessionId, callId, args: input.toolArgs, text: output,
    read: { key: readKey('view', null, args.path, args.view_range), what: args.path,
      stillInContext: id => events !== undefined && callId !== null && copilotStillInContext(events, id, callId) },
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  return note === undefined ? undefined : JSON.stringify({ modifiedResult: { resultType: 'success', textResultForLlm: note } })
}

type CopilotEvent = { readonly type?: unknown; readonly timestamp?: unknown; readonly data?: { readonly toolCallId?: unknown; readonly parentToolCallId?: unknown
  readonly result?: { readonly content?: unknown }; readonly toolRequests?: readonly { readonly toolCallId?: unknown }[] } }

function copilotEvents(path: string): CopilotEvent[] | undefined {
  const lines = transcriptTail(path)
  return lines?.flatMap(line => { try { return line.trim() === '' ? [] : [JSON.parse(line) as CopilotEvent] } catch { return [] } })
}

function copilotStillInContext(events: readonly CopilotEvent[], earlier: string, current: string): boolean {
  const at = events.findIndex(event => event.type === 'tool.execution_complete' && event.data?.toolCallId === earlier)
  const done = events[at]
  if (!done || done.data?.parentToolCallId !== undefined || typeof done.data?.result?.content !== 'string' || done.data.result.content.startsWith('[TokenWise: ')) return false
  const when = typeof done.timestamp === 'string' ? Date.parse(done.timestamp) : Number.NaN
  if (!(Date.now() - when < COPILOT_RECENT_MS)) return false
  const asked = events.findIndex(event => event.type === 'assistant.message' && event.data?.toolRequests?.some(request => request?.toolCallId === current))
  if (asked >= 0 && asked < at) return false
  return !events.slice(at + 1).some(event => typeof event.type === 'string' && COPILOT_CONTEXT_GONE.has(event.type))
}

/** Hermes's notes for a command it stopped (`tools/environments/base.py`). */
const HERMES_STOPPED = /\[Command (?:interrupted|timed out after [^\]\n]*)\]\s*$/u
/** Hermes's head-and-tail cut of a capture over its window (`tools/tool_output_truncate.py`). */
const HERMES_CUT = '... [OUTPUT TRUNCATED - '

/**
 * Hermes: its TokenWise plugin hands `transform_terminal_output` here (the
 * terminal tool's merged output after Hermes bounded the capture, before its
 * output limit, ANSI stripping and secret redaction). The reply is
 * `{"output": "<projection>"}`, which the plugin returns to Hermes. Output
 * Hermes cut, and commands it stopped, pass through. Hermes also hands
 * background-process output to `transform_terminal_output`, with no
 * `env_type` and only as a tail: left alone. The plugin sends the complete
 * output of a finished background process (`process_manage` wait, nothing
 * cut) as `process_output`.
 */
export function hermesHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const event = input.hook_event_name
  if (event !== 'transform_terminal_output' && event !== 'process_output') return undefined
  if (event === 'transform_terminal_output' && input.env_type === '') return undefined
  const { command, output, returncode } = input as { command?: unknown; output?: unknown; returncode?: unknown }
  if (typeof command !== 'string' || typeof output !== 'string' || output === '') return undefined
  if (typeof returncode !== 'number' || !Number.isSafeInteger(returncode)) return undefined
  // No mayProject gate after the fact: the output is here, and a learned rule or the evidence for one may need any command.
  const projected = projectOutput({ host: 'hermes', delivery: 'result-hook', tool: event === 'process_output' ? 'process_manage' : 'terminal',
    sessionId: text(input.session_id) ?? text(input.task_id),
    callId: text(input.tool_call_id), command, exitCode: returncode, interrupted: returncode < 0 || HERMES_STOPPED.test(output),
    truncated: output.includes(HERMES_CUT), stdout: output, ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {}, env })
  return projected ? JSON.stringify({ output: projected.stdout }) : undefined
}

/**
 * Grok: Economy on shell results, and LightShadow's assisted tier (see
 * grok-shadow.ts): PostCompact saves the span, the next PostToolUse of any
 * tool (or Stop, when the turn used none) adds the catalog.
 */
export function grokEntry(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const event = input.hook_event_name
  if (event === 'PostCompact') { grokAfterCompact(input); return undefined }
  if (event === 'Stop') {
    if (input.reason !== undefined && input.reason !== 'end_turn') return undefined
    const catalog = grokPendingCatalog(input)
    const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined
    const startup = sessionId && takePending(GROK_NOTICE, sessionId) ? startupNotice('grok') : undefined
    const message = [startup, conversationNotice('grok', sessionId, env)].filter(Boolean).join('\n') || undefined
    if (!catalog && !message) return undefined
    return JSON.stringify({ ...message ? { systemMessage: message } : {}, ...catalog ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: catalog } } : {} })
  }
  const economy = grokHook(input, env)
  if (event !== 'PostToolUse') return economy
  const catalog = grokPendingCatalog(input)
  if (!catalog) return economy
  const reply = (economy ? JSON.parse(economy) : { hookSpecificOutput: { hookEventName: 'PostToolUse' } }) as { hookSpecificOutput: Record<string, unknown> }
  reply.hookSpecificOutput.additionalContext = catalog
  return JSON.stringify(reply)
}

export async function readStdin(limit = MAX_INPUT): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new Error('hook input too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const HANDLERS: Record<HookHost, (input: HookInput) => string | undefined> = {
  codex: input => input.hook_event_name === 'Stop' ? turnEnd('codex', input) : codexAfterCompact(input) ?? codexPreToolUse(input), claude: claudeHook, codebuddy: codebuddyHook, grok: grokEntry, hermes: hermesHook,
  copilot: copilotHook,
}

/**
 * Grok shows a SessionStart `systemMessage` only when the session is reopened
 * (seen on Grok 1.0.70), but a Stop one at once: a new session marks that its
 * notice is due, and the end of its first turn says it (and only then counts it
 * as told, so a session closed sooner leaves it for the next).
 */
const GROK_NOTICE = 'grok-notice'
function holdGrokNotice(input: HookInput): undefined {
  if (typeof input.session_id === 'string' && input.session_id && startupNotice('grok', process.env, { peek: true })) keepPending(GROK_NOTICE, input.session_id, 'due')
  return undefined
}

/**
 * A new session, not one resumed or continued after a compaction: `startup` (Claude Code, Codex, CodeBuddy), `new` (Grok).
 * Copilot's sessionStart has no event name: it is the event with a `source` and no tool.
 */
const isStartup = (host: string, input: HookInput) => (input.hook_event_name === 'SessionStart' || (host === 'copilot' && typeof input.sessionId === 'string'
  && input.toolName === undefined)) && (input.source === 'startup' || input.source === 'new')

/** `tokenwise hook <host>`: never blocks a tool call, never exits non-zero. */
export async function hook(host: string | undefined): Promise<number> {
  try {
    if (host === undefined || !Object.hasOwn(HANDLERS, host)) return 0
    const input = JSON.parse(await readStdin()) as HookInput
    const output = !isStartup(host, input) ? HANDLERS[host as HookHost](input) : host === 'grok' ? holdGrokNotice(input) : notice(host, startupNotice(host))
    if (output) process.stdout.write(output + '\n')
  } catch { /* Passthrough. */ }
  return 0
}
