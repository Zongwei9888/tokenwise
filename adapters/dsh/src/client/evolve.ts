/**
 * The "Self-evolution" section on TokenWise's Plugins page, and the toast when
 * a learning run ends. `EvolveView` is a pure function of what the Host
 * reports (so tests render it without a browser); `EvolveSection` and
 * `EvolveToast` add the polling and the actions. Built from the Web client's
 * own primitives and `--dsw-alias-*` tokens, so it follows the app's theme.
 */
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { Button, StateDot, Switch, Tag, TextShimmer, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EvolveOutcome, EvolveRunStatus } from '@tokenwise/mechanisms'
import { api, formatTokens } from './api.ts'
import type { LearningPayload, ReadyCommand } from './api.ts'
import type { Copy } from './locales.ts'
import { useToastTurn } from './turns.ts'

export type Translate = (key: keyof Copy, params?: Record<string, string | number>) => string

/** One element: `h('div', { style }, child, child)`; null and false children are dropped. */
function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown {
  const kept = children.flat().filter(child => child !== null && child !== undefined && child !== false)
  const all = { ...props ?? {} }
  if (kept.length === 1) return jsx(type, { ...all, children: kept[0] })
  if (kept.length > 1) return jsxs(type, { ...all, children: kept })
  return jsx(type, all)
}

