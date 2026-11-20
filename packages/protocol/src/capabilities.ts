/**
 * What a host lets TokenWise do. Adapters declare the capabilities their host
 * offers; each mechanism declares what it needs; `negotiate` picks the
 * strongest mode both sides support and says why. Nothing is enabled by
 * patching a host.
 */
export const CAPABILITIES = {
  journal: 'private append-only TokenWise event log',
  artifacts: 'private store for original tool output',
  tokens: 'token estimate for admission (host meter or the default estimate)',
  toolResults: 'replace a tool result before the model first sees it',
  toolResultsPreserveRaw: 'replace what the model sees while the host session keeps the original',
  toolCalls: 'rewrite tool arguments before execution',
  commandWrapper: 'run shell commands through `tokenwise run`, which filters at the process boundary',
  compaction: 'supply the compaction summary and kept boundary',
  compactionShaping: 'influence, but not supply, the host compaction summary',
  compactionContext: 'add text to the conversation right after the host compacts it (the host writes the summary)',
  context: 'rewrite the message list for each request without persisting it',
  tools: 'register model-callable tools',
  toolVisibility: 'show or hide registered tools per turn',
  models: 'call a configured model or start a sub-agent',
  sessions: 'read host sessions and per-request token usage',
  ui: 'show receipts in the host interface',
} as const

export type Capability = keyof typeof CAPABILITIES

export type MechanismMode = 'off' | 'observe' | 'apply'

export interface MechanismSpec {
  readonly id: string
  readonly summary: string
  /** Needed for any mode other than `off`. */
  readonly requires: readonly Capability[]
  /** Strongest first. A mode is possible when every capability of one `anyOf` alternative is present. */
  readonly modes: readonly { readonly mode: Exclude<MechanismMode, 'off'>; readonly anyOf: readonly (readonly Capability[])[] }[]
}

export interface Negotiation {
  readonly mechanism: string
  readonly mode: MechanismMode
  /** The capabilities the chosen mode runs on. */
  readonly via: readonly Capability[]
  readonly reason: string
}

const rank: Record<MechanismMode, number> = { off: 0, observe: 1, apply: 2 }

/**
 * Pick each mechanism's mode. A user setting can only lower the mode: it can
 * never switch on something the host cannot support.
 */
export function negotiate(specs: readonly MechanismSpec[], available: Iterable<Capability>,
  requested: Readonly<Record<string, MechanismMode | undefined>> = {}): Negotiation[] {
  const have = new Set(available)
  const supported = (spec: MechanismSpec, ceiling: MechanismMode) => {
    for (const option of spec.modes) {
      if (rank[option.mode] > rank[ceiling]) continue
      const via = option.anyOf.find(set => set.every(item => have.has(item)))
      if (via) return { mode: option.mode, via }
    }
    return undefined
  }
  return specs.map((spec): Negotiation => {
    const ceiling = requested[spec.id] ?? 'apply'
    if (ceiling === 'off') return { mechanism: spec.id, mode: 'off', via: [], reason: 'disabled by configuration' }
    const missing = spec.requires.filter(item => !have.has(item))
    if (missing.length) return { mechanism: spec.id, mode: 'off', via: [], reason: `host lacks ${missing.join(', ')}` }
    const chosen = supported(spec, ceiling)
    if (!chosen) {
      const needs = spec.modes.filter(item => rank[item.mode] <= rank[ceiling])
        .map(item => `${item.mode} needs ${item.anyOf.map(set => set.join(' + ')).join(' or ')}`)
      return { mechanism: spec.id, mode: 'off', via: [], reason: needs.length ? needs.join('; ') : 'no permitted mode' }
    }
    const best = supported(spec, 'apply')!
    return { mechanism: spec.id, mode: chosen.mode, via: [...spec.requires, ...chosen.via],
      reason: rank[best.mode] > rank[chosen.mode] ? `limited to ${chosen.mode} by configuration` : `${chosen.mode} via ${chosen.via.join(' + ')}` }
  })
}

/** Token Economy: deterministic projection of shell output. */
export const ECONOMY_SPEC: MechanismSpec = {
  id: 'economy',
  summary: 'shrink recognized shell output before the model sees it',
  requires: ['journal', 'artifacts', 'tokens'],
  modes: [
    { mode: 'apply', anyOf: [['toolResultsPreserveRaw'], ['toolResults'], ['commandWrapper']] },
    { mode: 'observe', anyOf: [['toolResultsPreserveRaw'], ['toolResults'], ['commandWrapper'], ['sessions']] },
  ],
}

/** Presentation-only command rewrites (line numbers, no colour) that make output recognizable. */
export const COMMAND_NORMALIZATION_SPEC: MechanismSpec = {
  id: 'command-normalization',
  summary: 'add record-format flags to grep/rg and disable colour for git diff and pytest',
  requires: ['journal'],
  modes: [{ mode: 'apply', anyOf: [['toolCalls']] }],
}

/**
 * LightShadow: recoverable compaction. Tool results in the compacted segment
 * become references the model can read again with `recall`; the user's
 * messages are kept word for word. `observe` records what a checkpoint would
 * have saved and leaves the host's compaction alone.
 */
export const LIGHTSHADOW_SPEC: MechanismSpec = {
  id: 'lightshadow',
  summary: 'replace tool results in compacted history with recallable references',
  requires: ['journal', 'artifacts', 'tokens'],
  modes: [
    // The strongest first: LightShadow writes the checkpoint; else the host's summary stays and the catalog follows it.
    { mode: 'apply', anyOf: [['compaction', 'tools'], ['compactionContext', 'tools']] },
    { mode: 'observe', anyOf: [['compaction'], ['sessions']] },
  ],
}

export const V0_2_SPECS: readonly MechanismSpec[] = [ECONOMY_SPEC, COMMAND_NORMALIZATION_SPEC, LIGHTSHADOW_SPEC]
