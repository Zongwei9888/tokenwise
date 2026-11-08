import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore, RuleStore } from '@tokenwise/store'
import { claudeHook, codebuddyHook, eventHost, grokHook, hermesHook } from '../src/hook.ts'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-hooks-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** Three source files whose `grep -rn value src` output TokenWise shortens. */
function grepCase() {
  const cwd = temp()
  mkdirSync(join(cwd, 'src'))
  for (let f = 0; f < 3; f++) writeFileSync(join(cwd, 'src', `f${f}.ts`), Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i} // value line`).join('\n') + '\n')
  const output = spawnSync('/bin/sh', ['-c', 'grep -rn value src'], { cwd, encoding: 'utf8' }).stdout
  return { cwd, output, home: temp() }
}

/** An environment with `tokenwise` on PATH (a stub: wrapping never runs it). */
function withLc(home: string) {
  const bin = temp()
  writeFileSync(join(bin, 'tokenwise'), '#!/bin/sh\n')
  chmodSync(join(bin, 'tokenwise'), 0o755)
  // Claude Code's settings come from a temporary folder, never the machine's own ~/.claude.
  return { TOKENWISE_HOME: home, PATH: bin, HOME: temp(), CLAUDE_CONFIG_DIR: temp() } as NodeJS.ProcessEnv
}

