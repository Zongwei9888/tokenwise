/**
 * `tokenwise saved`: what TokenWise saved you, in the terminal. A pixel jar
 * (half-block characters, two pixels per cell) fills with coins, then the
 * tokens saved appear in pixel digits. Plain text when not a terminal.
 */
import { cliContext } from './context.ts'
import { savingsOf, type Period, type Savings, AGENT_NAMES } from './savings.ts'

type Rgb = readonly [number, number, number]
const C = { glass: [104, 136, 128] as Rgb, glint: [190, 216, 208] as Rgb, lid: [74, 104, 96] as Rgb, lidHi: [112, 146, 137] as Rgb,
  rim: [[10, 92, 80], [15, 122, 106], [36, 150, 132]] as Rgb[], face: [[22, 153, 133], [45, 176, 155], [92, 200, 180]] as Rgb[],
  shine: [226, 250, 243] as Rgb, accent: [61, 184, 162] as Rgb, soft: [128, 148, 142] as Rgb }
const W = 32, H = 40
type Grid = (Rgb | null)[][]

/** The jar's inside on each pixel row: [left, right], or null outside the jar. */
function inside(y: number): [number, number] | null {
  if (y < 5) return null
  if (y < 9) return [12, 19]
  if (y < 12) { const w = (y - 8) * 3; return [Math.max(4, 12 - w), Math.min(27, 19 + w)] }
  if (y < H - 3) return [4, 27]
  if (y === H - 3) return [5, 26]
  return null
}
function jar(): Grid {
  const g: Grid = Array.from({ length: H }, () => Array<Rgb | null>(W).fill(null))
  for (let x = 10; x <= 21; x++) { g[0]![x] = C.lidHi; g[1]![x] = C.lid; g[2]![x] = C.lid }
  for (let y = 3; y < H; y++) {
    const r = inside(y), rp = inside(y - 1)
    if (y < 5) { g[y]![11] = C.glass; g[y]![20] = C.glass; continue }
    if (r) { g[y]![r[0] - 1] = C.glass; g[y]![r[1] + 1] = C.glass }
    if (r && rp && r[0] < rp[0]) for (let x = r[0] - 1; x < rp[0]; x++) g[y]![x] = C.glass
    if (r && rp && r[1] > rp[1]) for (let x = rp[1] + 1; x <= r[1] + 1; x++) g[y]![x] = C.glass
    if (!r && rp) for (let x = rp[0]; x <= rp[1]; x++) g[y]![x] = C.glass
  }
  for (let y = 13; y < 24; y++) g[y]![6] = C.glint
  return g
}
// A coin is 4x3 pixels: rim, face and a bright point; rows 3 pixels apart, every other row shifted by 2.
const COIN = ['.rr.', 'rfsr', '.rr.']
interface Slot { readonly x: number; readonly y: number; readonly tone: number }
function slots(rows: number): Slot[] {
  const out: Slot[] = []
  for (let row = 0; row < rows; row++) {
    const y = H - 6 - row * 3, r = inside(y), r2 = inside(y + 2)
    if (!r || !r2) break
    const left = Math.max(r[0], r2[0]) + (row % 2 ? 2 : 0), right = Math.min(r[1], r2[1])
    for (let x = left; x + 3 <= right; x += 4) out.push({ x, y, tone: (x * 5 + row * 7) % 3 })
  }
  return out
}
function coin(g: Grid, x: number, y: number, tone: number, clip = false): void {
  COIN.forEach((line, dy) => [...line].forEach((ch, dx) => {
    const row = g[y + dy], r = inside(y + dy)
    if (!row || ch === '.') return
    if (clip && (!r || x + dx < r[0] || x + dx > r[1])) return
    row[x + dx] = ch === 'r' ? C.rim[tone]! : ch === 'f' ? C.face[tone]! : C.shine
  }))
}

const FONT: Readonly<Record<string, readonly string[]>> = {
  0: ['.##.', '#..#', '#..#', '#..#', '#..#', '.##.'], 1: ['.#.', '##.', '.#.', '.#.', '.#.', '###'], 2: ['.##.', '#..#', '..#.', '.#..', '#...', '####'],
  3: ['###.', '...#', '.##.', '...#', '...#', '###.'], 4: ['#..#', '#..#', '#..#', '####', '...#', '...#'], 5: ['####', '#...', '###.', '...#', '...#', '###.'],
  6: ['.##.', '#...', '###.', '#..#', '#..#', '.##.'], 7: ['####', '...#', '..#.', '.#..', '.#..', '.#..'], 8: ['.##.', '#..#', '.##.', '#..#', '#..#', '.##.'],
  9: ['.##.', '#..#', '#..#', '.###', '...#', '.##.'], ',': ['.', '.', '.', '.', '#', '#'],
}

