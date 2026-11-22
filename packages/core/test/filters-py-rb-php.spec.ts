import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mayProject } from '../src/economy.ts'
import { projectStaticFilter } from '../src/filters/index.ts'
import { bundleInstallFilter, composerInstallFilter, poetryInstallFilter, uvSyncFilter } from '../src/filters/install-lists.ts'
import { minitestFilter } from '../src/filters/minitest.ts'
import { mypyFilter } from '../src/filters/mypy.ts'
import { phpunitFilter } from '../src/filters/phpunit.ts'
import { preCommitFilter } from '../src/filters/pre-commit.ts'
import { pyrightFilter } from '../src/filters/pyright.ts'
import { rubocopFilter } from '../src/filters/rubocop.ts'
import { ruffTextFilter } from '../src/filters/ruff-text.ts'
import { tyFilter } from '../src/filters/ty.ts'
import type { MappedProjection } from '../src/projection-map.ts'
import type { EconomyFilter } from '../src/types.ts'

/**
 * Real outputs captured on 2026-11-22 in throwaway projects under $TMPDIR, with
 * no network: mypy 2.4.1, ruff 0.17.3, pre-commit 4.7.0 (local `system` and
 * `pygrep` hooks), uv 0.6.7 (offline, from its cache), Bundler 1.17.2
 * (`--local`), rake 12.3.3 with Minitest 5.11.3. User paths are replaced by
 * /Users/demo. See fixtures/py-rb-php/.
 */
const fixture = (name: string) => readFileSync(new URL(`fixtures/py-rb-php/${name}`, import.meta.url), 'utf8')

/** Every line of `raw` that `removed` does not match appears in `text`, in order. */
function keepsAllBut(raw: string, text: string, removed: RegExp) {
  let at = 0
  for (const line of raw.split('\n').filter(line => line !== '' && !removed.test(line))) {
    const found = text.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(0)
    at = found + line.length
  }
}

/** Every copied span is exact. */
function copiedExactly(stdout: string, result: MappedProjection) {
  for (const span of result.sourceMap.spans) {
    if (span.sourceStart !== undefined) expect(result.text.slice(span.outputStart, span.outputEnd)).toBe(stdout.slice(span.sourceStart, span.sourceEnd))
  }
}

/**
 * Undo file grouping: rows under a `[<words> <path>]` header get their path
 * back, and a row listing several locations becomes one row per location.
 * With `snippets`, the two lines after a row whose second is a `^` highlight
 * belong to it (RuboCop).
 */
function ungroup(text: string, words: string, snippets = false): string {
  const lines = text.split('\n')
  const out: string[] = []
  const header = new RegExp(`^\\[${words} (.+)\\]$`, 'u')
  const row = /^ {2}(\d+(?::\d+)*(?:, \d+(?::\d+)*)*)(: .*)$/u
  for (let i = 0; i < lines.length; i++) {
    const path = header.exec(lines[i]!)?.[1]
    if (path === undefined) { out.push(lines[i]!); continue }
    for (let match = row.exec(lines[i + 1] ?? ''); match; match = row.exec(lines[i + 1] ?? '')) {
      i++
      for (const location of match[1]!.split(', ')) out.push(`${path}:${location}${match[2]}`)
      if (snippets && /^ *\^+$/u.test(lines[i + 2] ?? '')) out.push(lines[++i]!, lines[++i]!)
    }
  }
  return out.join('\n')
}

const project = (filter: EconomyFilter, command: string, stdout: string, exitCode = 0) => filter.project({ command, stdout, exitCode })

describe('mypy', () => {
  const raw = fixture('mypy.txt')

  it('lists each file\'s diagnostics under its name and merges consecutive identical notes, losing nothing', () => {
    const result = mypyFilter.projectMapped({ command: 'mypy app', stdout: raw, exitCode: 1 })!
    copiedExactly(raw, result)
    expect(result.text).toContain('[diagnostics in app/models.py]\n  2: error: Library stubs not installed for "requests"  [import-untyped]\n')
    expect(result.text).toContain('  31: note:     def conv(x: int) -> int\n')
    // Five annotation-unchecked notes in a row become one row with their five line numbers.
    expect(result.text).toContain('[diagnostics in app/legacy.py]\n  2, 7, 12, 17, 18: note: By default the bodies of untyped functions are not checked')
    expect(result.text).toContain('  23: error: Incompatible return value type (got "str", expected "int")  [return-value]\n')
    expect(result.text).toContain('Found 14 errors in 3 files (checked 4 source files)')
    expect(result.text).not.toMatch(/^app\/models\.py:/mu)
    // Lossless: putting the paths back gives the original output.
    expect(ungroup(result.text, 'diagnostics in')).toBe(raw)
    expect(result.text.length).toBeLessThan(raw.length * 0.8)
    expect(projectStaticFilter({ command: 'uv run mypy app', stdout: raw, exitCode: 1 })?.filter).toBe('mypy')
    expect(project(mypyFilter, 'python3 -m mypy app', raw, 1)).toBe(result.text)
  })

  it('keeps notes with different text apart, and short runs of a file as they are', () => {
    const out = [
      'src/api/views.py:10: error: Argument 1 to "f" has incompatible type "list[int]"; expected "list[float]"  [arg-type]',
      'src/api/views.py:10: note: "list" is invariant -- see https://mypy.readthedocs.io/en/stable/common_issues.html#variance',
      'src/api/views.py:10: note: Consider using "Sequence" instead, which is covariant',
      'src/api/urls.py:3: error: Module "x" has no attribute "y"  [attr-defined]',
      'src/api/urls.py:4: error: Module "x" has no attribute "z"  [attr-defined]',
      'Found 3 errors in 2 files (checked 9 source files)',
      '',
    ].join('\n')
    const projected = project(mypyFilter, 'mypy src', out, 1)!
    expect(projected).toContain('[diagnostics in src/api/views.py]\n  10: error: Argument 1')
    expect(projected).toContain('  10: note: "list" is invariant')
    expect(projected).toContain('  10: note: Consider using "Sequence"')
    // Two rows of urls.py: cheaper as they are.
    expect(projected).toContain('\nsrc/api/urls.py:3: error: Module "x" has no attribute "y"  [attr-defined]\n')
    expect(ungroup(projected, 'diagnostics in')).toBe(out)
  })

  it('leaves other layouts, commands, crashes and colored output alone', () => {
    expect(project(mypyFilter, 'mypy app', raw.replace(/^Found .*$/mu, ''), 1)).toBeUndefined()
    expect(project(mypyFilter, 'mypy app', raw, 2)).toBeUndefined()
    expect(project(mypyFilter, 'pyright app', raw, 1)).toBeUndefined()
    expect(project(mypyFilter, 'mypy app', `\u001b[1m${raw}`, 1)).toBeUndefined()
    expect(project(mypyFilter, 'mypy app', 'Success: no issues found in 1 source file\n', 0)).toBeUndefined()
  })
})

