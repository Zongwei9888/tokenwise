import { describe, expect, it } from 'vitest'
import { createPolicy, decideNativeProjection, nativeAbsolutePathLines, nativeGrepBlocks, nativeGrepRecords, nativeGrepSections, nativeJsonGrepRows, nativeJsonPaths, nativePathLines, nativePathList } from '../src/index.ts'
import type { FilterCandidate, NativeSearchMatch } from '../src/index.ts'

/** Every copied span is the source text it claims to be. */
function copiesExactly(projection: FilterCandidate, raw: string) {
  for (const span of projection.sourceMap.spans) {
    if (span.sourceStart !== undefined) expect(projection.text.slice(span.outputStart, span.outputEnd)).toBe(raw.slice(span.sourceStart!, span.sourceEnd))
  }
  expect(projection.sourceMap.sourceLength).toBe(raw.length)
}

/** DeepSeek Harness's own grep rendering. */
const dshGrep = (matches: NativeSearchMatch[]) => {
  const groups = new Map<string, NativeSearchMatch[]>()
  for (const match of matches) groups.set(match.path, [...groups.get(match.path) ?? [], match])
  return `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}\n\n`
    + [...groups].map(([path, group]) => `${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`).join('\n\n')
}
const matches: NativeSearchMatch[] = [
  ...Array.from({ length: 6 }, (_, i) => ({ path: 'packages/core/src/economy.ts', lineNumber: 10 + i * 7, line: `  const value${i} = compute(${i}) // Line 3: not a prefix` })),
  { path: 'README.md', lineNumber: 4, line: 'Line 9: literal text' },
  { path: 'packages/core/src/economy.ts', lineNumber: 200, line: '' },
]

describe('native grep, DeepSeek Harness rendering', () => {
  it('drops only the `Line ` of each row and keeps every match', () => {
    const raw = dshGrep(matches)
    const projection = nativeGrepSections(matches, raw)!
    expect(projection).toMatchObject({ filter: 'native-grep', transformation: 'lossless-formatting' })
    copiesExactly(projection, raw)
    expect(projection.text.startsWith('Found 8 matches\n\npackages/core/src/economy.ts\n10:   const value0')).toBe(true)
    expect(projection.text).toContain('\n\nREADME.md\n4: Line 9: literal text')
    // Putting the prefix back restores the host's text exactly.
    expect(projection.text.replace(/^(\d+): /gm, 'Line $1: ')).toBe(raw)
  })

  it('touches nothing but the complete rendering of the structured matches', () => {
    const raw = dshGrep(matches)
    expect(nativeGrepSections(matches.slice(1), raw)).toBeUndefined()
    expect(nativeGrepSections(matches, raw.replace('Found 8 matches', 'Found 8 of 12 matches'))).toBeUndefined()
    expect(nativeGrepSections(matches, `${raw}\n\n(Full grep result stored at: /tmp/x.txt.)`)).toBeUndefined()
    expect(nativeGrepSections([], 'No matches found')).toBeUndefined()
    const multiline = [{ path: 'a.ts', lineNumber: 1, line: 'x\ny' }]
    expect(nativeGrepSections(multiline, dshGrep(multiline))).toBeUndefined()
    expect(nativeGrepSections([{ path: 'a.ts', lineNumber: 0, line: 'x' }], 'Found 1 match\n\na.ts\nLine 0: x')).toBeUndefined()
  })
})

