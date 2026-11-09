/**
 * `tokenwise dashboard`: a page on this machine that shows what TokenWise
 * saved you, filling a jar as it saves more. It only reads TokenWise's data,
 * listens on 127.0.0.1 only, answers only its own host name, and needs the
 * random token in the address it prints.
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { cliContext } from './context.ts'
import { dashboardPage } from './dashboard-page.ts'
import { PERIODS, readSavings, summarize, type Period } from './savings.ts'

export interface DashboardServer {
  readonly url: string
  readonly port: number
  readonly token: string
  close(): Promise<void>
}

function send(response: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...extra })
  response.end(body)
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** The language to start in: the browser's first choice, else this machine's. */
export function startLanguage(acceptLanguage: string | undefined, locale = Intl.DateTimeFormat().resolvedOptions().locale): 'en' | 'zh' {
  const first = acceptLanguage?.split(',')[0]?.trim() || locale
  return /^zh\b/iu.test(first) ? 'zh' : 'en'
}

export async function startDashboard(options: { port?: number; env?: NodeJS.ProcessEnv; now?: () => number } = {}): Promise<DashboardServer> {
  const env = options.env ?? process.env
  const dirs = cliContext({ env }).dataDirs
  const now = options.now ?? Date.now
  const token = randomBytes(18).toString('base64url')
  let port = 0
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    // Only this machine's own name for the server: a page elsewhere that points its own name at 127.0.0.1 gets nothing.
    const host = request.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { send(response, 421, '{"error":"wrong host"}'); return }
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (!same(url.searchParams.get('t') ?? '', token)) { send(response, 403, '{"error":"open the address tokenwise dashboard printed"}'); return }
    if (request.method !== 'GET') { send(response, 405, '{"error":"read only"}'); return }
    try {
      const saved = readSavings(dirs), at = now()
      if (url.pathname === '/') {
        const nonce = randomBytes(16).toString('base64')
        send(response, 200, dashboardPage({ nonce, token, language: startLanguage(request.headers['accept-language']),
          week: summarize(saved, 'week', at), all: summarize(saved, 'all', at) }), 'text/html; charset=utf-8', {
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        })
      } else if (url.pathname === '/api/savings') {
        const period = (url.searchParams.get('period') ?? 'week') as Period
        if (!PERIODS.includes(period)) { send(response, 400, '{"error":"period is week, month or all"}'); return }
        send(response, 200, JSON.stringify({ savings: summarize(saved, period, at), all: summarize(saved, 'all', at) }))
      } else send(response, 404, '{"error":"not found"}')
    } catch (error) {
      send(response, 500, JSON.stringify({ error: String((error as Error).message ?? error) }))
    }
  }
  const server: Server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/?t=${token}`, port, token,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

function openBrowser(url: string): void {
  const [command, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  try { spawn(command!, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch { /* The address is printed anyway. */ }
}

export async function dashboard(options: { port?: number; open: boolean }): Promise<number> {
  let server: DashboardServer
  try {
    server = await startDashboard(options.port === undefined ? {} : { port: options.port })
  } catch (error) {
    process.stderr.write(`tokenwise dashboard: ${(error as Error).message}\n`)
    return 1
  }
  process.stdout.write(`TokenWise dashboard: ${server.url}\nIt only reads TokenWise's data, on this machine. Stop it with Ctrl-C.\n`)
  if (options.open) openBrowser(server.url)
  await new Promise<void>(resolve => {
    const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void server.close().then(resolve) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  return 0
}
