/**
 * pi's interactive side, driven through tmux: the status bar and `/tokenwise`
 * in a TUI session, and switching the extension off and on in `pi config`
 * (the screen pi offers for enabling installed resources). Skipped without
 * tmux.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFixture, COMMANDS } from './lib/fixture.mjs'
import { ensureTool, VERSIONS } from './lib/hosts.mjs'
import { startMockLlm, toolResults } from './lib/mock-llm.mjs'
import { childEnv, hasCommand, run, runAsync } from './lib/run.mjs'
import { linkLearnerCommand, writeLinkScript } from './lib/rules.mjs'
import { journal } from './lib/verify.mjs'

const tmux = (...args) => spawnSync('tmux', args, { encoding: 'utf8' })

/** One detached tmux session running `command` with `env`; `screen()` returns the visible text. */
function terminal(name, { cwd, env, command }) {
  tmux('kill-session', '-t', name)
  const vars = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  const started = tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '45', '-c', cwd, ...vars, ...command)
  assert.equal(started.status, 0, started.stderr)
  const screen = () => tmux('capture-pane', '-t', name, '-p', '-S', '-300').stdout
  /** What is on the screen now, without the scrollback. */
  const visible = () => tmux('capture-pane', '-t', name, '-p').stdout
  return {
    screen,
    visible,
    /** Close the /tokenwise panel and wait until it is gone: tmux may join a lone Escape with the next key. */
    closePanel: async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        tmux('send-keys', '-t', name, 'Escape')
        const deadline = Date.now() + 2000
        while (Date.now() < deadline) {
          if (!visible().includes('◆ TokenWise')) return
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      throw new Error(`pi TUI: the panel did not close\n${visible()}`)
    },
    keys: (...keys) => tmux('send-keys', '-t', name, ...keys),
    waitFor: async (pattern, what, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs
      while (!pattern.test(screen())) {
        if (Date.now() > deadline) throw new Error(`pi TUI: timed out waiting for ${what}\n${screen()}`)
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    },
    close: () => tmux('kill-session', '-t', name),
  }
}

