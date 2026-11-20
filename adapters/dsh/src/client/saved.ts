/**
 * The toast that says what TokenWise saved in a conversation after one of its
 * turns. It lives on the conversation's own page (a `conversation.composer.dock`
 * entry, which DSH renders for the Session on screen and hands its
 * `sessionId`), and asks the Host about that Session only, so it never speaks
 * of another conversation as "this" one. The Host says it once, when the
 * number grew since it was last said (../learning.ts, ../index.ts).
 */
import { useEffect, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import type { Translate } from './evolve.ts'
import { useToastTurn } from './turns.ts'

/** How often the conversation on screen asks; the Host answers from memory until a turn has ended. */
export const SAVED_POLL_MS = 3000

/** What TokenWise saved in a conversation, after one of its turns: the same words as in every other agent. */
export function savedText(t: Translate, saved: { savedTokens: number; seenTokens: number }): string | undefined {
  if (!(saved.savedTokens > 0)) return undefined
  const share = saved.seenTokens > 0 ? 100 * saved.savedTokens / saved.seenTokens : 0
  return t(share >= 1 ? 'toastSaved' : 'toastSavedLittle', { tokens: Math.round(saved.savedTokens).toLocaleString('en-US'), percent: Math.round(share) })
}

export function SavedToast({ t, sessionId }: { t: Translate; sessionId?: string }): unknown {
  const [notice, setNotice] = useState<{ key: string; text: string } | undefined>(undefined)
  useEffect(() => {
    if (!sessionId) return undefined
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const { saved } = await api.saved(sessionId)
        const text = saved ? savedText(t, saved) : undefined
        if (alive && text) setNotice({ key: `saved:${sessionId}:${saved!.savedTokens}`, text })
      } catch { /* The Host is away; try later. */ }
      if (alive) timer = setTimeout(() => { void poll() }, SAVED_POLL_MS)
    }
    timer = setTimeout(() => { void poll() }, SAVED_POLL_MS)
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [sessionId])
  // After any toast already showing (a learning notice can arrive with the same turn's end).
  const turn = useToastTurn(notice?.key)
  if (!notice || !turn.mine) return null
  return jsx(Toast, { key: notice.key, text: notice.text, holdMs: 6000, tone: 'success', onDone: () => { turn.done(); setNotice(undefined) } })
}
