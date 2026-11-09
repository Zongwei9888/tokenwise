/**
 * Whether TokenWise works in each agent: set up (its skill is in place and
 * current), and seen working (the agent's last command TokenWise recorded).
 * `--probe` goes further: it asks each agent to run one harmless command,
 * `tokenwise probe <mark>`, and looks for that command in TokenWise's records,
 * which only the agent's TokenWise plugin can have written there.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, sources, type Sources } from './setup.ts'
import { onPath } from './context.ts'

export interface AgentCheck {
  readonly id: string
  readonly name: string
  readonly installed: boolean
  readonly skill: 'missing' | 'outdated' | 'current'
  /** Whether the agent's own settings have TokenWise's plugin on; undefined where they cannot tell. */
  readonly plugin?: 'on' | 'off'
  /** When TokenWise last recorded a command of this agent. */
  readonly lastSeen: Date | null
  readonly next?: string
}

/** The newest record file of a host, across every data location. */
export function lastSeen(dataDirs: readonly string[], host: string): Date | null {
  let newest = 0
  for (const dir of dataDirs) {
    const journal = join(dir, 'journal', host)
    let names: string[]
    try { names = readdirSync(journal) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      try { newest = Math.max(newest, statSync(join(journal, name)).mtimeMs) } catch { /* Gone meanwhile. */ }
    }
  }
  return newest ? new Date(newest) : null
}

