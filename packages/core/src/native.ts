/**
 * Lossless layouts for the results of a host's own search tools (grep, glob,
 * find). No shell is involved, so there is no command to recognize: the
 * adapter says which tool produced the text. Every function checks the exact
 * rendering it is given and keeps every match, path, line number and their
 * order; anything unexpected returns undefined and the result passes.
 */
import { ProjectionBuilder, sourceLines } from './projection-map.ts'
import type { MappedProjection } from './projection-map.ts'
import type { FilterCandidate } from './types.ts'

export interface NativeSearchMatch {
  readonly path: string
  readonly lineNumber: number
  readonly line: string
}

const UNSAFE = /[\r\n\0]/
const native = (filter: 'native-grep' | 'native-glob', projection: MappedProjection | undefined): FilterCandidate | undefined =>
  projection === undefined ? undefined : { ...projection, filter, transformation: 'lossless-formatting' }

/**
 * `Found N matches`, then each file's path and one `Line N: text` row per
 * match (DeepSeek Harness `grep`). Only the complete rendering of `matches`
 * qualifies, so a result the host capped or abridged is never touched. The
 * `Line ` of each row goes; paths, numbers and text stay.
 */
export function nativeGrepSections(matches: readonly NativeSearchMatch[], rendered: string): FilterCandidate | undefined {
  if (matches.length === 0) return undefined
  const groups = new Map<string, NativeSearchMatch[]>()
  for (const match of matches) {
    if (typeof match?.path !== 'string' || match.path === '' || UNSAFE.test(match.path) || typeof match.line !== 'string'
      || UNSAFE.test(match.line) || !Number.isSafeInteger(match.lineNumber) || match.lineNumber < 1) return undefined
    const group = groups.get(match.path) ?? []
    group.push(match)
    groups.set(match.path, group)
  }
  const header = `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}\n\n`
  const body = [...groups].map(([path, group]) => `${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`).join('\n\n')
  if (rendered !== header + body) return undefined
  const builder = new ProjectionBuilder(rendered)
  let offset = header.length
  builder.keep(0, offset)
  for (const [path, group] of groups) {
    builder.keep(offset, offset + path.length + 1)
    offset += path.length + 1
    for (const match of group) {
      const length = `Line ${match.lineNumber}: ${match.line}`.length
      builder.keep(offset + 'Line '.length, offset + length)
      offset += length
      if (rendered[offset] === '\n') { builder.keep(offset, offset + 1); offset += 1 }
    }
    if (rendered[offset] === '\n') { builder.keep(offset, offset + 1); offset += 1 }
  }
  return native('native-grep', builder.finish())
}

/** pi `grep` rows: `path:N: text` for a match, `path-N- text` for a context line. */
const MATCH_ROW = /^([^:\r\n\0]+):([1-9]\d*): /
const CONTEXT_REST = /^-[1-9]\d*- /

/**
 * `path:line: text` rows and `path-line- text` context rows (pi `grep`). Runs
 * of at least three rows of one file are grouped under its path; each row
 * keeps its number and its `:` (match) or `-` (context) separator, so every
 * row is still there. Notices and anything else stay verbatim.
 */
export function nativeGrepRecords(rendered: string): FilterCandidate | undefined {
  if (/[\u001b\0]|\r(?!\n)/.test(rendered)) return undefined
  const lines = sourceLines(rendered)
  const files = new Set<string>()
  for (const line of lines) {
    const file = MATCH_ROW.exec(line.text)?.[1]
    if (file !== undefined) files.add(file)
  }
  if (files.size === 0) return undefined
  // A context row names no separator of its own: it belongs to the longest matched file it starts with.
  const longestFirst = [...files].sort((a, b) => b.length - a.length)
  const rowOf = (text: string): { file: string; context: boolean } | undefined => {
    const file = MATCH_ROW.exec(text)?.[1]
    if (file !== undefined) return { file, context: false }
    const owner = longestFirst.find(candidate => text.startsWith(candidate) && CONTEXT_REST.test(text.slice(candidate.length)))
    return owner === undefined ? undefined : { file: owner, context: true }
  }
  const rows = lines.map(line => rowOf(line.text))
  const builder = new ProjectionBuilder(rendered)
  let grouped = false
  for (let i = 0; i < lines.length;) {
    const row = rows[i]
    let end = i + 1
    if (row !== undefined) while (end < lines.length && rows[end]?.file === row.file) end++
    if (row === undefined || end - i < 3 || row.file.length < 4) {
      builder.keep(lines[i]!.start, lines[i]!.end); i++; continue
    }
    const context = rows.slice(i, end).some(item => item!.context)
    builder.generate(context ? '[matches and context lines in ' : '[matches in ', 'search-layout')
    builder.keep(lines[i]!.start, lines[i]!.start + row.file.length)
    builder.generate(context ? '; every line retained]\n' : '; every match retained]\n', 'search-layout')
    for (; i < end; i++) {
      builder.generate('  ', 'search-layout')
      builder.keep(lines[i]!.start + row.file.length + 1, lines[i]!.end)
    }
    grouped = true
  }
  return grouped ? native('native-grep', builder.finish()) : undefined
}

