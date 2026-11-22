import { describe, expect, it } from 'vitest'
import { createPolicy } from '../src/policy.ts'
import { decideShellProjection, embedProjection } from '../src/economy.ts'
import { rewriteCommand } from '../src/command-rewrite.ts'
import type { ShellResult } from '../src/economy.ts'

const policy = createPolicy()
const grep = (n: number) => Array.from({ length: n }, (_, i) => `src/a.ts:${i + 1}:const value${i} = ${i}`).join('\n') + '\n'
const shell = (command: string, stdout: string, exitCode = 0, suffix = ''): ShellResult =>
  ({ command, exitCode, rendered: stdout + suffix, stdout: { start: 0, text: stdout } })

function expectCopiedSpansMatch(rendered: string, decision: ReturnType<typeof decideShellProjection>) {
  if (decision.kind !== 'project') throw new Error(`expected a projection, got ${decision.reason}`)
  for (const span of decision.sourceMap.spans) {
    if (span.sourceStart !== undefined) {
      expect(decision.text.slice(span.outputStart, span.outputEnd)).toBe(rendered.slice(span.sourceStart, span.sourceEnd))
    }
  }
  expect(decision.sourceMap.sourceLength).toBe(rendered.length)
  expect(decision.sourceMap.outputLength).toBe(decision.text.length)
}

describe('decideShellProjection', () => {
  it('projects a large grep result and keeps a host suffix verbatim', () => {
    const result = shell('grep -rn value src', grep(200), 0, '\n[exit code: 0]')
    const decision = decideShellProjection(result, { policy })
    expect(decision).toMatchObject({ kind: 'project', filter: 'grep', stream: 'stdout', policyHash: policy.policyHash })
    if (decision.kind !== 'project') return
    expect(decision.text.endsWith('\n[exit code: 0]')).toBe(true)
    expect(decision.projectedBytes).toBeLessThan(decision.rawBytes)
    expect(decision.projectedTokens).toBeLessThan(decision.rawTokens)
    expectCopiedSpansMatch(result.rendered, decision)
  })
  it('passes unknown commands with a diagnostic reason', () => {
    expect(decideShellProjection(shell('my-tool', 'x\n'.repeat(400)), { policy }))
      .toMatchObject({ kind: 'pass', reason: 'no-filter-match', matchDetail: 'command-not-covered' })
    expect(decideShellProjection(shell('grep -rn $X src', grep(200)), { policy }))
      .toMatchObject({ kind: 'pass', reason: 'no-filter-match', matchDetail: 'unsupported-shell-syntax' })
  })
  it('never filters truncated or interrupted output', () => {
    expect(decideShellProjection({ ...shell('grep -rn value src', grep(200)), truncated: true }, { policy }))
      .toMatchObject({ kind: 'pass', reason: 'already-truncated' })
    expect(decideShellProjection({ ...shell('grep -rn value src', grep(200)), interrupted: true }, { policy }))
      .toMatchObject({ kind: 'pass', reason: 'interrupted-result' })
  })
  it('rejects a stream that is not verbatim inside the rendered result', () => {
    const result = { ...shell('grep -rn value src', grep(200)), stdout: { start: 3, text: grep(200) } }
    expect(decideShellProjection(result, { policy })).toMatchObject({ kind: 'pass', reason: 'unsupported-result-shape' })
  })
  it('requires a real token saving, not only fewer bytes', () => {
    const decision = decideShellProjection(shell('grep -rn value src', grep(200)), { policy, minimumSavedTokens: 1_000_000 })
    expect(decision).toMatchObject({ kind: 'pass', reason: 'non-growth-rejected', filter: 'grep' })
  })
  it('treats a minimum below one as one', () => {
    const tiny = 'src/a.ts:1:x\n'
    expect(decideShellProjection(shell('grep -rn x src', tiny), { policy, minimumSavedTokens: -5 }).kind).toBe('pass')
  })
  it('filters Cargo build reports on stderr but not arbitrary stderr transformations', () => {
    const stderr = Array.from({ length: 80 }, (_, i) => `   Compiling dep${i} v1.0.0\n`).join('')
      + 'error[E0308]: mismatched types\n --> src/lib.rs:3:5\nerror: could not compile fixture due to previous error\n'
    const rendered = `[stderr]\n${stderr}`
    const decision = decideShellProjection({ command: 'cargo build', exitCode: 101, rendered,
      stdout: { start: 0, text: '' }, stderr: { start: 9, text: stderr } }, { policy })
    expect(decision).toMatchObject({ kind: 'project', filter: 'cargo-build', stream: 'stderr' })
    if (decision.kind === 'project') {
      expect(decision.text.startsWith('[stderr]\n')).toBe(true)
      expect(decision.text).toContain('error[E0308]: mismatched types')
      expectCopiedSpansMatch(rendered, decision)
    }
    const grepOnStderr = decideShellProjection({ command: 'grep -rn value src', exitCode: 0, rendered: grep(200),
      stdout: { start: 0, text: '' }, stderr: { start: 0, text: grep(200) } }, { policy })
    expect(grepOnStderr).toMatchObject({ kind: 'pass', reason: 'stream-policy-rejected', matchDetail: 'stderr-transformation-not-approved' })
  })
  it('filters the stderr report of a tool that prints it there (go build, compilers, BuildKit, Jest)', () => {
    const stderr = Array.from({ length: 60 }, (_, i) => `go: downloading github.com/acme/mod${i} v1.${i}.0\n`).join('')
      + '# example.com/app\n./main.go:7:2: undefined: missing\n'
    const rendered = `[stderr]\n${stderr}`
    const decision = decideShellProjection({ command: 'go build ./...', exitCode: 1, rendered,
      stdout: { start: 0, text: '' }, stderr: { start: 9, text: stderr } }, { policy })
    expect(decision).toMatchObject({ kind: 'project', filter: 'go-build', stream: 'stderr' })
    if (decision.kind === 'project') {
      expect(decision.text).toContain('[60 Go module download lines omitted]\n# example.com/app\n./main.go:7:2: undefined: missing\n')
      expectCopiedSpansMatch(rendered, decision)
    }
  })
  it('pins decisions to the policy hash and honours its filter options', () => {
    const narrow = createPolicy({ grep: { maxPerFile: 2 } })
    expect(narrow.policyHash).not.toBe(policy.policyHash)
    expect(createPolicy({ grep: { maxPerFile: 2 } }).policyHash).toBe(narrow.policyHash)
    const a = decideShellProjection(shell('grep -rn value src', grep(200)), { policy })
    const b = decideShellProjection(shell('grep -rn value src', grep(200)), { policy: narrow })
    expect(a.kind === 'project' && b.kind === 'project' && b.text.length < a.text.length).toBe(true)
    expect(() => createPolicy({ grep: { maxPerFile: 0 } })).toThrow()
  })
})

