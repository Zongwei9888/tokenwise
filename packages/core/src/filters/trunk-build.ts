import { commandIs, noiseFilter } from './noise.ts'

/** Cargo's progress rows as trunk streams them: `   Compiling serde v1.0.195`, `Checking …`, `Downloaded …`, `Fresh …`. */
const CARGO = /^\s+(?:Compiling|Checking|Downloading|Downloaded|Fresh) [\w.-]+ v\d\S*(?: \(.+\))?$/u
/** Trunk's own log rows (`2024-01-15T10:30:00.123456Z  INFO 📦 starting build`) or Cargo's `Finished` line. */
const REPORT = /^\S+ +INFO .*(?:starting build|success)|^\s+Finished .+ target\(s\) in /u

/**
 * `trunk build`: runs of three or more Cargo compile and download rows
 * become one counted note. Trunk's own log rows, Cargo's `Finished` line,
 * every warning and error, wasm-bindgen and asset-pipeline output stay
 * verbatim.
 */
export const trunkBuildFilter = noiseFilter({
  name: 'trunk-build',
  commands: command => commandIs(command, ['trunk'], [['build']]),
  recognize: REPORT,
  fold: {
    kind: text => CARGO.test(text) ? 'cargo' : undefined,
    note: count => `[${count} Cargo compile and download rows omitted]\n`,
  },
})
