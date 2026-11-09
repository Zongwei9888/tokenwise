import { describe, expect, it } from 'vitest'
import { compileLearnedRules, createPolicy, sha256 } from '@tokenwise/core'
import type { ArtifactPort, EconomyRecord } from '@tokenwise/protocol'
import { checkRequirements, collectEvidence, commandHead, defaultRequirements, verifyRules } from '../src/index.ts'

const artifacts = (texts: string[]): ArtifactPort => {
  const map = new Map(texts.map(text => [sha256(text), text]))
  return { save: () => { throw new Error('read-only') }, read: hash => map.get(hash) }
}
const record = (command: string, rendered: string, extra: Partial<EconomyRecord> = {}): EconomyRecord => ({
  schemaVersion: 1, type: 'economy/decision', time: '2026-10-14T00:00:00.000Z', host: 'pi', sessionId: 's', callId: 'c', tool: 'bash', command, exitCode: 0,
  delivery: 'in-process', streams: 'merged', mode: 'apply', outcome: 'passed', reason: 'no-filter-match', runtimeVersion: 'v', policyHash: 'p',
  raw: { sha256: sha256(rendered), bytes: rendered.length, tokens: Math.ceil(rendered.length / 4), stored: true },
  layout: { stdout: { start: 0, length: rendered.length } }, ...extra,
})
const progress = Array.from({ length: 50 }, (_, i) => `[${i + 1}/50] step ${i}`).join('\n') + '\nok\n'
const rule = (body: string) => compileLearnedRules([
  { path: 'index.json', text: JSON.stringify({ schemaVersion: 1, rules: [{ id: 'r', file: 'rules/r.js' }] }) },
  { path: 'rules/r.js', text: `defineRule({ project(input, tw) { ${body} } })` },
])