/** `pytest -v` with 150 passing tests and one failure, as the e2e fixture project prints it. */
const failingPytest = [
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

const records = (home: string, host: string) => readdirSync(join(home, 'journal', host))
  .flatMap(file => readFileSync(join(home, 'journal', host, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))

// Event shapes as Claude Code 2.1.310, CodeBuddy 2.175.0 and Grok 1.0.70 sent them (captured from real sessions).
const claudeEvent = (event: string, command: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'cc-session', cwd: '/w', prompt_id: 'p1', permission_mode: 'default', hook_event_name: event, tool_name: 'Bash',
  tool_input: { command, description: 'Search' }, tool_use_id: 'toolu_01', ...extra,
})

describe('Claude Code hook', () => {
  it('replaces a successful call\'s output with its projection and keeps the original', () => {
    const { cwd, output, home } = grepCase()
    const response = { stdout: output.trimEnd(), stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
    const reply = JSON.parse(claudeHook(claudeEvent('PostToolUse', 'grep -rn value src', { cwd, tool_response: response }), { TOKENWISE_HOME: home })!)
    const replaced = reply.hookSpecificOutput.updatedToolOutput
    expect(reply.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    // The replacement keeps Bash's own result shape, which Claude Code requires.
    expect(Object.keys(replaced).sort()).toEqual(Object.keys(response).sort())
    expect(replaced.stdout.length).toBeLessThan(response.stdout.length)
    expect(replaced.stdout).toContain('omitted')
    const [record] = records(home, 'claude')
    expect(record).toMatchObject({ host: 'claude', sessionId: 'cc-session', callId: 'toolu_01', tool: 'Bash', delivery: 'result-hook', streams: 'separate', outcome: 'projected' })
    expect(new FileArtifactStore(home).read(record.raw.sha256)).toBe(response.stdout)
  })

  it('wraps commands in bypassPermissions mode only, and then leaves their output alone', () => {
    const { home } = grepCase()
    const env = withLc(home)
    expect(claudeHook(claudeEvent('PreToolUse', 'grep -rn value src'), env)).toBeUndefined()
    const wrapped = JSON.parse(claudeHook(claudeEvent('PreToolUse', 'grep -rn value src', { permission_mode: 'bypassPermissions' }), env)!)
    // No permission decision; the rest of the input stays as the model wrote it.
    expect(wrapped).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      updatedInput: { command: "tokenwise run --host claude --session cc-session --call toolu_01 -c 'grep -rn value src'", description: 'Search' } } })
    expect(claudeHook(claudeEvent('PreToolUse', 'grep -rn value src', { permission_mode: 'bypassPermissions', tool_input: { command: 'grep -rn value src', run_in_background: true } }), env)).toBeUndefined()
    const after = claudeEvent('PostToolUse', wrapped.hookSpecificOutput.updatedInput.command, { tool_response: { stdout: 'x', stderr: '', interrupted: false, isImage: false } })
    expect(claudeHook(after, env)).toBeUndefined()
  })

  it('outside bypassPermissions, wraps only one simple command the user\'s rules allow, and allows the wrapped form', () => {
    const { home } = grepCase()
    const env = withLc(home)
    const project = temp()
    const settings = (permissions: unknown) => { mkdirSync(join(project, '.claude'), { recursive: true }); writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions })) }
    const pre = (command: string, extra: Record<string, unknown> = {}) => claudeHook(claudeEvent('PreToolUse', command, { cwd: project, ...extra }), { ...env, CLAUDE_PROJECT_DIR: project })
    expect(pre('grep -rn value src')).toBeUndefined()
    settings({ allow: ['Bash(grep:*)', 'Bash(python3 -m pytest:*)'] })
    expect(JSON.parse(pre('grep -rn value src')!)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { command: "tokenwise run --host claude --session cc-session --call toolu_01 -c 'grep -rn value src'", description: 'Search' } } })
    // A trailing 2>&1 only merges stderr in (seen in a live session: the failing run went unfiltered without this).
    expect(JSON.parse(pre('grep -rn value src 2>&1')!).hookSpecificOutput.permissionDecision).toBe('allow')
    // Not allowed by a rule, compound, or in plan mode: as written.
    expect(pre('git diff')).toBeUndefined()
    expect(pre('grep -rn value src | head -5')).toBeUndefined()
    expect(pre('grep -rn value src', { permission_mode: 'plan' })).toBeUndefined()
    // Any deny or ask rule that could match wins, and so does a settings file that cannot be read.
    for (const permissions of [{ allow: ['Bash(grep:*)'], deny: ['Bash(grep -rn:*)'] }, { allow: ['Bash'], ask: ['Bash(gre:*)'] },
      { allow: ['Bash(grep:*)'], deny: ['Bash(grep -r*)'] }, { allow: ['Bash(grep:*)'], ask: ['Bash(something odd:*:*)'] }]) {
      settings(permissions)
      expect(pre('grep -rn value src'), JSON.stringify(permissions)).toBeUndefined()
    }
    // An exact allow rule covers the command as written, not one with 2>&1 added.
    settings({ allow: ['Bash(grep -rn value src)'] })
    expect(pre('grep -rn value src')).toBeDefined()
    expect(pre('grep -rn value src 2>&1')).toBeUndefined()
    writeFileSync(join(project, '.claude', 'settings.json'), '{ not json')
    expect(pre('grep -rn value src')).toBeUndefined()
    // The user's own settings count too; a deny there blocks a project allow.
    settings({ allow: ['Bash(grep:*)'] })
    writeFileSync(join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(grep:*)'] } }))
    expect(pre('grep -rn value src')).toBeUndefined()
  })

  it('leaves other tools, unrecognized output and images alone', () => {
    const { cwd, output, home } = grepCase()
    const env = { TOKENWISE_HOME: home }
    const response = { stdout: output, stderr: '', interrupted: false, isImage: false }
    expect(claudeHook(claudeEvent('PostToolUse', 'echo hi', { cwd, tool_response: { ...response, stdout: 'hi' } }), env)).toBeUndefined()
    expect(claudeHook({ ...claudeEvent('PostToolUse', 'grep -rn value src', { cwd, tool_response: response }), tool_name: 'Read' }, env)).toBeUndefined()
    expect(claudeHook(claudeEvent('PostToolUse', 'grep -rn value src', { cwd, tool_response: { ...response, isImage: true } }), env)).toBeUndefined()
    expect(claudeHook(claudeEvent('PostToolUseFailure', 'grep -rn value src', { cwd, error: 'Exit code 1' }), env)).toBeUndefined()
    expect(claudeHook(claudeEvent('PostToolUse', 'grep -rn value src', { cwd, tool_response: response }), { ...env, TOKENWISE_DISABLE: '1' })).toBeUndefined()
  })

  it('leaves events from Grok and CodeBuddy, which also run Claude Code hooks, to their own hook', () => {
    const { cwd, output, home } = grepCase()
    const response = { stdout: output, stderr: '', interrupted: false, isImage: false }
    const event = claudeEvent('PostToolUse', 'grep -rn value src', { cwd, tool_response: response })
    expect(eventHost({ ...event, hookEventName: 'post_tool_use' }, {})).toBe('grok')
    expect(eventHost(event, { GROK_HOOK_EVENT: 'post_tool_use' })).toBe('grok')
    expect(eventHost({ ...event, generation_id: 'g1' }, {})).toBe('codebuddy')
    expect(eventHost(event, {})).toBeUndefined()
    expect(claudeHook(event, { TOKENWISE_HOME: home, GROK_HOOK_EVENT: 'post_tool_use' })).toBeUndefined()
    expect(claudeHook({ ...event, generation_id: 'g1' }, { TOKENWISE_HOME: home })).toBeUndefined()
  })
})