describe('native grep, pi rendering', () => {
  const rows = (file: string, from: number, count: number) => Array.from({ length: count }, (_, i) => `${file}:${from + i}: row ${i} with: colons`)

  it('groups each file\'s consecutive rows and keeps context rows and notices verbatim', () => {
    const raw = [...rows('compaction-basic/src/config.ts', 19, 5), 'compaction-basic/src/index.ts-41- context', ...rows('compaction-basic/src/index.ts', 42, 2),
      ...rows('compaction-basic/tests/compaction-basic.spec.ts', 300, 4)].join('\n') + '\n\n[80 matches limit reached. Use limit=160 for more, or refine pattern]'
    const projection = nativeGrepRecords(raw)!
    expect(projection.filter).toBe('native-grep')
    copiesExactly(projection, raw)
    expect(projection.text).toContain('[matches in compaction-basic/src/config.ts; every match retained]\n  19: row 0 with: colons\n')
    // A context row counts towards its file's run and keeps its `-` separator; the notice stays.
    expect(projection.text).toContain('[matches and context lines in compaction-basic/src/index.ts; every line retained]\n  41- context\n  42: row 0 with: colons\n')
    expect(projection.text.endsWith('\n\n[80 matches limit reached. Use limit=160 for more, or refine pattern]')).toBe(true)
    const restored = projection.text.replace(/\[matches(?: and context lines)? in (.+?); every (?:match|line) retained\]\n((?: {2}.*(?:\n|$))+)/g,
      (_, file: string, block: string) => block.replace(/^ {2}(\d+)([:-])/gm, (_m: string, n: string, sep: string) => `${file}${sep}${n}${sep}`))
    expect(restored).toBe(raw)
    // Two rows of one file alone stay as they are.
    expect(nativeGrepRecords('src/a.ts:1: x\nsrc/a.ts:2: y\nsrc/b.ts:3: z')).toBeUndefined()
  })

  it('groups context lines with their file\'s matches, keeping each row\'s separator', () => {
    const file = 'compaction-basic/tests/compaction-basic.spec.ts', other = 'compaction-basic/src/config.ts'
    const raw = [`${other}-18- `, `${other}-19- /** Default */`, `${other}:20: const DEFAULT_THRESHOLD_RATIO = 0.8`, `${other}-21- `,
      `${file}-2306-       auto: false,`, `${file}:2307:       thresholdRatio: 0.8,`, `${file}-2308-       retainTokens: 350,`, `${file}-2309-     }), session)`,
      'src/v-2-x.ts-5- not a context row of a matched file'].join('\n')
    const projection = nativeGrepRecords(raw)!
    copiesExactly(projection, raw)
    expect(projection.text).toContain(`[matches and context lines in ${other}; every line retained]\n  18- \n  19- /** Default */\n  20: const DEFAULT`)
    expect(projection.text).toContain(`[matches and context lines in ${file}; every line retained]\n  2306-       auto: false,\n  2307:       thresholdRatio`)
    expect(projection.text.endsWith('\nsrc/v-2-x.ts-5- not a context row of a matched file')).toBe(true)
    const restored = projection.text.replace(/\[matches(?: and context lines)? in (.+?); every (?:match|line) retained\]\n((?: {2}.*(?:\n|$))+)/g,
      (_, owner: string, block: string) => block.replace(/^ {2}(\d+)([:-])/gm, (_m: string, n: string, sep: string) => `${owner}${sep}${n}${sep}`))
    expect(restored).toBe(raw)
  })

  it('leaves output without a run of one file\'s rows alone', () => {
    expect(nativeGrepRecords('No matches found')).toBeUndefined()
    expect(nativeGrepRecords('a.ts:1: x\nb.ts:2: y\na.ts:3: z')).toBeUndefined()
    expect(nativeGrepRecords(`${rows('src/a.ts', 1, 4).join('\n')}\u001b[0m`)).toBeUndefined()
  })
})

