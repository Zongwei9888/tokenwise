import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@tokenwise/core'
import type { JournalRecord } from '@tokenwise/protocol'
import { RECALL_INPUT_SCHEMA, RECALL_TOOL_DESCRIPTION, SKILL_DESCRIPTION, contextOverheadTokens, overheadOf, recordCost } from '../src/index.ts'

const skill = readFileSync(new URL('../../../skills/tokenwise/SKILL.md', import.meta.url), 'utf8')

describe('what TokenWise itself costs the model', () => {
  it('counts the skill as the agents that cannot keep it for the person list it', () => {
    expect(/^description: (.*)$/mu.exec(skill)?.[1]).toBe(SKILL_DESCRIPTION)
  })

  it('keeps the text in every request short', () => {
    // The recall tool as a host declares it: what every request carries.
    const tool = estimateTokens(JSON.stringify({ name: 'tokenwise_recall', description: RECALL_TOOL_DESCRIPTION, input_schema: RECALL_INPUT_SCHEMA }))
    expect(tool).toBeLessThanOrEqual(170)
    expect(contextOverheadTokens('claude')).toBe(tool)
    // The skill is the person's alone, except where the agent cannot keep it from the model.
    expect(contextOverheadTokens('opencode')).toBe(tool + estimateTokens(`tokenwise: ${SKILL_DESCRIPTION}`))
    expect(contextOverheadTokens('hermes')).toBe(contextOverheadTokens('opencode'))
    // Copilot has no recall tool; a terminal has no model.
    expect(contextOverheadTokens('copilot')).toBe(0)
    expect(contextOverheadTokens('shell')).toBe(0)
    expect(contextOverheadTokens('pi')).toBeGreaterThan(contextOverheadTokens('claude'))
    // pi shows the recall tool only after a compaction: before, TokenWise adds nothing there.
    expect(contextOverheadTokens('pi', false)).toBe(0)
    expect(contextOverheadTokens('claude', false)).toBe(tool)
  })

  it('counts pi\'s recall tool only in a conversation that compacted', () => {
    const base = { schemaVersion: 1, time: '2026-11-19T00:00:00.000Z', host: 'pi' } as const
    const decision = (sessionId: string) => ({ ...base, sessionId, type: 'economy/decision', outcome: 'projected' }) as unknown as JournalRecord
    expect(overheadOf([decision('a')])).toBe(0)
    const checkpoint = { ...base, sessionId: 'a', type: 'shadow/checkpoint', kind: 'lightshadow', references: [], userMessages: 0, segmentTokens: 9000, checkpointTokens: 900, addedTokens: 300 } as JournalRecord
    expect(overheadOf([decision('a'), checkpoint, decision('b')])).toBe(300 + contextOverheadTokens('pi'))
  })

  it('counts recalls, what compactions added, and the per-request text once per conversation', () => {
    const base = { schemaVersion: 1, time: '2026-11-17T00:00:00.000Z', host: 'claude' } as const
    const decision = (sessionId: string) => ({ ...base, sessionId, type: 'economy/decision', outcome: 'passed' }) as unknown as JournalRecord
    const records: JournalRecord[] = [
      decision('a'), decision('a'), decision('b'),
      { ...base, sessionId: 'a', type: 'shadow/recall', callId: null, id: 'o-1', original: false, outcome: 'window', bytes: 8000 },
      { ...base, sessionId: 'a', type: 'shadow/recall', callId: null, id: 'o-2', original: false, outcome: 'failed', bytes: 80 },
      { ...base, sessionId: 'a', type: 'shadow/checkpoint', kind: 'assisted', references: [], userMessages: 0, segmentTokens: 5000, checkpointTokens: 700 },
      { ...base, sessionId: 'a', type: 'shadow/checkpoint', kind: 'lightshadow', references: [], userMessages: 2, segmentTokens: 9000, checkpointTokens: 900, addedTokens: 300 },
      { ...base, sessionId: 'a', type: 'shadow/checkpoint', kind: 'standard', references: [], userMessages: 0, segmentTokens: 9000, checkpointTokens: 0 },
    ]
    expect(records.map(recordCost)).toEqual([0, 0, 0, 2000, 0, 700, 300, 0])
    expect(overheadOf(records)).toBe(3000 + 2 * contextOverheadTokens('claude'))
  })
})
