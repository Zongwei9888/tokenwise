import { describe, expect, it } from 'vitest'
import { compileLearnedRules, nativeGrepRecords, sha256 } from '@tokenwise/core'
import type { LearnedRuleSet } from '@tokenwise/core'
import type { ArtifactPort, ArtifactRef, EconomyRecord, JournalRecord } from '@tokenwise/protocol'
import { DEFAULT_CONFIG } from '@tokenwise/store'
import { EconomyEngine, normalizeShellCommand, summarizeEconomy } from '../src/index.ts'
import type { EconomyEngineOptions } from '../src/index.ts'

class MemoryArtifacts implements ArtifactPort {
  readonly items = new Map<string, string>()
  fail = false
  save(text: string): ArtifactRef {
    if (this.fail) throw new Error('disk full')
    this.items.set(sha256(text), text)
    return { sha256: sha256(text), bytes: Buffer.byteLength(text) }
  }
  read(hash: string) { return this.items.get(hash) }
}

const grep = (n: number) => Array.from({ length: n }, (_, i) => `src/a.ts:${i + 1}:const value${i} = ${i}`).join('\n') + '\n'
const shell = (command: string, stdout: string) => ({ command, exitCode: 0, rendered: stdout, stdout: { start: 0, text: stdout } })

function setup(overrides: Partial<EconomyEngineOptions> = {}) {
  const records: JournalRecord[] = []
  const artifacts = new MemoryArtifacts()
  const engine = new EconomyEngine({ host: 'test', journal: { append: record => { records.push(record) } }, artifacts,
    config: DEFAULT_CONFIG.economy, mode: 'apply', delivery: 'in-process', streams: 'merged', now: () => new Date(0), ...overrides })
  return { engine, records, artifacts }
}

