import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-learn-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tokenwise(args: string[], home: string, input?: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--conditions=source', main, ...args], { input, encoding: 'utf8',
    env: { ...process.env, TOKENWISE_HOME: home, TOKENWISE_DISABLE: '', ...env } })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

const startup = (home: string, host = 'claude', env: NodeJS.ProcessEnv = {}) =>
  tokenwise(['hook', host], home, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's' }), env).out

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

describe('tokenwise learn', () => {
  it('needs a learner it knows', () => {
    const home = temp()
    expect(tokenwise(['learn'], home)).toMatchObject({ status: 2, err: expect.stringContaining('--learner pi|dsh|claude|codex|codebuddy|grok') })
    expect(tokenwise(['learn', '--learner', 'vim'], home).status).toBe(2)
    expect(tokenwise(['learn', 'later'], home).status).toBe(2)
  })

  it('asks to run outside the sandbox when the learner could not write its own state', () => {
    const home = temp(), dshHome = temp()
    chmodSync(dshHome, 0o500)
    try {
      const result = tokenwise(['learn', '--learner', 'dsh'], home, undefined, { DSH_HOME: dshHome })
      expect(result.status).toBe(1)
      expect(result.err).toMatch(/^tokenwise: could not write .*\.tokenwise-write-check-\d+ \((EACCES|EPERM)\)\. This agent seems to run commands in a sandbox/u)
      expect(tokenwise(['learn', 'status'], home).out).toContain('No learning run yet.')
    } finally { chmodSync(dshHome, 0o700) }
  })

  it('runs in the background, and status follows it to the end', async () => {
    const home = temp()
    const started = tokenwise(['learn', '--learner', 'claude'], home)
    expect(started).toMatchObject({ status: 0, out: expect.stringContaining('Learning with claude in the background') })
    // With no recorded output there is nothing to learn from; the run ends before any learner starts.
    let status = ''
    for (let i = 0; i < 100 && !status.includes('Last run'); i++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      status = tokenwise(['learn', 'status'], home).out
    }
    expect(status).toContain('Last run (claude, ')
    expect(status).toContain('nothing to learn from yet')
    expect(status).toContain('No learned rules in use.')
    expect(tokenwise(['learn', 'cancel'], home).out).toBe('No learning run in progress.\n')
  }, 30_000)
})

