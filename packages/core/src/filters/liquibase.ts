import { commandIs, noiseFilter } from './noise.ts'

/** The box Liquibase 4 prints before every command: `####…####` rules and `##  …  ##` rows (logo, links). */
const BANNER = /^#{20,} *$|^##(?: .*)? ## *$/u
/** Liquibase's own start-up line, so the output is the CLI's. */
const STARTED = /^Starting Liquibase at \d/u

/**
 * `liquibase` (update, status, history, …): the banner box becomes one
 * counted note. The start-up and version lines, every changeset, the update
 * summary, warnings, errors and the result line stay verbatim.
 */
export const liquibaseFilter = noiseFilter({
  name: 'liquibase',
  commands: command => commandIs(command, ['liquibase']),
  recognize: STARTED,
  fold: {
    kind: text => BANNER.test(text) ? 'banner' : undefined,
    note: count => `[${count} lines of the Liquibase banner omitted]\n`,
  },
})
