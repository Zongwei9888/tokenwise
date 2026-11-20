/**
 * `tokenwise notice <host> --session ID`: what TokenWise saved in one
 * conversation, for the end of a turn. Said only when the number grew since it
 * was last said (@tokenwise/mechanisms keeps that number on disk), so a turn
 * that saved nothing shows nothing.
 */
import { markSavingsTold, savedCard, untoldSavings } from '@tokenwise/mechanisms'
import type { CardStyle } from '@tokenwise/mechanisms'
import { cliContext } from './context.ts'

/**
 * How each agent shows the card (@tokenwise/mechanisms savedCard), as seen in each one's real terminal UI
 * (2026-11-19). All six keep the lines. Claude Code, Codex, CodeBuddy and Hermes show the colour; Copilot drops
 * it and Grok prints the escape codes as text, so those two get none; Grok also trims the card's leading space. Claude Code ("Stop says:") and Codex
 * ("↳ Hook ·") put a label before the first line, so the card starts below it.
 */
export const CARD_STYLE: Readonly<Record<string, CardStyle>> = {
  claude: { lines: true, breakFirst: true, color: true },
  codex: { lines: true, breakFirst: true, color: true },
  codebuddy: { lines: true, color: true },
  grok: { lines: true, trimmed: true },
  copilot: { lines: true },
  hermes: { lines: true, color: true },
}

/**
 * The card to show at the end of this turn, or undefined: nothing saved yet,
 * nothing more since it was last said, or TokenWise switched off. With `peek`
 * it is left to be said again (a plugin marks it told once shown, with `told`).
 */
export function conversationNotice(host: string, sessionId: string | undefined, env: NodeJS.ProcessEnv = process.env,
  options: { peek?: boolean; told?: boolean } = {}): string | undefined {
  if (!sessionId || env.TOKENWISE_DISABLE === '1') return undefined
  const context = cliContext({ env })
  const savings = untoldSavings(id => context.readJournal({ host, sessionId: id }), context.dataDirs, host, sessionId)
  const style = CARD_STYLE[host] ?? {}
  const line = savings && savedCard(savings, env.NO_COLOR ? { ...style, color: false } : style)
  if (!savings || !line) return undefined
  const writable = options.peek ? undefined : context.writable()
  if (writable) markSavingsTold(writable.dataDir, host, sessionId, savings.savedTokens)
  return options.told ? undefined : line
}
