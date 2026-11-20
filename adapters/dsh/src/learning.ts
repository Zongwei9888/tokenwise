/**
 * Self-evolution for DeepSeek Harness, Host side: the HTTP routes the browser
 * half's Plugins-page section and toast use (status, start, cancel, rules),
 * and the learner, which is DSH's own headless profile running the model the
 * user chose. Learning runs in a separate process, so the Host never waits.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cancelEvolution, LEARNER_INSTRUCTION, nodeBinary, onPath, readEvolveStatus, refreshScan, startEvolution, takeAnnouncement, takeReadyNotice } from '@tokenwise/mechanisms'
import type { BackgroundOptions, ConversationSavings, EvolveRunStatus, EvolveStatus } from '@tokenwise/mechanisms'
import { RuleStore, ensurePrivateDir, loadConfig } from '@tokenwise/store'

export type Learner = { readonly argv: readonly string[]; readonly shell?: boolean; readonly label: string } | { readonly unavailable: string }

/** What `GET /api/tokenwise/status` returns. */
export interface LearningPayload {
  readonly evolve: EvolveStatus
  readonly learner: { readonly label: string } | { readonly unavailable: string }
  readonly learnedRulesOff: boolean
}

export interface DshLearningOptions {
  /** Where configuration, learned rules and runs live. */
  readonly configDir: string
  readonly env: NodeJS.ProcessEnv
  /** The learning runner (the bundled evolve.js next to index.js); tests run the source with node flags. */
  readonly runner?: string
  readonly runnerNodeArgs?: readonly string[]
  /** Tests replace the learner (by default DSH headless with the user's default model). */
  readonly learner?: () => Learner
  /** DSH's default model for new agents (`agentDefaultModel.currentSelection()`). */
  readonly selection?: () => { readonly provider: string; readonly model: string } | undefined
  /** `ctx.profileContext.installAnchor`: the dsh package.json the Host was started from. */
  readonly installAnchor?: () => string | undefined
  /** `ctx.profileContext.patchPath`: this profile's own layer, where the user's providers are saved. */
  readonly patchPath?: () => string | undefined
  /** What this conversation saved, after one of its turns, when that grew since it was last said; taking it marks it told (./index.ts). */
  readonly conversation?: (sessionId: string) => ConversationSavings | undefined
}

/**
 * The model providers this profile configures (`llm-pi-ai` entries of its
 * patch list), for the learner's overlay: the headless profile does not see
 * the Web profile's own layer. DSH writes that file as a YAML list with its
 * entries at column 0, so an entry runs to the next `- ` at column 0.
 */
