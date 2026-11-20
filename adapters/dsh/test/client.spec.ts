/**
 * The browser half exactly as the DSH Web client loads it: the built
 * lib/client.js registers a factory with `window.__ModuleLoader__`, which is
 * called with the page's `require`. React and the client primitives are
 * stand-ins that record the element tree.
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { MODE_FIELD } from '../src/client/mode.ts'

interface Element { type: unknown; props: Record<string, unknown> }
const element = (type: unknown, props: Record<string, unknown>): Element => ({ type, props })

class FakeFormModel {
  static last: FakeFormModel | undefined
  disposed = false
  state = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false, mode: { text: 'apply', overridden: false, invalid: false } }
  readonly scope: unknown
  constructor(scope: unknown) { this.scope = scope; FakeFormModel.last = this }
  bind(project: () => unknown) { return { getSnapshot: project, subscribe: () => () => {} } }
  shell() { const { mode: _, ...shell } = this.state; return shell }
  field() { return this.state.mode }
  actions() { return { edit: (...args: unknown[]) => this.calls.push(['edit', ...args]), resetField: (...args: unknown[]) => this.calls.push(['reset', ...args]), save: () => {}, discard: () => {} } }
  dispose() { this.disposed = true }
  calls: unknown[][] = []
}

const modules: Record<string, unknown> = {
  'react/jsx-runtime': { jsx: element, jsxs: element },
  'react': { useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) },
  '@deepseek-ai/dsh-client-ui-primitives': { SettingsFormModel: FakeFormModel, SettingsForm: 'SettingsForm', SegmentedControl: 'SegmentedControl', Tag: 'Tag',
    Button: 'Button', StateDot: 'StateDot', Switch: 'Switch', TextShimmer: 'TextShimmer', Toast: 'Toast' },
}

function load() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registered: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
  runInNewContext(source, { window: { __ModuleLoader__: { load: (entry: typeof registered) => { registered = entry } } } })
  const requested: string[] = []
  const exports = registered!.factory(id => { requested.push(id); if (!(id in modules)) throw new Error(`unexpected module ${id}`); return modules[id] })
  return { id: registered!.id, exports, requested }
}

function mount() {
  const { exports } = load()
  const effects: (() => void)[] = []
  const registrations: { options: Record<string, unknown>; component: (props: Record<string, unknown>) => unknown }[] = []
  let served: ((served: Set<string>) => () => void) | undefined
  let watched: readonly string[] = []
  const dictionaries: Record<string, Record<string, Record<string, string>>> = {}
  const ctx = {
    effect: (execute: () => () => void) => { effects.push(execute()) },
    locale: { bind: () => (key: string) => key, register: (ns: string, value: Record<string, Record<string, string>>) => { dictionaries[ns] = value; return () => {} } },
    configForms: { get: (ns: string) => ({ ns }), whileServed: (namespaces: readonly string[], register: (served: Set<string>) => () => void) => { watched = namespaces; served = register; return () => {} } },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => { registrations.push({ options, component }); return () => {} },
    },
  }
  ;(exports.apply as (ctx: unknown) => void)(ctx)
  return { exports, effects, registrations, dictionaries, ctx, watched: () => watched, serve: () => served!(new Set(['tokenwise'])) }
}

describe('DSH browser half', () => {
  it('registers under the package name and asks only for shared modules', () => {
    const { id, exports, requested } = load()
    expect(id).toBe('@tokenwise/dsh')
    expect(exports.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(typeof exports.apply).toBe('function')
    expect([...new Set(requested)].sort()).toEqual(['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'])
  })
  it('puts the mode form on the bundle page while the Host serves the tokenwise entry', () => {
    const mounted = mount()
    expect(mounted.watched()).toEqual(['tokenwise'])
    expect(FakeFormModel.last!.scope).toEqual({ ns: 'tokenwise' })
    expect(mounted.registrations).toHaveLength(0)
    mounted.serve()
    expect(mounted.registrations.map(item => item.options)).toEqual([
      expect.objectContaining({ name: 'plugins.bundle.config', key: '@tokenwise/dsh', locale: 'tokenwise.settings' }),
      { name: 'plugins.detail.section', id: 'tokenwise.evolve', order: 10, locale: 'tokenwise.settings' },
      { name: 'shell.overlay', id: 'tokenwise.evolve-toast', order: 50, locale: 'tokenwise.settings' },
      { name: 'conversation.composer.dock', id: 'tokenwise.saved-toast', order: 50, locale: 'tokenwise.settings' },
    ])
    expect(Object.keys(mounted.dictionaries['tokenwise.settings']!).sort()).toEqual(['en', 'zh'])
    // English in every DSH language.
    expect(mounted.dictionaries['tokenwise.settings']!.zh).toEqual(mounted.dictionaries['tokenwise.settings']!.en)
  })
  it('renders a three-way mode control that stages edits, and a reset once overridden', () => {
    const mounted = mount()
    mounted.serve()
    const { options, component } = mounted.registrations[0]!
    const face = (options.inject as () => Record<string, unknown>)()
    const store = (face.hooks as { tokenwiseConfig: { getSnapshot: () => unknown } }).tokenwiseConfig
    const props = { ...face, t: (key: string) => key, view: 'page', useTokenwiseConfig: (select: (state: unknown) => unknown) => select(store.getSnapshot()) }
    const find = (node: unknown, type: unknown): Element[] => {
      if (node === null || typeof node !== 'object') return []
      if (Array.isArray(node)) return node.flatMap(child => find(child, type))
      const el = node as Element
      return [...el.type === type ? [el] : [], ...find(el.props.children, type)]
    }
    let tree = component(props)
    const [control] = find(tree, 'SegmentedControl')
    expect((control!.props.options as { value: string }[]).map(option => option.value)).toEqual(['apply', 'observe', 'off'])
    expect(control!.props.value).toBe('apply')
    ;(control!.props.onChange as (value: string) => void)('observe')
    expect(FakeFormModel.last!.calls).toEqual([['edit', 'mode', 'observe']])
    expect(find(tree, 'button')).toHaveLength(0)
    FakeFormModel.last!.state.mode = { text: 'off', overridden: true, invalid: false }
    tree = component(props)
    expect(find(tree, 'SegmentedControl')[0]!.props.value).toBe('off')
    const [reset] = find(tree, 'button')
    ;(reset!.props.onClick as () => void)()
    expect(FakeFormModel.last!.calls.at(-1)).toEqual(['reset', 'mode'])
    expect(component({ ...props, view: 'summary' })).toBe('summary')
  })
  it('releases its form subscription on unload', () => {
    const mounted = mount()
    for (const dispose of mounted.effects) dispose()
    expect(FakeFormModel.last!.disposed).toBe(true)
  })
  it('stores only the three modes, and an empty draft as a reset', () => {
    expect(MODE_FIELD.parse('observe')).toEqual({ kind: 'set', value: 'observe' })
    expect(MODE_FIELD.parse('')).toEqual({ kind: 'clear' })
    expect(MODE_FIELD.parse('fast')).toBeUndefined()
    expect(MODE_FIELD.format('off')).toBe('off')
    expect(MODE_FIELD.format(undefined)).toBe('')
  })
})