/**
 * One path per line in the host's order (DeepSeek Harness `glob`), exactly
 * the complete `paths`: consecutive paths in one directory are grouped under it.
 */
export function nativePathList(paths: readonly string[], rendered: string): FilterCandidate | undefined {
  if (paths.length === 0 || !paths.every(path => typeof path === 'string' && path !== '' && !UNSAFE.test(path))
    || rendered !== paths.join('\n')) return undefined
  return nativePathLines(rendered)
}

/**
 * Path lines (pi `find`, DeepSeek Harness `glob`) with any notices: consecutive
 * paths in one directory are grouped under it, in their original order. Lines
 * that are not a path inside a directory (notices, blank lines, top-level
 * names, directories ending in `/`) stay verbatim and end a group.
 */
export function nativePathLines(rendered: string): FilterCandidate | undefined {
  if (/[\u001b\0]|\r/.test(rendered)) return undefined
  const lines = sourceLines(rendered)
  const directoryOf = (text: string) => {
    const slash = text.lastIndexOf('/')
    return slash <= 0 || slash === text.length - 1 || /^[[(]/.test(text) ? undefined : text.slice(0, slash + 1)
  }
  const builder = new ProjectionBuilder(rendered)
  builder.generate('[paths grouped by directory; original order retained]\n', 'glob-layout')
  let grouped = false
  for (let i = 0; i < lines.length;) {
    const first = lines[i]!
    const directory = directoryOf(first.text)
    let end = i + 1
    if (directory !== undefined) while (end < lines.length && directoryOf(lines[end]!.text) === directory) end++
    if (directory === undefined || end - i < 2) {
      builder.keep(first.start, first.end); i++; continue
    }
    builder.keep(first.start, first.start + directory.length)
    builder.generate('\n', 'glob-layout')
    for (; i < end; i++) {
      const line = lines[i]!
      builder.generate('  ', 'glob-layout')
      builder.keep(line.start + directory.length, line.end)
    }
    builder.newline()
    grouped = true
  }
  return grouped ? native('native-glob', builder.finish()) : undefined
}

/** A text item of a host's result: its value and where it sits in the rendered text (a JSON string's inside, or a line). */
interface Item { readonly value: string; readonly start: number; readonly end: number; readonly verbatim: boolean }

/**
 * The strings of a one-level JSON array of strings, exactly as rendered (`["a","b"]`, any white space), with each
 * one's place inside its quotes; undefined for anything else. A string with an escape is not verbatim in the text.
 */
function jsonStrings(rendered: string): Item[] | undefined {
  const items: Item[] = []
  let i = 0
  const space = () => { while (i < rendered.length && /\s/.test(rendered[i]!)) i++ }
  space()
  if (rendered[i] !== '[') return undefined
  i++; space()
  if (rendered[i] === ']') { i++; space(); return i === rendered.length ? items : undefined }
  for (;;) {
    if (rendered[i] !== '"') return undefined
    const open = i
    for (i++; i < rendered.length && rendered[i] !== '"'; i++) if (rendered[i] === '\\') i++
    if (i >= rendered.length) return undefined
    const token = rendered.slice(open, i + 1)
    let value: unknown
    try { value = JSON.parse(token) } catch { return undefined }
    if (typeof value !== 'string') return undefined
    items.push({ value, start: open + 1, end: i, verbatim: !token.includes('\\') })
    i++; space()
    if (rendered[i] === ',') { i++; space(); continue }
    if (rendered[i] !== ']') return undefined
    i++; space()
    return i === rendered.length ? items : undefined
  }
}

/** Copy part of an item (from `offset` on): its own text when verbatim, else the decoded value. */
function copy(builder: ProjectionBuilder, item: Item, from: number, to = item.value.length): void {
  if (to <= from) return
  if (item.verbatim) builder.keep(item.start + from, item.start + to)
  else builder.generate(item.value.slice(from, to), 'json-string')
}

/** The directory every path is in (with its trailing `/`), when that is worth saying once: '' otherwise. */
function commonRoot(paths: readonly string[]): string {
  if (paths.length < 2) return ''
  let root = paths[0]!.slice(0, paths[0]!.lastIndexOf('/') + 1)
  for (const path of paths) while (root && !path.startsWith(root)) root = root.slice(0, root.lastIndexOf('/', root.length - 2) + 1)
  return root.length >= 8 ? root : ''
}

/**
 * Paths, once each, in the host's order: their common directory said once, and
 * consecutive paths in one directory grouped under it. `after` (notices the
 * host put below the list) stays verbatim.
 */
function layoutPaths(rendered: string, items: readonly Item[], after?: { start: number; end: number }): MappedProjection | undefined {
  if (items.length < 2 || items.some(item => item.value === '' || UNSAFE.test(item.value) || item.value.endsWith('/'))) return undefined
  const root = commonRoot(items.map(item => item.value))
  const builder = new ProjectionBuilder(rendered)
  builder.generate(root ? `[paths under ${root}, grouped by directory; original order retained]\n` : '[paths grouped by directory; original order retained]\n', 'glob-layout')
  const directoryOf = (item: Item) => item.value.slice(root.length, item.value.lastIndexOf('/') + 1)
  let grouped = root !== ''
  for (let i = 0; i < items.length;) {
    const first = items[i]!
    const directory = directoryOf(first)
    let end = i + 1
    while (end < items.length && directoryOf(items[end]!) === directory) end++
    if (directory === '' || end - i < 2) {
      for (; i < end; i++) { copy(builder, items[i]!, root.length); builder.generate('\n', 'glob-layout') }
      continue
    }
    copy(builder, first, root.length, root.length + directory.length)
    builder.generate('\n', 'glob-layout')
    for (; i < end; i++) {
      builder.generate('  ', 'glob-layout')
      copy(builder, items[i]!, root.length + directory.length)
      builder.generate('\n', 'glob-layout')
    }
    grouped = true
  }
  if (!grouped) return undefined
  if (after && after.end > after.start) builder.keep(after.start, after.end)
  return builder.finish()
}

/**
 * A JSON array of paths, in the host's order (CodeBuddy `Glob`, and `Grep` in
 * files_with_matches mode): every path once, their common directory said once,
 * consecutive paths in one directory grouped under it.
 */
export function nativeJsonPaths(rendered: string): FilterCandidate | undefined {
  const items = jsonStrings(rendered)
  return items ? native('native-glob', layoutPaths(rendered, items)) : undefined
}

/**
 * Absolute paths, one per line, in the host's order (OpenCode `glob`), and
 * optionally a blank line and a notice in parentheses below them: their common
 * directory said once, consecutive paths in one directory grouped under it.
 */
export function nativeAbsolutePathLines(rendered: string): FilterCandidate | undefined {
  if (/[\u001b\0\r]/.test(rendered)) return undefined
  const lines = sourceLines(rendered)
  let count = 0
  while (count < lines.length && lines[count]!.text.startsWith('/')) count++
  const rest = lines.slice(count)
  if (count < 2 || !rest.every(line => line.text === '' || /^\(.*\)$/.test(line.text))) return undefined
  const items = lines.slice(0, count).map(line => ({ value: line.text, start: line.start, end: line.start + line.text.length, verbatim: true }))
  const tail = rest.length ? { start: rest[0]!.start, end: rendered.length } : undefined
  return native('native-glob', layoutPaths(rendered, items, tail))
}

/** A ripgrep row: `path:N:text` for a match, `path-N-text` for a context line, `--` between context blocks. */
const RG_MATCH = /^(.+?):([1-9]\d*):/
const MATCH_AFTER_PATH = /^:[1-9]\d*:/
const CONTEXT_AFTER_PATH = /^-[1-9]\d*-/

/**
 * A JSON array of ripgrep rows (CodeBuddy `Grep` in content mode with line
 * numbers): rows grouped under their file, each keeping its number, its `:`
 * (match) or `-` (context) separator and its text; the files' common directory
 * said once. Any row that is not one of these leaves the result alone.
 */
export function nativeJsonGrepRows(rendered: string): FilterCandidate | undefined {
  const items = jsonStrings(rendered)
  if (!items || items.length < 2 || items.some(item => UNSAFE.test(item.value))) return undefined
  // Every `path:N:` prefix. A context line whose text holds `:N:` (a time, a slice) gives one too, but that
  // one starts with a real file and `-N-`: ripgrep prints context only around a match, so that file is here.
  const candidates = new Set<string>()
  for (const item of items) { const file = RG_MATCH.exec(item.value)?.[1]; if (file !== undefined) candidates.add(file) }
  const files = [...candidates].filter(file => ![...candidates].some(other =>
    other.length < file.length && file.startsWith(other) && CONTEXT_AFTER_PATH.test(file.slice(other.length))))
  if (files.length === 0) return undefined
  const longestFirst = files.sort((a, b) => b.length - a.length)
  const rows = items.map(item => {
    if (item.value === '--') return { item, file: undefined, rest: 0 }
    const match = longestFirst.find(file => item.value.startsWith(file) && MATCH_AFTER_PATH.test(item.value.slice(file.length)))
    if (match !== undefined) return { item, file: match, rest: match.length + 1 }
    const context = longestFirst.find(file => item.value.startsWith(file) && CONTEXT_AFTER_PATH.test(item.value.slice(file.length)))
    return context === undefined ? undefined : { item, file: context, rest: context.length }
  })
  if (rows.some(row => row === undefined)) return undefined
  const root = commonRoot([...files])
  const builder = new ProjectionBuilder(rendered)
  builder.generate(root ? `[matches grouped by file under ${root}; every line retained]\n` : '[matches grouped by file; every line retained]\n', 'search-layout')
  let current: string | undefined
  for (const row of rows) {
    const { item, file, rest } = row!
    if (file === undefined) { copy(builder, item, 0); builder.generate('\n', 'search-layout'); current = undefined; continue }
    if (file !== current) {
      copy(builder, item, root.length, file.length)
      builder.generate('\n', 'search-layout')
      current = file
    }
    builder.generate('  ', 'search-layout')
    // A match keeps `N:text`, a context line `-N-text` (its leading `-` is the separator after the path).
    copy(builder, item, rest)
    builder.generate('\n', 'search-layout')
  }
  return native('native-grep', builder.finish())
}

/**
 * OpenCode `grep`: `Found N matches`, then each file as `path:` with its rows
 * as `  Line N: text` (a row's text keeps its newline, so a blank line follows
 * most rows), blank lines between files, and optionally a notice in
 * parentheses at the end. Rows become `  N: text`, the blank lines go, and the
 * files' common directory is said once. Anything else leaves the result alone.
 */
export function nativeGrepBlocks(rendered: string): FilterCandidate | undefined {
  if (/[\u001b\0\r]/.test(rendered)) return undefined
  const lines = sourceLines(rendered)
  if (!/^Found [1-9]\d* match(?:es)?(?: \(more matches available\))?$/.test(lines[0]?.text ?? '')) return undefined
  const kinds: ('file' | 'row' | 'blank' | 'notice')[] = []
  const files: string[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    const text = line.text
    if (text === '') kinds.push('blank')
    else if (/^ {2}Line [1-9]\d*: /.test(text)) kinds.push('row')
    else if (text.startsWith('/') && text.endsWith(':')) { kinds.push('file'); files.push(text.slice(0, -1)) }
    else if (/^\(.*\)$/.test(text) && lines.slice(index + 2).every(next => next.text === '' || /^\(.*\)$/.test(next.text))) kinds.push('notice')
    else return undefined
  }
  if (files.length === 0 || kinds[0] !== 'file') return undefined
  const root = commonRoot(files)
  const builder = new ProjectionBuilder(rendered)
  builder.keep(lines[0]!.start, lines[0]!.end)
  if (root) builder.generate(`[files under ${root}]\n`, 'search-layout')
  for (const [index, kind] of kinds.entries()) {
    const line = lines[index + 1]!
    if (kind === 'blank') continue
    if (kind === 'file') { builder.keep(line.start + root.length, line.end); builder.newline(); continue }
    if (kind === 'notice') { builder.keep(line.start, line.end); builder.newline(); continue }
    builder.generate('  ', 'search-layout')
    builder.keep(line.start + '  Line '.length, line.end)
    builder.newline()
  }
  return native('native-grep', builder.finish())
}
