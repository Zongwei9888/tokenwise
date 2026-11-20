import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { passToolOutput } from '../src/tools.ts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-tools-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const records = (home: string, host: string) => readdirSync(join(home, 'journal', host))
  .flatMap(file => readFileSync(join(home, 'journal', host, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))

describe('every tool result through TokenWise', () => {
  const file = Array.from({ length: 120 }, (_, i) => `export const value${i} = ${i}`).join('\n')

  it('journals each result; a read repeated unchanged while the first is in context is a note, once, then whole again', () => {
    const home = temp()
    const inContext = new Set(['c1', 'c3'])
    let call = 0
    const read = (text = file, sessionId = 's1') => {
      const callId = `c${++call}`
      return passToolOutput({ host: 'claude', tool: 'Read', sessionId, callId, args: { file_path: '/w/a.ts' }, text, env: { TOKENWISE_HOME: home },
        read: { key: 'Read /w/a.ts', what: '/w/a.ts', stillInContext: id => inContext.has(id) } })
    }
    expect(read()).toBeUndefined() // c1: first read, whole
    expect(read()).toMatch(/^\[TokenWise: \/w\/a\.ts is unchanged since you read it earlier/u) // c2: a note pointing at c1
    expect(read()).toBeUndefined() // c3: asked again right after a note: whole
    expect(read()).toBeDefined() // c4: a note pointing at c3
    expect(read(`${file}\nexport const added = 1`)).toBeUndefined() // c5: the file changed
    inContext.clear()
    expect(read(`${file}\nexport const added = 1`)).toBeUndefined() // c6: c5 is no longer in context
    expect(read(file, 's2')).toBeUndefined() // another conversation
    expect(records(home, 'claude').map(record => [record.callId, record.outcome, record.filter ?? record.reason])).toEqual([
      ['c1', 'passed', 'no-filter-match'], ['c2', 'projected', 'repeat-read'], ['c3', 'passed', 'no-filter-match'], ['c4', 'projected', 'repeat-read'],
      ['c5', 'passed', 'no-filter-match'], ['c6', 'passed', 'no-filter-match'], ['c7', 'passed', 'no-filter-match']])
    // The note's original is kept, as for any shortened output; a whole read's is not (only its digest).
    const [first, note] = records(home, 'claude')
    expect([first.raw.stored, note.raw.stored, note.command]).toEqual([false, true, 'Read {"file_path":"/w/a.ts"}'])
  })

  it('journals any other tool\'s result unchanged, and does nothing when TokenWise is off', () => {
    const home = temp()
    expect(passToolOutput({ host: 'claude', tool: 'WebFetch', sessionId: 's1', callId: 'w1', args: { url: 'https://example.com' }, text: 'page text', env: { TOKENWISE_HOME: home } })).toBeUndefined()
    expect(records(home, 'claude')).toMatchObject([{ tool: 'WebFetch', outcome: 'passed', raw: { stored: false } }])
    const off = temp()
    expect(passToolOutput({ host: 'claude', tool: 'WebFetch', sessionId: 's1', callId: 'w2', args: {}, text: 'x', env: { TOKENWISE_HOME: off, TOKENWISE_DISABLE: '1' } })).toBeUndefined()
    expect(existsSync(join(off, 'journal'))).toBe(false)
  })
})
