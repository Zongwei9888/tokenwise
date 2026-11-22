import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectStaticFilter } from '../src/filters/index.ts'
import { gitDiffFilter } from '../src/filters/git-diff.ts'
import { gitStatusFilter } from '../src/filters/git-status.ts'
import { gitLsTreeFilter, gitStashListFilter } from '../src/filters/git-listings.ts'
import { ghFilter } from '../src/filters/gh.ts'
import { gtFilter, yadmFilter } from '../src/filters/git-wrappers.ts'
import { diffFilter, jjFilter } from '../src/filters/unified-diff.ts'
import { mayProject } from '../src/economy.ts'
import { DEFAULT_FILTER_OPTIONS } from '../src/filter-options.ts'

/**
 * Real outputs, captured on macOS on 2026-11-22 (git 2.49, Apple diff) in a
 * throwaway repository under $TMPDIR (user `demo`); `ls-tree-core.txt` is
 * `git ls-tree -r --name-only HEAD packages/core` of this repository at 73ddffe.
 */
const fixture = (name: string) => readFileSync(new URL(`fixtures/vcs/${name}`, import.meta.url), 'utf8')
/** Adapted from RTK's tests/fixtures/diff (Apache-2.0, see third-party/rtk). */
const rtkDiff = (name: string) => readFileSync(new URL(`fixtures/vcs/rtk/${name}`, import.meta.url), 'utf8')

/** Every line of `raw` that `removed` does not match appears in `text`, in order. */
function keepsAllBut(raw: string, text: string, removed: RegExp) {
  let at = 0
  for (const line of raw.split('\n').filter(line => line !== '' && !removed.test(line))) {
    const found = text.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(0)
    at = found + line.length
  }
}

describe('git stash list', () => {
  const stashes = fixture('stash-list.txt')

  it('keeps the first of a run of stashes with one description and counts the rest by index', () => {
    const projected = gitStashListFilter.project({ command: 'git stash list', stdout: stashes, exitCode: 0 })!
    expect(projected).toBe([
      'stash@{0}: On feature/login: flaky test experiment',
      'stash@{1}: WIP on feature/login: 9e14836 Render login form',
      'stash@{2}: WIP on feature/login: 9e14836 Render login form',
      'stash@{3}: On main: readme wording',
      'stash@{4}: WIP on main: d06ce23 Fix parse of empty input',
      '[4 stashes omitted (stash@{5} to stash@{8}): same description as stash@{4}]',
      '',
    ].join('\n'))
    keepsAllBut(stashes, projected, /^stash@\{[5-8]\}: /u)
    expect(projectStaticFilter({ command: 'git stash list', stdout: stashes, exitCode: 0 })?.filter).toBe('git-stash-list')
  })

  it('never folds stashes that mention a problem, nor short ones a note would not shorten', () => {
    const conflict = Array.from({ length: 4 }, (_, i) => `stash@{${i}}: WIP on main: d06ce23 Resolve merge conflict in parser`).join('\n') + '\n'
    expect(gitStashListFilter.project({ command: 'git stash list', stdout: conflict, exitCode: 0 })).toBeUndefined()
    const short = Array.from({ length: 3 }, (_, i) => `stash@{${i}}: On main: x`).join('\n') + '\n'
    expect(gitStashListFilter.project({ command: 'git stash list', stdout: short, exitCode: 0 })).toBeUndefined()
  })

  it('leaves other layouts, other subcommands and unknown lines alone', () => {
    for (const command of ['git stash list --stat', 'git stash list -p', 'git stash show', 'git log -g refs/stash', 'git stash']) {
      expect(gitStashListFilter.project({ command, stdout: stashes, exitCode: 0 }), command).toBeUndefined()
    }
    expect(gitStashListFilter.project({ command: 'git stash list', stdout: `\u001b[33m${stashes}`, exitCode: 0 })).toBeUndefined()
    // Not numbered from 0 (a slice), or a line that is not a stash row.
    expect(gitStashListFilter.project({ command: 'git stash list', stdout: stashes.split('\n').slice(1).join('\n'), exitCode: 0 })).toBeUndefined()
    expect(gitStashListFilter.project({ command: 'git stash list', stdout: `${stashes}warning: something odd\n`, exitCode: 0 })).toBeUndefined()
  })
})

