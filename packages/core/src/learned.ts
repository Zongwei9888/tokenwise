import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { literalCommand, looksUp, readsFileContent } from './command.ts'
import { sha256 } from './hash.ts'
import { sourceLines } from './projection-map.ts'
import type { MappedProjection, SourceMap } from './projection-map.ts'
import type { EconomyTransformation, FilterCandidate, FilterInput } from './types.ts'

/**
 * Learned rules: filters `tokenwise evolve` adopted after verification, kept as a
 * content-hashed directory and run before the built-in filters.
 *
 *   index.json        {"schemaVersion": 1, "rules": [{"id", "file", "transformation"}]}
 *   rules/<id>.js     a script that calls defineRule({ project(input, tw) { ... } }) once
 *
 * A rule's `project` returns null (not recognized) or `{ text, sourceMap }`,
 * built with the `tw` helpers so every copied span is exact. Each rule set
 * runs in its own V8 context that holds nothing of the host: no `require`,
 * `process`, file system, network, timers or string evaluation, and only
 * strings cross the boundary. Every call has a time limit. A result must
 * carry a valid source map, keep every diagnostic line (error, warning,
 * failure, traceback) and be smaller; otherwise the rule abstains. Any failure
 * means the built-in filters decide, as if no rule were learned.
 */

export const LEARNED_SCHEMA_VERSION = 1
export const MAX_LEARNED_RULES = 256
const MAX_INPUT_CHARS = 1_048_576
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const RULE_FILE = /^rules\/[a-z0-9][a-z0-9._-]{0,63}\.js$/u
const TRANSFORMATIONS: ReadonlySet<EconomyTransformation> = new Set(['noise-removal', 'preview', 'lossless-formatting'])
/** Lines no learned rule may drop: errors and exceptions of any kind, warnings, failures and their markers. */
const DIAGNOSTIC = /\b(?:errors?|warnings?|failed|failures?|fatal|panic(?:ked)?|traceback|exceptions?)\b|\w(?:Error|Exception|Warning)\b|\bFAIL(?:ED)?\b|\bERR!|^E\s{2,}|^\s*not ok\b|^\s*>\s|\bassert(?:ion)?\b/iu
const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/gu

/** One file of a rule directory: its path relative to the directory, with `/` separators. */
export interface RuleFile {
  readonly path: string
  readonly text: string
}

export interface LearnedRuleEntry {
  readonly id: string
  readonly file: string
  readonly transformation: EconomyTransformation
}

/** What a learned rule receives. Only stdout of shell commands reaches learned rules. */
export interface LearnedRuleInput {
  readonly kind: 'shell'
  readonly command: string
  /** The command as words, when it is a plain command without shell syntax; otherwise null. */
  readonly argv: readonly string[] | null
  readonly raw: string
  readonly exitCode: number
  readonly stream: 'stdout'
}

export interface LearnedCandidate extends FilterCandidate {
  readonly rule: string
}

export interface LearnedRuleSet {
  /** Content hash of the directory (see {@link ruleDirectoryHash}). */
  readonly hash: string
  readonly rules: readonly LearnedRuleEntry[]
  /** The first rule's admissible projection, or undefined. Never throws. */
  project(input: FilterInput): LearnedCandidate | undefined
  /** Per rule: calls that failed (threw, timed out or returned an invalid result). */
  readonly failures: ReadonlyMap<string, number>
  /** Stop the worker thread (it never keeps the process alive). */
  dispose(): void
}

export class RuleDirectoryError extends Error {
  override readonly name = 'RuleDirectoryError'
}

/** sha256 over the sorted files: JSON [path, UTF-8 length], a NUL, then the content, for each file. */
export function ruleDirectoryHash(files: readonly RuleFile[]): string {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return sha256(sorted.map(file => `${JSON.stringify([file.path, Buffer.byteLength(file.text, 'utf8')])}\0${file.text}`).join(''))
}

