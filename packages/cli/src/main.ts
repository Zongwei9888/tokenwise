import { parseArgs } from 'node:util'
import { economyCoverage, economyRuleDisplayName } from '@tokenwise/core'
import type { EconomyFilterName } from '@tokenwise/core'
import { FileArtifactStore } from '@tokenwise/store'
import { cliContext } from './context.ts'
import { dashboard } from './dashboard.ts'
import { doctor, VERSION } from './doctor.ts'
import { checkAgents, knownAgent, probeAgents, probeTargets } from './check.ts'
import { saved } from './saved.ts'
import { evolve, evolveCheck, evolveTry, rules } from './evolve.ts'
import { hook } from './hook.ts'
import { learnCancel, learnStart, learnStatus, NOTICE_HOSTS, startupNotice } from './learn.ts'
import { mcp } from './mcp.ts'
import { report } from './report.ts'
import { run } from './run.ts'
import { recall, shadow } from './shadow.ts'
import { AGENTS, setup } from './setup.ts'
import { checkupCommand, previewCommand, teachCommand } from './teach.ts'

const HELP = `tokenwise — TokenWise ${VERSION}

Usage:
  tokenwise setup [agent...] [--dsh-profile P] [--dry-run]
                                   add TokenWise to your agents (default: every one found on PATH)
  tokenwise uninstall [agent...] [--dsh-profile P] [--purge] [--dry-run]
                                   take it out again; --purge also deletes the saved data
                                   agents: ${AGENTS.map(agent => agent.id).join(' ')}
  tokenwise run [--host H] [--session S] [--call C] -c <script>   run a shell script, print filtered output
  tokenwise run [--host H] [--session S] [--call C] -- <program> [args...]
  tokenwise hook codex|claude|codebuddy|grok|hermes|copilot
                                   hook handler for that host (reads hook JSON on stdin)
  tokenwise notice opencode|hermes [--peek|--told]
                                   the startup notice that agent's plugin shows, if any (--peek: leave it untold; --told: mark it told)
  tokenwise saved [--month|--all] [--static] [--lang en|zh] [--json]
                                   what TokenWise saved you, in the terminal
  tokenwise dashboard [--port N] [--no-open]
                                   the same, as a page in your browser that updates as it saves
  tokenwise report [--host H] [--session S] [--json]
                                   the detailed numbers behind saved, per session or agent
  tokenwise filters [--json]              list output filters and what each preserves
  tokenwise show <sha256>                 print a saved original output
  tokenwise gc [--days N]                 delete saved originals older than N days
  tokenwise doctor [--json]               configuration, whether each of your agents works, per-host capabilities
  tokenwise doctor --probe [agent...]     ask each agent to run one command and check TokenWise saw it (uses a little of each agent's model)
  tokenwise evolve --learner pi|dsh|claude|codex|codebuddy|grok|"<command>" [--since 7d] [--max-cases N] [--timeout 30m] [--dry-run] [--json]
                                   learn output rules from recorded evidence; adopt them only if verified
  tokenwise learn --learner pi|dsh|claude|codex|codebuddy|grok
                                   the same, in the background; agents' /tokenwise:learn runs this
  tokenwise learn status|cancel           follow or stop a learning run
  tokenwise checkup [--json]              what TokenWise shortens, its learned rules, and the commands worth teaching it
  tokenwise teach "<command>"             teach it about one command in your own agent: writes a workspace for the rule
  tokenwise teach check|preview|keep|drop|status
                                   check the rule, show the before and after, keep it (verified like a learning run) or discard it
  tokenwise preview "<command>" [--json]  a recorded output of that command: the original and what the model reads now
  tokenwise rules [list|show|path|off|on|rollback] [--json]
                                   learned rules: what is adopted, switch off, go back
  tokenwise recall <observation_id> [--query Q | --line N] [--original] [--session S]
                                   read again a tool result LightShadow kept
  tokenwise mcp [--host H] [--session S]  MCP server (stdio) offering the tokenwise_recall tool
  tokenwise shadow instruction|tool|checkpoint|catalog
                                   LightShadow for host adapters (JSON on stdin and stdout)
  tokenwise --version

Data: $TOKENWISE_HOME or ~/.tokenwise.  Disable: TOKENWISE_DISABLE=1 or TOKENWISE_OUTPUT=off.
Every TOKENWISE_* setting can also be written TW_* (TW_HOME, TW_DISABLE): Codex and DSH drop
variables whose names contain TOKEN from the shells they run, and TW_* gets through.
`

