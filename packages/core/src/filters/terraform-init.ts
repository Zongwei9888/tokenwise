import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM, commandIs } from './noise.ts'

/**
 * Provider version lookup and download progress: `- Finding hashicorp/aws
 * versions matching "~> 5.0"...`, `- Finding latest version of …...`,
 * `- Installing hashicorp/aws v5.31.0...`, `- Reusing previous version of …
 * from the dependency lock file`. The `- Installed …` and `- Using
 * previously-installed …` rows that name each version are not among them.
 */
const LOOKUP = /^- (?:Finding (?:latest version of )?\S+(?: versions matching ".*")?\.\.\.|Installing \S+ v\S+\.\.\.|Reusing previous version of \S+ from the dependency lock file)$/u
const DONE = /^(?:Terraform|OpenTofu) has been successfully initialized!$/u
/** The two paragraphs of next-step advice every successful init ends with (Terraform and OpenTofu wording). */
const ADVICE = [
  /^You may now begin working with (?:Terraform|OpenTofu)\. Try running "(?:terraform|tofu) plan" to see$/u,
  /^any changes that are required for your infrastructure\. All (?:Terraform|OpenTofu) commands$/u,
  /^should now work\.$/u,
  /^$/u,
  /^If you ever set or change modules or backend configuration for (?:Terraform|OpenTofu),$/u,
  /^rerun this command to reinitialize your working directory\. If you forget, other$/u,
  /^commands will detect it and remind you to do so if necessary\.$/u,
]

const initCommand = (command: string) => commandIs(command, ['terraform', 'tofu'], [['init']])

/**
 * A successful `terraform init` / `tofu init`: the provider lookup and
 * download progress rows become one counted note where the first of them
 * was, and the fixed next-step advice at the end becomes another. The
 * backend and module lines, every `- Installed` / `- Using previously-installed`
 * row with its version, the signing and lock-file messages, the success
 * line, every warning and any unknown line stay verbatim.
 */
function projectInit(input: FilterInput): MappedProjection | undefined {
  if (!initCommand(input.command) || input.exitCode !== 0 || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => DONE.test(line.text))) return undefined
  const lookups = new Set(lines.filter(line => LOOKUP.test(line.text) && !PROBLEM.test(line.text)))
  const advice = lines.findIndex((_, at) => ADVICE.every((pattern, k) => pattern.test(lines[at + k]?.text ?? '\0')))
  const foldLookups = lookups.size >= 2
  if (!foldLookups && advice < 0) return undefined
  const builder = new ProjectionBuilder(input.stdout)
  let first = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (i === advice) {
      builder.generate(`[${ADVICE.length} lines of next-step advice omitted]\n`, 'terraform-init-advice')
      i += ADVICE.length - 1
    } else if (foldLookups && lookups.has(line)) {
      if (first) builder.generate(`[${lookups.size} provider lookup and download progress lines omitted]\n`, 'terraform-init-providers')
      first = false
    } else builder.keep(line.start, line.end)
  }
  return builder.finish()
}

export const terraformInitFilter: EconomyFilter = {
  name: 'terraform-init', transformation: 'noise-removal', commands: initCommand,
  projectMapped: projectInit, project: input => projectInit(input)?.text,
}
