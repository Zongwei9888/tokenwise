/**
 * The part of DeepSeek Harness 0.2.x this plugin touches, declared locally so
 * the package builds and tests without the harness's type graph. Each shape
 * mirrors `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-commands` and
 * `@deepseek-ai/cordis` 0.2.0-rc.2 / 0.2.1-alpha.2; the end-to-end suite runs
 * the published harness to keep them honest.
 */

export interface TextBlock { readonly type: 'text'; readonly text: string }
export type ContentBlock = TextBlock | { readonly type: string; readonly [key: string]: unknown }

/** `@deepseek-ai/dsh-session` Session, as far as TokenWise reads it. */
export interface HostSession {
  readonly id: string
  readonly header?: {
    readonly cwd?: string
    /** The session that started this one; with `origin: 'subagent'` it is the delegating parent. */
    readonly parentSession?: string
    readonly origin?: string
  }
}

/** `@deepseek-ai/dsh-tools` ToolExecution. */
export interface ToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly id?: string; readonly session?: HostSession }
  /** Set on `run_code` sub-dispatches; the program, not the model, receives their value. */
  readonly parent?: unknown
}

export type ToolExecutionResult =
  | { readonly isError: false; readonly value: unknown; readonly content: readonly ContentBlock[] }
  | { readonly isError: true; readonly content: readonly ContentBlock[] }

export type PostToolDecision =
  | { readonly kind: 'accept'; readonly content?: readonly ContentBlock[]; readonly value?: never; readonly additionalContexts?: readonly unknown[] }
  | { readonly kind: 'accept'; readonly value: unknown; readonly content?: never; readonly additionalContexts?: readonly unknown[] }
  | { readonly kind: 'block'; readonly feedback: readonly ContentBlock[]; readonly additionalContexts?: readonly unknown[] }

/** The canonical value of a finished foreground `bash` call. */
export interface BashForegroundValue {
  readonly kind: 'foreground'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stopped?: string
  readonly stdout: { readonly text: string; readonly truncated: boolean }
  readonly stderr: { readonly text: string; readonly truncated: boolean }
  readonly sandbox?: { readonly denied: boolean; readonly runnerFailed?: boolean }
}

/** `@deepseek-ai/dsh-commands` CommandInvocation and CommandResult. */
export interface CommandInvocation { readonly agent: { readonly session: HostSession }; readonly rawInput: string }
export type CommandResult = { readonly kind: 'success' | 'error'; readonly text: string }

export interface CommandRuntime {
  register(definition: {
    readonly definitionId?: string
    readonly name: string
    readonly description: string
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

/** `@deepseek-ai/cordis` Volatile<T>: a live configuration value. */
export interface Volatile<T> { get(): T }

/** `@deepseek-ai/dsh-tools` ToolDefinition, as TokenWise registers one. */
export interface HostToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: { readonly schema: Record<string, unknown>; render(args: unknown, value: unknown): ContentBlock[] }
  execute(args: unknown, exec: { readonly callId: string; readonly agent?: { readonly session?: HostSession }; readonly signal?: AbortSignal }): Promise<unknown>
}

export interface ToolRuntime { register(definition: HostToolDefinition): () => void }

/** The slice of a cordis Context the plugin uses. */
export interface HostContext {
  on(name: 'tools/post-execute',
    listener: (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>): () => void
  on(name: 'agent/created', listener: (payload: unknown) => undefined, options: { global: true }): () => void
  /** Every event appended to a session's log (`turn/end` closes a turn). */
  on(name: 'session/event', listener: (session: { readonly id?: unknown; readonly header?: { readonly origin?: string } } | undefined,
    event: { readonly type?: string } | undefined) => void, options: { global: true }): () => void
  on(name: 'agent/pre-step', listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>, options: { global: true; prepend: true }): () => void
  /** The event bus; LightShadow reads its listener list to find DSH's compaction engines. */
  readonly events?: unknown
  readonly tools?: ToolRuntime
  inject(deps: readonly string[], callback: (ctx: HostContext & { readonly commands: CommandRuntime; readonly connection: ConnectionRuntime }) => void): void
  /** A service by name, when the composition has it (`agentDefaultModel`, `profileContext`). */
  get?(name: string): unknown
  effect(execute: () => () => void, label?: string): void
  readonly logger: { warn(message: string): void; info(message: string): void }
}

/** `@deepseek-ai/dsh-client-connection` HostConnectionFetch: exact Fetch routes under /api. */
export interface ConnectionRuntime {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** DSH's job registry (the `jobs` service, `@deepseek-ai/dsh-jobs`): a job's view, with how many bytes it has output so far. */
export interface JobRegistry {
  get(id: string, caller?: string): { readonly output?: { readonly total?: unknown } }
}
