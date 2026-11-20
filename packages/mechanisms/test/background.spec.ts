import { existsSync, mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backgroundCommand, rememberBackground } from '../src/index.ts'

describe('background commands, remembered until their output is read', () => {
  it('finds a task\'s command under its agent and conversation only, in any data directory', () => {
    const [primary, legacy] = [mkdtempSync(join(tmpdir(), 'tokenwise-bg-')), mkdtempSync(join(tmpdir(), 'tokenwise-bg-'))]
    rememberBackground(legacy, 'claude', 's1', 'b0abc1234', { command: 'pytest -v', cwd: '/w' })
    expect(backgroundCommand([primary, legacy], 'claude', 's1', 'b0abc1234')).toEqual({ command: 'pytest -v', cwd: '/w' })
    expect(backgroundCommand([primary, legacy], 'claude', 's2', 'b0abc1234')).toBeUndefined()
    expect(backgroundCommand([primary, legacy], 'codebuddy', 's1', 'b0abc1234')).toBeUndefined()
    expect(backgroundCommand([primary, legacy], 'claude', 's1', 'other')).toBeUndefined()
    // A task ID cannot reach outside its folder.
    rememberBackground(primary, 'claude', 's1', '../../x', { command: 'ls' })
    expect(backgroundCommand([primary], 'claude', 's1', '../../x')).toEqual({ command: 'ls' })
    expect(existsSync(join(primary, 'background', 'x.json'))).toBe(false)
  })

  it('forgets conversations untouched for three days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenwise-bg-'))
    rememberBackground(dir, 'claude', 'old', 't1', { command: 'make' })
    const old = new Date(Date.now() - 4 * 86_400_000)
    utimesSync(join(dir, 'background', 'claude', 'old'), old, old)
    rememberBackground(dir, 'claude', 'new', 't2', { command: 'make test' })
    expect(backgroundCommand([dir], 'claude', 'old', 't1')).toBeUndefined()
    expect(backgroundCommand([dir], 'claude', 'new', 't2')).toEqual({ command: 'make test' })
  })
})
