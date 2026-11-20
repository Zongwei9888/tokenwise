/**
 * What TokenWise saved in a conversation, at the end of a turn, as a small card:
 * the jar `tokenwise saved` draws, three rows tall: a mint jar of gold coins, the
 * tokens saved, and a bar for how much shorter that made the tool output.
 *
 *      ▗▄▄▖
 *     ▗▛●░▜▖ TokenWise · saved 2,402 tokens in this conversation
 *     ▐●●●●▌ ▰▰▰▰▰▰▰▰▱▱ tool output 78% shorter
 *
 * Always in English, whatever the locale (the person's decision, 2026-11-20).
 *
 * Agents show it differently, so the style says what this one can take: colour
 * (where escape codes reach the terminal), several lines, a title of its own (an
 * OpenCode toast has one), a label it puts before the first line. `progress`
 * draws one frame of the fill pi plays: the number counts up, the jar and the
 * bar fill.
 */
import type { EconomySummary } from './receipts.ts'

export interface CardStyle {
  /** ANSI colour: only where the agent hands escape codes to the terminal. */
  readonly color?: boolean
  /** The three-row card; otherwise one line. */
  readonly lines?: boolean
  /** Start on a line of its own: the agent puts a label before the first line. */
  readonly breakFirst?: boolean
  /** Leave out "TokenWise": the agent shows it as the title. */
  readonly untitled?: boolean
  /** One frame of the fill, 0 to 1; 1 (the default) is the card as it stays. */
  readonly progress?: number
}

type Rgb = readonly [number, number, number]
// TokenWise's colours (Cyber Mint): a mint jar of gold coins on ink, as in the logo.
const FRAME: Rgb = [62, 178, 152]
const FILL: readonly Rgb[] = [[255, 210, 74], [224, 165, 0]]
const EMPTY: Rgb = [52, 66, 62]
const MINT: Rgb = [79, 227, 193]
const BRIGHT: Rgb = [167, 255, 233]
const BAR_OFF: Rgb = [64, 80, 76]

const BAR_CELLS = 10
const JAR_CELLS = 6

/** Ease out: the count slows as it lands. */
const ease = (p: number) => 1 - (1 - p) ** 3

export function savedCard(summary: Pick<EconomySummary, 'savedTokens' | 'seenTokens'>, style: CardStyle = {}): string | undefined {
  const saved = summary.savedTokens
  if (!(saved > 0)) return undefined
  const p = Math.min(1, Math.max(0, style.progress ?? 1))
  const share = summary.seenTokens > 0 ? Math.min(100, 100 * saved / summary.seenTokens) : 0
  const paint = (rgb: Rgb, text: string, bold = false) => style.color ? `\x1b[${bold ? '1;' : ''}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m` : text

  const tokens = Math.round(saved * ease(p)).toLocaleString('en-US')
  const percent = share >= 1 ? `${Math.round(share)}%` : 'under 1%'
  const said = `saved ${paint(BRIGHT, tokens, true)} tokens in this conversation`
  const shorter = `tool output ${percent} shorter`
  const title = style.untitled ? '' : `${paint(MINT, 'TokenWise', true)} · `

  const filled = Math.round(share / 100 * BAR_CELLS * ease(p))
  const bar = paint(MINT, '▰'.repeat(filled)) + paint(BAR_OFF, '▱'.repeat(BAR_CELLS - filled))
  if (!style.lines) return `${style.breakFirst ? '\n' : ''}${title}${said} ${bar} ${shorter}`

  // Coins fill the jar from the bottom row, one per cell: four below, two in the shoulders; anything saved is at least one.
  const coins = Math.round(Math.max(1, Math.round(share / 100 * JAR_CELLS)) * ease(p))
  const cell = (index: number, empty: string) => index < coins ? paint(FILL[index % 2]!, '●') : paint(EMPTY, empty)
  const lid = paint(FRAME, ' ▗▄▄▖')
  const top = paint(FRAME, '▗▛') + [4, 5].map(i => cell(i, '░')).join('') + paint(FRAME, '▜▖')
  const bottom = paint(FRAME, '▐') + [0, 1, 2, 3].map(i => cell(i, '·')).join('') + paint(FRAME, '▌')
  return [`${style.breakFirst ? '\n' : ''}${lid}`, `${top} ${title}${said}`, `${bottom} ${bar} ${shorter}`].join('\n')
}