const TEXT = {
  en: { week: 'This week, TokenWise saved you', month: 'In the last 30 days, TokenWise saved you', all: 'Since you installed it, TokenWise saved you', unit: 'tokens',
    outputs: (n: string) => `from ${n} shortened command outputs`, today: (n: string) => `${n} so far today`, perDay: 'per day', perMonth: 'per month',
    agents: (names: string, more: number) => `in ${names}${more ? ` and ${more} more` : ''}`, emptyTitle: 'Nothing saved yet.',
    empty: 'Use your agents as usual. When a test run or a build prints a long output, TokenWise shortens what the model reads, and what it saved shows up here.',
    more: 'See it in your browser: tokenwise dashboard' },
  zh: { week: '这周，TokenWise 已为你省下', month: '最近 30 天，TokenWise 已为你省下', all: '装上以来，TokenWise 已为你省下', unit: 'token',
    outputs: (n: string) => `来自 ${n} 次被缩短的命令输出`, today: (n: string) => `今天已省 ${n}`, perDay: '每天省下的', perMonth: '每月省下的',
    agents: (names: string, more: number) => `在 ${names}${more ? ` 等 ${more + 3} 个 agent` : ''} 里`, emptyTitle: '还没有省下 token。',
    empty: '照常使用你的 agent。跑测试、构建这类命令输出很长时，TokenWise 会把模型要读的部分缩短，省下的会显示在这里。',
    more: '在浏览器里看：tokenwise dashboard' },
}

export interface SavedOptions { readonly period?: Period; readonly language?: 'en' | 'zh'; readonly animate?: boolean; readonly color?: boolean; readonly json?: boolean }

export function language(env: NodeJS.ProcessEnv = process.env): 'en' | 'zh' {
  const tag = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale
  return /^zh/iu.test(tag) ? 'zh' : 'en'
}

