import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gitBlameFilter, gitLogFilter, projectStaticFilter } from '../src/filters/index.ts'
import { sourceLines } from '../src/projection-map.ts'

// Real outputs of git 2.x in a generated repository: 60 commits by three authors, every third with a body;
// module.py written in the first commit and retouched by three later ones.
const captured = JSON.parse(readFileSync(new URL('./fixtures/git-log-blame.json', import.meta.url), 'utf8')) as Record<'log' | 'log20' | 'oneline' | 'blame' | 'blame_module', string>
const blocks = (log: string) => log.split(/^(?=commit [0-9a-f]{40})/mu)
const subject = (block: string) => block.split('\n')[4]!

describe('git-log', () => {
  it('keeps the first ten commits and the last two of a long default log, counting the rest', () => {
    const all = blocks(captured.log)
    expect(all).toHaveLength(60)
    const projected = gitLogFilter.project({ command: 'git log', stdout: captured.log, exitCode: 0 })!
    expect(projected).toBe([...all.slice(0, 10), '[48 commits omitted]\n', ...all.slice(58)].join(''))
    expect(projectStaticFilter({ command: 'git log', stdout: captured.log, exitCode: 0 })?.filter).toBe('git-log')
    // Twenty commits: still cut; fifteen or fewer: left alone.
    expect(gitLogFilter.project({ command: 'git log', stdout: captured.log20, exitCode: 0 })).toContain('[8 commits omitted]')
    expect(gitLogFilter.project({ command: 'git log', stdout: all.slice(0, 15).join(''), exitCode: 0 })).toBeUndefined()
  })

  it('leaves whole a log the agent scoped itself, which is also how it reads what a bare log left out', () => {
    for (const command of ['git log -20', 'git log -n 20', 'git log -n20', 'git log --max-count=20', 'git log --skip=10', 'git log --since=2.weeks',
      'git log --author Ann', 'git log --grep=fix', 'git log -S total', 'git log -Gtotal', 'git log main..feature', 'git log origin/main',
      'git log -- ledger.py', 'git log ledger.py', 'git log -L 1,5:module.py', 'git log --oneline -40']) {
      expect(gitLogFilter.project({ command, stdout: command.includes('--oneline') ? captured.oneline : captured.log, exitCode: 0 }), command).toBeUndefined()
    }
    // Layout options alone do not scope it.
    for (const command of ['git log --all', 'git log --no-merges', 'git log --decorate', 'git log --first-parent']) {
      expect(gitLogFilter.project({ command, stdout: captured.log, exitCode: 0 }), command).toContain('[48 commits omitted]')
    }
  })

  it('never omits a commit whose message mentions a failure, an error, a conflict or a revert', () => {
    const all = blocks(captured.log)
    const notable = [20, 33]
    const edited = all.map((block, i) => notable.includes(i) ? block.replace(subject(block), i === 20 ? '    Fix failing currency conversion test' : '    Resolve merge conflict in ledger export') : block)
    const projected = gitLogFilter.project({ command: 'git log', stdout: edited.join(''), exitCode: 0 })!
    expect(projected).toBe([...edited.slice(0, 10), '[10 commits omitted]\n', edited[20], '[12 commits omitted]\n', edited[33], '[24 commits omitted]\n', ...edited.slice(58)].join(''))
  })

  it('previews a long --oneline list the same way, row by row', () => {
    const rows = sourceLines(captured.oneline).map(line => line.text)
    expect(rows).toHaveLength(60)
    const projected = gitLogFilter.project({ command: 'git log --oneline', stdout: captured.oneline, exitCode: 0 })!
    expect(projected).toBe([...rows.slice(0, 30), '[25 commits omitted]', ...rows.slice(55)].join('\n') + '\n')
    expect(gitLogFilter.project({ command: 'git log --oneline', stdout: rows.slice(0, 50).join('\n') + '\n', exitCode: 0 })).toBeUndefined()
  })

  it('leaves other layouts, failures and anything not in the default shape alone', () => {
    for (const command of ['git log -p', 'git log --stat', 'git log --format=%H', 'git log --pretty=oneline', 'git log --graph', 'git log --show-signature', 'git log -c', 'git shortlog']) {
      expect(gitLogFilter.project({ command, stdout: captured.log, exitCode: 0 }), command).toBeUndefined()
    }
    expect(gitLogFilter.project({ command: 'git log', stdout: captured.log, exitCode: 128 })).toBeUndefined()
    // A stat or diff line inside the blocks: not the default layout.
    const withStat = captured.log.replace('\n\ncommit ', '\n\n ledger.py | 2 +-\n\ncommit ')
    expect(gitLogFilter.project({ command: 'git log', stdout: withStat, exitCode: 0 })).toBeUndefined()
    expect(gitLogFilter.project({ command: 'git log --oneline', stdout: captured.oneline + 'fatal: bad object\n', exitCode: 0 })).toBeUndefined()
  })
})

describe('git-blame', () => {
  it('drops the repeated hash, author and date inside runs from one commit, keeping every line number and code line', () => {
    const projected = gitBlameFilter.project({ command: 'git blame module.py', stdout: captured.blame_module, exitCode: 0 })!
    expect(projected.length).toBeLessThan(captured.blame_module.length * 0.6)
    const rows = sourceLines(captured.blame_module).map(line => line.text)
    const kept = projected.split('\n')
    expect(kept[0]).toBe(rows[0])
    expect(kept[1]).toBe('[hash, author and date of the next 11 lines omitted: same as above]')
    expect(kept[2]).toBe('  2)     return x + 1')
    // Every code line and line number, in order.
    const code = rows.map(row => row.slice(row.indexOf(') ') - 2))
    for (const [i, row] of code.entries()) expect(projected, String(i + 1)).toContain(row.trimStart())
    for (const row of rows) expect(projected).toContain(row.slice(row.lastIndexOf(' +0000') + 6))
    expect(projectStaticFilter({ command: 'git blame module.py', stdout: captured.blame_module, exitCode: 0 })?.filter).toBe('git-blame')
  })

  it('leaves blame without long runs, other layouts and broken shapes alone', () => {
    expect(gitBlameFilter.project({ command: 'git blame ledger.py', stdout: captured.blame, exitCode: 0 })).toBeUndefined()
    for (const command of ['git blame -p module.py', 'git blame --porcelain module.py', 'git blame --line-porcelain module.py', 'git blame -s module.py',
      'git blame -e module.py', 'git blame --incremental module.py', 'git blame -n module.py', 'git blame -f module.py']) {
      expect(gitBlameFilter.project({ command, stdout: captured.blame_module, exitCode: 0 }), command).toBeUndefined()
    }
    expect(gitBlameFilter.project({ command: 'git blame -L 1,40 module.py', stdout: sourceLines(captured.blame_module).slice(0, 40).map(line => line.text).join('\n') + '\n', exitCode: 0 })).toBeDefined()
    // Line numbers out of order, or a row of another shape.
    const rows = captured.blame_module.split('\n')
    expect(gitBlameFilter.project({ command: 'git blame module.py', stdout: [rows[1], rows[0], ...rows.slice(2)].join('\n'), exitCode: 0 })).toBeUndefined()
    expect(gitBlameFilter.project({ command: 'git blame module.py', stdout: captured.blame_module + 'fatal: no such path\n', exitCode: 0 })).toBeUndefined()
  })
})