function read(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/** The agent's own record of TokenWise's plugin being on, where that is a file TokenWise can read. */
export function pluginState(id: string, env: NodeJS.ProcessEnv = process.env): 'on' | 'off' | undefined {
  const home = env.HOME || homedir()
  const enabledIn = (path: string) => {
    try { return (JSON.parse(readFileSync(path, 'utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins?.['tokenwise@tokenwise'] === true ? 'on' : 'off' } catch { return 'off' }
  }
  const matches = (path: string, pattern: RegExp) => pattern.test(read(path) ?? '') ? 'on' : 'off'
  switch (id) {
    case 'claude': return enabledIn(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'))
    case 'codebuddy': return enabledIn(join(home, '.codebuddy', 'settings.json'))
    case 'codex': return matches(join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), /^\[plugins\."tokenwise@tokenwise"\]\s*\n\s*enabled\s*=\s*true\b/mu)
    case 'grok': return matches(join(home, '.grok', 'config.toml'), /^\[plugins\]\s*\n\s*enabled\s*=\s*\[[^\]]*"tokenwise"/mu)
    case 'opencode': return existsSync(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', 'tokenwise.js')) ? 'on' : 'off'
    case 'hermes': {
      const dir = env.HERMES_HOME || join(home, '.hermes')
      return existsSync(join(dir, 'plugins', 'tokenwise')) && /^\s*enabled:\s*\n(?:\s*-\s*\S+\s*\n)*?\s*-\s*tokenwise\s*$/mu.test(read(join(dir, 'config.yaml')) ?? '') ? 'on' : 'off'
    }
    case 'copilot': return enabledIn(join(env.COPILOT_HOME || join(home, '.copilot'), 'settings.json'))
    default: return undefined
  }
}

function plugin(id: string, setUp: boolean, env: NodeJS.ProcessEnv = process.env): { plugin?: 'on' | 'off' } {
  const state = setUp ? pluginState(id, env) : undefined
  return state === undefined ? {} : { plugin: state }
}

export function checkAgents(dataDirs: readonly string[], env: NodeJS.ProcessEnv = process.env, from: Sources = sources()): AgentCheck[] {
  const skill = read(join(from.skill, 'SKILL.md'))
  return AGENTS.map(agent => {
    const installed = read(join(agent.skillDir(env), 'SKILL.md'))
    return {
      id: agent.id, name: agent.name, installed: onPath(agent.bin, env) !== undefined,
      skill: installed === undefined ? 'missing' : skill === undefined || installed === skill ? 'current' : 'outdated',
      ...plugin(agent.id, installed !== undefined, env),
      lastSeen: lastSeen(dataDirs, agent.id),
      ...agent.next === undefined ? {} : { next: agent.next },
    }
  })
}

export function ago(time: Date, now = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - time.getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/** One line per agent on this machine or seen working; nothing for the others (agents share skill folders). */
export function describeAgents(checks: readonly AgentCheck[], now = new Date()): string[] {
  const shown = checks.filter(check => check.installed || check.lastSeen)
  const width = Math.max(0, ...shown.map(check => check.name.length))
  return shown.map(check => {
    const name = check.name.padEnd(width)
    if (!check.installed) return `  -  ${name}  not found on PATH${check.lastSeen ? ` (last command ${ago(check.lastSeen, now)})` : ''}`
    if (check.skill === 'missing') return `  !  ${name}  not set up: tokenwise setup ${check.id}`
    if (check.plugin === 'off') return `  !  ${name}  TokenWise is not on in it: tokenwise setup ${check.id}`
    const outdated = check.skill === 'outdated' ? `; its tokenwise skill is out of date: tokenwise setup ${check.id}` : ''
    if (check.lastSeen) return `${outdated ? '  !' : '  ✓'}  ${name}  working, last command ${ago(check.lastSeen, now)}${outdated}`
    return `  ·  ${name}  set up, no command seen yet${check.next ? ` (${check.next})` : ''}${outdated}`
  })
}

/** How to ask each agent, without a terminal, to run the probe command and nothing else. */
export function probeCommand(id: string, prompt: string, command: string): string[] | undefined {
  switch (id) {
    case 'claude': return ['claude', '-p', prompt, '--allowedTools', `Bash(${command})`]
    case 'codebuddy': return ['codebuddy', '-p', prompt, '--allowedTools', `Bash(${command})`]
    case 'grok': return ['grok', '-p', prompt, '--allow', `Bash(${command})`]
    // Codex runs it in its read-only sandbox; its hooks run only once trusted in /hooks.
    case 'codex': return ['codex', 'exec', '--skip-git-repo-check', prompt]
    case 'opencode': return ['opencode', 'run', prompt]
    case 'hermes': return ['hermes', 'chat', '-q', prompt, '-Q']
    // Copilot's rules cannot allow one tokenwise subcommand: TokenWise's own preToolUse hook allows the probe and denies the rest.
    case 'copilot': return ['copilot', '-p', prompt]
    case 'pi': return ['pi', '-p', prompt]
    // DeepSeek Harness runs prompts in its web or terminal app only.
    default: return undefined
  }
}

/** Whether a record of `host` written since `since` holds `mark`. */
export function sawProbe(dataDirs: readonly string[], host: string, mark: string, since: number): boolean {
  for (const dir of dataDirs) {
    const journal = join(dir, 'journal', host)
    let names: string[]
    try { names = readdirSync(journal) } catch { continue }
    for (const name of names) {
      const path = join(journal, name)
      try { if (statSync(path).mtimeMs < since - 1000) continue } catch { continue }
      if (read(path)?.includes(mark)) return true
    }
  }
  return false
}

/** `ok` undefined: the agent cannot be asked without its window, so it was not checked. */
export interface ProbeResult { readonly id: string; readonly name: string; readonly ok: boolean | undefined; readonly detail: string }

export interface ProbeOptions {
  readonly dataDirs: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  /** Runs the agent; resolves with its exit code (null when stopped) and the end of what it printed. */
  readonly run?: (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number | null; tail: string }>
}

function runAgent(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; tail: string }> {
  return new Promise(resolve => {
    let tail = ''
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-2000) }
    let child
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (error) { resolve({ code: null, tail: (error as Error).message }); return }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const stop = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, timeoutMs)
    child.on('error', error => { clearTimeout(stop); resolve({ code: null, tail: error.message }) })
    child.on('close', code => { clearTimeout(stop); resolve({ code, tail }) })
  })
}

/** Ask each agent to run the probe command, all at once, each in an empty folder of its own. */
export async function probeAgents(ids: readonly string[], options: ProbeOptions): Promise<ProbeResult[]> {
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? 180_000
  const run = options.run ?? runAgent
  return Promise.all(ids.map(async id => {
    const agent = AGENTS.find(candidate => candidate.id === id)!
    const mark = `tw${randomBytes(4).toString('hex')}`
    const command = `tokenwise probe ${mark}`
    const prompt = `Run this shell command exactly once and do nothing else: ${command}`
    const argv = probeCommand(id, prompt, command)
    if (!argv) return { id, name: agent.name, ok: undefined, detail: 'cannot be asked from here: run any command in it, then tokenwise doctor shows when it last saw one' }
    const cwd = mkdtempSync(join(tmpdir(), 'tokenwise-probe-'))
    const since = Date.now()
    try {
      const { code, tail } = await run(argv, cwd, { ...env, TOKENWISE_PROBE: mark }, timeoutMs)
      if (sawProbe(options.dataDirs, id, mark, since)) return { id, name: agent.name, ok: true, detail: 'TokenWise saw the command it ran' }
      const last = tail.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 160)
      const why = code === null ? `it did not finish within ${Math.round(timeoutMs / 1000)} s`
        : code !== 0 ? `it exited with code ${code}${last ? `: ${last}` : ''}`
        : 'it answered, but TokenWise saw no command from it'
      const hint = pluginState(id, env) === 'off' ? `TokenWise is not on in it: tokenwise setup ${id}` : agent.next
      return { id, name: agent.name, ok: false, detail: `${why}${hint ? ` (${hint})` : ''}` }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }))
}

/** The ids to probe: those named, else every agent on PATH that was set up. */
export function probeTargets(named: readonly string[], checks: readonly AgentCheck[]): string[] {
  if (named.length) return [...named]
  return checks.filter(check => check.installed && check.skill !== 'missing').map(check => check.id)
}

export const knownAgent = (id: string): boolean => AGENTS.some(agent => agent.id === id)