describe('the startup notice', () => {
  it('says once when recorded output is worth learning from, naming the host\'s own command', () => {
    const home = temp()
    const opportunities = [{ command: './deploy.sh', cases: 5, leftTokens: 9000 }, { command: 'make', cases: 4, leftTokens: 3000 }]
    writeJson(join(home, 'evolve', 'scan.json'), { schemaVersion: 1, time: new Date().toISOString(), evidence: 9, newEvidence: 9, leftTokens: 12000,
      opportunities, ready: true, rules: [], disabled: [] })
    expect(JSON.parse(startup(home))).toEqual({ systemMessage: 'TokenWise: output from ./deploy.sh, make keeps coming back long. '
      + 'Teach TokenWise about it with /tokenwise, or let it learn in the background with /tokenwise:learn.' })
    expect(startup(home)).toBe('')
    expect(JSON.parse(startup(home, 'codex')).systemMessage).toContain('with $tokenwise, or let it learn in the background with $tokenwise learn.')
    // Copilot CLI shows a hook's progress line; its sessionStart has no event name, and `new` is a start in `copilot -p`.
    const copilot = (source: string) => tokenwise(['hook', 'copilot'], home, JSON.stringify({ sessionId: 'c', timestamp: 1, cwd: '/w', source })).out
    expect(copilot('resume')).toBe('')
    expect(JSON.parse(copilot('new'))).toEqual({ type: 'progress', message: 'TokenWise: output from ./deploy.sh, make keeps coming back long. Teach TokenWise about it with /tokenwise.' })
    expect(copilot('startup')).toBe('')
    // A learner's own session says nothing.
    expect(startup(home, 'grok', { TOKENWISE_DISABLE: '1' })).toBe('')
    // Grok calls a new session's start `new` (seen from Grok 1.0.70), and a resumed one is not a start. It shows a
    // SessionStart message only on reopening, so the notice waits for the end of the first turn, once.
    const grok = (event: object) => tokenwise(['hook', 'grok'], home, JSON.stringify({ session_id: 'g', ...event })).out
    const stop = { hookEventName: 'stop', hook_event_name: 'Stop', reason: 'end_turn' }
    expect(grok({ hookEventName: 'session_start', hook_event_name: 'SessionStart', source: 'resume' })).toBe('')
    // A session closed before its first turn ended leaves the notice for the next one.
    expect(tokenwise(['hook', 'grok'], home, JSON.stringify({ session_id: 'closed', hookEventName: 'session_start', hook_event_name: 'SessionStart', source: 'new' })).out).toBe('')
    expect(grok({ hookEventName: 'session_start', hook_event_name: 'SessionStart', source: 'new' })).toBe('')
    expect(grok({ ...stop, reason: 'user_interrupt' })).toBe('')
    expect(JSON.parse(grok(stop)).systemMessage).toContain('with /tokenwise, or let it learn in the background with /tokenwise:learn.')
    expect(grok(stop)).toBe('')
  }, 60_000) // Fourteen CLI processes.

  it('reaches OpenCode and Hermes through `tokenwise notice`, without a learn command they cannot run', () => {
    const home = temp()
    writeJson(join(home, 'evolve', 'scan.json'), { schemaVersion: 1, time: new Date().toISOString(), evidence: 9, newEvidence: 9, leftTokens: 9000,
      opportunities: [{ command: './deploy.sh', cases: 5, leftTokens: 9000 }], ready: true, rules: [], disabled: [] })
    // --peek leaves it to be told, --told marks it told without printing.
    const said = 'TokenWise: output from ./deploy.sh keeps coming back long. Teach TokenWise about it with @tokenwise.\n'
    expect(tokenwise(['notice', 'opencode', '--peek'], home)).toMatchObject({ status: 0, out: said })
    expect(tokenwise(['notice', 'opencode', '--peek'], home).out).toBe(said)
    expect(tokenwise(['notice', 'opencode', '--told'], home).out).toBe('')
    expect(tokenwise(['notice', 'opencode'], home).out).toBe('')
    expect(tokenwise(['notice', 'hermes'], home).out).toContain('Teach TokenWise about it with /tokenwise.\n')
    // An unknown agent, or none, says nothing and never fails.
    expect(tokenwise(['notice', 'vim'], home)).toMatchObject({ status: 0, out: '' })
    expect(tokenwise(['notice'], home)).toMatchObject({ status: 0, out: '' })
  }, 60_000)

  it('says once how a learning run ended', () => {
    const home = temp()
    writeJson(join(home, 'evolve', 'status.json'), { schemaVersion: 1, runId: 'r1', host: 'cli', learner: 'claude', pid: 999999, startedAt: '2026-10-30T10:00:00.000Z',
      phase: 'done', finishedAt: '2026-10-30T10:05:00.000Z', outcome: { result: 'rejected', reasons: ['did-not-generalize'] } })
    expect(JSON.parse(startup(home, 'codebuddy')).systemMessage).toBe('TokenWise learning: nothing adopted: they only fit the examples the learner saw.')
    expect(startup(home, 'codebuddy')).toBe('')
    // An adoption is news about the project: what is shorter now, and where to see it.
    writeJson(join(home, 'evolve', 'status.json'), { schemaVersion: 1, runId: 'r2', host: 'cli', learner: 'claude', pid: 999999, startedAt: '2026-10-30T11:00:00.000Z',
      phase: 'done', finishedAt: '2026-10-30T11:05:00.000Z', outcome: { result: 'adopted', rules: ['make-progress'], changes: { added: ['make-progress'], changed: [], removed: [] },
        generalization: { status: 'confirmed', commands: ['make e2e'], heldOutCases: 3, heldOutGain: 900 } } })
    expect(JSON.parse(startup(home, 'codex')).systemMessage).toBe('TokenWise learned something about your project: output from make e2e is now shorter for every agent. '
      + 'See the before and after with $tokenwise.')
    // Not after a compaction: that SessionStart belongs to the catalog.
    expect(tokenwise(['hook', 'claude'], home, JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 's', transcript_path: '/nope' })).out).toBe('')
  })
})