/** The jar and the words beside it, as text lines; `landed` coins of `slots` are drawn, and `flying` ones on their way. */
export function frame(s: Savings, options: { language: 'en' | 'zh'; color: boolean; landed: number; shown: number; flying?: readonly { slot: number; t: number }[] }): string[] {
  const { color } = options
  const T = TEXT[options.language]
  const fg = (c: Rgb) => color ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m` : ''
  const bg = (c: Rgb) => color ? `\x1b[48;2;${c[0]};${c[1]};${c[2]}m` : ''
  const reset = color ? '\x1b[0m' : ''
  const dim = (t: string) => color ? `${fg(C.soft)}${t}${reset}` : t
  const bold = (t: string) => color ? `\x1b[1m${t}\x1b[22m` : t
  const cells = (g: Grid) => {
    const out: string[] = []
    for (let y = 0; y < g.length; y += 2) {
      let line = ''
      for (let x = 0; x < g[0]!.length; x++) {
        const t = g[y]![x], b = g[y + 1]?.[x]
        if (!color) line += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
        else if (t && b) line += fg(t) + bg(b) + '▀' + reset
        else if (t) line += fg(t) + '▀' + reset
        else if (b) line += fg(b) + '▄' + reset
        else line += ' '
      }
      out.push(line)
    }
    return out
  }
  const all = slots(fullRows(s)), g = jar()
  for (let i = 0; i < Math.min(options.landed, all.length); i++) coin(g, all[i]!.x, all[i]!.y, all[i]!.tone)
  for (const { slot, t } of options.flying ?? []) {
    const c = all[slot]
    if (c) coin(g, c.x + Math.round((14 - c.x) * (1 - t) * .5), Math.round(3 + (c.y - 3) * t * t), c.tone, true)
  }
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
  const digits = (text: string) => {
    const d: Grid = Array.from({ length: 6 }, () => [])
    for (const ch of text) { const f = FONT[ch]; if (!f) continue; f.forEach((row, y) => d[y]!.push(...[...row].map(c => c === '#' ? C.accent : null), null)) }
    const lines = cells(d)
    lines[lines.length - 1] += ' ' + dim(T.unit)
    return lines
  }
  const bars = '▁▂▃▄▅▆▇█', max = Math.max(1, ...s.buckets.map(b => b.tokens))
  const spark = s.buckets.map((b, i) => fg(i === s.buckets.length - 1 ? C.face[0]! : C.face[2]!) + bars[Math.round(b.tokens / max * 7)] + reset).join('')
  const names = s.agents.slice(0, 3).map(a => AGENT_NAMES[a] ?? a).join(options.language === 'zh' ? '、' : ', '), more = Math.max(0, s.agents.length - 3)
  const words = s.tokens === 0
    ? [bold(T.emptyTitle), '', ...wrap(T.empty, 44), '', dim(T.more)]
    : [dim(T[s.period]), '', ...digits(fmt(options.shown)), '', T.outputs(bold(fmt(s.outputs))), '', `${fg(C.face[1]!)}●${reset} ${T.today(bold(fmt(s.today)))}`, '',
      `${spark}  ${dim(s.period === 'all' ? T.perMonth : T.perDay)}`, '', dim(T.agents(names, more)), '', dim(T.more)]
  const left = cells(g), top = Math.max(0, Math.floor((left.length - words.length) / 2))
  return Array.from({ length: Math.max(left.length, words.length + top) }, (_, i) => '  ' + (left[i] ?? ' '.repeat(W)) + '    ' + (words[i - top] ?? ''))
}

/** How many coin rows to fill: none for nothing saved, then more for more, up to a full jar (8 rows). */
function fullRows(s: Savings): number {
  if (s.tokens <= 0) return 0
  return Math.max(1, Math.min(8, Math.round(Math.log10(s.tokens / 1000 + 1) * 2.4)))
}
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = '', w = 0
  for (const word of text.match(/[一-鿿　-〿＀-￯]|[^\s一-鿿　-〿＀-￯]+\s*/gu) ?? []) {
    const ww = [...word].reduce((n, c) => n + (/[一-鿿　-〿＀-￯]/u.test(c) ? 2 : 1), 0)
    if (w + ww > width && line) { out.push(line.trimEnd()); line = ''; w = 0 }
    line += word; w += ww
  }
  if (line) out.push(line.trimEnd())
  return out
}

export async function saved(options: SavedOptions = {}): Promise<number> {
  const s = savingsOf(cliContext().dataDirs, options.period ?? 'week')
  if (options.json) {
    process.stdout.write(JSON.stringify({ period: s.period, tokens: s.tokens, outputs: s.outputs, today: s.today, agents: s.agents,
      buckets: s.buckets.map(b => ({ start: new Date(b.start).toISOString(), tokens: b.tokens })), since: s.since === null ? null : new Date(s.since).toISOString() }, null, 2) + '\n')
    return 0
  }
  const lang = options.language ?? language()
  const out = process.stdout
  const color = options.color ?? (out.isTTY === true && !process.env.NO_COLOR)
  const total = slots(fullRows(s)).length
  if (!(options.animate ?? (out.isTTY === true && !process.env.CI)) || total === 0) {
    out.write(frame(s, { language: lang, color, landed: total, shown: s.tokens }).join('\n') + '\n')
    return 0
  }
  const height = frame(s, { language: lang, color, landed: 0, shown: 0 }).length
  out.write('\x1b[?25l' + '\n'.repeat(height))
  const show = () => out.write('\x1b[?25h')
  const stop = () => { show(); process.exit(130) }
  process.once('SIGINT', stop)
  // Each coin starts a little after the one before, drops from the neck in 5 frames and stays where it lands.
  const START = 1.1, FALL = 5, frames = Math.ceil(total * START + FALL + 2)
  for (let f = 0; f <= frames; f++) {
    const flying: { slot: number; t: number }[] = []
    let landed = 0
    for (let i = 0; i < total; i++) { const t = (f - i * START) / FALL; if (t >= 1) landed = i + 1; else if (t > 0) flying.push({ slot: i, t }) }
    out.write(`\x1b[${height}A\r` + frame(s, { language: lang, color, landed, shown: s.tokens * landed / total, flying }).map(l => l + '\x1b[K').join('\n') + '\n')
    await new Promise(r => setTimeout(r, 40))
  }
  out.write(`\x1b[${height}A\r` + frame(s, { language: lang, color, landed: total, shown: s.tokens }).map(l => l + '\x1b[K').join('\n') + '\n')
  process.off('SIGINT', stop)
  show()
  return 0
}
