import { toolArgv } from '../command.ts'
import { ProjectionBuilder } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN } from './noise.ts'

/**
 * Remove the layout whitespace of pretty-printed JSON inside containers
 * nested deeper than `keep` levels, so each element or key of the outer
 * level reads on one line (`[\n  {"name":"a","deps":["x"]},\n  …\n]`). The
 * whitespace of the outer levels, between top-level values and inside
 * strings stays; keys, values, escapes, order and number spelling are copied
 * as they are. Undefined unless `raw` is a whitespace-separated sequence of
 * JSON values whose containers all parse, or when nothing would be removed.
 */
export function compactNestedJson(raw: string, keep = 1): MappedProjection | undefined {
  const builder = new ProjectionBuilder(raw)
  let depth = 0
  let inString = false
  let escaped = false
  let start = 0
  let opened = 0
  let removed = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') {
      if (depth === 0) opened = i
      depth++
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) return undefined
      depth--
      if (depth === 0) {
        try { JSON.parse(raw.slice(opened, i + 1)) } catch { return undefined }
      }
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (depth > keep) {
        builder.keep(start, i)
        start = i + 1
        removed = true
      }
    } else if (depth === 0 && (ch === ',' || ch === ':')) return undefined
  }
  if (depth !== 0 || inString) return undefined
  builder.keep(start, raw.length)
  return removed ? builder.finish() : undefined
}

// ——— jq ———

/** Options after which jq prints raw strings or record separators, not JSON text. */
const RAW = /^--(?:raw-output0?|join-output|seq)$|^-[A-Za-z]*[rj]/u

function jqCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'jq') return false
  for (const arg of argv.slice(1)) {
    if (arg === '--') break
    if (arg.startsWith('-') && RAW.test(arg)) return false
  }
  return true
}

/**
 * `jq` printing JSON (not `-r`/`-j`): the indentation and line breaks inside
 * containers nested below the first level go, so each element or key of the
 * outer level reads on one line. The data is untouched: every key, value,
 * escape, order and number spelling is copied as it is, and output that is
 * not a sequence of JSON values passes through.
 */
function projectJq(input: FilterInput): MappedProjection | undefined {
  if (!jqCommand(input.command) || ![0, 1].includes(input.exitCode) || NOT_PLAIN.test(input.stdout)) return undefined
  return compactNestedJson(input.stdout)
}

export const jqFilter: EconomyFilter = {
  name: 'jq', transformation: 'lossless-formatting', projectMapped: projectJq, commands: jqCommand,
  project: input => projectJq(input)?.text,
}