/** TW_HOME and the like, for shells that drop TOKEN-named variables; a TOKENWISE_* one set as well wins. */
export function applyShortNames(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    const full = `TOKENWISE_${name.slice(3)}`
    if (name.startsWith('TW_') && name.length > 3 && env[full] === undefined) env[full] = value
  }
}

function runArgs(argv: string[]) {
  const split = argv.indexOf('--')
  const head = split < 0 ? argv : argv.slice(0, split)
  const { values } = parseArgs({ args: head, strict: true, options: {
    host: { type: 'string' }, session: { type: 'string' }, call: { type: 'string' }, tool: { type: 'string' }, c: { type: 'string', short: 'c' },
  } })
  const env = process.env
  const host = values.host ?? env.TOKENWISE_HOST ?? 'shell'
  return {
    host,
    sessionId: values.session ?? env.TOKENWISE_SESSION ?? null,
    callId: values.call ?? null,
    // Name the host's own shell tool so decisions line up with the hook's rewrite records.
    tool: values.tool ?? (host === 'codex' ? 'exec_command' : 'bash'),
    ...values.c !== undefined ? { script: values.c } : {},
    ...split >= 0 ? { argv: argv.slice(split + 1) } : {},
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  // `tokenwise <command> --help` prints the usage. `tokenwise run` and `tokenwise hook` pass their arguments on, so theirs are never read as a request for help.
  if (command !== 'run' && command !== 'hook' && (rest.includes('--help') || rest.includes('-h'))) { process.stdout.write(HELP); return 0 }
  try {
    return await dispatch(command, rest)
  } catch (error) {
    // An unknown or malformed option: one line, not a stack trace.
    if (!String((error as NodeJS.ErrnoException).code ?? '').startsWith('ERR_PARSE_ARGS_')) throw error
    process.stderr.write(`tokenwise ${command}: ${(error as Error).message}\nRun \`tokenwise --help\` for usage.\n`)
    return 2
  }
}

async function dispatch(command: string | undefined, rest: string[]): Promise<number> {
  switch (command) {
    case 'run': {
      let options
      try { options = runArgs(rest) } catch (error) {
        process.stderr.write(`tokenwise run: ${(error as Error).message}\n`)
        return 2
      }
      if ((options.script === undefined) === (options.argv === undefined)) {
        process.stderr.write('tokenwise run: give exactly one of -c <script> or -- <program> [args...]\n')
        return 2
      }
      return run(options)
    }
    case 'hook': return hook(rest[0])
    case 'notice': {
      // The OpenCode and Hermes plugins show this at a session's start; it never fails them. --peek prints it and leaves
      // it to be told; --told then marks it told without printing, once the plugin has shown it.
      try {
        const host = rest.find(arg => !arg.startsWith('-'))
        const text = host && NOTICE_HOSTS.has(host) ? startupNotice(host, process.env, { peek: rest.includes('--peek') }) : undefined
        if (text && !rest.includes('--told')) process.stdout.write(text + '\n')
      } catch { /* Nothing to say. */ }
      return 0
    }
    case 'dashboard': {
      const { values } = parseArgs({ args: rest, options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } } })
      const port = values.port === undefined ? undefined : Number(values.port)
      if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) { process.stderr.write('tokenwise dashboard: --port must be 1 to 65535\n'); return 2 }
      return dashboard({ ...port === undefined ? {} : { port }, open: values['no-open'] !== true })
    }
    case 'report': {
      const { values } = parseArgs({ args: rest, options: { host: { type: 'string' }, session: { type: 'string' }, json: { type: 'boolean' } } })
      return report({ ...values.host === undefined ? {} : { host: values.host }, ...values.session === undefined ? {} : { session: values.session }, json: values.json === true })
    }
    case 'filters': {
      const coverage = economyCoverage()
      if (rest.includes('--json')) { process.stdout.write(JSON.stringify(coverage, null, 2) + '\n'); return 0 }
      for (const filter of coverage.filters) {
        process.stdout.write(`${economyRuleDisplayName(filter.name as EconomyFilterName).padEnd(20)} ${filter.transformation.padEnd(24)} ${filter.action}\n`)
      }
      return 0
    }
    case 'show': {
      const text = rest[0] ? cliContext().readArtifact(rest[0]) : undefined
      if (text === undefined) { process.stderr.write('tokenwise show: no saved original with that sha256 (expired or never stored)\n'); return 1 }
      process.stdout.write(text)
      return 0
    }
    case 'gc': {
      const { values } = parseArgs({ args: rest, options: { days: { type: 'string' } } })
      const context = cliContext()
      const days = values.days === undefined ? context.loaded.config.artifacts.retentionDays : Number(values.days)
      if (!Number.isFinite(days) || days < 0) { process.stderr.write('tokenwise gc: --days must be a non-negative number\n'); return 2 }
      const removed = context.dataDirs.reduce((sum, dir) => sum + new FileArtifactStore(dir).prune(days), 0)
      process.stdout.write(`removed ${removed} saved originals older than ${days} days\n`)
      return 0
    }
    case 'doctor': {
      if (!rest.includes('--probe')) return doctor({ json: rest.includes('--json') })
      const named = rest.filter(arg => !arg.startsWith('-'))
      const unknown = named.filter(id => !knownAgent(id))
      if (unknown.length) { process.stderr.write(`tokenwise doctor: unknown agent ${unknown.join(', ')} (one of ${AGENTS.map(agent => agent.id).join(', ')})\n`); return 2 }
      const context = cliContext()
      const ids = probeTargets(named, checkAgents(context.dataDirs))
      if (!ids.length) { process.stdout.write('No agent is set up yet: tokenwise setup\n'); return 1 }
      process.stdout.write(`Asking ${ids.length === 1 ? 'one agent' : `${ids.length} agents`} to run one command; this takes up to a few minutes...\n`)
      const results = await probeAgents(ids, { dataDirs: context.dataDirs })
      for (const result of results) process.stdout.write(`  ${result.ok === undefined ? '·' : result.ok ? '✓' : '✗'}  ${result.name}: ${result.detail}\n`)
      return results.some(result => result.ok === false) ? 1 : 0
    }
    case 'saved': {
      const { values } = parseArgs({ args: rest, options: { month: { type: 'boolean' }, all: { type: 'boolean' }, lang: { type: 'string' }, static: { type: 'boolean' }, json: { type: 'boolean' } } })
      if (values.lang !== undefined && values.lang !== 'en' && values.lang !== 'zh') { process.stderr.write('tokenwise saved: --lang is en or zh\n'); return 2 }
      return saved({ period: values.all ? 'all' : values.month ? 'month' : 'week', ...values.lang ? { language: values.lang as 'en' | 'zh' } : {},
        ...values.static ? { animate: false } : {}, json: values.json === true })
    }
    case 'probe':
      // What `tokenwise doctor --probe` asks an agent to run: proof that TokenWise saw the agent's command.
      // Long enough that every agent's plugin looks at it (Hermes's skips output under 256 characters).
      process.stdout.write(`TokenWise probe ${rest[0] ?? ''}: this agent's commands go through TokenWise.\n`
        + Array.from({ length: 12 }, (_, i) => `  probe line ${i + 1} of 12, for tokenwise doctor --probe\n`).join(''))
      return 0
    case 'evolve': {
      if (rest[0] === 'check' || rest[0] === 'try') {
        const { values, positionals } = parseArgs({ args: rest.slice(1), allowPositionals: true, options: { workspace: { type: 'string' }, json: { type: 'boolean' } } })
        return rest[0] === 'check' ? evolveCheck(values.workspace, values.json === true) : evolveTry(values.workspace, positionals[0])
      }
      const { values } = parseArgs({ args: rest, options: {
        learner: { type: 'string' }, profile: { type: 'string' }, since: { type: 'string' }, 'max-cases': { type: 'string' },
        timeout: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
      } })
      const maxCases = values['max-cases'] === undefined ? undefined : Number(values['max-cases'])
      if (maxCases !== undefined && (!Number.isSafeInteger(maxCases) || maxCases < 1)) { process.stderr.write('tokenwise evolve: --max-cases must be a positive integer\n'); return 2 }
      return evolve({ ...values.learner === undefined ? {} : { learner: values.learner }, ...values.profile === undefined ? {} : { profile: values.profile },
        ...values.since === undefined ? {} : { since: values.since }, ...maxCases === undefined ? {} : { maxCases },
        ...values.timeout === undefined ? {} : { timeout: values.timeout }, dryRun: values['dry-run'] === true, json: values.json === true })
    }
    case 'learn': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { learner: { type: 'string' } } })
      if (positionals[0] === 'status') return learnStatus()
      if (positionals[0] === 'cancel') return learnCancel()
      if (positionals.length) { process.stderr.write(`tokenwise learn: unknown ${positionals[0]} (use status or cancel)\n`); return 2 }
      return learnStart(values.learner)
    }
    case 'rules': return rules(rest.find(arg => !arg.startsWith('-')), rest.includes('--json'))
    case 'checkup': return checkupCommand(rest.includes('--json'))
    case 'preview': return previewCommand(rest.filter(arg => arg !== '--json').join(' ').trim() || undefined, rest.includes('--json'))
    case 'teach': {
      const args = rest.filter(arg => arg !== '--json')
      return teachCommand(args[0], args.slice(1), rest.includes('--json'))
    }
    case 'recall': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        query: { type: 'string' }, line: { type: 'string' }, original: { type: 'boolean' }, host: { type: 'string' }, session: { type: 'string' }, call: { type: 'string' },
      } })
      return recall({ id: positionals[0], ...values.query === undefined ? {} : { query: values.query }, ...values.line === undefined ? {} : { line: values.line },
        original: values.original === true, ...values.host === undefined ? {} : { host: values.host },
        ...values.session === undefined ? {} : { session: values.session }, ...values.call === undefined ? {} : { call: values.call } })
    }
    case 'mcp': {
      const { values } = parseArgs({ args: rest, options: { host: { type: 'string' }, session: { type: 'string' } } })
      return mcp({ ...values.host === undefined ? {} : { host: values.host }, ...values.session === undefined ? {} : { session: values.session } })
    }
    case 'shadow': return shadow(rest[0])
    case 'setup': case 'uninstall': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
        'dry-run': { type: 'boolean' }, 'dsh-profile': { type: 'string' }, ...command === 'uninstall' ? { purge: { type: 'boolean' } } : {},
      } })
      return setup({ action: command, agents: positionals, dryRun: values['dry-run'] === true,
        ...values['dsh-profile'] === undefined ? {} : { dshProfile: values['dsh-profile'] as string },
        ...values.purge === true ? { purge: cliContext().dataDir } : {} })
    }
    case '--version': case '-v': case 'version': process.stdout.write(`${VERSION}\n`); return 0
    case undefined: case '--help': case '-h': case 'help': process.stdout.write(HELP); return 0
    default:
      process.stderr.write(`tokenwise: unknown command ${command}\n${HELP}`)
      return 2
  }
}

applyShortNames(process.env)
let code: number
try {
  code = await main(process.argv.slice(2))
} catch (error) {
  const failure = error as NodeJS.ErrnoException & { tokenwiseMessage?: string }
  if (failure.tokenwiseMessage) {
    process.stderr.write(`tokenwise: ${failure.tokenwiseMessage}\n`)
  } else if (failure.code === 'EPERM' || failure.code === 'EACCES' || failure.code === 'EROFS') {
    // Codex and DSH run an agent's commands in a sandbox that may not write outside the project.
    process.stderr.write(`tokenwise: could not write ${failure.path ?? 'its data'} (${failure.code}). This agent seems to run commands in a sandbox: `
      + 'run the same tokenwise command again with escalated permissions (outside the sandbox), so it can write there.\n')
  } else {
    throw error
  }
  code = 1
}
process.exitCode = code
