import { economyCoverage, ECONOMY_RUNTIME_VERSION } from '@tokenwise/core'
import { HOST_PROFILES, V0_2_SPECS, negotiate } from '@tokenwise/protocol'
import { cliContext, onPath } from './context.ts'
import { checkAgents, describeAgents } from './check.ts'

export const VERSION = '0.3.0'

export function doctor(options: { json?: boolean } = {}): number {
  const context = cliContext()
  const { config, sources, problems } = context.loaded
  const requested = { economy: config.economy.mode, 'command-normalization': config.economy.commandNormalization ? 'apply' as const : 'off' as const,
    lightshadow: config.lightshadow.mode }
  const hosts = Object.values(HOST_PROFILES).map(profile => ({
    host: profile.id, name: profile.name, integration: profile.integration,
    mechanisms: negotiate(V0_2_SPECS, profile.capabilities, requested), notes: profile.notes,
  }))
  const writable = context.writable()
  const result = {
    version: VERSION, runtimeVersion: ECONOMY_RUNTIME_VERSION, node: process.version, dataDir: context.dataDir,
    dataDirs: context.dataDirs, writableDataDir: writable?.dataDir ?? null, lcOnPath: onPath('tokenwise') ?? null,
    config: { ...config, sources, problems }, filters: economyCoverage().filters.length,
    agents: checkAgents(context.dataDirs), hosts,
  }
  if (options.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return problems.length ? 1 : 0 }
  const lines = [
    `TokenWise ${VERSION} (filters ${ECONOMY_RUNTIME_VERSION}, ${result.filters} filters)`,
    `  node        ${process.version}`,
    `  data        ${context.dataDir}${writable?.dataDir === context.dataDir ? '' : writable ? ` (not writable here; using ${writable.dataDir})` : ' (not writable: nothing will be filtered)'}`,
    `  tokenwise on PATH  ${result.lcOnPath ?? 'no — Codex hooks need `tokenwise` on PATH'}`,
    `  config      ${sources.length ? sources.join(', ') : 'defaults'}`,
    `  output      mode=${config.economy.mode} minimumSavedTokens=${config.economy.minimumSavedTokens} retention=${config.artifacts.retentionDays}d`,
    `  compaction  mode=${config.lightshadow.mode}`,
    `  evolution   evidence=${config.economy.evidence ? 'kept (every complete shell output, except credential-looking ones)' : 'off'} learnedRules=${config.economy.learnedRules ? 'on' : 'off'}`,
  ]
  for (const problem of problems) lines.push(`  ! ${problem} (output filtering and compaction are off until this is fixed)`)
  const agents = describeAgents(result.agents)
  if (agents.length) lines.push('', 'Your agents (tokenwise doctor --probe asks each one to run a command, to be sure)', ...agents)
  for (const host of hosts) {
    lines.push('', `${host.name} [${host.integration}]`)
    for (const item of host.mechanisms) lines.push(`  ${item.mechanism.padEnd(22)} ${item.mode.padEnd(8)} ${item.reason}`)
    for (const note of host.notes) lines.push(`  · ${note}`)
  }
  process.stdout.write(lines.join('\n') + '\n')
  return problems.length ? 1 : 0
}
