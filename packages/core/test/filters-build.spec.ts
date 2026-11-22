import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectStaticFilter } from '../src/filters/index.ts'
import { ccFilter } from '../src/filters/cc.ts'
import { dotnetBuildFilter } from '../src/filters/dotnet-build.ts'
import { goBuildFilter } from '../src/filters/go-build.ts'
import { gradleFilter } from '../src/filters/gradle.ts'
import { liquibaseFilter } from '../src/filters/liquibase.ts'
import { mixCompileFilter } from '../src/filters/mix-compile.ts'
import { pioRunFilter } from '../src/filters/pio-run.ts'
import { springBootFilter } from '../src/filters/spring-boot.ts'
import { swiftBuildFilter } from '../src/filters/swift-build.ts'
import { trunkBuildFilter } from '../src/filters/trunk-build.ts'
import { xcodebuildFilter } from '../src/filters/xcodebuild.ts'
import { mayProject } from '../src/economy.ts'

/**
 * Real outputs captured on macOS (Apple clang 21, Swift 6.3, Gradle 7.2 on
 * Java 8, all offline in a temp directory; project paths replaced by /repo),
 * and outputs from RTK's fixtures (`rtk-*`); see fixtures/build/.
 */
const fixture = (name: string) => readFileSync(new URL(`fixtures/build/${name}`, import.meta.url), 'utf8')

/** Every line of `raw` that `removed` does not match appears in `text`, in order. */
function keepsAllBut(raw: string, text: string, removed: RegExp) {
  let at = 0
  for (const line of raw.split('\n').filter(line => line !== '' && !removed.test(line))) {
    const found = text.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(0)
    at = found + line.length
  }
}

const lines = (...rows: string[]) => rows.join('\n') + '\n'

describe('go-build', () => {
  // Module rows adapted from RTK's go_cmd.rs tests (Apache-2.0, see third-party/rtk); the rest is synthetic, in go 1.22's format.
  const build = lines(
    'go: downloading github.com/spf13/cobra v1.8.0',
    'go: downloading github.com/spf13/pflag v1.0.5',
    'go: downloading github.com/inconshreveable/mousetrap v1.1.0',
    'go: downloading github.com/hashicorp/go-multierror v1.1.1',
    'go: downloading github.com/hashicorp/errwrap v1.1.0',
    'go: downloading golang.org/x/sync v0.6.0',
    'go: downloading golang.org/x/text v0.14.0',
    'go: downloading gopkg.in/yaml.v3 v3.0.1',
    '# example.com/tool/cmd',
    'cmd/root.go:10:5: undefined: missingFunc',
    'cmd/root.go:15:2: cannot use x (variable of type int) as string value in assignment',
  )
  const MODULE = /^go: downloading /u

  it('folds module download rows, keeping package headers, diagnostics and rows that name a problem word', () => {
    const projected = goBuildFilter.project({ command: 'go build ./...', stdout: build, exitCode: 1 })!
    // `errwrap` has "err" but not a problem word; `go-multierror` has "error": that row stays and splits the run.
    expect(projected).toBe(lines(
      '[3 Go module download lines omitted]',
      'go: downloading github.com/hashicorp/go-multierror v1.1.1',
      '[4 Go module download lines omitted]',
      '# example.com/tool/cmd',
      'cmd/root.go:10:5: undefined: missingFunc',
      'cmd/root.go:15:2: cannot use x (variable of type int) as string value in assignment',
    ))
    keepsAllBut(build, projected, MODULE)
    expect(projectStaticFilter({ command: 'go vet ./...', stdout: build, exitCode: 1 })?.filter).toBe('go-build')
    expect(goBuildFilter.project({ command: 'go install example.com/tool@latest', stdout: build, exitCode: 0 })).toContain('[3 Go module download lines omitted]')
  })

  it('leaves other go commands, ANSI output and output without module rows alone', () => {
    expect(goBuildFilter.project({ command: 'go mod download', stdout: build, exitCode: 0 })).toBeUndefined()
    expect(goBuildFilter.project({ command: 'go run .', stdout: build, exitCode: 0 })).toBeUndefined()
    expect(goBuildFilter.project({ command: 'cargo build', stdout: build, exitCode: 0 })).toBeUndefined()
    expect(goBuildFilter.project({ command: 'go build', stdout: `\u001b[1m${build}`, exitCode: 1 })).toBeUndefined()
    expect(goBuildFilter.project({ command: 'go vet', stdout: '# example.com/x\n./x.go:3:2: fmt.Printf format %d has arg s of wrong type string\n', exitCode: 1 })).toBeUndefined()
  })
})

