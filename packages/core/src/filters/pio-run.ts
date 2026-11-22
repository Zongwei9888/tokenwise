import { commandIs, noiseFilter } from './noise.ts'

/** SCons build rows for files under `.pio/build/`: `Compiling .pio/build/esp32dev/src/main.cpp.o`, `Archiving …/libFrameworkArduino.a`, `Indexing …`, `Linking …`. */
const STEP = /^(?:Compiling|Archiving|Indexing|Linking|Building|Generating \w+|Retrieving maximum program size|Checking size) \.pio\/build\/\S+$/u
/** PlatformIO's own report: the environment header or the result rule. */
const REPORT = /^Processing \S+ \(.+\)$|^=+ \[(?:SUCCESS|FAILED|IGNORED)\] Took /u

/**
 * `pio run` / `platformio run`: runs of three or more compile, archive,
 * index and link rows become one counted note. Configuration, platform,
 * package and dependency lines, every compiler warning and error, memory
 * usage, and the result rule stay verbatim.
 */
export const pioRunFilter = noiseFilter({
  name: 'pio-run',
  commands: command => commandIs(command, ['pio', 'platformio'], [['run']]),
  recognize: REPORT,
  fold: {
    kind: text => STEP.test(text) ? 'build' : undefined,
    note: count => `[${count} PlatformIO compile, archive and link lines omitted]\n`,
  },
})
