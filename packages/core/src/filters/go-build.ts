import { commandIs, noiseFilter } from './noise.ts'

/** Module resolution rows: `go: downloading github.com/x/y v1.2.3`, `go: extracting …`, `go: finding module for package …`, `go: found … in … v1.2.3`. */
const MODULE = /^go: (?:downloading \S+ v\S+|extracting \S+ v\S+|finding module for package \S+|found \S+ in \S+ v\S+)$/u

/**
 * `go build`, `go install` and `go vet`: runs of three or more module
 * download and resolution rows become one counted note. Package headers
 * (`# pkg`), every compiler and vet diagnostic, and any row naming a module
 * whose path has a problem word in it (`pkg/errors`) stay verbatim.
 */
export const goBuildFilter = noiseFilter({
  name: 'go-build',
  // The go command prints module downloads and compiler diagnostics on stderr.
  stderr: true,
  commands: command => commandIs(command, ['go'], [['build'], ['install'], ['vet']]),
  fold: {
    kind: text => MODULE.test(text) ? 'module' : undefined,
    note: count => `[${count} Go module download lines omitted]\n`,
  },
})
