import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FileJournal, removeTree } from '@tokenwise/store'
import type { EconomyRecord } from '@tokenwise/protocol'
import { parseDuration } from '../src/evolve.ts'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-evolve-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) removeTree(dir) })

function tokenwise(args: string[], options: { cwd?: string; home: string; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(process.execPath, ['--conditions=source', main, ...args], {
    cwd: options.cwd, encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh', TOKENWISE_HOME: options.home, ...options.env },
  })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

/** A project whose build script prints progress lines no built-in filter knows. */
function project() {
  const dir = temp()
  const progress = Array.from({ length: 80 }, (_, i) => `[${String(i + 1).padStart(3)}/80] Compiling module_${i}.rs`).join('\\n')
  writeFileSync(join(dir, 'build.sh'), `#!/bin/sh\nprintf '${progress}\\nFinished release in 4.2s\\n'\n`)
  chmodSync(join(dir, 'build.sh'), 0o755)
  writeFileSync(join(dir, 'module.py'), 'payload = """first\n' + '\n'.repeat(128) + 'last"""\nprint(payload)\n')
  mkdirSync(join(dir, 'src'))
  for (let f = 0; f < 3; f++) writeFileSync(join(dir, 'src', `f${f}.ts`), Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i} // value line`).join('\n') + '\n')
  return dir
}

/** A learner: a shell script that writes rules-work and runs the checker, as an agent would. */
function learner(dir: string, name: string, rule: string, match = "input.argv && input.argv[0] === './build.sh'") {
  const script = join(dir, `${name}.sh`)
  writeFileSync(script, `#!/bin/sh
set -e
test -f PROMPT.md && test -f RULES.md && test -f evidence-index.json
mkdir -p rules-work/rules
cat > rules-work/index.json <<'JSON'
{ "schemaVersion": 1, "rules": [{ "id": "${name}", "file": "rules/${name}.js", "transformation": "noise-removal" }] }
JSON
cat > rules-work/rules/${name}.js <<'JS'
defineRule({ project(input, tw) {
  if (!(${match})) return null
  ${rule}
} })
JS
echo "${name}: see evidence" > rules-work/CHANGELOG.md
./check > check.txt || true
./try cases/0001.json > try.txt
`)
  return `sh ${script}`
}

/** A stand-in for cargo: dependency progress the built-in cargo filter removes, then a finished line. */
function cargo(dir: string) {
  writeFileSync(join(dir, 'cargo'), '#!/bin/sh\ni=1; while [ "$i" -le 60 ]; do echo "   Compiling crate_$i v0.1.$i"; i=$((i + 1)); done\necho "    Finished dev [unoptimized] target(s) in 3.2s"\n')
  chmodSync(join(dir, 'cargo'), 0o755)
}

const PROGRESS_RULE = "return tw.keepLines(input.raw, line => !/^\\[\\s*\\d+\\/\\d+\\] Compiling /.test(line.text), n => '[' + n + ' compile progress lines omitted]\\n')"

describe('tokenwise evolve', () => {
  it('learns a rule from recorded evidence, verifies and adopts it, and new sessions use it', () => {
    const home = temp(), cwd = project(), work = temp()
    for (let i = 0; i < 3; i++) expect(tokenwise(['run', '-c', './build.sh'], { cwd, home }).status).toBe(0)
    // Nothing is filtered yet, but the originals are kept as evidence.
    const before = new FileJournal(home).read({ host: 'shell' }) as EconomyRecord[]
    expect(before.map(record => [record.outcome, record.reason, record.raw?.stored])).toEqual(Array(3).fill(['passed', 'no-filter-match', true]))

    const run = tokenwise(['evolve', '--learner', learner(work, 'build-progress', PROGRESS_RULE), '--json'], { cwd, home })
    expect(run.err).toContain('1 observations as evidence, 1 shown to the learner')
    const report = JSON.parse(run.out)
    expect(report).toMatchObject({ accepted: true, cases: 1, improved: 1, regressions: [], reasons: [] })
    expect(report.gainTokens).toBeGreaterThan(0)
    expect(report.adopted).toMatch(/^[a-f0-9]{64}$/)
    // The learner saw the checker's verdict and its rule's output on the case.
    expect(readFileSync(join(report.workspace, 'check.txt'), 'utf8')).toMatch(/^ACCEPTED/)
    expect(readFileSync(join(report.workspace, 'try.txt'), 'utf8')).toContain('projected by rule build-progress')
    expect(JSON.parse(readFileSync(join(report.workspace, 'cases', '0001.json'), 'utf8'))).toMatchObject({ command: './build.sh', occurrences: 3 })

    expect(tokenwise(['rules'], { home }).out).toContain(`active: ${report.adopted.slice(0, 12)}`)
    expect(tokenwise(['rules', 'show'], { home }).out).toContain('--- rules/build-progress.js')
    const filtered = tokenwise(['run', '-c', './build.sh'], { cwd, home })
    // The shortened output ends with where its original is (Economy's recall hint).
    expect(filtered.out).toMatch(/^Finished release in 4\.2s\n\[80 compile progress lines omitted\]\n\[TokenWise shortened this output\. The complete output is observation (o-[a-f0-9]{12}): .*`tokenwise recall \1`\.\]\n$/u)
    const last = (new FileJournal(home).read({ host: 'shell' }) as EconomyRecord[]).at(-1)!
    expect(last).toMatchObject({ outcome: 'projected', filter: 'learned-rule', rule: 'build-progress', learnedRulesHash: report.adopted })

    // The build output is now short: nothing is left to learn from it.
    const again = JSON.parse(tokenwise(['evolve', '--learner', 'true', '--json'], { cwd, home }).out)
    expect(again).toMatchObject({ accepted: false, reasons: ['nothing-to-learn'], adopted: null })
    // A learner that leaves the rules as they were is not adopted either.
    tokenwise(['run', '-c', 'seq 1 2000'], { cwd, home })
    const unchanged = JSON.parse(tokenwise(['evolve', '--learner', 'true', '--json'], { cwd, home }).out)
    expect(unchanged).toMatchObject({ accepted: false, reasons: ['unchanged', 'no-incremental-token-gain'], adopted: null })
    expect(tokenwise(['rules'], { home }).out).toContain(`active: ${report.adopted.slice(0, 12)}`)

    // Roll back: new sessions read the build output in full again.
    expect(tokenwise(['rules', 'rollback'], { home }).out).toContain('No learned rules are active now.')
    expect(tokenwise(['run', '-c', './build.sh'], { cwd, home }).out).toContain('[ 80/80] Compiling module_79.rs')
  }, 60_000)

  it('keeps file contents out of learning, and rejects a rule that does worse than the built-in filters', () => {
    const home = temp(), cwd = project(), work = temp()
    tokenwise(['run', '-c', './build.sh'], { cwd, home })
    tokenwise(['run', '-c', 'cat module.py'], { cwd, home })
    cargo(cwd)
    expect(tokenwise(['run', '-c', './cargo build'], { cwd, home }).out).toContain('Cargo dependency progress rows omitted')
    // What the agent looked up is not evidence either.
    tokenwise(['run', '-c', 'grep -rn value src'], { cwd, home })

    // Squeezing blank lines would hit literal data in a source dump, but learned rules never see file contents:
    // the cat output is not evidence, and the source-dump requirements hold.
    const blanks = tokenwise(['evolve', '--learner', learner(work, 'squeeze-blanks', "return tw.keepLines(input.raw, (line, i, all) => !(line.text === '' && i > 0 && all[i - 1].text === ''))",
      "input.argv !== null"), '--json'], { cwd, home })
    expect(JSON.parse(blanks.out)).toMatchObject({ accepted: false, adopted: null, cases: 2, requirementFailures: [], reasons: ['no-incremental-token-gain'] })

    // A rule that keeps nearly all of a build the built-in filter shortens far more saves less there.
    const greedy = tokenwise(['evolve', '--learner', learner(work, 'cargo-lite', 'return tw.keepLines(input.raw, (line, i) => i >= 8)', "input.argv && input.argv[0] === './cargo'"), '--json'], { cwd, home })
    expect(JSON.parse(greedy.out)).toMatchObject({ accepted: false, adopted: null, reasons: ['no-incremental-token-gain', 'replay-token-regression'],
      regressions: [{ command: './cargo build' }] })

    // A rule that throws is a rule error.
    const broken = tokenwise(['evolve', '--learner', learner(work, 'broken', "throw new Error('boom')"), '--json'], { cwd, home })
    expect(JSON.parse(broken.out)).toMatchObject({ accepted: false, reasons: expect.arrayContaining(['rule-error']), ruleFailures: { broken: expect.any(Number) } })
    expect(tokenwise(['rules'], { home }).out).toContain('No learned rules yet')
  }, 60_000)

  it('refuses a rule directory that does not load, and reports when there is nothing to learn from', () => {
    const home = temp(), cwd = project(), work = temp()
    expect(tokenwise(['evolve', '--learner', 'true'], { cwd, home }).err).toContain('nothing to learn from yet')
    tokenwise(['run', '-c', './build.sh'], { cwd, home })
    const script = join(work, 'bad.sh')
    writeFileSync(script, 'mkdir -p rules-work/rules\necho \'{"schemaVersion":1,"rules":[{"id":"x","file":"rules/x.js"}]}\' > rules-work/index.json\necho "not javascript (" > rules-work/rules/x.js\n')
    const result = tokenwise(['evolve', '--learner', `sh ${script}`], { cwd, home })
    expect(result.status).toBe(1)
    expect(result.out).toMatch(/^NOT ACCEPTED: loading rules failed/)
    expect(tokenwise(['evolve'], { home }).err).toContain('choose a learner')
    expect(tokenwise(['evolve', '--learner', 'true', '--since', 'yesterday'], { home }).status).toBe(2)
    // Each run keeps its workspace, learner log and verdict for inspection.
    const runs = readdirSync(join(home, 'evolve'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    expect(runs.length).toBeGreaterThanOrEqual(1)
    expect(readdirSync(join(home, 'evolve', runs.at(-1)!)).sort()).toEqual(['checker.json', 'feedback.json', 'learner.log', 'workspace'])
    // The status the hosts' interfaces read: the last run, finished, and a history of runs.
    expect(JSON.parse(readFileSync(join(home, 'evolve', 'status.json'), 'utf8'))).toMatchObject({ host: 'cli', phase: 'done', outcome: { result: 'failed' } })
    expect(readFileSync(join(home, 'evolve', 'history.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('verifies against its own record of the evidence, and stops whatever the learner left running', () => {
    const home = temp(), cwd = project(), work = temp()
    tokenwise(['run', '-c', './build.sh'], { cwd, home })
    cargo(cwd)
    expect(tokenwise(['run', '-c', './cargo build'], { cwd, home }).out).toContain('omitted')
    // A learner that shadows the built-in cargo filter (a regression there) and hides that observation from the checker file.
    const script = join(work, 'tamper.sh')
    writeFileSync(script, `${readFileSync(learner(work, 'cargo-lite', 'return tw.keepLines(input.raw, (line, i) => i >= 8)', "input.argv && (input.argv[0] === './cargo' || input.argv[0] === './build.sh')").slice(3), 'utf8')}
node -e "const f='../checker.json';const s=JSON.parse(require('fs').readFileSync(f,'utf8'));s.caseIds=s.caseIds.slice(0,1);require('fs').writeFileSync(f,JSON.stringify(s))"
(sleep 30; echo late > rules-work/late.txt) &
`)
    const started = Date.now()
    const result = JSON.parse(tokenwise(['evolve', '--learner', `sh ${script}`, '--json'], { cwd, home }).out)
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(result).toMatchObject({ accepted: false, cases: 2, reasons: expect.arrayContaining(['replay-token-regression']) })
  }, 60_000)

  it('parses durations', () => {
    expect([parseDuration('30m'), parseDuration('12h'), parseDuration('7d'), parseDuration('7 days')]).toEqual([1_800_000, 43_200_000, 604_800_000, undefined])
  })
})