// ——— Styles: tokens only, so light and dark themes both hold. ———
const text = { primary: 'var(--dsw-alias-label-primary)', secondary: 'var(--dsw-alias-label-secondary)', tertiary: 'var(--dsw-alias-label-tertiary)' }
const mono = 'var(--dsw-font-markdown-code-block-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)'
const hairline = '0.5px solid var(--dsw-alias-border-l3)'
const S = {
  section: { display: 'flex', flexDirection: 'column', gap: '12px' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
  headLeft: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  title: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 500, color: text.primary },
  chip: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', lineHeight: '18px', color: text.secondary, fontVariantNumeric: 'tabular-nums' },
  intro: { margin: 0, fontSize: '12.5px', lineHeight: '19px', color: text.tertiary, maxWidth: '680px' },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' },
  tile: { border: hairline, borderRadius: '12px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  tileLabel: { fontSize: '12px', lineHeight: '16px', color: text.tertiary },
  tileValue: { fontSize: '20px', lineHeight: '26px', fontWeight: 600, color: text.primary, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' },
  card: { border: hairline, borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  soft: { background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
  cardTitle: { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 500, color: text.primary },
  body: { margin: 0, fontSize: '12.5px', lineHeight: '19px', color: text.secondary },
  note: { margin: 0, fontSize: '12px', lineHeight: '18px', color: text.tertiary },
  buttons: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  steps: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  step: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', lineHeight: '18px' },
  connector: { width: '28px', height: '0.5px', background: 'var(--dsw-alias-border-l4)' },
  facts: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: '16px', rowGap: '6px', margin: 0, fontSize: '12.5px', lineHeight: '18px' },
  dt: { color: text.tertiary },
  dd: { margin: 0, color: text.primary, minWidth: 0, fontVariantNumeric: 'tabular-nums' },
  list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' },
  row: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', alignItems: 'center', gap: '14px', padding: '7px 0', borderTop: hairline },
  rowFirst: { borderTop: 0 },
  code: { fontFamily: mono, fontSize: '12.5px', color: text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { fontSize: '12px', color: text.tertiary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  barTrack: { width: '96px', height: '6px', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-2)', boxShadow: 'inset 0 0 0 0.5px var(--dsw-alias-border-l3)', overflow: 'hidden' },
  barFill: { display: 'block', height: '100%', borderRadius: '3px', background: 'var(--dsw-alias-label-tertiary)' },
  saved: { fontSize: '12.5px', color: 'var(--dsw-alias-state-success-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  inline: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  message: { margin: 0, fontSize: '12.5px', lineHeight: '18px' },
} as const

export interface ViewProps {
  readonly t: Translate
  readonly payload: LearningPayload | undefined
  /** The Host did not answer. */
  readonly unreachable: boolean
  readonly now: number
  readonly confirming: boolean
  readonly busy: boolean
  readonly message?: { readonly tone: 'success' | 'error'; readonly text: string } | undefined
  readonly onLearn: () => void
  readonly onConfirm: () => void
  readonly onBack: () => void
  readonly onCancel: () => void
  readonly onToggle: (next: boolean) => void
  readonly onRollback: () => void
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function ago(t: Translate, iso: string | undefined, now: number): string {
  if (!iso) return ''
  const minutes = Math.round((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return t('justNow')
  const span = minutes < 60 ? t('minutes', { n: minutes }) : minutes < 48 * 60 ? t('hours', { n: Math.round(minutes / 60) }) : t('days', { n: Math.round(minutes / 1440) })
  return t('ago', { t: span })
}

/** How a run ended, in the reader's language. */
export function outcomeText(t: Translate, outcome: EvolveOutcome): string {
  const rules = outcomeRules(outcome).join(', ') || '—'
  switch (outcome.result) {
    case 'adopted': return outcome.generalization?.status === 'confirmed'
      ? t('outcomeAdoptedConfirmed', { rules, gain: formatTokens(outcome.gainTokens ?? 0), cases: outcome.cases ?? 0, held: outcome.generalization.heldOutCases })
      : t('outcomeAdopted', { rules, gain: formatTokens(outcome.gainTokens ?? 0), cases: outcome.cases ?? 0 })
    case 'rejected': return t('outcomeRejected', { reasons: (outcome.reasons ?? []).map(reason => t(`reason.${reason}` as keyof Copy)).join(t('listSeparator')) })
    case 'unchanged': return t('outcomeUnchanged')
    case 'nothing-to-learn': return t('outcomeNothing')
    case 'cancelled': return t('outcomeCancelled')
    case 'interrupted': return t('outcomeInterrupted')
    case 'failed': return t('outcomeFailed', { error: outcome.error ?? '' })
    case 'dry-run': return t('outcomeDryRun')
  }
}

/** The rules an outcome is about: what the run added or changed, else all it holds (as `outcomeRules` on the Host). */
const outcomeRules = (outcome: EvolveOutcome): readonly string[] => {
  const touched = outcome.changes ? [...outcome.changes.added, ...outcome.changes.changed] : []
  return touched.length ? touched : outcome.rules ?? []
}

const outcomeTone = (outcome: EvolveOutcome) => outcome.result === 'adopted' ? 'success'
  : outcome.result === 'failed' || outcome.result === 'interrupted' ? 'danger' : outcome.result === 'rejected' ? 'warning' : 'neutral'

const ERRORS = new Set(['running', 'no-runner', 'no-node', 'no-dsh', 'spawn-failed'])
/** A Host error code in the reader's language; anything else (an unexpected failure) as the generic one. */
export function errorText(t: Translate, code: string): string {
  return ERRORS.has(code) ? t(`error.${code}` as keyof Copy) : t('error.spawn-failed')
}

function Tile(label: string, value: unknown, key: string, tone?: 'success') {
  return h('div', { key, style: S.tile, 'data-tokenwise-tile': key },
    h('span', { style: S.tileLabel }, label),
    h('span', { style: tone === 'success' ? { ...S.tileValue, color: 'var(--dsw-alias-state-success-primary)' } : S.tileValue }, value))
}

export function EvolveView(p: ViewProps): unknown {
  const { t } = p
  if (!p.payload) {
    return h('section', { style: S.section, 'data-tokenwise-evolve': 'loading' },
      h('h4', { style: S.title }, t('evolveTitle')),
      h('p', { style: S.intro }, p.unreachable ? t('unreachable') : t('evolveIntro')))
  }
  const { evolve, learner } = p.payload
  const { run, scan, rules } = evolve
  const running = run?.running === true
  const canLearn = 'label' in learner && !running

  const chip = running
    ? h('span', { style: S.chip, 'data-tokenwise-state': 'learning' }, jsx(StateDot, { state: 'ongoing', size: 8 }),
      jsx(TextShimmer, { active: true, children: `${t(run!.phase === 'verifying' ? 'stateVerifying' : 'stateLearning')} ${elapsed(p.now - Date.parse(run!.startedAt))}` }))
    : scan?.ready ? h('span', { style: S.chip, 'data-tokenwise-state': 'ready' }, jsx(StateDot, { state: 'warning', size: 8 }), t('stateReady'))
      : rules.active ? h('span', { style: S.chip, 'data-tokenwise-state': 'active' }, jsx(StateDot, { state: 'done', size: 8 }), t('stateActive'))
        : h('span', { style: S.chip, 'data-tokenwise-state': 'collecting' }, jsx(StateDot, { state: 'idle', size: 8 }), t('stateCollecting'))

  const action = running
    ? jsx(Button, { variant: 'outline', size: 'sm', disabled: p.busy, onClick: p.onCancel, 'data-tokenwise-action': 'cancel', children: t('cancel') })
    : canLearn && !p.confirming ? jsx(Button, { variant: 'primary', size: 'sm', disabled: p.busy, onClick: p.onLearn, 'data-tokenwise-action': 'learn', children: t('learnNow') }) : null

  const uses = new Map((scan?.rules ?? []).map(use => [use.id, use]))
  const learnedSaved = [...uses.values()].reduce((sum, use) => sum + use.savedTokens, 0)

  const tiles = h('div', { style: S.tiles },
    Tile(t('tileRules'), t('tileRulesValue', { n: rules.rules.length }), 'rules'),
    Tile(t('tileSaved'), learnedSaved > 0 ? `−${formatTokens(learnedSaved)}` : '—', 'saved', learnedSaved > 0 ? 'success' : undefined),
    Tile(t('tileEvidence'), scan ? String(scan.evidence) : '—', 'evidence'))

  const confirm = p.confirming && 'label' in learner ? h('div', { style: S.soft, 'data-tokenwise-confirm': '' },
    h('p', { style: S.cardTitle }, t('confirmTitle', { learner: learner.label })),
    h('p', { style: S.body }, t('confirmBody')),
    h('div', { style: S.buttons },
      jsx(Button, { variant: 'primary', size: 'sm', disabled: p.busy, onClick: p.onConfirm, 'data-tokenwise-action': 'confirm', children: t('confirmStart') }),
      jsx(Button, { variant: 'ghost', size: 'sm', disabled: p.busy, onClick: p.onBack, children: t('confirmBack') }))) : null

  let progress: unknown = null
  if (running) {
    const order = ['starting', 'preparing', 'learning', 'verifying']
    const at = Math.max(1, order.indexOf(run!.phase))
    const step = (label: string, index: number) => h('span', { key: label, style: { ...S.step, color: at >= index ? text.primary : text.tertiary } },
      jsx(StateDot, { state: at > index ? 'done' : at === index ? 'ongoing' : 'idle', appearance: 'step', size: 14 }), label)
    const last = run!.lastCheck
    progress = h('div', { style: S.card, 'data-tokenwise-progress': run!.phase },
      h('div', { style: S.steps }, step(t('stepPrepare'), 1), h('span', { key: 'c1', style: S.connector }), step(t('stepLearn'), 2),
        h('span', { key: 'c2', style: S.connector }), step(t('stepVerify'), 3)),
      h('dl', { style: S.facts },
        h('dt', { style: S.dt }, t('runLearner')),
        h('dd', { style: S.dd }, run!.learner, run!.shown ? h('span', { style: { color: text.tertiary } }, ` · ${t('runReading', { shown: run!.shown, evidence: run!.evidence ?? run!.shown })}`) : null),
        run!.checks > 0 ? h('dt', { style: S.dt }, t('runChecks')) : null,
        run!.checks > 0 ? h('dd', { style: S.dd }, t('runChecksValue', { n: run!.checks }), ' · ',
          last?.accepted ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, t('runCheckPass', { gain: formatTokens(last.gainTokens ?? 0) }))
            : h('span', { style: { color: text.secondary } }, t('runCheckFail'))) : null),
      h('p', { style: S.note }, t('runBackground')))
  }

  const opportunities = scan?.opportunities ?? []
  const max = opportunities[0]?.leftTokens ?? 0
  const worth = running ? null : h('div', { style: S.card, 'data-tokenwise-worth': '' },
    h('p', { style: S.cardTitle }, t('worthTitle')),
    opportunities.length === 0 ? h('p', { style: S.note }, t('worthNone'))
      : h('ul', { style: S.list }, opportunities.slice(0, 5).map((item, i) => h('li', { key: item.command, style: i === 0 ? { ...S.row, ...S.rowFirst } : S.row },
        h('span', { style: S.inline }, h('code', { style: S.code }, item.command), h('span', { style: S.meta }, t('worthOutputs', { n: item.cases }))),
        h('span', { style: S.barTrack, 'aria-hidden': 'true' }, h('span', { style: { ...S.barFill, width: `${Math.max(8, Math.round(item.leftTokens / max * 100))}%` } })),
        h('span', { style: S.meta }, t('worthLeft', { n: formatTokens(item.leftTokens) }))))))

  const rulesCard = h('div', { style: S.card, 'data-tokenwise-rules': rules.active ?? 'none' },
    h('div', { style: S.cardHead },
      h('p', { style: S.cardTitle }, t('rulesTitle')),
      rules.active || rules.history > 0 ? h('span', { style: S.inline },
        h('span', { style: S.meta }, t('rulesUse')),
        jsx(Switch, { checked: rules.active !== null, label: t('rulesUse'), disabled: p.busy, onChange: p.onToggle }),
        rules.active ? jsx(Button, { variant: 'ghost', size: 'sm', disabled: p.busy, onClick: p.onRollback, 'data-tokenwise-action': 'rollback', children: t('rulesRollback') }) : null) : null),
    p.payload.learnedRulesOff ? h('p', { style: { ...S.note, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' } }, t('rulesConfigOff')) : null,
    rules.active && rules.rules.length > 0
      ? h('ul', { style: S.list }, rules.rules.map((rule, i) => {
        const use = uses.get(rule.id)
        return h('li', { key: rule.id, style: i === 0 ? { ...S.row, ...S.rowFirst } : S.row, 'data-tokenwise-rule': rule.id },
          h('span', { style: S.inline }, h('code', { style: S.code }, rule.id), jsx(Tag, { tone: 'neutral', children: rule.transformation })),
          use && use.originalRecalls > 0 ? h('span', { title: t('rulesRecallsHint') }, jsx(Tag, { tone: 'warning', children: t('rulesRecalls', { n: use.originalRecalls }) })) : h('span', null),
          use && use.projections > 0 ? h('span', { style: S.inline }, h('span', { style: S.meta }, t('rulesUses', { n: use.projections })), h('span', { style: S.saved }, `−${formatTokens(use.savedTokens)}`))
            : h('span', { style: S.meta }, t('rulesUnused')))
      }))
      : h('p', { style: S.note }, rules.history > 0 ? t('rulesOffHistory') : t('rulesNone')),
    ...(scan?.disabled ?? []).map(item => h('p', { key: `off-${item.id}`, style: { ...S.note, color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' } }, t('switchedOff', { id: item.id, recalls: item.recalls, uses: item.uses }))))

  const last = run && !running && run.outcome ? h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '12.5px', lineHeight: '19px' }, 'data-tokenwise-last': run.outcome.result },
    h('span', { style: { color: text.tertiary } }, t('lastTitle')),
    jsx(Tag, { tone: outcomeTone(run.outcome), children: t(`result.${run.outcome.result}` as keyof Copy) }),
    h('span', { style: { color: text.secondary, minWidth: 0 } }, outcomeText(t, run.outcome)),
    h('span', { style: S.meta }, `· ${ago(t, run.finishedAt, p.now)}`)) : null

  const unavailable = 'unavailable' in learner && !running ? h('p', { style: S.note }, errorText(t, learner.unavailable)) : null
  const message = p.message ? h('p', { role: 'status', style: { ...S.message, color: p.message.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, p.message.text) : null

  return h('section', { style: S.section, 'data-tokenwise-evolve': running ? 'running' : 'idle' },
    h('div', { style: S.head }, h('div', { style: S.headLeft }, h('h4', { style: S.title }, t('evolveTitle')), chip), action),
    h('p', { style: S.intro }, t('evolveIntro')),
    tiles, confirm, message, unavailable, progress, worth, rulesCard, last)
}

interface SectionProps {
  readonly t: Translate
  readonly subject?: { readonly kind: string; readonly pkg?: { readonly name: string } }
}

/** How often the page asks the Host: often while a run goes, rarely otherwise. */
export const POLL_RUNNING_MS = 1500
export const POLL_IDLE_MS = 5000

export function EvolveSection(props: SectionProps): unknown {
  if (props.subject && (props.subject.kind === 'item' || props.subject.pkg?.name !== '@tokenwise/dsh')) return null
  return jsx(EvolveLive, { t: props.t })
}

function EvolveLive({ t }: { t: Translate }): unknown {
  const [payload, setPayload] = useState<LearningPayload | undefined>(undefined)
  const [unreachable, setUnreachable] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<ViewProps['message']>(undefined)
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const opened = useRef(true)
  const refresh = async () => {
    if (timer.current) clearTimeout(timer.current)
    let next: LearningPayload | undefined
    const first = opened.current
    opened.current = false
    try { next = await api.status(first); if (alive.current) { setPayload(next); setUnreachable(false) } } catch { if (alive.current) setUnreachable(true) }
    if (!alive.current) return
    setNow(Date.now())
    timer.current = setTimeout(() => { void refresh() }, next?.evolve.run?.running ? POLL_RUNNING_MS : POLL_IDLE_MS)
  }
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current) }
  }, [])
  // The elapsed time ticks every second while a run goes.
  const running = payload?.evolve.run?.running === true
  useEffect(() => {
    if (!running) return undefined
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [running])

  const act = async (work: () => Promise<ViewProps['message'] | undefined>) => {
    setBusy(true)
    setMessage(undefined)
    try { const result = await work(); if (alive.current) setMessage(result) } catch { if (alive.current) setMessage({ tone: 'error', text: t('unreachable') }) }
    if (alive.current) setBusy(false)
    await refresh()
  }

  return EvolveView({
    t, payload, unreachable, now, confirming, busy, message,
    onLearn: () => { setMessage(undefined); setConfirming(true) },
    onBack: () => setConfirming(false),
    onConfirm: () => { setConfirming(false); void act(async () => { const started = await api.learn(); return started.ok ? undefined : { tone: 'error', text: errorText(t, started.error) } }) },
    onCancel: () => { void act(async () => { await api.cancel(); return undefined }) },
    onToggle: next => { void act(async () => { await api.rules(next ? 'on' : 'off'); return undefined }) },
    onRollback: () => { void act(async () => { await api.rules('rollback'); return { tone: 'success', text: t('rolledBack') } }) },
  })
}

/** How often the toast asks whether a run has ended. */
export const ANNOUNCE_MS = 8000

/** Text of the toast for a finished run, or undefined for runs not worth one. */
export function toastText(t: Translate, run: EvolveRunStatus): string | undefined {
  const outcome = run.outcome
  if (!outcome || outcome.result === 'nothing-to-learn') return undefined
  if (outcome.result === 'adopted') return t('toastAdopted', { rules: outcomeRules(outcome).join(', '), gain: formatTokens(outcome.gainTokens ?? 0) })
  return t('toastFinished', { tag: t(`result.${outcome.result}` as keyof Copy), result: outcomeText(t, outcome) })
}

/** Text of the toast for commands newly worth learning from. */
export function readyText(t: Translate, ready: readonly ReadyCommand[]): string | undefined {
  if (!ready.length) return undefined
  const shown = ready.slice(0, 3).map(item => item.command)
  return t('toastReady', { commands: shown.join(', '), tokens: formatTokens(ready.reduce((sum, item) => sum + item.leftTokens, 0)) })
}

type Notice = { readonly key: string; readonly text: string; readonly success: boolean }

export function EvolveToast({ t }: { t: Translate }): unknown {
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const { run, ready } = await api.announcement()
        const text = run ? toastText(t, run) : ready ? readyText(t, ready) : undefined
        if (alive && text) setNotice({ key: run ? run.runId : `ready:${Date.now()}`, text, success: run?.outcome?.result === 'adopted' })
      } catch { /* The Host is away; try later. */ }
      if (alive) timer = setTimeout(() => { void poll() }, ANNOUNCE_MS)
    }
    timer = setTimeout(() => { void poll() }, 1500)
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [])
  // One toast at a time: DSH draws them all in one place.
  const turn = useToastTurn(notice?.key)
  if (!notice || !turn.mine) return null
  return jsx(Toast, { key: notice.key, text: notice.text, holdMs: notice.key.startsWith('ready:') ? 9000 : 6000, ...notice.success ? { tone: 'success' } : {},
    onDone: () => { turn.done(); setNotice(undefined) } })
}
