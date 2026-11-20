/**
 * TokenWise for DeepSeek Harness 0.2.x, Host half. Economy: recognized `bash`
 * output, and complete results of DSH's own `grep` and `glob`, are replaced by
 * a deterministic projection in the `tools/post-execute` waterfall, so the
 * model and the session log receive the smaller text while TokenWise keeps the
 * original (and a source map) in its private store. LightShadow
 * (./shadow.ts): DSH's compaction keeps tool results recallable through
 * `tokenwise_recall`. `/tokenwise` reports both; the `mode` setting is live.
 * Self-evolution (./learning.ts): routes under /api/tokenwise for the
 * Plugins page, where a learning run starts, and `/tokenwise learn`. When a
 * turn ends, a toast on that conversation's page says what it saved.
 */
import Schema from '@deepseek-ai/schemastery'
import type { MechanismMode } from '@tokenwise/protocol'
import { formatTokens, markSavingsTold, outcomeSentence, readEvolveStatus, untoldSavings } from '@tokenwise/mechanisms'
import { HOST, INLINE_LIMIT_CHARS, createDshEconomy } from './economy.ts'
import type { HostContext, JobRegistry, Volatile } from './host.ts'
import { createDshLearning } from './learning.ts'
import type { DshLearningOptions } from './learning.ts'
import { RECALL_TOOL, createDshShadow } from './shadow.ts'

export const name = 'tokenwise'
export const inject = ['tools']

export interface Config {
  mode: Volatile<MechanismMode>
  inlineLimitChars: number
}

export const Config = Schema.object({
  mode: Schema.union(['apply', 'observe', 'off']).default('apply')
    .description('apply: the model reads smaller tool output, and compaction keeps tool results recallable; observe: record what would change, change nothing; off: do nothing.')
    .volatile(),
  inlineLimitChars: Schema.natural().default(INLINE_LIMIT_CHARS)
    .description('A projection longer than this (characters) is not used: the original passes, so DSH\'s spill policy keeps the complete text. '
      + 'Keep it at or below spill-policy maxInlineTokens × 4 (the default fits DSH\'s default 12,500).'),
})

/** Tests replace the learning runner and learner. */
export const testing: { learning?: Partial<DshLearningOptions> } = {}

