import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256 } from '@tokenwise/core'
import { FileArtifactStore, FileJournal, RuleStore, removeTree } from '@tokenwise/store'
import { apply, testing } from '../src/index.ts'
import type { CommandRuntime, ConnectionRuntime, HostContext } from '../src/host.ts'
import { ROUTES, createDshLearning, dshCommand, providerEntries } from '../src/learning.ts'
import type { LearningPayload } from '../src/learning.ts'

const runner = fileURLToPath(new URL('../../../packages/mechanisms/test/fixtures/runner.ts', import.meta.url))
let home: string, work: string
const saved = process.env.TOKENWISE_HOME
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tokenwise-dsh-learn-'))
  work = mkdtempSync(join(tmpdir(), 'tokenwise-dsh-learner-'))
  process.env.TOKENWISE_HOME = home
})
afterEach(() => {
  if (saved === undefined) delete process.env.TOKENWISE_HOME
  else process.env.TOKENWISE_HOME = saved
  delete testing.learning
  removeTree(home)
  removeTree(work)
})

const progress = (seed: number) => Array.from({ length: 120 }, (_, i) => `[${String(i + 1).padStart(3)}/120] Compiling crate_${seed}_${i}`).join('\n') + '\nFinished\n'
function evidence() {
  for (const seed of [1, 2, 3]) {
    const output = progress(seed)
    new FileArtifactStore(home).save(output)
    new FileJournal(home).append({ schemaVersion: 1, type: 'economy/decision', time: new Date().toISOString(), host: 'dsh', sessionId: 'old', callId: `c${seed}`, tool: 'bash',
      command: './build.sh', exitCode: 0, delivery: 'in-process', streams: 'separate', mode: 'apply', outcome: 'passed', reason: 'no-filter-match', runtimeVersion: 'v', policyHash: 'p',
      raw: { sha256: sha256(output), bytes: output.length, tokens: Math.ceil(output.length / 4), stored: true }, layout: { stdout: { start: 0, length: output.length } } })
  }
}
function learnerScript() {
  const script = join(work, 'learner.sh')
  writeFileSync(script, `mkdir -p rules-work/rules
echo '{ "schemaVersion": 1, "rules": [{ "id": "compile-progress", "file": "rules/compile-progress.js", "transformation": "noise-removal" }] }' > rules-work/index.json
cat > rules-work/rules/compile-progress.js <<'JS'
defineRule({ project(input, tw) {
  if (!input.argv || input.argv[0] !== './build.sh') return null
  return tw.keepLines(input.raw, line => !/^\\[\\s*\\d+\\/\\d+\\] Compiling /.test(line.text), n => '[' + n + ' compile lines omitted]\\n')
} })
JS
./check
`)
  return script
}

function mount() {
  const routes = new Map<string, Parameters<ConnectionRuntime['fetch']['register']>[0]>()
  const commands: Parameters<CommandRuntime['register']>[0][] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const ctx: HostContext = {
    on: ((name: string, listener: (...args: unknown[]) => unknown) => { listeners.set(name, listener); return () => {} }) as HostContext['on'],
    inject: (_deps, callback) => callback({ ...ctx, commands: { register: definition => { commands.push(definition); return () => {} } },
      connection: { fetch: { register: route => { routes.set(route.path, route); return async () => {} } } } }),
    effect: execute => { execute() },
    logger: { warn: () => {}, info: () => {} },
    get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }) } : undefined,
  }
  apply(ctx, { mode: { get: () => 'apply' }, inlineLimitChars: 48_000 })
  const call = async (path: string, init?: RequestInit) => {
    const route = routes.get(path)!
    expect(route.methods).toContain(init?.method ?? 'GET')
    const response = await route.fetch(new Request(`http://dsh.local${path}`, init))
    expect(response.headers.get('content-type')).toBe('application/json')
    return response.json() as Promise<Record<string, unknown>>
  }
  const post = (path: string, body?: unknown) => call(path, { method: 'POST', ...body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } })
  const command = (rawInput: string) => commands[0]!.handler({ agent: { session: { id: 's1' } }, rawInput }) as { text: string }
  return { routes, call, post, command, listeners }
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

