import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { sha256 } from '@tokenwise/core'
import { savedCard } from '@tokenwise/mechanisms'
import type { EvolveStatus } from '@tokenwise/mechanisms'
import { FileArtifactStore, FileJournal, RuleStore, removeTree } from '@tokenwise/store'
import { createTokenWiseExtension } from '../src/extension.ts'
import { evolveBadge, panelKey, renderPanel } from '../src/panel.ts'
import type { PanelData } from '../src/panel.ts'

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text }
const economy = { projected: 12, passed: 30, previewed: 0, savedTokens: 24_100, previewSavedTokens: 0, failed: 0, byFilter: [] }
const shadow = { checkpoints: 1, standard: 0, cuts: 0, references: 17, referencedTokens: 30_000, recalls: 2 }
const now = Date.parse('2026-10-14T12:00:00.000Z')

function data(evolve: Partial<EvolveStatus>, extra: Partial<PanelData> = {}): PanelData {
  return { economy, shadow, modes: 'economy apply · shadow apply', learner: { label: 'pi · deepseek-v4-pro' }, learnedRulesOff: false, now,
    evolve: { rules: { active: null, rules: [], history: 0 }, ...evolve }, ...extra } as PanelData
}

describe('the /tokenwise panel', () => {
  it('shows savings, what is worth learning and the keys, inside the width it gets', () => {
    const lines = renderPanel(data({ scan: { schemaVersion: 1, time: '', evidence: 40, newEvidence: 12, leftTokens: 9000, ready: true, rules: [], disabled: [],
      opportunities: [{ command: 'cargo', cases: 6, leftTokens: 8400 }, { command: 'npm', cases: 3, leftTokens: 2100 }] } }), {}, 120, plain)
    const text = lines.join('\n')
    expect(text).toContain('◆ TokenWise')
    expect(text).toContain('12 of 42 outputs filtered')
    expect(text).toContain('−24.1k tokens')
    expect(text).toContain('1 compaction · 17 results recallable · 2 recalled')
    expect(text).toContain('✦ Ready to learn')
    expect(text).toMatch(/Worth learning +cargo +6 outputs +~8\.4k left ▰{8}/)
    expect(text).toContain('l learn now')
    for (const line of lines) expect(visibleWidth(line)).toBe(92)
    for (const line of renderPanel(data({}), {}, 60, plain)) expect(visibleWidth(line)).toBe(60)
  })

  it('follows a run: progress while it runs, the result after', () => {
    const run = { schemaVersion: 1 as const, runId: 'r', host: 'pi', learner: 'pi · deepseek-v4-pro', pid: 1, startedAt: '2026-10-14T11:57:29.000Z',
      phase: 'learning' as const, evidence: 69, shown: 40, running: true, checks: 2, lastCheck: { time: '', accepted: true, gainTokens: 2628 } }
    const running = renderPanel(data({ run }), {}, 100, plain).join('\n')
    expect(running).toContain('● Learning 2:31')
    expect(running).toMatch(/✓ Prepare .* ● Learn .* ○ Verify/)
    expect(running).toContain('reading 40 of 69 recorded outputs')
    expect(running).toContain('2 so far · last passes (+2.6k)')
    expect(running).toContain('c cancel')
    expect(running).not.toContain('l learn now')
    expect(evolveBadge({ run, rules: { active: null, rules: [], history: 0 } }, plain, now)).toMatch(/^[◐◓◑◒] learning 2:31$/)

    const done = renderPanel(data({
      run: { ...run, running: false, phase: 'done', finishedAt: '2026-10-14T11:59:00.000Z',
        outcome: { result: 'adopted', rules: ['pytest-verbose-passed'], gainTokens: 2628, cases: 69, generalization: { status: 'confirmed', commands: ['pytest'], heldOutCases: 12, heldOutGain: 400 } } },
      rules: { active: 'a'.repeat(64), rules: [{ id: 'pytest-verbose-passed', transformation: 'noise-removal' }], history: 1, adoptedAt: '2026-10-14T11:59:00.000Z', gainTokens: 2628, cases: 69 },
      scan: { schemaVersion: 1, time: '', evidence: 69, newEvidence: 0, leftTokens: 0, ready: false, opportunities: [], disabled: [],
        rules: [{ id: 'pytest-verbose-passed', projections: 41, savedTokens: 11_200, originalRecalls: 1 }] },
    }), {}, 100, plain).join('\n')
    expect(done).toContain('✓ Rules active')
    expect(done).toContain('1 active · adopted 1 min ago · +2.6k on 69 outputs')
    expect(done).toMatch(/• pytest-verbose-passed +41× +−11\.2k +↺ 1/)
    // A rule with no use yet says so, rather than "0× −0".
    const fresh = renderPanel(data({ rules: { active: 'a'.repeat(64), rules: [{ id: 'cargo-test-passing', transformation: 'noise-removal' }], history: 1 },
      scan: { schemaVersion: 1, time: '', evidence: 1, newEvidence: 0, leftTokens: 0, ready: false, opportunities: [], disabled: [],
        rules: [{ id: 'cargo-test-passing', projections: 0, savedTokens: 0, originalRecalls: 0 }] } }), {}, 100, plain).join('\n')
    expect(fresh).toMatch(/• cargo-test-passing +not used yet/)
    expect(done.replace(/[ │]*\n[ │]+/gu, ' ')).toContain('✓ adopted rule pytest-verbose-passed: +2.6k tokens on 69 recorded outputs, confirmed on 12 it had not seen · 1 min ago')
    expect(done).toContain('r roll back')
  })

  it('asks before learning or rolling back, and says why it cannot learn', () => {
    expect(renderPanel(data({}), { confirming: 'learn' }, 100, plain).join('\n')).toContain('Learn with pi · deepseek-v4-pro?')
    expect(renderPanel(data({}), { confirming: 'off' }, 100, plain).join('\n')).toContain('Switch learned rules off?')
    // Anything but y or n while asking is ignored, so stray typing cannot act.
    for (const key of ['o', 'r', 'l', 'c', 'x']) expect(panelKey(key, { confirming: 'off' })).toBeUndefined()
    expect(panelKey('y', { confirming: 'learn' })).toBe('confirm')
    expect(panelKey('\x1b', { confirming: 'learn' })).toBe('back')
    expect(panelKey('l', {})).toBe('learn')
    expect(panelKey('\x1b', {})).toBe('close')
    expect(panelKey('x', {})).toBeUndefined()
    const unavailable = renderPanel(data({}, { learner: { unavailable: 'needs Node.js on PATH' } }), {}, 100, plain).join('\n')
    expect(unavailable).toContain('Learning from here: needs Node.js on PATH')
    expect(unavailable).not.toContain('learn now')
  })
})

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-pi-learn-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) removeTree(dir) })

