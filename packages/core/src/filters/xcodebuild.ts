import { toolArgv } from '../command.ts'
import { sourceLines } from '../projection-map.ts'
import type { MappedProjection } from '../projection-map.ts'
import type { EconomyFilter, FilterInput } from '../types.ts'
import { foldMarked } from './build-folds.ts'
import { NOT_PLAIN, PROBLEM } from './noise.ts'

/** A build step header (Xcode 11+): `SwiftCompile normal arm64 … (in target 'App' from project 'App')`. */
const TARGET_STEP = /^[A-Z][A-Za-z]+ .+ \(in target '[^']+' from project '[^']+'\)$/u
/** Step headers without a target: older Xcode's, and the build-planning steps. */
const NAMED_STEP = /^(?:CompileC|CompileSwift|CompileSwiftSources|SwiftCompile|SwiftDriver|SwiftDriverJobDiscovery|SwiftEmitModule|SwiftMergeGeneratedHeaders|MergeSwiftModule|Ld|Libtool|CreateBuildDirectory|MkDir|ProcessInfoPlistFile|ProcessProductPackaging|ProcessProductPackagingDER|CopySwiftLibs|CodeSign|RegisterWithLaunchServices|RegisterExecutionPolicyException|Validate|Touch|LinkStoryboards|CompileStoryboard|CompileXIB|CompileAssetCatalog|GenerateDSYMFile|PBXCp|CpResource|CpHeader|Copy|Ditto|SetMode|SetOwnerAndGroup|WriteAuxiliaryFile|CreateUniversalBinary|ClangStatCache|ExecuteExternalTool|ScanDependencies|PrecompileModule|GenerateAssetSymbols|ExtractAppIntentsMetadata|Strip|SymLink)(?: .+)?$|^(?:GatherProvisioningInputs|CreateBuildDescription|Prepare packages)$|^Build description (?:signature|path): \S+$/u
/** The command a step runs, as xcodebuild echoes it under the header (`    cd …`, `    export …`, `    /usr/bin/…`). */
const INVOCATION = /^ {4}\S/u
const isStep = (text: string) => TARGET_STEP.test(text) || NAMED_STEP.test(text)
/** The result line: `** BUILD SUCCEEDED **`, `** TEST FAILED **`, `** ARCHIVE SUCCEEDED **`. */
const RESULT = /^\*\* [A-Z ]+ (?:SUCCEEDED|FAILED|INTERRUPTED) \*\*$/u

/**
 * xcodebuild: a build step that printed nothing (its header, the `cd`,
 * `export` and command lines echoed under it, and the blank line that ends
 * it) is folded; a run of such steps becomes one note that counts them by
 * kind. A step with any output under it, or whose lines mention a problem,
 * stays whole. Every warning, error and note with its source excerpt, test
 * output, the failed-commands list and the result line stay verbatim.
 */
function projectMapped(input: FilterInput): MappedProjection | undefined {
  if (toolArgv(input.command)?.[0] !== 'xcodebuild' || NOT_PLAIN.test(input.stdout)) return undefined
  const lines = sourceLines(input.stdout)
  if (!lines.some(line => RESULT.test(line.text))) return undefined
  const marks: (string | undefined)[] = lines.map(() => undefined)
  const blank = (i: number) => lines[i]!.text.trim() === ''
  for (let i = 0; i < lines.length; i++) {
    if (!isStep(lines[i]!.text)) continue
    // The echoed invocation: indented lines, and blank lines between them (CodeSign's).
    let end = i + 1
    while (end < lines.length && (INVOCATION.test(lines[end]!.text) || blank(end) && INVOCATION.test(lines[end + 1]?.text ?? ''))) end++
    // Whatever comes before the next step or the result is this step's output: then it stays.
    let next = end
    while (next < lines.length && blank(next)) next++
    if (next < lines.length && !isStep(lines[next]!.text) && !RESULT.test(lines[next]!.text)) continue
    if (lines.slice(i, end).some(line => PROBLEM.test(line.text))) continue
    for (let j = i; j < end; j++) marks[j] = 'step'
    i = end - 1
  }
  return foldMarked(input.stdout, lines, marks, {
    label: 'xcodebuild-steps',
    note: (_count, _kind, texts) => {
      const tally = new Map<string, number>()
      for (const text of texts) if (!/^\s/u.test(text)) {
        const name = /^(?:Prepare packages|Build description|\S+)/u.exec(text)![0]
        tally.set(name, (tally.get(name) ?? 0) + 1)
      }
      const steps = [...tally.values()].reduce((sum, n) => sum + n, 0)
      return `[${steps} build ${steps === 1 ? 'step' : 'steps'} that printed nothing omitted (${texts.length} lines): ${[...tally].map(([name, n]) => `${n} ${name}`).join(', ')}]\n`
    },
  })
}

export const xcodebuildFilter: EconomyFilter = {
  name: 'xcodebuild', transformation: 'noise-removal', commands: command => toolArgv(command)?.[0] === 'xcodebuild', projectMapped,
  project: input => projectMapped(input)?.text,
}