describe('native path lists', () => {
  const paths = ['src/a/one.ts', 'src/a/two.ts', 'src/a/three.ts', 'README.md', 'src/b/four.ts', 'src/a/five.ts', 'src/a/six.ts', 'docs/']

  it('groups consecutive paths by directory in their original order', () => {
    const raw = paths.join('\n')
    const projection = nativePathList(paths, raw)!
    expect(projection).toMatchObject({ filter: 'native-glob', transformation: 'lossless-formatting' })
    copiesExactly(projection, raw)
    expect(projection.text).toBe('[paths grouped by directory; original order retained]\n'
      + 'src/a/\n  one.ts\n  two.ts\n  three.ts\nREADME.md\nsrc/b/four.ts\nsrc/a/\n  five.ts\n  six.ts\ndocs/')
  })

  it('keeps notices and only takes the complete path list', () => {
    const raw = `${paths.slice(0, 3).join('\n')}\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]`
    const projection = nativePathLines(raw)!
    copiesExactly(projection, raw)
    expect(projection.text.endsWith('  three.ts\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]')).toBe(true)
    expect(nativePathList(paths, `${paths.join('\n')}\n\n(Showing 8 of 20 paths.)`)).toBeUndefined()
    expect(nativePathList(['a/b', 'a/c\nd'], 'a/b\na/c\nd')).toBeUndefined()
    expect(nativePathLines('one.ts\ntwo.ts\nthree.ts')).toBeUndefined()
    expect(nativePathLines('No files found matching pattern')).toBeUndefined()
  })
})

