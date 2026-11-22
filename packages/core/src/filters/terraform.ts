import { commandIs, noiseFilter } from './noise.ts'

/** `aws_vpc.main: Refreshing state... [id=vpc-1]`, `data.aws_ami.x: Reading...`, `…: Read complete after 1s [id=…]`, `…: Still reading... [10s elapsed]`. */
const REFRESH = /^\S+: (?:Refreshing state\.\.\.|Reading\.\.\.|Read complete after \S+|Still reading\.\.\.)(?: \[[^\]]*\])?$/u
const LOCK = /^(?:Acquiring|Releasing) state lock\. This may take a few moments\.\.\.$/u
/** The plan's own report: any of its headers, summaries or "no changes" lines. */
const REPORT = /^(?:Terraform|OpenTofu) (?:will perform|used the selected providers)|^Plan: \d+ to add|^No changes\.|^(?:Apply|Destroy) complete!|^Changes to Outputs:/u

/**
 * `terraform` / `tofu` plan, apply, destroy and refresh: runs of three or
 * more refresh and read progress rows (one per resource in the state) and
 * the state-lock messages become one counted note. Every planned change,
 * attribute, warning, error, output and summary line stays verbatim.
 */
export const terraformFilter = noiseFilter({
  name: 'terraform',
  commands: command => commandIs(command, ['terraform', 'tofu'], [['plan'], ['apply'], ['destroy'], ['refresh']]),
  recognize: REPORT,
  fold: {
    kind: text => REFRESH.test(text) || LOCK.test(text) ? 'state' : undefined,
    note: count => `[${count} state refresh and read lines omitted]\n`,
  },
})