describe('git ls-tree', () => {
  const listing = fixture('ls-tree-core.txt')
  /** Read the grouped listing back into git's lines. */
  const unfold = (text: string) => {
    let directory = ''
    return text.split('\n').filter(line => line !== '').map(line => {
      const header = /^\[paths in (.+); original order\]$/u.exec(line)
      if (header) { directory = header[1]!; return undefined }
      if (line.startsWith('  ')) return directory + line.slice(2)
      directory = ''
      return line
    }).filter(line => line !== undefined).join('\n') + '\n'
  }

  it('groups consecutive paths in one directory under one header, every path kept in order', () => {
    const projected = gitLsTreeFilter.project({ command: 'git ls-tree -r --name-only HEAD packages/core', stdout: listing, exitCode: 0 })!
    expect(projected).toContain('[paths in packages/core/src/filters/; original order]\n  cargo-build.ts\n')
    expect(unfold(projected)).toBe(listing)
    expect(projected.length).toBeLessThan(listing.length * 0.7)
    expect(projectStaticFilter({ command: 'git ls-tree --name-status -r HEAD', stdout: listing, exitCode: 0 })?.filter).toBe('git-ls-tree')
  })

  it('leaves object rows, other options and listings that would not shrink alone', () => {
    const rows = listing.split('\n').filter(Boolean).map(path => `100644 blob 66371994ba861d1b15030ae37f89c686ea2912e9\t${path}`).join('\n') + '\n'
    expect(gitLsTreeFilter.project({ command: 'git ls-tree -r HEAD', stdout: rows, exitCode: 0 })).toBeUndefined()
    expect(gitLsTreeFilter.project({ command: 'git ls-tree -r --name-only HEAD', stdout: rows, exitCode: 0 })).toBeUndefined()
    for (const command of ['git ls-tree -r -l --name-only HEAD', 'git ls-tree -z --name-only HEAD', 'git ls-tree --format=%(path) HEAD', 'git ls-files', 'git ls-tree --name-only HEAD | head']) {
      expect(gitLsTreeFilter.project({ command, stdout: listing, exitCode: 0 }), command).toBeUndefined()
    }
    expect(gitLsTreeFilter.project({ command: 'git ls-tree -r --name-only HEAD', stdout: `\u001b[1m${listing}`, exitCode: 0 })).toBeUndefined()
    expect(gitLsTreeFilter.project({ command: 'git ls-tree -r --name-only HEAD', stdout: listing, exitCode: 128 })).toBeUndefined()
    // Three paths under src/cmds/: the header costs more than the shared directory.
    const small = 'README.md\ndocs/intro.md\npackage.json\nsrc/cmds/alpha.ts\nsrc/cmds/beta.ts\nsrc/cmds/gamma.ts\nsrc/core/parse.ts\n'
    expect(gitLsTreeFilter.project({ command: 'git ls-tree -r --name-only HEAD', stdout: small, exitCode: 0 })).toBeUndefined()
  })
})