describe('what a DSH conversation saved', () => {
  it('reaches that conversation\'s page once after a turn that saved more, never another page, a subagent or a restart', async () => {
    const decision = (sessionId: string, raw: number, read: number, outcome = 'projected') => new FileJournal(home).append({ schemaVersion: 1, type: 'economy/decision',
      time: new Date().toISOString(), host: 'dsh', sessionId, callId: 'c', tool: 'bash', command: 'pytest', exitCode: 1, delivery: 'in-process', streams: 'separate', mode: 'apply',
      outcome, runtimeVersion: 'v', policyHash: 'p', raw: { sha256: 'a', bytes: raw * 4, tokens: raw, stored: true }, ...outcome === 'projected' ? { projected: { sha256: 'b', bytes: read * 4, tokens: read } } : {} } as never)
    decision('s1', 3000, 300); decision('s1', 1000, 1000, 'passed'); decision('s2', 800, 200); decision('sub', 5000, 100)
    let host = mount()
    const turnEnd = (id: string, origin?: string) => host.listeners.get('session/event')!({ id, header: origin ? { origin } : {} }, { type: 'turn/end', data: { turn: 1 } })
    const saved = async (sessionId?: string) => (await host.post(ROUTES.saved, sessionId === undefined ? {} : { sessionId })).saved
    turnEnd('sub', 'subagent')
    host.listeners.get('session/event')!({ id: 's1', header: {} }, { type: 'step/end', data: {} })
    expect(await saved('sub')).toBeNull()
    expect(await saved('s1')).toBeNull()
    turnEnd('s1')
    // Only s1's own page hears of s1; the learning toast never carries it.
    expect(await saved('s2')).toBeNull()
    expect(await saved()).toBeNull()
    expect(await host.post(ROUTES.announcement)).toEqual({ run: null, ready: null })
    expect(await saved('s1')).toEqual({ savedTokens: 2700, seenTokens: 4000 })
    expect(await saved('s1')).toBeNull()
    turnEnd('s1')
    expect(await saved('s1')).toBeNull()
    // Told is kept on disk: a restarted Host does not say it again, but says s2's.
    host = mount()
    turnEnd('s1'); turnEnd('s2')
    expect(await saved('s1')).toBeNull()
    expect(await saved('s2')).toEqual({ savedTokens: 600, seenTokens: 800 })
  })
})

