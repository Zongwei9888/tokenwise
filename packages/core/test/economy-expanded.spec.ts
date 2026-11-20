import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectStaticFilter } from '../src/filters/index.ts'

const ruffReport = [{ filename: '/src/甲.py', code: 'F401', message: 'unused import', location: { row: 1, column: 1 },
  fix: { edits: [{ content: '', location: { row: 1, column: 1 } }] }, future: { text: 'keep \\" quoted\n text' } }]

describe('additional Git, Python diagnostics and Go test output contracts', () => {
  it('compacts Ruff layout without deleting findings, fixes, new fields, duplicate keys or numeric spelling', () => {
    const raw = JSON.stringify(ruffReport, null, 4).replace('"code": "F401"', '"number": 1e+20, "code": "first", "code": "F401"')
    const projected = projectStaticFilter({ command: 'uv run ruff check --output-format=json src', stdout: raw, exitCode: 1 })!
    expect(projected.filter).toBe('ruff-json')
    expect(JSON.parse(projected.text)).toEqual(JSON.parse(raw))
    expect(projected.text).toContain('"number":1e+20,"code":"first","code":"F401"')
    expect(projected.text.length).toBeLessThan(raw.length)
    for (const span of projected.sourceMap.spans) expect(projected.text.slice(span.outputStart, span.outputEnd)).toBe(raw.slice(span.sourceStart, span.sourceEnd))
  })

  it.each(['ruff check src', 'ruff format --output-format=json src', 'ruff check --output-format=json --output-format=full src', 'ruff check --output-format=json src && true'])('does not infer JSON command formats: %s', command => {
    expect(projectStaticFilter({ command, stdout: JSON.stringify(ruffReport, null, 2), exitCode: 1 })).toBeUndefined()
  })

  it('preserves every Go event and exact escaped test-output string in order', () => {
    const raw = '{ "Action": "run", "Package": "example/p", "Test": "TestA" }\r\n'
      + '{ "Action": "output", "Package": "example/p", "Output": "  error\\n  diagnostics  ", "Future": 1e+20 }\r\n'
      + '{ "Action": "fail", "Package": "example/p", "Elapsed": 0.03 }\r\n'
    const projection = projectStaticFilter({ command: 'go test -json ./...', stdout: raw, exitCode: 1 })!
    expect(projection.filter).toBe('go-test-json')
    expect(projection.text.split('\r\n').filter(Boolean).map(line => JSON.parse(line))).toEqual(raw.split('\r\n').filter(Boolean).map(line => JSON.parse(line)))
    expect(projection.text).toContain('"Output":"  error\\n  diagnostics  "')
    expect(projection.text).toContain('1e+20')
    expect(projection.text.match(/\r\n/g)).toHaveLength(3)
  })

  it.each(['not JSON', '{"Action":"unknown","Package":"p"}\n', '{"Action":"pass","Package":"p"}\ncompiler diagnostic\n'])('keeps unknown or mixed Go output: %s', stdout => {
    expect(projectStaticFilter({ command: 'go test -json ./...', stdout, exitCode: 1 })).toBeUndefined()
  })

  it('does not pretend already compact Go JSON can save tokens', () => {
    const raw = '{"Action":"pass","Package":"p"}\n'
    expect(projectStaticFilter({ command: 'go test -json ./...', stdout: raw, exitCode: 0 })?.text).toBe(raw)
  })

  it('turns real Git status file lists into the rows git status --short prints, state lines kept, hints gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'economy-git-status-'))
    const git = (args: string[], check = true) => {
      try {
        return execFileSync('git', ['-c', 'color.ui=false', '-c', 'advice.statusHints=true', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', HOME: root } })
      } catch (error) { if (check) throw error; return '' }
    }
    try {
      git(['init', '-q', '--initial-branch=main'])
      for (const name of ['a', 'b', 'c', 'd', 'conflict']) await writeFile(join(root, `${name}.txt`), '1\n')
      git(['add', '.']); git(['commit', '-qm', 'init'])
      git(['checkout', '-qb', 'other']); await writeFile(join(root, 'conflict.txt'), 'other\n'); git(['commit', '-qam', 'other'])
      git(['checkout', '-q', 'main']); await writeFile(join(root, 'conflict.txt'), 'main\n'); git(['commit', '-qam', 'main'])
      git(['merge', '-q', 'other'], false)
      // Staged and changed again (MM), renamed and changed (RM), staged and unstaged deletions, a conflict, odd untracked names.
      await writeFile(join(root, 'a.txt'), '2\n'); git(['add', 'a.txt']); await writeFile(join(root, 'a.txt'), '3\n')
      git(['mv', 'b.txt', 'b2.txt']); await writeFile(join(root, 'b2.txt'), '1\n9\n')
      git(['rm', '-q', 'c.txt']); await rm(join(root, 'd.txt'))
      await writeFile(join(root, 'Line 25: strange name.txt'), 'untracked'); await mkdir(join(root, 'newdir')); await writeFile(join(root, 'newdir', 'f'), 'y')
      const raw = git(['status', '--long'])
      const projection = projectStaticFilter({ command: 'git status', stdout: raw, exitCode: 0 })!
      expect(projection.filter).toBe('git-status')
      const lines = projection.text.trimEnd().split('\n')
      expect(lines.slice(0, 3)).toEqual(['On branch main', 'You have unmerged paths.', '[short format: XY path, X = staged, Y = not staged, ?? untracked]'])
      // Exactly git's own short rows.
      expect(lines.slice(3).join('\n')).toBe(git(['status', '--short']).trimEnd())
      expect(projection.text).not.toMatch(/\(use "git|\(fix conflicts/u)
      expect(projectStaticFilter({ command: 'git status --porcelain=v1', stdout: git(['status', '--porcelain=v1']), exitCode: 0 })).toBeUndefined()
      // Two files: the legend would cost more than the rows save, so only the hints go.
      git(['reset', '-q', '--hard']); git(['clean', '-qfd'])
      await writeFile(join(root, 'a.txt'), '5\n'); await writeFile(join(root, 'new.txt'), 'n')
      const small = git(['status', '--long'])
      const kept = projectStaticFilter({ command: 'git status', stdout: small, exitCode: 0 })!.text
      expect(kept).toContain('Changes not staged for commit:\n\tmodified:   a.txt\n')
      expect(kept.split('\n').filter(line => !small.split('\n').includes(line))).toEqual(['no changes added to commit'])
      expect(kept).not.toContain('(use "git')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