describe('embedProjection', () => {
  it('keeps the prefix and suffix and separates a projection without a final newline', () => {
    const rendered = 'HEAD\nbody body body\nTAIL'
    const out = embedProjection(rendered, { start: 5, text: 'body body body\n' }, {
      text: 'body', sourceMap: { version: 1, unit: 'utf16', sourceLength: 15, outputLength: 4, spans: [{ outputStart: 0, outputEnd: 4, sourceStart: 0, sourceEnd: 4 }] },
    })
    expect(out.text).toBe('HEAD\nbody\nTAIL')
    expect(out.sourceMap.spans.filter(span => span.sourceStart !== undefined)
      .every(span => out.text.slice(span.outputStart, span.outputEnd) === rendered.slice(span.sourceStart, span.sourceEnd))).toBe(true)
  })
})

describe('rewriteCommand', () => {
  it('adds record-format flags without touching patterns or paths', () => {
    expect(rewriteCommand('rg foo src')).toEqual({ command: 'rg -n -H foo src', rule: 'search-record-format' })
    expect(rewriteCommand('grep -n foo src')).toEqual({ command: 'grep -H -n foo src', rule: 'search-record-format' })
    expect(rewriteCommand('git diff HEAD~1')).toEqual({ command: 'git diff --no-color HEAD~1', rule: 'git-diff-no-color' })
    expect(rewriteCommand('python3 -m pytest tests')).toEqual({ command: 'python3 -m pytest --color=no tests', rule: 'pytest-no-color' })
  })
  it('leaves anything outside the closed grammar alone', () => {
    for (const command of ['rg -c foo', 'rg --json foo', 'grep -rn foo src | head', 'git diff --color=always', 'pytest --color=yes', 'ls -la']) {
      expect(rewriteCommand(command)).toBeUndefined()
    }
  })
})

describe('mayProject', async () => {
  const { mayProject } = await import('../src/economy.ts')
  it('selects commands some filter recognizes', () => {
    for (const command of ['pytest -x', 'cd ./app && cargo test', 'git status', 'grep -rn x src | head', 'find . -name "*.ts"', 'npm test', 'git show HEAD', 'uv run pytest -q']) {
      expect(mayProject(command), command).toBe(true)
    }
    for (const command of ['echo hi', 'cat README.md', 'python script.py', 'vim file', 'sed -n 1,5p a.txt']) {
      expect(mayProject(command), command).toBe(false)
    }
  })
})
