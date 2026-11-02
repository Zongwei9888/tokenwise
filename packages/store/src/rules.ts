import { chmodSync, cpSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { compileLearnedRules, parseRuleIndex, ruleDirectoryHash, RuleDirectoryError } from '@tokenwise/core'
import type { LearnedRuleSet, RuleFile } from '@tokenwise/core'
import { ensurePrivateDir } from './paths.ts'

/**
 * Adopted rule directories under `<data>/rules`: each at `<data>/rules/<hash>`
 * (read-only once written), and `active.json`, which names the one in use and
 * keeps the history of adoptions for rollback.
 */

const MAX_FILES = 512
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/u

export interface RuleAdoption {
  readonly hash: string
  /** The rules it replaced; null for the first adoption. */
  readonly parent: string | null
  readonly adoptedAt: string
  readonly rules: number
  /** Verification summary: replayed observations and the token gain on them. */
  readonly cases?: number
  readonly gainTokens?: number
  readonly note?: string
  /** Set when a person taught the rules in their own agent (`tokenwise teach`): the command, and the rules it added or changed. */
  readonly taught?: { readonly command: string; readonly rules: readonly string[] }
}

export interface ActiveRules {
  readonly schemaVersion: 1
  /** Null when learned rules are switched off (`tokenwise rules off`). */
  readonly active: string | null
  /** The rules in use when they were switched off; switching on restores them. */
  readonly paused?: string
  /** When `active` last changed (an adoption, rollback or switch); use is judged from here. */
  readonly activatedAt?: string
  readonly history: readonly RuleAdoption[]
}

/** Read a rule directory: regular files only (no links), bounded in number and size. */
export function readRuleDirectory(root: string): RuleFile[] {
  const files: RuleFile[] = []
  let total = 0
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === '.git') continue
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new RuleDirectoryError(`${relative(root, path)}: symbolic links are not allowed`)
      if (stat.isDirectory()) { walk(path); continue }
      if (!stat.isFile()) continue
      total += stat.size
      if (files.length >= MAX_FILES || total > MAX_TOTAL_BYTES) throw new RuleDirectoryError(`a rule directory holds at most ${MAX_FILES} files and ${MAX_TOTAL_BYTES} bytes`)
      files.push({ path: relative(root, path).split(sep).join('/'), text: readFileSync(path, 'utf8') })
    }
  }
  walk(root)
  return files
}

export class RuleStore {
  readonly root: string
  private cache: { stamp: string; set: LearnedRuleSet | undefined } | undefined
  constructor(dataDir: string) {
    this.root = join(dataDir, 'rules')
  }

  private get activeFile(): string { return join(this.root, 'active.json') }

  dirOf(hash: string): string {
    if (!HASH.test(hash)) throw new RuleDirectoryError(`not a rule directory hash: ${hash}`)
    return join(this.root, hash)
  }

  state(): ActiveRules {
    try {
      const value = JSON.parse(readFileSync(this.activeFile, 'utf8')) as ActiveRules
      if (value?.schemaVersion === 1 && Array.isArray(value.history) && (value.active === null || HASH.test(value.active ?? ''))) return value
    } catch { /* Missing or unreadable: nothing adopted. */ }
    return { schemaVersion: 1, active: null, history: [] }
  }