describe('DSH self-evolution routes', () => {
  it('tells the browser once when recorded output is worth learning from', async () => {
    evidence()
    testing.learning = { runner, runnerNodeArgs: ['--conditions=source'], learner: () => ({ argv: ['true'], shell: true, label: 'DSH · test' }) }
    const host = mount()
    // The first poll starts a scan in its own process; a later poll reports what it found, once.
    const notice = await until(async () => {
      const value = await host.post(ROUTES.announcement) as { run: unknown; ready: { command: string; cases: number }[] | null }
      expect(value.run).toBeNull()
      return value.ready ?? undefined
    })
    expect(notice).toEqual([expect.objectContaining({ command: './build.sh', cases: 3 })])
    expect(await host.post(ROUTES.announcement)).toEqual({ run: null, ready: null })
  })

  it('serves status, starts a run, follows it to adoption, and announces it once', async () => {
    evidence()
    testing.learning = { runner, runnerNodeArgs: ['--conditions=source'], learner: () => ({ argv: [`sh ${learnerScript()}`], shell: true, label: 'DSH · test' }) }
    const host = mount()
    expect([...host.routes.keys()].sort()).toEqual(Object.values(ROUTES).sort())
    const first = await host.call(ROUTES.status) as unknown as LearningPayload
    expect(first).toMatchObject({ learner: { label: 'DSH · test' }, learnedRulesOff: false, evolve: { rules: { active: null } } })

    expect(await host.post(ROUTES.learn)).toMatchObject({ ok: true, runId: expect.any(String) })
    expect(await host.post(ROUTES.learn)).toEqual({ ok: false, error: 'running' })
    const done = await until(async () => {
      const payload = await host.call(ROUTES.status) as unknown as LearningPayload
      return payload.evolve.run?.phase === 'done' ? payload : undefined
    })
    expect(done.evolve.run).toMatchObject({ host: 'dsh', learner: 'DSH · test', outcome: { result: 'adopted', rules: ['compile-progress'] } })
    expect(done.evolve.rules.rules).toEqual([{ id: 'compile-progress', transformation: 'noise-removal' }])
    expect(await host.post(ROUTES.announcement)).toMatchObject({ run: { outcome: { result: 'adopted' } } })
    // The scan from before the run counted the evidence it just learned from: no "worth learning" notice.
    expect(await host.post(ROUTES.announcement)).toEqual({ run: null, ready: null })

    // Switching off and on, and rolling back, as the page's controls do.
    expect(await host.post(ROUTES.rules, { action: 'off' })).toEqual({ ok: true, active: null })
    expect(await host.post(ROUTES.rules, { action: 'on' })).toMatchObject({ ok: true, active: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(host.command(' rules').text).toContain('compile-progress')
    expect(await host.post(ROUTES.rules, { action: 'rollback' })).toEqual({ ok: true, active: null })
    expect(new RuleStore(home).state().active).toBeNull()
    expect(await host.post(ROUTES.rules, { action: 'bogus' })).toEqual({ ok: false, active: null })
    expect(await host.post(ROUTES.cancel)).toEqual({ ok: false })
  }, 60_000)

  it('/tokenwise learn starts a run, and the report still answers plain /tokenwise', async () => {
    evidence()
    testing.learning = { runner, runnerNodeArgs: ['--conditions=source'], learner: () => ({ argv: ['sleep 30'], shell: true, label: 'DSH · slow' }) }
    const host = mount()
    expect(host.command(' learn').text).toContain('learning output rules in the background')
    expect(host.command(' learn').text).toContain('a learning run is already in progress')
    await until(async () => ((await host.call(ROUTES.status)) as unknown as LearningPayload).evolve.run?.phase === 'learning' ? true : undefined)
    expect(host.command('').text).toContain('TokenWise has not filtered any output in this session yet')
    expect(host.command(' cancel').text).toBe('Stopping the learning run.')
    const run = await until(async () => {
      const payload = await host.call(ROUTES.status) as unknown as LearningPayload
      return payload.evolve.run?.phase === 'done' ? payload.evolve.run : undefined
    })
    expect(run.outcome).toEqual({ result: 'cancelled' })
  }, 60_000)

  it('runs the learner as DSH headless with the user\'s default model', () => {
    const anchor = join(work, 'dsh', 'package.json')
    mkdirSync(join(work, 'dsh', 'lib'), { recursive: true })
    writeFileSync(anchor, '{}')
    writeFileSync(join(work, 'dsh', 'lib', 'bin.js'), '')
    expect(dshCommand({ PATH: '' }, anchor)).toEqual([process.execPath, join(work, 'dsh', 'lib', 'bin.js')])
    expect(dshCommand({ PATH: '' }, undefined)).toBeUndefined()
    const learning = createDshLearning({ configDir: home, env: { PATH: '' }, installAnchor: () => anchor,
      selection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }) })
    // Polling the status writes nothing; a start writes the overlay for that run.
    expect(learning.learner()).toMatchObject({ label: 'DSH · deepseek-v4-pro',
      argv: [process.execPath, join(work, 'dsh', 'lib', 'bin.js'), '--profile', 'headless', expect.stringContaining('PROMPT.md')] })
    const learner = learning.learner(true) as unknown as { argv: string[]; cleanup: string[] }
    expect(learner.argv.slice(2, 5)).toEqual(['--profile', 'headless', '--patch'])
    expect(learner.cleanup).toEqual([learner.argv[5]])
    expect(learner.argv[5]).toMatch(new RegExp(`^${join(home, 'evolve')}/dsh-learner\\.[0-9a-f]{8}\\.patch\\.yml$`))
    expect(createDshLearning({ configDir: home, env: { PATH: '' } }).learner()).toEqual({ unavailable: 'no-dsh' })
  })

  it('carries the profile\'s own providers into the learner\'s overlay', () => {
    const patch = `- id: llm-pi-ai
  config:
    providers:
      mock:
        apiKeyEnv: MOCK_LLM_API_KEY
        baseURL: http://127.0.0.1:9/v1
- id: agent-default-model
  config:
    provider: mock
    model: mock-model
- id: workspace-controller
  config:
    documentsDirectory: /tmp/docs
`
    expect(providerEntries(patch)).toBe(patch.split('- id: agent-default-model')[0])
    expect(providerEntries('- id: other\n')).toBe('')
    const anchor = join(work, 'dsh', 'package.json')
    mkdirSync(join(work, 'dsh', 'lib'), { recursive: true })
    writeFileSync(anchor, '{}')
    writeFileSync(join(work, 'dsh', 'lib', 'bin.js'), '')
    writeFileSync(join(work, 'profile.patch.yml'), patch)
    const written = createDshLearning({ configDir: home, env: { PATH: '' }, installAnchor: () => anchor, patchPath: () => join(work, 'profile.patch.yml'),
      selection: () => ({ provider: 'mock', model: 'mock-model' }) }).learner(true) as { cleanup: string[] }
    expect(readFileSync(written.cleanup[0]!, 'utf8')).toBe(`${providerEntries(patch)}- id: agent-default-model
  config:
    provider: "mock"
    model: "mock-model"
`)
  })
})