/** Read and check `index.json`. */
export function parseRuleIndex(files: readonly RuleFile[]): LearnedRuleEntry[] {
  const index = files.find(file => file.path === 'index.json')
  if (!index) throw new RuleDirectoryError('index.json is missing')
  let value: unknown
  try { value = JSON.parse(index.text) } catch (error) { throw new RuleDirectoryError(`index.json: ${(error as Error).message}`) }
  const body = value as { schemaVersion?: unknown; rules?: unknown }
  if (body?.schemaVersion !== LEARNED_SCHEMA_VERSION || !Array.isArray(body.rules)) {
    throw new RuleDirectoryError(`index.json must be {"schemaVersion": ${LEARNED_SCHEMA_VERSION}, "rules": [...]}`)
  }
  if (body.rules.length > MAX_LEARNED_RULES) throw new RuleDirectoryError(`at most ${MAX_LEARNED_RULES} rules`)
  const seen = new Set<string>()
  return body.rules.map((item: unknown, i: number): LearnedRuleEntry => {
    const rule = item as { id?: unknown; file?: unknown; transformation?: unknown }
    const where = `index.json rules[${i}]`
    if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) throw new RuleDirectoryError(`${where}: id must match ${RULE_ID}`)
    if (seen.has(rule.id)) throw new RuleDirectoryError(`${where}: duplicate id ${rule.id}`)
    seen.add(rule.id)
    if (typeof rule.file !== 'string' || !RULE_FILE.test(rule.file)) throw new RuleDirectoryError(`${where}: file must be rules/<name>.js`)
    if (!files.some(file => file.path === rule.file)) throw new RuleDirectoryError(`${where}: ${rule.file} is missing`)
    const transformation = rule.transformation ?? 'preview'
    if (typeof transformation !== 'string' || !TRANSFORMATIONS.has(transformation as EconomyTransformation)) {
      throw new RuleDirectoryError(`${where}: transformation must be noise-removal, preview or lossless-formatting`)
    }
    return { id: rule.id, file: rule.file, transformation: transformation as EconomyTransformation }
  })
}

/**
 * The helpers and the dispatcher, evaluated inside the rule context. Only
 * strings enter (`__input`) and leave (the JSON `__call` returns).
 */
const PRELUDE = String.raw`
'use strict';
const __rules = Object.create(null);
let __current = null;
const __lines = raw => {
  const out = [];
  let start = 0;
  while (start < raw.length) {
    const nl = raw.indexOf('\n', start);
    const end = nl < 0 ? raw.length : nl + 1;
    out.push(Object.freeze({ text: raw.slice(start, end).replace(/\r?\n$/, ''), start, end }));
    start = end;
  }
  return out;
};
const __builder = raw => {
  let text = '';
  const spans = [];
  return Object.freeze({
    keep(start, end) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > raw.length) throw new RangeError('keep: invalid source range');
      if (end === start) return;
      const outputStart = text.length;
      text += raw.slice(start, end);
      spans.push({ outputStart, outputEnd: text.length, sourceStart: start, sourceEnd: end });
    },
    keepLine(line) { this.keep(line.start, line.end); },
    generate(value, reason) {
      value = String(value);
      if (value === '') return;
      const outputStart = text.length;
      text += value;
      spans.push({ outputStart, outputEnd: text.length, generated: String(reason || 'learned') });
    },
    newline() { if (text !== '' && !text.endsWith('\n')) this.generate('\n', 'separator'); },
    finish() { return { text, sourceMap: { version: 1, unit: 'utf16', sourceLength: raw.length, outputLength: text.length, spans: spans.slice() } }; },
  });
};
const tw = Object.freeze({
  lines: __lines,
  builder: __builder,
  stripAnsi: value => String(value).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''),
  keepLines(raw, keep, note) {
    const b = __builder(raw);
    let omitted = 0;
    const lines = __lines(raw);
    lines.forEach((line, i) => { if (keep(line, i, lines)) b.keepLine(line); else omitted++; });
    if (omitted === 0) return null;
    b.newline();
    b.generate(typeof note === 'function' ? note(omitted) : '[' + omitted + ' line' + (omitted === 1 ? '' : 's') + ' omitted]\n', 'omission-note');
    return b.finish();
  },
});
const defineRule = definition => {
  if (__current === null) throw new Error('defineRule may only run while the rule file loads');
  if (__rules[__current] !== undefined) throw new Error('defineRule called twice');
  if (!definition || typeof definition.project !== 'function') throw new Error('defineRule needs { project(input, tw) }');
  __rules[__current] = definition.project;
};
var __load = id => { __current = id; };
var __loaded = id => { __current = null; if (__rules[id] === undefined) throw new Error('the rule file did not call defineRule'); };
Object.defineProperty(globalThis, '__input', { value: '', writable: true, enumerable: false, configurable: false });
var __call = id => {
  try {
    const input = Object.freeze(JSON.parse(__input));
    const result = __rules[id](input, tw);
    if (result === null || result === undefined) return 'null';
    return JSON.stringify({ text: result.text, sourceMap: result.sourceMap });
  } catch (error) {
    let message = 'error';
    try { message = String(error && error.message !== undefined ? error.message : error).slice(0, 500); } catch {}
    return JSON.stringify({ error: message });
  }
};
`