export function apply(ctx: HostContext, config: Config): void {
  const economy = createDshEconomy({
    mode: () => config.mode.get(),
    inlineLimitChars: config.inlineLimitChars,
    warn: message => ctx.logger.warn(message),
    jobOutputTotal: (id, exec) => {
      // A service the plugin does not inject: looked up when needed. It answers only the job's owner (its agent's session).
      const jobs = ctx.get?.('jobs') as JobRegistry | undefined
      for (const caller of new Set([exec.agent?.session?.id, exec.agent?.id])) {
        try {
          const total = jobs?.get(id, caller)?.output?.total
          if (typeof total === 'number' && Number.isSafeInteger(total)) return total
        } catch { /* Not this caller's, or no such job. */ }
      }
      return undefined
    },
  })
  // Registered last, so it runs innermost: it sees the bash result itself, and DSH's spill policy
  // (which prepends) bounds the projection rather than handing TokenWise a spilled preview.
  ctx.on('tools/post-execute', async (exec, result, next) => economy.postExecute(exec, result, await next()))

  // The recall tool is declared to every agent only when TokenWise's own configuration allows LightShadow;
  // without it, LightShadow at most observes (references nobody could recall are never made).
  let recallRegistered = false
  const shadow = createDshShadow({
    host: HOST, journal: economy.journal, artifacts: economy.artifacts, read: economy.read,
    mode: session => {
      const mode = economy.shadowMode(session)
      return mode === 'apply' && !recallRegistered ? 'observe' : mode
    },
    warn: message => ctx.logger.warn(message),
  })
  // Presets mount their compaction engines after this plugin; look again whenever an agent starts or steps.
  const discover = () => { try { shadow.discover(ctx.events) } catch (error) { ctx.logger.warn(`TokenWise compaction: ${String(error)}`) } }
  discover()
  ctx.on('agent/created', () => { discover(); return undefined }, { global: true })
  ctx.on('agent/pre-step', async (_payload, next) => { discover(); return next() }, { global: true, prepend: true })
  economy.extraReport = () => {
    const { engines, pruners } = shadow.attached
    return engines === 0 ? ['Compaction: no DSH compaction engine found yet (it attaches when an agent starts).']
      : [`Compaction is attached to ${engines} compaction engine${engines === 1 ? '' : 's'} and ${pruners} result pruner${pruners === 1 ? '' : 's'}.`]
  }
  if (economy.configuredShadowMode() !== 'off' && ctx.tools) {
    recallRegistered = true
    ctx.tools.register({
      name: RECALL_TOOL.name,
      description: RECALL_TOOL.description,
      parameters: {
        type: 'object',
        properties: {
          observation_id: { type: 'string', description: 'Such as o-1a2b3c4d5e6f.' },
          query: { type: 'string', description: 'An exact string it contains: read around its first match.' },
          line: { type: 'integer', minimum: 1, description: 'A 1-based line to read around.' },
          original: { type: 'boolean', description: 'For a catalog entry marked original: the output before TokenWise shortened it.' },
        },
        required: ['observation_id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' }, ok: { type: 'boolean' } }, required: ['text', 'ok'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: String((value as { text?: unknown }).text ?? '') }],
      },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (!session) return { text: 'recall failed: no session', ok: false }
        const { text, result } = shadow.recall({ id: String(session.id) }, args, String(exec.callId))
        return { text, ok: result.ok }
      },
    })
  }
  // The end of a turn in a conversation (not a subagent's): its page in the browser (client/saved.ts) then asks what TokenWise
  // saved in it so far, said when that grew since it was last said (kept on disk) and told once handed over.
  const turnEnded = new Set<string>()
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || session?.header?.origin === 'subagent' || session?.id === undefined) return
    turnEnded.add(String(session.id))
    if (turnEnded.size > 256) turnEnded.delete(turnEnded.values().next().value!)
  }, { global: true })
  const conversation = (sessionId: string) => {
    if (!turnEnded.delete(sessionId)) return undefined
    const savings = untoldSavings(economy.read, economy.dataDirs, HOST, sessionId)
    if (savings) markSavingsTold(economy.dataDir, HOST, sessionId, savings.savedTokens)
    return savings
  }
  const learning = createDshLearning({
    configDir: economy.configDir, env: process.env,
    selection: () => (ctx.get?.('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined)?.currentSelection?.(),
    installAnchor: () => (ctx.get?.('profileContext') as { installAnchor?: string } | undefined)?.installAnchor,
    patchPath: () => (ctx.get?.('profileContext') as { patchPath?: string } | undefined)?.patchPath,
    conversation,
    ...testing.learning,
  })
  // The Plugins page's self-evolution section talks to these.
  ctx.inject(['connection'], inner => {
    for (const route of learning.routes()) {
      inner.effect(() => {
        const dispose = inner.connection.fetch.register(route)
        return () => { void dispose() }
      }, `tokenwise: ${route.path}`)
    }
  })
  const learnCommand = (sub: string): string => {
    if (sub === 'learn') {
      const started = learning.start()
      if (started.ok) return 'TokenWise is learning output rules in the background (Plugins → TokenWise shows its progress).'
      return `TokenWise did not start learning: ${({ running: 'a learning run is already in progress', 'no-runner': 'this installation has no learning runner',
        'no-node': 'Node.js was not found', 'no-dsh': 'the dsh command was not found', 'spawn-failed': 'the runner did not start' } as Record<string, string>)[started.error] ?? started.error}.`
    }
    if (sub === 'cancel') return learning.cancel() ? 'Stopping the learning run.' : 'No learning run in progress.'
    if (sub === 'off' || sub === 'on' || sub === 'rollback') {
      const result = learning.rules(sub)
      if (sub === 'rollback' && !result.ok) return 'No learned rules are active.'
      return result.active ? `Learned rules ${result.active.slice(0, 12)} are in use from the next output on.` : 'No learned rules are in use now.'
    }
    const evolve = readEvolveStatus(economy.configDir)
    const run = evolve.run
    return [
      evolve.rules.active ? `Learned rules ${evolve.rules.active.slice(0, 12)}: ${evolve.rules.rules.map(rule => rule.id).join(', ') || 'none'}` : 'No learned rules are active.',
      run?.running ? `Learning with ${run.learner}: ${run.phase}, ${run.checks} check${run.checks === 1 ? '' : 's'} so far.`
        : run?.outcome ? `Last learning run: ${outcomeSentence(run.outcome)}.` : 'No learning run yet: /tokenwise learn starts one.',
      ...evolve.scan?.ready ? [`Worth learning: ${evolve.scan.opportunities.slice(0, 3).map(item => `${item.command} (~${formatTokens(item.leftTokens)} tokens left)`).join(', ')}.`] : [],
    ].join('\n')
  }
  ctx.inject(['commands'], inner => {
    inner.effect(() => inner.commands.register({
      definitionId: '@tokenwise/dsh/tokenwise',
      name: 'tokenwise',
      description: 'TokenWise: tokens saved in this session; /tokenwise learn | cancel | rules | rollback | off | on',
      handler: invocation => {
        const session = invocation.agent.session
        // rawInput is the text after the command name.
        const sub = String(invocation.rawInput ?? '').trim().split(/\s+/u)[0] ?? ''
        if (['learn', 'cancel', 'rules', 'rollback', 'off', 'on'].includes(sub)) return { kind: 'success', text: learnCommand(sub) }
        return { kind: 'success', text: economy.report({ id: String(session.id), cwd: session.header?.cwd }) }
      },
    }), 'tokenwise: /tokenwise command')
  })
}
