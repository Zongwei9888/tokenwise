import { commandIs, noiseFilter } from './noise.ts'

/** SwiftPM's step rows: `[5/10] Compiling Core Format.swift`, `[0/7] Write sources`, `[10/12] Linking Demo`. */
const STEP = /^\[\d+\/\d+\] [A-Z][a-z]+(?: .*)?$/u
/** Dependency resolution: `Fetching https://…`, `Fetched … (0.83s)`, `Computing version for …`, `Computed … at 1.3.0 (0.42s)`, working copies, updates. */
const RESOLUTION = /^(?:Fetching https?:\/\/\S+(?: from cache)?|Fetched https?:\/\/\S+(?: from cache)? \([\d.]+s\)|Computing version for https?:\/\/\S+|Computed https?:\/\/\S+ at \S+ \([\d.]+s\)|Creating working copy for https?:\/\/\S+|Working copy of https?:\/\/\S+ resolved at \S+|Updating https?:\/\/\S+|Updated https?:\/\/\S+ \([\d.]+s\))$/u

/**
 * `swift build`: runs of three or more `[n/m]` step rows and of package
 * resolution rows become counted notes. `Building for …`, every compiler
 * diagnostic with its source excerpt, every warning and error, and
 * `Build complete!` stay verbatim.
 */
export const swiftBuildFilter = noiseFilter({
  name: 'swift-build',
  commands: command => commandIs(command, ['swift'], [['build']]),
  recognize: /^Building for [\w-]+\.\.\.$/u,
  fold: {
    kind: text => STEP.test(text) ? 'step' : RESOLUTION.test(text) ? 'resolution' : undefined,
    note: (count, kind) => kind === 'step' ? `[${count} build step rows omitted]\n` : `[${count} package resolution lines omitted]\n`,
  },
})