describe('gh', () => {
  /**
   * Synthetic, in gh 2.x's non-TTY layout for `gh pr checks` (pkg/cmd/pr/checks:
   * name, bucket, elapsed, link, description, tab-separated, no header or summary).
   */
  const job = (run: number, id: number) => `https://github.com/acme/widgets/actions/runs/${run}/job/${id}`
  const checks = [
    `build (ubuntu-latest, 20.x)\tpass\t1m23s\t${job(11823456789, 32945678901)}\t`,
    `build (ubuntu-latest, 22.x)\tpass\t1m19s\t${job(11823456789, 32945678902)}\t`,
    `build (macos-latest, 22.x)\tpass\t2m41s\t${job(11823456789, 32945678903)}\t`,
    `lint\tpass\t38s\t${job(11823456789, 32945678904)}\t`,
    `test (unit)\tfail\t3m2s\t${job(11823456789, 32945678905)}\t`,
    `test (e2e)\tpending\t0\t${job(11823456789, 32945678906)}\t`,
    `docs\tskipping\t0\t${job(11823456790, 32945678907)}\t`,
    'codecov/patch\tpass\t0\thttps://app.codecov.io/gh/acme/widgets/pull/42\t82.35% of diff hit (target 80.00%)',
    '',
  ].join('\n')

  it('pr checks: writes the shared job link prefix once; failed checks keep their whole link', () => {
    const projected = ghFilter.project({ command: 'gh pr checks 42', stdout: checks, exitCode: 1 })!
    expect(projected.split('\n')[0]).toBe('[runs/ in the links below stands for https://github.com/acme/widgets/actions/runs/]')
    expect(projected).toContain('lint\tpass\t38s\truns/11823456789/job/32945678904\t\n')
    expect(projected).toContain(`test (unit)\tfail\t3m2s\t${job(11823456789, 32945678905)}\t\n`)
    expect(projected).toContain('codecov/patch\tpass\t0\thttps://app.codecov.io/gh/acme/widgets/pull/42\t82.35% of diff hit (target 80.00%)\n')
    // Lossless: the prefix put back gives gh's rows.
    expect(projected.split('\n').slice(1).join('\n').replaceAll('\truns/', '\thttps://github.com/acme/widgets/actions/runs/')).toBe(checks)
    expect(projected.length).toBeLessThan(checks.length * 0.85)
    expect(projectStaticFilter({ command: 'gh pr checks', stdout: checks, exitCode: 8 })?.filter).toBe('gh')
  })

  // Adapted from RTK's tests/gh_pr_checks_failure_test.rs (Apache-2.0, see third-party/rtk).
  it('pr checks: RTK\'s rows link outside GitHub Actions, so they pass through', () => {
    const rtk = 'doc review\tfail\t13s\thttps://example.test/job/1\t\nfmt\tfail\t7s\thttps://example.test/job/2\t\nAnalyze (rust)\tpass\t4m17s\thttps://example.test/job/3\t\ncheck\tpass\t5s\thttps://example.test/job/4\t\n'
    expect(ghFilter.project({ command: 'gh pr checks 123', stdout: rtk, exitCode: 1 })).toBeUndefined()
  })

  /** Synthetic, in gh 2.x's non-TTY `gh pr view` layout (printRawPrPreview): `field:\tvalue` rows, `--`, the body. */
  const prView = [
    'title:\tAdd retry to the upload client',
    'state:\tOPEN',
    'author:\toctocat',
    'labels:\tenhancement',
    'assignees:\toctocat',
    'reviewers:\thubot (Requested)',
    'projects:\t',
    'milestone:\t',
    'number:\t42',
    'url:\thttps://github.com/acme/widgets/pull/42',
    'additions:\t120',
    'deletions:\t14',
    'auto-merge:\tdisabled',
    '--',
    '<!--',
    'Thanks for sending a pull request! Before you submit, please read',
    'the contributing guide and make sure the checklist below is complete.',
    '-->',
    '',
    '## Summary',
    '',
    'Retries uploads up to three times with backoff.',
    '',
    '<!-- Link the issue this pull request closes, e.g. "Closes #123". -->',
    'Closes #41',
    '',
    '## Checklist',
    '',
    '<!-- Mark items with [x]. Remove the items that do not apply. -->',
    '- [x] Tests added',
    '- [x] Docs updated',
    '',
    '```html',
    '<!-- This comment is part of the code sample, so it stays. -->',
    '<p>retrying</p>',
    '```',
    '',
    '<!-- If CI fails on this change, paste the error output here. -->',
    'Seen on <!-- a comment inside a line stays as it is, however long it happens to be -->Linux only.',
    '',
  ].join('\n')
  const COMMENT = /^<!--$|^Thanks for sending|^the contributing guide|^-->$|^<!-- (?:Link the issue|Mark items)/u

  it('pr view: folds whole-line HTML comments of the body into counts, keeps metadata, code blocks and problem comments', () => {
    const projected = ghFilter.project({ command: 'gh pr view 42', stdout: prView, exitCode: 0 })!
    expect(projected).toContain('--\n[4 HTML comment lines omitted]\n\n## Summary')
    expect(projected).toContain('\n[1 HTML comment line omitted]\nCloses #41\n')
    expect(projected).toContain('\n[1 HTML comment line omitted]\n- [x] Tests added')
    expect(projected).toContain('<!-- This comment is part of the code sample, so it stays. -->')
    expect(projected).toContain('<!-- If CI fails on this change, paste the error output here. -->')
    keepsAllBut(prView, projected, COMMENT)
    expect(projected).not.toMatch(/Thanks for sending|Link the issue|Mark items/u)
    // Bodies edited on github.com end their lines with CRLF.
    const [head, body] = [prView.slice(0, prView.indexOf('--\n') + 3), prView.slice(prView.indexOf('--\n') + 3)]
    const crlf = head + body.replaceAll('\n', '\r\n')
    const crlfProjected = ghFilter.project({ command: 'gh pr view', stdout: crlf, exitCode: 0 })!
    expect(crlfProjected).toContain('--\n[4 HTML comment lines omitted]\n\r\n## Summary\r\n')
  })

  it('issue view: the same body treatment', () => {
    /** Synthetic, in gh 2.x's non-TTY `gh issue view` layout (printRawIssuePreview). */
    const issue = 'title:\tUpload fails on files over 2 GB\nstate:\tOPEN\nauthor:\thubot\nlabels:\tbug\ncomments:\t3\nassignees:\t\nprojects:\t\nmilestone:\tv2.4\nnumber:\t41\n--\n'
      + '<!--\nBefore opening an issue, search the existing ones\nand include the version you are running.\n-->\n### Steps to reproduce\n\n1. Upload a 3 GB file\n2. Wait\n'
    const projected = ghFilter.project({ command: 'gh issue view 41 -R acme/widgets', stdout: issue, exitCode: 0 })!
    expect(projected).toBe('title:\tUpload fails on files over 2 GB\nstate:\tOPEN\nauthor:\thubot\nlabels:\tbug\ncomments:\t3\nassignees:\t\nprojects:\t\nmilestone:\tv2.4\nnumber:\t41\n--\n'
      + '[4 HTML comment lines omitted]\n### Steps to reproduce\n\n1. Upload a 3 GB file\n2. Wait\n')
  })

  it('leaves other layouts, subcommands, tools and colored output alone', () => {
    for (const command of ['gh pr view 42 --json title,body', 'gh pr view 42 --comments', 'gh pr view -w', 'gh pr checks --watch', 'gh pr checks --json name,state', 'gh run list', 'gh pr list', 'gh api repos/acme/widgets/pulls/42', 'glab mr view 42']) {
      expect(ghFilter.project({ command, stdout: command.includes('checks') ? checks : prView, exitCode: 0 }), command).toBeUndefined()
    }
    expect(ghFilter.project({ command: 'gh pr checks', stdout: checks, exitCode: 2 })).toBeUndefined()
    expect(ghFilter.project({ command: 'gh pr view', stdout: prView, exitCode: 1 })).toBeUndefined()
    expect(ghFilter.project({ command: 'gh pr checks', stdout: `\u001b[32m✓\u001b[0m ${checks}`, exitCode: 0 })).toBeUndefined()
    // The TTY layout (title line, no field rows) or a body with no comment to fold.
    expect(ghFilter.project({ command: 'gh pr view', stdout: 'Add retry to the upload client acme/widgets#42\nOpen • octocat wants to merge 1 commit into main from retry\n', exitCode: 0 })).toBeUndefined()
    expect(ghFilter.project({ command: 'gh issue view 1', stdout: 'title:\tx\nstate:\tOPEN\n--\nNo comments here.\n', exitCode: 0 })).toBeUndefined()
    // An unclosed comment, or one with text after it on its last line, is not a whole-line comment.
    expect(ghFilter.project({ command: 'gh issue view 1', stdout: 'title:\tx\n--\n<!-- an unclosed comment that runs to the end of the body\nand more\n', exitCode: 0 })).toBeUndefined()
    expect(ghFilter.project({ command: 'gh issue view 1', stdout: 'title:\tx\n--\n<!-- a comment followed on its last line\nby text --> that is shown\n', exitCode: 0 })).toBeUndefined()
  })
})

