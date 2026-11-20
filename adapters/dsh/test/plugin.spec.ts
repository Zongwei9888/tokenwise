import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, apply, inject, name } from '../src/index.ts'
import type { CommandRuntime, ConnectionRuntime, HostContext, PostToolDecision, ToolExecution, ToolExecutionResult } from '../src/host.ts'
import { bashResult, pytestOutput } from './render.ts'

let home: string
const saved = process.env.TOKENWISE_HOME
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tokenwise-dsh-plugin-')); process.env.TOKENWISE_HOME = home })
afterEach(() => {
  if (saved === undefined) delete process.env.TOKENWISE_HOME
  else process.env.TOKENWISE_HOME = saved
  rmSync(home, { recursive: true, force: true })
})

type Listener = (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>

function fakeContext() {
  const listeners: { listener: Listener }[] = []
  const others: { event: string; listener: (...args: any[]) => unknown; options?: unknown }[] = []
  const tools: Parameters<NonNullable<HostContext['tools']>['register']>[0][] = []
  const commands: Parameters<CommandRuntime['register']>[0][] = []
  const disposers: (() => void)[] = []
  const warnings: string[] = []
  const routes: Parameters<ConnectionRuntime['fetch']['register']>[0][] = []
  const ctx: HostContext = {
    on: ((event: string, listener: (...args: any[]) => unknown, options?: unknown) => {
      if (event === 'tools/post-execute') listeners.push({ listener: listener as Listener })
      else others.push({ event, listener, options })
      return () => {}
    }) as HostContext['on'],
    tools: { register: definition => { tools.push(definition); return () => {} } },
    inject: (deps, callback) => {
      expect([['commands'], ['connection']]).toContainEqual(deps)
      callback({ ...ctx, commands: { register: definition => { commands.push(definition); return () => {} } },
        connection: { fetch: { register: route => { routes.push(route); return async () => {} } } } })
    },
    effect: execute => { disposers.push(execute()) },
    logger: { warn: message => warnings.push(message), info: () => {} },
  }
  return { ctx, listeners, others, tools, commands, disposers, warnings, routes }
}

const live = <T>(value: T) => ({ get: () => value })
const call: ToolExecution = { callId: 'c1', name: 'bash', arguments: { command: 'pytest -v' }, agent: { session: { id: 's1' } } }

describe('DSH plugin entry', () => {
  it('declares what cordis needs to load it', () => {
    expect(name).toBe('tokenwise')
    expect(inject).toEqual(['tools'])
    // The Loader resolves `mode` to a live reference; `get()` reads the current value.
    expect(Config({}).mode.get()).toBe('apply')
    expect(Config({}).inlineLimitChars).toBe(48_000)
    expect(Config({ mode: 'observe' }).mode.get()).toBe('observe')
    expect(() => Config({ mode: 'fast' as 'off' })).toThrow()
  })
  it('joins the post-execute waterfall innermost and filters the bash result itself', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx, { mode: live('apply'), inlineLimitChars: 48_000 })
    expect(listeners).toHaveLength(1)
    const result = bashResult({ stdout: pytestOutput(60) })
    const decision = await listeners[0]!.listener(call, result, async () => ({ kind: 'accept' }))
    expect((decision as { content: { text: string }[] }).content[0]!.text).toContain('60 passed')
  })
  it('registers tokenwise_recall and looks for DSH\'s compaction engines whenever an agent starts or steps', async () => {
    const { ctx, others, tools } = fakeContext()
    apply(ctx, { mode: live('apply'), inlineLimitChars: 48_000 })
    expect(tools.map(tool => tool.name)).toEqual(['tokenwise_recall'])
    expect(others.map(item => [item.event, item.options])).toEqual([['agent/created', { global: true }], ['agent/pre-step', { global: true, prepend: true }], ['session/event', { global: true }]])
    // The pre-step listener only looks; it always hands on to DSH.
    await expect(others[1]!.listener({}, async () => 'continued')).resolves.toBe('continued')
    const output = await tools[0]!.execute({ observation_id: 'o-000000000000' }, { callId: 'c', agent: { session: { id: 's1' } } })
    expect(output).toEqual({ text: expect.stringMatching(/^recall failed: unknown observation_id/), ok: false })
    expect(tools[0]!.output.render({}, output)).toEqual([{ type: 'text', text: (output as { text: string }).text }])
  })
  it('declares no recall tool when TokenWise\'s configuration switches LightShadow off', () => {
    process.env.TOKENWISE_COMPACTION = 'off'
    try {
      const { ctx, tools } = fakeContext()
      apply(ctx, { mode: live('apply'), inlineLimitChars: 48_000 })
      expect(tools).toEqual([])
    } finally { delete process.env.TOKENWISE_COMPACTION }
  })
  it('never swallows a downstream failure', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx, { mode: live('apply'), inlineLimitChars: 48_000 })
    await expect(listeners[0]!.listener(call, bashResult({ stdout: 'x' }), () => Promise.reject(new Error('downstream')))).rejects.toThrow('downstream')
  })
  it('registers /tokenwise, which reports this session', async () => {
    const { ctx, listeners, commands } = fakeContext()
    apply(ctx, { mode: live('apply'), inlineLimitChars: 48_000 })
    expect(commands.map(command => command.name)).toEqual(['tokenwise'])
    await listeners[0]!.listener(call, bashResult({ stdout: pytestOutput(60) }), async () => ({ kind: 'accept' }))
    const output = await commands[0]!.handler({ agent: { session: { id: 's1' } }, rawInput: '' })
    expect(output.kind).toBe('success')
    expect(output.text).toContain('(1 of 1 outputs filtered)')
  })
})