/** A pi stand-in that records what the extension registers and lets a test call it. */
function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }>()
  const api = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler) },
    registerCommand: (name: string, command: never) => { commands.set(name, command) },
    registerFlag: () => {}, getFlag: () => '', registerTool: () => {}, getActiveTools: () => [], setActiveTools: () => {},
  }
  const notes: { text: string; level: string }[] = []
  const statuses: string[] = []
  /** Every widget content set, in order; undefined when one is taken away. */
  const widgets: { key: string; lines: string[] | undefined }[] = []
  const ctx = {
    cwd: tmpdir(), hasUI: true, mode: 'rpc', model: { provider: 'faux', id: 'faux-model' },
    sessionManager: { getSessionId: () => 's1', getBranch: () => [] },
    ui: { theme: plain, notify: (text: string, level = 'info') => notes.push({ text, level }), setStatus: (_key: string, text: string) => statuses.push(text), confirm: async () => true,
      setWidget: (key: string, lines: string[] | undefined) => { widgets.push({ key, lines }) } },
  }
  return { api, handlers, commands, ctx, notes, statuses, widgets }
}

const progress = (seed: number) => Array.from({ length: 120 }, (_, i) => `[${String(i + 1).padStart(3)}/120] Compiling crate_${seed}_${i}`).join('\n') + '\nFinished\n'

