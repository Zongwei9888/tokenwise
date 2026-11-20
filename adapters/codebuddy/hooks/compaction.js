/**
 * LightShadow for CodeBuddy Code: a mod (in-process plugin module), the full
 * tier. Verified against CodeBuddy 2.175.0:
 *
 * - `session.compact` runs before CodeBuddy's own summarizer with the span it
 *   compacts. A mod cannot hand back a different transcript there (2.175
 *   ignores returned messages), but it can add to the summarizer's
 *   instructions: the span is kept for the next step.
 * - `session.append` sees every row as it is stored. The summary row
 *   (`<conversation_history_summary><summary>…</summary>…`) is rewritten so its
 *   summary becomes LightShadow's checkpoint: CodeBuddy's summary, the user's
 *   exact messages and the catalog of the tool results TokenWise kept.
 * - `tokenwise_recall`, registered at `session.start`, reads any of them
 *   again; `tool.check` lets it run without asking (it only reads TokenWise's
 *   own store).
 *
 * A mod may not import anything, so the work is done by the `tokenwise` command
 * (`tokenwise shadow checkpoint`, `tokenwise recall`). Every hook passes the event on
 * unchanged on any failure: CodeBuddy's own compaction stands.
 */

const TOOL = 'tokenwise_recall'
const LC_TIMEOUT_MS = 30_000

// Kept equal to SHADOW_SUMMARY_INSTRUCTION, RECALL_TOOL_DESCRIPTION and RECALL_INPUT_SCHEMA in
// @tokenwise/mechanisms (a test compares them).
const INSTRUCTION = 'After this compaction every tool result in this span stays recoverable: TokenWise appends a catalog of them, '
  + 'and the agent can read any of them again with the recall tool. So write the summary the agent needs to carry on '
  + 'without re-running anything: the findings from the tool results (facts, file paths with line numbers, values, '
  + 'errors, what passed and what failed) and the decisions made. Do not paste whole files, logs or test output; '
  + 'say what they showed. Do not list observation IDs. The user\'s messages are kept word for word after the summary. '
  + 'Keep it concise: a short line per finding, so the summary fits well within your output limit.'
const DESCRIPTION = 'Read again a tool result TokenWise kept, by the observation_id in the observation catalog. '
  + 'Results over 8 KB come back a window at a time.'
const SCHEMA = {
  type: 'object',
  properties: {
    observation_id: { type: 'string', description: 'Such as o-1a2b3c4d5e6f.' },
    query: { type: 'string', description: 'An exact string it contains: read around its first match.' },
    line: { type: 'integer', minimum: 1, description: 'A 1-based line to read around.' },
    original: { type: 'boolean', description: 'For a catalog entry marked original: the output before TokenWise shortened it.' },
  },
  required: ['observation_id'],
  additionalProperties: false,
}

/** The span of each loop compacting (the main conversation, or a subagent's), until its summary is stored. */
const pending = new Map()

/** CodeBuddy's transcript as LightShadow's messages: text, and each tool result with the call that produced it. */
export function spanOf(messages) {
  const out = []
  const calls = new Map()
  const seen = new Set()
  const toolRow = (id, text) => {
    if (typeof text !== 'string' || seen.has(id)) return
    seen.add(id)
    const call = calls.get(id)
    out.push({ role: 'tool', text, tool_name: call?.tool ?? 'tool', call_id: id, ...call ? { call_input: call.input } : {} })
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const text = typeof message.text === 'string' ? message.text : ''
    if (message.role === 'assistant') {
      const uses = Array.isArray(message.toolUses) ? message.toolUses : []
      const said = [text, ...uses.map(use => `${use?.tool ?? 'tool'} ${JSON.stringify(use?.input ?? {})}`)].filter(Boolean).join('\n')
      if (said) out.push({ role: 'assistant', text: said })
      for (const use of uses) {
        if (typeof use?.tool_use_id !== 'string') continue
        calls.set(use.tool_use_id, { tool: use.tool, input: use.input })
        if (!use.isError) toolRow(use.tool_use_id, use.text)
      }
      continue
    }
    if (message.role !== 'user') continue
    for (const result of Array.isArray(message.toolResults) ? message.toolResults : []) {
      if (typeof result?.tool_use_id === 'string' && !result.isError) toolRow(result.tool_use_id, result.text)
    }
    if (text.trim()) out.push({ role: 'user', text })
  }
  return out
}

