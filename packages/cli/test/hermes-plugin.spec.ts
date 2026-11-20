import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const adapter = fileURLToPath(new URL('../../../adapters/hermes/', import.meta.url))
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-hermes-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const python = ['python3', 'python'].find(name => spawnSync(name, ['-c', 'import sys; assert sys.version_info >= (3, 9)']).status === 0)

/** Run Python with the plugin importable, the way Hermes imports `~/.hermes/plugins/tokenwise`. */
function plugin(code: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(python!, ['-I', '-B', '-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(adapter)})\nimport tokenwise as tokenwise\n${code}`],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

/** A stand-in `tokenwise` that records what it was sent and answers like `tokenwise hook hermes`. */
function stub(reply: string, status = 0) {
  const dir = temp()
  const script = join(dir, 'tokenwise')
  writeFileSync(script, `#!/bin/sh\necho "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\nprintf '%s' '${reply}'\nexit ${status}\n`)
  chmodSync(script, 0o755)
  return { script, sent: () => JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8')), argv: () => readFileSync(join(dir, 'argv'), 'utf8').trim() }
}

const output = 'x'.repeat(300)

describe.skipIf(!python)('Hermes plugin', () => {
  it('registers both hooks, and hands the terminal output to tokenwise hook hermes under its session', () => {
    const tokenwise = stub('{"output": "projected"}')
    const result = plugin(`
hooks = []
class Ctx:
    def register_hook(self, name, fn): hooks.append(name)
tokenwise.register(Ctx())
tokenwise._remember_session(tool_name="terminal", session_id="sess-1", tool_call_id="call-1", args={})
print(json.dumps({"hooks": hooks, "out": tokenwise._transform(command="pytest", output=${JSON.stringify(output)}, returncode=1, task_id="default", env_type="local", tool_call_id="call-1")}))`,
    { TOKENWISE_BIN: tokenwise.script })
    expect(JSON.parse(result)).toEqual({ hooks: ['pre_tool_call', 'transform_terminal_output', 'transform_tool_result'], out: 'projected' })
    expect(tokenwise.argv()).toBe('hook hermes')
    expect(tokenwise.sent()).toMatchObject({ hook_event_name: 'transform_terminal_output', command: 'pytest', output, returncode: 1,
      session_id: 'sess-1', task_id: 'default', tool_call_id: 'call-1', env_type: 'local' })
  })

  it('fails open: short output, background output, no tokenwise, a failing or empty reply all leave the output alone', () => {
    const ok = stub('{"output": "projected"}')
    const run = (args: string, env: NodeJS.ProcessEnv) => plugin(`print(json.dumps(tokenwise._transform(${args})))`, env)
    expect(run(`command="pytest", output="short", returncode=0`, { TOKENWISE_BIN: ok.script })).toBe('null')
    expect(run(`command="pytest", output=${JSON.stringify(output)}, returncode=None`, { TOKENWISE_BIN: ok.script })).toBe('null')
    expect(run(`command="pytest", output=${JSON.stringify(output)}, returncode=0`, { TOKENWISE_BIN: ok.script, TOKENWISE_DISABLE: '1' })).toBe('null')
    expect(run(`command="pytest", output=${JSON.stringify(output)}, returncode=0`, { TOKENWISE_BIN: join(temp(), 'missing') })).toBe('null')
    expect(run(`command="pytest", output=${JSON.stringify(output)}, returncode=0`, { TOKENWISE_BIN: stub('{"output": "projected"}', 1).script })).toBe('null')
    expect(run(`command="pytest", output=${JSON.stringify(output)}, returncode=0`, { TOKENWISE_BIN: stub('').script })).toBe('null')
    expect(run(`command="pytest", output=${JSON.stringify(output)}, returncode=0`, { TOKENWISE_BIN: stub('not json').script })).toBe('null')
    // A background process's tail (Hermes passes no env_type for it), even once it exited with a code.
    expect(run(`command="pytest", output=${JSON.stringify(output)}, returncode=0, env_type=""`, { TOKENWISE_BIN: ok.script })).toBe('null')
  }, 30_000) // Eight Python processes: past the default 5 s on a loaded machine.

  it('hands a finished background process\'s complete output (process_manage wait) to tokenwise, and keeps the rest of the result', () => {
    const tokenwise = stub('{"output": "projected"}')
    const exited = { status: 'exited', command: 'pytest -v', exit_code: 1, completion_reason: 'exited', termination_source: '', output }
    const run = (value: unknown, args: Record<string, unknown> = { action: 'wait', session_id: 'proc_1' }, tool = 'process_manage') =>
      JSON.parse(plugin(`print(json.dumps(tokenwise._transform_result(tool_name=${JSON.stringify(tool)}, args=json.loads(${JSON.stringify(JSON.stringify(args))}), result=${JSON.stringify(JSON.stringify(value))}, session_id="sess-1", tool_call_id="call-9")))`,
        { TOKENWISE_BIN: tokenwise.script })) as string | null
    expect(JSON.parse(run(exited)!)).toEqual({ ...exited, output: 'projected' })
    expect(tokenwise.sent()).toMatchObject({ hook_event_name: 'process_output', command: 'pytest -v', output, returncode: 1, session_id: 'sess-1', tool_call_id: 'call-9' })
    // Only the whole output of a process that exited on its own, read with wait.
    expect(run({ ...exited, output_cut: 21_893 })).toBeNull()
    expect(run({ ...exited, completion_reason: 'killed' })).toBeNull()
    expect(run({ ...exited, status: 'timeout' })).toBeNull()
    expect(run({ ...exited, exit_code: null })).toBeNull()
    expect(run({ ...exited, detached: true })).toBeNull()
    expect(run(exited, { action: 'poll', session_id: 'proc_1' })).toBeNull()
    expect(run(exited, { action: 'wait' }, 'terminal')).toBeNull()
  }, 30_000)

  it('posts the startup notice into the session that started, when Hermes can post', () => {
    const tokenwise = stub('TokenWise: output from make keeps coming back long.')
    const result = plugin(`ARGV_PATH = ${JSON.stringify(join(tokenwise.script, '..', 'argv'))}
import threading, time
hooks, posted, done = {}, [], threading.Event()
class Handle:
    ok = True
class Ctx:
    def register_hook(self, name, fn): hooks[name] = fn
    def post_message(self, text): posted.append(text); return Handle()
tokenwise.register(Ctx())
hooks["on_session_start"](session_id="s1", model="m", platform="cli")
for _ in range(100):
    if posted and __import__("os").path.exists(ARGV_PATH) and open(ARGV_PATH).read().strip() == "notice hermes --told": break
    time.sleep(0.1)
class Old:
    def register_hook(self, name, fn): hooks.setdefault("old", []).append(name)
tokenwise.register(Old())
print(json.dumps({"hooks": sorted(k for k in hooks if k != "old"), "old": hooks["old"], "posted": posted}))`, { TOKENWISE_BIN: tokenwise.script })
    // A Hermes without post_message gets no session hook.
    expect(JSON.parse(result)).toEqual({ hooks: ['on_session_start', 'post_llm_call', 'pre_tool_call', 'transform_terminal_output', 'transform_tool_result'],
      old: ['pre_tool_call', 'transform_terminal_output', 'transform_tool_result'],
      posted: ['TokenWise: output from make keeps coming back long.'] })
    // Told only once posted.
    expect(tokenwise.argv()).toBe('notice hermes --told')
    const refused = stub('TokenWise: hello')
    plugin(`
class Handle:
    ok = False
class Ctx:
    def register_hook(self, name, fn):
        if name == "on_session_start": self.start = fn
    def post_message(self, text): return Handle()
ctx = Ctx()
tokenwise.register(ctx)
import threading
ctx.start(session_id="s2")
for t in threading.enumerate():
    if t.name == "tokenwise-notice": t.join(10)`, { TOKENWISE_BIN: refused.script })
    expect(refused.argv()).toBe('notice hermes --peek')
    // Nothing to say, or no tokenwise: nothing is posted.
    expect(plugin('print(tokenwise._notice())', { TOKENWISE_BIN: stub('').script })).toBe('None')
    expect(plugin('print(tokenwise._notice())', { TOKENWISE_BIN: join(temp(), 'missing') })).toBe('None')
  }, 60_000)

  it('posts what the conversation saved when a turn ends, told only once a surface showed it', () => {
    const run = (delivered: string) => {
      const tokenwise = stub('TokenWise saved 2,973 tokens in this conversation (tool output 90% shorter)')
      const result = plugin(`ARGV_PATH = ${JSON.stringify(join(tokenwise.script, '..', 'argv'))}
posted = []
class Handle:
    ok = True
    result = {"ok": True, "delivered": ${delivered}}
class Ctx:
    def register_hook(self, name, fn):
        if name == "post_llm_call": self.end = fn
    def post_message(self, text): posted.append(text); return Handle()
ctx = Ctx()
tokenwise.register(ctx)
ctx.end(session_id="s1", platform="cli")
print(json.dumps(posted))`, { TOKENWISE_BIN: tokenwise.script })
      return { posted: JSON.parse(result), argv: tokenwise.argv() }
    }
    // Posted before the hook returns, while the turn is open. Shown: told. Not delivered: left for a later turn.
    expect(run('True')).toEqual({ posted: ['TokenWise saved 2,973 tokens in this conversation (tool output 90% shorter)'], argv: 'notice hermes --session s1 --told' })
    expect(run('False')).toEqual({ posted: ['TokenWise saved 2,973 tokens in this conversation (tool output 90% shorter)'], argv: 'notice hermes --session s1 --peek' })
  }, 30_000)

  it('declares its hooks in the manifest Hermes reads', () => {
    const manifest = readFileSync(join(adapter, 'tokenwise', 'plugin.yaml'), 'utf8')
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
    expect(manifest).toContain('name: tokenwise\n')
    expect(manifest).toContain(`version: "${version}"\n`)
    expect(manifest).toContain('provides_hooks:\n  - pre_tool_call\n  - transform_terminal_output\n  - transform_tool_result\n  - on_session_start\n  - post_llm_call\n')
  })
})

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))

/** The real `tokenwise` (this checkout's source), as Hermes would find it. */
function realLc(home: string) {
  const script = join(temp(), 'tokenwise')
  writeFileSync(script, `#!/bin/sh\nTOKENWISE_HOME='${home}' exec '${process.execPath}' --conditions=source '${main}' "$@"\n`)
  chmodSync(script, 0o755)
  return script
}

/**
 * A stand-in for Hermes's `agent.context_compressor` with the call order of the real one (0.22.5): shorten the
 * tool results in the head, build the summary prompt, then assemble head + summary + tail.
 */
function fakeHermes() {
  const dir = temp()
  for (const pkg of ['agent', 'hermes_cli']) { mkdirSync(join(dir, pkg)); writeFileSync(join(dir, pkg, '__init__.py'), '') }
  writeFileSync(join(dir, 'hermes_cli', 'config.py'), 'def load_config_readonly():\n    return {"context": {"engine": "tokenwise"}}\n')
  writeFileSync(join(dir, 'agent', 'context_compressor.py'), `import json
class ContextCompressor:
    def __init__(self, model="", quiet_mode=False, threshold_percent=0.5, protect_first_n=3):
        self._session_id = "sess-9"
    def compress(self, messages, current_tokens=None, focus_topic=None, force=False, memory_context="", bypass_cooldown=False):
        pruned = [dict(m) for m in messages]
        pruned[1]["content"] = "[terminal] ran cat head.log -> exit 0, 300 lines output"
        self.last_prompt = self._build_summary_prompt("window", 100, None, "", True)
        return self._assemble_compressed(pruned, 2, len(pruned) - 1, None, "Hermes summary of the window.")
    def _build_summary_prompt(self, content_to_summarize, summary_budget, focus_topic, memory_context, has_user_turn):
        return "BASE PROMPT"
    def _assemble_compressed(self, messages, compress_start, compress_end, scan, summary):
        return messages[:compress_start] + [{"role": "user", "content": summary, "_compressed_summary": True}] + messages[compress_end:]
    def get_tool_schemas(self):
        return []
    def handle_tool_call(self, name, args, **kwargs):
        return json.dumps({"error": "unknown tool"})
def is_compaction_summary_message(message):
    return isinstance(message, dict) and message.get("_compressed_summary") is True
`)
  return dir
}

const rows = (tag: string) => Array.from({ length: 300 }, (_, i) => `${tag} ${i}: ${(i * 7919) % 10007}`).join('\\n')
const history = `[
  {"role": "assistant", "content": "", "tool_calls": [{"id": "c0", "type": "function", "function": {"name": "terminal", "arguments": "{\\"command\\": \\"cat head.log\\"}"}}]},
  {"role": "tool", "tool_call_id": "c0", "name": "terminal", "content": "${rows('head')}"},
  {"role": "user", "content": "Now look at the build log."},
  {"role": "assistant", "content": "Reading it.", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "terminal", "arguments": "{\\"command\\": \\"cat build.log\\"}"}}]},
  {"role": "tool", "tool_call_id": "c1", "name": "terminal", "content": "${rows('build')}"},
  {"role": "user", "content": "What failed?"}
]`

describe.skipIf(!python)('Hermes plugin: LightShadow context engine', () => {
  it('keeps Hermes\'s summary, appends the catalog, marks the shortened head result and recalls it', () => {
    const home = temp(), fakes = fakeHermes()
    const result = plugin(`
sys.path.insert(0, ${JSON.stringify(fakes)})
engines = []
class Ctx:
    def register_hook(self, name, fn): pass
    def register_context_engine(self, engine): engines.append(engine)
tokenwise.register(Ctx())
engine = engines[0]
out = engine.compress(json.loads(${JSON.stringify(history)}))
summary = next(m["content"] for m in out if m.get("_compressed_summary"))
ids = __import__("re").findall(r"observation_id: (o-[a-f0-9]{12})", summary)
recall = json.loads(engine.handle_tool_call("tokenwise_recall", {"observation_id": ids[0], "query": "head 250:"}))
print(json.dumps({"name": engine.name, "prompt": engine.last_prompt, "summary": summary, "head": out[1]["content"], "ids": ids,
  "tools": [t["name"] for t in engine.get_tool_schemas()], "recall": recall}))`, { TOKENWISE_BIN: realLc(home) })
    const parsed = JSON.parse(result)
    expect(parsed.name).toBe('tokenwise')
    expect(parsed.prompt).toMatch(/^BASE PROMPT\n\nAfter this compaction every tool result/u)
    expect(parsed.summary).toMatch(/^Hermes summary of the window\./u)
    // Hermes already keeps the user's messages; TokenWise does not add a second copy.
    expect(parsed.summary).not.toContain('User messages (verbatim)')
    expect(parsed.ids).toHaveLength(2)
    expect(parsed.head).toMatch(/\[full output: tokenwise_recall o-[a-f0-9]{12}\]$/u)
    expect(parsed.tools).toEqual(['tokenwise_recall'])
    expect(parsed.recall.result).toContain(`head 250: ${(250 * 7919) % 10007}`)
  })

  it('fails open to Hermes\'s own compaction without tokenwise, and registers no engine unless chosen', () => {
    const fakes = fakeHermes()
    const result = plugin(`
sys.path.insert(0, ${JSON.stringify(fakes)})
engines = []
class Ctx:
    def register_hook(self, name, fn): pass
    def register_context_engine(self, engine): engines.append(engine)
tokenwise.register(Ctx())
out = engines[0].compress(json.loads(${JSON.stringify(history)}))
import hermes_cli.config as cfg
cfg.load_config_readonly = lambda: {"context": {"engine": "compressor"}}
tokenwise.register(Ctx())
print(json.dumps({"summary": next(m["content"] for m in out if m.get("_compressed_summary")), "engines": len(engines)}))`, { TOKENWISE_BIN: join(temp(), 'missing') })
    expect(JSON.parse(result)).toEqual({ summary: 'Hermes summary of the window.', engines: 1 })
  })

  it('carries the same summary instruction and recall tool as the TypeScript core', async () => {
    const { SHADOW_ASSISTED_INSTRUCTION, RECALL_TOOL_DESCRIPTION, RECALL_INPUT_SCHEMA } = await import('@tokenwise/mechanisms')
    const parsed = JSON.parse(plugin('from tokenwise import shadow\nprint(json.dumps([shadow.SUMMARY_INSTRUCTION, shadow.RECALL_DESCRIPTION, shadow.RECALL_PARAMETERS]))'))
    expect(parsed).toEqual([SHADOW_ASSISTED_INSTRUCTION, RECALL_TOOL_DESCRIPTION, RECALL_INPUT_SCHEMA])
  })
})