/** Check a rule's result against the input: a contiguous source map whose copied spans are exact. */
export function validMappedProjection(raw: string, value: unknown): value is MappedProjection {
  const candidate = value as { text?: unknown; sourceMap?: SourceMap }
  if (typeof candidate?.text !== 'string') return false
  const map = candidate.sourceMap
  if (!map || map.version !== 1 || map.unit !== 'utf16' || map.sourceLength !== raw.length || map.outputLength !== candidate.text.length
    || !Array.isArray(map.spans)) return false
  let at = 0
  for (const span of map.spans) {
    if (!Number.isSafeInteger(span?.outputStart) || span.outputStart !== at || !Number.isSafeInteger(span.outputEnd) || span.outputEnd <= at) return false
    const piece = candidate.text.slice(span.outputStart, span.outputEnd)
    if (span.sourceStart !== undefined || span.sourceEnd !== undefined) {
      if (!Number.isSafeInteger(span.sourceStart) || !Number.isSafeInteger(span.sourceEnd) || span.sourceStart! < 0
        || span.sourceEnd! > raw.length || span.sourceEnd! - span.sourceStart! !== piece.length
        || raw.slice(span.sourceStart, span.sourceEnd) !== piece || span.generated !== undefined) return false
    } else if (typeof span.generated !== 'string') return false
    at = span.outputEnd
  }
  return at === candidate.text.length
}

/** Every diagnostic line of the input is still a line of the output. */
export function keepsDiagnostics(raw: string, text: string): boolean {
  const kept = new Set(sourceLines(text).map(line => line.text.replace(ANSI, '').trim()))
  for (const line of sourceLines(raw)) {
    if (DIAGNOSTIC.test(line.text) && !kept.has(line.text.replace(ANSI, '').trim())) return false
  }
  return true
}

/**
 * A rule's own text (a `generate` span) is limited to omission notes such as
 * "[120 progress lines omitted]" and separators: everything else in a
 * learned projection is copied from the output. A rule therefore cannot put
 * words of its own in front of the model.
 */
