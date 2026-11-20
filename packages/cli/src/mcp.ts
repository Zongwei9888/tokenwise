/**
 * `tokenwise mcp`: a Model Context Protocol server on stdio with one tool,
 * `tokenwise_recall`. Any agent that speaks MCP can read again the tool results
 * LightShadow kept, whatever adapter (or none) recorded them. Messages are
 * newline-delimited JSON-RPC 2.0; no SDK, so the bundle stays one file.
 */
import { createInterface } from 'node:readline'
import { RECALL_INPUT_SCHEMA, RECALL_TOOL_DESCRIPTION, RECALL_TOOL_NAME, recallFromJournal } from '@tokenwise/mechanisms'
import { cliContext } from './context.ts'
import { VERSION } from './doctor.ts'

/** Newest first; a client asking for one of these gets it back, any other gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

interface Request { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

export interface McpOptions {
  /** Host name for the recall records in the journal. */
  readonly host?: string
  /** The session, when the host passes it (an environment variable in the server's launch config). */
  readonly session?: string
}

/** One JSON-RPC message in, the reply out (undefined for notifications and unanswerable input). */
export function handleMcp(message: Request, options: McpOptions = {}): Record<string, unknown> | undefined {
  const id = message.id
  const isRequest = typeof id === 'string' || typeof id === 'number'
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } })
  if (typeof message.method !== 'string') return isRequest ? fail(-32600, 'invalid request') : undefined
  if (!isRequest) return undefined
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>
  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        // No instructions: the host puts them in every request, and the catalog after a compaction says when to recall.
        serverInfo: { name: 'tokenwise', version: VERSION },
      })
    }
    case 'ping': return ok({})
    case 'tools/list':
      return ok({ tools: [{ name: RECALL_TOOL_NAME, title: 'Recall a tool result', description: RECALL_TOOL_DESCRIPTION, inputSchema: RECALL_INPUT_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] })
    case 'tools/call': {
      if (params.name !== RECALL_TOOL_NAME) return fail(-32602, `unknown tool ${String(params.name)}`)
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
      try {
        const context = cliContext()
        const writable = context.writable()
        const session = options.session || process.env.TOKENWISE_SESSION || null
        // Claude Code tells its MCP servers the session they were started in.
        const hint = process.env.CLAUDE_CODE_SESSION_ID
        const result = recallFromJournal(args, {
          host: options.host ?? process.env.TOKENWISE_HOST ?? 'mcp', sessionId: session, ...hint ? { sessionHint: hint } : {},
          artifacts: { save: () => { throw new Error('read only') }, read: hash => context.readArtifact(hash) },
          read: sessionId => context.readJournal({ sessionId }),
          readAll: () => context.readJournal({}),
          ...writable ? { journal: writable.journal } : {},
        })
        return ok({ content: [{ type: 'text', text: result.text }], isError: !result.ok })
      } catch (error) {
        return ok({ content: [{ type: 'text', text: `recall failed: ${String((error as Error)?.message ?? error)}` }], isError: true })
      }
    }
    default: return fail(-32601, `method not found: ${message.method}`)
  }
}

export async function mcp(options: McpOptions = {}): Promise<number> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let message: Request
    try { message = JSON.parse(line) as Request } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
      continue
    }
    const batch = Array.isArray(message) ? message as Request[] : [message]
    const replies = batch.map(item => handleMcp(item, options)).filter(Boolean)
    if (replies.length) process.stdout.write(JSON.stringify(Array.isArray(message) ? replies : replies[0]) + '\n')
  }
  return 0
}
