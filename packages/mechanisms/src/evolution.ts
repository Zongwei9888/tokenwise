import { createPolicy, decideShellProjection, estimateTokens as defaultEstimate, looksUp, readsFileContent, sha256 } from '@tokenwise/core'
import type { EconomyPolicy, LearnedRuleSet, ShellResult, TokenEstimator } from '@tokenwise/core'
import type { ArtifactPort, EconomyRecord, JournalRecord } from '@tokenwise/protocol'

/**
 * Evidence-guided self-evolution of the filter policy: pi_{k+1} = Verify(Propose(pi_k, E_k)).
 *
 * - Evidence: the shell outputs TokenWise saw (originals kept in the artifact
 *   store, decisions in the journal), rebuilt exactly as the engine saw them.
 * - Propose: a coding agent (the learner) edits a copy of the learned rules in
 *   a workspace, given the evidence (`tokenwise evolve`).
 * - Verify (this module): replay every observation with the current and the
 *   proposed policy, and check the preservation requirements. A proposal is
 *   accepted iff it changes the rules, meets every requirement, no rule fails
 *   on the evidence, and either repairs a policy that violated a requirement
 *   or saves more tokens in total with no observation saving less. When some
 *   observations were held back from the learner, every command it improved
 *   that has held-back observations must save more on those too.
 */

/** Shell words outside quotes, with the separators `&&`, `||`, `;` and `|` as words of their own. */
function shellWords(command: string): string[] {
  const words: string[] = []
  let word = '', quote: string | undefined, started = false
  const flush = () => { if (started) words.push(word); word = ''; started = false }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) { if (ch === quote) quote = undefined; else word += ch; continue }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue }
    if (/\s/u.test(ch)) { flush(); continue }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') { flush(); words.push(two); i++; continue }
    if (ch === ';' || ch === '|' || ch === '\n') { flush(); words.push(ch === '\n' ? ';' : ch); continue }
    word += ch
    started = true
  }
  flush()
  return words
}

const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'unset', 'true', 'clear', 'echo',
  'sleep', 'wait', 'mkdir', 'touch', 'chmod', 'rm', 'cp', 'mv', 'ln', 'kill', 'pkill', '[', '[[', 'test', 'continue', 'break', 'return', ':'])
/** Shell syntax, not programs: a stage that opens or closes a loop or a condition names none, and these lead into one that does. */
const SYNTAX = new Set(['for', 'while', 'until', 'if', 'elif', 'case', 'select', 'function', 'done', 'fi', 'esac', '}', ')'])
const LEADERS = new Set(['do', 'then', 'else', '{', '(', '!'])
/**
 * Programs that run the command after them, with their own options first (and `timeout`'s duration): for each,
 * the options followed by a value (`nice -n 10`, `sudo -u pg`, `timeout -s KILL`, `env -u NAME`, `time -o file`).
 */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries({
  time: ['-o', '-f', '--output', '--format'], sudo: ['-u', '-g', '-p', '-C', '-h', '-U', '--user', '--group', '--prompt'], nice: ['-n', '--adjustment'],
  nohup: [], command: [], exec: ['-a'], env: ['-u', '-C', '-S', '--unset', '--chdir'], timeout: ['-s', '-k', '--signal', '--kill-after'],
}).map(([name, values]) => [name, new Set(values)]))

/** Where the program of a pipeline stage starts: past leading syntax, assignments and wrappers with their options. */
function programStart(stage: readonly string[]): number {
  let at = 0
  while (at < stage.length) {
    const word = stage[at]!
    if (LEADERS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) { at++; continue }
    const values = WRAPPERS.get(word)
    if (!values || at + 1 >= stage.length) break
    // `command -v x` looks a name up: nothing of its own to group.
    if (word === 'command' && /^-[vV]$/u.test(stage[at + 1]!)) return stage.length
    at++
    while (at < stage.length && stage[at]!.startsWith('-')) at += values.has(stage[at]!) ? 2 : 1
    if (word === 'timeout' && /^\d/u.test(stage[at] ?? '')) at++
  }
  return at
}

/**
 * The tool a command runs, for grouping observations: the program that
 * produces the output (past `cd …&&`, variable assignments and setup
 * commands, the first stage of a pipeline), with its subcommand when there
 * is one (`npm install`, `git diff`, `cargo test`, `python3 -m pytest`;
 * `pytest -v` and `python3 app.py` are just `pytest` and `python3`).
 */