describe('gt and yadm (git underneath)', () => {
  const status = fixture('git-status.txt')
  const patch = fixture('git-diff.txt')

  it('gt status reads as git status', () => {
    const projected = gtFilter.project({ command: 'gt status', stdout: status, exitCode: 0 })!
    expect(projected).toBe(gitStatusFilter.project({ command: 'git status', stdout: status, exitCode: 0 }))
    expect(projected).toContain(' M src/cmds/alpha.ts\n')
    expect(projectStaticFilter({ command: 'gt status', stdout: status, exitCode: 0 })?.filter).toBe('gt')
    expect(gtFilter.project({ command: 'gt log', stdout: status, exitCode: 0 })).toBeUndefined()
    expect(gtFilter.project({ command: 'gt status --short', stdout: status, exitCode: 0 })).toBeUndefined()
    expect(gtFilter.project({ command: 'gt status', stdout: `\u001b[1m${status}`, exitCode: 0 })).toBeUndefined()
    expect(gtFilter.project({ command: 'git status', stdout: status, exitCode: 0 })).toBeUndefined()
  })

  it('yadm status, diff and stash list read as git\'s', () => {
    expect(yadmFilter.project({ command: 'yadm status', stdout: status, exitCode: 0 })).toBe(gitStatusFilter.project({ command: 'git status', stdout: status, exitCode: 0 }))
    const diffed = yadmFilter.project({ command: 'yadm diff', stdout: patch, exitCode: 0 })!
    expect(diffed).toBe(gitDiffFilter.project({ command: 'git diff', stdout: patch, exitCode: 0 }))
    expect(diffed).toContain('  ... (51 lines truncated)\n')
    // A word that needs quoting is passed on quoted: `HEAD~1` reaches git-diff as a revision.
    expect(yadmFilter.project({ command: 'yadm diff "HEAD~1"', stdout: patch, exitCode: 0 })).toBe(diffed)
    expect(yadmFilter.project({ command: 'yadm stash list', stdout: fixture('stash-list.txt'), exitCode: 0 })).toContain('[4 stashes omitted (stash@{5} to stash@{8})')
    expect(projectStaticFilter({ command: 'yadm diff', stdout: patch, exitCode: 0 })?.filter).toBe('yadm')
  })

  it('yadm passes through what the git filters would, and its own commands', () => {
    // Limited to a path, the patch stays whole, as with git diff -- <path>.
    expect(yadmFilter.project({ command: 'yadm diff -- .vimrc', stdout: patch, exitCode: 0 })).toBeUndefined()
    expect(yadmFilter.project({ command: 'yadm diff --stat', stdout: patch, exitCode: 0 })).toBeUndefined()
    for (const command of ['yadm encrypt', 'yadm list -a', 'yadm bootstrap', 'yadm clone https://example.test/dotfiles.git', 'yadm stash show']) {
      expect(yadmFilter.project({ command, stdout: patch, exitCode: 0 }), command).toBeUndefined()
    }
    expect(yadmFilter.project({ command: 'yadm status', stdout: `\u001b[32m${status}`, exitCode: 0 })).toBeUndefined()
    // Adapted from RTK's src/filters/yadm.toml (Apache-2.0, see third-party/rtk): a one-line answer has nothing to remove.
    expect(yadmFilter.project({ command: 'yadm pull', stdout: 'Already up to date.\n', exitCode: 0 })).toBeUndefined()
  })
})

