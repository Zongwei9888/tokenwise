import { ProjectionBuilder, sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { NOT_PLAIN, PROBLEM, commandIs } from './noise.ts'

/** A host that needed nothing, or was skipped: `ok: [web01]`, `skipping: [web02]`, `ok: [web01 -> localhost] => (item=nginx)`. A result (`=> {…}`) is not one. */
const HOST_ROW = /^(ok|skipping): \[[^\]\s][^\]]*\](?: => \(item=.*\))?$/u
/** A banner padded with stars to the terminal width: `TASK [Install nginx] ****…`. */
const BANNER = /^(?:(?:PLAY|TASK|RUNNING HANDLER) \[.*\]|PLAY RECAP) \*{4,}$/u
const PLAY = /^PLAY \[.*\] \*+$/u
const RECAP = /^PLAY RECAP \*+$/u

const playbookCommand = (command: string) => commandIs(command, ['ansible-playbook'])

/**
 * `ansible-playbook` with the default callback: in each task, runs of three
 * or more `ok:` and `skipping:` host rows become one note that counts them,
 * and the star padding of PLAY, TASK and RECAP banners is cut to the three
 * stars Ansible prints on a narrow terminal. Every `changed`, `failed`,
 * `fatal`, `unreachable`, `...ignoring`, warning, result and included-file
 * row, every banner that names a problem and every PLAY RECAP row stay
 * verbatim.
 */
function projectPlaybook(input: FilterInput): MappedProjection | undefined {
  if (!playbookCommand(input.command) || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => PLAY.test(line.text)) || !lines.some(line => RECAP.test(line.text))) return undefined
  const status = (text: string) => PROBLEM.test(text) ? undefined : HOST_ROW.exec(text)?.[1]
  const builder = new ProjectionBuilder(input.stdout)
  let changed = false
  for (let i = 0; i < lines.length;) {
    let end = i
    const counts = { ok: 0, skipping: 0 }
    for (; end < lines.length; end++) {
      const kind = status(lines[end]!.text)
      if (kind === undefined) break
      counts[kind as keyof typeof counts]++
    }
    if (end - i >= 3) {
      const parts = [counts.ok > 0 ? `${counts.ok} ok` : '', counts.skipping > 0 ? `${counts.skipping} skipping` : ''].filter(Boolean)
      builder.generate(`[${parts.join(', ')} host rows omitted]\n`, 'ansible-host-rows')
      changed = true
      i = end
      continue
    }
    const stop = Math.max(end, i + 1)
    for (; i < stop; i++) {
      const line = lines[i]!
      if (BANNER.test(line.text) && !PROBLEM.test(line.text)) {
        // Keep the banner's text and three of its stars.
        builder.keep(line.start, line.start + line.text.lastIndexOf(' ') + 4)
        builder.keep(line.start + line.text.length, line.end)
        changed = true
      } else builder.keep(line.start, line.end)
    }
  }
  return changed ? builder.finish() : undefined
}

export const ansiblePlaybookFilter: EconomyFilter = {
  name: 'ansible-playbook', transformation: 'noise-removal', commands: playbookCommand,
  projectMapped: projectPlaybook, project: input => projectPlaybook(input)?.text,
}