describe('CodeBuddy hook', () => {
  const event = (command: string, extra: Record<string, unknown> = {}) => ({
    session_id: 'cb-session', cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'Search' },
    call_id: 'call_00_x', tool_use_id: 'call_00_x', agent_type: 'cli', permission_mode: 'default', client: 'CLI', version: '2.175.0', generation_id: 'g1', ...extra,
  })

  it('wraps recognizable commands without a permission decision, and normalizes them', () => {
    const { home } = grepCase()
    const reply = JSON.parse(codebuddyHook(event('rg value src'), withLc(home))!)
    expect(reply).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      updatedInput: { command: "tokenwise run --host codebuddy --session cb-session --call call_00_x -c 'rg -n -H value src'", description: 'Search' } } })
    expect(reply.hookSpecificOutput).not.toHaveProperty('permissionDecision')
    expect(records(home, 'codebuddy')).toMatchObject([{ type: 'economy/command-rewrite', original: 'rg value src', tool: 'Bash' }])
  })

  it('leaves other commands, background commands, other events and wrapped commands alone', () => {
    const env = withLc(temp())
    expect(codebuddyHook(event('echo hi'), env)).toBeUndefined()
    expect(codebuddyHook(event('pytest', { tool_input: { command: 'pytest', run_in_background: true } }), env)).toBeUndefined()
    expect(codebuddyHook(event('pytest', { hook_event_name: 'PostToolUse' }), env)).toBeUndefined()
    expect(codebuddyHook(event("tokenwise run -c 'pytest'"), env)).toBeUndefined()
  })

  it('wraps the command tokenwise doctor --probe asks for, and only that one of its own', () => {
    const env = withLc(temp())
    expect(JSON.parse(codebuddyHook(event('tokenwise probe tw0123abcd'), env)!).hookSpecificOutput.updatedInput.command)
      .toBe("tokenwise run --host codebuddy --session cb-session --call call_00_x -c 'tokenwise probe tw0123abcd'")
    for (const command of ['tokenwise probe tw0123abcd; rm -rf x', 'tokenwise probe', 'tokenwise rules']) expect(codebuddyHook(event(command), env), command).toBeUndefined()
  })
})