export function providerEntries(patch: string): string {
  return patch.split(/^(?=- )/mu).filter(entry => /^- id:\s*['"]?llm-pi-ai['"]?\s*$/mu.test(entry.split('\n')[0] ?? '')).map(entry => entry.endsWith('\n') ? entry : `${entry}\n`).join('')
}

export const ROUTES = {
  status: '/api/tokenwise/status',
  learn: '/api/tokenwise/learn',
  cancel: '/api/tokenwise/cancel',
  rules: '/api/tokenwise/rules',
  announcement: '/api/tokenwise/announcement',
  saved: '/api/tokenwise/saved',
} as const

const HOST = 'dsh'

/** How to run the dsh CLI from this Host: Desktop's bundled CLI, the CLI this Host came from, or dsh on PATH. */
export function dshCommand(env: NodeJS.ProcessEnv, installAnchor: string | undefined): string[] | undefined {
  if (process.versions.electron) {
    const cli = join(dirname(process.argv[1] ?? ''), 'cli.js')
    return existsSync(cli) ? [process.execPath, '--expose-internals', cli] : undefined
  }
  if (installAnchor) {
    const bin = join(dirname(installAnchor), 'lib', 'bin.js')
    if (existsSync(bin)) return [process.execPath, bin]
  }
  const found = onPath('dsh', env)
  return found ? [found] : undefined
}

export function createDshLearning(options: DshLearningOptions) {
  const { configDir, env } = options
  const ruleStore = new RuleStore(configDir)
  const runner = options.runner ?? fileURLToPath(new URL('./evolve.js', import.meta.url))

  const background = (): BackgroundOptions | { unavailable: string } => {
    if (!existsSync(runner)) return { unavailable: 'no-runner' }
    // Desktop runs the Host on Electron as Node; its runner and learner do the same.
    const electron = process.versions.electron !== undefined
    const node = electron ? process.execPath : nodeBinary(env)
    if (!node) return { unavailable: 'no-node' }
    const childEnv: NodeJS.ProcessEnv = { ...env, TOKENWISE_HOME: configDir, ...electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
    return { runner, node, env: childEnv, cwd: configDir, ...options.runnerNodeArgs ? { nodeArgs: options.runnerNodeArgs } : {} }
  }

  const selected = () => { try { return options.selection?.() } catch { return undefined } }

  /**
   * The learner. Only when a run starts (`write`) is its overlay written: the
   * profile's provider entries may hold credentials, so the file exists only
   * for the run and the runner deletes it afterwards.
   */
  const learner = (write = false): Learner & { cleanup?: string[] } => {
    if (options.learner) return options.learner()
    const selection = selected()
    const command = dshCommand(env, options.installAnchor?.())
    if (!command) return { unavailable: 'no-dsh' }
    const label = `DSH · ${selection?.model ?? 'default model'}`
    // The headless profile does not share the Web profile's model choice: pass it as an overlay.
    const args = [...command, '--profile', 'headless']
    let cleanup: string[] | undefined
    if (write && selection?.provider && selection.model) {
      let providers = ''
      try { const path = options.patchPath?.(); if (path) providers = providerEntries(readFileSync(path, 'utf8')) } catch { /* Built-in providers only. */ }
      const patch = join(ensurePrivateDir(join(configDir, 'evolve')), `dsh-learner.${randomBytes(4).toString('hex')}.patch.yml`)
      writeFileSync(patch, `${providers}- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(selection.provider)}\n    model: ${JSON.stringify(selection.model)}\n`, { mode: 0o600 })
      args.push('--patch', patch)
      cleanup = [patch]
    }
    return { argv: [...args, LEARNER_INSTRUCTION], label, ...cleanup ? { cleanup } : {} }
  }

  const status = (fresh = false): LearningPayload => {
    const runnerOptions = background()
    // Keep the "worth learning" view fresh without blocking: a stale scan (or any, when the page opens) is redone in its own process.
    if (!('unavailable' in runnerOptions)) { try { refreshScan(configDir, { ...runnerOptions, ...fresh ? { maxAgeMs: 0 } : {} }) } catch { /* Shown as it is. */ } }
    const chosen = learner()
    return {
      evolve: readEvolveStatus(configDir),
      learner: 'unavailable' in runnerOptions ? runnerOptions : 'unavailable' in chosen ? chosen : { label: chosen.label },
      learnedRulesOff: !loadConfig({ dataDir: configDir, env }).config.economy.learnedRules,
    }
  }

  const start = (): { ok: true; runId: string } | { ok: false; error: string } => {
    const runnerOptions = background()
    if ('unavailable' in runnerOptions) return { ok: false, error: runnerOptions.unavailable }
    const chosen = learner(true)
    if ('unavailable' in chosen) return { ok: false, error: chosen.unavailable }
    const { cleanup, ...command } = chosen
    const started = startEvolution(configDir, { ...runnerOptions, host: HOST, learner: command, ...cleanup ? { cleanup } : {} })
    if ('error' in started) { for (const path of cleanup ?? []) rmSync(path, { force: true }) }
    return 'error' in started ? { ok: false, error: started.error } : { ok: true, runId: started.runId }
  }

  const rules = (action: unknown): { ok: boolean; active: string | null } => {
    const active = ruleStore.state().active
    if (action === 'off') { if (active) ruleStore.deactivate(); return { ok: true, active: null } }
    if (action === 'on') return { ok: true, active: active ?? ruleStore.rollback() }
    if (action === 'rollback') return { ok: active !== null, active: active ? ruleStore.rollback() : null }
    return { ok: false, active }
  }

  /**
   * What the toast shows once: a run that ended, or else commands now worth
   * learning from. The scan behind the second is redone in its own process
   * (see `refreshScan`: two minutes after new output, else every ten).
   */
  const announcement = (): { run: EvolveRunStatus | null; ready: ReturnType<typeof takeReadyNotice> | null } => {
    const run = takeAnnouncement(configDir, HOST)
    if (run) return { run, ready: null }
    const runnerOptions = background()
    if ('unavailable' in runnerOptions) return { run: null, ready: null }
    try { refreshScan(configDir, runnerOptions) } catch { /* Next poll. */ }
    return { run: null, ready: takeReadyNotice(configDir, HOST) ?? null }
  }

  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  const guard = (handle: (request: Request) => Promise<Response> | Response) => async (request: Request) => {
    try { return await handle(request) } catch (error) { return json({ ok: false, error: String((error as Error)?.message ?? error) }, 500) }
  }
  const body = async (request: Request): Promise<Record<string, unknown>> => {
    try { const value = await request.json(); return value && typeof value === 'object' ? value as Record<string, unknown> : {} } catch { return {} }
  }

  /** The exact Fetch routes, for `ctx.connection.fetch.register`. */
  const routes = () => [
    { path: ROUTES.status, methods: ['GET'] as const, requestBody: 'buffered' as const,
      fetch: guard(request => json(status(new URL(request.url).searchParams.get('refresh') === '1'))) },
    { path: ROUTES.learn, methods: ['POST'] as const, requestBody: 'buffered' as const, fetch: guard(() => json(start())) },
    { path: ROUTES.cancel, methods: ['POST'] as const, requestBody: 'buffered' as const, fetch: guard(() => json({ ok: cancelEvolution(configDir) })) },
    { path: ROUTES.rules, methods: ['POST'] as const, requestBody: 'buffered' as const, fetch: guard(async request => json(rules((await body(request)).action))) },
    { path: ROUTES.announcement, methods: ['POST'] as const, requestBody: 'buffered' as const,
      fetch: guard(() => json(announcement())) },
    // Asked by a conversation's own page (client/saved.ts), so the toast always speaks of the conversation on screen.
    { path: ROUTES.saved, methods: ['POST'] as const, requestBody: 'buffered' as const,
      fetch: guard(async request => {
        const { sessionId } = await body(request)
        return json({ saved: typeof sessionId === 'string' && sessionId ? options.conversation?.(sessionId) ?? null : null })
      }) },
  ]

  return { status, start, cancel: () => cancelEvolution(configDir), rules, routes, learner }
}