describe('EconomyEngine', () => {
  it('a running session takes up adopted learned rules from its next output, and lets them go when they are switched off', () => {
    const progress = Array.from({ length: 80 }, (_, i) => `[${i + 1}/80] Linking t${i}`).join('\n') + '\nLinked\n'
    const rules = compileLearnedRules([
      { path: 'index.json', text: JSON.stringify({ schemaVersion: 1, rules: [{ id: 'link', file: 'rules/link.js' }] }) },
      { path: 'rules/link.js', text: "defineRule({ project(input, tw) { return input.argv && input.argv[0] === './link.sh' ? tw.keepLines(input.raw, line => !/^\\[\\d+\\/\\d+\\] Linking /.test(line.text), n => '[' + n + ' link lines omitted]\\n') : null } })" },
    ])
    let active: LearnedRuleSet | undefined
    const { engine, records } = setup({ learned: () => active })
    try {
      const run = (callId: string) => engine.process({ sessionId: 's', callId, tool: 'bash', result: shell('./link.sh', progress) })
      expect(run('c1').text).toBeUndefined()
      active = rules
      expect(run('c2').text).toBe('Linked\n[80 link lines omitted]\n')
      expect(records.at(-1)).toMatchObject({ outcome: 'projected', rule: 'link', learnedRulesHash: rules.hash })
      active = undefined
      expect(run('c3').text).toBeUndefined()
    } finally { rules.dispose() }
  })

  it('runs a host tool\'s own result through the same save, journal and admission', () => {
    const { engine, records, artifacts } = setup()
    const rendered = Array.from({ length: 40 }, (_, i) => `packages/app/src/module.ts:${i + 1}: const value${i} = ${i}`).join('\n')
    const output = engine.process({ sessionId: 's', callId: 'c', tool: 'grep', command: 'grep {"pattern":"value"}', native: { rendered, projection: nativeGrepRecords(rendered) } })
    expect(output.text).toContain('[matches in packages/app/src/module.ts; every match retained]')
    expect(records).toMatchObject([{ outcome: 'projected', filter: 'native-grep', tool: 'grep', command: 'grep {"pattern":"value"}', exitCode: null }])
    expect(artifacts.read((records[0] as EconomyRecord).raw!.sha256)).toBe(rendered)
    const passed = engine.process({ sessionId: 's', callId: 'd', tool: 'grep', command: 'grep {}', native: { rendered: 'No matches found', projection: nativeGrepRecords('No matches found') } })
    expect(passed.text).toBeUndefined()
    expect(records[1]).toMatchObject({ outcome: 'passed', reason: 'no-filter-match', matchDetail: 'output-format-unrecognized' })
    const observe = setup({ mode: 'observe' })
    expect(observe.engine.process({ sessionId: 's', callId: 'e', tool: 'grep', command: 'grep {}', native: { rendered, projection: nativeGrepRecords(rendered) } }).text).toBeUndefined()
    expect(observe.records).toMatchObject([{ outcome: 'previewed', filter: 'native-grep' }])
  })

  it('stores the original and source map, journals, then releases the projection', () => {
    const { engine, records, artifacts } = setup()
    const raw = grep(200)
    const output = engine.process({ sessionId: 's', callId: 'c1', tool: 'bash', result: shell('grep -rn value src', raw) })
    expect(output.text).toBeDefined()
    expect(output.text!.length).toBeLessThan(raw.length)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record).toMatchObject({ type: 'economy/decision', outcome: 'projected', filter: 'grep', sessionId: 's', callId: 'c1', delivery: 'in-process' })
    if (record.type !== 'economy/decision') return
    expect(artifacts.read(record.raw!.sha256)).toBe(raw)
    expect(JSON.parse(artifacts.read(record.sourceMap!.sha256)!)).toMatchObject({ version: 1, sourceLength: raw.length })
    expect(record.projected!.sha256).toBe(sha256(output.text!))
  })
  it('keeps the original of a pass as evidence for tokenwise evolve, unless evidence is off', () => {
    const { engine, records, artifacts } = setup()
    const output = 'x\n'.repeat(500)
    expect(engine.process({ sessionId: null, callId: null, tool: 'bash', result: shell('my-tool', output) }).text).toBeUndefined()
    expect(records[0]).toMatchObject({ outcome: 'passed', reason: 'no-filter-match', matchDetail: 'command-not-covered', raw: { stored: true },
      layout: { stdout: { start: 0, length: output.length } } })
    expect(artifacts.read(sha256(output))).toBe(output)
    const off = setup({ config: { ...DEFAULT_CONFIG.economy, evidence: false } })
    off.engine.process({ sessionId: null, callId: null, tool: 'bash', result: shell('my-tool', output) })
    expect(off.records[0]).toMatchObject({ outcome: 'passed', raw: { stored: false } })
    expect(off.artifacts.items.size).toBe(0)
    // Nothing that looks like credentials is kept.
    const secrets = setup()
    for (const [command, text] of ([['cat .env', 'A=1\n'.repeat(100)], ['printenv', 'PATH=/bin\n'.repeat(100)], ['./show-config', `${'x\n'.repeat(100)}api_key = abcdef0123456789\n`],
      ['cat deploy.txt', `${'y\n'.repeat(100)}-----BEGIN OPENSSH PRIVATE KEY-----\n`]] as [string, string][])) {
      secrets.engine.process({ sessionId: 's', callId: command, tool: 'bash', result: shell(command, text) })
    }
    expect(secrets.records.map(record => (record as EconomyRecord).raw?.stored)).toEqual([false, false, false, false])
    expect(secrets.artifacts.items.size).toBe(0)
    // A host tool's own result is no evidence (learned rules see shell output only).
    const native = setup()
    native.engine.process({ sessionId: 's', callId: 'd', tool: 'grep', command: 'grep {}', native: { rendered: 'No matches found', projection: undefined } })
    expect(native.records[0]).toMatchObject({ raw: { stored: false } })
    expect(native.records[0]).not.toHaveProperty('layout')
  })
  it('previews without changing the result in observe mode', () => {
    const { engine, records, artifacts } = setup({ mode: 'observe', config: { ...DEFAULT_CONFIG.economy, evidence: false } })
    expect(engine.process({ sessionId: 's', callId: 'c', tool: 'bash', result: shell('grep -rn value src', grep(200)) }).text).toBeUndefined()
    expect(records[0]).toMatchObject({ outcome: 'previewed', filter: 'grep' })
    expect(artifacts.items.size).toBe(0)
  })
  it('fails open when the original cannot be saved or the decision cannot be journaled', () => {
    const broken = setup()
    broken.artifacts.fail = true
    expect(broken.engine.process({ sessionId: 's', callId: 'c', tool: 'bash', result: shell('grep -rn value src', grep(200)) }).text).toBeUndefined()
    expect(broken.records[0]).toMatchObject({ outcome: 'failed-open', reason: 'artifact-save-failed' })
    const noJournal = setup({ journal: { append: () => { throw new Error('read-only') } } })
    expect(noJournal.engine.process({ sessionId: 's', callId: 'c', tool: 'bash', result: shell('grep -rn value src', grep(200)) }).text).toBeUndefined()
  })
  it('pins one policy per session', () => {
    const { engine } = setup()
    const first = engine.policyFor('s')
    expect(engine.policyFor('s')).toBe(first)
    expect(engine.policyFor('t').policyHash).toBe(first.policyHash)
  })
})

