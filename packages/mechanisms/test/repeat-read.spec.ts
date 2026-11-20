import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '@tokenwise/core'
import { rememberRead, repeatReadNote, repeatReadProjection, seenRead } from '../src/index.ts'

describe('a file read again, unchanged', () => {
  const text = 'def main():\n    return 1\n'
  const always = () => true

  it('is a note only when the last read of the same range had the same text, reached the model whole and is still in context', () => {
    const seen = { sha256: sha256(text), callId: 'c1', noted: false }
    const note = repeatReadProjection(seen, text, 'src/app.py', always)!
    expect(note.text).toBe(repeatReadNote('src/app.py'))
    expect(note).toMatchObject({ filter: 'repeat-read', transformation: 'lossless-formatting' })
    expect(note.sourceMap.spans).toEqual([{ outputStart: 0, outputEnd: note.text.length, generated: note.text }])
    expect(repeatReadProjection(undefined, text, 'src/app.py', always)).toBeUndefined()
    expect(repeatReadProjection(seen, `${text}x`, 'src/app.py', always)).toBeUndefined()
    expect(repeatReadProjection({ ...seen, noted: true }, text, 'src/app.py', always)).toBeUndefined()
    const asked: string[] = []
    expect(repeatReadProjection(seen, text, 'src/app.py', id => { asked.push(id); return false })).toBeUndefined()
    expect(asked).toEqual(['c1'])
  })

  it('remembers the last read per agent, conversation and range, from any data directory, and forgets them all at once', () => {
    const [primary, legacy] = [mkdtempSync(join(tmpdir(), 'tokenwise-reads-')), mkdtempSync(join(tmpdir(), 'tokenwise-reads-'))]
    rememberRead(legacy, 'claude', 's1', 'Read a.py', { sha256: 'x', callId: 'c1', noted: false })
    rememberRead(legacy, 'claude', 's1', 'Read a.py', { sha256: 'y', callId: 'c2', noted: true })
    rememberRead(legacy, 'claude', 's1', 'Read b.py', { sha256: 'z', callId: 'c3', noted: false })
    expect(seenRead([primary, legacy], 'claude', 's1', 'Read a.py')).toEqual({ sha256: 'y', callId: 'c2', noted: true })
    expect(seenRead([primary, legacy], 'claude', 's2', 'Read a.py')).toBeUndefined()
    expect(seenRead([primary, legacy], 'codebuddy', 's1', 'Read a.py')).toBeUndefined()
  })
})
