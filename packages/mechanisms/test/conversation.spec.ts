import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileJournal, readJournals } from '@tokenwise/store'
import { contextOverheadTokens, markSavingsTold, recordSubagent, toldSavings, untoldSavings } from '../src/index.ts'

const decision = (journal: FileJournal, sessionId: string, raw: number, read: number) => journal.append({ schemaVersion: 1, type: 'economy/decision',
  time: new Date().toISOString(), host: 'h', sessionId, callId: `c${raw}`, tool: 'bash', command: 'pytest', exitCode: 1, delivery: 'in-process', streams: 'merged',
  mode: 'apply', outcome: 'projected', runtimeVersion: 'v', policyHash: 'p', raw: { sha256: 'a', bytes: raw * 4, tokens: raw, stored: true },
  projected: { sha256: 'b', bytes: read * 4, tokens: read } } as never)

describe('what a conversation saved, said once', () => {
  it('counts its subagents and is untold again only once it grew; the told number is on disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenwise-told-'))
    const journal = new FileJournal(home)
    const read = (id: string) => readJournals([home], { host: 'h', sessionId: id })
    // Net of TokenWise's per-request text, once per conversation (the subagent's included).
    const own = contextOverheadTokens('h')
    expect(untoldSavings(read, [home], 'h', 's1')).toBeUndefined()
    decision(journal, 's1', 3000, 300)
    recordSubagent(journal, 'h', 's1', 'child')
    decision(journal, 'child', 1000, 100)
    expect(untoldSavings(read, [home], 'h', 's1')).toEqual({ savedTokens: 3600 - 2 * own, seenTokens: 4000 })
    markSavingsTold(home, 'h', 's1', 3600 - 2 * own)
    expect(toldSavings([home], 'h', 's1')).toBe(3600 - 2 * own)
    expect(untoldSavings(read, [home], 'h', 's1')).toBeUndefined()
    // Per agent and per conversation.
    expect(toldSavings([home], 'other', 's1')).toBe(0)
    decision(journal, 's2', 500, 100)
    expect(untoldSavings(read, [home], 'h', 's2')).toEqual({ savedTokens: 400 - own, seenTokens: 500 })
    decision(journal, 's1', 200, 100)
    expect(untoldSavings(read, [home], 'h', 's1')).toEqual({ savedTokens: 3700 - 2 * own, seenTokens: 4200 })
    // A recall's answer and a compaction's catalog are read too.
    journal.append({ schemaVersion: 1, type: 'shadow/recall', time: new Date().toISOString(), host: 'h', sessionId: 's1', callId: 'r',
      id: 'o-000000000000', original: true, outcome: 'returned', bytes: 400 })
    journal.append({ schemaVersion: 1, type: 'shadow/checkpoint', time: new Date().toISOString(), host: 'h', sessionId: 's1', kind: 'assisted',
      references: [], userMessages: 0, segmentTokens: 900, checkpointTokens: 60, addedTokens: 60 })
    decision(journal, 's1', 300, 100)
    expect(untoldSavings(read, [home], 'h', 's1')).toEqual({ savedTokens: 3900 - 2 * own - 100 - 60, seenTokens: 4500 })
  })

  it('says nothing while a conversation has not yet saved more than TokenWise cost it', () => {
    const home = mkdtempSync(join(tmpdir(), 'tokenwise-told-'))
    const read = (id: string) => readJournals([home], { host: 'h', sessionId: id })
    decision(new FileJournal(home), 's', 100 + contextOverheadTokens('h'), 100)
    expect(untoldSavings(read, [home], 'h', 's')).toBeUndefined()
  })

  it('reads the told number from any data directory and lets month-old ones go', () => {
    const [primary, legacy] = [mkdtempSync(join(tmpdir(), 'tokenwise-told-')), mkdtempSync(join(tmpdir(), 'tokenwise-told-'))]
    markSavingsTold(legacy, 'h', 'old', 50)
    expect(toldSavings([primary, legacy], 'h', 'old')).toBe(50)
    const stale = join(legacy, 'told', 'h', 'stale.txt')
    writeFileSync(stale, '10')
    utimesSync(stale, new Date(Date.now() - 40 * 86_400_000), new Date(Date.now() - 40 * 86_400_000))
    markSavingsTold(legacy, 'h', 'new', 70)
    expect(readdirSync(join(legacy, 'told', 'h')).sort()).toEqual(['new.txt', 'old.txt'])
  })
})
