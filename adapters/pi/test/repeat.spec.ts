import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTokenWiseExtension } from '../src/extension.ts'
import { collapseRepeatReads } from '../src/repeat.ts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-pi-repeat-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const text = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i}`).join('\n')
let calls = 0
/** A pi read as the model's list holds it: the assistant's tool call, then its result. */
const read = (output = text, args: Record<string, unknown> = { path: 'src/a.ts' }) => {
  const id = `call_${++calls}`
  return [{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: args }] },
    { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: output }], isError: false }]
}
const results = (messages: readonly unknown[]) => (messages as { role: string; content: { text: string }[] }[])
  .filter(message => message.role === 'toolResult').map(message => message.content[0]!.text.slice(0, 12))

describe('pi: a read repeated in the list about to be sent', () => {
  it('goes as a note while the earlier read is in the list, alternating, and never edits pi\'s own messages', () => {
    const list = [{ role: 'system', content: 'You are pi.' }, ...read(), ...read(), ...read(), ...read(text, { path: 'src/a.ts', offset: 5 })]
    const { messages, reads } = collapseRepeatReads(list)
    expect(results(messages!)).toEqual(['export const', '[TokenWise: ', 'export const', 'export const'])
    expect(reads.map(item => item.collapsed)).toEqual([false, true, false, false])
    expect(results(list)).toEqual(['export const', 'export const', 'export const', 'export const'])
    // The earlier read gone (a compaction): sent whole.
    expect(collapseRepeatReads(read()).messages).toBeUndefined()
    expect(collapseRepeatReads([...read(), ...read(`${text}\n// changed`)]).messages).toBeUndefined()
  })

  it('in the extension: context_with_system returns the list with the note, each read journaled once', async () => {
    const home = temp()
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const api = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler) },
      registerCommand: () => {}, registerFlag: () => {}, getFlag: () => '', registerTool: () => {}, getActiveTools: () => [], setActiveTools: () => {} }
    const ctx = { cwd: tmpdir(), hasUI: false, mode: 'rpc', model: { provider: 'faux', id: 'faux-model' }, sessionManager: { getSessionId: () => 's1', getBranch: () => [] } }
    createTokenWiseExtension({ dataDir: home, env: { ...process.env, TOKENWISE_HOME: home } })(api as never)
    await handlers.get('session_start')!({}, ctx)
    const list = [...read(), ...read()]
    for (let request = 0; request < 2; request++) {
      const reply = await handlers.get('context_with_system')!({ type: 'context_with_system', messages: list }, ctx) as { messages: unknown[] }
      expect(results(reply.messages)).toEqual(['export const', '[TokenWise: '])
    }
    await handlers.get('tool_result')!({ toolName: 'webfetch', toolCallId: 'w1', input: { url: 'https://example.com' }, content: [{ type: 'text', text: 'page text' }], isError: false }, ctx)
    const records = readdirSync(join(home, 'journal', 'pi')).flatMap(file => readFileSync(join(home, 'journal', 'pi', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    expect(records.map(record => [record.tool, record.outcome, record.filter ?? record.reason])).toEqual([
      ['read', 'passed', 'no-filter-match'], ['read', 'projected', 'repeat-read'], ['webfetch', 'passed', 'no-filter-match']])
  })
})
