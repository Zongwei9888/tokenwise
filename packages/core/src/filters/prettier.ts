import { jsToolArgv } from './js-tool.ts'
import { noiseFilter } from './noise.ts'

/** `src/components/a.js 2ms (unchanged)`: a file `--write` left as it was (`(cached)` with `--cache`). */
const UNCHANGED = /^\S.* \d+ms \((?:unchanged|cached)\)$/u
/** Any file row of `--write`, changed or not. */
const FILE_ROW = /^\S.* \d+ms(?: \((?:unchanged|cached)\))?$/u

/**
 * `prettier --write`: runs of three or more files it left unchanged become one
 * counted note. Every file it rewrote, every `[warn]` and `[error]` line and
 * every other line stay verbatim. (`--check` prints only the files that are
 * not formatted and a summary, so it is left alone.)
 */
export const prettierFilter = noiseFilter({
  name: 'prettier',
  commands: command => jsToolArgv(command, ['prettier'])?.some(arg => arg === '--write' || arg === '-w') === true,
  recognize: FILE_ROW,
  fold: {
    kind: text => UNCHANGED.test(text) ? 'unchanged' : undefined,
    note: count => `[${count} unchanged files omitted]\n`,
  },
})