describe('cc', () => {
  const EXCERPT = /^ *(?:\d+ )?\|/u

  it('drops the excerpt of a macro note that repeats at every use, keeping every diagnostic line', () => {
    const raw = fixture('clang-macro-notes.txt')
    const projected = ccFilter.project({ command: 'cc -Wall -Wextra -fsyntax-only m.c', stdout: raw, exitCode: 0 })!
    expect(projected.match(/\[source excerpt: same as above\]\n/gu)).toHaveLength(4)
    expect(projected).toContain("m.c:6:11: warning: format specifies type 'char *' but the argument has type 'int' [-Wformat]\n    6 |   LOG_INT(b);\n      |   ~~~~~~~~^~\nm.c:2:35: note: expanded from macro 'LOG_INT'\n[source excerpt: same as above]\n")
    // Every diagnostic line stays, and the first excerpt of the macro.
    for (const line of raw.split('\n').filter(line => /: (?:warning|note): /u.test(line))) expect(projected).toContain(line)
    expect(projected).toContain('    2 | #define LOG_INT(v) printf("%s\\n", v)')
    keepsAllBut(raw, projected, EXCERPT)
    expect(projected).toMatch(/6 warnings generated\.\n$/u)
  })

  it('keeps one note for a run of repeated candidates, and the include chain of a header warned about twice', () => {
    const candidates = fixture('clang++-candidates.txt')
    const projected = ccFilter.project({ command: 'clang++ -std=c++17 -c o.cpp', stdout: candidates, exitCode: 1 })!
    expect(projected).toContain("o.cpp:8:3: error: no matching function for call to 'draw'\n    8 |   draw(q);\n      |   ^~~~\no.cpp:3:6: note: candidate function not viable: no known conversion from 'Point' to 'int' for 1st argument\no.cpp:4:6:")
    expect(projected).toContain('requires 2 arguments, but 1 was provided\n[source excerpts of these 3: same as above]\n2 errors generated.\n')
    keepsAllBut(candidates, projected, EXCERPT)
    const header = fixture('clang-header-twice.txt')
    const twice = projectStaticFilter({ command: 'gcc -Wall -c a.c b.c', stdout: header, exitCode: 0 })!
    expect(twice.filter).toBe('cc')
    expect(twice.text).toContain("In file included from b.c:1:\n./h.h:2:32: warning: unused variable 'unused' [-Wunused-variable]\n[source excerpt: same as above]\n1 warning generated.\n")
    keepsAllBut(header, twice.text, EXCERPT)
  })

  it('handles GCC\'s layout, and keeps excerpts seen for the first time or too short to be worth a note', () => {
    // Synthetic, in GCC 13's format: an `In function` line, labels under the caret and a fix-it row.
    const gcc = lines(
      "m.c: In function 'report':",
      "m.c:5:18: warning: format '%s' expects argument of type 'char *', but argument 2 has type 'int' [-Wformat=]",
      '    5 |   LOG_INT(a);',
      '      |           ^',
      '      |           |',
      '      |           int',
      "m.c:2:30: note: format string is defined here",
      '    2 | #define LOG_INT(v) printf("%s\\n", v)',
      '      |                             ~^',
      '      |                              |',
      '      |                              char *',
      '      |                             %d',
      "m.c:6:18: warning: format '%s' expects argument of type 'char *', but argument 2 has type 'int' [-Wformat=]",
      '    6 |   LOG_INT(b);',
      '      |           ^',
      '      |           |',
      '      |           int',
      "m.c:2:30: note: format string is defined here",
      '    2 | #define LOG_INT(v) printf("%s\\n", v)',
      '      |                             ~^',
      '      |                              |',
      '      |                              char *',
      '      |                             %d',
      "m.c:9:3: error: implicit declaration of function 'puts' [-Wimplicit-function-declaration]",
      '    9 |   puts("x");',
      '      |   ^~~~',
      "m.c:1:1: note: include '<stdio.h>' or provide a declaration of 'puts'",
      '  +++ |+#include <stdio.h>',
      '    1 | #define LOG_INT(v) printf("%s\\n", v)',
    )
    const projected = ccFilter.project({ command: 'gcc-13 -Wall -c m.c', stdout: gcc, exitCode: 1 })!
    expect(projected).toContain("m.c:2:30: note: format string is defined here\n[source excerpt: same as above]\nm.c:9:3: error: implicit declaration of function 'puts'")
    expect(projected).toContain('  +++ |+#include <stdio.h>')
    keepsAllBut(gcc, projected, EXCERPT)
    // A repeat whose excerpt is shorter than the note stays as it is: nothing to gain.
    const short = lines('a.c:1:1: warning: x', '    1 | a', 'a.c:1:1: warning: x', '    1 | a')
    expect(ccFilter.project({ command: 'cc a.c', stdout: short, exitCode: 0 })).toBeUndefined()
  })

  it('leaves distinct diagnostics, other modes, other tools and colored output alone', () => {
    const raw = fixture('clang-macro-notes.txt')
    expect(ccFilter.project({ command: 'clang -fsyntax-only m.c', stdout: fixture('swift-build-fail.txt'), exitCode: 1 })).toBeUndefined()
    expect(ccFilter.project({ command: 'cc -E m.c', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(ccFilter.project({ command: 'gcc --version', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(ccFilter.project({ command: 'clang -fdiagnostics-format=sarif m.c', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(ccFilter.project({ command: 'tcc m.c', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(ccFilter.project({ command: 'cc m.c', stdout: `\u001b[1m${raw}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('swift-build', () => {
  const STEP = /^\[\d+\/\d+\] /u

  it('folds [n/m] step rows, keeping every diagnostic with its excerpt and the result', () => {
    const fresh = fixture('swift-build-fresh.txt')
    const projected = swiftBuildFilter.project({ command: 'swift build', stdout: fresh, exitCode: 0 })!
    expect(projected).toBe(lines(
      'Building for debugging...',
      '[6 build step rows omitted]',
      "/repo/Sources/Core/Greeter.swift:2:7: warning: variable 'message' was never mutated; consider changing to 'let' constant",
      '1 | public func greet(_ name: String) -> String {',
      '2 |   var message = "Hello, \\(name)!"',
      "  |       `- warning: variable 'message' was never mutated; consider changing to 'let' constant",
      '3 |   return message',
      '4 | }',
      '[6 build step rows omitted]',
      'Build complete! (19.47s)',
    ))
    const failed = fixture('swift-build-fail.txt')
    const errors = projectStaticFilter({ command: 'swift build -c release', stdout: failed, exitCode: 1 })!
    expect(errors.filter).toBe('swift-build')
    keepsAllBut(failed, errors.text, STEP)
  })

  it('folds package resolution, and leaves a no-op build, swift test, other tools and ANSI alone', () => {
    // Synthetic, in SwiftPM 5.9's resolution format.
    const resolving = lines(
      'Fetching https://github.com/apple/swift-argument-parser.git',
      'Fetched https://github.com/apple/swift-argument-parser.git from cache (0.83s)',
      'Computing version for https://github.com/apple/swift-argument-parser.git',
      'Computed https://github.com/apple/swift-argument-parser.git at 1.3.0 (0.42s)',
      'Creating working copy for https://github.com/apple/swift-argument-parser.git',
      'Working copy of https://github.com/apple/swift-argument-parser.git resolved at 1.3.0',
      'Building for debugging...',
      'Build complete! (0.52s)',
    )
    expect(swiftBuildFilter.project({ command: 'swift build', stdout: resolving, exitCode: 0 })).toBe('[6 package resolution lines omitted]\nBuilding for debugging...\nBuild complete! (0.52s)\n')
    // Two step rows: one note would cost as much.
    expect(swiftBuildFilter.project({ command: 'swift build', stdout: fixture('swift-build-noop.txt'), exitCode: 0 })).toBeUndefined()
    const fresh = fixture('swift-build-fresh.txt')
    expect(swiftBuildFilter.project({ command: 'swift test', stdout: fresh, exitCode: 0 })).toBeUndefined()
    expect(swiftBuildFilter.project({ command: 'swift package resolve', stdout: resolving, exitCode: 0 })).toBeUndefined()
    expect(swiftBuildFilter.project({ command: 'swift build', stdout: `\u001b[1m${fresh}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('xcodebuild', () => {
  // Synthetic, in Xcode 15's xcodebuild layout (DerivedData paths shortened).
  const DD = '/Users/demo/Library/Developer/Xcode/DerivedData/App-abcdefghijkl/Build'
  const TOOLS = '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin'
  const swiftCompile = (file: string) => [
    `SwiftCompile normal arm64 Compiling\\ ${file} /Users/demo/App/App/${file} (in target 'App' from project 'App')`,
    '    cd /Users/demo/App',
    `    builtin-swiftTaskExecution -- ${TOOLS}/swift-frontend -frontend -c -primary-file /Users/demo/App/App/${file} -target arm64-apple-macos14.0 -Onone -module-name App -o ${DD}/Intermediates.noindex/App.build/Debug/App.build/Objects-normal/arm64/${file.replace('.swift', '.o')}`,
    '',
  ]
  const build = (failure: boolean) => lines(
    'Command line invocation:',
    '    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme App -destination platform=macOS build',
    '',
    'Prepare packages',
    '',
    'ComputeTargetDependencyGraph',
    'note: Building targets in dependency order',
    'note: Target dependency graph (1 target)',
    "    Target 'App' in project 'App' (no dependencies)",
    '',
    'GatherProvisioningInputs',
    '',
    'CreateBuildDescription',
    '',
    `ExecuteExternalTool ${TOOLS}/swiftc --version`,
    '',
    'Build description signature: 5c0d6f2b4e1a9c3d7f8e6b5a4c3d2e1f',
    `Build description path: ${DD}/Intermediates.noindex/XCBuildData/5c0d6f2b4e1a9c3d7f8e6b5a4c3d2e1f.xcbuilddata`,
    `CreateBuildDirectory ${DD}/Products (in target 'App' from project 'App')`,
    '    cd /Users/demo/App',
    `    builtin-create-build-directory ${DD}/Products`,
    '',
    `MkDir ${DD}/Products/Debug/App.app (in target 'App' from project 'App')`,
    '    cd /Users/demo/App',
    `    /bin/mkdir -p ${DD}/Products/Debug/App.app`,
    '',
    `CompileC ${DD}/Intermediates.noindex/App.build/Debug/App.build/Objects-normal/arm64/shim.o /Users/demo/App/App/shim.c normal arm64 c com.apple.compilers.llvm.clang.1_0.compiler (in target 'App' from project 'App')`,
    '    cd /Users/demo/App',
    `    ${TOOLS}/clang -x c -target arm64-apple-macos14.0 -fmessage-length\\=0 -std\\=gnu11 -O0 -Wno-missing-field-initializers -Wno-missing-prototypes -Werror\\=return-type -c /Users/demo/App/App/shim.c -o ${DD}/Intermediates.noindex/App.build/Debug/App.build/Objects-normal/arm64/shim.o`,
    '',
    ...swiftCompile('AppDelegate.swift'),
    ...swiftCompile('ViewController.swift'),
    "/Users/demo/App/App/ViewController.swift:12:13: warning: initialization of immutable value 'x' was never used; consider replacing with assignment to '_' or removing it",
    '        let x = 5',
    '        ~~~~^',
    '        _',
    '',
    ...swiftCompile('Store.swift'),
    ...swiftCompile('Model.swift'),
    ...failure ? [
      "/Users/demo/App/App/Model.swift:8:16: error: cannot find 'missing' in scope",
      '        return missing',
      '               ^~~~~~~',
      '',
      '** BUILD FAILED **',
      '',
      '',
      'The following build commands failed:',
      "\tSwiftCompile normal arm64 Compiling\\ Model.swift /Users/demo/App/App/Model.swift (in target 'App' from project 'App')",
      '(1 failure)',
    ] : [
      `Ld ${DD}/Products/Debug/App.app/Contents/MacOS/App normal (in target 'App' from project 'App')`,
      '    cd /Users/demo/App',
      `    ${TOOLS}/clang -Xlinker -reproducible -target arm64-apple-macos14.0 -o ${DD}/Products/Debug/App.app/Contents/MacOS/App`,
      '',
      `CodeSign ${DD}/Products/Debug/App.app (in target 'App' from project 'App')`,
      '    cd /Users/demo/App',
      '    ',
      '    Signing Identity:     "Sign to Run Locally"',
      '    ',
      `    /usr/bin/codesign --force --sign - --timestamp\\=none --generate-entitlement-der ${DD}/Products/Debug/App.app`,
      '',
      `RegisterWithLaunchServices ${DD}/Products/Debug/App.app (in target 'App' from project 'App')`,
      '    cd /Users/demo/App',
      `    /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister -f -R -trusted ${DD}/Products/Debug/App.app`,
      '',
      '** BUILD SUCCEEDED **',
    ],
  )
  const STEP = /^(?:[A-Z]\w+ .*\(in target '|ExecuteExternalTool |Build description |Prepare packages$|GatherProvisioningInputs$|CreateBuildDescription$| {4}\S| +$)/u

  it('folds steps that printed nothing, counted by kind, and keeps every step with output or a problem word', () => {
    const raw = build(false)
    const projected = xcodebuildFilter.project({ command: 'xcodebuild -scheme App -destination platform=macOS build', stdout: raw, exitCode: 0 })!
    expect(projected).toContain('Prepare packages\n\nComputeTargetDependencyGraph\nnote: Building targets in dependency order')
    expect(projected).toContain('\n[7 build steps that printed nothing omitted (11 lines): 1 GatherProvisioningInputs, 1 CreateBuildDescription, 1 ExecuteExternalTool, 2 Build description, 1 CreateBuildDirectory, 1 MkDir]\n\nCompileC ')
    // The C compile echoes `-Werror=…` and `-Wno-missing-…`: it stays whole.
    expect(projected).toContain('-Werror\\=return-type -c /Users/demo/App/App/shim.c')
    expect(projected).toContain('\n[1 build step that printed nothing omitted (3 lines): 1 SwiftCompile]\n')
    // The step that warned keeps its header, invocation and the warning.
    expect(projected).toContain("SwiftCompile normal arm64 Compiling\\ ViewController.swift /Users/demo/App/App/ViewController.swift (in target 'App' from project 'App')\n    cd /Users/demo/App\n")
    expect(projected).toContain("initialization of immutable value 'x' was never used; consider replacing with assignment to '_' or removing it\n        let x = 5\n        ~~~~^\n        _\n")
    expect(projected).toContain('\n[5 build steps that printed nothing omitted (16 lines): 2 SwiftCompile, 1 Ld, 1 CodeSign, 1 RegisterWithLaunchServices]\n\n** BUILD SUCCEEDED **\n')
    expect(projected).toMatch(/\n\*\* BUILD SUCCEEDED \*\*\n$/u)
    expect(projected).not.toContain('AppDelegate.swift')
    keepsAllBut(raw, projected, STEP)
  })

  it('keeps the error, the failed-commands list and the result of a failed build', () => {
    const raw = build(true)
    const projected = projectStaticFilter({ command: 'xcodebuild build', stdout: raw, exitCode: 65 })!
    expect(projected.filter).toBe('xcodebuild')
    expect(projected.text).toContain("SwiftCompile normal arm64 Compiling\\ Model.swift /Users/demo/App/App/Model.swift (in target 'App' from project 'App')\n    cd /Users/demo/App\n")
    expect(projected.text).toContain("/Users/demo/App/App/Model.swift:8:16: error: cannot find 'missing' in scope\n        return missing\n               ^~~~~~~\n\n** BUILD FAILED **\n\n\nThe following build commands failed:\n\tSwiftCompile")
    keepsAllBut(raw, projected.text, STEP)
  })

  // Adapted from RTK's xcodebuild filter tests (Apache-2.0, see third-party/rtk): Xcode 10's headers, without a target.
  it('handles headers without a target, and leaves -quiet, other tools and ANSI output alone', () => {
    const rtk = 'note: Using new build system\nCompileSwift normal arm64 /Users/dev/App/Main.swift\n    cd /Users/dev/App\nLd /Users/dev/Build/Products/Debug/App normal arm64\n    cd /Users/dev/App\nCodeSign /Users/dev/Build/Products/Debug/App.app\n    cd /Users/dev/App\n    builtin-codesign --force --sign\n\n** BUILD SUCCEEDED **\n'
    expect(xcodebuildFilter.project({ command: 'xcodebuild build', stdout: rtk, exitCode: 0 })).toBe('note: Using new build system\n[3 build steps that printed nothing omitted (7 lines): 1 CompileSwift, 1 Ld, 1 CodeSign]\n\n** BUILD SUCCEEDED **\n')
    const quiet = "/Users/demo/App/App/ViewController.swift:12:13: warning: initialization of immutable value 'x' was never used\n** BUILD SUCCEEDED **\n"
    expect(xcodebuildFilter.project({ command: 'xcodebuild -quiet build', stdout: quiet, exitCode: 0 })).toBeUndefined()
    expect(xcodebuildFilter.project({ command: 'xcodebuild -list', stdout: 'Information about project "App":\n    Targets:\n        App\n', exitCode: 0 })).toBeUndefined()
    expect(xcodebuildFilter.project({ command: 'swift build', stdout: rtk, exitCode: 0 })).toBeUndefined()
    expect(xcodebuildFilter.project({ command: 'xcodebuild build', stdout: `\u001b[1m${rtk}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('pio-run', () => {
  // Synthetic, in PlatformIO 6's layout; the error row is from RTK's pio-run filter tests (Apache-2.0, see third-party/rtk).
  const build = lines(
    'Processing esp32dev (platform: espressif32; board: esp32dev; framework: arduino)',
    '--------------------------------------------------------------------------------',
    'Verbose mode can be enabled via `-v, --verbose` option',
    'CONFIGURATION: https://docs.platformio.org/page/boards/espressif32/esp32dev.html',
    'PLATFORM: Espressif 32 (6.4.0) > Espressif ESP32 Dev Module',
    'HARDWARE: ESP32 240MHz, 320KB RAM, 4MB Flash',
    'PACKAGES:',
    ' - framework-arduinoespressif32 @ 3.20011.230801 (2.0.11)',
    ' - toolchain-xtensa-esp32 @ 8.4.0+2021r2-patch5',
    'LDF: Library Dependency Finder -> https://bit.ly/configure-pio-ldf',
    'LDF Modes: Finder ~ chain, Compatibility ~ soft',
    'Found 33 compatible libraries',
    'Scanning dependencies...',
    'No dependencies',
    'Building in release mode',
    'Compiling .pio/build/esp32dev/src/main.cpp.o',
    'Building .pio/build/esp32dev/bootloader.bin',
    'Generating partitions .pio/build/esp32dev/partitions.bin',
    'Compiling .pio/build/esp32dev/FrameworkArduino/Esp.cpp.o',
    'Compiling .pio/build/esp32dev/FrameworkArduino/FirmwareMSC.cpp.o',
    'src/main.cpp:10:3: error: \'LED_BUILTINN\' was not declared in this scope',
    'Compiling .pio/build/esp32dev/FrameworkArduino/HWCDC.cpp.o',
    'Compiling .pio/build/esp32dev/FrameworkArduino/HardwareSerial.cpp.o',
    'Compiling .pio/build/esp32dev/FrameworkArduino/IPAddress.cpp.o',
    'Archiving .pio/build/esp32dev/libFrameworkArduino.a',
    'Indexing .pio/build/esp32dev/libFrameworkArduino.a',
    '*** [.pio/build/esp32dev/src/main.cpp.o] Error 1',
    '========================= [FAILED] Took 12.34 seconds =========================',
  )
  const STEP = /^(?:Compiling|Archiving|Indexing|Building|Generating \w+) \.pio\//u

  it('folds compile and archive rows, keeping configuration, the error and the result', () => {
    const projected = pioRunFilter.project({ command: 'pio run -e esp32dev', stdout: build, exitCode: 1 })!
    expect(projected).toContain('Building in release mode\n[5 PlatformIO compile, archive and link lines omitted]\nsrc/main.cpp:10:3: error:')
    expect(projected).toContain("not declared in this scope\n[5 PlatformIO compile, archive and link lines omitted]\n*** [.pio/build/esp32dev/src/main.cpp.o] Error 1\n")
    keepsAllBut(build, projected, STEP)
    expect(projectStaticFilter({ command: 'platformio run', stdout: build, exitCode: 1 })?.filter).toBe('pio-run')
  })

  it('leaves other pio commands, unrecognized output and ANSI alone', () => {
    expect(pioRunFilter.project({ command: 'pio test', stdout: build, exitCode: 1 })).toBeUndefined()
    expect(pioRunFilter.project({ command: 'pio run', stdout: build.split('\n').filter(line => !/^Processing|^=+ \[/u.test(line)).join('\n'), exitCode: 1 })).toBeUndefined()
    expect(pioRunFilter.project({ command: 'pio run', stdout: `\u001b[1m${build}`, exitCode: 1 })).toBeUndefined()
  })
})

describe('trunk-build', () => {
  // Cargo rows adapted from RTK's trunk-build filter tests (Apache-2.0, see third-party/rtk); trunk's own rows are synthetic, in trunk 0.18's layout.
  const build = lines(
    '2024-01-15T10:30:00.123456Z  INFO 🚀 Starting trunk 0.18.8',
    '2024-01-15T10:30:00.234567Z  INFO 📦 starting build',
    '   Compiling proc-macro2 v1.0.78',
    '   Compiling unicode-ident v1.0.12',
    '   Compiling wasm-bindgen-shared v0.2.90',
    '   Compiling tokio v1.35.0',
    'warning: unused variable: `x`',
    ' --> src/main.rs:4:9',
    '   Compiling my-crate v0.1.0 (/home/demo/my-crate)',
    '    Finished release [optimized] target(s) in 45.23s',
    '2024-01-15T10:30:46.123456Z  INFO fetching cargo artifacts',
    '2024-01-15T10:30:46.523456Z  INFO processing WASM for my-crate',
    '2024-01-15T10:30:47.123456Z  INFO calling wasm-bindgen for my-crate',
    '2024-01-15T10:30:50.123456Z  INFO ✅ success',
  )

  it('folds Cargo compile rows, keeping trunk\'s rows, warnings and the Finished line', () => {
    const projected = trunkBuildFilter.project({ command: 'trunk build --release', stdout: build, exitCode: 0 })!
    expect(projected).toContain('starting build\n[4 Cargo compile and download rows omitted]\nwarning: unused variable: `x`\n --> src/main.rs:4:9\n   Compiling my-crate v0.1.0')
    keepsAllBut(build, projected, /^ +Compiling /u)
    expect(projectStaticFilter({ command: 'trunk build', stdout: build, exitCode: 0 })?.filter).toBe('trunk-build')
  })

  it('leaves trunk serve, output that is not trunk\'s and ANSI alone', () => {
    expect(trunkBuildFilter.project({ command: 'trunk serve', stdout: build, exitCode: 0 })).toBeUndefined()
    expect(trunkBuildFilter.project({ command: 'trunk build', stdout: '   Compiling a v1.0.0\n   Compiling b v1.0.0\n   Compiling c v1.0.0\n', exitCode: 0 })).toBeUndefined()
    expect(trunkBuildFilter.project({ command: 'trunk build', stdout: `\u001b[1m${build}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('gradle', () => {
  const TASK = /^> (?:Task :[\w:.-]+(?: (?:UP-TO-DATE|NO-SOURCE))?|Configure project :[\w:]*)$/u
  const ADVICE = /^(?:\* Try:|Run with --stacktrace|\* Get more help at|> Run with --|> Get more help)/u

  it('folds quiet task rows with their outcomes and the welcome message, keeping the header of a task that printed', () => {
    const raw = fixture('gradle-build.txt')
    const projected = gradleFilter.project({ command: './gradlew build', stdout: raw, exitCode: 0 })!
    expect(projected).toContain('\n[6 lines of the Gradle 7.2 welcome message omitted]\n')
    expect(projected).toContain('Daemon will be stopped at the end of the build \n[4 Gradle task rows with nothing printed under them omitted: 3 ran, 1 NO-SOURCE]\n\n> Task :app:compileJava\n/repo/app/src/main/java/demo/App.java:7: warning: [deprecation]')
    expect(projected).toContain('1 warning\n\n[17 Gradle task rows with nothing printed under them omitted: 7 NO-SOURCE, 6 ran, 4 UP-TO-DATE]\n\nBUILD SUCCESSFUL in 11s\n4 actionable tasks: 4 executed\n')
    keepsAllBut(raw, projected, /^> Task :(?!app:compileJava$)|^Welcome to Gradle|^Here are the highlights|^ - |^For more details see/u)
    const upToDate = gradleFilter.project({ command: 'gradle build', stdout: fixture('gradle-uptodate.txt'), exitCode: 0 })!
    expect(upToDate).toContain('[22 Gradle task rows with nothing printed under them omitted: 14 UP-TO-DATE, 8 NO-SOURCE]\n\nBUILD SUCCESSFUL in 6s\n')
  })

  it('keeps the FAILED task, the compiler errors and the FAILURE section, folding only the standard advice', () => {
    const raw = fixture('gradle-fail.txt')
    const projected = gradleFilter.project({ command: './gradlew build', stdout: raw, exitCode: 1 })!
    expect(projected).toContain('\n> Task :app:compileJava FAILED\n')
    expect(projected).toContain("* What went wrong:\nExecution failed for task ':app:compileJava'.\n> Compilation failed; see the compiler error output for details.\n\n[3 lines of Gradle's standard --stacktrace/--info/--scan advice omitted]\n\nBUILD FAILED in 7s\n")
    keepsAllBut(raw, projected, new RegExp(`${TASK.source}|${ADVICE.source}`, 'u'))
  })

  // Adapted from RTK's gradlew fixtures (Apache-2.0, see third-party/rtk).
  it('handles RTK\'s Android builds: configuration rows, a lint task with output after a blank line, Gradle 8 advice', () => {
    const build = fixture('rtk-gradlew-build.txt')
    expect(gradleFilter.project({ command: './gradlew assembleDebug', stdout: build, exitCode: 0 })).toBe(lines(
      'Starting a Gradle Daemon (subsequent builds will be faster)',
      'Daemon will be stopped at the end of the build after running out of JVM memory',
      '',
      '[27 Gradle task rows with nothing printed under them omitted: 1 project configuration, 24 UP-TO-DATE, 2 NO-SOURCE]',
      '',
      'BUILD SUCCESSFUL in 3s',
      '28 actionable tasks: 28 up-to-date',
    ))
    const lint = fixture('rtk-gradlew-lint.txt')
    const linted = gradleFilter.project({ command: './gradlew lint', stdout: lint, exitCode: 1 })!
    expect(linted).toContain('[17 Gradle task rows with nothing printed under them omitted: 2 project configuration, 13 UP-TO-DATE, 2 NO-SOURCE]\n> Task :app:lint\nRan lint on variant debug: 0 issues found')
    expect(linted).toContain('> Task :app:lintDebug\n\nRan lint on variant debug: 3 issues found')
    keepsAllBut(lint, linted, TASK)
    const failed = fixture('rtk-gradlew-build-failed.txt')
    const projected = gradleFilter.project({ command: './gradlew assembleDebug', stdout: failed, exitCode: 1 })!
    expect(projected).toContain("Type mismatch: inferred type is String but Int was expected\n\n[5 lines of Gradle's standard --stacktrace/--info/--scan advice omitted]\n\nBUILD FAILED in 12s")
    keepsAllBut(failed, projected, new RegExp(`${TASK.source}|${ADVICE.source}`, 'u'))
    // Test output under the one task header: nothing to fold.
    expect(gradleFilter.project({ command: './gradlew test', stdout: fixture('rtk-gradlew-test-failed.txt'), exitCode: 1 })).toBeUndefined()
  })

  it('keeps a Try section with specific advice, and folds Gradle 4 download lines', () => {
    // Synthetic, in Gradle 8's and Gradle 4's layouts.
    const specific = lines(
      '> Task :app:compileJava FAILED',
      '',
      'FAILURE: Build failed with an exception.',
      '',
      '* What went wrong:',
      "Execution failed for task ':app:compileJava'.",
      '> Could not resolve all files for configuration \':app:compileClasspath\'.',
      '',
      '* Try:',
      '> Run with --stacktrace option to get the stack trace.',
      '> Run with --info or --debug option to get more log output.',
      '> Run with --scan to get full insights.',
      '> Get more help at https://help.gradle.org.',
      '',
      'BUILD FAILED in 1s',
    )
    expect(gradleFilter.project({ command: 'gradle build', stdout: specific, exitCode: 1 })).toContain("for configuration ':app:compileClasspath'.\n\n[5 lines of Gradle's standard --stacktrace/--info/--scan advice omitted]\n\nBUILD FAILED in 1s\n")
    const withHint = specific.replace('* Try:\n', '* Try:\n> Check that the repository is reachable.\n')
    const hinted = gradleFilter.project({ command: 'gradle build', stdout: withHint, exitCode: 1 })!
    expect(hinted).toContain('* Try:\n> Check that the repository is reachable.\n[4 lines of Gradle')
    const downloads = lines(
      'Download https://repo.maven.apache.org/maven2/com/google/guava/guava/23.0/guava-23.0.pom',
      'Download https://repo.maven.apache.org/maven2/com/google/guava/guava-parent/23.0/guava-parent-23.0.pom',
      'Download https://repo.maven.apache.org/maven2/com/google/guava/guava/23.0/guava-23.0.jar',
      ':compileJava',
      '',
      'BUILD SUCCESSFUL in 4s',
    )
    expect(gradleFilter.project({ command: 'gradle build', stdout: downloads, exitCode: 0 })).toBe('[3 Gradle download lines omitted]\n:compileJava\n\nBUILD SUCCESSFUL in 4s\n')
  })

  it('leaves other tools, output without a BUILD line and ANSI alone', () => {
    const raw = fixture('gradle-uptodate.txt')
    expect(gradleFilter.project({ command: 'mvn package', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(gradleFilter.project({ command: './gradlew build', stdout: raw.replace(/BUILD SUCCESSFUL in 6s\n/u, ''), exitCode: 0 })).toBeUndefined()
    expect(gradleFilter.project({ command: './gradlew build', stdout: `\u001b[1m${raw}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('spring-boot', () => {
  // Synthetic, in Spring Boot 3.2's default console layout.
  const log = (level: string, logger: string, message: string) =>
    `2024-01-15T10:30:01.000+01:00 ${level.padStart(5)} 12345 --- [           main] ${logger.padEnd(40)} : ${message}`
  const banner = [
    '',
    '  .   ____          _            __ _ _',
    ' /\\\\ / ___\'_ __ _ _(_)_ __  __ _ \\ \\ \\ \\',
    '( ( )\\___ | \'_ | \'_| | \'_ \\/ _` | \\ \\ \\ \\',
    ' \\\\/  ___)| |_)| | | | | || (_| |  ) ) ) )',
    '  \'  |____| .__|_| |_|_| |_\\__, | / / / /',
    ' =========|_|==============|___/=/_/_/_/',
    ' :: Spring Boot ::                (v3.2.0)',
    '',
  ]
  const startup = [
    log('INFO', 'com.example.demo.DemoApplication', 'Starting DemoApplication using Java 17.0.9 with PID 12345 (/home/demo/demo/target/classes started by demo in /home/demo/demo)'),
    log('INFO', 'com.example.demo.DemoApplication', 'No active profile set, falling back to 1 default profile: "default"'),
    log('INFO', '.s.d.r.c.RepositoryConfigurationDelegate', 'Bootstrapping Spring Data JPA repositories in DEFAULT mode.'),
    log('INFO', '.s.d.r.c.RepositoryConfigurationDelegate', 'Finished Spring Data repository scanning in 48 ms. Found 1 JPA repository interface.'),
    log('INFO', 'o.s.b.w.embedded.tomcat.TomcatWebServer', 'Tomcat initialized with port 8080 (http)'),
    log('INFO', 'o.apache.catalina.core.StandardService', 'Starting service [Tomcat]'),
    log('INFO', 'o.apache.catalina.core.StandardEngine', 'Starting Servlet engine: [Apache Tomcat/10.1.16]'),
    log('INFO', 'o.a.c.c.C.[Tomcat].[localhost].[/]', 'Initializing Spring embedded WebApplicationContext'),
    log('INFO', 'w.s.c.ServletWebServerApplicationContext', 'Root WebApplicationContext: initialization completed in 1612 ms'),
    log('INFO', 'o.hibernate.jpa.internal.util.LogHelper', 'HHH000204: Processing PersistenceUnitInfo [name: default]'),
    log('INFO', 'org.hibernate.Version', 'HHH000412: Hibernate ORM core version 6.3.1.Final'),
    log('INFO', 'com.zaxxer.hikari.HikariDataSource', 'HikariPool-1 - Starting...'),
    log('INFO', 'com.zaxxer.hikari.pool.HikariPool', 'HikariPool-1 - Added connection conn0: url=jdbc:h2:mem:testdb user=SA'),
    log('INFO', 'com.zaxxer.hikari.HikariDataSource', 'HikariPool-1 - Start completed.'),
    log('INFO', 'j.LocalContainerEntityManagerFactoryBean', "Initialized JPA EntityManagerFactory for persistence unit 'default'"),
    log('WARN', 'JpaBaseConfiguration$JpaWebConfiguration', 'spring.jpa.open-in-view is enabled by default. Therefore, database queries may be performed during view rendering. Explicitly configure spring.jpa.open-in-view to disable this warning'),
    log('INFO', 'o.s.b.w.embedded.tomcat.TomcatWebServer', "Tomcat started on port 8080 (http) with context path ''"),
    log('INFO', 'com.example.demo.DemoApplication', 'Started DemoApplication in 4.321 seconds (process running for 4.789)'),
  ]
  const failure = [
    log('WARN', 'ConfigServletWebServerApplicationContext', "Exception encountered during context initialization - cancelling refresh attempt: org.springframework.context.ApplicationContextException: Failed to start bean 'webServerStartStop'"),
    log('INFO', 'j.LocalContainerEntityManagerFactoryBean', "Closing JPA EntityManagerFactory for persistence unit 'default'"),
    log('INFO', 'com.zaxxer.hikari.HikariDataSource', 'HikariPool-1 - Shutdown initiated...'),
    log('INFO', 'com.zaxxer.hikari.HikariDataSource', 'HikariPool-1 - Shutdown completed.'),
    log('INFO', '.s.b.a.l.ConditionEvaluationReportLogger', ''),
    '',
    "Error starting ApplicationContext. To display the condition evaluation report re-run your application with 'debug' enabled.",
    log('ERROR', 'o.s.b.d.LoggingFailureAnalysisReporter', ''),
    '',
    '***************************',
    'APPLICATION FAILED TO START',
    '***************************',
    '',
    'Description:',
    '',
    'Web server failed to start. Port 8080 was already in use.',
    '',
  ]
  const art = banner.slice(1, 7).map(row => row.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
  const ROUTINE = new RegExp(`Spring Data|Tomcat initialized|Starting (?:service|Servlet)|embedded WebApplicationContext|initialization completed|HHH|HikariPool|EntityManagerFactory|^(?:${art})$`, 'u')

  it('folds the banner art and routine framework INFO lines, keeping the app\'s lines, ports, warnings and Started', () => {
    const raw = lines(...banner, ...startup)
    const projected = springBootFilter.project({ command: 'java -jar target/demo-0.0.1-SNAPSHOT.jar', stdout: raw, exitCode: 0 })!
    expect(projected).toContain('\n[6 lines of the Spring Boot banner omitted]\n :: Spring Boot ::                (v3.2.0)\n')
    expect(projected).toContain('No active profile set, falling back to 1 default profile: "default"\n[13 routine Spring Boot, Tomcat, Hibernate and Hikari INFO lines omitted]\n2024-01-15T10:30:01.000+01:00  WARN 12345')
    expect(projected).toContain("Tomcat started on port 8080 (http) with context path ''")
    keepsAllBut(raw, projected, ROUTINE)
  })

  it('keeps the failure analysis and a routine line whose message continues below it', () => {
    const raw = lines(...banner, ...startup.slice(0, 9), ...failure)
    const projected = projectStaticFilter({ command: 'mvn spring-boot:run', stdout: raw, exitCode: 1 })!
    expect(projected.filter).toBe('spring-boot')
    expect(projected.text).toContain("Failed to start bean 'webServerStartStop'\n[3 routine Spring Boot")
    expect(projected.text).toContain('.s.b.a.l.ConditionEvaluationReportLogger : \n\nError starting ApplicationContext.')
    expect(projected.text).toContain('APPLICATION FAILED TO START\n***************************\n\nDescription:\n\nWeb server failed to start. Port 8080 was already in use.\n')
    keepsAllBut(raw, projected.text, ROUTINE)
  })

  it('folds Gradle\'s quiet task rows under bootRun, and leaves Maven\'s download fold to maven', () => {
    const gradle = lines('> Task :compileJava UP-TO-DATE', '> Task :processResources UP-TO-DATE', '> Task :classes UP-TO-DATE', '', '> Task :bootRun', ...banner, ...startup)
    const projected = projectStaticFilter({ command: './gradlew bootRun', stdout: gradle, exitCode: 0 })!
    expect(projected.filter).toBe('spring-boot')
    expect(projected.text).toMatch(/^\[3 Gradle task rows with nothing printed under them omitted: 3 UP-TO-DATE\]\n\n> Task :bootRun\n\n\[6 lines of the Spring Boot banner omitted\]/u)
    const maven = lines(
      '[INFO] --- spring-boot-maven-plugin:3.2.0:run (default-cli) @ demo ---',
      'Downloading from central: https://repo.maven.apache.org/maven2/org/a/a/1/a-1.pom',
      'Downloaded from central: https://repo.maven.apache.org/maven2/org/a/a/1/a-1.pom (1.2 kB at 10 kB/s)',
      'Downloading from central: https://repo.maven.apache.org/maven2/org/b/b/1/b-1.pom',
      ...banner, ...startup,
    )
    expect(projectStaticFilter({ command: 'mvn spring-boot:run', stdout: maven, exitCode: 0 })?.filter).toBe('maven')
  })

  it('leaves other commands, output without a Spring Boot start-up and ANSI alone', () => {
    const raw = lines(...banner, ...startup)
    expect(springBootFilter.project({ command: 'mvn package', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(springBootFilter.project({ command: 'java -version', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(springBootFilter.project({ command: 'java -jar app.jar', stdout: lines(...startup.slice(2, 9)), exitCode: 0 })).toBeUndefined()
    expect(springBootFilter.project({ command: 'java -jar app.jar', stdout: `\u001b[32m${raw}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('liquibase', () => {
  // Synthetic, in Liquibase 4.29's layout; the banner rows are from RTK's liquibase filter tests (Apache-2.0, see third-party/rtk).
  const update = lines(
    '####################################################',
    '##   _     _             _ _                      ##',
    '##  | |   (_)           (_) |                     ##',
    '##  | |    _  __ _ _   _ _| |__   __ _ ___  ___   ##',
    "##  | |   | |/ _` | | | | | '_ \\ / _` / __|/ _ \\  ##",
    '##  | |___| | (_| | |_| | | |_) | (_| \\__ \\  __/  ##',
    '##  \\_____/_|\\__, |\\__,_|_|_.__/ \\__,_|___/\\___|  ##',
    '##              | |                               ##',
    '##              |_|                               ##',
    '##                                                ## ',
    '##  Get documentation at docs.liquibase.com       ##',
    '##  Get certified courses at learn.liquibase.com  ## ',
    '##                                                ##',
    '####################################################',
    'Starting Liquibase at 10:12:11 (version 4.29.1 #3006 built at 2024-07-31 20:30+0000)',
    'Liquibase Version: 4.29.1',
    'Liquibase Open Source 4.29.1 by Liquibase',
    'Running Changeset: db/changelog/db.changelog-master.yaml::1::alice',
    'Running Changeset: db/changelog/db.changelog-master.yaml::2::alice',
    '',
    'UPDATE SUMMARY',
    'Run:                          2',
    'Previously run:               0',
    'Filtered out:                 0',
    '-------------------------------',
    'Total change sets:            2',
    '',
    'Liquibase: Update has been successful. Rows affected: 2',
    "Liquibase command 'update' was executed successfully.",
  )

  it('folds the banner box, keeping the version, every changeset, the summary and the result', () => {
    const projected = liquibaseFilter.project({ command: 'liquibase update --changelog-file=db/changelog/db.changelog-master.yaml', stdout: update, exitCode: 0 })!
    expect(projected).toMatch(/^\[14 lines of the Liquibase banner omitted\]\nStarting Liquibase at 10:12:11/u)
    keepsAllBut(update, projected, /^##/u)
    const failed = update.replace(/Liquibase: Update[^]*$/u, 'ERROR: Exception Primary Class:  SQLSyntaxErrorException\nUnexpected error running Liquibase: Table "PERSON" already exists\n')
    const projectedFailure = projectStaticFilter({ command: 'liquibase update', stdout: failed, exitCode: 1 })!
    expect(projectedFailure.filter).toBe('liquibase')
    expect(projectedFailure.text).toContain('Unexpected error running Liquibase: Table "PERSON" already exists\n')
  })

  it('leaves output without the start-up line, other tools and ANSI alone', () => {
    expect(liquibaseFilter.project({ command: 'liquibase update', stdout: update.replace(/^Starting Liquibase.*\n/mu, ''), exitCode: 0 })).toBeUndefined()
    expect(liquibaseFilter.project({ command: 'flyway migrate', stdout: update, exitCode: 0 })).toBeUndefined()
    expect(liquibaseFilter.project({ command: 'liquibase status', stdout: `\u001b[1m${update}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('dotnet-build', () => {
  const DIAGNOSTIC = /: (?:warning|error) [A-Z]+\d+: /u

  // Adapted from RTK's dotnet fixtures (Apache-2.0, see third-party/rtk).
  it('replaces the summary\'s repeat of every warning with one count, keeping the first copies and the counts', () => {
    const raw = fixture('rtk-dotnet-build-warnings.txt')
    const projected = dotnetBuildFilter.project({ command: 'dotnet build', stdout: raw, exitCode: 0 })!
    expect(projected).toContain('\nBuild succeeded.\n\n[25 warning and error lines omitted: the build summary repeats them, each word for word as printed above]\n    25 Warning(s)\n    0 Error(s)\n\nBinaryLogger wrote to: /fx/fresh/mine.binlog\n')
    // Every distinct warning is still there, before the result.
    const before = projected.slice(0, projected.indexOf('Build succeeded.'))
    for (const line of new Set(raw.split('\n').filter(line => DIAGNOSTIC.test(line)))) expect(before).toContain(line)
    keepsAllBut(raw.slice(0, raw.indexOf('Build succeeded.')), projected, /^$/u)
    const failed = fixture('rtk-dotnet-build-failed.txt')
    const errors = projectStaticFilter({ command: 'dotnet build src/App.csproj -c Release', stdout: failed, exitCode: 1 })!
    expect(errors.filter).toBe('dotnet-build')
    expect(errors.text).toContain("error CS1525: Invalid expression term ';' [/private/tmp/RtkDotnetSmoke/RtkDotnetSmoke.csproj]\n\nBuild FAILED.\n\n[1 warning or error line omitted: the build summary repeats it word for word as printed above]\n    0 Warning(s)\n    1 Error(s)\n")
  })

  it('keeps a summary with a line not printed above, and leaves dotnet test, other tools and ANSI alone', () => {
    const raw = fixture('rtk-dotnet-build-warnings.txt')
    const extra = raw.replace('    25 Warning(s)', '/fx/fresh/Lib/Lib.csproj : warning NU1901: only in the summary\n    25 Warning(s)')
    expect(dotnetBuildFilter.project({ command: 'dotnet build', stdout: extra, exitCode: 0 })).toBeUndefined()
    expect(dotnetBuildFilter.project({ command: 'dotnet test', stdout: fixture('rtk-dotnet-test-failed.txt'), exitCode: 1 })).toBeUndefined()
    expect(dotnetBuildFilter.project({ command: 'dotnet test', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(dotnetBuildFilter.project({ command: 'msbuild', stdout: raw, exitCode: 0 })).toBeUndefined()
    expect(dotnetBuildFilter.project({ command: 'dotnet build', stdout: `\u001b[1m${raw}`, exitCode: 0 })).toBeUndefined()
    expect(projectStaticFilter({ command: 'dotnet publish -c Release', stdout: raw, exitCode: 0 })?.filter).toBe('dotnet-build')
  })
})

describe('mix-compile', () => {
  // Synthetic, in Elixir 1.17's layout; the warning is from RTK's mix-compile filter tests (Apache-2.0, see third-party/rtk).
  const compile = lines(
    '==> decimal',
    'Compiling 4 files (.ex)',
    'Generated decimal app',
    '==> telemetry',
    '===> Analyzing applications...',
    '===> Compiling telemetry',
    '==> mime',
    'Compiling 1 file (.ex)',
    'Generated mime app',
    '==> plug_crypto',
    'Compiling 5 files (.ex)',
    '    warning: Logger.warn/1 is deprecated. Use Logger.warning/2 instead',
    '    │',
    ' 12 │     Logger.warn("x")',
    '    │            ~',
    '    │',
    '    └─ lib/plug/crypto.ex:12:12: Plug.Crypto.check/1',
    '',
    'Generated plug_crypto app',
    '==> jason',
    'Compiling 10 files (.ex)',
    'Generated jason app',
    'Compiling 12 files (.ex)',
    'warning: variable "conn" is unused',
    '  lib/router.ex:42',
    'Generated my_app app',
  )

  it('folds dependencies that compiled quietly, keeping one that warned and the project\'s own output', () => {
    const projected = mixCompileFilter.project({ command: 'mix compile', stdout: compile, exitCode: 0 })!
    expect(projected).toBe(lines(
      '[3 apps (dependencies or umbrella children) compiled with no messages: 9 lines omitted]',
      '==> plug_crypto',
      'Compiling 5 files (.ex)',
      '    warning: Logger.warn/1 is deprecated. Use Logger.warning/2 instead',
      '    │',
      ' 12 │     Logger.warn("x")',
      '    │            ~',
      '    │',
      '    └─ lib/plug/crypto.ex:12:12: Plug.Crypto.check/1',
      '',
      'Generated plug_crypto app',
      '[1 app (dependencies or umbrella children) compiled with no messages: 3 lines omitted]',
      'Compiling 12 files (.ex)',
      'warning: variable "conn" is unused',
      '  lib/router.ex:42',
      'Generated my_app app',
    ))
    expect(projectStaticFilter({ command: 'mix deps.compile', stdout: compile, exitCode: 0 })?.filter).toBe('mix-compile')
  })

  it('leaves the project\'s own compile, other mix tasks and ANSI alone', () => {
    // Adapted from RTK's mix-compile filter tests (Apache-2.0, see third-party/rtk).
    expect(mixCompileFilter.project({ command: 'mix compile', stdout: 'Compiling 3 files (.ex)\nGenerated my_app app\n', exitCode: 0 })).toBeUndefined()
    // A dependency section that runs into the project's lines is not one Mix closed: it stays.
    expect(mixCompileFilter.project({ command: 'mix compile', stdout: '==> telemetry\n===> Compiling telemetry\nCompiling 3 files (.ex)\nGenerated my_app app\n', exitCode: 0 })).toBeUndefined()
    expect(mixCompileFilter.project({ command: 'mix test', stdout: compile, exitCode: 0 })).toBeUndefined()
    expect(mixCompileFilter.project({ command: 'mix compile', stdout: `\u001b[33m${compile}`, exitCode: 0 })).toBeUndefined()
  })
})

describe('routing', () => {
  it('claims the build commands before they run', () => {
    for (const command of [
      'go build ./...', 'go vet ./...', 'go install ./cmd/tool', 'gcc -Wall -c main.c', 'g++ -std=c++17 main.cpp', 'clang -c x.c', 'clang++-17 x.cpp', 'cc x.c', 'arm-none-eabi-gcc -c x.c',
      'swift build', 'xcodebuild -scheme App build', 'pio run', 'platformio run -e esp32dev', 'trunk build --release',
      './gradlew build', 'gradle test', 'cd ./android && ./gradlew assembleDebug', 'mvn spring-boot:run', './gradlew bootRun', 'java -jar target/app.jar',
      'liquibase update', 'liquibase status --verbose', 'dotnet build', 'dotnet publish -c Release', 'mix compile', 'mix deps.compile',
    ]) expect(mayProject(command), command).toBe(true)
    for (const command of ['golangci-lint run', 'mix format --check-formatted', 'dotnet restore', 'dotnet test', 'gcc -E x.c', 'swift test', 'java -version']) expect(mayProject(command), command).toBe(false)
  })
})
