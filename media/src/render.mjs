// Renders the media kit from the HTML sources in this folder with headless Chromium.
//   node render.mjs stills            every still image into ../
//   node render.mjs stills social     just the ones whose name contains "social"
//   node render.mjs video en|zh       the explainer video (frames piped to ffmpeg)
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = fileURLToPath(new URL('.', import.meta.url))
const out = join(here, '..')
const require = createRequire(import.meta.url)
const { chromium } = require(join(here, '../../e2e/.cache/playwright-core-1.63.0/node_modules/playwright-core'))
const CHROME = process.env.CHROME ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  // Agent icons live beside the media sources, in media/agents (the README uses them too).
  const path = url.startsWith('/agents/') ? join(here, '..', url) : join(here, url)
  if (!(path.startsWith(here) || path.startsWith(join(here, '..', 'agents'))) || !existsSync(path)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }); res.end(readFileSync(path))
}).listen(0)
const base = `http://127.0.0.1:${server.address().port}/`

const STILLS = [
  { name: 'social-preview', page: 'story.html?v=social', w: 1280, h: 640, scale: 1 },
  { name: 'social-preview-zh', page: 'story.html?v=social&lang=zh', w: 1280, h: 640, scale: 1 },
  { name: 'banner', page: 'story.html?v=banner', w: 1600, h: 560, scale: 2 },
  { name: 'banner-zh', page: 'story.html?v=banner&lang=zh', w: 1600, h: 560, scale: 2 },
  // The README's agent-wall badges for 'any shell' and 'more': Flaticon icons in the brand's badge shape.
  ...['shell', 'more'].map(icon => ({ name: `icons/agent-${icon}`, page: `badge.html?kind=agent&icon=${icon}`, w: 64, h: 64, scale: 2, fit: '.b' })),
  ...['how', 'evolve'].flatMap(v => ['en', 'zh'].map(l =>
    ({ name: `story-${v}${l === 'zh' ? '-zh' : ''}`, page: `story.html?v=${v}&lang=${l}`, w: 1200, h: 400, scale: 2, fit: '.d' }))),
  // README: what TokenWise saves, per kind of work and model (from the paper's evaluation).
  ...['en', 'zh'].map(l => ({ name: `savings${l === 'zh' ? '-zh' : ''}`, page: `savings.html?lang=${l}`, w: 1200, h: 400, scale: 2, fit: '.d' })),
  { name: 'before-after', page: 'before-after.html', w: 1600, h: 900, scale: 2 },
  { name: 'before-after-zh', page: 'before-after.html?lang=zh', w: 1600, h: 900, scale: 2 },
]

// Flaticon icons (see icons.json) are fetched into .icons/ rather than kept in the repository.
const ICONS = JSON.parse(readFileSync(join(here, 'icons.json'), 'utf8')).icons
mkdirSync(join(here, '.icons'), { recursive: true })
for (const [name, icon] of Object.entries(ICONS)) {
  const file = join(here, '.icons', `${name}.png`)
  if (existsSync(file)) continue
  const res = await fetch(icon.png)
  if (!res.ok) throw new Error(`icon ${name}: HTTP ${res.status} from ${icon.png}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

const browser = await chromium.launch({ executablePath: CHROME })
try {
  const [mode, arg] = process.argv.slice(2)
  if (mode === 'stills') {
    mkdirSync(join(out, 'images'), { recursive: true })
    for (const still of STILLS.filter(s => !arg || s.name.includes(arg))) {
      const page = await browser.newPage({ viewport: { width: still.w, height: still.h }, deviceScaleFactor: still.scale })
      await page.goto(base + still.page)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => window.ready === true, null, { timeout: 10000 })
      if (still.fit) {
        const box = await page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) } }, still.fit)
        await page.setViewportSize({ width: box.w, height: box.h })
      }
      mkdirSync(dirname(join(out, 'images', `${still.name}.png`)), { recursive: true })
      await page.screenshot({ path: join(out, 'images', `${still.name}.png`), omitBackground: !!still.fit })
      await page.close()
      console.log('wrote images/' + still.name + '.png')
    }
  } else if (mode === 'video') {
    const lang = arg ?? 'en'
    const fps = 30
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    await page.goto(base + `video.html?lang=${lang}`)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => window.ready === true)
    const duration = await page.evaluate(() => window.DURATION)
    mkdirSync(join(out, 'video'), { recursive: true })
    const file = join(out, 'video', `tokenwise-${lang}.mp4`)
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] })
    const frames = Math.round(duration * fps)
    for (let i = 0; i < frames; i++) {
      await page.evaluate(t => window.render(t), i / fps)
      const png = await page.screenshot({ type: 'png' })
      if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r))
      if (i % 150 === 0) console.log(`frame ${i}/${frames}`)
    }
    ff.stdin.end()
    await new Promise(r => ff.on('close', r))
    console.log('wrote', file)
  } else if (mode === 'frames') {
    // Preview: node render.mjs frames en 3,9,12 -> frames written to $FRAMES_DIR (default ./.frames)
    const [lang, list] = [arg ?? 'en', process.argv[4] ?? '0']
    const dir = process.env.FRAMES_DIR ?? join(here, '.frames'); mkdirSync(dir, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(base + `video.html?lang=${lang}`)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => window.ready === true)
    for (const t of list.split(',').map(Number)) {
      // replay from 0 so state that depends on earlier frames (none should) cannot hide a bug
      await page.evaluate(t => window.render(t), t)
      await page.screenshot({ path: join(dir, `${lang}-${String(t).padStart(5, '0')}.png`) })
    }
    console.log('frames in', dir)
  } else {
    console.log('usage: node render.mjs stills [filter] | video [en|zh]')
  }
} finally {
  await browser.close()
  server.close()
}