describe('learning from pi', () => {
  it('/tokenwise learn runs the learner in the background, adopts what verifies, and announces it', async () => {
    const home = temp(), work = temp()
    for (const seed of [1, 2, 3]) {
      const output = progress(seed)
      new FileArtifactStore(home).save(output)
      new FileJournal(home).append({ schemaVersion: 1, type: 'economy/decision', time: new Date().toISOString(), host: 'pi', sessionId: 'old', callId: `c${seed}`, tool: 'bash',
        command: './build.sh', exitCode: 0, delivery: 'in-process', streams: 'merged', mode: 'apply', outcome: 'passed', reason: 'no-filter-match', runtimeVersion: 'v', policyHash: 'p',
        raw: { sha256: sha256(output), bytes: output.length, tokens: Math.ceil(output.length / 4), stored: true }, layout: { stdout: { start: 0, length: output.length } } })
    }
    const script = join(work, 'learner.sh')
    writeFileSync(script, `mkdir -p rules-work/rules
echo '{ "schemaVersion": 1, "rules": [{ "id": "compile-progress", "file": "rules/compile-progress.js" }] }' > rules-work/index.json
cat > rules-work/rules/compile-progress.js <<'JS'
defineRule({ project(input, tw) {
  if (!input.argv || input.argv[0] !== './build.sh') return null
  return tw.keepLines(input.raw, line => !/^\\[\\s*\\d+\\/\\d+\\] Compiling /.test(line.text), n => '[' + n + ' compile lines omitted]\\n')
} })
JS
./check
`)
    const pi = fakePi()
    createTokenWiseExtension({ dataDir: home, env: { ...process.env, TOKENWISE_HOME: home },
      runner: fileURLToPath(new URL('../../../packages/mechanisms/test/fixtures/runner.ts', import.meta.url)), runnerNodeArgs: ['--conditions=source'],
      learner: () => ({ argv: [`sh ${script}`], shell: true, label: 'test learner' }) })(pi.api as never)
    const command = pi.commands.get('tokenwise')!
    expect((command.getArgumentCompletions!('ro') as { value: string }[]).map(item => item.value)).toEqual(['rollback'])
    await pi.handlers.get('session_start')!({}, pi.ctx)
    await command.handler('learn', pi.ctx)
    expect(pi.notes.at(-1)!.text).toContain('Learning with test learner in the background')
    // The footer follows the run, and the extension announces the adoption once it ends.
    const deadline = Date.now() + 30_000
    while (!pi.notes.some(note => note.text.startsWith('TokenWise learning adopted'))) {
      if (Date.now() > deadline) throw new Error(`no announcement: ${JSON.stringify(pi.notes)}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(pi.statuses.some(text => /learning \d+:\d\d/.test(text))).toBe(true)
    expect(pi.notes.find(note => note.text.startsWith('TokenWise learning adopted'))!.text)
      .toMatch(/adopted rule compile-progress: \+[\d.]+k? tokens on 3 recorded outputs, confirmed on 1 it had not seen\. \/tokenwise to review or roll back\./)
    expect(new RuleStore(home).state().active).toMatch(/^[a-f0-9]{64}$/)
    await command.handler('rules', pi.ctx)
    expect(pi.notes.at(-1)!.text).toContain('compile-progress (preview)')
    await command.handler('off', pi.ctx)
    expect(new RuleStore(home).state().active).toBeNull()
    await command.handler('on', pi.ctx)
    expect(new RuleStore(home).state().active).toMatch(/^[a-f0-9]{64}$/)
    await pi.handlers.get('session_shutdown')!({}, pi.ctx)
  }, 60_000)
})

describe('what a pi conversation saved', () => {
  it('is said when an answer ends, and again only once it grew, also across a restart', async () => {
    const home = temp()
    const decision = (raw: number, read: number) => new FileJournal(home).append({ schemaVersion: 1, type: 'economy/decision', time: new Date().toISOString(),
      host: 'pi', sessionId: 's1', callId: `c${raw}`, tool: 'bash', command: 'pytest', exitCode: 1, delivery: 'in-process', streams: 'merged', mode: 'apply',
      outcome: 'projected', runtimeVersion: 'v', policyHash: 'p', raw: { sha256: 'a', bytes: raw * 4, tokens: raw, stored: true }, projected: { sha256: 'b', bytes: read * 4, tokens: read } } as never)
    decision(3000, 300)
    const pi = fakePi()
    createTokenWiseExtension({ dataDir: home, env: { ...process.env, TOKENWISE_HOME: home, LANG: 'en_US.UTF-8' } })(pi.api as never)
    await pi.handlers.get('session_start')!({}, pi.ctx)
    // The card fills on a timer: run it with fake time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      await pi.handlers.get('agent_end')!({}, pi.ctx)
      await pi.handlers.get('agent_end')!({}, pi.ctx)
      const card = (saved: number, seen: number, progress = 1) => savedCard({ savedTokens: saved, seenTokens: seen }, { color: true, lines: true, progress })!.split('\n')
      const cards = () => pi.widgets.filter(widget => widget.key === 'tokenwise-saved')
      // It starts empty, fills, and stays; the second agent_end, with nothing more saved, adds nothing.
      expect(cards()[0]!.lines).toEqual(card(2700, 3000, 0))
      vi.advanceTimersByTime(1500)
      expect(cards().at(-1)!.lines).toEqual(card(2700, 3000))
      expect(cards().length).toBeGreaterThan(5)
      const shown = cards().length
      vi.advanceTimersByTime(1500)
      expect(cards()).toHaveLength(shown)
      // The next prompt takes it away; an answer that saved more brings it back with the new number.
      await pi.handlers.get('agent_start')!({}, pi.ctx)
      expect(cards().at(-1)!.lines).toBeUndefined()
      decision(1000, 100)
      await pi.handlers.get('agent_end')!({}, pi.ctx)
      vi.advanceTimersByTime(1500)
      expect(cards().at(-1)!.lines).toEqual(card(3600, 4000))
      // pi restarted on the same session (`pi -c`): the number is kept on disk, so it is not said again.
      const again = fakePi()
      createTokenWiseExtension({ dataDir: home, env: { ...process.env, TOKENWISE_HOME: home, LANG: 'en_US.UTF-8' } })(again.api as never)
      await again.handlers.get('session_start')!({}, again.ctx)
      await again.handlers.get('agent_end')!({}, again.ctx)
      expect(again.widgets.filter(widget => widget.key === 'tokenwise-saved')).toEqual([])
    } finally { vi.useRealTimers() }
  })
})
