/** The published shape the DSH plugin manager and Loader read. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const at = (path: string) => new URL(`../${path}`, import.meta.url)
const manifest = JSON.parse(readFileSync(at('package.json'), 'utf8'))

describe('DSH bundle package', () => {
  it('declares a bundle whose patch mounts the package root', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(at('cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/- insert:\n\s+- id: tokenwise\n\s+name: '@tokenwise\/dsh'\n/)
  })
  it('ships display metadata, in English for every DSH language, and a small self-contained icon', () => {
    const meta = JSON.parse(readFileSync(at('locale/en.json'), 'utf8')).meta
    expect(meta.title).toBe('TokenWise')
    expect(meta.description.length).toBeGreaterThan(20)
    expect(readFileSync(at('locale/zh.json'), 'utf8')).toBe(readFileSync(at('locale/en.json'), 'utf8'))
    expect(manifest.icon).toBe('./icon.svg')
    const icon = readFileSync(at('icon.svg'), 'utf8')
    expect(statSync(at('icon.svg')).size).toBeLessThan(256 * 1024)
    expect(icon).not.toMatch(/<script|href=|url\(/i)
  })
  it('publishes every file it exports and nothing from the workspace at runtime', () => {
    expect(manifest.dependencies).toBeUndefined()
    for (const target of ['./lib/index.js', './lib/client.js', './cordis.patch.yml', './icon.svg', './locale/en.json', './locale/zh.json']) {
      expect(existsSync(at(target)), target).toBe(true)
      const relative = target.slice(2)
      expect(manifest.files.some((pattern: string) => pattern === relative || (pattern.endsWith('*.json') && relative.startsWith(pattern.slice(0, -6)))), relative).toBe(true)
    }
    expect(manifest.exports['./client']).toBe('./lib/client.js')
    expect(manifest.main).toBe('./lib/index.js')
  })
  it('gates on DSH 0.2 through a peer range the harness checks before installing', () => {
    expect(manifest.peerDependencies['@deepseek-ai/dsh-tools']).toBe('>=0.2.0-0 <0.3.0-0')
    expect(manifest.peerDependencies['@deepseek-ai/schemastery']).toBe('*')
  })
  it('keeps every TokenWise import inside the bundle; only the harness modules stay external', () => {
    const host = readFileSync(at('lib/index.js'), 'utf8')
    const imports = [...host.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!)
    expect(imports.filter(specifier => !specifier.startsWith('node:')).sort()).toEqual(['@deepseek-ai/schemastery'])
    expect(host).not.toMatch(/from\s+["']@tokenwise\//)
  })
})
