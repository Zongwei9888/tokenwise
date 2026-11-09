import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '@tokenwise/store'
import { startDashboard, startLanguage, type DashboardServer } from '../src/dashboard.ts'
import { dashboardPage } from '../src/dashboard-page.ts'
import { frame } from '../src/saved.ts'
import { readSavings, savingsOf, summarize } from '../src/savings.ts'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const dirs: string[] = []
const servers: DashboardServer[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-dashboard-')); dirs.push(dir); return dir }
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) removeTree(dir)
})

/** A decision record as the journal keeps it. */
const record = (host: string, time: string, raw: number, read: number, outcome = 'projected') =>
  JSON.stringify({ schemaVersion: 1, type: 'economy/decision', time, host, sessionId: 's', outcome, raw: { sha256: 'a', bytes: raw * 4, tokens: raw, stored: true }, projected: { sha256: 'b', bytes: read * 4, tokens: read } }) + '\n'
function journal(home: string, host: string, lines: string[]) {
  mkdirSync(join(home, 'journal', host), { recursive: true })
  const file = join(home, 'journal', host, `${Math.random().toString(16).slice(2)}.jsonl`)
  writeFileSync(file, lines.join(''))
  return file
}

/** A project with a pytest that fails one of 151 tests. */
function project() {
  const dir = temp()
  const lines = ['echo "============================= test session starts =============================="', 'echo "collecting ... collected 151 items"', 'echo',
    'i=0; while [ $i -lt 150 ]; do printf "tests/test_v.py::test_parse_%s PASSED                    [%3s%%]\\n" $i $((i*100/151)); i=$((i+1)); done',
    'echo "tests/test_v.py::test_order FAILED                     [100%]"', 'echo', 'echo "=================================== FAILURES ==================================="',
    'echo "E       AssertionError: assert \'1.10.0\' > \'1.9.0\'"', 'echo "========================= 1 failed, 150 passed in 0.12s ========================="', 'exit 1']
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'pytest'), `#!/bin/sh\n${lines.join('\n')}\n`)
  chmodSync(join(dir, 'bin', 'pytest'), 0o755)
  return dir
}
function tokenwise(args: string[], cwd: string, home: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['--conditions=source', main, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh', TOKENWISE_HOME: home, TOKENWISE_DISABLE: '', PATH: `${join(cwd, 'bin')}:${process.env.PATH}`, ...env },
  })
  return result.stdout + result.stderr
}

function get(server: DashboardServer, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method, headers: { host: `127.0.0.1:${server.port}`, ...headers } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}
async function serve(home: string, now?: number) {
  const server = await startDashboard({ env: { HOME: temp(), PATH: '', TOKENWISE_HOME: home }, ...now === undefined ? {} : { now: () => now } })
  servers.push(server)
  return server
}

// Wednesday 2026-11-11, mid-afternoon local time.
const NOW = new Date(2026, 10, 11, 15, 0, 0).getTime()
const at = (daysAgo: number, hour = 12) => new Date(2026, 10, 11 - daysAgo, hour).toISOString()

describe('what TokenWise saved', () => {
  it('counts only shortened outputs: the original minus what the model read, per day, today and per agent', () => {
    const home = temp()
    journal(home, 'claude', [record('claude', at(0, 9), 4000, 400), record('claude', at(1), 3000, 300), record('claude', at(0, 10), 900, 900, 'passed')])
    journal(home, 'copilot', [record('copilot', at(6), 2000, 200), record('copilot', at(8), 50000, 1000)])
    const week = savingsOf([home], 'week', NOW)
    expect(week).toMatchObject({ tokens: 3600 + 2700 + 1800, outputs: 3, today: 3600, agents: ['claude', 'copilot'] })
    expect(week.buckets).toHaveLength(7)
    expect(week.buckets.map(b => b.tokens)).toEqual([1800, 0, 0, 0, 0, 2700, 3600])
    // Eight days ago is outside the week but inside 30 days, where Copilot saved the most.
    expect(savingsOf([home], 'month', NOW)).toMatchObject({ tokens: 3600 + 2700 + 1800 + 49000, agents: ['copilot', 'claude'] })
    expect(savingsOf([home], 'month', NOW).buckets).toHaveLength(30)
    const all = savingsOf([home], 'all', NOW)
    expect(all.buckets.length).toBeGreaterThanOrEqual(6)
    expect(all.buckets.at(-1)!.tokens).toBe(all.tokens)
    expect(summarize([], 'week', NOW)).toMatchObject({ tokens: 0, today: 0, since: null, agents: [] })
  })

  it('reads every data location, and a journal file again only when it changed', () => {
    const a = temp(), b = temp()
    const file = journal(a, 'codex', [record('codex', at(0), 1000, 100)])
    journal(b, 'codex', [record('codex', at(0), 500, 100)])
    expect(summarize(readSavings([a, b]), 'week', NOW).tokens).toBe(1300)
    appendFileSync(file, record('codex', at(0), 700, 200))
    utimesSync(file, new Date(), new Date(Date.now() + 2000))
    expect(summarize(readSavings([a, b]), 'week', NOW).tokens).toBe(1800)
  })

  it('counts what tokenwise run really shortened', () => {
    const cwd = project(), home = temp()
    tokenwise(['run', '--host', 'claude', '-c', 'pytest -v'], cwd, home)
    const week = savingsOf([home], 'week')
    expect(week.outputs).toBe(1)
    expect(week.tokens).toBeGreaterThan(1000)
    expect(week.agents).toEqual(['claude'])
  })
})