describe('pyright', () => {
  // Adapted from RTK's basedpyright filter tests (Apache-2.0, see third-party/rtk).
  const rtk = [
    '/home/user/app/main.py',
    '  /home/user/app/main.py:10:5 - error: "foo" is not defined (reportUndefinedVariable)',
    '  /home/user/app/main.py:25:1 - error: Type "str" is not assignable to type "int" (reportAssignmentType)',
    '',
    '/home/user/app/utils.py',
    '  /home/user/app/utils.py:8:9 - warning: Variable "x" is not accessed (reportUnusedVariable)',
    '',
    '3 errors, 1 warning, 0 informations',
    '',
  ].join('\n')
  /** Synthetic, in pyright 1.1's CLI layout: continuation lines are indented four spaces; the summary ends in a space. */
  const out = [
    '/home/demo/shop/src/shop/orders/models.py',
    '  /home/demo/shop/src/shop/orders/models.py:2:8 - warning: Import "requests" could not be resolved from source (reportMissingModuleSource)',
    '  /home/demo/shop/src/shop/orders/models.py:15:16 - error: Type "str" is not assignable to return type "int"',
    '    "str" is not assignable to "int" (reportReturnType)',
    '  /home/demo/shop/src/shop/orders/models.py:31:5 - error: No overloads for "conv" match the provided arguments',
    '    Argument types: (Literal[\'s\']) (reportCallIssue)',
    '  /home/demo/shop/src/shop/orders/models.py:33:7 - error: Cannot access attribute "missing" for class "User"',
    '    Attribute "missing" is unknown (reportAttributeAccessIssue)',
    '/home/demo/shop/src/shop/orders/service.py',
    '  /home/demo/shop/src/shop/orders/service.py:12:14 - error: "age" is not a known attribute of "None" (reportOptionalMemberAccess)',
    '4 errors, 1 warning, 0 informations ',
    '',
  ].join('\n')

  it('drops the path repeated on each row under its file header, keeping every diagnostic', () => {
    const result = pyrightFilter.projectMapped({ command: 'pyright', stdout: out, exitCode: 1 })!
    copiedExactly(out, result)
    expect(result.text).toContain('/home/demo/shop/src/shop/orders/models.py\n  2:8 - warning: Import "requests" could not be resolved from source (reportMissingModuleSource)\n')
    expect(result.text).toContain('  15:16 - error: Type "str" is not assignable to return type "int"\n    "str" is not assignable to "int" (reportReturnType)\n')
    expect(result.text).toContain('/home/demo/shop/src/shop/orders/service.py\n  12:14 - error:')
    expect(result.text).toContain('4 errors, 1 warning, 0 informations \n[file path omitted from 5 diagnostic rows: each is in the file on the header line above it]\n')
    // Putting each header's path back gives the original.
    let path = ''
    const restored = result.text.split('\n').filter(line => !line.startsWith('[file path omitted')).map(line => {
      if (/^\S.*\.py$/u.test(line)) path = line
      return /^ {2}\d+:\d+ - /u.test(line) ? `  ${path}:${line.slice(2)}` : line
    }).join('\n')
    expect(restored).toBe(out)
    expect(result.text.length).toBeLessThan(out.length * 0.9)
    for (const command of ['basedpyright', 'npx pyright src', 'uv run basedpyright']) expect(projectStaticFilter({ command, stdout: out, exitCode: 1 })?.filter, command).toBe('pyright')
  })

  it('needs three rows to pay for its note, and leaves other commands and layouts alone', () => {
    // RTK's sample has three rows: enough.
    expect(project(pyrightFilter, 'basedpyright', rtk, 1)).toContain('/home/user/app/main.py\n  10:5 - error: "foo" is not defined (reportUndefinedVariable)\n')
    expect(project(pyrightFilter, 'basedpyright', rtk.replace(/^ {2}\/home\/user\/app\/utils\.py:8:9.*\n/mu, ''), 1)).toBeUndefined()
    expect(project(pyrightFilter, 'mypy .', out, 1)).toBeUndefined()
    expect(project(pyrightFilter, 'pyright --outputjson', '{"version": "1.1.400"}\n', 1)).toBeUndefined()
    expect(project(pyrightFilter, 'pyright', out.replace(/^4 errors.*$/mu, ''), 1)).toBeUndefined()
    expect(project(pyrightFilter, 'pyright', `\u001b[31m${out}`, 1)).toBeUndefined()
    // A row whose path is not its header's stays whole.
    const moved = out.replace('  /home/demo/shop/src/shop/orders/service.py:12:14', '  /home/demo/shop/src/shop/other.py:12:14')
    expect(project(pyrightFilter, 'pyright', moved, 1)).toContain('  /home/demo/shop/src/shop/other.py:12:14 - error:')
  })
})

