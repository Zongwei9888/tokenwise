import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTokenWise } from '../src/plugin.ts'
import { collapseRepeatReads } from '../src/repeat.ts'
import type { OpenCodeMessage } from '../src/shadow.ts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-opencode-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// OpenCode 1.19's read output: the path, then numbered lines, then a footer.
const body = (extra = '') => `<path>/w/a.ts</path>\n<type>file</type>\n<content>\n${Array.from({ length: 60 }, (_, i) => `${i + 1}: export const v${i} = ${i}`).join('\n')}${extra}\n(End of file - total 60 lines)\n</content>`
let calls = 0
const read = (output = body(), extra: Record<string, unknown> = {}): OpenCodeMessage => ({ info: { id: `m${++calls}`, sessionID: 'ses_1', role: 'assistant' },
  parts: [{ type: 'tool', tool: 'read', callID: `call_${calls}`, state: { status: 'completed', input: { filePath: '/w/a.ts' }, output, ...extra } }] })
const outputs = (messages: readonly OpenCodeMessage[]) => messages.map(message => (message.parts[0]!.state!.output as string).slice(0, 12))

describe('OpenCode: a read repeated in what is about to be sent', () => {
  it('goes as a note while the earlier read is in the list, alternating with the text, and never edits what OpenCode keeps', () => {
    const kept = [read(), read(), read(), read()]
    const sent = [...kept]
    const result = collapseRepeatReads(sent)
    expect(outputs(sent)).toEqual(['<path>/w/a.t', '[TokenWise: ', '<path>/w/a.t', '[TokenWise: '])
    expect(result.map(item => item.collapsed)).toEqual([false, true, false, true])
    expect(outputs(kept)).toEqual(['<path>/w/a.t', '<path>/w/a.t', '<path>/w/a.t', '<path>/w/a.t'])
    // Once the earlier read is gone from the list (a compaction), the repeat is sent whole again.
    const later = [read(), read(), read()].slice(1)
    collapseRepeatReads(later)
    expect(outputs(later)).toEqual(['<path>/w/a.t', '[TokenWise: '])
  })

  it('leaves a changed file, a pruned earlier read, another range or a short file whole', () => {
    const changed = [read(), read(body('\n61: export const extra = 1'))]
    const pruned = [read(body(), { time: { compacted: 1 } }), read()]
    const range = [read(), { ...read(), parts: [{ ...read().parts[0]!, state: { status: 'completed', input: { filePath: '/w/a.ts', offset: 10 }, output: body() } }] }]
    const short = [read('x'), read('x')]
    for (const list of [changed, pruned, range, short]) {
      collapseRepeatReads(list)
      expect(outputs(list).some(text => text.startsWith('[TokenWise'))).toBe(false)
    }
  })

  it('in the plugin: notes in the request, each read journaled once, other tools journaled as they are', async () => {
    const home = temp()
    const hooks = await createTokenWise({ env: { TOKENWISE_HOME: home } })({ directory: temp() })
    const conversation = [read(), read()]
    for (let request = 0; request < 2; request++) {
      const output = { messages: [...conversation] }
      await hooks['experimental.chat.messages.transform']!({}, output)
      expect(outputs(output.messages)).toEqual(['<path>/w/a.t', '[TokenWise: '])
    }
    await hooks['tool.execute.after']!({ tool: 'webfetch', sessionID: 'ses_1', callID: 'w1', args: { url: 'https://example.com' } }, { output: 'page text' })
    const records = readdirSync(join(home, 'journal', 'opencode')).flatMap(file => readFileSync(join(home, 'journal', 'opencode', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    expect(records.map(record => [record.tool, record.outcome, record.filter ?? record.reason])).toEqual([
      ['read', 'passed', 'no-filter-match'], ['read', 'projected', 'repeat-read'], ['webfetch', 'passed', 'no-filter-match']])
  })
})
