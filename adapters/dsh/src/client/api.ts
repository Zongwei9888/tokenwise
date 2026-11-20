/**
 * The browser half's calls to the Host's /api/tokenwise routes (./learning.ts
 * on the Host). Paths are relative, so they resolve under whatever base the
 * Web client is served from, the Desktop app included.
 */
import type { LearningPayload } from '../learning.ts'

export type { LearningPayload }
export type RulesAction = 'off' | 'on' | 'rollback'
export interface ReadyCommand { readonly command: string; readonly cases: number; readonly leftTokens: number }

async function call<T>(path: string, init?: { method: 'POST'; body?: unknown }): Promise<T> {
  const response = await fetch(`api/tokenwise/${path}`, {
    method: init?.method ?? 'GET', credentials: 'same-origin',
    ...init?.body === undefined ? {} : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } },
  })
  if (!response.ok && response.status !== 500) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

export const api = {
  /** `refresh`: look at the evidence again now (when the page opens). */
  status: (refresh = false) => call<LearningPayload>(refresh ? 'status?refresh=1' : 'status'),
  learn: () => call<{ ok: true; runId: string } | { ok: false; error: string }>('learn', { method: 'POST' }),
  cancel: () => call<{ ok: boolean }>('cancel', { method: 'POST' }),
  rules: (action: RulesAction) => call<{ ok: boolean; active: string | null }>('rules', { method: 'POST', body: { action } }),
  /** Shown once each: a run that ended, or commands now worth learning from. */
  announcement: () => call<{ run: LearningPayload['evolve']['run'] | null; ready?: ReadyCommand[] | null }>('announcement', { method: 'POST' }),
  /** What this conversation saved, once it grew since it was last said; null otherwise. */
  saved: (sessionId: string) => call<{ saved: { savedTokens: number; seenTokens: number } | null }>('saved', { method: 'POST', body: { sessionId } }),
}

/** 1234 → "1.2k", as the terminal hosts print it. */
export function formatTokens(value: number): string {
  const n = Math.abs(value)
  return n >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))
}
