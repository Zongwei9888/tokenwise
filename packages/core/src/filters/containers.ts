import { toolArgv } from '../command.ts'
import { compactJsonDocument } from '../json-layout.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN } from './noise.ts'
import { capitalHeader, compactAlignedTables } from './table-layout.ts'

/** The words after a program's leading global options; `valued` names the options that take a value (`kubectl -n prod get pods` → `get pods`). */
export function afterGlobalOptions(argv: readonly string[], valued: readonly string[]): readonly string[] {
  let at = 1
  while (at < argv.length && argv[at]!.startsWith('-')) at += valued.includes(argv[at]!) ? 2 : 1
  return argv.slice(at)
}

function dockerPsCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] === 'docker-compose') return argv[1] === 'ps'
  if (argv?.[0] !== 'docker') return false
  return argv[1] === 'ps' || argv[1] === 'container' && ['ls', 'list', 'ps'].includes(argv[2] ?? '') || argv[1] === 'compose' && argv[2] === 'ps'
}

function dockerImagesCommand(command: string): boolean {
  const argv = toolArgv(command)
  return argv?.[0] === 'docker' && (argv[1] === 'images' || argv[1] === 'image' && ['ls', 'list'].includes(argv[2] ?? ''))
}

/** A successful listing laid out as a table: its column padding becomes one tab between cells. */
function tableListing(claims: (command: string) => boolean) {
  return (input: FilterInput): MappedProjection | undefined => {
    if (!claims(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
    return compactAlignedTables(input.stdout, { header: capitalHeader })
  }
}

const projectDockerPs = tableListing(dockerPsCommand)
const projectDockerImages = tableListing(dockerImagesCommand)

/**
 * `docker ps`, `docker container ls` and `docker compose ps` tables: the
 * column padding becomes one tab between cells (an empty PORTS cell stays an
 * empty field). Every container, column and value stays; a row whose status
 * may report a problem (`Exited (1)`, `Restarting`, `unhealthy`) keeps its
 * layout. `--format` templates without a table, `-q` and JSON pass through.
 */
export const dockerPsFilter: EconomyFilter = {
  name: 'docker-ps', transformation: 'lossless-formatting', commands: dockerPsCommand,
  projectMapped: projectDockerPs, project: input => projectDockerPs(input)?.text,
}

/** `docker images` / `docker image ls` tables: the column padding becomes one tab between cells; every image and value stays. */
export const dockerImagesFilter: EconomyFilter = {
  name: 'docker-images', transformation: 'lossless-formatting', commands: dockerImagesCommand,
  projectMapped: projectDockerImages, project: input => projectDockerImages(input)?.text,
}

// ——— kubectl get ———

/** kubectl's global options that take a value, when they come before the subcommand. */
const KUBECTL_VALUED = ['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--as']

/** The arguments of `kubectl get`, or undefined for any other command. */
function kubectlGetArgs(command: string): readonly string[] | undefined {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'kubectl') return undefined
  const words = afterGlobalOptions(argv, KUBECTL_VALUED)
  return words[0] === 'get' ? words.slice(1) : undefined
}

/** The `-o` / `--output` format named last, or '' for the default table. */
function outputFormat(args: readonly string[]): string {
  let format = ''
  args.forEach((arg, i) => {
    if (arg === '-o' || arg === '--output') format = args[i + 1] ?? ''
    else if (arg.startsWith('--output=')) format = arg.slice(9)
    else if (/^-o./u.test(arg)) format = arg.slice(arg[2] === '=' ? 3 : 2)
  })
  return format
}

function projectKubectlGet(input: FilterInput): MappedProjection | undefined {
  const args = kubectlGetArgs(input.command)
  if (args === undefined || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  if (args.some(arg => /^(?:-w|--watch|--watch-only)(?:=|$)/u.test(arg))) return undefined
  const format = outputFormat(args)
  if (format === 'json') return compactJsonDocument(input.stdout)
  if (format === '' || format === 'wide' || format.startsWith('custom-columns')) return compactAlignedTables(input.stdout, { header: capitalHeader })
  return undefined
}

/**
 * `kubectl get`: tables (default, `-o wide`, capital custom columns) have
 * their column padding replaced by one tab between cells, table by table
 * (`kubectl get all`); `-o json` loses its layout whitespace. Every object,
 * column, value and field stays; a row whose state may report a problem
 * (`CrashLoopBackOff`, `Error`, `NotReady`, `Pending`) keeps its layout.
 * YAML, names, templates and watches pass through.
 */
export const kubectlGetFilter: EconomyFilter = {
  name: 'kubectl-get', transformation: 'lossless-formatting', commands: command => kubectlGetArgs(command) !== undefined,
  projectMapped: projectKubectlGet, project: input => projectKubectlGet(input)?.text,
}