describe('normalizeShellCommand and summaries', () => {
  it('journals rewrites and summarizes savings and uncovered commands', () => {
    const { engine, records } = setup()
    const journal = { append: (record: JournalRecord) => { records.push(record) } }
    expect(normalizeShellCommand({ host: 'test', journal }, { sessionId: 's', callId: 'c', tool: 'bash', command: 'rg value src' })).toBe('rg -n -H value src')
    expect(normalizeShellCommand({ host: 'test', journal }, { sessionId: 's', callId: 'c', tool: 'bash', command: 'ls' })).toBeUndefined()
    engine.process({ sessionId: 's', callId: 'c1', tool: 'bash', result: shell('grep -rn value src', grep(200)) })
    engine.process({ sessionId: 's', callId: 'c2', tool: 'bash', result: shell('terraform-like run', 'y\n'.repeat(100)) })
    engine.process({ sessionId: 's', callId: 'c3', tool: 'bash', result: shell('terraform-like run', 'y\n'.repeat(100)) })
    const summary = summarizeEconomy(records)
    expect(summary).toMatchObject({ decisions: 3, projected: 1, passed: 2, rewrites: 1 })
    expect(summary.savedTokens).toBeGreaterThan(0)
    expect(summary.byFilter[0]).toMatchObject({ filter: 'grep', count: 1 })
    expect(summary.uncovered[0]).toMatchObject({ command: 'terraform-like', count: 2 })
    // Every output seen counts toward the share, shortened or not.
    expect(summary.seenTokens).toBe(records.filter(r => r.type === 'economy/decision').reduce((n, r) => n + ((r as EconomyRecord).raw?.tokens ?? 0), 0))
  })
})

describe('prepare and commit', () => {
  it('saves the original at prepare time but journals only on commit', async () => {
    const { isPrepared } = await import('../src/index.ts')
    const { engine, records, artifacts } = setup()
    const prepared = engine.prepare({ sessionId: 's', callId: 'c', tool: 'bash', result: shell('grep -rn value src', grep(200)) })
    expect(isPrepared(prepared)).toBe(true)
    expect(records).toHaveLength(0)
    expect(artifacts.items.size).toBe(2)
    if (!isPrepared(prepared)) return
    expect(engine.commit(prepared).text).toBe(prepared.text)
    expect(records[0]).toMatchObject({ outcome: 'projected', callId: 'c' })
  })
})

describe('what the model reads', () => {
  // pytest -v with 300 passing tests and one failure: a lossy projection (noise removal).
  const pytest = [
    '============================= test session starts ==============================',
    'platform darwin -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0 -- /usr/bin/python3', 'cachedir: .pytest_cache', 'rootdir: /w',
    'collecting ... collected 301 items', '',
    ...Array.from({ length: 300 }, (_, i) => `tests/test_a.py::test_${i} PASSED${' '.repeat(30)}[${String(Math.floor(i * 100 / 301)).padStart(3)}%]`),
    `tests/test_a.py::test_bad FAILED${' '.repeat(22)}[100%]`, '',
    '=================================== FAILURES ===================================',
    '__________________________________ test_bad ___________________________________', '',
    '    def test_bad():', '>       assert 1 == 2', 'E       assert 1 == 2', '',
    'tests/test_a.py:3: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED tests/test_a.py::test_bad - assert 1 == 2',
    '========================= 1 failed, 300 passed in 0.12s =========================', '',
  ].join('\n')

  it('is the projection alone: TokenWise adds no text of its own, and the recall tool still reads the original', async () => {
    const { recallFromJournal } = await import('../src/index.ts')
    const { engine, records, artifacts } = setup({})
    const out = engine.process({ sessionId: 's', callId: 'c1', tool: 'bash', result: { ...shell('python3 -m pytest -v', pytest), exitCode: 1 } })
    expect(out.text).toBeDefined()
    expect(out.text).not.toContain('TokenWise')
    expect(out.text).not.toContain('[full output')
    expect(out.text!.trimEnd().endsWith('1 failed, 300 passed in 0.12s =========================')).toBe(true)
    const record = records.at(-1) as EconomyRecord
    expect(record.projected).toMatchObject({ bytes: Buffer.byteLength(out.text!) })
    // The ID a compaction's catalog gives it: the recall tool reads the complete original by it.
    const id = `o-${sha256(pytest).slice(0, 12)}`
    const recalled = recallFromJournal({ observation_id: id, query: 'test_250 PASSED' }, { host: 'test', sessionId: 's', artifacts, read: () => records })
    expect(recalled).toMatchObject({ ok: true })
    expect(recalled.text).toContain('tests/test_a.py::test_250 PASSED')
  })
})
