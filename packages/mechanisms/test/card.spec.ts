import { describe, expect, it } from 'vitest'
import { savedCard } from '../src/index.ts'

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, '')
const saved = { savedTokens: 2402, seenTokens: 3080 }

describe('the card that says what a conversation saved', () => {
  it('draws a small jar beside the tokens saved and a bar for how much shorter the output got, in English', () => {
    expect(savedCard(saved, { lines: true })).toBe([
      ' ▗▄▄▖',
      '▗▛●░▜▖ TokenWise · saved 2,402 tokens in this conversation',
      '▐●●●●▌ ▰▰▰▰▰▰▰▰▱▱ tool output 78% shorter',
    ].join('\n'))
    // The jar fills with the share: a little saved is still one coin.
    expect(savedCard({ savedTokens: 12, seenTokens: 5000 }, { lines: true })).toBe([
      ' ▗▄▄▖',
      '▗▛░░▜▖ TokenWise · saved 12 tokens in this conversation',
      '▐●···▌ ▱▱▱▱▱▱▱▱▱▱ tool output under 1% shorter',
    ].join('\n'))
  })

  it('fits each agent: colour, a title of its own, a label before the first line, or one line', () => {
    const coloured = savedCard(saved, { lines: true, color: true })!
    expect(coloured).toContain('\x1b[38;2;79;227;193m')
    expect(plain(coloured)).toBe(savedCard(saved, { lines: true }))
    expect(savedCard(saved, { lines: true, untitled: true })!.split('\n')[1]).toBe('▗▛●░▜▖ saved 2,402 tokens in this conversation')
    expect(savedCard(saved, { lines: true, breakFirst: true })!.startsWith('\n ▗▄▄▖\n')).toBe(true)
    expect(savedCard(saved)).toBe('TokenWise · saved 2,402 tokens in this conversation ▰▰▰▰▰▰▰▰▱▱ tool output 78% shorter')
  })

  it('fills as pi plays it: from nothing to the number, never past it', () => {
    const frame = (progress: number) => savedCard(saved, { lines: true, progress })!.split('\n')
    expect(frame(0).slice(1)).toEqual(['▗▛░░▜▖ TokenWise · saved 0 tokens in this conversation', '▐····▌ ▱▱▱▱▱▱▱▱▱▱ tool output 78% shorter'])
    const counts = [0, 0.2, 0.4, 0.6, 0.8, 1].map(p => Number(/saved ([\d,]+)/u.exec(frame(p)[1]!)![1]!.replace(/,/gu, '')))
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(counts.at(-1)).toBe(2402)
    expect(frame(2)).toEqual(frame(1))
  })

  it('says nothing for a conversation that saved nothing', () => {
    expect(savedCard({ savedTokens: 0, seenTokens: 400 }, { lines: true })).toBeUndefined()
    expect(savedCard({ savedTokens: -50, seenTokens: 400 })).toBeUndefined()
  })
})
