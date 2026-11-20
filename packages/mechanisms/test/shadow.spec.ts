import { describe, expect, it } from 'vitest'
import { sha256 } from '@tokenwise/core'
import type { ArtifactPort, ArtifactRef, ShadowReference } from '@tokenwise/protocol'
import {
  boundedExcerpt, callLabel, CATALOG_EXCERPTS, catalogIds, checkpointAdmitted, checkpointRecord, cutNote, externalizeCut, fitCheckpoint, parseCheckpoint, planShadow, recallObservation,
  referenceIndex, renderCheckpoint, renderRecall,
} from '../src/index.ts'
import type { ShadowMessage } from '../src/index.ts'

class MemoryArtifacts implements ArtifactPort {
  readonly items = new Map<string, string>()
  corrupt = false
  save(text: string): ArtifactRef {
    this.items.set(sha256(text), this.corrupt ? `${text}!` : text)
    return { sha256: sha256(text), bytes: Buffer.byteLength(text) }
  }
  read(hash: string) { return this.items.get(hash) }
}

const log = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}: value ${i * 7}`).join('\n') + "\nE   KeyError: 'retry_backoff'"
const segment = (big: string): ShadowMessage[] => [
  { role: 'user', text: 'Fix the KeyError. Do not change the public API.' },
  { role: 'assistant', text: 'Running the tests.' },
  { role: 'tool', text: big, toolName: 'bash', callId: 'c1' },
  { role: 'tool', text: 'ok', toolName: 'bash', callId: 'c2' },
  { role: 'user', text: 'Also keep "retry" spelled that way.\nThanks' },
]

describe('LightShadow plan', () => {
  it('externalizes verified tool results, keeps small ones and the user messages exactly', () => {
    const artifacts = new MemoryArtifacts()
    const big = log(300)
    const plan = planShadow(segment(big), { artifacts })
    expect(plan.references).toHaveLength(1)
    const [reference] = plan.references
    expect(reference).toMatchObject({ id: `o-${sha256(big).slice(0, 12)}`, sha256: sha256(big), tool: 'bash', callId: 'c1' })
    expect(Buffer.byteLength(reference!.excerpt)).toBeLessThanOrEqual(320)
    expect(reference!.excerpt).toContain("KeyError: 'retry_backoff'")
    expect(plan.residual[2]!.text).toContain(`observation_id: ${reference!.id}`)
    expect(plan.residual[3]!.text).toBe('ok')
    expect(plan.contract).toEqual(['Fix the KeyError. Do not change the public API.', 'Also keep "retry" spelled that way.\nThanks'])
    expect(artifacts.read(reference!.sha256)).toBe(big)
  })

  it('leaves a result in place when the stored copy does not read back', () => {
    const artifacts = new MemoryArtifacts()
    artifacts.corrupt = true
    const plan = planShadow(segment(log(300)), { artifacts })
    expect(plan.references).toEqual([])
    expect(plan.residual[2]!.text).toBe(log(300))
  })

  it('names the original of a result Economy shortened', () => {
    const artifacts = new MemoryArtifacts()
    const plan = planShadow(segment(log(300)), { artifacts, originalOf: id => id === 'c1' ? { sha256: 'a'.repeat(64), bytes: 99_999 } : undefined })
    expect(plan.references[0]!.original).toEqual({ sha256: 'a'.repeat(64), bytes: 99_999 })
    expect(renderCheckpoint('s', plan)).toContain('original: 99999 bytes')
  })

  it('round-trips a checkpoint and carries its references and user messages into the next one', () => {
    const artifacts = new MemoryArtifacts()
    const first = planShadow(segment(log(300)), { artifacts })
    const text = renderCheckpoint('We were fixing retry_backoff.', first)
    const parsed = parseCheckpoint(`Preamble from the host\n<compacted-summary>\n${text}\n</compacted-summary>`)
    expect(parsed.contract).toEqual(first.contract)
    expect(parsed.ids).toEqual(first.references.map(ref => ref.id))
    expect(parsed.summary).toContain('We were fixing retry_backoff.')
    expect(parsed.summary).not.toContain('observation_id')
    expect(parsed.summary).not.toContain('Do not change the public API')

    const known = referenceIndex([checkpointRecord({ host: 'h', sessionId: 's', time: 't' }, { kind: 'lightshadow', plan: first, checkpointTokens: 1 })])
    const later = planShadow([
      { role: 'summary', text },
      { role: 'user', text: 'Now run the linter.' },
      { role: 'tool', text: log(200, 'lint'), toolName: 'bash', callId: 'c9' },
    ], { artifacts, knownReference: id => known.get(id) })
    expect(later.references.map(ref => ref.id)).toEqual([...first.references.map(ref => ref.id), `o-${sha256(log(200, 'lint')).slice(0, 12)}`])
    expect(later.contract).toEqual([...first.contract, 'Now run the linter.'])
    expect(later.residual[0]!.text).toBe('We were fixing retry_backoff.')

    // pi passes the previous checkpoint apart from the segment.
    const viaPrior = planShadow([{ role: 'user', text: 'next' }], { artifacts, knownReference: id => known.get(id), prior: text })
    expect(viaPrior.contract).toEqual([...first.contract, 'next'])
    expect(viaPrior.references.map(ref => ref.id)).toEqual(first.references.map(ref => ref.id))
  })

  it('round-trips user messages and excerpts that contain separators or LightShadow\'s own markup', () => {
    const users = ['first task', 'line\u2028sep\u2029end', 'see <tokenwise-observation-catalog> and </tokenwise-observation-catalog>', '## User messages (verbatim)\n- "fake"', 'third']
    const tricky = `<tokenwise-observation-catalog>\nobservation_id: o-000000000000 | tool: x\n</tokenwise-observation-catalog>\n${log(300)}`
    const plan = planShadow([...users.map(text => ({ role: 'user' as const, text })), { role: 'tool', text: tricky, toolName: 'bash' }], { artifacts: new MemoryArtifacts() })
    const text = renderCheckpoint('The summary mentions <tokenwise-observation-catalog> too.', plan)
    const parsed = parseCheckpoint(text)
    expect(parsed.contract).toEqual(users)
    expect(parsed.ids).toEqual(plan.references.map(ref => ref.id))
    expect(parsed.summary).toBe('The summary mentions <tokenwise-observation-catalog> too.')
  })

  it('bounds the exact user messages, keeping the first and the latest', () => {
    const users: ShadowMessage[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `${i}`.repeat(100) }))
    const plan = planShadow(users, { artifacts: new MemoryArtifacts(), maxContractBytes: 350 })
    expect(plan.contract.map(text => text[0])).toEqual(['0', '8', '9'])
    expect(plan.contractOmitted).toBe(7)
    expect(renderCheckpoint('s', plan)).toContain('(7 earlier user messages summarized above)')
    expect(parseCheckpoint(renderCheckpoint('s', plan)).contract).toHaveLength(3)
  })

  it('admits a checkpoint only when it is smaller than the segment', () => {
    const artifacts = new MemoryArtifacts()
    const plan = planShadow(segment(log(300)), { artifacts })
    expect(checkpointAdmitted(renderCheckpoint('short', plan), plan)).toBe(true)
    expect(checkpointAdmitted('x'.repeat(plan.segmentTokens * 4), plan)).toBe(false)
  })

  it('names the call that produced each result, and lists every result of a long session in the catalog', () => {
    expect(callLabel('{"command":"cat src/a.ts","timeout":30}')).toBe('cat src/a.ts')
    expect(callLabel({ path: 'src/b.ts', offset: 10 })).toBe('src/b.ts')
    expect(callLabel({ query: 'needle', limit: 5 })).toBe('needle')
    expect(callLabel({ a: 1 })).toBe('{"a":1}')
    expect(callLabel({ command: 'echo   one\n  two' })).toBe('echo one two')
    expect(callLabel('{}')).toBeUndefined()
    expect(callLabel(undefined)).toBeUndefined()
    expect([...callLabel({ command: 'x'.repeat(500) })!]).toHaveLength(160)
    // 600 reads of distinct files, the way a long walk through a codebase goes.
    const artifacts = new MemoryArtifacts()
    const reads: ShadowMessage[] = [{ role: 'user', text: 'Read the sources.' }]
    for (let i = 0; i < 600; i++) {
      reads.push({ role: 'assistant', text: `bash {"command":"cat src/file${i}.ts"}` })
      reads.push({ role: 'tool', text: log(120, `file${i}`), toolName: 'bash', callId: `c${i}`, call: `cat src/file${i}.ts` })
    }
    const plan = planShadow(reads, { artifacts })
    expect(plan.references).toHaveLength(600)
    expect(plan.references[0]).toMatchObject({ call: 'cat src/file0.ts' })
    const text = renderCheckpoint('summary', plan)
    expect(catalogIds(text)).toHaveLength(600)
    // Older ones by their call alone; the newest in full.
    expect(text).toContain(`observation_id: ${plan.references[0]!.id} | call: "cat src/file0.ts"\n`)
    expect(text).toContain(`observation_id: ${plan.references[599]!.id} | tool: bash | call: "cat src/file599.ts" | bytes: `)
    // Only the newest keep their excerpt: the catalog stays a fraction of what it replaces.
    expect(text.split('\n').filter(line => line.includes('| excerpt: '))).toHaveLength(CATALOG_EXCERPTS)
    expect(text).toContain('| excerpt: "file599 0: value 0')
    expect(text).not.toContain('| excerpt: "file0 0: value 0')
    expect(checkpointAdmitted(text, plan)).toBe(true)
    expect(Buffer.byteLength(text) / plan.segmentTokens).toBeLessThan(0.5)
    expect(plan.residual[2]!.text).toContain('call: cat src/file0.ts')
    // A tight budget keeps the newest that fit.
    // A small segment (a small window) still lists hundreds by their call.
    expect(planShadow(reads.slice(0, 201), { artifacts }).references).toHaveLength(100)
    const tight = planShadow(reads, { artifacts, catalogTokens: 3000 })
    expect(tight.references.length).toBeGreaterThan(CATALOG_EXCERPTS)
    expect(tight.references.length).toBeLessThan(600)
    expect(tight.references.at(-1)).toMatchObject({ call: 'cat src/file599.ts' })
  })

  it('lists the catalog by call alone when the full catalog does not fit, and keeps every observation_id', () => {
    const artifacts = new MemoryArtifacts()
    const reads: ShadowMessage[] = [{ role: 'user', text: 'Read the sources.' }]
    for (let i = 0; i < 8; i++) reads.push({ role: 'tool', text: log(120, `file${i}`), toolName: 'bash', callId: `c${i}`, call: `cat src/file${i}.ts` })
    const plan = planShadow(reads, { artifacts })
    const full = renderCheckpoint('summary', plan)
    expect(fitCheckpoint('summary', plan, () => true)).toBe(full)
    const compact = fitCheckpoint('summary', plan, text => text.length < full.length)!
    expect(compact).toBe(renderCheckpoint('summary', plan, { excerpts: 0 }))
    expect(catalogIds(compact)).toEqual(plan.references.map(ref => ref.id))
    expect(compact).not.toContain('| excerpt: ')
    expect(compact).toContain(`observation_id: ${plan.references[0]!.id} | call: "cat src/file0.ts"\n`)
    expect(parseCheckpoint(compact)).toMatchObject({ summary: 'summary', contract: ['Read the sources.'] })
    expect(fitCheckpoint('summary', plan, () => false)).toBeUndefined()
    // Without references there is nothing to shorten.
    const bare = planShadow([{ role: 'user', text: 'hi' }], { artifacts })
    expect(fitCheckpoint('summary', bare, text => text.length < renderCheckpoint('summary', bare).length)).toBeUndefined()
  })

  it('bounds excerpts in bytes without splitting characters', () => {
    const text = `${'中'.repeat(400)}\nmiddle\n${'文'.repeat(400)}`
    const excerpt = boundedExcerpt(text, 100)
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(100)
    expect(excerpt).not.toContain('�')
  })
})

describe('recall', () => {
  const setup = () => {
    const artifacts = new MemoryArtifacts()
    const big = log(2000)
    const plan = planShadow(segment(big), { artifacts, originalOf: () => artifacts.save(`${big}\nmore original`) })
    const index = referenceIndex([checkpointRecord({ host: 'h', sessionId: 's', time: 't' }, { kind: 'lightshadow', plan, checkpointTokens: 1 })])
    return { artifacts, big, reference: plan.references[0]!, lookup: (id: string) => index.get(id) }
  }

  it('returns small results whole and a bounded window of a large one around the query', () => {
    const { artifacts, big, reference, lookup } = setup()
    // Neither a line nor a query: the first window, numbered from line 1.
    expect(recallObservation({ observation_id: reference.id }, { lookup, artifacts })).toMatchObject({ ok: true, complete: false, lines: [1, expect.any(Number)], numbered: 1 })
    const window = recallObservation({ observation_id: reference.id, query: 'line 1000:' }, { lookup, artifacts })
    expect(window.ok).toBe(true)
    if (!window.ok) return
    expect(window.text).toContain('line 1000: value 7000')
    expect(Buffer.byteLength(window.text)).toBeLessThanOrEqual(8192)
    expect(big).toContain(window.text)
    expect(renderRecall(reference.id, window)).toMatch(/^\[o-[a-f0-9]{12}: lines \d+-\d+ of 2001\]/)
    // Read in a shell, a window also says how to ask for another part.
    expect(renderRecall(reference.id, window, 'command')).toMatch(/^\[o-[a-f0-9]{12}: lines \d+-\d+ of 2001; another part: tokenwise recall o-[a-f0-9]{12} --line N, or --query 'exact text'\]\n/)
    // A query in the wrong case still finds the line (agents lowercase what they search for); an exact match wins.
    const folded = recallObservation({ observation_id: reference.id, query: 'LINE 1000: VALUE' }, { lookup, artifacts })
    expect(folded).toMatchObject({ ok: true, text: expect.stringContaining('line 1000: value 7000') })
    const whole = recallObservation({ observation_id: reference.id, query: 'KeyError' }, { lookup, artifacts, windowBytes: 1_000_000 })
    expect(whole).toEqual({ ok: true, text: big, complete: true })
  })

  it('reads a large result around a line number', () => {
    const { artifacts, reference, lookup } = setup()
    for (const line of [1500, '1500']) {
      const window = recallObservation({ observation_id: reference.id, line }, { lookup, artifacts })
      expect(window).toMatchObject({ ok: true, complete: false, totalLines: 2001 })
      if (!window.ok) return
      // Line 1500 of the result is "line 1499: ..." (the log counts from 0).
      expect(window.text).toContain('>  1500\tline 1499: value 10493')
      expect(window.text).toContain('   1501\tline 1500: value 10500')
      expect(renderRecall(reference.id, window)).toMatch(/^\[o-[a-f0-9]{12}: lines \d+-\d+ of 2001, numbered; line 1500 is marked >\]\n/)
      expect(window.lines![0]).toBeLessThanOrEqual(1500)
      expect(window.lines![1]).toBeGreaterThanOrEqual(1500)
      expect(Buffer.byteLength(window.text)).toBeLessThanOrEqual(8192)
    }
    expect(recallObservation({ observation_id: reference.id, line: 1 }, { lookup, artifacts })).toMatchObject({ ok: true, lines: [1, expect.any(Number)] })
    // A small result asked by line comes back whole and numbered.
    const small = recallObservation({ observation_id: reference.id, line: 2 }, { lookup, artifacts, windowBytes: 1_000_000 })
    expect(small).toMatchObject({ ok: true, lines: [1, 2001], numbered: 2 })
    if (small.ok) expect(small.text.split('\n')[1]).toBe('>     2\tline 1: value 7')
    expect(recallObservation({ observation_id: reference.id, line: 2001 }, { lookup, artifacts })).toMatchObject({ ok: true, lines: [expect.any(Number), 2001] })
    for (const line of [0, 2002, 3.5, 'x']) {
      expect(recallObservation({ observation_id: reference.id, line }, { lookup, artifacts })).toMatchObject({ ok: false })
    }
    expect(recallObservation({ observation_id: reference.id, line: 0 }, { lookup, artifacts })).toMatchObject({ error: expect.stringMatching(/from 1 to 2001/) })
  })

  it('reads the original Economy shortened, and refuses unknown or expired references', () => {
    const { artifacts, reference, lookup } = setup()
    const original = recallObservation({ observation_id: reference.id, query: 'more original', original: true }, { lookup, artifacts })
    expect(original).toMatchObject({ ok: true, text: expect.stringContaining('more original') })
    expect(recallObservation({ observation_id: 'o-000000000000' }, { lookup, artifacts })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/) })
    expect(recallObservation({}, { lookup, artifacts })).toMatchObject({ ok: false })
    expect(recallObservation({ observation_id: reference.id, query: 'not there at all' }, { lookup, artifacts })).toMatchObject({ ok: false, error: expect.stringMatching(/does not occur/) })
    artifacts.items.clear()
    expect(recallObservation({ observation_id: reference.id, query: 'x' }, { lookup, artifacts })).toMatchObject({ ok: false, error: expect.stringMatching(/no longer stored/) })
  })

  it('clips a single line longer than the window', () => {
    const artifacts = new MemoryArtifacts()
    const line = `needle ${'x'.repeat(20_000)}`
    const reference = externalizeCut(line, { artifacts, tool: 'bash' })!
    const result = recallObservation({ observation_id: reference.id, query: 'needle' }, { lookup: () => reference, artifacts })
    expect(result).toMatchObject({ ok: true, complete: false, lines: [1, 1] })
    if (result.ok) expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192)
  })

  it('returns the part of an over-long line around the match, not its start (a JSON-escaped log)', () => {
    const artifacts = new MemoryArtifacts()
    const log = JSON.stringify({ output: Array.from({ length: 900 }, (_, i) => `build line ${i}: ok${i === 427 ? ' MARKER-42: tangerine-falcon-0731' : ''}`).join('\n') })
    const reference = externalizeCut(log, { artifacts, tool: 'terminal' })!
    const result = recallObservation({ observation_id: reference.id, query: 'MARKER-42:' }, { lookup: () => reference, artifacts })
    expect(result).toMatchObject({ ok: true, complete: false, lines: [1, 1], lineLength: log.length })
    if (!result.ok) return
    expect(result.text).toContain('MARKER-42: tangerine-falcon-0731')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192)
    expect(renderRecall(reference.id, result)).toMatch(new RegExp(`^\\[${reference.id}: line 1 of 1, characters \\d+-\\d+ of ${log.length}\\]`, 'u'))
    // Multi-byte text stays within the window too.
    const wide = `${'界'.repeat(6000)}needle${'界'.repeat(6000)}`
    const other = externalizeCut(wide, { artifacts, tool: 'bash' })!
    const narrow = recallObservation({ observation_id: other.id, query: 'needle' }, { lookup: () => other, artifacts })
    if (narrow.ok) { expect(narrow.text).toContain('needle'); expect(Buffer.byteLength(narrow.text)).toBeLessThanOrEqual(8192) }
  })
})

describe('cut externalization', () => {
  it('keeps the complete text of a head/tail cut and names it in the note', () => {
    const artifacts = new MemoryArtifacts()
    const reference = externalizeCut(log(500), { artifacts, tool: 'bash', callId: 'c' }) as ShadowReference
    expect(artifacts.read(reference.sha256)).toBe(log(500))
    expect(cutNote(reference, 1234)).toContain(`observation_id ${reference.id}`)
    artifacts.corrupt = true
    expect(externalizeCut('other', { artifacts })).toBeUndefined()
  })

  it('compacts a cut result into a reference to its complete text, so a line recall reads the real line', () => {
    const artifacts = new MemoryArtifacts()
    const full = log(500)
    const cut = externalizeCut(full, { artifacts, tool: 'tool' })!
    const seen = full.slice(0, 4096) + cutNote(cut, full.length - 5120) + full.slice(-1024)
    const known = new Map([[cut.id, cut]])
    const plan = planShadow([
      { role: 'user', text: 'Read it.' },
      { role: 'tool', text: seen, toolName: 'bash', callId: 'c7', call: 'cat big.log' },
    ], { artifacts, knownReference: id => known.get(id) })
    expect(plan.references).toEqual([expect.objectContaining({ id: cut.id, sha256: cut.sha256, tool: 'bash', callId: 'c7', call: 'cat big.log' })])
    expect(plan.residual[1]!.text).toContain(`observation_id: ${cut.id}`)
    const index = referenceIndex([checkpointRecord({ host: 'h', sessionId: 's', time: 't' }, { kind: 'lightshadow', plan, checkpointTokens: 1 })])
    const window = recallObservation({ observation_id: cut.id, line: 300 }, { lookup: id => index.get(id), artifacts })
    expect(window).toMatchObject({ ok: true, totalLines: 501 })
    if (window.ok) expect(window.text).toContain('>   300\tline 299: value 2093')
    // Without the complete text (expired), the result is kept as the model saw it.
    const plain = planShadow([{ role: 'tool', text: seen, toolName: 'bash', callId: 'c7' }], { artifacts, knownReference: () => undefined })
    expect(plain.references[0]!.sha256).toBe(sha256(seen))
  })
})
