/**
 * The self-evolution section rendered from what the Host reports. React and
 * the client primitives are stand-ins that record the element tree.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('react/jsx-runtime', () => ({ jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) }))
vi.mock('react', () => ({ useState: (v: unknown) => [v, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'Button', StateDot: 'StateDot', Switch: 'Switch', Tag: 'Tag', TextShimmer: 'TextShimmer', Toast: 'Toast' }))

const { EvolveSection, EvolveView, outcomeText, readyText, toastText } = await import('../src/client/evolve.ts')
const { savedText } = await import('../src/client/saved.ts')
const { en } = await import('../src/client/locales.ts')
type ViewProps = Parameters<typeof EvolveView>[0]

interface El { type: unknown; props: Record<string, unknown> }
const translate = (dict: Record<string, string>) => (key: string, params?: Record<string, string | number>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => params && name in params ? String(params[name]) : match)
const t = translate(en) as ViewProps['t']
const walk = (node: unknown): El[] => {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(walk)
  const el = node as El
  return [el, ...walk(el.props.children)]
}
const textOf = (node: unknown): string => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf((node as El).props.children)
}
const by = (tree: unknown, attribute: string) => walk(tree).filter(el => attribute in el.props)
const now = Date.parse('2026-10-14T12:00:00.000Z')
const noop = () => {}
const base = (payload: Partial<ViewProps['payload']> & object, extra: Partial<ViewProps> = {}): ViewProps => ({
  t, now, unreachable: false, confirming: false, busy: false,
  onLearn: noop, onConfirm: noop, onBack: noop, onCancel: noop, onToggle: noop, onRollback: noop,
  payload: { learner: { label: 'DSH · deepseek-v4-pro' }, learnedRulesOff: false, evolve: { rules: { active: null, rules: [], history: 0 } }, ...payload } as ViewProps['payload'],
  ...extra,
})

describe('self-evolution section', () => {
  it('invites learning when there is something worth learning', () => {
    const onLearn = vi.fn()
    const tree = EvolveView(base({ evolve: { rules: { active: null, rules: [], history: 0 },
      scan: { schemaVersion: 1, time: '', evidence: 69, newEvidence: 12, leftTokens: 9000, ready: true, rules: [], disabled: [],
        opportunities: [{ command: 'cargo', cases: 6, leftTokens: 8400 }, { command: 'npm', cases: 3, leftTokens: 2100 }] } } }, { onLearn }))
    expect(by(tree, 'data-tokenwise-state')[0]!.props['data-tokenwise-state']).toBe('ready')
    expect(textOf(tree)).toContain('Ready to learn')
    expect(textOf(by(tree, 'data-tokenwise-worth'))).toContain('cargo6 outputs~8.4k tokens left')
    expect(textOf(by(tree, 'data-tokenwise-tile'))).toBe('Learned rules0 activeSaved by learned rules—Recorded outputs69')
    const learn = by(tree, 'data-tokenwise-action').find(el => el.props['data-tokenwise-action'] === 'learn')!
    expect(learn.type).toBe('Button')
    ;(learn.props.onClick as () => void)()
    expect(onLearn).toHaveBeenCalled()
  })

  it('asks before learning, naming the learner and what leaves the machine', () => {
    const onConfirm = vi.fn()
    const tree = EvolveView(base({}, { confirming: true, onConfirm }))
    expect(textOf(by(tree, 'data-tokenwise-confirm'))).toContain('Learn with DSH · deepseek-v4-pro?')
    expect(textOf(by(tree, 'data-tokenwise-confirm'))).toContain('sends them to that model\'s provider')
    expect(by(tree, 'data-tokenwise-action').map(el => el.props['data-tokenwise-action'])).toEqual(['confirm'])
    ;(by(tree, 'data-tokenwise-action')[0]!.props.onClick as () => void)()
    expect(onConfirm).toHaveBeenCalled()
  })

  it('shows a run in progress with its steps, learner and checks, and offers cancel', () => {
    const tree = EvolveView(base({ evolve: { rules: { active: null, rules: [], history: 0 },
      run: { schemaVersion: 1, runId: 'r', host: 'dsh', learner: 'DSH · deepseek-v4-pro', pid: 1, startedAt: '2026-10-14T11:57:29.000Z', phase: 'learning',
        evidence: 69, shown: 40, running: true, checks: 2, lastCheck: { time: '', accepted: true, gainTokens: 2628 } } } }))
    expect(textOf(walk(tree).find(el => el.type === 'TextShimmer'))).toBe('Learning 2:31')
    const progress = by(tree, 'data-tokenwise-progress')[0]!
    expect(walk(progress).filter(el => el.type === 'StateDot').map(el => el.props.state)).toEqual(['done', 'ongoing', 'idle'])
    expect(textOf(progress)).toContain('DSH · deepseek-v4-pro · reading 40 of 69 recorded outputs')
    expect(textOf(progress)).toContain('2 so far · last one passes (+2.6k tokens)')
    expect(by(tree, 'data-tokenwise-action').map(el => el.props['data-tokenwise-action'])).toEqual(['cancel'])
    expect(by(tree, 'data-tokenwise-worth')).toEqual([])
  })

  it('lists the learned rules with their use, and switches them off or rolls back', () => {
    const onToggle = vi.fn(), onRollback = vi.fn()
    const tree = EvolveView(base({ evolve: {
      rules: { active: 'a'.repeat(64), rules: [{ id: 'pytest-verbose-passed', transformation: 'noise-removal' }, { id: 'cargo-progress', transformation: 'noise-removal' }], history: 2 },
      scan: { schemaVersion: 1, time: '', evidence: 69, newEvidence: 0, leftTokens: 0, ready: false, opportunities: [],
        rules: [{ id: 'pytest-verbose-passed', projections: 41, savedTokens: 11_200, originalRecalls: 1 }, { id: 'cargo-progress', projections: 0, savedTokens: 0, originalRecalls: 0 }],
        disabled: [{ id: 'npm-noise', reason: 'the agent asked for the original 3 of 10 times it shortened output', recalls: 3, uses: 10 }] },
      run: { schemaVersion: 1, runId: 'r', host: 'dsh', learner: 'x', pid: 1, startedAt: '2026-10-14T11:00:00.000Z', phase: 'done', finishedAt: '2026-10-14T11:03:00.000Z', running: false, checks: 3,
        outcome: { result: 'adopted', rules: ['pytest-verbose-passed', 'cargo-progress'], gainTokens: 2628, cases: 69, generalization: { status: 'confirmed', commands: ['pytest'], heldOutCases: 12, heldOutGain: 300 } } },
    } }, { onToggle, onRollback }))
    expect(by(tree, 'data-tokenwise-state')[0]!.props['data-tokenwise-state']).toBe('active')
    const rows = by(tree, 'data-tokenwise-rule')
    expect(rows.map(el => textOf(el))).toEqual(['pytest-verbose-passednoise-removal1 recalls41×−11.2k', 'cargo-progressnoise-removalnot used yet'])
    expect(textOf(by(tree, 'data-tokenwise-tile'))).toContain('Saved by learned rules−11.2k')
    expect(textOf(by(tree, 'data-tokenwise-rules'))).toContain('Switched off npm-noise: the agent asked for the original 3 of 10 times')
    const toggle = walk(tree).find(el => el.type === 'Switch')!
    expect(toggle.props.checked).toBe(true)
    ;(toggle.props.onChange as (next: boolean) => void)(false)
    expect(onToggle).toHaveBeenCalledWith(false)
    ;(by(tree, 'data-tokenwise-action').find(el => el.props['data-tokenwise-action'] === 'rollback')!.props.onClick as () => void)()
    expect(onRollback).toHaveBeenCalled()
    expect(textOf(by(tree, 'data-tokenwise-last'))).toBe('Last runAdoptedpytest-verbose-passed, cargo-progress: +2.6k tokens on 69 recorded outputs, confirmed on 12 it had not seen· 57 min ago')
  })

  it('explains when it cannot learn or reach the Host', () => {
    expect(textOf(EvolveView(base({ learner: { unavailable: 'no-dsh' } })))).toContain('The dsh command was not found.')
    expect(by(EvolveView(base({ learner: { unavailable: 'no-dsh' } })), 'data-tokenwise-action')).toEqual([])
    expect(textOf(EvolveView({ ...base({}), payload: undefined, unreachable: true }))).toContain('TokenWise is not answering')
  })

  it('appears only on TokenWise\'s own page', () => {
    expect(EvolveSection({ t, subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } })).toBeNull()
    expect(EvolveSection({ t, subject: { kind: 'item' } })).toBeNull()
    expect(EvolveSection({ t, subject: { kind: 'bundle', pkg: { name: '@tokenwise/dsh' } } })).not.toBeNull()
  })

  it('words outcomes and toasts in English', () => {
    const rejected = { result: 'rejected' as const, reasons: ['did-not-generalize', 'replay-token-regression'] }
    expect(outcomeText(t, rejected)).toBe('they only fit the examples the learner saw; they would have saved less on some outputs')
    expect(toastText(t, { schemaVersion: 1, runId: 'r', host: 'dsh', learner: 'x', pid: 1, startedAt: '', phase: 'done', outcome: rejected })).toBe('TokenWise learning: Not adopted — they only fit the examples the learner saw; they would have saved less on some outputs')
    const run = { schemaVersion: 1 as const, runId: 'r', host: 'dsh', learner: 'x', pid: 1, startedAt: '', phase: 'done' as const,
      outcome: { result: 'adopted' as const, rules: ['build-progress', 'compile-progress'], changes: { added: ['compile-progress'], changed: [], removed: [] }, gainTokens: 2628 } }
    expect(toastText(t, run)).toBe('TokenWise learned compile-progress (+2.6k tokens)')
    expect(toastText(t, { ...run, outcome: { result: 'nothing-to-learn' } })).toBeUndefined()
    const ready = [{ command: 'cargo test', cases: 4, leftTokens: 5200 }, { command: 'pytest', cases: 3, leftTokens: 2400 }]
    expect(readyText(t, ready)).toBe('TokenWise can learn from your cargo test, pytest output (~7.6k tokens to save). Start it in Plugins → TokenWise.')
    expect(readyText(t, [])).toBeUndefined()
    // What a conversation saved, in the words every other agent uses.
    expect(savedText(t, { savedTokens: 2973, seenTokens: 3300 })).toBe('TokenWise saved 2,973 tokens in this conversation (tool output 90% shorter)')
    expect(savedText(t, { savedTokens: 40, seenTokens: 900_000 })).toBe('TokenWise saved 40 tokens in this conversation (tool output under 1% shorter)')
    expect(savedText(t, { savedTokens: 0, seenTokens: 10 })).toBeUndefined()
  })
})
