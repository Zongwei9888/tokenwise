import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { foldMarked } from './build-folds.ts'
import { gradleNoise, gradleNote } from './gradle.ts'
import { NOT_PLAIN } from './noise.ts'

/** The ASCII art of Spring Boot's default banner (its version line, `:: Spring Boot ::`, stays). */
const BANNER = new Set([
  '  .   ____          _            __ _ _',
  ' /\\\\ / ___\'_ __ _ _(_)_ __  __ _ \\ \\ \\ \\',
  '( ( )\\___ | \'_ | \'_| | \'_ \\/ _` | \\ \\ \\ \\',
  ' \\\\/  ___)| |_)| | | | | || (_| |  ) ) ) )',
  '  \'  |____| .__|_| |_|_| |_\\__, | / / / /',
  ' =========|_|==============|___/=/_/_/_/',
])
const VERSION = /^ :: Spring Boot :: +\(v[\w.-]+\)$/u
/** Spring Boot's console layout (2.x and 3.x, with or without the application name): timestamp, level, PID, thread, logger, message. */
const LOG = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]\d{3}(?:Z|[+-]\d{2}:?\d{2})? +(TRACE|DEBUG|INFO|WARN|ERROR) +\d+ --- (?:\[[^\]]*\] +)?\[[^\]]*\] +\S+ +:(?: (.*))?$/u
/**
 * Messages Spring Boot, Tomcat, Spring Data, Hibernate and Hikari log at
 * INFO on every start and stop. Not here, so they stay: the app's own lines,
 * active profiles, the port the server started on, `Started … in …`,
 * generated passwords, migrations and anything else.
 */
const ROUTINE = [
  /^Bootstrapping Spring Data \w+ repositories in \w+ mode\.$/u,
  /^Finished Spring Data repository scanning in \d+ ?ms\. Found \d+ \w+ repository interfaces?\.$/u,
  /^Multiple Spring Data modules found, entering strict repository configuration mode$/u,
  /^Tomcat initialized with port(?:\(s\):)? \d+ \(https?\)$/u,
  /^Starting service \[Tomcat\]$/u,
  /^Stopping service \[Tomcat\]$/u,
  /^Starting Servlet engine: \[Apache Tomcat\/[\w.-]+\]$/u,
  /^Starting ProtocolHandler \["[^"]+"\]$/u,
  /^Initializing Spring embedded WebApplicationContext$/u,
  /^Root WebApplicationContext: initialization completed in \d+ ms$/u,
  /^Initializing Spring DispatcherServlet '[^']*'$/u,
  /^Initializing Servlet '[^']*'$/u,
  /^Completed initialization in \d+ ms$/u,
  /^HHH\d+: /u,
  /^HikariPool-\d+ - (?:Starting\.\.\.|Start completed\.|Added connection \S+.*|Shutdown initiated\.\.\.|Shutdown completed\.)$/u,
  /^No LoadTimeWeaver setup: ignoring JPA class transformer$/u,
  /^(?:Initialized|Closing) JPA EntityManagerFactory for persistence unit '[^']*'$/u,
  /^Exposing \d+ endpoints? beneath base path '[^']*'$/u,
  /^LiveReload server is running on port \d+$/u,
  /^Devtools property defaults active! Set '[^']+' to 'false' to disable$/u,
  /^For additional web related logging consider setting the '[^']+' property to 'DEBUG'$/u,
  /^Adding welcome page(?: template)?: .+$/u,
]
/** A start-up line: the banner's version line, or the line Spring Boot logs as it starts the application. */
const STARTUP = /^ :: Spring Boot :: |^\S+ +INFO .* : Starting \S+ (?:v\S+ )?using Java /u

export function springBootCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv === undefined) return false
  const [tool, ...args] = argv
  if (tool === 'mvn' || tool === 'mvnw') return args.includes('spring-boot:run')
  if (tool === 'gradle' || tool === 'gradlew') return args.some(arg => /^(?::[\w.-]+)*:?bootRun$/u.test(arg))
  if (tool === 'java') return args.some((arg, i) => arg === '-jar' && /\.jar$/u.test(args[i + 1] ?? ''))
  return false
}

/**
 * Spring Boot start-up output (`mvn spring-boot:run`, `./gradlew bootRun`,
 * `java -jar app.jar`): the banner's ASCII art and runs of three or more
 * routine INFO lines from the framework (Tomcat, Spring Data, Hibernate,
 * Hikari) become counted notes; under Gradle, so do its quiet task rows.
 * Every WARN and ERROR line, stack traces, the failure analysis, the app's
 * own log lines, active profiles, ports, `Started … in …` and any line not
 * recognized stay verbatim. A routine line with text continued under it stays.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (!springBootCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => STARTUP.test(line.text))) return undefined
  const tool = toolArgv(input.command)?.[0]
  const marks = tool === 'gradle' || tool === 'gradlew' ? gradleNoise(lines) : lines.map(() => undefined)
  const nextText = (i: number): string | undefined => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.text.trim() !== '') return lines[j]!.text
    return undefined
  }
  for (const [i, line] of lines.entries()) {
    if (BANNER.has(line.text.trimEnd())) { marks[i] = 'banner'; continue }
    const log = LOG.exec(line.text)
    if (log?.[1] !== 'INFO' || !ROUTINE.some(pattern => pattern.test(log[2] ?? ''))) continue
    // A message continued on the lines below (a stack trace, a report) keeps its header.
    const next = nextText(i)
    if (next === undefined || LOG.test(next) || VERSION.test(next)) marks[i] = 'routine'
  }
  return foldMarked(input.stdout, lines, marks, {
    label: 'spring-boot-folded',
    note: (count, kind, texts) => kind === 'banner' ? `[${count} lines of the Spring Boot banner omitted]\n`
      : kind === 'routine' ? `[${count} routine Spring Boot, Tomcat, Hibernate and Hikari INFO lines omitted]\n`
        : gradleNote(count, kind, texts),
  })
}

export const springBootFilter: EconomyFilter = {
  name: 'spring-boot', transformation: 'noise-removal', commands: springBootCommand, projectMapped,
  project: input => projectMapped(input)?.text,
}