describe('Grok hook', () => {
  const event = (command: string, output: string, exitCode: number, extra: Record<string, unknown> = {}) => {
    const toolResult = { type: 'Bash', output: [...Buffer.from(output)], output_for_prompt: `exit: ${exitCode}\n${output}`, exit_code: exitCode,
      command, truncated: false, signal: null, timed_out: false, description: 'Search', current_dir: '/w', output_file: '/s/terminal/c.log', total_bytes: Buffer.byteLength(output) }
    return { hookEventName: 'post_tool_use', sessionId: 'gk-session', cwd: '/w', toolName: 'run_terminal_command', toolUseId: 'call-1-0', toolInput: { command },
      toolResult, isBackgrounded: false, hook_event_name: 'PostToolUse', session_id: 'gk-session', tool_name: 'run_terminal_command',
      tool_input: { command }, tool_response: toolResult, tool_use_id: 'call-1-0', ...extra }
  }

  it('replaces the model\'s copy of a result, failed commands included', () => {
    const { cwd, output, home } = grepCase()
    const env = { TOKENWISE_HOME: home }
    const grep = JSON.parse(grokHook(event('grep -rn value src', output, 0, { cwd }), env)!).hookSpecificOutput.updatedToolOutput as string
    expect(grep.startsWith('exit: 0\n')).toBe(true)
    expect(grep.length).toBeLessThan(output.length)
    expect(grep).toContain('omitted')
    const tests = JSON.parse(grokHook(event('python3 -m pytest -v', failingPytest, 1, { cwd }), env)!).hookSpecificOutput.updatedToolOutput as string
    expect(tests.startsWith('exit: 1\n')).toBe(true)
    expect(tests.length).toBeLessThan(failingPytest.length / 4)
    expect(tests).toContain("E       AssertionError: assert '1.10.0' > '1.9.0'")
    expect(tests).toContain('tests/test_versions.py::test_version_ordering')
    const journaled = records(home, 'grok')
    expect(journaled).toMatchObject([{ exitCode: 0, outcome: 'projected', streams: 'merged', delivery: 'result-hook', tool: 'run_terminal_command' },
      { exitCode: 1, outcome: 'projected', filter: 'pytest' }])
    expect(new FileArtifactStore(home).read(journaled[0].raw.sha256)).toBe(output)
  })

  it('leaves cut, oversized, unexpected and undecodable results alone', () => {
    const { cwd, output, home } = grepCase()
    const env = { TOKENWISE_HOME: home }
    const base = event('grep -rn value src', output, 0, { cwd })
    const result = base.toolResult
    // Cut by Grok: recorded as passed, never projected.
    expect(grokHook({ ...base, toolResult: { ...result, truncated: true } }, env)).toBeUndefined()
    // Over 128 KiB Grok sends the model-facing text as a string.
    expect(grokHook({ ...base, toolResult: `exit: 0\n${output}` }, env)).toBeUndefined()
    expect(grokHook({ ...base, toolResult: { ...result, output_for_prompt: `exit: 0\n[shortened]` } }, env)).toBeUndefined()
    expect(grokHook({ ...base, toolResult: { ...result, output: [0xff, 0xfe], output_for_prompt: 'exit: 0\n�' } }, env)).toBeUndefined()
    expect(grokHook({ ...base, isBackgrounded: true }, env)).toBeUndefined()
    expect(grokHook({ ...base, tool_name: 'read_file' }, env)).toBeUndefined()
    expect(records(home, 'grok')).toMatchObject([{ outcome: 'passed', reason: 'already-truncated' }])
  })
})

describe('Hermes hook', () => {
  // What the Hermes plugin sends for transform_terminal_output (Hermes 0.22.5).
  const event = (command: string, output: string, returncode: unknown, extra: Record<string, unknown> = {}) => ({
    hook_event_name: 'transform_terminal_output', command, output, returncode, task_id: 'hm-task', tool_call_id: 'call_1', env_type: 'local', ...extra })

  it('answers with the projection of a recognized output, failed commands included', () => {
    const { cwd, output, home } = grepCase()
    const env = { TOKENWISE_HOME: home }
    const grep = JSON.parse(hermesHook(event('grep -rn value src', output, 0, { cwd }), env)!).output as string
    expect(grep.length).toBeLessThan(output.length)
    expect(grep).toContain('omitted')
    const tests = JSON.parse(hermesHook(event('python3 -m pytest -v', failingPytest, 1, { cwd }), env)!).output as string
    expect(tests.length).toBeLessThan(failingPytest.length / 4)
    expect(tests).toContain("E       AssertionError: assert '1.10.0' > '1.9.0'")
    expect(records(home, 'hermes')).toMatchObject([
      { sessionId: 'hm-task', callId: 'call_1', tool: 'terminal', delivery: 'result-hook', streams: 'merged', exitCode: 0, outcome: 'projected' },
      { exitCode: 1, outcome: 'projected', filter: 'pytest' }])
  })

  it('leaves cut, stopped, background and unrecognized output alone', () => {
    const { cwd, output, home } = grepCase()
    const env = { TOKENWISE_HOME: home }
    const cut = `${output.slice(0, 2000)}\n\n... [OUTPUT TRUNCATED - 9,000 chars omitted out of 12,000 total] ...\n\n${output.slice(-2000)}`
    expect(hermesHook(event('grep -rn value src', cut, 0, { cwd }), env)).toBeUndefined()
    expect(hermesHook(event('python3 -m pytest -v', `${failingPytest}\n[Command timed out after 180s]`, 124, { cwd }), env)).toBeUndefined()
    expect(hermesHook(event('python3 -m pytest -v', `${failingPytest}\n[Command interrupted]`, 130, { cwd }), env)).toBeUndefined()
    expect(hermesHook(event('python3 -m pytest -v', failingPytest, null, { cwd }), env)).toBeUndefined()
    expect(hermesHook(event('echo hi', 'hi\n'.repeat(200), 0, { cwd }), env)).toBeUndefined()
    expect(hermesHook({ ...event('grep -rn value src', output, 0, { cwd }), hook_event_name: 'transform_tool_result' }, env)).toBeUndefined()
    // Output no filter recognizes passes through unchanged, recorded as evidence for learning.
    expect(records(home, 'hermes').map(record => record.reason)).toEqual(['already-truncated', 'interrupted-result', 'interrupted-result', 'no-filter-match'])
  })
})

