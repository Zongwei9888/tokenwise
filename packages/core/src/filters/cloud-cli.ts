import { toolArgv } from '../command.ts'
import { compactJsonDocument } from '../json-layout.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { afterGlobalOptions } from './containers.ts'
import { NOT_PLAIN, foldRuns } from './noise.ts'
import { capitalHeader, compactAlignedTables, compactPaddedTabTables } from './table-layout.ts'

// ——— helm ———

const HELM_VALUED = ['-n', '--namespace', '--kube-context', '--kubeconfig', '--registry-config', '--repository-config', '--repository-cache']

/** `helm list`, `helm history`, `helm search hub|repo` and `helm repo list`: the subcommands that print a table. */
function helmTableCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'helm') return false
  const [sub, next] = afterGlobalOptions(argv, HELM_VALUED)
  return ['list', 'ls', 'history', 'hist'].includes(sub ?? '') || sub === 'search' && ['hub', 'repo'].includes(next ?? '')
    || sub === 'repo' && ['list', 'ls'].includes(next ?? '')
}

function projectHelm(input: FilterInput): MappedProjection | undefined {
  if (!helmTableCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  return compactPaddedTabTables(input.stdout, { header: capitalHeader })
}

/**
 * helm's tables (`list`, `history`, `search`, `repo list`), whose cells are
 * padded to the column width and joined by tabs: the padding goes, every tab,
 * release, revision and value stays. A row whose status or description may
 * report a problem (`failed`, `pending-upgrade`) keeps its layout. JSON and
 * YAML output, and the release reports of install, upgrade and status, pass
 * through.
 */
export const helmFilter: EconomyFilter = {
  name: 'helm', transformation: 'lossless-formatting', commands: helmTableCommand,
  projectMapped: projectHelm, project: input => projectHelm(input)?.text,
}

// ——— aws ———

/** `aws <service> <operation>` with JSON output (the default); `aws s3` (text), `configure` and `help` print no JSON. */
function awsCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'aws' || argv.length < 3 || ['s3', 'configure', 'help'].includes(argv[1] ?? '') || argv.includes('help')) return false
  const output = argv.flatMap((arg, i) => arg === '--output' ? [argv[i + 1] ?? ''] : arg.startsWith('--output=') ? [arg.slice(9)] : [])
  return output.length === 0 || output.at(-1) === 'json'
}

function projectAws(input: FilterInput): MappedProjection | undefined {
  if (!awsCommand(input.command) || input.exitCode !== 0) return undefined
  return compactJsonDocument(input.stdout)
}

/** AWS CLI JSON output: the layout whitespace goes; every key, value, escape and order stays. Text, table and YAML output pass through. */
export const awsFilter: EconomyFilter = {
  name: 'aws', transformation: 'lossless-formatting', commands: awsCommand,
  projectMapped: projectAws, project: input => projectAws(input)?.text,
}

// ——— gcloud ———

/** The `--format` gcloud was given, or '' for its default. */
function gcloudFormat(argv: readonly string[]): string {
  let format = ''
  argv.forEach((arg, i) => {
    if (arg === '--format') format = argv[i + 1] ?? ''
    else if (arg.startsWith('--format=')) format = arg.slice(9)
  })
  return format
}

/** A `gcloud … list` command (a table by default), or any gcloud command asked for JSON or a table. */
function gcloudCommand(command: string): boolean {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'gcloud') return false
  const format = gcloudFormat(argv)
  return /^(?:json|table)\b/u.test(format) || format === '' && argv.includes('list')
}

function projectGcloud(input: FilterInput): MappedProjection | undefined {
  if (!gcloudCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  return /^json\b/u.test(gcloudFormat(toolArgv(input.command)!)) ? compactJsonDocument(input.stdout)
    : compactAlignedTables(input.stdout, { header: capitalHeader })
}

/**
 * gcloud: `list` tables (and `--format=table`) have their column padding
 * replaced by one tab between cells (an empty cell stays an empty field);
 * `--format=json` loses its layout whitespace. Every resource, column, value
 * and field stays; a row whose status may report a problem keeps its layout.
 */
export const gcloudFilter: EconomyFilter = {
  name: 'gcloud', transformation: 'lossless-formatting', commands: gcloudCommand,
  projectMapped: projectGcloud, project: input => projectGcloud(input)?.text,
}

// ——— skopeo ———

/** One layer of `skopeo copy` / `sync` progress, as printed without a terminal: `Copying blob sha256:<digest>`, maybe `done` or `skipped: already exists`. */
const BLOB = /^Copying blob (?:sha256:[0-9a-f]{64}|[0-9a-f]{12})(?: done| skipped: already exists)?$/u

function skopeoSubcommand(command: string): string | undefined {
  const argv = toolArgv(command)
  if (argv?.[0] !== 'skopeo') return undefined
  const sub = afterGlobalOptions(argv, ['--command-timeout', '--policy', '--registries.d', '--tmpdir', '--override-arch', '--override-os', '--override-variant'])[0]
  return ['inspect', 'list-tags', 'copy', 'sync'].includes(sub ?? '') ? sub : undefined
}

function projectSkopeo(input: FilterInput): MappedProjection | undefined {
  const sub = skopeoSubcommand(input.command)
  if (sub === undefined || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  if (sub === 'inspect' || sub === 'list-tags') return compactJsonDocument(input.stdout)
  return foldRuns(input.stdout, { kind: text => BLOB.test(text) ? 'blob' : undefined, note: count => `[${count} blob copy lines omitted]\n`, label: 'skopeo-blobs' })
}

/**
 * skopeo: `inspect` and `list-tags` JSON loses its layout whitespace (every
 * tag, layer and field stays); in `copy` and `sync`, runs of three or more
 * `Copying blob` rows become one counted note. `Getting image source
 * signatures`, `Copying config`, `Writing manifest`, every image line and
 * anything else stay verbatim.
 */
export const skopeoFilter: EconomyFilter = {
  name: 'skopeo', transformation: 'noise-removal', commands: command => skopeoSubcommand(command) !== undefined,
  projectMapped: projectSkopeo, project: input => projectSkopeo(input)?.text,
}
