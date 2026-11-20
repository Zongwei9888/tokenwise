import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MechanismMode } from '@tokenwise/protocol'
import { createDshEconomy } from '../src/economy.ts'
import type { PostToolDecision, ToolExecution } from '../src/host.ts'
import { bashResult, pytestOutput } from './render.ts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-dsh-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const accept: PostToolDecision = { kind: 'accept' }
const exec = (command: string, extra: Partial<ToolExecution> = {}): ToolExecution =>
  ({ callId: 'call-1', name: 'bash', arguments: { command, description: 'run' }, agent: { session: { id: 'session-1', header: { cwd: '/nowhere' } } }, ...extra })

function setup(mode: MechanismMode = 'apply', env: NodeJS.ProcessEnv = {}) {
  const dataDir = temp()
  const warnings: string[] = []
  let current = mode
  const economy = createDshEconomy({ mode: () => current, dataDir, env, warn: message => warnings.push(message) })
  const journal = () => {
    const dir = join(dataDir, 'journal', 'dsh')
    try {
      return readdirSync(dir).flatMap(name => readFileSync(join(dir, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    } catch { return [] }
  }
  return { economy, dataDir, warnings, journal, setMode: (next: MechanismMode) => { current = next } }
}

const text = (decision: PostToolDecision) => (decision as { content?: { text: string }[] }).content?.[0]?.text

describe('DSH Token Economy', () => {
  it('replaces recognized output, keeps every marker, and journals the original', () => {
    const { economy, journal, dataDir } = setup()
    const result = bashResult({ stdout: pytestOutput(40, 2), stderr: 'DeprecationWarning: x\n', exitCode: 1 })
    const decision = economy.postExecute(exec('python -m pytest -v'), result, accept)
    const projected = text(decision)!
    expect(projected.length).toBeLessThan(result.content[0]!.text.length)
    expect(projected).toContain('FAILED tests/test_inventory.py::test_broken_1')
    expect(projected.endsWith('[stderr]\nDeprecationWarning: x\n[exit code: 1]')).toBe(true)
    const [record] = journal()
    expect(record).toMatchObject({ type: 'economy/decision', host: 'dsh', sessionId: 'session-1', callId: 'call-1', tool: 'bash',
      outcome: 'projected', filter: 'pytest', delivery: 'in-process', streams: 'separate', exitCode: 1 })
    const original = readFileSync(join(dataDir, 'artifacts', record.raw.sha256.slice(0, 2), `${record.raw.sha256}.txt`), 'utf8')
    expect(original).toBe(result.content[0]!.text)
  })
  it('only records in observe mode and does nothing when off', () => {
    const { economy, journal, setMode } = setup('observe')
    const result = bashResult({ stdout: pytestOutput(60) })
    expect(economy.postExecute(exec('pytest -v'), result, accept)).toBe(accept)
    expect(journal()).toMatchObject([{ outcome: 'previewed', mode: 'observe' }])
    setMode('off')
    expect(economy.postExecute(exec('pytest -v'), result, accept)).toBe(accept)
    expect(journal()).toHaveLength(1)
  })
  it('follows the live mode setting from one call to the next', () => {
    const { economy, setMode } = setup('off')
    const result = bashResult({ stdout: pytestOutput(60) })
    expect(text(economy.postExecute(exec('pytest -v'), result, accept))).toBeUndefined()
    setMode('apply')
    expect(text(economy.postExecute(exec('pytest -v'), result, accept))).toContain('60 passed')
  })
  it('lets TokenWise configuration and environment lower the plugin setting, never raise it', () => {
    const result = bashResult({ stdout: pytestOutput(60) })
    const configured = setup('apply')
    writeFileSync(join(configured.dataDir, 'config.json'), JSON.stringify({ output: { mode: 'observe' } }))
    expect(configured.economy.postExecute(exec('pytest -v'), result, accept)).toBe(accept)
    expect(configured.journal()).toMatchObject([{ outcome: 'previewed' }])
    for (const env of [{ TOKENWISE_DISABLE: '1' }, { TOKENWISE_OUTPUT: 'off' }]) {
      const disabled = setup('apply', env)
      expect(disabled.economy.postExecute(exec('pytest -v'), result, accept)).toBe(accept)
      expect(disabled.journal()).toEqual([])
    }
    const project = setup('observe')
    const cwd = temp()
    mkdirSync(join(cwd, '.tokenwise'))
    writeFileSync(join(cwd, '.tokenwise', 'config.json'), JSON.stringify({ output: { mode: 'apply' } }))
    const inProject = exec('pytest -v', { agent: { session: { id: 's2', header: { cwd } } } })
    expect(project.economy.postExecute(inProject, result, accept)).toBe(accept)
  })
  it('turns itself off on a broken configuration instead of guessing', () => {
    const { economy, dataDir, journal } = setup('apply')
    writeFileSync(join(dataDir, 'config.json'), '{ not json')
    expect(economy.postExecute(exec('pytest -v'), bashResult({ stdout: pytestOutput(60) }), accept)).toBe(accept)
    expect(journal()).toEqual([])
    expect(economy.report({ id: 'session-1', cwd: '/nowhere' })).toContain('config problem')
  })
  it('projects a Cargo build report kept on stderr', () => {
    const { economy } = setup()
    const compiling = Array.from({ length: 40 }, (_, i) => `   Compiling crate${i} v0.1.${i}`).join('\n')
    const stderr = `${compiling}\n    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 4.20s\n`
    const result = bashResult({ stdout: '', stderr })
    const projected = text(economy.postExecute(exec('cargo build'), result, accept))
    expect(projected).toBeDefined()
    expect(projected!.startsWith('[stderr]\n')).toBe(true)
    expect(projected).toContain('Finished')
  })
  it('leaves everything else alone', () => {
    const { economy, journal } = setup()
    const result = bashResult({ stdout: pytestOutput(60) })
    const cases: [ToolExecution, Parameters<typeof economy.postExecute>[1], PostToolDecision][] = [
      [exec('pytest -v', { name: 'pwsh' }), result, accept],
      [exec('pytest -v', { parent: 'run_code-token' }), result, accept],
      [exec('pytest -v'), { isError: true, content: result.content }, accept],
      [exec('pytest -v'), result, { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }],
      [exec('pytest -v'), result, { kind: 'accept', value: { replaced: true } }],
      [exec('pytest -v'), result, { kind: 'accept', content: [{ type: 'text', text: 'already rewritten by another plugin' }] }],
      [exec('pytest -v'), bashResult({ stdout: pytestOutput(60), stdoutTruncated: true }), accept],
      [exec('pytest -v'), bashResult({ stdout: pytestOutput(60), exitCode: null, signal: 'SIGTERM' }), accept],
      [exec('echo hello'), bashResult({ stdout: 'hello\n' }), accept],
    ]
    for (const [call, outcome, decision] of cases) expect(economy.postExecute(call, outcome, decision)).toBe(decision)
    expect(journal().every(record => record.outcome === 'passed')).toBe(true)
  })
  it('keeps contexts another listener attached', () => {
    const { economy } = setup()
    const additionalContexts = [{ role: 'user', content: [{ type: 'text', text: 'note' }] }]
    const decision = economy.postExecute(exec('pytest -v'), bashResult({ stdout: pytestOutput(60) }), { kind: 'accept', additionalContexts })
    expect(decision).toMatchObject({ kind: 'accept', additionalContexts })
    expect(text(decision)).toContain('60 passed')
  })
  it('delivers the original when the private store cannot be written', () => {
    const blocked = join(temp(), 'file')
    writeFileSync(blocked, '')
    const warnings: string[] = []
    const economy = createDshEconomy({ mode: () => 'apply', dataDir: join(blocked, 'home'), env: {}, warn: message => warnings.push(message) })
    expect(economy.postExecute(exec('pytest -v'), bashResult({ stdout: pytestOutput(60) }), accept)).toEqual(accept)
    expect(economy.postExecute(exec('pytest -v'), bashResult({ stdout: pytestOutput(60) }), accept)).toEqual(accept)
    // Each distinct problem is reported once, not once per tool call.
    expect(warnings.length).toBeGreaterThan(0)
    expect(new Set(warnings).size).toBe(warnings.length)
  })
  it('touches nothing on disk while off, /tokenwise included', () => {
    const home = join(temp(), 'tokenwise')
    const economy = createDshEconomy({ mode: () => 'off', dataDir: home, env: {} })
    expect(economy.postExecute(exec('pytest -v'), bashResult({ stdout: pytestOutput(60) }), accept)).toBe(accept)
    expect(economy.report({ id: 'session-1' })).toContain('economy: off')
    expect(existsSync(home)).toBe(false)
  })
  it('passes the original when even the projection is over DSH\'s inline budget, so DSH spills the complete text', () => {
    const dataDir = temp()
    const economy = createDshEconomy({ mode: () => 'apply', inlineLimitChars: 200, dataDir, env: {} })
    const result = bashResult({ stdout: pytestOutput(40, 2), exitCode: 1 })
    expect(economy.postExecute(exec('pytest -v'), result, accept)).toBe(accept)
    const roomy = createDshEconomy({ mode: () => 'apply', inlineLimitChars: 100_000, dataDir, env: {} })
    expect(text(roomy.postExecute(exec('pytest -v'), result, accept))).toContain('2 failed')
    const records = readdirSync(join(dataDir, 'journal', 'dsh')).flatMap(name => readFileSync(join(dataDir, 'journal', 'dsh', name), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    expect(records.map(record => [record.outcome, record.reason])).toEqual([['passed', 'over-host-inline-limit'], ['projected', undefined]])
  })
  it('picks up a changed configuration file without a restart', async () => {
    const { economy, dataDir, journal } = setup('apply')
    const result = bashResult({ stdout: pytestOutput(60) })
    expect(text(economy.postExecute(exec('pytest -v'), result, accept))).toContain('60 passed')
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ output: { mode: 'observe' } }))
    expect(economy.postExecute(exec('pytest -v'), result, accept)).toBe(accept)
    expect(journal().map(record => record.outcome)).toEqual(['projected', 'previewed'])
    rmSync(join(dataDir, 'config.json'))
    expect(text(economy.postExecute(exec('pytest -v'), result, accept))).toContain('60 passed')
  })
  it('never throws, whatever the harness hands it', () => {
    const { economy } = setup()
    const hostile = { get name(): string { throw new Error('boom') } } as unknown as ToolExecution
    expect(economy.postExecute(hostile, bashResult({ stdout: 'x' }), accept)).toBe(accept)
    const throwingMode = createDshEconomy({ mode: () => { throw new Error('volatile gone') }, dataDir: temp(), env: {} })
    expect(throwingMode.postExecute(exec('pytest -v'), bashResult({ stdout: pytestOutput(60) }), accept)).toBe(accept)
  })
  it('counts what in-process subagents saved in the parent\'s /tokenwise, grandchildren included', () => {
    const { economy, journal } = setup()
    const sessionOf = (id: string, header: Record<string, unknown>) => ({ agent: { session: { id, header: { cwd: '/nowhere', ...header } } } })
    const child = sessionOf('child-1', { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 })
    const grandchild = sessionOf('grandchild-1', { parentSession: 'child-1', origin: 'subagent', delegationDepth: 2 })
    for (const extra of [child, child, grandchild]) economy.postExecute(exec('pytest -v', extra), bashResult({ stdout: pytestOutput(60) }), accept)
    // One link per subagent session, kept under its parent.
    expect(journal().filter(record => record.type === 'session/subagent').map(record => [record.sessionId, record.childSessionId]))
      .toEqual([['child-1', 'grandchild-1'], ['parent', 'child-1']].sort())
    const report = economy.report({ id: 'parent' })
    expect(report).toContain('has not filtered any output in this session yet')
    expect(report).toMatch(/Its subagents \(2 sessions\) saved ~\S+ tokens \(3 of 3 outputs filtered\)/)
    expect(economy.report({ id: 'child-1' })).toMatch(/Its subagents \(1 session\) saved .* \(1 of 1 outputs filtered\)/)
  })
  it('does not count a conversation the user forked, and records no subagent while off', () => {
    const { economy, journal, setMode } = setup()
    const forked = { agent: { session: { id: 'forked', header: { cwd: '/nowhere', parentSession: 'parent' } } } }
    economy.postExecute(exec('pytest -v', forked), bashResult({ stdout: pytestOutput(60) }), accept)
    setMode('off')
    const child = { agent: { session: { id: 'child-off', header: { cwd: '/nowhere', parentSession: 'parent', origin: 'subagent' } } } }
    economy.postExecute(exec('pytest -v', child), bashResult({ stdout: pytestOutput(60) }), accept)
    expect(journal().filter(record => record.type === 'session/subagent')).toEqual([])
    expect(economy.report({ id: 'parent' })).not.toContain('subagents')
  })
  it('shortens DeepSeek Harness\'s own grep result and groups its glob paths, only when complete and untouched', () => {
    const { economy, journal } = setup()
    const matches = Array.from({ length: 30 }, (_, i) => ({ path: i < 20 ? 'packages/core/src/economy.ts' : 'README.md', lineNumber: i + 1, line: `  value ${i}` }))
    const rendered = 'Found 30 matches\n\n' + ['packages/core/src/economy.ts', 'README.md'].map(path =>
      `${path}\n${matches.filter(m => m.path === path).map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`).join('\n\n')
    const grep = (extra: Partial<ToolExecution> = {}) => ({ ...exec('', extra), name: 'grep', arguments: { pattern: 'value' } })
    const result = { isError: false as const, value: { matches }, content: [{ type: 'text' as const, text: rendered }] }
    const projected = text(economy.postExecute(grep(), result, accept))!
    expect(projected).toContain('packages/core/src/economy.ts\n1:   value 0\n2:   value 1')
    expect(projected.replace(/^(\d+): /gm, 'Line $1: ')).toBe(rendered)
    expect(journal().at(-1)).toMatchObject({ outcome: 'projected', filter: 'native-grep', tool: 'grep', command: 'grep {"pattern":"value"}', exitCode: null })
    // A capped result, one another listener rewrote, a nested call and an error stay exactly as they are.
    const capped = { ...result, content: [{ type: 'text' as const, text: rendered.replace('Found 30 matches', 'Found 20 of 30 matches') }] }
    expect(economy.postExecute(grep(), capped, accept)).toBe(accept)
    const rewritten: PostToolDecision = { kind: 'accept', content: [{ type: 'text', text: rendered }] }
    expect(economy.postExecute(grep(), result, rewritten)).toBe(rewritten)
    expect(economy.postExecute(grep({ parent: Symbol('run_code') }), result, accept)).toBe(accept)
    expect(economy.postExecute(grep(), { isError: true, content: result.content }, accept)).toBe(accept)
    const glob = { ...exec(''), name: 'glob', arguments: { pattern: '**/*.ts' } }
    const globbed = (paths: string[]) => text(economy.postExecute(glob, { isError: false, value: { paths }, content: [{ type: 'text', text: paths.join('\n') }] }, accept))
    const deep = [...Array.from({ length: 12 }, (_, i) => `packages/compaction/compaction-basic/src/module${i}.ts`), 'README.md']
    expect(globbed(deep)).toBe('[paths grouped by directory; original order retained]\npackages/compaction/compaction-basic/src/\n'
      + Array.from({ length: 12 }, (_, i) => `  module${i}.ts\n`).join('') + 'README.md')
    // Grouping a short list would not make it smaller.
    expect(globbed(['src/a/one.ts', 'src/a/two.ts', 'src/b/four.ts'])).toBeUndefined()
    // Other tools are not TokenWise's.
    const read = { ...exec(''), name: 'read', arguments: { path: 'x' } }
    expect(economy.postExecute(read, { isError: false, value: {}, content: [{ type: 'text', text: rendered }] }, accept)).toBe(accept)
  })
  it('reports savings and negotiation for /tokenwise', () => {
    const { economy } = setup()
    expect(economy.report({ id: 'session-1' })).toContain('has not filtered any output')
    economy.postExecute(exec('pytest -v'), bashResult({ stdout: pytestOutput(60) }), accept)
    const report = economy.report({ id: 'session-1' })
    expect(report).toMatch(/TokenWise saved ~\S+ tokens in this session \(1 of 1 outputs filtered\)/)
    expect(report).toContain('pytest: 1×')
    expect(report).toContain('economy: apply')
    expect(report).toContain('command-normalization: off')
    expect(economy.negotiated()[0]).toMatchObject({ mechanism: 'economy', mode: 'apply' })
  })
})

describe('DSH job_output: a background bash job read later', () => {
  /** A `job_output` read as DSH 0.2.1 renders it (tool-jobs render.ts): stdout, `[stderr]` and stderr, then the status line. */
  const jobRead = (out: string, err = '', status = 'completed', detail = 'exit code: 1', label = 'python -m pytest -v') => {
    const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
    const text = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
    const value = { text, job: { id: 'bash-0123456789abcdef', kind: 'bash', label, status, detail, startedAt: 1, finishedAt: 2 } }
    const body = text.length > 0 ? text : '(no new output)'
    return { isError: false as const, value, content: [{ type: 'text' as const, text: `${body}${body.endsWith('\n') ? '' : '\n'}[status: ${status}, ${detail}]` }] }
  }
  const read: ToolExecution = { callId: 'call-9', name: 'job_output', arguments: { job_id: 'bash-0123456789abcdef' }, agent: { session: { id: 'session-1', header: { cwd: '/nowhere' } } } }
  const setupJobs = (written: number | undefined) => {
    const dataDir = temp()
    const asked: unknown[] = []
    const economy = createDshEconomy({ mode: () => 'apply', dataDir, env: {}, jobOutputTotal: (id, exec) => { asked.push([id, exec.agent?.session?.id]); return written } })
    const journal = () => readdirSync(join(dataDir, 'journal', 'dsh')).flatMap(name => readFileSync(join(dataDir, 'journal', 'dsh', name), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    return { economy, journal, asked }
  }
  const out = pytestOutput(40, 2)
  const bytes = (value: string) => Buffer.byteLength(value)

  it('filters the whole output of a finished job as the command that started it, status line and stderr kept', () => {
    const { economy, journal, asked } = setupJobs(bytes(out))
    const result = jobRead(out)
    const projected = text(economy.postExecute(read, result, accept))!
    expect(projected.length).toBeLessThan(result.content[0]!.text.length / 2)
    expect(projected).toContain('FAILED tests/test_inventory.py::test_broken_1')
    expect(projected.endsWith('\n[status: completed, exit code: 1]')).toBe(true)
    expect(asked).toEqual([['bash-0123456789abcdef', 'session-1']])
    expect(journal()).toMatchObject([{ tool: 'job_output', command: 'python -m pytest -v', exitCode: 1, callId: 'call-9', outcome: 'projected', filter: 'pytest' }])
    // With stderr: both streams located, the stderr section kept byte for byte.
    const withErr = setupJobs(bytes(out) + bytes('DeprecationWarning: x\n'))
    const both = text(withErr.economy.postExecute(read, jobRead(out, 'DeprecationWarning: x\n'), accept))!
    expect(both.endsWith('[stderr]\nDeprecationWarning: x\n[status: completed, exit code: 1]')).toBe(true)
    expect(both.length).toBeLessThan(out.length / 2)
  })

  it('leaves alone a read that is not the whole output of a finished bash job', () => {
    const whole = bytes(out)
    const cases: [ReturnType<typeof setupJobs>, ReturnType<typeof jobRead>, PostToolDecision?][] = [
      [setupJobs(whole + 500), jobRead(out)], // part of it was read before
      [setupJobs(undefined), jobRead(out)], // the registry does not know the job
      [setupJobs(whole), jobRead(out, '', 'running', 'exit code: 1')],
      [setupJobs(whole), jobRead(out, '', 'killed', 'signal: SIGTERM')],
      [setupJobs(whole), jobRead(out, '', 'completed', 'exit code: 1; [sandbox: denied network]')],
      [setupJobs(whole), jobRead(`${out}[some output was dropped from memory; full output: /tmp/x.log]\n`)],
      [setupJobs(whole), jobRead(out, '', 'completed', 'exit code: 1', '')],
      [setupJobs(whole), jobRead(out), { kind: 'accept', content: [{ type: 'text', text: 'rewritten' }] }],
    ]
    for (const [{ economy }, result, decision = accept] of cases) expect(economy.postExecute(read, result, decision)).toBe(decision)
    // Without a job registry at all.
    const { economy } = setup()
    expect(economy.postExecute(read, jobRead(out), accept)).toBe(accept)
  })
})

describe('DSH: every other tool\'s text journaled', () => {
  it('journals a read (or any text result) unchanged; errors, sub-calls and TokenWise\'s own recall are not', () => {
    const { economy, journal } = setup()
    const read = (extra: Partial<ToolExecution> = {}): ToolExecution => ({ callId: 'r1', name: 'read', arguments: { file_path: 'a.ts' },
      agent: { session: { id: 'session-1', header: { cwd: '/nowhere' } } }, ...extra })
    const result = { isError: false as const, value: {}, content: [{ type: 'text' as const, text: '<path>a.ts</path>\n1: x' }] }
    expect(economy.postExecute(read(), result, accept)).toBe(accept)
    expect(economy.postExecute(read({ parent: {} }), result, accept)).toBe(accept)
    expect(economy.postExecute(read({ name: 'tokenwise_recall' }), result, accept)).toBe(accept)
    expect(economy.postExecute(read(), { isError: true, content: [{ type: 'text', text: 'no such file' }] }, accept)).toBe(accept)
    expect(journal().map(record => [record.tool, record.outcome, record.command])).toEqual([['read', 'passed', 'read {"file_path":"a.ts"}']])
  })
})