  private writeState(state: ActiveRules): void {
    ensurePrivateDir(this.root)
    const temp = `${this.activeFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, this.activeFile)
  }

  /** Files of an installed directory, checked against its hash. */
  files(hash: string): RuleFile[] {
    const files = readRuleDirectory(this.dirOf(hash))
    const actual = ruleDirectoryHash(files)
    if (actual !== hash) throw new RuleDirectoryError(`rules ${hash.slice(0, 12)} changed on disk (now ${actual.slice(0, 12)})`)
    return files
  }

  /** Copy a checked directory into the store under its hash, read-only. Returns the hash. */
  install(source: string): string {
    return this.installFiles(readRuleDirectory(source))
  }

  /** Write exactly these files (the ones that were verified) under their hash, read-only. Returns the hash. */
  installFiles(files: readonly RuleFile[]): string {
    parseRuleIndex(files)
    const hash = ruleDirectoryHash(files)
    const target = this.dirOf(hash)
    if (existsSync(target)) return hash
    ensurePrivateDir(this.root)
    const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    ensurePrivateDir(temp)
    for (const file of files) {
      const path = join(temp, ...file.path.split('/'))
      ensurePrivateDir(join(path, '..'))
      writeFileSync(path, file.text, { mode: 0o400 })
    }
    renameSync(temp, target)
    return hash
  }

  /**
   * Make an installed directory the active one, recording the adoption.
   * With `expect`, only if the active rules are still those (else undefined).
   */
  activate(hash: string, details: Omit<RuleAdoption, 'hash' | 'parent' | 'adoptedAt' | 'rules'> = {}, now = new Date(), expect?: string | null): RuleAdoption | undefined {
    const files = this.files(hash)
    const state = this.state()
    if (expect !== undefined && state.active !== expect) return undefined
    const adoption: RuleAdoption = { hash, parent: state.active, adoptedAt: now.toISOString(), rules: parseRuleIndex(files).length, ...details }
    this.writeState({ schemaVersion: 1, active: hash, activatedAt: adoption.adoptedAt, history: [...state.history, adoption] })
    return adoption
  }

  /** Switch learned rules off, remembering which were in use; the history stays. */
  deactivate(): void {
    const state = this.state()
    if (state.active === null) return
    this.writeState({ schemaVersion: 1, active: null, paused: state.active, activatedAt: new Date().toISOString(), history: state.history })
  }

  /**
   * Go back to the rules the active ones replaced (or none). With learned
   * rules switched off, switch back on the ones in use when they were
   * switched off (or else the last adopted). Returns the new active hash.
   */
  rollback(): string | null {
    const state = this.state()
    if (state.active === null) {
      const known = (hash: string | undefined) => hash !== undefined && HASH.test(hash) && existsSync(join(this.root, hash))
      const back = known(state.paused) ? state.paused! : state.history.at(-1)?.hash ?? null
      if (back) this.writeState({ schemaVersion: 1, active: back, activatedAt: new Date().toISOString(), history: state.history })
      return back
    }
    const current = [...state.history].reverse().find(item => item.hash === state.active)
    const previous = current?.parent ?? null
    this.writeState({ schemaVersion: 1, active: previous, activatedAt: new Date().toISOString(), history: state.history })
    return previous
  }

  /** A copy of the active rules (or an empty directory) for a learner to edit. */
  checkout(target: string): string | null {
    const active = this.state().active
    if (active) {
      cpSync(this.dirOf(active), target, { recursive: true, errorOnExist: true, force: false })
      makeWritable(target)
    } else {
      ensurePrivateDir(join(target, 'rules'))
      writeFileSync(join(target, 'index.json'), JSON.stringify({ schemaVersion: 1, rules: [] }, null, 2) + '\n')
    }
    return active
  }

  /**
   * The active learned rules, compiled; undefined when none are active or
   * they cannot be loaded (which `onError` reports). Recompiled only when
   * `active.json` changes.
   */
  load(onError?: (error: unknown) => void): LearnedRuleSet | undefined {
    let stamp: string
    try { const stat = statSync(this.activeFile); stamp = `${stat.mtimeMs}:${stat.size}` } catch { stamp = '-' }
    if (this.cache?.stamp === stamp) return this.cache.set
    let set: LearnedRuleSet | undefined
    const active = stamp === '-' ? null : this.state().active
    if (active && active === this.cache?.set?.hash) set = this.cache.set
    else if (active) {
      try { set = compileLearnedRules(this.files(active)) } catch (error) { onError?.(error) }
    }
    // Engines renew a policy before every decision, so the set it replaced is no longer used.
    if (this.cache?.set && this.cache.set !== set) this.cache.set.dispose()
    this.cache = { stamp, set }
    return set
  }
}

function makeWritable(dir: string): void {
  chmodSync(dir, 0o700)
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) makeWritable(path)
    else if (stat.isFile()) chmodSync(path, 0o600)
  }
}

/** Remove a working directory the store created (used by tests and `tokenwise evolve` cleanup). */
export function removeTree(path: string): void {
  if (!existsSync(path)) return
  try { makeWritable(path) } catch { /* Best effort. */ }
  rmSync(path, { recursive: true, force: true })
}
