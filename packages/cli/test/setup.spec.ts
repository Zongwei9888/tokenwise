import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS, REPOSITORY, describeStep, setup, sources } from '../src/setup.ts'
import type { Sources, Step } from '../src/setup.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'tokenwise-setup-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

const published: Sources = sources('/usr/lib/node_modules/@tokenwise/cli/dist/tokenwise.js')
const quiet = () => { vi.spyOn(process.stdout, 'write').mockImplementation(() => true); vi.spyOn(process.stderr, 'write').mockImplementation(() => true) }

/** Run setup with a recording runner; returns the steps it would perform. */
function plan(args: Partial<Parameters<typeof setup>[0]> & { action: 'setup' | 'uninstall' }, result = true) {
  const steps: Step[] = []
  quiet()
  const code = setup({ agents: [], env: { PATH: '', HOME: '/home/u' }, sources: published, perform: step => { steps.push(step); return result }, ...args })
  return { code, steps: steps.map(describeStep) }
}

describe('tokenwise setup', () => {
  it('uses the checkout it runs from, and the published sources otherwise', () => {
    expect(sources(join(root, 'packages/cli/dist/tokenwise.js'))).toEqual({
      marketplace: join(root, '.').replace(/\/$/, ''), pi: join(root, 'adapters/pi'), dsh: join(root, 'adapters/dsh'),
      opencode: join(root, 'adapters/opencode/dist/index.js'), hermes: join(root, 'adapters/hermes/tokenwise'), skill: join(root, 'skills/tokenwise') })
    expect(published).toEqual({ marketplace: REPOSITORY, pi: 'npm:@tokenwise/pi', dsh: '@tokenwise/dsh',
      opencode: '/usr/lib/node_modules/@tokenwise/cli/assets/opencode/tokenwise.js', hermes: '/usr/lib/node_modules/@tokenwise/cli/assets/hermes/tokenwise',
      skill: '/usr/lib/node_modules/@tokenwise/cli/assets/skills/tokenwise' })
  })

  it('installs into each named agent with that agent\'s own commands', () => {
    const { code, steps } = plan({ action: 'setup', agents: AGENTS.map(agent => agent.id), dshProfile: 'mine' })
    expect(code).toBe(0)
    // Every agent also gets the tokenwise skill, where it reads skills.
    const skill = (to: string) => `copy ${published.skill} -> /home/u/${to}/tokenwise`
    expect(steps).toEqual([
      'pi install npm:@tokenwise/pi', skill('.agents/skills'),
      'dsh plugin --profile mine add -w @tokenwise/dsh', skill('.agents/skills'),
      'claude plugin marketplace add HKUDS/TokenWise', 'claude plugin install tokenwise@tokenwise', skill('.claude/skills'),
      'codex plugin marketplace add HKUDS/TokenWise', 'codex plugin add tokenwise@tokenwise', skill('.agents/skills'),
      'codebuddy plugin uninstall tokenwise@tokenwise', 'remove /home/u/.codebuddy/plugins/cache/tokenwise',
      'codebuddy plugin marketplace add HKUDS/TokenWise', 'codebuddy plugin install tokenwise@tokenwise', skill('.codebuddy/skills'),
      'grok plugin marketplace add HKUDS/TokenWise', 'grok plugin install tokenwise@tokenwise --trust', skill('.grok/skills'),
      `copy ${published.opencode} -> /home/u/.config/opencode/plugins/tokenwise.js`, skill('.config/opencode/skills'),
      `copy ${published.hermes} -> /home/u/.hermes/plugins/tokenwise`, 'hermes plugins enable tokenwise', 'hermes config set context.engine tokenwise',
      skill('.hermes/skills'),
    ])
  })

  it('takes TokenWise out again, and deletes the data only with --purge', () => {
    // In the order of AGENTS, whatever order they were named in.
    expect(plan({ action: 'uninstall', agents: ['hermes', 'opencode', 'claude'] }).steps).toEqual([
      'claude plugin uninstall tokenwise@tokenwise', 'claude plugin marketplace remove tokenwise', 'remove /home/u/.claude/skills/tokenwise',
      'remove /home/u/.config/opencode/plugins/tokenwise.js', 'remove /home/u/.config/opencode/skills/tokenwise',
      'hermes config set context.engine compressor', 'hermes plugins disable tokenwise', 'remove /home/u/.hermes/plugins/tokenwise',
      'remove /home/u/.hermes/skills/tokenwise',
    ])
    expect(plan({ action: 'uninstall', agents: ['codebuddy'] }).steps).toEqual(['codebuddy plugin uninstall tokenwise@tokenwise',
      'codebuddy plugin marketplace remove tokenwise', 'remove /home/u/.codebuddy/plugins/cache/tokenwise', 'remove /home/u/.codebuddy/skills/tokenwise'])
    expect(plan({ action: 'uninstall', agents: ['pi'], purge: '/home/u/.tokenwise' }).steps).toEqual(['pi remove npm:@tokenwise/pi',
      'remove /home/u/.agents/skills/tokenwise', 'remove /home/u/.tokenwise'])
  })

  it('keeps a shared skill directory while another agent that reads it is still installed', () => {
    const bin = temp()
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n')
    chmodSync(join(bin, 'codex'), 0o755)
    // Codex reads ~/.agents/skills too: taking TokenWise out of pi leaves Codex its skill.
    expect(plan({ action: 'uninstall', agents: ['pi'], env: { PATH: bin, HOME: '/home/u' } }).steps).toEqual(['pi remove npm:@tokenwise/pi'])
    expect(plan({ action: 'uninstall', agents: ['pi', 'codex'], env: { PATH: bin, HOME: '/home/u' } }).steps).toContain('remove /home/u/.agents/skills/tokenwise')
  })

  it('picks the agents found on PATH when none is named, and says so when there are none', () => {
    const bin = temp()
    for (const name of ['codex', 'hermes']) { writeFileSync(join(bin, name), '#!/bin/sh\n'); chmodSync(join(bin, name), 0o755) }
    expect(plan({ action: 'setup', env: { PATH: bin, HOME: '/home/u' } }).steps[0]).toBe('codex plugin marketplace add HKUDS/TokenWise')
    expect(plan({ action: 'setup', env: { PATH: bin, HOME: '/home/u' } }).steps.at(-1)).toBe(`copy ${published.skill} -> /home/u/.hermes/skills/tokenwise`)
    expect(plan({ action: 'setup' })).toEqual({ code: 1, steps: [] })
    expect(plan({ action: 'setup', agents: ['vim'] })).toEqual({ code: 2, steps: [] })
  })

  it('stops an agent at its first failed step, carries on with the others, and fails overall', () => {
    let n = 0
    quiet()
    const steps: string[] = []
    const code = setup({ action: 'setup', agents: ['claude', 'pi'], env: { PATH: '' }, sources: published,
      perform: step => { steps.push(describeStep(step)); return n++ !== 0 } })
    expect(code).toBe(1)
    expect(steps).toEqual(['pi install npm:@tokenwise/pi', 'claude plugin marketplace add HKUDS/TokenWise', 'claude plugin install tokenwise@tokenwise',
      `copy ${published.skill} -> ${join(homedir(), '.claude/skills/tokenwise')}`])
  })

  it('copies plugin files and removes them for real', () => {
    const home = temp()
    const assets = temp()
    mkdirSync(join(assets, 'hermes'))
    writeFileSync(join(assets, 'hermes', '__init__.py'), '# plugin\n')
    writeFileSync(join(assets, 'opencode.js'), 'export {}\n')
    mkdirSync(join(assets, 'skill'))
    writeFileSync(join(assets, 'skill', 'SKILL.md'), '---\nname: tokenwise\n---\n')
    const env = { PATH: '', HOME: home }
    const s = { ...published, opencode: join(assets, 'opencode.js'), hermes: join(assets, 'hermes'), skill: join(assets, 'skill') }
    quiet()
    expect(setup({ action: 'setup', agents: ['opencode'], env, sources: s })).toBe(0)
    expect(readFileSync(join(home, '.config/opencode/plugins/tokenwise.js'), 'utf8')).toBe('export {}\n')
    expect(readFileSync(join(home, '.config/opencode/skills/tokenwise/SKILL.md'), 'utf8')).toContain('name: tokenwise')
    expect(setup({ action: 'uninstall', agents: ['opencode'], env, sources: s })).toBe(0)
    expect(existsSync(join(home, '.config/opencode/plugins/tokenwise.js'))).toBe(false)
    expect(existsSync(join(home, '.config/opencode/skills/tokenwise'))).toBe(false)
    // A missing plugin file (a checkout that was never built) fails that agent.
    expect(setup({ action: 'setup', agents: ['opencode'], env, sources: { ...s, opencode: join(assets, 'nope.js') } })).toBe(1)
  })

  it('prints the plan and changes nothing with --dry-run', () => {
    const home = temp()
    const result = spawnSync(process.execPath, ['--conditions=source', main, 'uninstall', 'opencode', 'pi', '--purge', '--dry-run'],
      { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), TOKENWISE_HOME: join(home, 'data') }, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('$ pi remove ')
    // OpenCode follows XDG_CONFIG_HOME when it is set.
    expect(result.stdout).toContain(`$ remove ${join(home, 'config/opencode/plugins/tokenwise.js')}`)
    expect(result.stdout).toContain(`$ remove ${join(home, 'data')}`)
    expect(result.stdout).toContain('Dry run: nothing was changed.')
  })
})
