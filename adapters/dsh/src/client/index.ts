/**
 * TokenWise for DeepSeek Harness, browser half: the `mode` setting on the
 * bundle's page in Plugins, the self-evolution section below it (./evolve.ts),
 * a toast when a learning run ends, and on a conversation's page a toast when
 * its turn saved more (./saved.ts). It edits the live `mode` field of the `tokenwise`
 * profile entry through the Web client's shared configuration form, so a save
 * applies to the next tool result without a restart. The page exists while
 * the Host serves that entry, i.e. while the bundle is switched on.
 */
import { SettingsFormModel } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-ui-primitives'
import { en } from './locales.ts'
import type { Copy } from './locales.ts'
import { MODE_FIELD } from './mode.ts'
import { EvolveSection, EvolveToast } from './evolve.ts'
import { SavedToast } from './saved.ts'
import { TokenWiseConfig } from './page.ts'
import type { ConfigState } from './page.ts'

/** The package name: the key of its bundle page. */
const PACKAGE = '@tokenwise/dsh'
/** The profile entry the bundle patch inserts; its id is the configuration namespace. */
const ENTRY = 'tokenwise'
/** Dictionary namespace owned by this plugin. */
const NS = 'tokenwise.settings'

/** What this page needs from the Web client: slots, the locale registry, and the shared configuration forms. */
export const inject = ['slots', 'locale', 'configForms']

interface ClientContext {
  effect(execute: () => () => void, label?: string): void
  readonly locale: { bind(ns: string): (key: string) => string; register(ns: string, dictionaries: Record<string, Copy>): () => void }
  readonly configForms: { get(ns: string): unknown; whileServed(namespaces: readonly string[], register: (served: Set<string>) => () => void): () => void }
  readonly slots: {
    inject(name: string, register: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

export function apply(ctx: ClientContext): void {
  // English in every DSH language: TokenWise shows English whatever the locale.
  ctx.effect(() => ctx.locale.register(NS, { en, zh: en }), 'tokenwise: dictionaries')
  const form = new SettingsFormModel<unknown>(ctx.configForms.get(ENTRY), [MODE_FIELD])
  const store: SnapshotStore<ConfigState> = form.bind(() => ({ ...form.shell(), mode: form.field('mode') }))
  ctx.effect(() => () => form.dispose(), 'tokenwise: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => {
    const disposers = [
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE,
        locale: NS,
        inject: () => ({ hooks: { tokenwiseConfig: store }, ...form.actions() }),
      }, TokenWiseConfig)),
      // Self-evolution: a section on this bundle's page, and a toast anywhere when a run ends.
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({ name: 'plugins.detail.section', id: 'tokenwise.evolve', order: 10, locale: NS }, EvolveSection)),
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'tokenwise.evolve-toast', order: 50, locale: NS }, EvolveToast)),
      // What a turn saved: on the conversation's own page, which DSH renders for the Session on screen.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'tokenwise.saved-toast', order: 50, locale: NS }, SavedToast)),
    ]
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }), 'tokenwise: plugin page')
}
