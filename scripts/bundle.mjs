#!/usr/bin/env node
/**
 * Build the self-contained files the distributable packages ship. Each one
 * carries the TokenWise packages it uses inline, so installing `@tokenwise/pi`,
 * `@tokenwise/dsh`, `@tokenwise/opencode` or `@tokenwise/cli` needs no
 * other TokenWise package; the host's own modules stay external and come from the
 * running host.
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const at = (...parts) => join(root, ...parts)
const LICENSE_BANNER = name => `/*! ${name} — MIT License. Bundles the TokenWise packages. */`

const node = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Workspace packages resolve to their TypeScript sources, so a bundle never picks up a stale lib/.
  conditions: ['source'],
  legalComments: 'inline',
  logLevel: 'warning',
  charset: 'utf8',
}

async function bundleNode({ entry, outfile, external, name, executable = false }) {
  await build({ ...node, entryPoints: [at(entry)], outfile: at(outfile), external,
    banner: { js: `${executable ? '#!/usr/bin/env node\n' : ''}${LICENSE_BANNER(name)}` } })
}

/**
 * The DSH Web client loads a browser half as one script that registers a
 * factory with the page's module loader; the factory receives `require` for
 * the shared modules (React, the client primitives) and returns the exports.
 */
async function bundleDshClient() {
  const result = await build({
    bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', write: false, charset: 'utf8',
    conditions: ['source'], legalComments: 'none', logLevel: 'warning',
    entryPoints: [at('adapters/dsh/src/client/index.ts')],
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  })
  const code = result.outputFiles[0].text
  const wrapped = `${LICENSE_BANNER('@tokenwise/dsh (browser half)')}
window.__ModuleLoader__.load({
\tid: "@tokenwise/dsh",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
// The bundle is inserted verbatim: re-indenting it would change multi-line string literals.
${code}
\t\treturn module.exports;
\t}
});
`
  mkdirSync(at('adapters/dsh/lib'), { recursive: true })
  writeFileSync(at('adapters/dsh/lib/client.js'), wrapped)
}

/** Each bundled package carries the TokenWise license. */
for (const dir of ['adapters/pi', 'adapters/dsh', 'adapters/opencode', 'packages/cli', 'packages/core', 'packages/protocol', 'packages/store', 'packages/mechanisms']) {
  copyFileSync(at('LICENSE'), at(dir, 'LICENSE'))
}

await Promise.all([
  bundleNode({ entry: 'adapters/pi/src/extension.ts', outfile: 'adapters/pi/dist/extension.js', name: '@tokenwise/pi',
    external: ['@earendil-works/*', 'typebox'] }),
  bundleNode({ entry: 'adapters/dsh/src/index.ts', outfile: 'adapters/dsh/lib/index.js', name: '@tokenwise/dsh',
    external: ['@deepseek-ai/*'] }),
  bundleNode({ entry: 'adapters/opencode/src/index.ts', outfile: 'adapters/opencode/dist/index.js', name: '@tokenwise/opencode', external: [] }),
  // The learning runner each plugin starts as its own process.
  bundleNode({ entry: 'adapters/pi/src/evolve.ts', outfile: 'adapters/pi/dist/evolve.js', name: '@tokenwise/pi (learning runner)', external: [] }),
  bundleNode({ entry: 'adapters/dsh/src/evolve.ts', outfile: 'adapters/dsh/lib/evolve.js', name: '@tokenwise/dsh (learning runner)', external: [] }),
  bundleNode({ entry: 'packages/cli/src/evolve-runner.ts', outfile: 'packages/cli/dist/evolve.js', name: '@tokenwise/cli (learning runner)', external: [] }),
  bundleNode({ entry: 'packages/cli/src/main.ts', outfile: 'packages/cli/dist/tokenwise.js', name: '@tokenwise/cli',
    external: [], executable: true }),
  bundleDshClient(),
])

// `tokenwise setup` installs the OpenCode and Hermes plugins from these copies when the CLI comes from npm…
rmSync(at('packages/cli/assets'), { recursive: true, force: true })
mkdirSync(at('packages/cli/assets/opencode'), { recursive: true })
copyFileSync(at('adapters/opencode/dist/index.js'), at('packages/cli/assets/opencode/tokenwise.js'))
cpSync(at('adapters/hermes/tokenwise'), at('packages/cli/assets/hermes/tokenwise'), { recursive: true,
  filter: source => !source.includes('__pycache__') })
// …and the tokenwise skill every agent gets.
cpSync(at('skills/tokenwise'), at('packages/cli/assets/skills/tokenwise'), { recursive: true })
console.log('bundled @tokenwise/pi, @tokenwise/dsh (Host and browser halves), their learning runners, @tokenwise/opencode and @tokenwise/cli')
