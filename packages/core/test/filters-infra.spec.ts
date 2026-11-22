import { describe, expect, it } from 'vitest'
import { projectStaticFilter } from '../src/filters/index.ts'
import { terraformFilter } from '../src/filters/terraform.ts'
import { mayProject } from '../src/economy.ts'

/** Every line of `raw` that `removed` does not match appears in `text`, in order. */
function keepsAllBut(raw: string, text: string, removed: RegExp) {
  let at = 0
  for (const line of raw.split('\n').filter(line => line !== '' && !removed.test(line))) {
    const found = text.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(0)
    at = found + line.length
  }
}

const REFRESH = /: (?:Refreshing state|Reading\.\.\.|Read complete|Still reading)|state lock/u

/** A plan against a state of 40 resources, in Terraform 1.x's plain (-no-color) layout. */
const plan = [
  'Acquiring state lock. This may take a few moments...',
  'data.aws_ami.ubuntu: Reading...',
  'data.aws_ami.ubuntu: Read complete after 1s [id=ami-0abcdef1234567890]',
  ...Array.from({ length: 40 }, (_, i) => `aws_security_group_rule.ingress[${i}]: Refreshing state... [id=sgrule-${1000 + i}]`),
  '',
  'Terraform used the selected providers to generate the following execution',
  'plan. Resource actions are indicated with the following symbols:',
  '  + create',
  '  ~ update in-place',
  '',
  'Terraform will perform the following actions:',
  '',
  '  # aws_instance.web will be created',
  '  + resource "aws_instance" "web" {',
  '      + ami           = "ami-0abcdef1234567890"',
  '      + instance_type = "t3.micro"',
  '    }',
  '',
  '  # aws_s3_bucket.logs will be updated in-place',
  '  ~ resource "aws_s3_bucket" "logs" {',
  '        id   = "logs"',
  '      ~ tags = {',
  '          + "env" = "prod"',
  '        }',
  '        # (10 unchanged attributes hidden)',
  '    }',
  '',
  'Plan: 1 to add, 1 to change, 0 to destroy.',
  'Releasing state lock. This may take a few moments...',
  '',
].join('\n')

describe('terraform', () => {
  it('folds refresh and read progress, keeping every planned change and the summary', () => {
    const projected = terraformFilter.project({ command: 'terraform plan -no-color', stdout: plan, exitCode: 0 })!
    expect(projected).toContain('[43 state refresh and read lines omitted]\n')
    expect(projected).not.toContain('Refreshing state')
    keepsAllBut(plan, projected, REFRESH)
    // The lone lock release at the end is one line: cheaper kept than noted.
    expect(projected).toContain('Plan: 1 to add, 1 to change, 0 to destroy.\nReleasing state lock.')
    expect(projectStaticFilter({ command: 'tofu apply -auto-approve', stdout: plan, exitCode: 0 })?.filter).toBe('terraform')
  })

  it('keeps refresh rows that mention a problem, and leaves other commands and layouts alone', () => {
    const failing = plan.replace('aws_security_group_rule.ingress[20]: Refreshing state... [id=sgrule-1020]',
      'aws_security_group_rule.ingress[20]: Refreshing state... [id=sgrule-1020]\n│ Error: reading security group rule: AccessDenied')
    const projected = terraformFilter.project({ command: 'terraform plan', stdout: failing, exitCode: 1 })!
    expect(projected).toContain('│ Error: reading security group rule: AccessDenied')
    keepsAllBut(failing, projected, REFRESH)
    // Not a plan-family subcommand, not terraform, colored output, or no plan report at all.
    expect(terraformFilter.project({ command: 'terraform state list', stdout: plan, exitCode: 0 })).toBeUndefined()
    expect(terraformFilter.project({ command: 'terragrunt plan', stdout: plan, exitCode: 0 })).toBeUndefined()
    expect(terraformFilter.project({ command: 'terraform plan', stdout: `\u001b[1m${plan}`, exitCode: 0 })).toBeUndefined()
    const noReport = Array.from({ length: 5 }, (_, i) => `aws_vpc.v${i}: Refreshing state... [id=vpc-${i}]`).join('\n') + '\n'
    expect(terraformFilter.project({ command: 'terraform plan', stdout: noReport, exitCode: 1 })).toBeUndefined()
  })

  // Adapted from RTK's terraform-plan filter tests (Apache-2.0, see third-party/rtk).
  it('handles the short plan in RTK\'s tests: two refresh rows are kept, the plan is untouched', () => {
    const rtk = 'Acquiring state lock. This may take a few moments...\nRefreshing state... [id=vpc-abc]\nRefreshing state... [id=sg-123]\nReleasing state lock. This may take a few moments...\n\nTerraform will perform the following actions:\n\n  # aws_instance.web will be created\n  + resource "aws_instance" "web" {}\n\nPlan: 1 to add, 0 to change, 0 to destroy.\n'
    // Without a resource address these rows are not Terraform 1.x refresh rows: nothing to fold.
    expect(terraformFilter.project({ command: 'terraform plan', stdout: rtk, exitCode: 0 })).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['terraform plan', 'tofu destroy -auto-approve', 'cd ./infra && terraform apply']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('terraform fmt')).toBe(false)
  })
})