describe('Claude Code output over its limit', () => {
  // Shape from Claude Code 2.1.x: stdout cut at 30,000 characters, the whole output in persistedOutputPath.
  it('filters the whole saved output instead of the cut, and replaces Claude\'s preview only when the result is shorter', () => {
    const { cwd, output, home } = grepCase()
    const saved = join(home, 'persisted.txt')
    writeFileSync(saved, output)
    const cut = output.slice(0, Math.floor(output.length * 0.9))
    const response = { stdout: cut, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, persistedOutputPath: saved, persistedOutputSize: Buffer.byteLength(output) }
    const reply = JSON.parse(claudeHook(claudeEvent('PostToolUse', 'grep -rn value src', { cwd, tool_response: response }), { TOKENWISE_HOME: home })!)
    const replaced = reply.hookSpecificOutput.updatedToolOutput
    expect(replaced.persistedOutputPath).toBeUndefined()
    expect(replaced.stdout.length).toBeLessThan(cut.length)
    // Built from the whole output: its last match is there, though the cut ended long before it.
    const last = output.trimEnd().split('\n').at(-1)!
    expect(cut).not.toContain(last)
    expect(replaced.stdout).toContain(last.split(':')[0])
    expect(records(home, 'claude').at(-1)).toMatchObject({ outcome: 'projected', raw: { bytes: Buffer.byteLength(output) } })
    // A saved file that is gone or of another size: Claude's own preview stays.
    for (const broken of [{ ...response, persistedOutputPath: join(home, 'gone.txt') }, { ...response, persistedOutputSize: 1 }]) {
      expect(claudeHook(claudeEvent('PostToolUse', 'grep -rn value src', { cwd, tool_response: broken }), { TOKENWISE_HOME: home })).toBeUndefined()
    }
  })
})

describe('learned rules on hook-based agents', () => {
  // Seen in a real Claude Code session: `pytest -v 2>&1 | tail -n 400` and project scripts never reached a learned rule.
  it('apply to a project\'s own command and to piped output, after the fact', () => {
    const home = temp()
    const store = new RuleStore(home)
    store.activate(store.installFiles([
      { path: 'index.json', text: JSON.stringify({ schemaVersion: 1, rules: [{ id: 'deploy-steps', file: 'rules/deploy-steps.js', transformation: 'noise-removal' }] }) },
      { path: 'rules/deploy-steps.js', text: "defineRule({ project(input, tw) { return /deploy\\.sh/.test(input.command) ? tw.keepLines(input.raw, line => !/^step \\d+ ok$/.test(line.text), n => '[' + n + ' step lines omitted]\\n') : null } })" },
    ]))
    const output = Array.from({ length: 200 }, (_, i) => `step ${i} ok`).join('\n') + '\ndeployed release 42\n'
    for (const command of ['./deploy.sh staging', './deploy.sh staging 2>&1 | tail -n 400']) {
      const response = { stdout: output, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
      const reply = JSON.parse(claudeHook(claudeEvent('PostToolUse', command, { cwd: home, tool_response: response }), { TOKENWISE_HOME: home })!)
      const shown = reply.hookSpecificOutput.updatedToolOutput.stdout as string
      expect(shown).toMatch(/^deployed release 42\n\[200 step lines omitted\]\n/u)
      expect(shown).not.toContain('step 7 ok')
    }
    const hermes = JSON.parse(hermesHook({ hook_event_name: 'transform_terminal_output', command: './deploy.sh staging', output, returncode: 0, task_id: 't', cwd: home },
      { TOKENWISE_HOME: home })!)
    expect(hermes.output).toContain('[200 step lines omitted]')
    expect(records(home, 'claude').map(record => record.rule)).toEqual(['deploy-steps', 'deploy-steps'])
  })
})