describe('evolution', () => {
  it('the built-in filters meet every preservation requirement', () => {
    const result = checkRequirements(createPolicy(), defaultRequirements())
    expect(result.results.filter(item => !item.passed)).toEqual([])
  })

  it('rebuilds evidence from the journal: stored, complete shell output only, no file contents, identical observations once', () => {
    const records = [
      record('./steps', progress), record('./steps', progress),
      record('./steps', progress, { layout: { stdout: { start: 0, length: progress.length }, truncated: true } }),
      record('./other', 'gone\n'.repeat(50)),
      record('./unstored', progress, { raw: { sha256: sha256(progress), bytes: 1, tokens: 1, stored: false } }),
      // File contents are never learned from.
      record('cat steps.log', progress), record('tail -n 200 steps.log', progress),
      (({ layout: _layout, ...rest }) => ({ ...rest, exitCode: null }))(record('grep {}', 'x')),
    ]
    const cases = collectEvidence(records, artifacts([progress]))
    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({ occurrences: 2, result: { command: './steps', rendered: progress, stdout: { start: 0, text: progress } } })
    expect(collectEvidence(records, artifacts([progress]), { since: new Date('2026-10-15') })).toEqual([])
  })

  it('accepts a gain without regressions, and names why it rejects', () => {
    const cases = collectEvidence([record('./steps', progress)], artifacts([progress]))
    const good = rule("return input.argv && input.argv[0] === './steps' ? tw.keepLines(input.raw, line => !/^\\[\\d+\\/\\d+\\]/.test(line.text)) : null")
    expect(verifyRules({ parent: undefined, candidate: good, cases })).toMatchObject({ accepted: true, improved: 1, reasons: [] })
    expect(verifyRules({ parent: good, candidate: good, cases })).toMatchObject({ accepted: false, reasons: ['unchanged', 'no-incremental-token-gain'] })
    const regression = verifyRules({ parent: good, candidate: undefined, cases })
    expect(regression).toMatchObject({ accepted: false, reasons: ['no-incremental-token-gain', 'replay-token-regression'] })
    // Lines of dots can be the program's own output when pytest does not capture it.
    const lossy = rule("return /^(python -m )?pytest /.test(input.command) ? tw.keepLines(input.raw, line => !/^\\.+$/.test(line.text)) : null")
    expect(verifyRules({ parent: undefined, candidate: lossy, cases })).toMatchObject({ accepted: false,
      reasons: expect.arrayContaining(['preservation-requirement-failed']) })
    // Removing a rule that broke a requirement is a repair, even without a gain.
    expect(verifyRules({ parent: lossy, candidate: undefined, cases })).toMatchObject({ accepted: true, changeKind: 'safety-repair' })
    const throws = rule("throw new Error('x')")
    expect(verifyRules({ parent: undefined, candidate: throws, cases })).toMatchObject({ accepted: false, reasons: expect.arrayContaining(['rule-error']), ruleFailures: { r: expect.any(Number) } })
  })

  it('rejects a rule that only fits the observations the learner saw, judging each command on its own', () => {
    const output = (seed: string) => Array.from({ length: 50 }, (_, i) => `[${i + 1}/50] step ${i} ${seed}`).join('\n') + '\nok\n'
    const a = output('alpha'), b = output('beta')
    const cases = collectEvidence([record('./steps', a), record('./steps', b, { time: '2026-10-13T00:00:00.000Z' })], artifacts([a, b]))
    const heldOut = new Set([cases.find(item => item.result.rendered === b)!.id])
    const general = rule("return input.argv && input.argv[0] === './steps' ? tw.keepLines(input.raw, line => !/^\\[\\d+\\/\\d+\\]/.test(line.text)) : null")
    expect(verifyRules({ parent: undefined, candidate: general, cases, heldOut })).toMatchObject({ accepted: true,
      generalization: { status: 'confirmed', commands: ['./steps'], heldOutCases: 1 } })
    // Matches the sample it saw, word for word.
    const memorized = rule("return input.raw.includes('alpha') ? tw.keepLines(input.raw, line => !/^\\[\\d+\\/\\d+\\]/.test(line.text)) : null")
    expect(verifyRules({ parent: undefined, candidate: memorized, cases, heldOut })).toMatchObject({ accepted: false, reasons: ['did-not-generalize'],
      generalization: { status: 'failed', heldOutGain: 0 } })
    // With nothing held out of that command, generalization is untested, not failed.
    expect(verifyRules({ parent: undefined, candidate: memorized, cases, heldOut: new Set() }))
      .toMatchObject({ accepted: true, generalization: { status: 'untested' } })
    // One command that generalizes does not hide another that only fits its samples.
    const c = output('gamma').replace(/step/gu, 'pass'), d = output('delta').replace(/step/gu, 'pass')
    const both = collectEvidence([record('./steps', a), record('./steps', b, { time: '2026-10-13T00:00:00.000Z' }),
      record('./other', c, { time: '2026-10-12T00:00:00.000Z' }), record('./other', d, { time: '2026-10-11T00:00:00.000Z' })], artifacts([a, b, c, d]))
    const mixed = rule("if (!input.argv) return null; if (input.argv[0] === './steps' || input.raw.includes('gamma')) return tw.keepLines(input.raw, line => !/^\\[\\d+\\/\\d+\\]/.test(line.text)); return null")
    const held = new Set(both.filter(item => item.result.rendered === b || item.result.rendered === d).map(item => item.id))
    expect(verifyRules({ parent: undefined, candidate: mixed, cases: both, heldOut: held })).toMatchObject({ accepted: false, reasons: ['did-not-generalize'],
      generalization: { status: 'failed', byCommand: [{ command: './other', heldOutGain: 0 }, { command: './steps', heldOutCases: 1 }] } })
  })

  it('groups commands by tool and subcommand', () => {
    expect(['npm install', 'npm test -- -u', 'pytest -v', 'python3 app.py', 'git diff --stat', './build.sh', 'cargo test --release'].map(commandHead))
      .toEqual(['npm install', 'npm test', 'pytest', 'python3', 'git diff', './build.sh', 'cargo test'])
    // What agents really run: a cd, pipes, assignments, setup commands.
    expect([
      'cd /tmp/work && python3 -m pytest -v 2>&1 | tail -15',
      'cd packages/x/src; grep -n "a\\|b" index.ts | head -20',
      'cd "/some dir" && FOO=1 cargo test --release',
      'export CI=1 && npx jest --silent',
      'source .venv/bin/activate; python app.py',
      'cat file.txt | grep x',
      'cd src',
    ].map(commandHead)).toEqual(['python3 -m pytest', 'grep', 'cargo test', 'jest', 'python', 'cat', 'cd src'])
    // Loops and conditions name the command inside them (a startup notice once named `for t`).
    expect(['for t in a b; do python3 -m pytest $t; done', 'while true; do ./poll.sh; done', 'if [ -f x ]; then make build; fi']
      .map(commandHead)).toEqual(['python3 -m pytest', './poll.sh', 'make build'])
    // Steps that print nothing and leading words give way to the command that prints; any interpreter's -m tool is one tool.
    expect(['sleep 3; tmux capture-pane -p', 'time python3 -m pytest', '[ -f x ] && make build', 'for f in *; do [ -d $f ] || continue; ./check.sh $f; done',
      'mkdir -p out && ./build.sh', '~/venv/bin/python -m pytest -q', '/usr/bin/python3 -m pip install x']
      .map(commandHead)).toEqual(['tmux capture-pane', 'python3 -m pytest', 'make build', './check.sh', './build.sh', 'python -m pytest', 'python3 -m pip'])
    // Wrappers with their own options and values; a script with a subcommand is a tool of its own.
    expect(['nice -n 10 make test', 'sudo -u pg psql -c x', 'time -p cargo build', 'command -v x && make', 'env FOO=1 npm test', 'timeout 60 npm test',
      'timeout -s KILL 5m ./e2e.sh', 'env', 'python manage.py test', 'python3 app.py', 'node --test', 'node server.js'].map(commandHead))
      .toEqual(['make test', 'psql', 'cargo build', 'make', 'npm test', 'npm test', './e2e.sh', 'env', 'python manage.py test', 'python3', 'node --test', 'node'])
    // A function defined in place runs its body: grouped by the body's program, not by `q(){`.
    expect(['q(){ curl -s "$1"; }; q https://x', 'run() { echo start; make build; }; run', 'f(){ ./deploy.sh; }; f'].map(commandHead))
      .toEqual(['curl', 'make build', './deploy.sh'])
  })

  it('leaves out of evidence what the agent looked up, as it does file contents', () => {
    const listing = Array.from({ length: 60 }, (_, i) => `src/file_${i}.ts:${i}: const value = ${i}`).join('\n') + '\n'
    const cases = collectEvidence([record('grep -rn value src', listing), record('git diff HEAD~1', listing), record('curl -s https://x.dev/a', listing),
      record('./build.sh', progress)], artifacts([listing, progress]))
    expect(cases.map(item => item.result.command)).toEqual(['./build.sh'])
  })
})