export function commandHead(command: string): string {
  const words = shellWords(command)
  // Segments split on && || ; — in each, the first stage of a pipeline.
  const segments: string[][] = [[]]
  for (const word of words) {
    if (word === '&&' || word === '||' || word === ';') segments.push([])
    else segments.at(-1)!.push(word)
  }
  const stages = segments.map(segment => {
    const pipe = segment.indexOf('|')
    const first = pipe < 0 ? segment : segment.slice(0, pipe)
    const at = programStart(first)
    return SYNTAX.has(first[at] ?? '') ? [] : first.slice(at)
  }).filter(stage => stage.length > 0)
  const stage = stages.find(item => !SETUP.has(item[0]!)) ?? stages.at(-1) ?? []
  let [program = '', next, third] = stage
  if (program === 'npx' || program === 'bunx' || program === 'uvx') { program = next ?? program; next = third }
  // One tool whichever interpreter runs it: ~/venv/bin/python -m pytest is python -m pytest.
  const interpreter = program.replace(/^.*\//u, '')
  if (/^python[0-9.]*$/u.test(interpreter) && next === '-m' && third) return `${interpreter} -m ${third}`
  // A script with a subcommand is a tool of its own (`python manage.py test`); `node --test` is Node's test runner.
  if (INTERPRETERS.test(interpreter) && next && /^[\w./-]+\.(?:py|js|mjs|cjs|ts|rb|pl|php)$/u.test(next) && third && /^[a-z][a-z0-9:-]*$/u.test(third)) {
    return `${interpreter} ${next} ${third}`
  }
  if (interpreter === 'node' && next === '--test') return 'node --test'
  return next !== undefined && /^[a-z][a-z0-9-]*$/u.test(next) ? `${program} ${next}` : program
}

const INTERPRETERS = /^(?:python[0-9.]*|node|ruby|perl|php|deno|bun)$/u

/**
 * An interpreter or wrapper run on its own (`python3 script.py`, `node -e …`, `bash -c …`): its output is
 * whatever the script prints, with no format to learn. With a subcommand or module (`python3 -m pytest`) it is a tool.
 */
const GENERIC = /^(?:python[0-9.]*|node|bash|sh|zsh|fish|ruby|perl|php|deno|bun|lua|osascript|eval|exec|xargs|sudo|time|timeout|env|nohup|watch)$/u

/** Whether a command head is an interpreter or wrapper run on its own: whatever its script prints, with no format to learn. */
export function scriptRun(head: string): boolean {
  return GENERIC.test(head.replace(/^.*\//u, ''))
}

export interface EvidenceCase {
  /** Stable: the original's hash and the command. */
  readonly id: string
  readonly host: string
  readonly sessionId: string | null
  readonly time: string
  /** How many recorded observations had exactly this command and output. */
  readonly occurrences: number
  readonly result: ShellResult
  /** What the policy at the time decided. */
  readonly recorded: { readonly outcome: string; readonly reason?: string; readonly filter?: string; readonly rule?: string }
}

/**
 * Rebuild observations from the journal and the artifact store. Only shell
 * outputs whose original is still stored, complete (not cut or interrupted)
 * and laid out as recorded count; identical command and output count once.
 */
export function collectEvidence(records: Iterable<JournalRecord>, artifacts: ArtifactPort, options: { since?: Date; maxCases?: number } = {}): EvidenceCase[] {
  const since = options.since?.toISOString()
  const byId = new Map<string, { case: EvidenceCase; occurrences: number }>()
  for (const item of records) {
    if (item.type !== 'economy/decision') continue
    const record = item as EconomyRecord
    if (!record.raw?.stored || !record.layout || record.layout.truncated || record.layout.interrupted || record.exitCode === null) continue
    if (since && record.time < since) continue
    // Learned rules never touch file contents or what the agent looked up, so there is nothing to learn from them.
    if (readsFileContent(record.command) || looksUp(record.command)) continue
    // TokenWise's own output (checkups, previews, a rule being taught) is not something to learn from.
    if (/^(?:\S*\/)?(?:tokenwise|tw)(?: |$)/u.test(commandHead(record.command))) continue
    const id = `${record.raw.sha256.slice(0, 16)}-${sha256(record.command).slice(0, 8)}`
    const known = byId.get(id)
    if (known) { known.occurrences++; continue }
    const rendered = artifacts.read(record.raw.sha256)
    if (rendered === undefined) continue
    const { stdout, stderr } = record.layout
    const span = (part: { start: number; length: number }) => ({ start: part.start, text: rendered.slice(part.start, part.start + part.length) })
    if (stdout.start + stdout.length > rendered.length || (stderr && stderr.start + stderr.length > rendered.length)) continue
    const result: ShellResult = { command: record.command, exitCode: record.exitCode, rendered, stdout: span(stdout), ...stderr ? { stderr: span(stderr) } : {} }
    byId.set(id, { occurrences: 1, case: { id, host: record.host, sessionId: record.sessionId, time: record.time, occurrences: 1, result,
      recorded: { outcome: record.outcome, ...record.reason ? { reason: record.reason } : {}, ...record.filter ? { filter: record.filter } : {},
        ...record.rule ? { rule: record.rule } : {} } } })
  }
  const cases = [...byId.values()].map(item => ({ ...item.case, occurrences: item.occurrences }))
  // Newest first, so a cap keeps recent evidence.
  cases.sort((a, b) => a.time < b.time ? 1 : a.time > b.time ? -1 : 0)
  return options.maxCases === undefined ? cases : cases.slice(0, options.maxCases)
}

export interface ReplayRow {
  readonly id: string
  readonly reason: string
  readonly filter?: string
  readonly rule?: string
  readonly rawTokens: number
  /** Tokens saved on this observation (0 when it passes). */
  readonly saving: number
  /** What the model would read. */
  readonly delivered: string
}

/**
 * The most characters a host delivers inline, as its adapter configures the
 * engine (`maxProjectedChars`): a longer projection passes at runtime, so it
 * saves nothing in replay either.
 */
export const HOST_INLINE_LIMITS: Readonly<Record<string, number>> = Object.freeze({ dsh: 48_000 })

/** s_pi(e): replay one observation through the full decision (filters, stream policy, admission, the host's inline limit). */
export function replayCase(policy: EconomyPolicy, item: { id: string; result: ShellResult; host?: string },
  options: { minimumSavedTokens?: number; estimateTokens?: TokenEstimator } = {}): ReplayRow {
  const estimate = options.estimateTokens ?? defaultEstimate
  const decision = decideShellProjection(item.result, { policy, minimumSavedTokens: options.minimumSavedTokens ?? 16, estimateTokens: estimate })
  const rawTokens = estimate(item.result.rendered)
  if (decision.kind === 'pass') {
    return { id: item.id, reason: decision.reason, ...decision.filter ? { filter: decision.filter } : {}, ...decision.rule ? { rule: decision.rule } : {},
      rawTokens, saving: 0, delivered: item.result.rendered }
  }
  const limit = item.host === undefined ? undefined : HOST_INLINE_LIMITS[item.host]
  if (limit !== undefined && decision.text.length > limit) {
    return { id: item.id, reason: 'over-host-inline-limit', filter: decision.filter, ...decision.rule ? { rule: decision.rule } : {}, rawTokens,
      saving: 0, delivered: item.result.rendered }
  }
  return { id: item.id, reason: 'projected', filter: decision.filter, ...decision.rule ? { rule: decision.rule } : {}, rawTokens,
    saving: decision.rawTokens - decision.projectedTokens, delivered: decision.text }
}

/** A preservation requirement: for this output, whatever a policy delivers must contain every fragment. */
export interface PreservationRequirement {
  readonly id: string
  readonly result: ShellResult
  readonly requiredFragments: readonly string[]
}

const stdoutResult = (command: string, stdout: string, exitCode = 0): ShellResult => ({ command, exitCode, rendered: stdout, stdout: { start: 0, text: stdout } })

/**
 * The default requirements (after the paper's set, Appendix A.3): literal
 * data that looks like layout, application output that looks like test
 * progress, partial source windows, and failure evidence.
 */
export function defaultRequirements(): PreservationRequirement[] {
  const items: PreservationRequirement[] = []
  const add = (id: string, command: string, raw: string, requiredFragments: readonly string[], exitCode = 0) =>
    items.push({ id, result: stdoutResult(command, raw, exitCode), requiredFragments })

  // A source dump must not treat blank or repeated lines inside literals as disposable layout.
  for (const [id, command, raw] of [
    ['cat-python-string-blanks', 'cat module.py', 'payload = """first\n' + '\n'.repeat(128) + 'last"""\nprint(payload)\n'],
    ['sed-partial-string-repeats', "sed -n '20,90p' module.py",
      'def embedded_example():\n' + '    important literal payload, not executable source\n'.repeat(10) + '\n'.repeat(128) + '"""\nprint(payload)\n'],
    ['cat-template-string', 'cat module.js', 'const data = `first\n' + '\n'.repeat(128)
      + 'important literal payload, not executable source\n'.repeat(10) + 'last`;\nconsole.log(data);\n'],
    ['sed-hash-lines-in-open-string', "sed -n '1,100p' module.py", '# data in an already-open string\n'.repeat(5) + '\n\n"""\ndef get():\n    return 1\n'.repeat(4)],
    ['sed-significant-blank-lines', "sed -n '1,100p' module.py", 'payload = """first\n\n\n\nlast"""\n' + 'x = 1\n'.repeat(12)],
    ['sed-js-comment-in-template', "sed -n '1,100p' module.js", 'const payload = `\n' + '// literal data\n'.repeat(5) + '\n\n`;\n' + 'console.log(payload);\n'.repeat(12)],
  ] as const) add(id, command, raw, [raw])

  // Progress-looking text can be application stdout: a tail window may have cut the capture header,
  // and -s / --capture=no expose the program's own output.
  const dots = '.'.repeat(100) + '\n'
  add('pytest-captured-stdout-colored', 'pytest -rP -q tests/test_cli.py | tail -3',
    '\u001b[32m' + dots.trimEnd() + '\u001b[0m\nimportant application output\n1 passed in 0.03s\n', [dots.trimEnd(), 'important application output', '1 passed in 0.03s'])
  for (const [id, command, prefix] of [
    ['pytest-window-captured-stdout', 'pytest -rP -q tests/test_cli.py | tail -10',
      '==================== PASSES ====================\n---------------- Captured stdout call ----------------\n'],
    ['pytest-window-cut-capture-header', 'pytest -rP -q tests/test_cli.py | tail -2', ''],
    ['pytest-window-uncaptured-stdout', 'python -m pytest -s -q tests/test_cli.py 2>&1 | tail -10', ''],
    ['pytest-window-capture-no', 'pytest --capture=no -q tests/test_cli.py | head -10', ''],
  ] as const) add(id, command, prefix + dots + '1 passed in 0.03s\n', [dots, '1 passed in 0.03s'])

  // Failure evidence: the failing test, its assertion and the summary survive.
  add('pytest-failure', 'pytest -q', '..F.\n' + '='.repeat(20) + ' FAILURES ' + '='.repeat(20) + '\n____ test_retry ____\n\n    def test_retry():\n>       assert backoff(2) == 4\nE       assert 3 == 4\n\ntests/test_retry.py:7: AssertionError\n1 failed, 3 passed in 0.05s\n',
    ['test_retry', 'E       assert 3 == 4', 'tests/test_retry.py:7: AssertionError', '1 failed, 3 passed'], 1)
  add('node-test-failure', 'node --test', 'TAP version 13\n# Subtest: adds\nok 1 - adds\n# Subtest: retries\nnot ok 2 - retries\n  ---\n  error: \'expected 4, got 3\'\n  ...\n1..2\n# pass 1\n# fail 1\n',
    ['not ok 2 - retries', "error: 'expected 4, got 3'", '# fail 1'], 1)
  add('compiler-error', 'make', 'cc -c a.c\ncc -c b.c\nb.c:12:5: error: use of undeclared identifier \'retry\'\n    retry(3);\n    ^\n1 error generated.\nmake: *** [b.o] Error 1\n',
    ["b.c:12:5: error: use of undeclared identifier 'retry'", 'make: *** [b.o] Error 1'], 2)
  add('python-traceback', 'python3 app.py', 'loading config\n' + 'step ok\n'.repeat(40) + 'Traceback (most recent call last):\n  File "app.py", line 12, in <module>\n    main()\n  File "app.py", line 9, in main\n    parse(rate)\nValueError: invalid literal for int() with base 10: \'1,5\'\n',
    ['Traceback (most recent call last):', 'File "app.py", line 9, in main', "ValueError: invalid literal for int() with base 10: '1,5'"], 1)
  add('jest-failure', 'npx jest', 'PASS src/a.test.ts\n'.repeat(30) + 'FAIL src/retry.test.ts\n  ● retry › waits longer each time\n\n    expect(received).toBe(expected)\n\n    Expected: 4\n    Received: 3\n\nTests:       1 failed, 30 passed, 31 total\n',
    ['FAIL src/retry.test.ts', '● retry › waits longer each time', 'Expected: 4', 'Received: 3', 'Tests:       1 failed, 30 passed, 31 total'], 1)
  add('go-test-failure', 'go test ./...', 'ok  \texample.com/a\t0.01s\n'.repeat(30) + '--- FAIL: TestRetry (0.00s)\n    retry_test.go:12: got 3, want 4\nFAIL\nFAIL\texample.com/retry\t0.01s\n',
    ['--- FAIL: TestRetry (0.00s)', 'retry_test.go:12: got 3, want 4', 'FAIL\texample.com/retry'], 1)
  add('npm-error', 'npm install', 'npm WARN deprecated a@1.0.0\n'.repeat(20) + 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree\nnpm ERR! Found: react@18.3.1\n',
    ['npm ERR! code ERESOLVE', 'npm ERR! ERESOLVE unable to resolve dependency tree', 'npm ERR! Found: react@18.3.1'], 1)
  add('git-conflict', 'git status', 'On branch main\nYou have unmerged paths.\n\nUnmerged paths:\n\tboth modified:   src/retry.py\n',
    ['You have unmerged paths.', 'both modified:   src/retry.py'])
  return items
}

export interface RequirementResult { readonly id: string; readonly passed: boolean; readonly missing: readonly string[] }

/** P(pi): each requirement's delivered text (the projection, or the original when the policy passes) keeps every fragment. */
export function checkRequirements(policy: EconomyPolicy, requirements: readonly PreservationRequirement[], options: { minimumSavedTokens?: number } = {}): { passed: boolean; results: RequirementResult[] } {
  const results = requirements.map(item => {
    if (item.requiredFragments.length === 0 || item.requiredFragments.some(fragment => !item.result.rendered.includes(fragment))) {
      throw new Error(`requirement ${item.id}: every fragment must occur in its output`)
    }
    const delivered = replayCase(policy, item, { minimumSavedTokens: options.minimumSavedTokens ?? 1 }).delivered
    const missing = item.requiredFragments.filter(fragment => !delivered.includes(fragment))
    return { id: item.id, passed: missing.length === 0, missing }
  })
  return { passed: results.every(result => result.passed), results }
}

export interface VerificationReport {
  readonly accepted: boolean
  readonly changeKind: 'safety-repair' | 'compression-improvement'
  readonly parentHash: string | null
  readonly candidateHash: string | null
  readonly cases: number
  /** Total tokens saved on the evidence, by the parent and by the candidate (weighted by occurrences). */
  readonly parentSaving: number
  readonly candidateSaving: number
  readonly gainTokens: number
  /** Observations the candidate saves less on. */
  readonly regressions: readonly { id: string; command: string; parentSaving: number; saving: number }[]
  /** Observations the candidate saves more on. */
  readonly improved: number
  readonly requirementFailures: readonly RequirementResult[]
  /** Calls of learned rules that failed during replay, by rule. */
  readonly ruleFailures: Readonly<Record<string, number>>
  /**
   * Held-out check: the commands the candidate improved on observations the
   * learner saw, and its gain on the held-back observations of each.
   * `failed` when any such command gains nothing there; `untested` when none
   * has held-back observations.
   */
  readonly generalization?: {
    readonly status: 'confirmed' | 'untested' | 'failed'
    readonly commands: readonly string[]
    readonly heldOutCases: number
    readonly heldOutGain: number
    readonly byCommand?: readonly { readonly command: string; readonly heldOutCases: number; readonly heldOutGain: number }[]
  }
  readonly reasons: readonly string[]
}

/**
 * The acceptance rule. `parent` and `candidate` are learned rule sets
 * (undefined: none); both run in front of the same built-in filters.
 */
export function verifyRules(options: {
  parent: LearnedRuleSet | undefined
  candidate: LearnedRuleSet | undefined
  cases: readonly EvidenceCase[]
  requirements?: readonly PreservationRequirement[]
  filterOptions?: unknown
  minimumSavedTokens?: number
  /** IDs of the observations held back from the learner; with them, the others count as seen. */
  heldOut?: ReadonlySet<string>
}): VerificationReport {
  const requirements = options.requirements ?? defaultRequirements()
  const parentPolicy = createPolicy(options.filterOptions, options.parent)
  const candidatePolicy = createPolicy(options.filterOptions, options.candidate)
  const replayOptions = { minimumSavedTokens: options.minimumSavedTokens ?? 16 }
  const before = new Map(options.candidate?.failures ?? [])
  let parentSaving = 0, candidateSaving = 0, improved = 0
  const regressions: { id: string; command: string; parentSaving: number; saving: number }[] = []
  const improvedHeads = new Set<string>()
  const heldOutGainByHead = new Map<string, { cases: number; gain: number }>()
  for (const item of options.cases) {
    const parentRow = replayCase(parentPolicy, item, replayOptions)
    const row = replayCase(candidatePolicy, item, replayOptions)
    parentSaving += parentRow.saving * item.occurrences
    candidateSaving += row.saving * item.occurrences
    if (row.saving < parentRow.saving) regressions.push({ id: item.id, command: item.result.command, parentSaving: parentRow.saving, saving: row.saving })
    else if (row.saving > parentRow.saving) improved++
    if (options.heldOut) {
      const head = commandHead(item.result.command)
      if (!options.heldOut.has(item.id)) { if (row.saving > parentRow.saving) improvedHeads.add(head) }
      else {
        const entry = heldOutGainByHead.get(head) ?? { cases: 0, gain: 0 }
        entry.cases++
        entry.gain += (row.saving - parentRow.saving) * item.occurrences
        heldOutGainByHead.set(head, entry)
      }
    }
  }
  let generalization: VerificationReport['generalization']
  if (options.heldOut) {
    const commands = [...improvedHeads].sort()
    const byCommand = commands.flatMap(command => {
      const entry = heldOutGainByHead.get(command)
      return entry ? [{ command, heldOutCases: entry.cases, heldOutGain: entry.gain }] : []
    })
    const heldOutCases = byCommand.reduce((sum, item) => sum + item.heldOutCases, 0)
    const heldOutGain = byCommand.reduce((sum, item) => sum + item.heldOutGain, 0)
    // Judged per command: one that generalizes must not hide one that only fits its samples.
    generalization = { status: byCommand.length === 0 ? 'untested' : byCommand.every(item => item.heldOutGain > 0) ? 'confirmed' : 'failed',
      commands, heldOutCases, heldOutGain, byCommand }
  }
  const parentSafety = checkRequirements(parentPolicy, requirements)
  const safety = checkRequirements(candidatePolicy, requirements)
  const ruleFailures: Record<string, number> = {}
  for (const [rule, count] of options.candidate?.failures ?? []) {
    const added = count - (before.get(rule) ?? 0)
    if (added > 0) ruleFailures[rule] = added
  }
  const failed = Object.keys(ruleFailures).length > 0
  const changed = (options.candidate?.hash ?? null) !== (options.parent?.hash ?? null)
  const gain = candidateSaving - parentSaving
  const repair = !parentSafety.passed && safety.passed
  const overfit = generalization?.status === 'failed'
  const accepted = changed && safety.passed && !failed && (repair || (gain > 0 && regressions.length === 0 && !overfit))
  return {
    accepted,
    changeKind: repair ? 'safety-repair' : 'compression-improvement',
    parentHash: options.parent?.hash ?? null,
    candidateHash: options.candidate?.hash ?? null,
    cases: options.cases.length,
    parentSaving, candidateSaving, gainTokens: gain, regressions, improved,
    requirementFailures: safety.results.filter(result => !result.passed),
    ruleFailures,
    ...generalization ? { generalization } : {},
    reasons: [
      !changed && 'unchanged',
      !safety.passed && 'preservation-requirement-failed',
      failed && 'rule-error',
      !repair && gain <= 0 && 'no-incremental-token-gain',
      !repair && regressions.length > 0 && 'replay-token-regression',
      !repair && overfit && 'did-not-generalize',
    ].filter((reason): reason is string => typeof reason === 'string'),
  }
}