/**
 * `tokenwise <args>` with JSON on stdin. A mod cannot tell the platform, so the ways
 * to start it are tried in turn, moving on when one cannot start (`tokenwise` on
 * PATH; a POSIX shell, whose PATH may differ; Windows' `cmd`, which runs the
 * `tokenwise.cmd` npm installs there).
 */
async function tokenwise($, args, payload) {
  const init = { ...payload === undefined ? {} : { stdin: JSON.stringify(payload) }, timeoutMs: LC_TIMEOUT_MS }
  const ways = [['tokenwise', ...args], ['/bin/sh', '-c', 'exec tokenwise "$@"', 'tokenwise', ...args], ['cmd.exe', '/d', '/s', '/c', 'tokenwise', ...args]]
  for (const argv of ways) {
    try {
      const done = await $.process.run(argv, init)
      // 127: the shell started but found no tokenwise; 9009: the same from cmd.
      if (done && done.exitCode !== 127 && done.exitCode !== 9009) return done
    } catch { /* This way cannot start here; try the next. */ }
  }
  return undefined
}

// The stored summary, in the two shapes CodeBuddy 2.175 writes: `/compact` (an assistant row with an inner
// <summary>) and an automatic emergency compaction (a user row, the summary directly inside).
const SUMMARY = /^(\s*<conversation_history_summary>\s*<summary>)([\s\S]*?)(<\/summary>[\s\S]*)$/u
const BARE_SUMMARY = /^(\s*<conversation_history_summary>)([\s\S]*?)(<\/conversation_history_summary>\s*)$/u

const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text'])

/** The text of a stored row, when all of its content is text. */
function rowText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (!TEXT_BLOCKS.has(block?.type) || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

/** The row with its text replaced, in the same block type it was stored with. */
function withText(message, text) {
  if (typeof message.content === 'string') return { ...message, content: text }
  return { ...message, content: [{ ...message.content[0], text }] }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    } catch { /* No recall tool; compaction is unaffected. */ }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    try {
      const span = spanOf(e.messages)
      if (span.some(row => row.role === 'tool')) {
        pending.set(e.agentId ?? '', { span, sessionId: await $.session.id() })
        return next({ ...e, instructions: [e.instructions, INSTRUCTION].filter(Boolean).join('\n\n') })
      }
    } catch { /* Fall through: CodeBuddy compacts as it would have. */ }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    try {
      const entry = pending.get(e.agentId ?? '')
      // Any door: an automatic compaction stores its summary as a user row. The compaction prompt, which also
      // mentions the tag, does not start with it.
      const text = entry ? rowText(e.message) : undefined
      const match = text === undefined ? null : SUMMARY.exec(text) ?? BARE_SUMMARY.exec(text)
      if (match) {
        pending.delete(e.agentId ?? '')
        const done = await tokenwise($, ['shadow', 'checkpoint'], { host: 'codebuddy', session_id: entry.sessionId, messages: entry.span, summary: match[2].trim() })
        const reply = done && done.exitCode === 0 ? JSON.parse(done.stdout || '{}') : undefined
        if (typeof reply?.text === 'string' && reply.text.trim()) {
          return next({ ...e, message: withText(e.message, `${match[1]}\n${reply.text}\n${match[3]}`) })
        }
      }
    } catch { /* CodeBuddy's summary stays. */ }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    // Read-only: it reads what TokenWise saved earlier in this session.
    if (typeof e.tool === 'string' && (e.tool === TOOL || e.tool.endsWith(`__${TOOL}`))) return { decision: 'allow' }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // 2.175 passes the short name here, though the model sees mcp__<plugin>__<name>.
    if (typeof e.tool !== 'string' || (e.tool !== TOOL && !e.tool.endsWith(`__${TOOL}`))) return next(e)
    try {
      const id = typeof e.observation_id === 'string' ? e.observation_id.trim() : ''
      if (!id) return { result: 'recall failed: pass an observation_id from the observation catalog' }
      const args = ['recall', id, '--host', 'codebuddy', '--session', await $.session.id()]
      if (typeof e.query === 'string' && e.query) args.push('--query', e.query)
      if (e.line !== undefined && /^\s*\d+\s*$/u.test(String(e.line))) args.push('--line', String(e.line).trim())
      if (e.original === true || e.original === 'true') args.push('--original')
      const done = await tokenwise($, args)
      return { result: done?.stdout || 'recall failed: TokenWise (tokenwise) is not available' }
    } catch (error) {
      return { result: `recall failed: ${String(error?.message ?? error)}` }
    }
  })
}
