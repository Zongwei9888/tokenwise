/**
 * What TokenWise itself puts in front of the model, so what it says it saved
 * is net of it:
 *
 * - the text it adds to every request on an agent: the recall tool's
 *   definition, and the `tokenwise` skill's listing where the agent cannot
 *   keep the skill for the person alone. Counted once per conversation (and
 *   per subagent conversation), the way a shortened output counts once
 *   although the model reads it again in every later request;
 * - what each recall returned (the model read it after all);
 * - what a compaction added: the catalog, the checkpoint beyond the host's own
 *   summary, the note in place of the host's cut marker.
 *
 * A shortened output itself carries no text of TokenWise's.
 */
import { estimateTokens } from '@tokenwise/core'
import type { JournalRecord } from '@tokenwise/protocol'
import { RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME } from './shadow.ts'
import { RECALL_INPUT_SCHEMA } from './shadow-service.ts'

/** The `tokenwise` skill's description (skills/tokenwise/SKILL.md; a test keeps them equal). */
export const SKILL_DESCRIPTION = 'TokenWise shortens the tool output your agent reads. Use on /tokenwise or $tokenwise, '
  + 'to ask what it saved, whether it works, which output is noisy, to teach it a command, or to see, learn, undo or switch off its rules.'

/** pi lists each tool once more in its system prompt, by this line. */
export const RECALL_PROMPT_SNIPPET = `${RECALL_TOOL_NAME}: read again a tool result TokenWise kept`

/** Agents without the recall tool: Copilot CLI (no MCP server in its plugin), and `tokenwise run` in a terminal (no model). */
const NO_RECALL_TOOL = new Set(['copilot', 'shell'])

/**
 * Agents that list the skill to the model although it is the person's alone
 * (`disable-model-invocation` in SKILL.md, `allow_implicit_invocation: false`
 * for Codex): OpenCode and Hermes have no such setting.
 */
const SKILL_LISTED = new Set(['opencode', 'hermes'])

/**
 * Agents that show the recall tool only once a compaction left something to
 * recall: pi activates it then (adapters/pi/src/shadow.ts), so a conversation
 * that never compacted never carried it.
 */
const RECALL_TOOL_AFTER_COMPACTION = new Set(['pi'])

/**
 * Tokens TokenWise adds to every request on `host`. `compacted`: whether the
 * conversation had a compaction (or a recall), for the agents that show the
 * recall tool only from then on.
 */
export function contextOverheadTokens(host: string, compacted = true): number {
  if (host === 'shell') return 0
  const shown = !NO_RECALL_TOOL.has(host) && (compacted || !RECALL_TOOL_AFTER_COMPACTION.has(host))
  const tool = shown ? estimateTokens(JSON.stringify({ name: RECALL_TOOL_NAME, description: RECALL_TOOL_DESCRIPTION, input_schema: RECALL_INPUT_SCHEMA }))
    + (host === 'pi' ? estimateTokens(RECALL_PROMPT_SNIPPET) : 0) : 0
  return tool + (SKILL_LISTED.has(host) ? estimateTokens(`tokenwise: ${SKILL_DESCRIPTION}`) : 0)
}

/** What one record put in front of the model: a recall's answer, what a compaction added. 0 for anything else. */
export function recordCost(record: JournalRecord): number {
  if (record.type === 'shadow/recall') return record.outcome === 'failed' ? 0 : Math.ceil(record.bytes / 4)
  if (record.type === 'shadow/checkpoint') return record.addedTokens ?? (record.kind === 'assisted' ? record.checkpointTokens : 0)
  return 0
}

/**
 * What TokenWise cost the model in these records: each one's cost, and the
 * per-request text once for every conversation in them that TokenWise
 * decided an output in.
 */
export function overheadOf(records: Iterable<JournalRecord>): number {
  let cost = 0
  const conversations = new Map<string, string>()
  const compacted = new Set<string>()
  for (const record of records) {
    cost += recordCost(record)
    const key = `${record.host}\0${record.sessionId}`
    if (record.type === 'economy/decision' && record.sessionId) conversations.set(key, record.host)
    if (record.type === 'shadow/checkpoint' || record.type === 'shadow/recall') compacted.add(key)
  }
  for (const [key, host] of conversations) cost += contextOverheadTokens(host, compacted.has(key))
  return cost
}
