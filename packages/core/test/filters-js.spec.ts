import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectStaticFilter } from '../src/filters/index.ts'
import { jsTestFilter } from '../src/filters/js-test.ts'
import { playwrightFilter } from '../src/filters/playwright.ts'
import { nextBuildFilter } from '../src/filters/next-build.ts'
import { ngBuildFilter } from '../src/filters/ng-build.ts'
import { pnpmListFilter, pnpmOutdatedFilter } from '../src/filters/pnpm-deps.ts'
import { turboFilter } from '../src/filters/turbo.ts'
import { prismaMigrateFilter } from '../src/filters/prisma-migrate.ts'
import { prettierFilter } from '../src/filters/prettier.ts'
import { mayProject } from '../src/economy.ts'

/**
 * Real outputs captured on macOS in throwaway projects (Vitest 5.0.4, Playwright 1.58.2,
 * Next.js 14.2.24, pnpm 10.4.1, Prettier 3.6.2; packages from the local cache, no network);
 * the project directory replaced by /repo.
 */
const real = (name: string) => readFileSync(new URL(`fixtures/js/${name}`, import.meta.url), 'utf8')

/** Every line of `raw` that `removed` does not match appears in `text`, in order. */
function keepsAllBut(raw: string, text: string, removed: RegExp) {
  let at = 0
  for (const line of raw.split('\n').filter(line => line !== '' && !removed.test(line))) {
    const found = text.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(0)
    at = found + line.length
  }
}

/** `text` with every run of two or more spaces cut to one: what a padding-only change must equal. */
const unpadded = (text: string) => text.replace(/ {2,}/gu, ' ')