describe('ty', () => {
  /** Synthetic, in ty's full output layout (0.0.x): every diagnostic ends with the line naming why its rule is on. */
  const diagnostic = (rule: string, message: string, path: string, line: number, code: string, extra: string[] = []) => [
    `error[${rule}]: ${message}`,
    ` --> ${path}:${line}:5`,
    '  |',
    `${line} |     ${code}`,
    '  |     ^^^',
    '  |',
    ...extra,
    `info: rule \`${rule}\` is enabled by default`,
    '',
  ]
  const out = [
    ...diagnostic('unresolved-reference', 'Name `foo` used when not defined', 'app/main.py', 4, 'foo()'),
    ...diagnostic('unresolved-reference', 'Name `bar` used when not defined', 'app/main.py', 7, 'bar()'),
    ...diagnostic('unresolved-import', 'Cannot resolve imported module `requests`', 'app/net.py', 1, 'import requests',
      ['info: make sure your Python environment is properly configured: https://docs.astral.sh/ty/modules/#python-environment']),
    ...diagnostic('unresolved-reference', 'Name `baz` used when not defined', 'app/main.py', 9, 'baz()'),
    ...diagnostic('unresolved-import', 'Cannot resolve imported module `yaml`', 'app/net.py', 2, 'import yaml',
      ['info: make sure your Python environment is properly configured: https://docs.astral.sh/ty/modules/#python-environment']),
    ...diagnostic('unresolved-reference', 'Name `qux` used when not defined', 'app/util.py', 3, 'qux()'),
    'Found 6 diagnostics',
    '',
  ].join('\n')
  const ORIGIN = /^info: rule `/u

  it('keeps the first rule-origin line of each rule and counts the repeats', () => {
    const result = tyFilter.projectMapped({ command: 'ty check', stdout: out, exitCode: 1 })!
    copiedExactly(out, result)
    expect(result.text.match(/^info: rule `unresolved-reference` is enabled by default$/gmu)).toHaveLength(1)
    expect(result.text.match(/^info: rule `unresolved-import` is enabled by default$/gmu)).toHaveLength(1)
    expect(result.text).toContain('Found 6 diagnostics\n[4 repeated "info: rule `…`" lines omitted; the first one for each rule is kept]\n')
    // The environment hint is the diagnostic's own: kept every time.
    expect(result.text.match(/make sure your Python environment/gu)).toHaveLength(2)
    keepsAllBut(out, result.text, ORIGIN)
    expect(projectStaticFilter({ command: 'uv run ty check src', stdout: out, exitCode: 1 })?.filter).toBe('ty')
  })

  // Adapted from RTK's ty filter tests (Apache-2.0, see third-party/rtk).
  it('leaves output without repeated origin lines, other commands and colored output alone', () => {
    const rtk = 'ty 0.1.0\nChecking 15 files\n\nerror[unresolved-reference]: Name `foo` used when not defined\n  --> app/main.py:10:5\n   |\n10 |     foo()\n   |     ^^^\n   |\n\nwarning[unused-variable]: Variable `x` is not used\n  --> app/utils.py:8:9\n   |\n 8 |     x = 42\n   |     ^\n   |\n\nFound 1 error, 1 warning\n'
    expect(project(tyFilter, 'ty check', rtk, 1)).toBeUndefined()
    expect(project(tyFilter, 'ty check', 'All checks passed!\n', 0)).toBeUndefined()
    expect(project(tyFilter, 'ty server', out, 1)).toBeUndefined()
    expect(project(tyFilter, 'ty check', out.replace('Found 6 diagnostics', ''), 1)).toBeUndefined()
    expect(project(tyFilter, 'ty check', `\u001b[1m${out}`, 1)).toBeUndefined()
  })
})

describe('ruff-text', () => {
  const full = fixture('ruff-full.txt')
  const concise = fixture('ruff-concise.txt')

  it('lists concise rows of one file under its name', () => {
    const result = ruffTextFilter.projectMapped({ command: 'ruff check --output-format concise app', stdout: concise, exitCode: 1 })!
    copiedExactly(concise, result)
    expect(result.text).toContain('[diagnostics in app/models.py]\n  1:1: I001 [*] Import block is un-sorted or un-formatted\n')
    expect(result.text).toContain('[diagnostics in app/service.py]\n  1:1: I001')
    expect(ungroup(result.text, 'diagnostics in')).toBe(concise)
    expect(result.text.length).toBeLessThan(concise.length * 0.95)
    expect(projectStaticFilter({ command: 'uv run ruff check --output-format=concise .', stdout: concise, exitCode: 1 })?.filter).toBe('ruff-text')
  })

  it('passes the full format through: each row is followed by its code frame and fix', () => {
    expect(project(ruffTextFilter, 'ruff check app', full, 1)).toBeUndefined()
    expect(project(ruffTextFilter, 'ruff check --output-format full app', full, 1)).toBeUndefined()
  })

  it('leaves other formats, subcommands, errors and colored output alone', () => {
    const command = 'ruff check --output-format concise app'
    expect(project(ruffTextFilter, 'ruff check --output-format json app', concise, 1)).toBeUndefined()
    expect(project(ruffTextFilter, 'ruff check --output-format concise --statistics app', concise, 1)).toBeUndefined()
    expect(project(ruffTextFilter, 'ruff format --output-format concise app', concise, 1)).toBeUndefined()
    expect(project(ruffTextFilter, command, concise, 2)).toBeUndefined()
    expect(project(ruffTextFilter, command, concise.replace(/^Found .*$/mu, ''), 1)).toBeUndefined()
    expect(project(ruffTextFilter, command, `\u001b[1m${concise}`, 1)).toBeUndefined()
    expect(project(ruffTextFilter, command, 'All checks passed!\n', 0)).toBeUndefined()
  })
})

describe('pre-commit', () => {
  const raw = fixture('pre-commit-run.txt')
  const HOOK_OK = /\.+(?:\([^)]*\))?(?:Passed|Skipped)$/u

  it('folds runs of Passed and Skipped hook rows, keeping every failed hook and its output', () => {
    const result = preCommitFilter.projectMapped({ command: 'pre-commit run --all-files', stdout: raw, exitCode: 1 })!
    copiedExactly(raw, result)
    expect(result.text.startsWith('[6 Passed hook rows omitted]\ncheck for merge conflicts')).toBe(true)
    expect(result.text).toContain('[3 hook rows (1 Passed, 2 Skipped) omitted]\nfix requirements')
    expect(result.text).toContain('no print statements......................................................Failed\n- hook id: no-print\n- exit code: 1\n\napp.py:5:    print("hello")\n')
    expect(result.text).toContain('fix requirements.........................................................Failed\n- hook id: fixer\n- files were modified by this hook')
    keepsAllBut(raw, result.text, HOOK_OK)
    expect(projectStaticFilter({ command: 'pre-commit', stdout: raw, exitCode: 1 })?.filter).toBe('pre-commit')
  })

  // Adapted from RTK's pre-commit filter tests (Apache-2.0, see third-party/rtk).
  it('folds environment setup messages and keeps rows with details under them', () => {
    const rtk = '[INFO] Installing environment for https://github.com/psf/black.\n[INFO] Once installed this environment will be reused.\n[INFO] This may take a few minutes...\nTrim Trailing Whitespace.................................................Passed\nFix End of Files.........................................................Passed\nCheck Yaml...............................................................Failed\n- hook id: check-yaml\n- exit code: 1\n'
    expect(project(preCommitFilter, 'pre-commit run', rtk, 1)).toBe('[3 hook environment setup lines omitted]\nTrim Trailing Whitespace.................................................Passed\nFix End of Files.........................................................Passed\nCheck Yaml...............................................................Failed\n- hook id: check-yaml\n- exit code: 1\n')
    // Verbose: each row has details under it, so no row is folded.
    const verbose = Array.from({ length: 4 }, (_, i) => `hook ${i}.................................................................Passed\n- hook id: hook-${i}\n- duration: 0.0${i}s\n`).join('')
    expect(project(preCommitFilter, 'pre-commit run --verbose', verbose, 0)).toBeUndefined()
    // A passed row followed by its details (a hook with verbose: true) is not folded with the rows before it.
    const tail = 'a......Passed\nb......Passed\nc......Passed\n- hook id: c\n- duration: 0.1s\n\nprinted by c\n'
    expect(project(preCommitFilter, 'pre-commit run', tail, 0)).toBeUndefined()
  })

  it('leaves other subcommands, other tools and colored output alone', () => {
    expect(project(preCommitFilter, 'pre-commit install', raw, 0)).toBeUndefined()
    expect(project(preCommitFilter, 'prek run', raw, 1)).toBeUndefined()
    expect(project(preCommitFilter, 'pre-commit run', raw.replace(/Passed$/mu, '\u001b[42mPassed\u001b[m'), 1)).toBeUndefined()
    expect(project(preCommitFilter, 'pre-commit run', 'An error has occurred: InvalidConfigError:\n', 1)).toBeUndefined()
  })
})

describe('uv-sync', () => {
  const install = fixture('uv-pip-install.txt')
  const ADDED = /^ \+ /u

  it('previews a long list of installed packages, keeping its head, tail and every count', () => {
    const result = uvSyncFilter.projectMapped({ command: 'uv pip install -r requirements.txt', stdout: install, exitCode: 0 })!
    copiedExactly(install, result)
    expect(result.text).toBe([
      'Using Python 3.12.9 environment at: /Users/demo/app/.venv',
      'Resolved 18 packages in 19ms',
      'Installed 18 packages in 52ms',
      ' + ast-serialize==0.13.1',
      ' + cfgv==3.5.0',
      ' + distlib==0.4.4',
      '[13 more "+" rows of installed packages omitted]',
      ' + typing-extensions==4.16.0',
      ' + virtualenv==21.14.12',
      '',
    ].join('\n'))
    keepsAllBut(install, result.text, ADDED)
  })

  it('keeps the rows of packages the command names, upgrades, removals and short lists', () => {
    // The three named packages split the list into runs too short to preview.
    expect(project(uvSyncFilter, 'uv pip install mypy ruff pre-commit', install)).toBeUndefined()
    expect(project(uvSyncFilter, 'uv pip sync requirements.txt', fixture('uv-pip-sync.txt'))).toBeUndefined()
    expect(project(uvSyncFilter, 'uv pip install mypy ruff pre-commit', fixture('uv-pip-install-audited.txt'))).toBeUndefined()
    /** Synthetic, in uv's layout: a fresh `uv sync` that downloads three large wheels, then an upgrade among the new rows. */
    const names = ['annotated-types', 'anyio', 'certifi', 'charset-normalizer', 'click', 'h11', 'httpcore', 'httpx', 'idna', 'iniconfig', 'mypy', 'mypy-extensions', 'packaging', 'pluggy', 'pydantic', 'pydantic-core', 'pytest', 'ruff', 'sniffio', 'typing-extensions']
    const sync = [
      'Using CPython 3.12.9',
      'Creating virtual environment at: .venv',
      'Resolved 22 packages in 1.21s',
      'Downloading pydantic-core (1.9MiB)',
      'Downloading ruff (10.6MiB)',
      'Downloading mypy (12.4MiB)',
      ' Downloaded pydantic-core',
      ' Downloaded ruff',
      ' Downloaded mypy',
      'Prepared 21 packages in 2.31s',
      'Uninstalled 1 package in 2ms',
      'Installed 21 packages in 85ms',
      ...names.slice(0, 7).map(name => ` + ${name}==1.0.0`),
      ' - httpx==0.27.0',
      ' + httpx==0.28.1',
      ...names.slice(8).map(name => ` + ${name}==1.0.0`),
      ' + demo==0.1.0 (from file:///Users/demo/app)',
      'warning: `VIRTUAL_ENV=/opt/venv` does not match the project environment path `.venv` and will be ignored',
      '',
    ].join('\n')
    const projected = project(uvSyncFilter, 'uv sync', sync)!
    expect(projected).toContain('Resolved 22 packages in 1.21s\n[6 download progress rows omitted]\nPrepared 21 packages in 2.31s\n')
    // Seven rows before the upgrade: kept. The upgrade pair, then twelve new rows: previewed.
    expect(projected).toContain(' + httpcore==1.0.0\n - httpx==0.27.0\n + httpx==0.28.1\n + idna==1.0.0\n + iniconfig==1.0.0\n + mypy==1.0.0\n[7 more "+" rows of installed packages omitted]\n + sniffio==1.0.0\n + typing-extensions==1.0.0\n + demo==0.1.0 (from file:///Users/demo/app)\nwarning:')
    keepsAllBut(sync, projected, /^ \+ \S+==1\.0\.0$|Download/u)
  })

  it('leaves other subcommands, other tools and colored output alone', () => {
    expect(project(uvSyncFilter, 'uv lock', install)).toBeUndefined()
    expect(project(uvSyncFilter, 'uv run pytest', install)).toBeUndefined()
    expect(project(uvSyncFilter, 'pip install -r requirements.txt', install)).toBeUndefined()
    expect(project(uvSyncFilter, 'uv sync', `\u001b[2m${install}`)).toBeUndefined()
    expect(project(uvSyncFilter, 'uv sync', install.replace(/^(?:Resolved|Installed) .*\n/gmu, ''))).toBeUndefined()
  })
})

describe('poetry-install', () => {
  /** Synthetic, in Poetry 1.8 / 2.x's non-interactive layout. */
  const packages = ['asgiref (3.8.1)', 'certifi (2024.8.30)', 'charset-normalizer (3.4.0)', 'django (5.1.3)', 'idna (3.10)', 'iniconfig (2.0.0)', 'packaging (24.2)', 'pluggy (1.5.0)', 'pytest (8.3.3)', 'pytest-django (4.9.0)', 'sqlparse (0.5.2)', 'urllib3 (2.2.3)', 'requests (2.32.3)', 'whitenoise (6.8.2)']
  const out = [
    'Installing dependencies from lock file',
    '',
    `Package operations: ${packages.length} installs, 1 update, 1 removal`,
    '',
    '  - Removing six (1.16.0)',
    '  - Updating gunicorn (22.0.0 -> 23.0.0)',
    ...packages.map(name => `  - Installing ${name}`),
    '',
    'Installing the current project: shop (0.1.0)',
    '',
  ].join('\n')

  it('previews a long Installing list, keeping updates, removals and counts', () => {
    const result = poetryInstallFilter.projectMapped({ command: 'poetry install --no-root', stdout: out, exitCode: 0 })!
    copiedExactly(out, result)
    expect(result.text).toContain('  - Removing six (1.16.0)\n  - Updating gunicorn (22.0.0 -> 23.0.0)\n  - Installing asgiref (3.8.1)\n  - Installing certifi (2024.8.30)\n  - Installing charset-normalizer (3.4.0)\n[9 more "Installing" rows omitted]\n  - Installing requests (2.32.3)\n  - Installing whitenoise (6.8.2)\n\nInstalling the current project: shop (0.1.0)\n')
    keepsAllBut(out, result.text, /^ {2}- Installing /u)
    expect(projectStaticFilter({ command: 'poetry sync', stdout: out, exitCode: 0 })?.filter).toBe('poetry-install')
  })

  // Adapted from RTK's poetry-install filter tests (Apache-2.0, see third-party/rtk).
  it('keeps named packages and short lists, and leaves other commands alone', () => {
    // The named package's row stays after a preview of the thirteen before it.
    expect(project(poetryInstallFilter, 'poetry update whitenoise', out)).toContain('[8 more "Installing" rows omitted]\n  - Installing urllib3 (2.2.3)\n  - Installing requests (2.32.3)\n  - Installing whitenoise (6.8.2)\n')
    expect(project(poetryInstallFilter, 'poetry update django pytest', out)).toBeUndefined()
    const rtk = 'Installing dependencies from lock file\n\n  - Downloading requests-2.31.0-py3-none-any.whl (62.6 kB)\n  - Installing certifi (2023.11.17)\n  - Installing charset-normalizer (3.3.2)\n  - Installing idna (3.6)\n  - Installing urllib3 (2.1.0)\n  - Installing requests (2.31.0)\n\nWriting lock file\n'
    expect(project(poetryInstallFilter, 'poetry install', rtk)).toBeUndefined()
    expect(project(poetryInstallFilter, 'poetry install', 'Installing dependencies from lock file\n\nNo dependencies to install or update\n')).toBeUndefined()
    expect(project(poetryInstallFilter, 'poetry show', out)).toBeUndefined()
    expect(project(poetryInstallFilter, 'pip install .', out)).toBeUndefined()
    expect(project(poetryInstallFilter, 'poetry install', `\u001b[39m${out}`)).toBeUndefined()
  })
})

describe('bundle-install', () => {
  const local = fixture('bundle-install-local.txt')
  const QUIET = /^(?:Using|Fetching) \S+ \S+$/u

  it('folds Using rows of gems already installed, keeping the warning and the summary', () => {
    const result = bundleInstallFilter.projectMapped({ command: 'bundle install --local', stdout: local, exitCode: 0 })!
    copiedExactly(local, result)
    // The lone first row costs less kept; the eleven after the warning become one note.
    expect(result.text).toContain('Resolving dependencies...\nUsing rake 12.3.3\nFollowing files may not be writable, so sudo is needed:\n')
    expect(result.text).toContain('  /usr/local/bin\n[11 "Using" rows of gems already installed omitted]\nBundle complete! 10 Gemfile dependencies, 12 gems now installed.\n')
    keepsAllBut(local, result.text, QUIET)
  })

  it('counts Fetching rows of installed gems and previews a long Installing list', () => {
    /** Synthetic, in Bundler 2.5's layout: a fresh install with parallel jobs. */
    const gems = ['base64 0.2.0', 'bigdecimal 3.1.8', 'concurrent-ruby 1.3.4', 'connection_pool 2.4.1', 'drb 2.2.1', 'i18n 1.14.6', 'minitest 5.25.1', 'mutex_m 0.3.0', 'tzinfo 2.0.6', 'activesupport 7.2.2', 'racc 1.8.1', 'nokogiri 1.16.7 (arm64-darwin)', 'rack 3.1.8']
    const out = [
      'Fetching gem metadata from https://rubygems.org/..........',
      'Resolving dependencies...',
      'Using bundler 2.5.22',
      ...gems.flatMap(gem => [`Fetching ${gem}`, `Installing ${gem}${gem.startsWith('bigdecimal') ? ' with native extensions' : ''}`]),
      'Bundle complete! 4 Gemfile dependencies, 14 gems now installed.',
      'Use `bundle info [gemname]` to see where a bundled gem is installed.',
      '',
    ].join('\n')
    const projected = project(bundleInstallFilter, 'bundle install', out)!
    expect(projected).toBe([
      'Fetching gem metadata from https://rubygems.org/..........',
      'Resolving dependencies...',
      'Installing base64 0.2.0',
      'Installing bigdecimal 3.1.8 with native extensions',
      'Installing concurrent-ruby 1.3.4',
      '[8 more "Installing" rows, 1 "Using" rows of gems already installed, 13 "Fetching" rows of gems installed in this run omitted]',
      'Installing nokogiri 1.16.7 (arm64-darwin)',
      'Installing rack 3.1.8',
      'Bundle complete! 4 Gemfile dependencies, 14 gems now installed.',
      'Use `bundle info [gemname]` to see where a bundled gem is installed.',
      '',
    ].join('\n'))
  })

  // Adapted from RTK's bundle-install filter tests (Apache-2.0, see third-party/rtk).
  it('keeps version changes, named gems, problem lines, and leaves other commands alone', () => {
    const update = 'Fetching gem metadata from https://rubygems.org/.........\nResolving dependencies...\nUsing rake 13.1.0\nUsing ast 2.4.2\nUsing base64 0.2.0\nFetching rspec 3.14.0 (was 3.13.0)\nInstalling rspec 3.14.0 (was 3.13.0)\nUsing error_highlight 0.6.0\nUsing minitest 5.22.2 (was 5.21.0)\nBundle updated!\n'
    expect(project(bundleInstallFilter, 'bundle update', update)).toBe('Fetching gem metadata from https://rubygems.org/.........\nResolving dependencies...\n[3 "Using" rows of gems already installed omitted]\nFetching rspec 3.14.0 (was 3.13.0)\nInstalling rspec 3.14.0 (was 3.13.0)\nUsing error_highlight 0.6.0\nUsing minitest 5.22.2 (was 5.21.0)\nBundle updated!\n')
    expect(project(bundleInstallFilter, 'bundle update rake ast', update)).toBeUndefined()
    const cached = 'Using bundler 2.5.6\nUsing rake 13.1.0\nUsing ast 2.4.2\nUsing base64 0.2.0\nUsing minitest 5.22.2\nBundle complete! 85 Gemfile dependencies, 200 gems now installed.\nUse `bundle info [gemname]` to see where a bundled gem is installed.\n'
    expect(project(bundleInstallFilter, 'bundle', cached)).toBe('[5 "Using" rows of gems already installed omitted]\nBundle complete! 85 Gemfile dependencies, 200 gems now installed.\nUse `bundle info [gemname]` to see where a bundled gem is installed.\n')
    expect(project(bundleInstallFilter, 'bundle exec rake', cached)).toBeUndefined()
    expect(project(bundleInstallFilter, 'bundle install', cached.replace('Bundle complete!', 'Done!'))).toBeUndefined()
    expect(project(bundleInstallFilter, 'bundle install', `\u001b[32m${cached}`)).toBeUndefined()
  })
})

describe('composer-install', () => {
  /** Synthetic, in Composer 2.8's non-interactive layout: parallel downloads first, then installs. */
  const packages = ['psr/container (2.0.2)', 'psr/log (3.0.2)', 'symfony/event-dispatcher (v7.1.6)', 'symfony/polyfill-ctype (v1.31.0)', 'symfony/polyfill-mbstring (v1.31.0)', 'symfony/service-contracts (v3.5.0)', 'symfony/string (v7.1.8)', 'symfony/console (v7.1.8)', 'monolog/monolog (3.8.0)', 'nikic/php-parser (v5.3.1)', 'phpunit/php-timer (6.0.0)', 'sebastian/diff (5.1.1)', 'doctrine/instantiator (2.0.0)']
  const out = [
    'Installing dependencies from lock file (including require-dev)',
    'Verifying lock file contents can be installed on current platform.',
    `Package operations: ${packages.length} installs, 1 update, 0 removals`,
    ...packages.map(name => `  - Downloading ${name}`),
    '  - Upgrading guzzlehttp/guzzle (7.8.0 => 7.9.2): Extracting archive',
    ...packages.map(name => `  - Installing ${name}: Extracting archive`),
    'Package doctrine/instantiator is abandoned, you should avoid using it. No replacement was suggested.',
    'Generating optimized autoload files',
    '12 packages you are using are looking for funding.',
    'Use the `composer fund` command to find out more!',
    '',
  ].join('\n')

  it('counts Downloading rows of installed packages and previews the Installing list', () => {
    const result = composerInstallFilter.projectMapped({ command: 'composer install --no-interaction', stdout: out, exitCode: 0 })!
    copiedExactly(out, result)
    expect(result.text).toBe([
      'Installing dependencies from lock file (including require-dev)',
      'Verifying lock file contents can be installed on current platform.',
      'Package operations: 13 installs, 1 update, 0 removals',
      '[13 "Downloading" rows of packages installed in this run omitted]',
      '  - Upgrading guzzlehttp/guzzle (7.8.0 => 7.9.2): Extracting archive',
      '  - Installing psr/container (2.0.2): Extracting archive',
      '  - Installing psr/log (3.0.2): Extracting archive',
      '  - Installing symfony/event-dispatcher (v7.1.6): Extracting archive',
      '[8 more "Installing" rows omitted]',
      '  - Installing sebastian/diff (5.1.1): Extracting archive',
      '  - Installing doctrine/instantiator (2.0.0): Extracting archive',
      'Package doctrine/instantiator is abandoned, you should avoid using it. No replacement was suggested.',
      'Generating optimized autoload files',
      '12 packages you are using are looking for funding.',
      'Use the `composer fund` command to find out more!',
      '',
    ].join('\n'))
    keepsAllBut(out, result.text, /^ {2}- (?:Downloading|Installing) /u)
    // A package whose name mentions a problem word is never folded: its rows split the runs.
    const deprecation = out.replaceAll('symfony/event-dispatcher (v7.1.6)', 'symfony/deprecation-contracts (v3.5.0)')
    const projected = project(composerInstallFilter, 'composer install', deprecation)!
    expect(projected).toContain('  - Downloading psr/log (3.0.2)\n  - Downloading symfony/deprecation-contracts (v3.5.0)\n[10 "Downloading" rows')
    expect(projected).toContain('  - Installing symfony/deprecation-contracts (v3.5.0): Extracting archive\n  - Installing symfony/polyfill-ctype')
  })

  // Adapted from RTK's composer-install filter tests (Apache-2.0, see third-party/rtk).
  it('keeps rows of named packages and of packages not installed, and leaves other commands alone', () => {
    expect(project(composerInstallFilter, 'composer require monolog/monolog:^3.8', out)).toContain('  - Installing monolog/monolog (3.8.0): Extracting archive\n')
    const rtk = 'Loading composer repositories with package information\nUpdating dependencies\n  - Downloading symfony/console (v6.4.0)\n  - Installing symfony/console (v6.4.0): Extracting archive\n  - Downloading psr/log (3.0.0)\n  - Installing psr/log (3.0.0): Extracting archive\nWriting lock file\nGenerating autoload files\n'
    expect(project(composerInstallFilter, 'composer update', rtk)).toBeUndefined()
    // Downloads with no install after them (the run stopped) are not repeated anywhere: kept.
    const stopped = out.replace(/^ {2}- Installing .*\n/gmu, '')
    expect(project(composerInstallFilter, 'composer install', stopped)).toBeUndefined()
    expect(project(composerInstallFilter, 'composer dump-autoload', out)).toBeUndefined()
    expect(project(composerInstallFilter, 'composer install', `\u001b[32m${out}`)).toBeUndefined()
  })
})

describe('rubocop', () => {
  /** Synthetic, in RuboCop 1.6x's default (progress) layout. */
  const out = [
    'Inspecting 4 files',
    'CC.W',
    '',
    'Offenses:',
    '',
    'app/models/user.rb:1:1: C: [Correctable] Style/FrozenStringLiteralComment: Missing frozen string literal comment.',
    'class User < ApplicationRecord',
    '^',
    'app/models/user.rb:1:1: C: Style/Documentation: Missing top-level documentation comment for class User.',
    'class User < ApplicationRecord',
    '^^^^^^^^^^',
    'app/models/user.rb:4:11: C: [Correctable] Style/StringLiterals: Prefer single-quoted strings when you don\'t need string interpolation or special symbols.',
    '    where("active = ?", true)',
    '          ^^^^^^^^^^^^',
    'app/models/user.rb:9:121: C: Layout/LineLength: Line is too long. [131/120]',
    '  def label = [first_name, middle_name, last_name, suffix].compact.reject(&:blank?).map(&:strip).join(" ").presence || email_address',
    '                                                                                                                        ^^^^^^^^^^^',
    'app/services/billing.rb:12:5: W: [Correctable] Lint/UselessAssignment: Useless assignment to variable - total.',
    '    total = 0',
    '    ^^^^^',
    'app/controllers/users_controller.rb:1:1: C: [Correctable] Style/FrozenStringLiteralComment: Missing frozen string literal comment.',
    'class UsersController < ApplicationController',
    '^',
    '',
    '4 files inspected, 6 offenses detected, 4 offenses autocorrectable',
    '',
  ].join('\n')

  it('lists a file\'s consecutive offenses under its name, keeping each source line and highlight', () => {
    const result = rubocopFilter.projectMapped({ command: 'bundle exec rubocop', stdout: out, exitCode: 1 })!
    copiedExactly(out, result)
    expect(result.text).toContain('Offenses:\n\n[offenses in app/models/user.rb]\n  1:1: C: [Correctable] Style/FrozenStringLiteralComment: Missing frozen string literal comment.\nclass User < ApplicationRecord\n^\n  1:1: C: Style/Documentation:')
    expect(result.text).toContain('\napp/services/billing.rb:12:5: W: [Correctable] Lint/UselessAssignment: Useless assignment to variable - total.\n    total = 0\n')
    expect(ungroup(result.text, 'offenses in', true)).toBe(out)
    expect(projectStaticFilter({ command: 'rubocop app', stdout: out, exitCode: 1 })?.filter).toBe('rubocop')
  })

  it('leaves other formats, commands and colored output alone', () => {
    expect(project(rubocopFilter, 'rubocop', out.replace(/^4 files inspected.*$/mu, ''), 1)).toBeUndefined()
    expect(project(rubocopFilter, 'rubocop --format json', '{"metadata":{}}\n', 1)).toBeUndefined()
    expect(project(rubocopFilter, 'rubocop', 'Inspecting 4 files\n....\n\n4 files inspected, no offenses detected\n', 0)).toBeUndefined()
    expect(project(rubocopFilter, 'standardrb', out, 1)).toBeUndefined()
    expect(project(rubocopFilter, 'rubocop', out, 2)).toBeUndefined()
    expect(project(rubocopFilter, 'rubocop', `\u001b[36m${out}`, 1)).toBeUndefined()
  })
})

describe('minitest', () => {
  const verbose = fixture('rake-test-verbose.txt')
  const PASSED = /^\S+#\S+ = \d+\.\d+ s = \.$/u

  it('previews runs of passing verbose rows, keeping every failing, erroring and skipped test', () => {
    const result = minitestFilter.projectMapped({ command: 'rake test TESTOPTS=-v', stdout: verbose, exitCode: 1 })!
    copiedExactly(verbose, result)
    expect(result.text).toContain('MoreTest#test_more_6 = 0.00 s = .\n[34 positive-status rows omitted]\nCalcTest#test_add_5 = 0.00 s = .\nCalcTest#test_skip = 0.00 s = S\n')
    for (const row of ['CalcTest#test_skip = 0.00 s = S', 'CalcTest#test_wrong = 0.00 s = F', 'CalcTest#test_div_zero = 0.00 s = E']) expect(result.text).toContain(row)
    expect(result.text).toContain('  2) Failure:\nCalcTest#test_wrong [/Users/demo/calc/test/calc_test.rb:22]:\nExpected: 5\n  Actual: 4\n')
    expect(result.text).toContain('ZeroDivisionError: divided by 0\n    /Users/demo/calc/lib/calc.rb:7:in `/\'\n')
    expect(result.text).toContain('46 runs, 44 assertions, 1 failures, 1 errors, 1 skips\n')
    keepsAllBut(verbose, result.text, PASSED)
    expect(projectStaticFilter({ command: 'bin/rails test -v', stdout: verbose, exitCode: 1 })?.filter).toBe('minitest')
  })

  it('keeps passing rows that mention a problem, and leaves the dots layout and other commands alone', () => {
    const named = verbose.replace('CalcTest#test_add_19 = 0.00 s = .', 'CalcTest#test_error_message = 0.00 s = .')
    expect(project(minitestFilter, 'rake test TESTOPTS=-v', named, 1)).toContain('CalcTest#test_error_message = 0.00 s = .\n')
    expect(project(minitestFilter, 'rake test', fixture('rake-test.txt'), 1)).toBeUndefined()
    expect(project(minitestFilter, 'rake db:migrate', verbose, 1)).toBeUndefined()
    expect(project(minitestFilter, 'rspec', verbose, 1)).toBeUndefined()
    expect(project(minitestFilter, 'rake test', verbose.replace(/^46 runs.*$/mu, ''), 1)).toBeUndefined()
    expect(project(minitestFilter, 'rake test', `\u001b[32m${verbose}`, 1)).toBeUndefined()
  })
})

describe('phpunit', () => {
  /** Synthetic, in PHPUnit 10's layout: 63 results per progress row, the count right-aligned. */
  const rows = (total: number, failAt: number) => {
    const out: string[] = []
    for (let done = 0; done < total; done += 63) {
      const n = Math.min(63, total - done)
      const marks = Array.from({ length: n }, (_, i) => done + i === failAt ? 'F' : '.').join('').padEnd(63)
      out.push(`${marks} ${String(done + n).padStart(String(total).length)} / ${total} (${String(Math.floor((done + n) * 100 / total)).padStart(3)}%)`)
    }
    return out
  }
  const out = [
    'PHPUnit 10.5.38 by Sebastian Bergmann and contributors.',
    '',
    'Runtime:       PHP 8.3.12',
    'Configuration: /Users/demo/shop/phpunit.xml',
    '',
    ...rows(500, 260),
    '',
    'Time: 00:02.345, Memory: 48.00 MB',
    '',
    'There was 1 failure:',
    '',
    '1) App\\Tests\\OrderTest::testTotal',
    'Failed asserting that 42 matches expected 100.',
    '',
    '/Users/demo/shop/tests/OrderTest.php:17',
    '',
    'FAILURES!',
    'Tests: 500, Assertions: 1204, Failures: 1.',
    '',
  ].join('\n')

  it('folds runs of all-passing progress rows, keeping rows with any other status and every report', () => {
    const result = phpunitFilter.projectMapped({ command: 'vendor/bin/phpunit', stdout: out, exitCode: 1 })!
    copiedExactly(out, result)
    expect(result.text).toContain('Configuration: /Users/demo/shop/phpunit.xml\n\n[4 progress rows of passing tests omitted]\n')
    expect(result.text).toMatch(/^\.{8}F\.{54} 315 \/ 500 \( 63%\)$/mu)
    expect(result.text).toContain('[3 progress rows of passing tests omitted]\n\nTime:')
    expect(result.text).toContain('1) App\\Tests\\OrderTest::testTotal\nFailed asserting that 42 matches expected 100.\n\n/Users/demo/shop/tests/OrderTest.php:17\n')
    keepsAllBut(out, result.text, /^\.+ +\d+ \/ \d+ \( *\d+%\)$/u)
    expect(projectStaticFilter({ command: 'php vendor/bin/phpunit --colors=never', stdout: out, exitCode: 1 })?.filter).toBe('phpunit')
  })

  it('previews passing TestDox rows', () => {
    /** Synthetic, in PHPUnit's --testdox layout. */
    const tests = ['Total is sum of lines', 'Total with no lines is zero', 'Tax is added', 'Shipping is free over limit', 'Shipping is charged under limit', 'Coupon reduces total', 'Currency is kept']
    const testdox = [
      'PHPUnit 10.5.38 by Sebastian Bergmann and contributors.',
      '',
      'Order (App\\Tests\\Order)',
      ...tests.map(name => ` ✔ ${name}`),
      ' ✘ Discount applies',
      '   │',
      '   │ Failed asserting that 90 matches expected 85.',
      '   │',
      '   │ /Users/demo/shop/tests/OrderTest.php:40',
      '   │',
      '',
      'FAILURES!',
      'Tests: 8, Assertions: 9, Failures: 1.',
      '',
    ].join('\n')
    const projected = project(phpunitFilter, 'phpunit --testdox', testdox, 1)!
    expect(projected).toContain(' ✔ Total is sum of lines\n[5 positive-status rows omitted]\n ✔ Currency is kept\n ✘ Discount applies\n')
    keepsAllBut(testdox, projected, /^ ✔ /u)
  })

  // Adapted from RTK's phpunit tests (Apache-2.0, see third-party/rtk).
  it('leaves short runs, other commands and colored output alone', () => {
    const rtk = 'PHPUnit 10.5.0 by Sebastian Bergmann and contributors.\n\nRuntime:       PHP 8.2.27 with Xdebug 3.3.1\nConfiguration: /var/www/html/phpunit.xml\n\n........................................          40 / 40 (100%)\n..................................................  80 / 80 (100%)\n.F................................................  100 / 100 (100%)\n..........                                         110 / 110 (100%)\n\nTime: 00:01:23.456, Memory: 48.00 MB\n\nThere was 1 failure:\n\n1) App\\Tests\\UserTest::testEmailValidation\nFailed asserting that false is true.\n\n#0 /var/www/html/src/User.php:142 (App\\User::validate)\n#1 /var/www/html/tests/UserTest.php:38 (App\\Tests\\UserTest::testEmailValidation)\n\nFAILURES!\nTests: 110, Assertions: 340, Failures: 1.\n'
    expect(project(phpunitFilter, 'phpunit', rtk, 1)).toBeUndefined()
    expect(project(phpunitFilter, 'phpunit', out.replace(/^Tests: 500.*$/mu, '').replace('FAILURES!', ''), 1)).toBeUndefined()
    expect(project(phpunitFilter, 'pest', out, 1)).toBeUndefined()
    expect(project(phpunitFilter, 'phpunit --colors=always', `\u001b[41m${out}`, 1)).toBeUndefined()
  })
})

describe('routing', () => {
  it('claims each covered command before it runs', () => {
    for (const command of [
      'mypy src', 'python -m mypy .', 'uv run mypy app', 'pyright', 'basedpyright src', 'npx pyright', 'ty check', 'uv run ty check src',
      'ruff check .', 'ruff check --output-format concise src', 'pre-commit run --all-files', 'pre-commit',
      'uv sync', 'uv pip install -r requirements.txt', 'uv pip sync requirements.txt', 'poetry install', 'poetry update requests',
      'bundle install', 'bundle update rails', 'composer install', 'composer require monolog/monolog',
      'rubocop', 'bundle exec rubocop app', 'rake test', 'bin/rails test test/models', 'rake test:units',
      'vendor/bin/phpunit', 'php vendor/bin/phpunit --testdox', 'cd ./api && phpunit',
    ]) expect(mayProject(command), command).toBe(true)
    for (const command of ['ruff format .', 'ty server', 'pre-commit install', 'uv lock', 'poetry show', 'composer dump-autoload', 'rake db:migrate']) {
      expect(mayProject(command), command).toBe(false)
    }
  })
})
