import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore } from '@tokenwise/store'
import * as entry from '../src/index.ts'
import { bashShellResult } from '../src/bash.ts'
import type { BashOutput } from '../src/bash.ts'
import { createTokenWise } from '../src/plugin.ts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-opencode-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** `pytest -v` with 150 passing tests and one failure, merged as OpenCode's bash tool reads it. */
const pytest = [
  '============================= test session starts ==============================',
  'platform darwin -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0 -- /usr/bin/python3', 'cachedir: .pytest_cache', 'rootdir: /w',
  'collecting ... collected 151 items', '',
  ...Array.from({ length: 150 }, (_, i) => `tests/test_versions.py::test_parse_${i} PASSED${' '.repeat(30)}[${String(Math.floor(i * 100 / 151)).padStart(3)}%]`),
  `tests/test_versions.py::test_version_ordering FAILED${' '.repeat(22)}[100%]`, '',
  '=================================== FAILURES ===================================',
  '____________________________ test_version_ordering _____________________________', '',
  '    def test_version_ordering():', ">       assert '1.10.0' > '1.9.0'", "E       AssertionError: assert '1.10.0' > '1.9.0'", '',
  'tests/test_versions.py:12: AssertionError',
  '=========================== short test summary info ============================',
  "FAILED tests/test_versions.py::test_version_ordering - AssertionError: assert '1.10.0' > '1.9.0'",
  '========================= 1 failed, 150 passed in 0.12s =========================', '',
].join('\n')

/** The `tool.execute.after` output OpenCode 1.19.4's bash tool returns. */
const bashOutput = (text: string, exit: number | null, extra: Record<string, unknown> = {}): BashOutput =>
  ({ title: 'python3 -m pytest -v', output: text, metadata: { output: text, exit, truncated: false, ...extra } })

async function plugin(env: NodeJS.ProcessEnv = {}) {
  const home = temp()
  const errors: unknown[] = []
  const hooks = await createTokenWise({ env: { TOKENWISE_HOME: home, ...env }, onError: error => errors.push(error) })({ directory: temp() })
  return { home, hooks, errors }
}

