import { describe, expect, it } from 'vitest'
import { sha256 } from '@tokenwise/core'
import type { ArtifactPort, ArtifactRef, JournalRecord, ShadowCheckpointRecord } from '@tokenwise/protocol'
import { catalogIds, recallFromJournal, shadowCatalog, shadowCheckpoint, shadowMessagesFrom } from '../src/index.ts'
import type { ShadowMessage, ShadowStore } from '../src/index.ts'

class MemoryArtifacts implements ArtifactPort {
  readonly items = new Map<string, string>()
  save(text: string): ArtifactRef {
    this.items.set(sha256(text), text)
    return { sha256: sha256(text), bytes: Buffer.byteLength(text) }
  }
  read(hash: string) { return this.items.get(hash) }
}

function memoryStore(): ShadowStore & { records: JournalRecord[] } {
  const records: JournalRecord[] = []
  return {
    records, artifacts: new MemoryArtifacts(),
    journal: { append: record => { records.push(record) } },
    read: sessionId => records.filter(record => record.sessionId === sessionId),
    now: () => new Date('2026-10-28T00:00:00Z'),
  }
}

const log = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}: value ${i * 7}`).join('\n')
const span = (tag: string): ShadowMessage[] => [
  { role: 'user', text: `Look at ${tag}.` },
  { role: 'assistant', text: 'Reading it.' },
  { role: 'tool', text: log(400, tag), toolName: 'Bash', callId: `call-${tag}`, call: `cat ${tag}.log` },
]

describe('shadowMessagesFrom', () => {
  it('keeps known fields, maps snake_case, and turns unknown roles into other', () => {
    expect(shadowMessagesFrom([
      { role: 'tool', text: 'x', tool_name: 'Bash', call_id: 'c1', call: 'ls' },
      { role: 'system', text: 'y' },
      { role: 'user' },
      'junk',
    ])).toEqual([{ role: 'tool', text: 'x', toolName: 'Bash', callId: 'c1', call: 'ls' }, { role: 'other', text: 'y' }])
    expect(shadowMessagesFrom(undefined)).toEqual([])
    expect(shadowMessagesFrom([{ role: 'tool', text: 'x', call_input: { command: 'make  test' } }])).toEqual([{ role: 'tool', text: 'x', call: 'make test' }])
  })
})

describe('shadowCatalog (assisted tier)', () => {
  it('saves the span, lists every reference of the session and records an assisted checkpoint', () => {
    const store = memoryStore()
    const first = shadowCatalog({ host: 'claude', sessionId: 's1', messages: span('alpha'), toolName: 'mcp__tokenwise__tokenwise_recall' }, store)
    expect(first).toMatchObject({ references: 1, added: 1 })
    expect(first.text).toContain('mcp__tokenwise__tokenwise_recall')
    expect(first.text).toContain('call: "cat alpha.log"')
    const second = shadowCatalog({ host: 'claude', sessionId: 's1', messages: span('beta') }, store)
    // The second compaction lists the first one's reference again.
    expect(second).toMatchObject({ references: 2, added: 1 })
    expect(catalogIds(second.text)).toHaveLength(2)
    const kinds = store.records.map(record => (record as ShadowCheckpointRecord).kind)
    expect(kinds).toEqual(['assisted', 'assisted'])
    // Another session does not see them.
    expect(shadowCatalog({ host: 'claude', sessionId: 's2', messages: [] }, store)).toMatchObject({ text: '', references: 0 })
  })

  it('links a shortened result to the original Economy kept', () => {
    const store = memoryStore()
    const original = store.artifacts.save(log(900, 'raw'))
    store.journal.append({ schemaVersion: 1, type: 'economy/decision', time: 't', host: 'claude', sessionId: 's1', callId: 'call-alpha', tool: 'Bash',
      command: 'cat alpha.log', exitCode: 0, delivery: 'result-hook', streams: 'separate', mode: 'apply', outcome: 'projected', runtimeVersion: 'x', policyHash: 'y',
      raw: { ...original, tokens: 1, stored: true } } as JournalRecord)
    const result = shadowCatalog({ host: 'claude', sessionId: 's1', messages: span('alpha') }, store)
    expect(result.text).toContain('original:')
  })
})

describe('shadowCatalog under a tight budget', () => {
  it('lists more references by leaving out excerpts when they would not fit otherwise', () => {
    const store = memoryStore()
    const messages: ShadowMessage[] = Array.from({ length: 300 }, (_, i) => ({ role: 'tool' as const, text: log(60, `part${i}`), toolName: 'Bash', callId: `c${i}`, call: `cat part-${i}.log` }))
    const result = shadowCatalog({ host: 'claude', sessionId: 's1', messages, budgetTokens: 2_000 }, store)
    expect(result.text.length).toBeLessThan(2_000 * 4 + 1_000)
    // About 70 characters per call-only line: well over the ~40 that fit with excerpts.
    expect(result.references).toBeGreaterThan(80)
    expect(result.text).toContain('call: "cat part-299.log"')
  })
})

describe('shadowCheckpoint (full tier)', () => {
  it('appends the user messages and the catalog to the host summary', () => {
    const store = memoryStore()
    const result = shadowCheckpoint({ host: 'hermes', sessionId: 's1', messages: span('alpha'), summary: 'Looked at alpha; value 7 at line 1.' }, store)
    expect(result.references).toBe(1)
    expect(result.text).toMatch(/^Looked at alpha/u)
    expect(result.text).toContain('"Look at alpha."')
    expect(catalogIds(result.text!)).toHaveLength(1)
    expect((store.records[0] as ShadowCheckpointRecord).kind).toBe('lightshadow')
  })

  it('keeps the host summary, saying so, when the span had no tool result worth keeping and the host keeps the user messages', () => {
    const store = memoryStore()
    const result = shadowCheckpoint({ host: 'hermes', sessionId: 's1', messages: [{ role: 'user', text: 'hi' }, { role: 'tool', text: 'ok' }], summary: 'Said hi.', userMessages: false }, store)
    expect(result.text).toBeUndefined()
    expect(store.records[0]).toMatchObject({ kind: 'standard', reason: 'nothing-recallable' })
  })

  it('keeps the host summary when the checkpoint would not be smaller', () => {
    const store = memoryStore()
    const result = shadowCheckpoint({ host: 'hermes', sessionId: 's1', messages: [{ role: 'user', text: 'hi' }], summary: 'x'.repeat(4000) }, store)
    expect(result.text).toBeUndefined()
    expect(store.records[0]).toMatchObject({ kind: 'standard', reason: 'checkpoint-not-smaller' })
  })
})

describe('recallFromJournal', () => {
  it('finds a reference in the session, then anywhere, and journals the call', () => {
    const store = memoryStore()
    const result = shadowCatalog({ host: 'claude', sessionId: 's1', messages: span('alpha') }, store)
    const [id] = catalogIds(result.text)
    const base = { host: 'mcp', artifacts: store.artifacts, read: store.read, journal: store.journal }
    expect(recallFromJournal({ observation_id: id, query: 'alpha 123:' }, { ...base, sessionId: 's1' })).toMatchObject({ ok: true })
    // Unknown session: only found when the caller allows a lookup across sessions.
    expect(recallFromJournal({ observation_id: id, query: 'alpha 123:' }, { ...base, sessionId: null }).ok).toBe(false)
    const anywhere = recallFromJournal({ observation_id: id, query: 'alpha 123:' }, { ...base, sessionId: null, readAll: () => store.records })
    expect(anywhere.ok).toBe(true)
    expect(anywhere.text).toContain('alpha 123: value 861')
    const recalls = store.records.filter(record => record.type === 'shadow/recall') as { outcome: string; sessionId: string | null }[]
    expect(recalls.map(record => record.outcome)).toEqual(['window', 'failed', 'window'])
    // Found without knowing the session (the MCP server): journaled under the session that owns the reference.
    expect(recalls.map(record => record.sessionId)).toEqual(['s1', null, 's1'])
  })

  it('gives a shell (tokenwise recall) the whole result up to 64 KB, and a window beyond that says how to ask for more', () => {
    const store = memoryStore()
    const [id] = catalogIds(shadowCatalog({ host: 'copilot', sessionId: 's1', messages: span('alpha') }, store).text)
    const base = { host: 'copilot', artifacts: store.artifacts, read: store.read, sessionId: 's1' }
    // 400 lines, about 8.6 KB: the tool gets its first window, a shell all of it to grep through.
    expect(recallFromJournal({ observation_id: id! }, base).text).toMatch(/^\[o-[a-f0-9]{12}: lines 1-\d+ of 400, numbered; line 1 is marked >\]\n/u)
    expect(recallFromJournal({ observation_id: id! }, { ...base, via: 'command' }).text).toBe(log(400, 'alpha'))
    // Asked for a part, a shell gets a window like the tool, and is told how to ask for another.
    expect(recallFromJournal({ observation_id: id!, query: 'alpha 300:' }, { ...base, via: 'command' }).text)
      .toMatch(/^\[o-[a-f0-9]{12}: lines \d+-\d+ of 400; another part: tokenwise recall o-[a-f0-9]{12} --line N, or --query 'exact text'\]\n/u)
  })

  it('journals a recall of output two conversations share under the one the host names, else the later one', () => {
    const store = memoryStore()
    let now = Date.parse('2026-11-17T00:00:00Z')
    const later = { ...store, now: () => new Date(now += 60_000) }
    // The same command, the same output, a day apart: one ID. The later conversation's file is read first.
    const [id] = catalogIds(shadowCatalog({ host: 'claude', sessionId: 'yesterday', messages: span('alpha') }, later).text)
    shadowCatalog({ host: 'claude', sessionId: 'today', messages: span('alpha') }, later)
    const records = [...store.records.filter(record => record.sessionId === 'today'), ...store.records.filter(record => record.sessionId === 'yesterday')]
    const base = { host: 'claude', artifacts: store.artifacts, read: store.read, journal: store.journal, sessionId: null, readAll: () => records }
    recallFromJournal({ observation_id: id!, line: 1 }, base)
    recallFromJournal({ observation_id: id!, line: 1 }, { ...base, sessionHint: 'yesterday' })
    // A stale hint (a conversation without that output) is ignored.
    recallFromJournal({ observation_id: id!, line: 1 }, { ...base, sessionHint: 'another' })
    // `tokenwise recall` in an agent's shell names no agent: the recall goes with the conversation, under its agent.
    shadowCatalog({ host: 'copilot', sessionId: 'shell-run', messages: span('alpha') }, later)
    recallFromJournal({ observation_id: id!, line: 1 }, { artifacts: store.artifacts, read: store.read, journal: store.journal, sessionId: null, readAll: () => store.records })
    const recalls = store.records.filter(record => record.type === 'shadow/recall')
    expect(recalls.map(record => record.sessionId)).toEqual(['today', 'yesterday', 'today', 'shell-run'])
    expect(recalls.map(record => record.host)).toEqual(['claude', 'claude', 'claude', 'copilot'])
  })
})