describe('jest and vitest', () => {
  const PASSING = /^ +[✓√] |^PASS /u

  it('folds the passing rows of a failing verbose Vitest run, keeping every failure, skip, frame and the summary', () => {
    const raw = real('vitest-verbose-fail.txt')
    const out = projectStaticFilter({ command: 'npx vitest run --reporter=verbose', stdout: raw, exitCode: 1 })!
    expect(out.filter).toBe('js-test')
    expect(out.text).toContain('[7 passing tests omitted]\n × src/broken.test.ts > broken > compares totals 4ms')
    expect(out.text).toContain('[12 passing tests omitted]\n')
    expect(out.text).toContain(' ↓ src/broken.test.ts > broken > is skipped\n')
    expect(out.text).toContain('      Tests  2 failed | 19 passed | 1 skipped (22)\n')
    keepsAllBut(raw, out.text, PASSING)
    expect(out.text.length).toBeLessThan(raw.length * 0.7)
  })

  it('folds a verbose passing run with its counts, and leaves Vitest 5\'s compact default report alone', () => {
    const raw = real('vitest-verbose-pass.txt')
    const out = jsTestFilter.project({ command: 'npx vitest run --reporter=verbose', stdout: raw, exitCode: 0 })!
    expect(out).toContain('[18 passing tests omitted]\n\n Test Files  6 passed (6)\n      Tests  18 passed (18)\n')
    keepsAllBut(raw, out, PASSING)
    // Vitest 5 prints no passing rows outside verbose mode: nothing to fold.
    expect(jsTestFilter.project({ command: 'npx vitest run', stdout: real('vitest-pass.txt'), exitCode: 0 })).toBeUndefined()
    expect(jsTestFilter.project({ command: 'npx vitest run', stdout: real('vitest-fail.txt'), exitCode: 1 })).toBeUndefined()
  })

  // Synthetic, in Vitest 2's default (non-TTY) layout: one row per test file.
  const vitest2 = [
    '',
    ' RUN  v2.1.8 /repo',
    '',
    ...['math', 'strings', 'arrays', 'dates'].map(name => ` ✓ src/${name}.test.ts (3 tests) 2ms`),
    ' ❯ src/broken.test.ts (4 tests | 2 failed | 1 skipped) 6ms',
    '   × broken > compares totals 4ms',
    '     → expected { total: 3 } to deeply equal { total: 4 }',
    '   × broken > throws 0ms',
    '     → boom: cannot parse config',
    ' ✓ src/parse.test.ts (3 tests) 1ms',
    ' ✓ src/errors.test.ts (3 tests) 1ms',
    ' ✓ src/format.test.ts (3 tests) 1ms',
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  src/broken.test.ts > broken > compares totals',
    'AssertionError: expected { total: 3 } to deeply equal { total: 4 }',
    ' ❯ src/broken.test.ts:4:54',
    '',
    ' Test Files  1 failed | 7 passed (8)',
    '      Tests  2 failed | 22 passed | 1 skipped (25)',
    '   Start at  10:00:00',
    '   Duration  1.20s (transform 101ms, setup 0ms, collect 180ms, tests 21ms, environment 2ms, prepare 640ms)',
    '',
  ].join('\n')

  it('folds Vitest 2 passing file rows, never one that names a problem', () => {
    const out = jsTestFilter.project({ command: 'vitest run', stdout: vitest2, exitCode: 1 })!
    expect(out).toContain(' RUN  v2.1.8 /repo\n\n[4 passing test files omitted]\n ❯ src/broken.test.ts')
    // Three rows, but the middle one mentions errors: too short a run on either side of it.
    expect(out).toContain(' ✓ src/parse.test.ts (3 tests) 1ms\n ✓ src/errors.test.ts (3 tests) 1ms\n ✓ src/format.test.ts (3 tests) 1ms\n')
    keepsAllBut(vitest2, out, PASSING)
  })

  // Synthetic, in Jest 29's default layout: a PASS/FAIL row per file, and test rows for a single file.
  const jest = [
    'PASS src/math.test.js',
    'PASS src/strings.test.js',
    'PASS src/arrays.test.js (5.12 s)',
    'FAIL src/broken.test.js',
    '  broken',
    '    ✓ passes first (1 ms)',
    '    ✓ parses dates (1 ms)',
    '    ✓ formats money',
    '    ✕ compares totals (3 ms)',
    '    ○ skipped is skipped',
    '',
    '  ● broken › compares totals',
    '',
    '    expect(received).toEqual(expected) // deep equality',
    '',
    '    - Expected  - 1',
    '    + Received  + 1',
    '',
    '      Object {',
    '    -   "total": 4,',
    '    +   "total": 3,',
    '      }',
    '',
    '      at Object.toEqual (src/broken.test.js:4:54)',
    '',
    'PASS src/dates.test.js',
    'PASS src/parse.test.js',
    '',
    'Test Suites: 1 failed, 5 passed, 6 total',
    'Tests:       1 failed, 1 skipped, 17 passed, 19 total',
    'Snapshots:   0 total',
    'Time:        6.204 s',
    'Ran all test suites.',
    '',
  ].join('\n')

  it('folds Jest PASS rows and passing test rows, keeping FAIL, failing and skipped rows and the failure block', () => {
    const out = projectStaticFilter({ command: 'npx jest', stdout: jest, exitCode: 1 })!
    expect(out.filter).toBe('js-test')
    expect(out.text).toContain('[3 passing test files omitted]\nFAIL src/broken.test.js\n  broken\n[3 passing tests omitted]\n    ✕ compares totals (3 ms)\n')
    // Two PASS rows cost less than a note.
    expect(out.text).toContain('PASS src/dates.test.js\nPASS src/parse.test.js\n')
    expect(out.text).toContain('Tests:       1 failed, 1 skipped, 17 passed, 19 total\n')
    keepsAllBut(jest, out.text, PASSING)
    // The same report from a package test script or the project's own binary.
    expect(jsTestFilter.project({ command: 'npm test', stdout: jest, exitCode: 1 })).toBe(out.text)
    expect(jsTestFilter.project({ command: 'yarn jest --ci', stdout: jest, exitCode: 1 })).toBe(out.text)
  })

  it('leaves output test-progress already condenses to it, and anything that is not one runner\'s report', () => {
    // A direct `vitest run` that passed: test-progress keeps its first and last rows, as before.
    const raw = real('vitest-verbose-pass.txt')
    expect(projectStaticFilter({ command: 'vitest run --reporter=verbose', stdout: raw, exitCode: 0 })?.filter).toBe('test-progress')
    expect(jsTestFilter.project({ command: 'npx vitest --watch', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(jsTestFilter.project({ command: 'npx vitest run', stdout: raw.replace(/ Test Files.*\n/u, ''), exitCode: 0 })).toBeUndefined()
    expect(jsTestFilter.project({ command: 'npx vitest run', stdout: `\u001b[32m${raw}`, exitCode: 0 })).toBeUndefined()
    expect(jsTestFilter.project({ command: 'npx vitest run', stdout: raw, exitCode: 2 })).toBeUndefined()
    expect(jsTestFilter.project({ command: 'npx mocha', stdout: jest, exitCode: 1 })).toBeUndefined()
    expect(jsTestFilter.project({ command: 'npm run build', stdout: jest, exitCode: 1 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['jest', 'npx jest --ci', 'vitest run', 'npx vitest run src', 'pnpm exec vitest run', 'pnpm vitest run', 'yarn jest', 'bunx vitest run', 'npm test', 'cd ./web && npx vitest run']) {
      expect(mayProject(command), command).toBe(true)
    }
  })
})

describe('playwright', () => {
  const PASSING = /^ {2}✓ +\d+ /u

  it('folds passing rows, keeping every failing and skipped row, error, frame and the counts', () => {
    const raw = real('playwright-fail.txt')
    const out = projectStaticFilter({ command: 'npx playwright test', stdout: raw, exitCode: 1 })!
    expect(out.filter).toBe('playwright')
    expect(out.text).toContain('[11 passing tests omitted]\n  -  15 tests/checkout.spec.ts:5:8 › checkout › ships abroad\n')
    expect(out.text).toContain('    Error: boom: cannot reach payment service\n')
    expect(out.text).toContain('  2 failed\n    tests/checkout.spec.ts:4:7 › checkout › computes total')
    keepsAllBut(raw, out.text, PASSING)
    const pass = real('playwright-pass.txt')
    expect(playwrightFilter.project({ command: 'pnpm exec playwright test', stdout: pass, exitCode: 0 }))
      .toBe('\nRunning 12 tests using 2 workers\n\n[12 passing tests omitted]\n\n  12 passed (695ms)\n')
  })

  it('keeps retried and problem-named passes, and leaves colored, other and unrecognized output alone', () => {
    const raw = real('playwright-pass.txt').replace('  ✓   4 tests/home.spec.ts:4:7 › home › keeps state (1ms)', '  ✓   4 tests/home.spec.ts:4:7 › home › keeps state (retry #1) (1ms)')
      .replace('  ✓   9 tests/profile.spec.ts:4:7 › profile › keeps state (3ms)', '  ✓   9 tests/profile.spec.ts:4:7 › profile › shows an error banner (3ms)')
    const out = playwrightFilter.project({ command: 'npx playwright test', stdout: raw, exitCode: 0 })!
    expect(out).toContain('(retry #1) (1ms)\n')
    expect(out).toContain('shows an error banner (3ms)\n')
    keepsAllBut(raw, out, PASSING)
    // Playwright colors expect() diffs even without a terminal: such output passes through.
    expect(playwrightFilter.project({ command: 'npx playwright test', stdout: real('playwright-fail-color.txt'), exitCode: 1 })).toBeUndefined()
    expect(playwrightFilter.project({ command: 'npx playwright show-report', stdout: real('playwright-pass.txt'), exitCode: 0 })).toBeUndefined()
    expect(playwrightFilter.project({ command: 'npx playwright test', stdout: real('playwright-pass.txt').replace('Running 12', 'Ran 12'), exitCode: 0 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['npx playwright test', 'pnpm exec playwright test --project=chromium', 'yarn playwright test']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('npx playwright install')).toBe(false)
  })
})

describe('next build', () => {
  it('cuts route-table padding and folds static-page progress, keeping every route, size and phase', () => {
    const raw = real('next-build.txt')
    const out = projectStaticFilter({ command: 'npx next build', stdout: raw, exitCode: 0 })!
    expect(out.filter).toBe('next-build')
    expect(out.text).toContain('   Collecting page data ...\n[4 static page progress lines omitted]\n ✓ Generating static pages (9/9)\n')
    expect(out.text).toContain('Route (app) Size First Load JS\n┌ ○ / 148 B 87.2 kB\n')
    expect(out.text).toContain('└ ● /blog/[slug] 149 B 87.2 kB\n    ├ /blog/one\n')
    expect(out.text).toContain('  └ other shared chunks (total) 1.83 kB\n')
    // Padding only: every kept line equals its source once padding is cut; the legend is untouched.
    keepsAllBut(unpadded(raw), unpadded(out.text), /Generating static pages \(\d\/9\) /u)
    expect(out.text).toContain('○  (Static)  prerendered as static content\n')
    expect(out.text.length).toBeLessThan(raw.length * 0.75)
  })

  it('leaves failed builds, dev servers and colored output alone', () => {
    const raw = real('next-build.txt')
    expect(nextBuildFilter.project({ command: 'next build', stdout: raw, exitCode: 1 })).toBeUndefined()
    expect(nextBuildFilter.project({ command: 'next dev', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(nextBuildFilter.project({ command: 'next build', stdout: `\u001b[1m${raw}`, exitCode: 0 })).toBeUndefined()
    const failed = '  ▲ Next.js 14.2.24\n\n   Creating an optimized production build ...\nFailed to compile.\n\n./app/page.js\nError: Unexpected token\n'
    expect(nextBuildFilter.project({ command: 'next build', stdout: failed, exitCode: 1 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    expect(mayProject('npx next build')).toBe(true)
    expect(mayProject('next build')).toBe(true)
    expect(mayProject('next start')).toBe(false)
  })
})

describe('ng build', () => {
  // Adapted from RTK's tests/fixtures/ng_build/lazy-chunks.stdout.txt and budget-error.* (Apache-2.0, see third-party/rtk).
  const lazy = [
    '❯ Building...',
    '✔ Building...',
    'Initial chunk files | Names         |  Raw size | Estimated transfer size',
    'main-HQODSNQU.js    | main          | 193.46 kB |                52.36 kB',
    'styles-3IO2SMMH.css | styles        |  61 bytes |                61 bytes',
    '',
    '                    | Initial total | 193.52 kB |                52.42 kB',
    '',
    'Lazy chunk files    | Names         |  Raw size | Estimated transfer size',
    'chunk-BmiBcDhi.js   | dashboard     | 419 bytes |               419 bytes',
    'chunk-D4-ECPz-.js   | settings      | 415 bytes |               415 bytes',
    'chunk-Dy4ZsgMF.js   | projects      | 415 bytes |               415 bytes',
    'chunk-CcxzvmAm.js   | reports       | 411 bytes |               411 bytes',
    'chunk-DSFAMcLH.js   | profile       | 411 bytes |               411 bytes',
    'chunk-g6pIdGbu.js   | help          | 399 bytes |               399 bytes',
    '',
    'Application bundle generation complete. [1.753 seconds] - 2026-10-02T20:01:55.941Z',
    '',
    'Output location: /workspace/scratch/72640dd8823a/rtk-angular-fixture-work/fixture-app/dist/fixture-app',
    '',
  ].join('\n')
  const budgetError = [
    '▲ [WARNING] bundle initial exceeded maximum budget. Budget 100.00 kB was not met by 90.07 kB with a total of 190.07 kB.',
    '',
    '',
    '✘ [ERROR] bundle initial exceeded maximum budget. Budget 150.00 kB was not met by 40.07 kB with a total of 190.07 kB.',
    '',
    '',
    '❯ Building...',
    '✔ Building...',
    'Initial chunk files | Names         |  Raw size | Estimated transfer size',
    'main-VYJRYTPO.js    | main          | 190.01 kB |                51.90 kB',
    'styles-3IO2SMMH.css | styles        |  61 bytes |                61 bytes',
    '',
    '                    | Initial total | 190.07 kB |                51.96 kB',
    '',
    'Application bundle generation failed. [1.494 seconds] - 2026-10-02T20:02:00.071Z',
    '',
  ].join('\n')

  it('cuts the bundle tables\' padding, keeping every chunk, name, size and the output location', () => {
    const out = projectStaticFilter({ command: 'npx ng build', stdout: lazy, exitCode: 0 })!
    expect(out.filter).toBe('ng-build')
    expect(out.text).toContain('Initial chunk files | Names | Raw size | Estimated transfer size\nmain-HQODSNQU.js | main | 193.46 kB | 52.36 kB\n')
    expect(out.text).toContain('\n | Initial total | 193.52 kB | 52.42 kB\n')
    expect(out.text).toContain('chunk-g6pIdGbu.js | help | 399 bytes | 399 bytes\n')
    expect(unpadded(out.text)).toBe(unpadded(lazy))
    expect(out.text.length).toBeLessThan(lazy.length * 0.8)
  })

  it('keeps budget warnings and errors verbatim (stderr merged in), and leaves other output alone', () => {
    const out = ngBuildFilter.project({ command: 'ng build --configuration production', stdout: budgetError, exitCode: 1 })!
    expect(out.startsWith(budgetError.slice(0, budgetError.indexOf('❯')))).toBe(true)
    expect(unpadded(out)).toBe(unpadded(budgetError))
    // Compiler errors only, a watch session, a dev server, colored output.
    const tsError = '✘ [ERROR] TS2322: Type \'string\' is not assignable to type \'number\'. [plugin angular-compiler]\n\n❯ Building...\n✔ Building...\nApplication bundle generation failed. [1.245 seconds] - 2026-10-02T20:02:01.757Z\n'
    expect(ngBuildFilter.project({ command: 'ng build', stdout: tsError, exitCode: 1 })).toBeUndefined()
    expect(ngBuildFilter.project({ command: 'ng build --watch', stdout: lazy, exitCode: 0 })).toBeUndefined()
    expect(ngBuildFilter.project({ command: 'ng serve', stdout: lazy, exitCode: 0 })).toBeUndefined()
    expect(ngBuildFilter.project({ command: 'ng build', stdout: `\u001b[1m${lazy}`, exitCode: 0 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['ng build', 'npx ng build --configuration production']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('ng test')).toBe(false)
  })
})

describe('pnpm outdated and pnpm list', () => {
  it('drops the rules between outdated rows and their padding, keeping every package and version', () => {
    const raw = real('pnpm-outdated.txt')
    const out = projectStaticFilter({ command: 'pnpm outdated', stdout: raw, exitCode: 1 })!
    expect(out.filter).toBe('pnpm-outdated')
    expect(out.text).toBe([
      '┌───────────┬─────────┬────────┐',
      '│ Package │ Current │ Latest │',
      '├───────────┼─────────┼────────┤',
      '│ next │ 14.2.24 │ 15.1.7 │',
      '│ react │ 18.3.1 │ 19.2.8 │',
      '│ react-dom │ 18.3.1 │ 19.2.8 │',
      '└───────────┴─────────┴────────┘',
      '[2 rule lines between table rows omitted; cell padding removed]',
      '',
    ].join('\n'))
  })

  // Synthetic, in pnpm's `outdated -r` layout, with a deprecated package.
  const recursive = [
    '┌──────────────────────────┬─────────┬────────────┬──────────────────────┐',
    '│ Package                  │ Current │ Latest     │ Dependents           │',
    '├──────────────────────────┼─────────┼────────────┼──────────────────────┤',
    '│ @types/node (dev)        │ 22.1.0  │ 24.3.0     │ api, web             │',
    '├──────────────────────────┼─────────┼────────────┼──────────────────────┤',
    '│ request                  │ 2.88.2  │ Deprecated │ legacy               │',
    '├──────────────────────────┼─────────┼────────────┼──────────────────────┤',
    '│ typescript (dev)         │ 5.6.3   │ 6.0.3      │ api, shared, web     │',
    '├──────────────────────────┼─────────┼────────────┼──────────────────────┤',
    '│ vitest (dev)             │ 3.2.4   │ 5.0.4      │ api, shared, web     │',
    '└──────────────────────────┴─────────┴────────────┴──────────────────────┘',
    '',
  ].join('\n')

  it('keeps a deprecated row verbatim, and leaves wrapped cells, other layouts and colors alone', () => {
    const out = pnpmOutdatedFilter.project({ command: 'pnpm -r outdated', stdout: recursive, exitCode: 1 })!
    expect(out).toContain('│ request                  │ 2.88.2  │ Deprecated │ legacy               │\n')
    expect(out).toContain('│ typescript (dev) │ 5.6.3 │ 6.0.3 │ api, shared, web │\n│ vitest (dev) │ 3.2.4 │ 5.0.4 │ api, shared, web │\n')
    expect(out).toContain('[3 rule lines between table rows omitted; cell padding removed]\n')
    keepsAllBut(unpadded(recursive), unpadded(out), /^├/u)
    // A wrapped cell: two row lines in a row.
    const wrapped = recursive.replace('│ legacy               │\n', '│ legacy               │\n│                          │         │            │ old-api              │\n')
    expect(pnpmOutdatedFilter.project({ command: 'pnpm outdated -r', stdout: wrapped, exitCode: 1 })).toBeUndefined()
    expect(pnpmOutdatedFilter.project({ command: 'pnpm outdated --format list', stdout: 'next\n14.2.24 => 15.1.7\n', exitCode: 1 })).toBeUndefined()
    expect(pnpmOutdatedFilter.project({ command: 'npm outdated', stdout: recursive, exitCode: 1 })).toBeUndefined()
    expect(pnpmOutdatedFilter.project({ command: 'pnpm outdated', stdout: `\u001b[31m${recursive}`, exitCode: 1 })).toBeUndefined()
  })

  it('replaces a repeated dependency subtree with a note naming the package, keeping its first listing', () => {
    const raw = real('pnpm-list-deep.txt')
    const out = projectStaticFilter({ command: 'pnpm list --depth Infinity', stdout: raw, exitCode: 0 })!
    expect(out.filter).toBe('pnpm-list')
    // Under next, react-dom is listed in full; the top-level react-dom repeats it.
    expect(out.text).toContain('├─┬ react-dom 18.3.1 peer\n│ ├─┬ loose-envify 1.4.0\n')
    expect(out.text.endsWith('react-dom 18.3.1\n[8 dependency lines omitted: the same as under react-dom 18.3.1 above]\n')).toBe(true)
    expect(raw.startsWith(out.text.slice(0, out.text.indexOf('[8 dependency lines')))).toBe(true)
  })

  it('folds a repeated subtree nested under guides, and leaves shallow lists and other commands alone', () => {
    // Synthetic, in pnpm's tree layout: babel's subtree listed twice at different depths.
    const tree = [
      'Legend: production dependency, optional only, dev only',
      '',
      'app /repo (PRIVATE)',
      '',
      'devDependencies:',
      '@babel/core 7.26.0',
      '├─┬ @babel/generator 7.26.2',
      '│ ├── @jridgewell/gen-mapping 0.3.5',
      '│ ├── jsesc 3.0.2',
      '│ └── @babel/types 7.26.0',
      '└── semver 6.3.1',
      'jest 29.7.0',
      '└─┬ @jest/core 29.7.0',
      '  ├─┬ @babel/generator 7.26.2',
      '  │ ├── @jridgewell/gen-mapping 0.3.5',
      '  │ ├── jsesc 3.0.2',
      '  │ └── @babel/types 7.26.0',
      '  └── chalk 4.1.2',
      '',
    ].join('\n')
    const out = pnpmListFilter.project({ command: 'pnpm ls --depth 3', stdout: tree, exitCode: 0 })!
    expect(out).toContain('└─┬ @jest/core 29.7.0\n  ├─┬ @babel/generator 7.26.2\n  │ [3 dependency lines omitted: the same as under @babel/generator 7.26.2 above]\n  └── chalk 4.1.2\n')
    keepsAllBut(tree, out, /^ {2}│ /u)
    // A shallow list repeats nothing.
    const shallow = 'Legend: production dependency, optional only, dev only\n\napp /repo (PRIVATE)\n\ndependencies:\nnext 14.2.24\nreact 18.3.1\n'
    expect(pnpmListFilter.project({ command: 'pnpm list', stdout: shallow, exitCode: 0 })).toBeUndefined()
    expect(pnpmListFilter.project({ command: 'pnpm why @babel/generator', stdout: tree, exitCode: 0 })).toBeUndefined()
    expect(pnpmListFilter.project({ command: 'pnpm list', stdout: tree.replace('Legend', 'Key'), exitCode: 0 })).toBeUndefined()
    // A repeat that mentions a problem stays whole.
    const deprecated = tree.replace('  │ ├── jsesc 3.0.2', '  │ ├── jsesc 3.0.2 deprecated')
    expect(pnpmListFilter.project({ command: 'pnpm list', stdout: deprecated, exitCode: 0 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['pnpm outdated', 'pnpm -r outdated', 'pnpm list --depth 2', 'pnpm ls', 'pnpm -r list']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('pnpm audit')).toBe(false)
  })
})

describe('turbo', () => {
  // Synthetic, in Turborepo 2's stream layout without a terminal (`package:task: ` prefixes).
  const run = [
    'turbo 2.1.3',
    '',
    '• Packages in scope: @repo/eslint-config, @repo/typescript-config, @repo/ui, docs, web',
    '• Running build in 5 packages',
    '• Remote caching disabled',
    '@repo/ui:build: cache miss, executing 4b8e1a1d2b3e8b0c',
    '@repo/ui:build: ',
    '@repo/ui:build: > @repo/ui@0.0.0 build /repo/packages/ui',
    '@repo/ui:build: > tsc',
    '@repo/ui:build: ',
    'docs:build: cache hit, replaying logs 9f1c3b2a7d8e6f5a',
    'web:build: cache miss, executing 1d8f8e7e5d7a1b2c',
    'docs:build: ',
    'web:build: ',
    'docs:build: > docs@0.1.0 build /repo/apps/docs',
    'docs:build: > next build',
    'docs:build: ',
    'docs:build:   ▲ Next.js 14.2.3',
    'docs:build:  ✓ Compiled successfully',
    'web:build: > web@0.1.0 build /repo/apps/web',
    'web:build: > next build',
    'web:build: ',
    'web:build:   ▲ Next.js 14.2.3',
    'web:build: ',
    'web:build:    Creating an optimized production build ...',
    'web:build: Failed to compile.',
    'web:build: ./app/page.tsx:3:10',
    'web:build: Type error: Cannot find name \'missing\'.',
    'web:build:  ERROR  command finished with error: command (/repo/apps/web) /usr/local/bin/pnpm run build exited (1)',
    'web#build: command (/repo/apps/web) /usr/local/bin/pnpm run build exited (1)',
    '',
    ' Tasks:    2 successful, 3 total',
    'Cached:    1 cached, 3 total',
    '  Time:    21.302s ',
    'Failed:    web#build',
    '',
    ' ERROR  run failed: command  exited (1)',
    '',
  ].join('\n')

  it('lists runs of one task\'s lines under one header, every line kept after its prefix', () => {
    const out = projectStaticFilter({ command: 'turbo run build', stdout: run, exitCode: 1 })!
    expect(out.filter).toBe('turbo')
    expect(out.text).toContain('• Remote caching disabled\n[lines from @repo/ui:build; every line retained]\n  cache miss, executing 4b8e1a1d2b3e8b0c\n\n  > @repo/ui@0.0.0 build /repo/packages/ui\n  > tsc\n\n')
    // Interleaved lines stay as they are; a run of one task gets its header again.
    expect(out.text).toContain('docs:build: cache hit, replaying logs 9f1c3b2a7d8e6f5a\nweb:build: cache miss, executing 1d8f8e7e5d7a1b2c\ndocs:build: \nweb:build: \n[lines from docs:build; every line retained]\n')
    // A line that may report a problem keeps its prefix and ends the run; so does the one between two of them.
    expect(out.text).toContain('[lines from web:build; every line retained]\n  > web@0.1.0 build /repo/apps/web\n  > next build\n\n    ▲ Next.js 14.2.3\n\n     Creating an optimized production build ...\n'
      + 'web:build: Failed to compile.\nweb:build: ./app/page.tsx:3:10\nweb:build: Type error: Cannot find name \'missing\'.\nweb:build:  ERROR  command finished')
    expect(out.text).toContain('web#build: command (/repo/apps/web) /usr/local/bin/pnpm run build exited (1)\n\n Tasks:    2 successful, 3 total\n')
    // Every line's text after its task prefix is still there, in order.
    keepsAllBut(run.replace(/^(?:@repo\/ui|docs|web):build: ?/gmu, ''), out.text, /^$/u)
    expect(out.text.length).toBeLessThan(run.length)
  })

  it('groups only prefixes a cache-status line announces and runs whose prefixes cost more than a header', () => {
    const short = 'web:build: cache miss, executing 1d8f8e7e5d7a1b2c\nweb:build: > tsc\nweb:build: \n\n Tasks:    1 successful, 1 total\n'
    expect(turboFilter.project({ command: 'turbo build', stdout: short, exitCode: 0 })).toBeUndefined()
    const unannounced = run.replace(/^(\S+): cache (?:hit|miss)[^\n]*\n/gmu, '')
    expect(turboFilter.project({ command: 'turbo build', stdout: unannounced, exitCode: 1 })).toBeUndefined()
    expect(turboFilter.project({ command: 'turbo build', stdout: run.replace(' Tasks:', ' Jobs:'), exitCode: 1 })).toBeUndefined()
    expect(turboFilter.project({ command: 'turbo login', stdout: run, exitCode: 0 })).toBeUndefined()
    expect(turboFilter.project({ command: 'turbo run build', stdout: `\u001b[2m${run}`, exitCode: 0 })).toBeUndefined()
    expect(turboFilter.project({ command: 'nx run-many -t build', stdout: run, exitCode: 0 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['turbo run build', 'turbo build', 'npx turbo run lint test', 'pnpm turbo build']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('turbo prune web')).toBe(false)
  })
})

describe('prisma migrate', () => {
  const ids = ['20240101000000_init', '20240115093000_add_sessions', '20240201120000_add_posts', '20240210080000_post_index']
  // Synthetic, in Prisma 5's `migrate deploy` layout.
  const deploy = [
    'Environment variables loaded from .env',
    'Prisma schema loaded from prisma/schema.prisma',
    'Datasource "db": PostgreSQL database "app", schema "public" at "localhost:5432"',
    '',
    '4 migrations found in prisma/migrations',
    '',
    ...ids.map(id => `Applying migration \`${id}\``),
    '',
    'The following migration(s) have been applied:',
    '',
    'migrations/',
    ...ids.flatMap(id => [`  └─ ${id}/`, '    └─ migration.sql']),
    '      ',
    'All migrations have been successfully applied.',
    '',
  ].join('\n')

  it('replaces the migrations tree that repeats the applied list with a count, keeping every Applying line', () => {
    const out = projectStaticFilter({ command: 'npx prisma migrate deploy', stdout: deploy, exitCode: 0 })!
    expect(out.filter).toBe('prisma-migrate')
    expect(out.text).toContain('The following migration(s) have been applied:\n\n[migrations/ tree omitted: 9 lines naming the 4 migrations applied above, each with its migration.sql]\n      \nAll migrations')
    for (const id of ids) expect(out.text).toContain(`Applying migration \`${id}\`\n`)
    keepsAllBut(deploy, out.text, /^(?:migrations\/| {2}└─ | {4}└─ )/u)
  })

  it('leaves a tree that differs from the applied list, a single migration and other subcommands alone', () => {
    // `migrate dev` applied pending migrations but its tree lists only the new one.
    const dev = deploy.replace(/migrations\/\n[\s\S]*?\n {6}\n/u, `migrations/\n  └─ ${ids[3]}/\n    └─ migration.sql\n      \n`)
    expect(prismaMigrateFilter.project({ command: 'npx prisma migrate dev', stdout: dev, exitCode: 0 })).toBeUndefined()
    const extraFile = deploy.replace(`  └─ ${ids[3]}/\n    └─ migration.sql\n`, `  └─ ${ids[3]}/\n    └─ migration.sql\n    └─ README.md\n`)
    expect(prismaMigrateFilter.project({ command: 'npx prisma migrate deploy', stdout: extraFile, exitCode: 0 })).toBeUndefined()
    const one = `Applying migration \`${ids[0]}\`\n\nThe following migration(s) have been applied:\n\nmigrations/\n  └─ ${ids[0]}/\n    └─ migration.sql\n`
    expect(prismaMigrateFilter.project({ command: 'npx prisma migrate deploy', stdout: one, exitCode: 0 })).toBeUndefined()
    expect(prismaMigrateFilter.project({ command: 'npx prisma migrate status', stdout: deploy, exitCode: 0 })).toBeUndefined()
    expect(prismaMigrateFilter.project({ command: 'npx prisma migrate deploy', stdout: deploy, exitCode: 1 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['npx prisma migrate deploy', 'npx prisma migrate dev --name add_posts', 'prisma migrate reset --force', 'pnpm prisma migrate deploy']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('npx prisma migrate status')).toBe(false)
  })
})

describe('prettier', () => {
  it('folds files --write left unchanged, keeping every file it rewrote', () => {
    const raw = real('prettier-write.txt')
    const out = projectStaticFilter({ command: 'npx prettier --write .', stdout: raw, exitCode: 0 })!
    expect(out.filter).toBe('prettier')
    expect(out.text).toBe('package-lock.json 13ms (unchanged)\npackage.json 1ms\nsrc/bad.js 5ms\n[7 unchanged files omitted]\nsrc/components/ugly.js 1ms\n')
    const broken = raw.replace('src/components/c.js 1ms (unchanged)\n', '[error] src/components/c.js: SyntaxError: Unexpected token (1:7)\n')
    keepsAllBut(broken, prettierFilter.project({ command: 'prettier -w src', stdout: broken, exitCode: 2 })!, /\(unchanged\)$/u)
  })

  it('leaves --check (every line is a finding or the summary) and other output alone', () => {
    expect(projectStaticFilter({ command: 'npx prettier --check .', stdout: real('prettier-check.txt'), exitCode: 1 })).toBeUndefined()
    expect(prettierFilter.project({ command: 'npx prettier --check .', stdout: real('prettier-write.txt'), exitCode: 0 })).toBeUndefined()
    expect(mayProject('npx prettier --write .')).toBe(true)
    expect(mayProject('npx prettier --check .')).toBe(false)
  })
})

describe('linters without a safe gain', () => {
  it('pass biome, oxlint and markdownlint reports through: every line is a finding, its frame or the summary', () => {
    // Adapted from RTK's biome, oxlint and markdownlint filter tests (Apache-2.0, see third-party/rtk).
    const biome = 'Checked 42 files in 0.5s\n\nsrc/app.tsx:5:3 lint/suspicious/noExplicitAny ━━━━━━━━━━━━━━━━━━━━\n  × Unexpected any. Specify a different type.\n  3 │ interface Props {\n  4 │   data: any;\n  5 │         ^^^\n\nFound 1 error.\n'
    const oxlint = '  × eslint(no-console): Unexpected console statement.\n   ╭─[src/app.ts:5:3]\n 5 │   console.log("debug");\n   │   ^^^^^^^^^^^\n   ╰────\n\nFound 1 warning on 1 file.\nFinished in 12ms on 100 files.\n'
    const markdownlint = 'README.md:1:1 MD041/first-line-heading/first-line-h1 First line in file should be a top level heading\nREADME.md:10:1 MD022/blanks-around-headings Headings should be surrounded by blank lines\n'
    expect(projectStaticFilter({ command: 'npx biome check .', stdout: biome, exitCode: 1 })).toBeUndefined()
    expect(projectStaticFilter({ command: 'npx oxlint', stdout: oxlint, exitCode: 1 })).toBeUndefined()
    expect(projectStaticFilter({ command: 'npx markdownlint "**/*.md"', stdout: markdownlint, exitCode: 1 })).toBeUndefined()
  })
})