describe('jj', () => {
  /** Synthetic: `jj diff --git` prints git's patch layout (jj abbreviates `index` hashes to 10 digits). */
  const added = Array.from({ length: 127 }, (_, i) => `+pub fn step_${i + 1}() -> u32 { ${i + 1} }`)
  const patch = ['diff --git a/src/lib.rs b/src/lib.rs', 'index 1b2c3d4e5f..6a7b8c9d0e 100644', '--- a/src/lib.rs', '+++ b/src/lib.rs',
    '@@ -1,3 +1,130 @@', ' pub mod config;', ' pub mod error;', ...added, ' pub mod util;',
    'diff --git a/README.md b/README.md', 'index 0a1b2c3d4e..5f6a7b8c9d 100644', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-# widgets', '+# Widgets', ''].join('\n')
  const TRUNCATED = /^\+pub fn step_(?:49|[5-6]\d|7[0-8])\(\)/u

  it('previews oversized hunks of jj diff --git like git diff', () => {
    const projected = jjFilter.project({ command: 'jj diff --git -r @-', stdout: patch, exitCode: 0 })!
    expect(projected).toContain('  ... (30 lines truncated)\n')
    expect(projected).toContain('[diff sample; omitted lines are counted above; not an applicable patch]\n')
    keepsAllBut(patch, projected, TRUNCATED)
    expect(projected).not.toContain('step_50()')
    expect(projectStaticFilter({ command: 'jj diff --git', stdout: patch, exitCode: 0 })?.filter).toBe('jj')
  })

  it('leaves paths, other layouts and other jj commands alone', () => {
    for (const command of ['jj diff --git src/lib.rs', 'jj diff', 'jj diff --stat --git', 'jj show --git', 'jj log', 'jj status', 'git diff --git']) {
      expect(jjFilter.project({ command, stdout: patch, exitCode: 0 }), command).toBeUndefined()
    }
    expect(jjFilter.project({ command: 'jj diff --git', stdout: patch, exitCode: 1 })).toBeUndefined()
    expect(jjFilter.project({ command: 'jj diff --git --color=always', stdout: `\u001b[1m${patch}`, exitCode: 0 })).toBeUndefined()
    // Adapted from RTK's src/filters/jj.toml (Apache-2.0, see third-party/rtk): a log graph is not a patch.
    const log = '@  qpvuntsm patrick@example.com 2026-03-10 12:00 abc123\n│  feat: add new feature\n◉  zzzzzzzz root()\n\nWorking copy now at: qpvuntsm abc123 feat: add new feature\nHint: use `jj log` to see the full history\n'
    expect(jjFilter.project({ command: 'jj log', stdout: log, exitCode: 0 })).toBeUndefined()
    expect(projectStaticFilter({ command: 'jj log', stdout: log, exitCode: 0 })).toBeUndefined()
  })
})

describe('diff', () => {
  const tree = fixture('diff-ru.txt')
  /** The middle 26 rows of src/big.txt's 126-row hunk. */
  const TRUNCATED = /^-line (?:7[89]|8\d|90): |^\+line (?:3[1-9]|4[0-3]): /u

  it('previews oversized hunks of a directory diff and keeps every header and file-level line', () => {
    const projected = diffFilter.project({ command: 'diff -ru a b', stdout: tree, exitCode: 1 })!
    expect(projected).toContain('  ... (26 lines truncated)\n')
    expect(projected).toContain('  +60 -60\ndiff -ru a/src/small.txt b/src/small.txt\n')
    expect(projected).toContain('\\ No newline at end of file\n  +1 -1\nOnly in a: only-a\n')
    expect(projected.endsWith('Only in b: sub\n[diff sample; omitted lines are counted above; not an applicable patch]\n')).toBe(true)
    keepsAllBut(tree, projected, TRUNCATED)
    expect(projected).not.toContain('-line 80: ')
    expect(projectStaticFilter({ command: 'diff -Naur a b', stdout: tree, exitCode: 1 })?.filter).toBe('diff')
  })

  // Adapted from RTK's tests/fixtures/diff (Apache-2.0, see third-party/rtk): GNU diff layouts.
  it('reads GNU diff\'s layout and file-level lines (RTK\'s fixtures), previewing nothing when hunks are short', () => {
    const gnu = rtkDiff('diff_ru_raw.txt')
    expect(diffFilter.project({ command: 'diff -ru a b', stdout: gnu, exitCode: 1 })).toBeUndefined()
    const narrow = { ...DEFAULT_FILTER_OPTIONS, 'git-diff': { maxHunkLines: 2 } }
    const projected = diffFilter.project({ command: 'diff -ru a b', stdout: gnu, exitCode: 1, options: narrow })!
    expect(projected).toContain('Binary files a/img.bin and b/img.bin differ\nOnly in b: newfile.txt\ndiff -ru a/sub/deep.txt b/sub/deep.txt\n')
    // The middle three rows of f1.txt's five-row hunk.
    keepsAllBut(gnu, projected, /^(?:-beta|\+BETA| gamma)$/u)
    expect(projected).toContain(' alpha\n  ... (3 lines truncated)\n+delta\n')
    for (const name of ['diff_ru_fifo_symlink_raw.txt', 'diff_ru_quoted_312_c_raw.txt']) {
      const raw = rtkDiff(name)
      expect(diffFilter.project({ command: 'diff -ru g1 g2', stdout: raw, exitCode: 1, options: narrow }), name).toContain('lines truncated')
    }
    // French messages (`Seulement dans …`) are not lines this filter knows.
    expect(diffFilter.project({ command: 'diff -ru a b', stdout: rtkDiff('diff_ru_fr_raw.txt'), exitCode: 1, options: narrow })).toBeUndefined()
  })

  it('leaves two-file diffs, other formats, other tools and colored output alone', () => {
    // Two files the agent named: no section headers, the patch stays whole.
    const twoFiles = tree.slice(tree.indexOf('--- a/src/big.txt'), tree.indexOf('diff -ru a/src/small.txt'))
    expect(diffFilter.project({ command: 'diff -u a/src/big.txt b/src/big.txt', stdout: twoFiles, exitCode: 1 })).toBeUndefined()
    for (const command of ['diff -r a b', 'diff -q -r a b', 'diff -ruq a b', 'diff -y a b', 'diff -c a b', 'colordiff -ru a b', 'git diff --no-index a b']) {
      expect(diffFilter.project({ command, stdout: tree, exitCode: 1 }), command).toBeUndefined()
    }
    expect(diffFilter.project({ command: 'diff -ru a b', stdout: tree, exitCode: 2 })).toBeUndefined()
    expect(diffFilter.project({ command: 'diff -ru --color=always a b', stdout: `\u001b[1m${tree}`, exitCode: 1 })).toBeUndefined()
    // A line that is neither patch nor a file-level message (an error mixed in by 2>&1).
    expect(diffFilter.project({ command: 'diff -ru a b 2>&1', stdout: `diff: a/x: Permission denied\n${tree}`, exitCode: 1 })).toBeUndefined()
  })
})

describe('routing', () => {
  it('claims the covered commands before they run, and only those', () => {
    for (const command of ['git stash list', 'git ls-tree -r --name-only HEAD', 'gh pr checks 42', 'gh pr view', 'gh issue view 41', 'gt status',
      'yadm status', 'yadm diff', 'yadm stash list', 'jj diff --git', 'diff -ru a b', 'diff -Naur old new', 'cd ./site && diff -u -r a b']) {
      expect(mayProject(command), command).toBe(true)
    }
    for (const command of ['gh run list', 'gh pr view --json body', 'gt log', 'yadm encrypt', 'jj log', 'jj diff', 'diff a b', 'diff -q a b']) {
      expect(mayProject(command), command).toBe(false)
    }
  })
})