/** The paths a path layout lists, rebuilt from its root, directory lines and indented names. */
function pathsOf(text: string): string[] {
  const [head, ...lines] = text.replace(/\n$/u, '').split('\n')
  const root = /^\[paths under (.*), grouped by directory/u.exec(head!)?.[1] ?? ''
  const paths: string[] = []
  let directory = ''
  for (const line of lines) {
    if (line.startsWith('  ')) paths.push(root + directory + line.slice(2))
    else if (line.endsWith('/')) directory = line
    else if (line !== '' && !line.startsWith('(')) { directory = ''; paths.push(root + line) }
  }
  return paths
}

describe('native path lists as their hosts render them', () => {
  const root = '/Users/me/work/project/'
  const paths = ['tools/a.py', 'tools/b.py', 'tools/web/c.py', 'agent/x.py', 'tools/d.py', 'README.md'].map(path => root + path)

  it('says a JSON array of paths (CodeBuddy Glob) once each, under their common directory, in their order', () => {
    const raw = JSON.stringify(paths)
    const projection = nativeJsonPaths(raw)!
    expect(projection.filter).toBe('native-glob')
    expect(projection.text.split('\n')[0]).toBe(`[paths under ${root}, grouped by directory; original order retained]`)
    expect(pathsOf(projection.text)).toEqual(paths)
    expect(projection.text).toContain('tools/\n  a.py\n  b.py\n')
    copiesExactly(projection, raw)
  })

  it('decodes a path the JSON escapes, and leaves anything but an array of strings alone', () => {
    const odd = [`${root}say "hi".md`, `${root}tab\\name.md`]
    const projection = nativeJsonPaths(JSON.stringify(odd))!
    expect(pathsOf(projection.text)).toEqual(odd)
    for (const raw of ['[]', '["/one/path.py"]', '{"files":["/a/b","/a/c"]}', '["/a/b",1]', '["/a/b","/a/c"] trailing', '["/a/\\nb","/a/c"]']) {
      expect(nativeJsonPaths(raw), raw).toBeUndefined()
    }
  })

  it('lays out absolute path lines (OpenCode glob) and keeps the notice below them', () => {
    const raw = paths.join('\n') + '\n\n(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)'
    const projection = nativeAbsolutePathLines(raw)!
    expect(pathsOf(projection.text)).toEqual(paths)
    expect(projection.text.endsWith('\n\n(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)')).toBe(true)
    copiesExactly(projection, raw)
    expect(nativeAbsolutePathLines('No files found')).toBeUndefined()
    expect(nativeAbsolutePathLines(`${paths[0]}\nsomething else\n${paths[1]}`)).toBeUndefined()
  })
})

describe('native grep rows as their hosts render them', () => {
  const root = '/Users/me/work/project/'
  it('groups a JSON array of ripgrep rows (CodeBuddy Grep content) under each file, every row kept', () => {
    const rows = [`${root}tools/a.py:66:def register(x: str = "/root") -> bool:`, `${root}tools/a.py:109:def register_all():`,
      `${root}tools/b.py-3-# context line`, `${root}tools/b.py:4:    def register(self):`, '--', `${root}agent/c.py:12:register()`]
    const raw = JSON.stringify(rows)
    const projection = nativeJsonGrepRows(raw)!
    expect(projection.filter).toBe('native-grep')
    expect(projection.text).toBe([`[matches grouped by file under ${root}; every line retained]`, 'tools/a.py', '  66:def register(x: str = "/root") -> bool:',
      '  109:def register_all():', 'tools/b.py', '  -3-# context line', '  4:    def register(self):', '--', 'agent/c.py', '  12:register()', ''].join('\n'))
    copiesExactly(projection, raw)
    expect(nativeJsonGrepRows(JSON.stringify([`${root}a.py:1:x`, 'not a row']))).toBeUndefined()
  })

  it('keeps a context line whose text holds `:N:` (a time, a slice) under its own file', () => {
    const rows = [`${root}app.py-11-    started = "12:30:45"`, `${root}app.py:12:def register(name):`,
      `${root}app.py-13-    return names[1:10:2]`, '--', `${root}util.py:40:def register_all():`, `${root}util.py-41-    pass`]
    const raw = JSON.stringify(rows)
    const projection = nativeJsonGrepRows(raw)!
    expect(projection.text).toBe([`[matches grouped by file under ${root}; every line retained]`, 'app.py', '  -11-    started = "12:30:45"',
      '  12:def register(name):', '  -13-    return names[1:10:2]', '--', 'util.py', '  40:def register_all():', '  -41-    pass', ''].join('\n'))
    copiesExactly(projection, raw)
  })

  it('drops OpenCode grep\'s `Line ` and blank lines, saying the files\' directory once', () => {
    const raw = ['Found 3 matches', `${root}src/cli.py:`, '  Line 42:     parser.add_argument("--x")', '', '  Line 155:     y = 1', '', '',
      `${root}src/run.py:`, '  Line 5: import threading', '', '', '(Results truncated. Consider using a more specific path or pattern.)'].join('\n')
    const projection = nativeGrepBlocks(raw)!
    expect(projection.text).toBe(['Found 3 matches', `[files under ${root}src/]`, 'cli.py:', '  42:     parser.add_argument("--x")', '  155:     y = 1',
      'run.py:', '  5: import threading', '(Results truncated. Consider using a more specific path or pattern.)', ''].join('\n'))
    copiesExactly(projection, raw)
    expect(nativeGrepBlocks('No files found')).toBeUndefined()
    expect(nativeGrepBlocks(`Found 1 match\n${root}a.py:\n  Line 1: x\nstray line`)).toBeUndefined()
  })
})

describe('native admission', () => {
  const policy = createPolicy()
  it('admits only a strictly smaller projection that saves tokens', () => {
    const raw = dshGrep(matches)
    expect(decideNativeProjection({ rendered: raw, projection: nativeGrepSections(matches, raw) }, { policy }))
      .toMatchObject({ kind: 'project', filter: 'native-grep', stream: 'stdout' })
    expect(decideNativeProjection({ rendered: raw, projection: undefined }, { policy }))
      .toMatchObject({ kind: 'pass', reason: 'no-filter-match', matchDetail: 'output-format-unrecognized' })
    const one = [{ path: 'a/b.ts', lineNumber: 1, line: 'x' }]
    expect(decideNativeProjection({ rendered: dshGrep(one), projection: nativeGrepSections(one, dshGrep(one)) }, { policy, minimumSavedTokens: 5 }))
      .toMatchObject({ kind: 'pass', reason: 'non-growth-rejected' })
  })
})
