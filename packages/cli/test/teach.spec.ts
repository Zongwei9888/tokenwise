import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '@tokenwise/store'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
/** Where teaching happens for a data directory: a private temporary directory, which agents' sandboxes can write. */
const teachRoot = (home: string) => join(resolve(process.env.TMPDIR?.trim() || tmpdir()), `tokenwise-teach-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12)}`)
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-teach-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) { removeTree(dir); removeTree(teachRoot(dir)) } })

function tokenwise(args: string[], options: { cwd?: string; home: string; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(process.execPath, ['--conditions=source', main, ...args], {
    cwd: options.cwd, encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh', TOKENWISE_HOME: options.home, TOKENWISE_DISABLE: '', ...options.env },
  })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

/** A project whose build script prints as many progress lines as asked, then a summary: a format no built-in filter knows. */
function project() {
  const dir = temp()
  writeFileSync(join(dir, 'build.sh'), `#!/bin/sh
i=1; while [ "$i" -le "$1" ]; do echo "[$i/$1] Compiling module_$i.rs"; i=$((i + 1)); done
echo "Finished release in 4.2s"
`)
  chmodSync(join(dir, 'build.sh'), 0o755)
  return dir
}

/** What the person's agent writes in the workspace. */
function writeRule(workspace: string, body: string) {
  mkdirSync(join(workspace, 'rules-work', 'rules'), { recursive: true })
  writeFileSync(join(workspace, 'rules-work', 'index.json'),
    JSON.stringify({ schemaVersion: 1, rules: [{ id: 'build-progress', file: 'rules/build-progress.js', transformation: 'noise-removal' }] }))
  writeFileSync(join(workspace, 'rules-work', 'rules', 'build-progress.js'),
    `defineRule({ project(input, tw) {\n  if (!input.argv || input.argv[0] !== './build.sh') return null\n  ${body}\n} })\n`)
}

const PROGRESS_RULE = "return tw.keepLines(input.raw, line => !/^\\[\\d+\\/\\d+\\] Compiling /.test(line.text), n => '[' + n + ' compile progress lines omitted]\\n')"

describe('tokenwise checkup and teach', () => {

  it('teaches only in a folder of its own, never through a link someone left in the temporary directory', () => {
    const home = temp(), cwd = project(), elsewhere = temp()
    for (const n of [60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
    symlinkSync(elsewhere, teachRoot(home))
    try {
      expect(tokenwise(['teach', './build.sh'], { home })).toMatchObject({ status: 1, err: expect.stringContaining('is not a folder of your own (another user\'s, or a link)') })
      expect(readdirSync(elsewhere)).toEqual([])
      expect(tokenwise(['teach'], { home }).out).toContain('Nothing is being taught')
    } finally { rmSync(teachRoot(home)) }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('keeps from outside a sandbox whose TMPDIR is its own folder in /tmp, as Claude Code\'s is', () => {
    const home = temp(), cwd = project()
    const sandboxTmp = mkdtempSync('/tmp/tokenwise-sandbox-')
    try {
      for (const n of [60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
      const sandboxed = { home, env: { TMPDIR: sandboxTmp } }
      const workspace = /Workspace: (\S+)/u.exec(tokenwise(['teach', './build.sh'], sandboxed).out)![1]!
      expect(workspace.startsWith(sandboxTmp)).toBe(true)
      writeRule(workspace, PROGRESS_RULE)
      expect(tokenwise(['teach', 'check'], sandboxed).out).toMatch(/^ACCEPTED/u)
      // Escalated, the command has the usual TMPDIR, and still finds the workspace.
      expect(tokenwise(['teach'], { home }).out).toContain('./build.sh')
      expect(tokenwise(['teach', 'keep'], { home })).toMatchObject({ status: 0, out: expect.stringContaining('Kept.') })
      expect(existsSync(workspace)).toBe(false)
      expect(readdirSync(sandboxTmp)).toEqual([])
    } finally { removeTree(sandboxTmp) }
  }, 30_000)

  it('keeps a rule only by its own check: editing the workspace\'s checker file does not get a rule through', () => {
    const home = temp(), cwd = project()
    for (const n of [60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
    const workspace = /Workspace: (\S+)/u.exec(tokenwise(['teach', './build.sh'], { home }).out)![1]!
    // Asking for a command with nothing to teach leaves this teaching as it was.
    expect(tokenwise(['teach', './nope.sh'], { home }).status).toBe(1)
    expect(existsSync(workspace)).toBe(true)
    expect(tokenwise(['teach'], { home }).out).toContain('./build.sh')
    // A rule that saves next to nothing: one line per output.
    writeRule(workspace, "return tw.keepLines(input.raw, line => !/^Finished/.test(line.text), n => '')")
    expect(tokenwise(['teach', 'check'], { home }).out).toContain('NOT ACCEPTED')
    // The agent lowers the bar in the checker file it can edit.
    const checkerFile = join(workspace, '..', 'checker.json')
    writeFileSync(checkerFile, JSON.stringify({ ...JSON.parse(readFileSync(checkerFile, 'utf8')), minimumSavedTokens: 0 }))
    expect(tokenwise(['teach', 'check'], { home }).out).toMatch(/^ACCEPTED/u)
    expect(tokenwise(['teach', 'preview'], { home }).out).toContain('Check: NOT ACCEPTED yet.')
    expect(tokenwise(['teach', 'keep'], { home })).toMatchObject({ status: 1, out: expect.stringContaining('Not kept') })
    expect(JSON.parse(tokenwise(['rules', '--json'], { home }).out).history).toEqual([])
  }, 30_000)
  it('says when nothing is recorded yet', () => {
    const home = temp()
    expect(tokenwise(['checkup'], { home }).out).toContain('no shell output recorded yet')
    expect(tokenwise(['teach'], { home }).out).toContain('Nothing is being taught')
    expect(tokenwise(['teach', 'cargo', 'build'], { home })).toMatchObject({ status: 1, out: expect.stringContaining('No recorded output of `cargo build` is kept') })
    expect(existsSync(teachRoot(home))).toBe(false)
    // Reading a file is never taught, and says so rather than that nothing was recorded.
    expect(tokenwise(['teach', 'cat build.log'], { home }).out).toContain('`cat` prints file contents the agent asked to read')
    expect(tokenwise(['preview', 'sed -n 1,80p src/a.ts'], { home }).err).toContain('which TokenWise leaves as it is')
    expect(tokenwise(['preview', 'make'], { home }).err).toContain('originals are kept for 14 days')
    const cwd = project()
    writeFileSync(join(cwd, 'lint.sh'), '#!/bin/sh\necho "lint: 42 files checked"\necho "lint: no problems found"\n')
    chmodSync(join(cwd, 'lint.sh'), 0o755)
    tokenwise(['run', '-c', './lint.sh'], { cwd, home })
    expect(tokenwise(['teach', './lint.sh'], { home })).toMatchObject({ status: 1, out: expect.stringContaining('`./lint.sh` prints only a few lines, so there is nothing worth teaching.') })
  }, 30_000)

  it('finds a noisy command, teaches it with the person watching, and keeps the rule only on keep', () => {
    const home = temp(), cwd = project()
    for (const n of [60, 70, 80]) expect(tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home }).status).toBe(0)
    // A short listing run once is long enough to record but not worth a rule.
    writeFileSync(join(cwd, 'listing.sh'), '#!/bin/sh\ni=1; while [ "$i" -le 15 ]; do echo "drwxr-xr-x  5 user staff  160 Nov  2 14:34 folder_$i"; i=$((i + 1)); done\n')
    chmodSync(join(cwd, 'listing.sh'), 0o755)
    tokenwise(['run', '-c', './listing.sh'], { cwd, home })

    // A search prints what the agent asked for: never suggested, and not taught.
    mkdirSync(join(cwd, 'src'))
    for (let f = 0; f < 4; f++) writeFileSync(join(cwd, 'src', `m${f}.ts`), Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i} // TODO check value`).join('\n') + '\n')
    for (let i = 0; i < 3; i++) tokenwise(['run', '-c', 'grep -rn TODO src'], { cwd, home })

    const checkup = tokenwise(['checkup'], { home }).out
    expect(checkup).not.toContain('listing.sh')
    expect(checkup).not.toMatch(/^ +\d\. grep/mu)
    expect(tokenwise(['teach', 'grep -rn TODO src'], { home })).toMatchObject({ status: 1,
      out: expect.stringContaining('`grep` prints what the agent asked to see (search results, listings, diffs), so any line can be the answer') })
    expect(checkup).toContain('7 shell outputs from shell')
    expect(checkup).toContain('No learned rules in use yet.')
    expect(checkup).toMatch(/1\. \.\/build\.sh +3 outputs, about 71 lines each; the model reads 100% of them now/u)
    expect(checkup).toContain('Teach one: tokenwise teach "./build.sh"')

    const started = tokenwise(['teach', './build.sh'], { home })
    expect(started.out).toContain('Teaching TokenWise about `./build.sh`: 3 recorded outputs; 2 to study, 1 held back to test the rule.')
    const workspace = /Workspace: (\S+)/u.exec(started.out)![1]!
    expect(existsSync(join(workspace, 'PROMPT.md'))).toBe(true)
    expect(tokenwise(['teach', 'status'], { home }).out).toContain(workspace)

    // Before any rule: the check says why not, and keep refuses.
    expect(tokenwise(['teach', 'check'], { home })).toMatchObject({ status: 1, out: expect.stringContaining('NOT ACCEPTED') })
    expect(tokenwise(['teach', 'keep'], { home })).toMatchObject({ status: 1, out: expect.stringContaining('Not kept') })

    writeRule(workspace, PROGRESS_RULE)
    expect(tokenwise(['teach', 'check'], { home }).out).toMatch(/^ACCEPTED/u)
    const preview = tokenwise(['teach', 'preview'], { home }).out
    expect(preview).toContain('`./build.sh`: one recorded output')
    expect(preview).toMatch(/original: +81 lines\n {2}the model reads now: +81 lines \(all of it\)\n {2}with the new rule: +2 lines/u)
    expect(preview).toContain('--- what the model would read with the new rule ---\nFinished release in 4.2s\n[80 compile progress lines omitted]\n---')
    expect(preview).toMatch(/the model would read \d+% of the original instead of 100%/u)
    expect(preview).toContain('Check: ACCEPTED. It keeps every error and failure')
    expect(preview).toContain('also saves on 1 recorded output it was not shown')

    const kept = tokenwise(['teach', 'keep'], { home })
    expect(kept).toMatchObject({ status: 0, out: expect.stringContaining('Kept. From the next command on, every agent reads the shorter `./build.sh` output (rule build-progress; you have taught TokenWise 1 rule).') })
    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(teachRoot(home))).toBe(false)
    expect(JSON.parse(tokenwise(['rules', '--json'], { home }).out).history[0].taught).toEqual({ command: './build.sh', rules: ['build-progress'] })

    // Every agent now gets the shorter output, and the checkup says who taught it.
    expect(tokenwise(['run', '-c', './build.sh 90'], { cwd, home }).out).toMatch(/^Finished release in 4\.2s\n\[90 compile progress lines omitted\]\n/u)
    const after = tokenwise(['checkup'], { home }).out
    expect(after).toContain('Learned rules in use: 1 (1 you taught, 0 learned in the background).')
    expect(after).toMatch(/build-progress +taught by you, for \.\/build\.sh; shortened 1 output/u)
    expect(after).not.toContain('Teach one: tokenwise teach "./build.sh"')
    expect(tokenwise(['preview', './build.sh'], { home }).out).toMatch(/the model reads now: +2 lines/u)
    // Nothing is left to teach about it.
    expect(tokenwise(['teach', './build.sh'], { home }).out).toContain('already shortens `./build.sh` to under half')
  }, 30_000)

  it('does not keep a rule that drops an error, and drop discards the workspace', () => {
    const home = temp(), cwd = project()
    writeFileSync(join(cwd, 'build.sh'), `#!/bin/sh
i=1; while [ "$i" -le "$1" ]; do echo "[$i/$1] Compiling module_$i.rs"; i=$((i + 1)); done
echo "error: linking failed"
`)
    for (const n of [60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
    const workspace = /Workspace: (\S+)/u.exec(tokenwise(['teach', './build.sh'], { home }).out)![1]!
    writeRule(workspace, "return tw.keepLines(input.raw, line => false, n => '[' + n + ' lines omitted]\\n')")
    expect(tokenwise(['teach', 'preview'], { home }).out).toContain('Check: NOT ACCEPTED yet.')
    expect(tokenwise(['teach', 'keep'], { home })).toMatchObject({ status: 1, out: expect.stringContaining('Not kept') })
    expect(JSON.parse(tokenwise(['rules', '--json'], { home }).out).history).toEqual([])
    expect(tokenwise(['teach', 'drop'], { home }).out).toBe('Discarded the rule being taught.\n')
    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(teachRoot(home))).toBe(false)
    // A workspace left unfinished goes when its originals would (14 days).
    const left = /Workspace: (\S+)/u.exec(tokenwise(['teach', './build.sh'], { home }).out)![1]!
    const current = join(teachRoot(home), 'current.json')
    writeFileSync(current, JSON.stringify({ ...JSON.parse(readFileSync(current, 'utf8')), startedAt: '2026-01-01T00:00:00.000Z' }))
    tokenwise(['checkup'], { home })
    expect(existsSync(left)).toBe(false)
  }, 30_000)

  it('says how many of a command\'s outputs still come back long when some are already short', () => {
    const home = temp(), cwd = project()
    for (const n of [2, 3, 60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
    expect(tokenwise(['checkup'], { home }).out).toMatch(/1\. \.\/build\.sh +3 of its 5 outputs still come back long, about 71 lines each; the model reads 100% of those/u)
  }, 30_000)

  it('names the command a rule learned in the background is for, before it has shortened anything', () => {
    const home = temp(), cwd = project(), work = temp()
    for (const n of [60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
    // A learner as an agent would run it: writes the rule and checks it.
    writeFileSync(join(work, 'learn.sh'), `#!/bin/sh
mkdir -p rules-work/rules
echo '{ "schemaVersion": 1, "rules": [{ "id": "build-progress", "file": "rules/build-progress.js", "transformation": "noise-removal" }] }' > rules-work/index.json
cat > rules-work/rules/build-progress.js <<'JS'
defineRule({ project(input, tw) {
  if (!input.argv || input.argv[0] !== './build.sh') return null
  ${PROGRESS_RULE}
} })
JS
./check > /dev/null || true
`)
    expect(tokenwise(['evolve', '--learner', `sh ${join(work, 'learn.sh')}`], { cwd, home }).status).toBe(0)
    expect(tokenwise(['checkup'], { home }).out).toMatch(/build-progress +learned, for \.\/build\.sh; shortened 0 outputs/u)
  }, 30_000)

  it('takes TW_HOME and TW_DISABLE, which Codex and DSH pass on to shell commands', () => {
    const home = temp(), cwd = project()
    const env = { ...process.env, SHELL: '/bin/sh', TW_HOME: home } as NodeJS.ProcessEnv
    delete env.TOKENWISE_HOME; delete env.TOKENWISE_DISABLE
    const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--conditions=source', main, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra } }).stdout
    for (const n of [60, 70, 80]) cli(['run', '-c', `./build.sh ${n}`])
    expect(cli(['checkup'])).toContain('3 shell outputs from shell')
    const workspace = /Workspace: (\S+)/u.exec(cli(['teach', './build.sh']))![1]!
    expect(workspace.startsWith(teachRoot(home))).toBe(true)
    writeRule(workspace, PROGRESS_RULE)
    expect(cli(['teach', 'keep'])).toContain('Kept.')
    expect(cli(['run', '-c', './build.sh 50'])).toMatch(/^Finished release/u)
    expect(cli(['run', '-c', './build.sh 50'], { TW_DISABLE: '1' })).toMatch(/^\[1\/50\] Compiling/u)
    // A TOKENWISE_* variable set as well wins.
    expect(cli(['checkup'], { TOKENWISE_HOME: temp() })).toContain('no shell output recorded yet')
  }, 30_000)

  it('teaches inside a sandbox that cannot write its data, and asks to keep the rule from outside it', () => {
    const home = temp(), cwd = project()
    for (const n of [60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
    chmodSync(home, 0o500)
    try {
      // Writing and checking the rule happen in a temporary directory, which sandboxes let commands write.
      const workspace = /Workspace: (\S+)/u.exec(tokenwise(['teach', './build.sh'], { home }).out)![1]!
      writeRule(workspace, PROGRESS_RULE)
      expect(tokenwise(['teach', 'check'], { home }).out).toMatch(/^ACCEPTED/u)
      expect(tokenwise(['teach', 'preview'], { home }).out).toContain('Check: ACCEPTED.')
      // Keeping it writes the data directory: one command to run outside the sandbox.
      const result = tokenwise(['teach', 'keep'], { home })
      expect(result.status).toBe(1)
      expect(result.err).toMatch(/^tokenwise: could not write .* \((EACCES|EPERM)\)\. This agent seems to run commands in a sandbox: run the same tokenwise command again with escalated permissions/u)
      expect(result.err).not.toContain('    at ')
      // A checkup only reads, so it still works.
      expect(tokenwise(['checkup'], { home }).out).toContain('3 shell outputs from shell')
    } finally { chmodSync(home, 0o700) }
  }, 30_000)

  it('reads its own output as it is, even when a learned rule matches it by content', () => {
    const home = temp(), cwd = project()
    for (const n of [60, 70, 80]) tokenwise(['run', '-c', `./build.sh ${n}`], { cwd, home })
    const workspace = /Workspace: (\S+)/u.exec(tokenwise(['teach', './build.sh'], { home }).out)![1]!
    // A rule that looks only at the output, not at the command.
    mkdirSync(join(workspace, 'rules-work', 'rules'), { recursive: true })
    writeFileSync(join(workspace, 'rules-work', 'index.json'),
      JSON.stringify({ schemaVersion: 1, rules: [{ id: 'compile-lines', file: 'rules/compile-lines.js', transformation: 'noise-removal' }] }))
    writeFileSync(join(workspace, 'rules-work', 'rules', 'compile-lines.js'), `defineRule({ project(input, tw) {
  ${PROGRESS_RULE}
} })\n`)
    expect(tokenwise(['teach', 'keep'], { home }).status).toBe(0)
    // A preview prints recorded output; a copy of the script stands in for the tokenwise command.
    const printed = tokenwise(['run', '-c', './build.sh 50'], { cwd, home }).out
    expect(printed).toMatch(/^Finished release in 4\.2s\n\[50 compile progress lines omitted\]/u)
    writeFileSync(join(cwd, 'tokenwise'), '#!/bin/sh\nexec ./build.sh 50\n')
    chmodSync(join(cwd, 'tokenwise'), 0o755)
    // Nor does it shorten what the agent looked up: a search through such lines comes back whole.
    writeFileSync(join(cwd, 'log.txt'), Array.from({ length: 40 }, (_, i) => `[${i + 1}/40] Compiling module_${i + 1}.rs`).join('\n') + '\n')
    expect(tokenwise(['run', '-c', 'grep Compiling log.txt'], { cwd, home }).out).not.toContain('compile progress lines omitted')
    expect(tokenwise(['run', '-c', './tokenwise preview ./build.sh'], { cwd, home }).out).toMatch(/^\[1\/50\] Compiling module_1\.rs\n(?:.*\n){49}Finished release in 4\.2s\n$/u)
  }, 30_000)

})