describe('tokenwise saved', () => {
  it('draws the jar and the number in the terminal, plain without colour and when piped', () => {
    const cwd = project(), home = temp()
    tokenwise(['run', '--host', 'codex', '-c', 'pytest -v'], cwd, home)
    const out = tokenwise(['saved', '--lang', 'zh'], cwd, home)
    expect(out).toContain('这周，TokenWise 已为你省下')
    expect(out).toContain('来自 1 次被缩短的命令输出')
    expect(out).toContain('在 Codex 里')
    expect(out).toMatch(/[▀▄█]/u)
    // Piped, it neither animates nor colours.
    expect(out).not.toMatch(/\x1b\[/u)
    expect(tokenwise(['saved', '--lang', 'en', '--all'], cwd, home)).toContain('Since you installed it, TokenWise saved you')
    expect(JSON.parse(tokenwise(['saved', '--json'], cwd, home))).toMatchObject({ period: 'week', outputs: 1, agents: ['codex'], tokens: expect.any(Number) })
  })

  it('says what to do when nothing was saved yet', () => {
    const cwd = project(), home = temp()
    expect(tokenwise(['saved', '--lang', 'en'], cwd, home)).toContain('Nothing saved yet.')
    expect(tokenwise(['saved', '--lang', 'xx'], cwd, home)).toContain('--lang is en or zh')
  })

  it('shows the number in pixel digits, rising while coins fall', () => {
    const s = summarize(readSavings([]), 'week', NOW)
    const filled = { ...s, tokens: 412038, outputs: 312, today: 31206, agents: ['claude'], buckets: s.buckets.map((b, i) => ({ ...b, tokens: i * 10 })) }
    const start = frame(filled, { language: 'en', color: true, landed: 0, shown: 0 }).join('\n')
    const end = frame(filled, { language: 'en', color: true, landed: 999, shown: 412038 }).join('\n')
    expect(start).not.toBe(end)
    expect(end).toContain('\x1b[38;2;')
    expect(end).toContain('312')
  })
})

describe('tokenwise dashboard', () => {
  it('answers only on 127.0.0.1, under its own host name, to the token it printed, and only reads', async () => {
    const server = await serve(temp())
    expect(server.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/\\?t=[\\w-]{24}$`, 'u'))
    const t = `t=${server.token}`
    expect((await get(server, `/api/savings?${t}`)).status).toBe(200)
    expect((await get(server, `/api/savings?${t}`, { host: `localhost:${server.port}` })).status).toBe(200)
    // A page elsewhere whose name points at 127.0.0.1 (DNS rebinding) sends its own name.
    expect((await get(server, `/api/savings?${t}`, { host: `evil.example:${server.port}` })).status).toBe(421)
    expect((await get(server, '/api/savings')).status).toBe(403)
    expect((await get(server, '/api/savings?t=wrong')).status).toBe(403)
    expect((await get(server, `/api/savings?${t}`, {}, 'POST')).status).toBe(405)
    expect((await get(server, `/api/savings?${t}&period=year`)).status).toBe(400)
  })

  it('serves the jar page under a nonce, and what was saved per period', async () => {
    const home = temp()
    journal(home, 'claude', [record('claude', at(0, 9), 4000, 400), record('claude', at(20), 10000, 1000)])
    const server = await serve(home, NOW)
    const page = await get(server, `/?t=${server.token}`, { 'accept-language': 'zh-CN,zh;q=0.9' })
    expect(page.status).toBe(200)
    const csp = String(page.headers['content-security-policy'])
    const nonce = /'nonce-([^']+)'/u.exec(csp)![1]!
    expect(csp).toContain("default-src 'none'")
    expect(page.body).toContain(`<script nonce="${nonce}">`)
    expect(page.body).toContain(`<style nonce="${nonce}">`)
    // Inline style attributes would be refused under this policy: the page sets sizes from its script.
    expect(page.body).not.toMatch(/ style=\\?"/u)
    expect(page.body).toContain('<html lang="zh">')
    const week = JSON.parse((await get(server, `/api/savings?t=${server.token}&period=week`)).body)
    expect(week.savings).toMatchObject({ tokens: 3600, today: 3600, outputs: 1, agents: ['claude'] })
    expect(week.all.tokens).toBe(3600 + 9000)
    expect(JSON.parse((await get(server, `/api/savings?t=${server.token}&period=month`)).body).savings.tokens).toBe(12600)
  })

  it('keeps data from breaking out of the page', () => {
    const s = summarize([], 'week', NOW)
    const html = dashboardPage({ nonce: 'n', token: 't', language: 'en', week: { ...s, agents: ['</script><script>alert(1)</script>'] }, all: s })
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script>')
  })

  it('starts in the browser\'s language, else this machine\'s', () => {
    expect(startLanguage('zh-CN,zh;q=0.9')).toBe('zh')
    expect(startLanguage('en-US,en;q=0.9', 'zh-CN')).toBe('en')
    expect(startLanguage(undefined, 'zh-Hans-CN')).toBe('zh')
    expect(startLanguage(undefined, 'de-DE')).toBe('en')
  })
})
