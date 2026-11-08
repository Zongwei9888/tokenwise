import { readFileSync } from 'node:fs'
import { mayProject } from '@tokenwise/core'
import { normalizeShellCommand } from '@tokenwise/mechanisms'
import { claudeAfterCompact, claudeAllowRecall, claudePreCompact } from './claude-shadow.ts'
import { codexAfterCompact } from './codex-shadow.ts'
import { grokAfterCompact, grokPendingCatalog } from './grok-shadow.ts'
import { cliContext, onPath, shellQuote } from './context.ts'
import { allowedByRules } from './claude-permissions.ts'
import { startupNotice } from './learn.ts'
import { keepPending, takePending } from './shadow.ts'
import { projectOutput } from './project.ts'

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
export const HOOK_HOSTS = ['codex', 'claude', 'codebuddy', 'grok', 'hermes'] as const
export type HookHost = typeof HOOK_HOSTS[number]

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null

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
 * CodeBuddy PreToolUse: wrap like Codex, without a permission decision.
 * CodeBuddy's permission check runs on the command as the model wrote it and
 * an `allow` would skip it, deny rules included. Its PostToolUse event carries
 * no command output, so the wrapper is the only way to filter.
 */
export function codebuddyHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
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
  if (input.hook_event_name === 'PreToolUse' && input.tool_name !== 'Bash') return claudeAllowRecall(input.tool_name)
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
  if (typeof command !== 'string' || command.trimStart().startsWith(`${WRAPPER} `) || input.tool_input?.run_in_background === true) return undefined
  const response = input.tool_response as { stdout?: unknown; stderr?: unknown; interrupted?: unknown; isImage?: unknown
    persistedOutputPath?: unknown; persistedOutputSize?: unknown } | null | undefined
  if (!response || typeof response.stdout !== 'string' || typeof response.stderr !== 'string' || response.isImage === true) return undefined
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

/** Hermes's notes for a command it stopped (`tools/environments/base.py`). */
const HERMES_STOPPED = /\[Command (?:interrupted|timed out after [^\]\n]*)\]\s*$/u
/** Hermes's head-and-tail cut of a capture over its window (`tools/tool_output_truncate.py`). */
const HERMES_CUT = '... [OUTPUT TRUNCATED - '

/**
 * Hermes: its TokenWise plugin hands `transform_terminal_output` here (the
 * terminal tool's merged output after Hermes bounded the capture, before its
 * output limit, ANSI stripping and secret redaction). The reply is
 * `{"output": "<projection>"}`, which the plugin returns to Hermes. Output
 * Hermes cut, and commands it stopped, pass through; background-process
 * output (no exit code yet) is left alone.
 */
export function hermesHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (input.hook_event_name !== 'transform_terminal_output') return undefined
  const { command, output, returncode } = input as { command?: unknown; output?: unknown; returncode?: unknown }
  if (typeof command !== 'string' || typeof output !== 'string' || output === '') return undefined
  if (typeof returncode !== 'number' || !Number.isSafeInteger(returncode)) return undefined
  // No mayProject gate after the fact: the output is here, and a learned rule or the evidence for one may need any command.
  const projected = projectOutput({ host: 'hermes', delivery: 'result-hook', tool: 'terminal', sessionId: text(input.session_id) ?? text(input.task_id),
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
    const message = sessionId && takePending(GROK_NOTICE, sessionId) ? startupNotice('grok') : undefined
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
  codex: input => codexAfterCompact(input) ?? codexPreToolUse(input), claude: claudeHook, codebuddy: codebuddyHook, grok: grokEntry, hermes: hermesHook,
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

/** A new session, not one resumed or continued after a compaction: `startup` (Claude Code, Codex, CodeBuddy), `new` (Grok). */
const isStartup = (input: HookInput) => input.hook_event_name === 'SessionStart' && (input.source === 'startup' || input.source === 'new')
const notice = (text: string | undefined) => text === undefined ? undefined : JSON.stringify({ systemMessage: text })

/** `tokenwise hook <host>`: never blocks a tool call, never exits non-zero. */
export async function hook(host: string | undefined): Promise<number> {
  try {
    if (host === undefined || !Object.hasOwn(HANDLERS, host)) return 0
    const input = JSON.parse(await readStdin()) as HookInput
    const output = !isStartup(input) ? HANDLERS[host as HookHost](input) : host === 'grok' ? holdGrokNotice(input) : notice(startupNotice(host))
    if (output) process.stdout.write(output + '\n')
  } catch { /* Passthrough. */ }
  return 0
}
