import { ProjectionBuilder } from './projection-map.ts'
import type { MappedProjection } from './projection-map.ts'

/** Caller validates the format. Never parse/stringify: retain duplicate keys and numeric spelling. */
export function compactJsonLayout(raw: string, preserveNewlines = false): MappedProjection {
  const builder = new ProjectionBuilder(raw)
  let inString = false
  let escaped = false
  let start = 0
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (/[ \t\r\n]/.test(ch) && !(preserveNewlines && /[\r\n]/.test(ch))) {
      builder.keep(start, i)
      start = i + 1
    }
  }
  builder.keep(start, raw.length)
  return builder.finish()
}

/**
 * A whole JSON object or array, as cloud CLIs print it (`aws`, `kubectl get -o
 * json`, `gcloud --format=json`, `skopeo inspect`), without its layout
 * whitespace. Undefined when the text is not one JSON document or has no
 * layout to remove.
 */
export function compactJsonDocument(raw: string): MappedProjection | undefined {
  if (!/^\s*[[{]/u.test(raw)) return undefined
  try { JSON.parse(raw) } catch { return undefined }
  const projection = compactJsonLayout(raw)
  return projection.text.length < raw.trimEnd().length ? projection : undefined
}