const records = (home: string) => readdirSync(join(home, 'journal', 'opencode'))
  .flatMap(file => readFileSync(join(home, 'journal', 'opencode', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))

describe('TokenWise for OpenCode', () => {
  it('exports the plugin and nothing else, since OpenCode starts every exported function', () => {
    expect(Object.keys(entry)).toEqual(['TokenWise'])
    expect(typeof entry.TokenWise).toBe('function')
  })

  it('replaces a recognized bash result in place, failed commands included, and keeps the original', async () => {
    const { home, hooks, errors } = await plugin()
    const output = bashOutput(pytest, 1)
    await hooks['tool.execute.after']!({ tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'python3 -m pytest -v', description: 'Run tests' } }, output)
    expect(output.output.length).toBeLessThan(pytest.length / 4)
    expect(output.output).toContain("E       AssertionError: assert '1.10.0' > '1.9.0'")
    expect(output.output).toContain('tests/test_versions.py::test_version_ordering')
    // OpenCode's own display (metadata) keeps what the command printed.
    expect(output.metadata?.output).toBe(pytest)
    const [record] = records(home)
    expect(record).toMatchObject({ host: 'opencode', sessionId: 'ses_1', callId: 'call_1', tool: 'bash', exitCode: 1, outcome: 'projected', filter: 'pytest', delivery: 'in-process', streams: 'merged' })
    expect(new FileArtifactStore(home).read(record.raw.sha256)).toBe(pytest)
    expect(errors).toEqual([])
  })

  it('leaves other tools, cut, interrupted, empty and unrecognized results alone', async () => {
    const { home, hooks } = await plugin()
    const run = async (tool: string, output: BashOutput, command = 'python3 -m pytest -v') => {
      await hooks['tool.execute.after']!({ tool, sessionID: 'ses_1', callID: 'c', args: { command } }, output)
      return output.output
    }
    expect(await run('read', bashOutput(pytest, 1))).toBe(pytest)
    const cut = `...output truncated...\n\nFull output saved to: /tmp/tool_x\n\n${pytest}`
    expect(await run('bash', bashOutput(cut, 1, { truncated: true, outputPath: '/tmp/tool_x' }))).toBe(cut)
    const timedOut = `${pytest}\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 120000 ms.\n</shell_metadata>`
    expect(await run('bash', bashOutput(timedOut, null))).toBe(timedOut)
    expect(await run('bash', bashOutput('(no output)', 0))).toBe('(no output)')
    expect(await run('bash', bashOutput('hello\n', 0), 'echo hello')).toBe('hello\n')
    expect(records(home).map(record => record.reason)).toEqual(['already-truncated', 'interrupted-result', 'no-filter-match'])
  })

  it('does nothing when Economy is off or nothing can be saved', async () => {
    expect(await (await plugin({ TOKENWISE_DISABLE: '1' })).hooks).toEqual({})
    // No directory can be made under a plain file, so neither the data directory nor the TMPDIR fallback is writable.
    const file = join(temp(), 'file')
    writeFileSync(file, '')
    const hooks = await createTokenWise({ env: { TOKENWISE_HOME: join(file, 'home'), TMPDIR: join(file, 'tmp') } })({ directory: temp() })
    expect(hooks).toEqual({})
  })

  it('reads OpenCode\'s bash result shape', () => {
    expect(bashShellResult({ command: 'ls' }, bashOutput('a\nb\n', 0))).toEqual({ command: 'ls', rendered: 'a\nb\n', exitCode: 0, stdout: { start: 0, text: 'a\nb\n' } })
    expect(bashShellResult({ command: 'ls' }, bashOutput('a', 0, { truncated: true }))).toMatchObject({ truncated: true })
    expect(bashShellResult({ command: 'ls' }, bashOutput('a', null))).toMatchObject({ exitCode: -1, interrupted: true })
    expect(bashShellResult({}, bashOutput('a', 0))).toBeUndefined()
    expect(bashShellResult({ command: 'ls' }, { output: 'a', metadata: null })).toMatchObject({ interrupted: true })
  })

  it('shows the startup notice as a toast when a top-level session starts', async () => {
    const toasts: unknown[] = []
    let told = 0
    const client = { tui: { calls: toasts, async showToast(options: unknown) { this.calls.push(options) } } }
    const hooks = await createTokenWise({ env: { TOKENWISE_HOME: temp() }, notice: async () => 'TokenWise: output from make keeps coming back long.',
      told: async () => { told++ } })({ directory: temp(), client })
    await hooks.event!({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_1' } } } })
    await hooks.event!({ event: { type: 'session.updated', properties: { info: { id: 'ses_1' } } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(toasts).toEqual([])
    await hooks.event!({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(toasts).toEqual([{ body: { title: 'TokenWise', message: 'TokenWise: output from make keeps coming back long.', variant: 'info', duration: 15_000 } }])
    // Told only once the toast is up.
    expect(told).toBe(1)
  })

  it('lays out its own glob and grep results without losing a path or a row', async () => {
    const { home, hooks, errors } = await plugin()
    const root = '/Users/me/work/project/'
    const paths = Array.from({ length: 30 }, (_, i) => `${root}docs/rules/${i}-rule.md`)
    const glob = { title: 'docs/rules/*.md', output: paths.join('\n'), metadata: { count: 30, truncated: false } }
    await hooks['tool.execute.after']!({ tool: 'glob', sessionID: 'ses_1', callID: 'call_g', args: { pattern: 'docs/rules/*.md' } }, glob)
    expect(glob.output.startsWith(`[paths under ${root}docs/rules/, grouped by directory; original order retained]\n`)).toBe(true)
    for (let i = 0; i < 30; i++) expect(glob.output).toContain(`\n${i}-rule.md\n`)
    const files = Array.from({ length: 12 }, (_, i) => `${root}src/module_${i}.py`)
    const rows = ['Found 24 matches', ...files.flatMap((file, i) => [`${file}:`, `  Line ${i + 3}: def register_${i}():`, '', `  Line ${i + 40}:     register_${i}()`, '', ''])].join('\n')
    const grep = { title: 'register', output: rows, metadata: { matches: 24, truncated: false } }
    await hooks['tool.execute.after']!({ tool: 'grep', sessionID: 'ses_1', callID: 'call_r', args: { pattern: 'register' } }, grep)
    expect(grep.output).toBe(['Found 24 matches', `[files under ${root}src/]`,
      ...files.flatMap((_, i) => [`module_${i}.py:`, `  ${i + 3}: def register_${i}():`, `  ${i + 40}:     register_${i}()`]), ''].join('\n'))
    expect(records(home).map(r => [r.tool, r.outcome, r.filter])).toEqual([['glob', 'projected', 'native-glob'], ['grep', 'projected', 'native-grep']])
    const read = { title: 'a.py', output: '<path>/a</path>', metadata: {} }
    await hooks['tool.execute.after']!({ tool: 'read', sessionID: 'ses_1', callID: 'call_x', args: {} }, read)
    expect(read.output).toBe('<path>/a</path>')
    expect(errors).toEqual([])
  })

  it('says what a conversation saved when an answer ends, once, never for a subagent, a restart or a toast that failed', async () => {
    const toasts: { body: { message: string } }[] = []
    // A real toast is a request to the TUI: slow enough for a second idle to arrive before the first is told.
    const client = { tui: { calls: toasts, async showToast(options: { body: { message: string } }) { await new Promise(resolve => setTimeout(resolve, 15)); this.calls.push(options) } } }
    const home = temp()
    const plugin = (tui: unknown) => createTokenWise({ env: { TOKENWISE_HOME: home, LANG: 'en_US.UTF-8' }, notice: async () => undefined, told: async () => undefined })({ directory: temp(), client: tui as never })
    const failing = await plugin({ tui: { showToast: async () => { throw new Error('TUI away') } } })
    await failing['tool.execute.after']!({ tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'python3 -m pytest -v' } }, bashOutput(pytest, 1))
    await failing.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await new Promise(resolve => setTimeout(resolve, 20))
    // Not shown, so not told: the next OpenCode says it.
    const hooks = await plugin(client)
    const idle = (id: string) => hooks.event!({ event: { type: 'session.idle', properties: { sessionID: id } } })
    await hooks.event!({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_1' } } } })
    await idle('ses_child'); await idle('ses_1'); await idle('ses_1')
    await new Promise(resolve => setTimeout(resolve, 60))
    // The card under the toast's own "TokenWise" title: a small jar, what was saved, a bar; no colour (the toast prints escape codes as text).
    expect(toasts.map(t => t.body.message)).toEqual([expect.stringMatching(/^ ▗▄▄▖\n▗▛[●░]{2}▜▖ saved [\d,]+ tokens in this conversation\n▐[●·]{4}▌ [▰▱]{10} tool output \d+% shorter$/u)])
    // A restarted OpenCode resuming the session does not say the same number again.
    const restarted = await plugin(client)
    await restarted.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(toasts).toHaveLength(1)
  })

  it('shows nothing, and never fails, without a notice or a TUI', async () => {
    const failing = { tui: { showToast: async () => { throw new Error('no TUI') } } }
    let told = 0
    const hooks = await createTokenWise({ env: { TOKENWISE_HOME: temp() }, notice: async () => 'hello', told: async () => { told++ } })({ directory: temp(), client: failing })
    await expect(hooks.event!({ event: { type: 'session.created', properties: { info: { id: 's' } } } })).resolves.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 10))
    // A toast that did not show leaves the notice to be told.
    expect(told).toBe(0)
    const quiet = await createTokenWise({ env: { TOKENWISE_HOME: temp(), PATH: '' } })({ directory: temp(), client: failing })
    await expect(quiet.event!({ event: { type: 'session.created', properties: { info: { id: 's' } } } })).resolves.toBeUndefined()
  })
})