export async function runPiTui({ cache, root, registry, log }) {
  if (!hasCommand('tmux')) { log('pi TUI: skipped (tmux not installed)'); return }
  const version = VERSIONS.pi.at(-1)
  const pi = join(ensureTool(cache, 'pi', version), 'pi')
  const base = join(root, `pi-tui-${version}`)
  const agentDir = join(base, 'agent'), work = join(base, 'work'), tokenwiseHome = join(base, 'tokenwise')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(work, { recursive: true })
  createFixture(work)
  const commands = [COMMANDS.search, COMMANDS.tests, COMMANDS.diff, COMMANDS.plain]
  const mock = await startMockLlm({ commands })
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: mock.url, api: 'openai-completions', apiKey: 'e2e',
    models: [{ id: 'mock-model', contextWindow: 128000, maxTokens: 4096 }] } } }))
  const env = childEnv({ ...registry.env, PI_CODING_AGENT_DIR: agentDir, TOKENWISE_HOME: tokenwiseHome, PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0', PI_OFFLINE: '1', npm_config_cache: join(cache, 'npm-cache') })
  // tmux sessions inherit the tmux server's environment: pass everything the TUI needs (local addresses bypass any proxy).
  const vars = Object.fromEntries(['PI_CODING_AGENT_DIR', 'TOKENWISE_HOME', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'PI_OFFLINE', 'NO_PROXY', 'no_proxy']
    .map(key => [key, env[key]]))
  const settings = () => JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
  const decisions = () => journal(tokenwiseHome, 'pi').filter(record => record.type === 'economy/decision').length
  const printRun = async () => {
    const result = await runAsync(pi, ['-p', '--provider', 'mock', '--model', 'mock-model', 'Run the fixture commands.'], { cwd: work, env })
    assert.equal(result.status, 0, result.stderr)
  }
  const toggleInConfig = async (expected) => {
    const config = terminal('tokenwise-pi-config', { cwd: work, env: vars, command: [pi, 'config'] })
    try {
      await config.waitFor(/\[[x ]\] dist\/extension\.js/, 'the TokenWise extension in pi config')
      config.keys('Space')
      await config.waitFor(new RegExp(`\\[${expected ? 'x' : ' '}\\] dist/extension\\.js`), `the extension ${expected ? 'on' : 'off'}`)
      config.keys('Escape')
      const deadline = Date.now() + 10_000
      while (JSON.stringify(settings().packages).includes('-dist/extension.js') === expected) {
        if (Date.now() > deadline) throw new Error(`pi config did not save the extension ${expected ? 'on' : 'off'}`)
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    } finally { config.close() }
  }
  try {
    run(pi, ['install', 'npm:@tokenwise/pi'], { cwd: base, env })

    // 1. A TUI session: the card above the editor and the status bar show the savings, the /tokenwise panel and report explain them.
    const session = terminal('tokenwise-pi-tui', { cwd: work, env: vars, command: [pi, '--provider', 'mock', '--model', 'mock-model'] })
    const shots = join(base, 'screens')
    mkdirSync(shots, { recursive: true })
    const keep = name => writeFileSync(join(shots, `${name}.txt`), session.screen())
    try {
      await session.waitFor(/mock-model/, 'pi to start')
      session.keys('Run the fixture commands.', 'Enter')
      await session.waitFor(/^ ?done\s*$/m, 'the scripted turn to finish', 120_000)
      await session.waitFor(/TokenWise · saved [\d,]+ tokens in this conversation/, 'the TokenWise card above the editor')
      await session.waitFor(/TokenWise saved \d/, 'the TokenWise status')
      session.keys('/tokenwise')
      await session.waitFor(/tokenwise .*TokenWise: savings, learned rules and learning/, '/tokenwise in the command list')
      session.keys('Enter')
      await session.waitFor(/◆ TokenWise[\s\S]*THIS SESSION[\s\S]*Output +3 of 4 outputs filtered[\s\S]*SELF-EVOLUTION[\s\S]*l learn now/, 'the /tokenwise panel')
      keep('01-panel')
      await session.closePanel()
      session.keys('/tokenwise status', 'Enter')
      await session.waitFor(/TokenWise output: 3 outputs filtered, ~\S+ tokens saved, 1 passed unchanged/, 'the /tokenwise status report')
      log(`pi ${version} TUI: card ✓ status bar ✓ /tokenwise panel ✓ /tokenwise status ✓`)

      // 1b. Learning from the panel: evidence from this session, "l" and "y", a learner (pi itself, on the
      // session's model) writes a rule in the background, the panel and footer follow it, and pi announces the
      // adoption; the running session uses the rule from its next output on.
      writeLinkScript(work)
      const before = decisions()
      // The scripted model picks its next call by the tool results the conversation already holds.
      const sessionCommands = [...commands, './link.sh', './link.sh', './link.sh']
      mock.setScript({ commands: sessionCommands })
      session.keys('Run the link script three times.', 'Enter')
      const deadline = Date.now() + 120_000
      while (decisions() < before + 3) {
        if (Date.now() > deadline) throw new Error(`pi TUI: the link runs were not recorded\n${session.screen()}`)
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      await session.waitFor(/TokenWise saved \d/, 'the status after the link runs')
      session.keys('/tokenwise', 'Enter')
      await session.waitFor(/✦ Ready to learn[\s\S]*Worth learning +\.\/link\.sh +3 outputs/, 'the panel to suggest learning', 60_000)
      keep('02-panel-ready')
      session.keys('l')
      await session.waitFor(/Learn with pi · mock-model\?/, 'the learning confirmation')
      keep('03-panel-confirm')
      mock.setScript({ commands: [linkLearnerCommand()] })
      session.keys('y')
      await session.waitFor(/● (Starting|Learning|Verifying) \d+:\d\d/, 'the run in progress')
      keep('04-panel-learning')
      await session.waitFor(/Last run +✓ adopted rule link-progress/, 'the adoption in the panel', 240_000)
      await session.waitFor(/• link-progress/, 'the learned rule in the panel')
      keep('05-panel-adopted')
      await session.closePanel()
      await session.waitFor(/TokenWise learning adopted rule link-progress/, 'the adoption notice')
      keep('06-notice')
      const status = JSON.parse(readFileSync(join(tokenwiseHome, 'evolve', 'status.json'), 'utf8'))
      assert.equal(status.host, 'pi')
      assert.equal(status.learner, 'pi · mock-model')
      // The same session, next output: the learned rule applies.
      mock.setScript({ commands: [...sessionCommands, './link.sh'] })
      const sent = mock.requests.length
      session.keys('Run the link script once more.', 'Enter')
      const until2 = Date.now() + 120_000
      while (!mock.requests.slice(sent).some(request => toolResults(request).some(result => result.text.includes('link progress lines omitted')))) {
        if (Date.now() > until2) throw new Error(`pi TUI: the learned rule did not apply in the running session\n${session.screen()}`)
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      mock.setScript({ commands })
      log(`pi ${version} TUI: learning from the panel ✓ (pi learner on the session's model, held-out confirmed, notice, rule live in the same session)`)
    } finally { session.close() }

    // 2. pi config: off means not loaded at all; on again means filtering again.
    await toggleInConfig(false)
    const before = decisions()
    await printRun()
    assert.equal(decisions(), before, 'a disabled extension still filtered')
    await toggleInConfig(true)
    await printRun()
    assert.equal(decisions(), before + commands.length, 'the re-enabled extension did not filter')
    log(`pi ${version} TUI: pi config off/on ✓`)
  } finally {
    await mock.close()
  }
}
