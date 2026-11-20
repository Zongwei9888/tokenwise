import { describe, expect, it } from 'vitest'
import { gitDiffFilter, gitShowFilter, grepFilter, pytestFilter } from '../src/filters/index.ts'

describe('Token Economy static filter parity', () => {
  it('keeps pytest failure identity and relevant diagnostics', () => {
    const stdout = `============================= test session starts ==============================
collected 3 items

tests/test_foo.py ..F [100%]

=================================== FAILURES ===================================
___________________________________ test_bad ___________________________________
>       assert 1 == 2
E       assert 1 == 2
tests/test_foo.py:10: AssertionError
=========================== short test summary info ============================
FAILED tests/test_foo.py::test_bad - assert 1 == 2
========================= 1 failed, 2 passed in 0.05s ==========================
`
    const projected = pytestFilter.project({ command: 'cd /repo && python -m pytest -q', stdout, exitCode: 1 })
    expect(pytestFilter.project({ command: 'cd /repo && python -m pytest -q 2>&1', stdout, exitCode: 1 })).toBe(projected)
    // A program named by its path reads as the tool it runs (a virtualenv, Homebrew).
    for (const command of ['.venv/bin/python -m pytest -q', '/opt/homebrew/bin/python3 -m pytest -q', 'cd /repo && .venv/bin/pytest -q 2>&1']) {
      expect(pytestFilter.project({ command, stdout, exitCode: 1 })).toBe(projected)
    }
    // So does a program a runner starts (as RTK and snip do), and one behind `time` or variable assignments.
    for (const command of ['uv run pytest -q', 'poetry run pytest -q', 'pipenv run pytest -q', 'pdm run pytest -q', 'time pytest -q', 'CI=1 pytest -q',
      'CI=1 uv run python -m pytest -q', 'cd /repo && uv run .venv/bin/pytest -q 2>&1']) {
      expect(pytestFilter.project({ command, stdout, exitCode: 1 }), command).toBe(projected)
    }
    // A runner option means another program shape: left alone.
    expect(pytestFilter.project({ command: 'uv run --with pytest-xdist pytest -q', stdout, exitCode: 1 })).toBeUndefined()
    expect(projected).toContain('test_bad')
    expect(projected).toContain('assert 1 == 2')
    expect(projected?.length).toBeLessThan(stdout.length)
  })

  it('caps grep matches per file without dropping file identity', () => {
    const stdout = [
      ...Array.from({ length: 28 }, (_, index) => `foo.py:${index + 1}: match`),
      ...Array.from({ length: 3 }, (_, index) => `bar.py:${index + 1}: result`),
    ].join('\n')
    const projected = grepFilter.project({ command: 'cd /repo && rg TODO src/', stdout, exitCode: 0 })
    expect(projected?.match(/^foo\.py:/gm)).toHaveLength(25)
    expect(projected).toContain('3 more matches in foo.py')
    expect(projected).toContain('bar.py')
  })

  it('caps a large diff while retaining file, hunk, and change counts', () => {
    const additions = Array.from({ length: 200 }, (_, index) => `+line${index}`).join('\n')
    const stdout = `diff --git a/foo.py b/foo.py
index abc..def 100644
--- a/foo.py
+++ b/foo.py
@@ -0,0 +1,200 @@ def foo():
${additions}
`
    const projected = gitDiffFilter.project({ command: 'git diff HEAD~1', stdout, exitCode: 0 })
    expect(projected).toContain('foo.py')
    expect(projected).toContain('def foo')
    expect(projected).toContain('lines truncated')
    expect(projected).toContain('+200 -0')
    expect(projected).toContain('+line199')
    // Limited to paths, the agent chose the files: the hunk stays whole. That is how it reads one a broader diff previewed.
    for (const command of ['git diff -- foo.py', 'git diff HEAD~1 -- foo.py', 'git diff --cached -- foo.py']) {
      expect(gitDiffFilter.project({ command, stdout, exitCode: 0 }), command).toBeUndefined()
    }
    expect(gitDiffFilter.project({ command: 'git diff HEAD~1 --', stdout, exitCode: 0 })).toContain('lines truncated')
  })

  it('previews oversized hunks of git show and git log -p, keeping every commit header and message', () => {
    const hunk = (file: string) => [`diff --git a/${file} b/${file}`, 'index 1111111..2222222 100644', `--- a/${file}`, `+++ b/${file}`, '@@ -1,150 +1,150 @@',
      ...Array.from({ length: 150 }, (_, i) => i % 2 ? `-old line ${i}` : `+new line ${i}`), ...Array.from({ length: 75 }, (_, i) => ` context ${i}`)].join('\n')
    const fix = 'Fix rounding in to_cents\n\nThe export expects half-up rounding.'
    const commit = (sha: string, message: string, file: string) => [`commit ${sha}`, 'Author: Dana Lee <dana@example.com>', 'Date:   Tue Jul 1 09:15:00 2026 +0000', '',
      ...message.split('\n').map(line => line ? `    ${line}` : ''), '', hunk(file)].join('\n')
    const show = commit('5cac6a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b', fix, 'ledger/money.py') + '\n'
    const projected = gitShowFilter.project({ command: 'git show 5cac6a1', stdout: show, exitCode: 0 })!
    expect(projected.length).toBeLessThan(show.length)
    for (const kept of ['commit 5cac6a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b', 'Author: Dana Lee', '    Fix rounding in to_cents', '    The export expects half-up rounding.',
      'diff --git a/ledger/money.py b/ledger/money.py', '@@ -1,150 +1,150 @@', '  +75 -75', 'lines truncated']) expect(projected, kept).toContain(kept)
    // git log -p: several commits, each header kept; a decorated header too.
    const log = [commit('aaaaaaa1111111111111111111111111111111111 (HEAD -> main)', 'Second change', 'b.py'), commit('bbbbbbb2222222222222222222222222222222222', 'First change', 'a.py')].join('\n') + '\n'
    const logged = gitShowFilter.project({ command: 'git log -p -2', stdout: log, exitCode: 0 })!
    for (const kept of ['commit aaaaaaa1111111111111111111111111111111111 (HEAD -> main)', '    Second change', 'commit bbbbbbb2222222222222222222222222222222222', '    First change']) expect(logged).toContain(kept)
    // Other layouts, merge diffs, file contents and plain git log pass through.
    for (const command of ['git show --stat 5cac6a1', 'git show --format=%H 5cac6a1', 'git log -2', 'git log --oneline -p']) {
      expect(gitShowFilter.project({ command, stdout: show, exitCode: 0 }), command).toBeUndefined()
    }
    expect(gitShowFilter.project({ command: 'git show HEAD:ledger/money.py', stdout: 'def to_cents(x):\n    return x\n', exitCode: 0 })).toBeUndefined()
    // git show limited to paths stays whole; a file's patch history (git log -p -- path) is still previewed.
    expect(gitShowFilter.project({ command: 'git show 5cac6a1 -- ledger/money.py', stdout: show, exitCode: 0 })).toBeUndefined()
    expect(gitShowFilter.project({ command: 'git log -p -2 -- b.py', stdout: log, exitCode: 0 })).toContain('lines truncated')
    expect(gitShowFilter.project({ command: 'git show 5cac6a1', stdout: show.replace('diff --git a/ledger/money.py b/ledger/money.py', 'diff --cc ledger/money.py'), exitCode: 0 })).toBeUndefined()
  })

  it('reads a pytest run behind | tee, and folds passing rows in a | tail or | head slice', () => {
    const passed = Array.from({ length: 40 }, (_, i) => `tests/test_money.py::test_case[${i}] PASSED${' '.repeat(20)}[ ${String(i + 1).padStart(2)}%]`)
    const failure = ['=================================== FAILURES ===================================', '_____ test_rate _____', '>       assert rate_for(50) == Decimal("0.05")',
      "E       AssertionError: assert Decimal('0') == Decimal('0.05')", 'tests/test_discount.py:9: AssertionError',
      '=========================== short test summary info ============================', 'FAILED tests/test_discount.py::test_rate - AssertionError', '========================= 1 failed, 40 passed in 0.12s =========================']
    const full = ['============================= test session starts ==============================', 'collected 41 items', '', ...passed, 'tests/test_discount.py::test_rate FAILED [100%]', '', ...failure].join('\n') + '\n'
    // | tee: the exit status is tee's 0, the summary says 1 failed.
    const teed = pytestFilter.project({ command: 'python3 -m pytest -v 2>&1 | tee /tmp/run.txt', stdout: full, exitCode: 0 })!
    expect(teed).not.toContain('test_case[7] PASSED')
    for (const kept of ["E       AssertionError: assert Decimal('0') == Decimal('0.05')", 'FAILED tests/test_discount.py::test_rate', '1 failed, 40 passed in 0.12s']) expect(teed).toContain(kept)
    // Without tee, a contradicting exit status still makes the filter stand aside.
    expect(pytestFilter.project({ command: 'python3 -m pytest -v', stdout: full, exitCode: 0 })).toBeUndefined()
    // A tail slice: the header is gone; passing rows go, diagnostics stay verbatim.
    const tail = [...passed.slice(10), 'tests/test_discount.py::test_rate FAILED [100%]', '', ...failure].join('\n') + '\n'
    for (const command of ['python3 -m pytest -v 2>&1 | tail -n 400', 'pytest -v | tail -60', 'uv run pytest -v 2>&1 | head -200']) {
      const slice = pytestFilter.project({ command, stdout: tail, exitCode: 0 })!
      expect(slice, command).toContain('[30 passing test rows omitted]')
      expect(slice).toContain('tests/test_discount.py::test_rate FAILED [100%]')
      expect(slice).toContain(failure.join('\n'))
    }
    // Output whose last line has no newline (Claude Code strips it): the note is still a line of its own.
    expect(pytestFilter.project({ command: 'pytest -v | tail -60', stdout: tail.trimEnd(), exitCode: 0 })).toMatch(/0\.12s =+\n\[30 passing test rows omitted\]\n$/u)
    // A slice with fewer than five passing rows, or of output pytest does not own (-s), is left alone.
    expect(pytestFilter.project({ command: 'pytest -v | tail -8', stdout: [...passed.slice(0, 3), ...failure].join('\n') + '\n', exitCode: 0 })).toBeUndefined()
    expect(pytestFilter.project({ command: 'pytest -v -s | tail -60', stdout: tail, exitCode: 0 })).toBeUndefined()
    // Rows that look like passes after a section rule (a PASSES section, captured output) are kept.
    const passes = [...failure.slice(0, 1), ...passed.slice(0, 6)].join('\n') + '\n'
    expect(pytestFilter.project({ command: 'pytest -v -rP | tail -20', stdout: passes, exitCode: 0 })).toBeUndefined()
  })
})