const NOTE = /^\[\d+ [A-Za-z0-9 ,.'()/_-]{1,80} omitted\]\n?$/u
const MAX_GENERATED_CHARS = 1024
export function generatedTextAllowed(map: SourceMap, text: string): boolean {
  let total = 0
  for (const span of map.spans) {
    if (span.generated === undefined) continue
    const piece = text.slice(span.outputStart, span.outputEnd)
    total += piece.length
    if (total > MAX_GENERATED_CHARS || !(piece === '\n' || NOTE.test(piece))) return false
  }
  return true
}

/** Runs in the worker thread: compiles the rules and answers `project` requests in a fresh context each time. */
const WORKER = String.raw`
'use strict';
const { workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { port, shared, prelude, rules, timeout } = workerData;
const reply = message => { port.postMessage(message); Atomics.store(shared, 0, 1); Atomics.notify(shared, 0); };
let prepared;
try {
  prepared = {
    prelude: new vm.Script(prelude, { filename: 'tokenwise-prelude.js' }),
    rules: rules.map(rule => ({
      id: rule.id,
      load: new vm.Script('__load(' + JSON.stringify(rule.id) + ')'),
      source: new vm.Script(rule.source, { filename: rule.file }),
      loaded: new vm.Script('__loaded(' + JSON.stringify(rule.id) + ')'),
      call: new vm.Script('__call(' + JSON.stringify(rule.id) + ')'),
    })),
  };
} catch (error) { prepared = { error: String(error && error.message || error) }; }
// A fresh context for every request: nothing a rule keeps survives into the next output.
const fresh = () => {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  prepared.prelude.runInContext(context, { timeout });
  for (const rule of prepared.rules) {
    rule.load.runInContext(context, { timeout });
    rule.source.runInContext(context, { timeout });
    rule.loaded.runInContext(context, { timeout });
  }
  return context;
};
port.on('message', message => {
  try {
    if (prepared.error) return reply({ error: prepared.error });
    const context = fresh();
    if (message.type === 'load') return reply({ ok: true });
    const failed = [];
    for (let index = message.from; index < prepared.rules.length; index++) {
      if (message.skip.includes(index)) continue;
      let output;
      try {
        context.__input = message.json;
        output = prepared.rules[index].call.runInContext(context, { timeout });
      } catch { failed.push(index); continue; }
      if (output === 'null') continue;
      if (typeof output !== 'string') { failed.push(index); continue; }
      return reply({ index, output, failed });
    }
    reply({ index: -1, failed });
  } catch (error) { reply({ error: String(error && error.message || error) }); }
});
`

interface WorkerReply { readonly ok?: true; readonly error?: string; readonly index?: number; readonly output?: string; readonly failed?: readonly number[] }

/** A worker thread with a memory limit, called synchronously with a deadline. */
class RuleWorker {
  private worker: Worker | undefined
  private port: MessagePort | undefined
  private readonly shared = new Int32Array(new SharedArrayBuffer(4))
  private started = false
  private readonly data: { prelude: string; rules: readonly { id: string; file: string; source: string }[]; timeout: number }
  constructor(data: RuleWorker['data']) {
    this.data = data
  }

  private start(): void {
    const { port1, port2 } = new MessageChannel()
    this.port = port1
    this.worker = new Worker(WORKER, {
      eval: true,
      workerData: { port: port2, shared: this.shared, ...this.data },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, stderr: true,
    })
    this.worker.on('error', () => this.stop())
    this.worker.unref()
    port1.unref()
    this.started = false
  }

  /** The reply, or undefined when the deadline passed (the worker is then stopped). */
  call(message: unknown, deadlineMs: number): WorkerReply | undefined {
    if (!this.worker) this.start()
    // The first request also waits for the thread to start.
    const budget = this.started ? deadlineMs : deadlineMs + 1500
    Atomics.store(this.shared, 0, 0)
    this.port!.postMessage(message)
    const waited = Atomics.wait(this.shared, 0, 0, budget)
    const received = receiveMessageOnPort(this.port!)
    if (waited === 'timed-out' && received === undefined) { this.stop(); return undefined }
    this.started = true
    return received?.message as WorkerReply | undefined
  }

  stop(): void {
    const worker = this.worker
    this.worker = undefined
    this.port?.close()
    this.port = undefined
    if (worker) void worker.terminate().catch(() => {})
  }
}

/**
 * Compile a rule directory. Throws {@link RuleDirectoryError} when the
 * directory is malformed or a rule file fails to load; a loaded set never
 * throws while projecting.
 *
 * Rules run in a worker thread (96 MB heap), in a fresh V8 context for every
 * output, each call limited to `timeoutMs`. A request the worker does not
 * answer in time stops the worker; after three such stops, or five failures
 * of one rule, that set or rule is not used again in this process.
 */
export function compileLearnedRules(files: readonly RuleFile[], options: { timeoutMs?: number } = {}): LearnedRuleSet {
  const timeout = options.timeoutMs ?? 100
  const rules = parseRuleIndex(files)
  const hash = ruleDirectoryHash(files)
  const worker = new RuleWorker({ prelude: PRELUDE, timeout,
    rules: rules.map(rule => ({ id: rule.id, file: rule.file, source: files.find(file => file.path === rule.file)!.text })) })
  // Each script inside the worker is limited to `timeout`; this wait mostly covers starting the worker thread,
  // which on a busy machine took over a second and failed a whole learning run (seen in a real run).
  const loaded = worker.call({ type: 'load' }, Math.max(5000, timeout * (rules.length * 3 + 2) + 500))
  if (!loaded?.ok) {
    worker.stop()
    throw new RuleDirectoryError(`loading rules failed: ${loaded?.error ?? 'timed out'}`)
  }
  const failures = new Map<string, number>()
  const fail = (index: number) => { const id = rules[index]!.id; failures.set(id, (failures.get(id) ?? 0) + 1) }
  let stops = 0
  const deadline = timeout * (rules.length + 3) + 200

  const project = (input: FilterInput): LearnedCandidate | undefined => {
    const raw = input.stdout
    if (stops >= 3 || raw.length === 0 || raw.length > MAX_INPUT_CHARS || /\0/u.test(raw)) return undefined
    // File contents and what the agent looked up (a search, a listing, a diff) are what it asked to see: no learned rule shortens them.
    if (readsFileContent(input.command) || looksUp(input.command)) return undefined
    const payload: LearnedRuleInput = { kind: 'shell', command: input.command, argv: literalCommand(input.command) ?? null, raw, exitCode: input.exitCode, stream: 'stdout' }
    let json: string
    try { json = JSON.stringify(payload) } catch { return undefined }
    let from = 0
    while (from < rules.length) {
      const skip = rules.flatMap((rule, index) => (failures.get(rule.id) ?? 0) >= 5 ? [index] : [])
      let reply: WorkerReply | undefined
      try { reply = worker.call({ type: 'project', json, from, skip }, deadline) } catch { reply = undefined }
      if (!reply || reply.error !== undefined) {
        // No answer in time (a rule hung or ran out of memory) or a broken context: blame the rule being tried.
        stops++
        if (from < rules.length) fail(from)
        return undefined
      }
      for (const index of reply.failed ?? []) fail(index)
      const index = reply.index ?? -1
      if (index < 0 || typeof reply.output !== 'string') return undefined
      from = index + 1
      const rule = rules[index]!
      if (reply.output.length > raw.length * 2 + 65_536) { fail(index); continue }
      let result: unknown
      try { result = JSON.parse(reply.output) } catch { fail(index); continue }
      if ((result as { error?: unknown }).error !== undefined || !validMappedProjection(raw, result)) { fail(index); continue }
      const mapped = result as MappedProjection
      if (!generatedTextAllowed(mapped.sourceMap, mapped.text)) { fail(index); continue }
      // A rule that drops a diagnostic, or changes nothing, abstains.
      if (mapped.text === raw || mapped.text.trim() === '' || !keepsDiagnostics(raw, mapped.text)) continue
      return { filter: 'learned-rule', transformation: rule.transformation, rule: rule.id, text: mapped.text, sourceMap: mapped.sourceMap }
    }
    return undefined
  }
  return { hash, rules, project, failures, dispose: () => worker.stop() }
}
