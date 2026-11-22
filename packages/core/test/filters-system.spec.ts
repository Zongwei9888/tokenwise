import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectStaticFilter } from '../src/filters/index.ts'
import { dfFilter, duFilter, iptablesFilter, psFilter, statFilter, wcFilter } from '../src/filters/system-tables.ts'
import { astGrepFilter } from '../src/filters/ast-grep.ts'
import { pingFilter, rsyncFilter } from '../src/filters/network.ts'
import { systemctlStatusFilter } from '../src/filters/systemctl.ts'
import { brewInstallFilter, goTaskFilter, quartoRenderFilter } from '../src/filters/task-tools.ts'
import { jqFilter } from '../src/filters/json-output.ts'
import { hadolintFilter, shellcheckFilter, yamllintFilter } from '../src/filters/linters.ts'
import { mayProject } from '../src/economy.ts'
import type { EconomyFilter } from '../src/types.ts'

/**
 * Real outputs captured on macOS 26 (BSD wc/df/du/stat, ping, openrsync, jq 1.7.1,
 * ShellCheck 0.11) in a scratch directory; the user name is replaced by `demo`.
 */
const fixture = (name: string) => readFileSync(new URL(`fixtures/system/${name}`, import.meta.url), 'utf8')

/** Every line of `raw` that `removed` does not match appears in `text`, in order. */
function keepsAllBut(raw: string, text: string, removed: RegExp) {
  let at = 0
  for (const line of raw.split('\n').filter(line => line !== '' && !removed.test(line))) {
    const found = text.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(0)
    at = found + line.length
  }
}

/** Only whitespace changed: the same words, in the same order. */
function sameWords(raw: string, text: string) {
  expect(text.split(/\s+/u).filter(Boolean)).toEqual(raw.split(/\s+/u).filter(Boolean))
}

/** Undo `[<open><file><close>]` grouping: each indented row under a header gets `<file>:` back. */
function ungroup(text: string, open: string, close: string): string {
  let file: string | undefined
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith(open) && line.endsWith(close)) { file = line.slice(open.length, line.length - close.length); continue }
    if (file !== undefined && line.startsWith('  ')) { out.push(`${file}:${line.slice(2)}`); continue }
    file = undefined
    out.push(line)
  }
  return out.join('\n')
}

const run = (filter: EconomyFilter, command: string, stdout: string, exitCode = 0) => filter.project({ command, stdout, exitCode })

describe('wc', () => {
  it('cuts the count padding of a several-file listing, keeping every count and name', () => {
    const raw = fixture('wc.txt')
    const projected = run(wcFilter, 'wc src/a/*', raw)!
    expect(projected).toContain('2 5 23 src/a/file1.txt\n')
    expect(projected).toContain('24 60 279 total\n')
    sameWords(raw, projected)
    expect(projected.length).toBeLessThan(raw.length * 0.6)
    expect(run(wcFilter, 'wc -l src/a/file1.txt src/a/file10.txt', fixture('wc-l.txt'))).toContain('2 src/a/file9.txt\n24 total\n')
    expect(projectStaticFilter({ command: 'wc -l src/*.ts', stdout: fixture('wc-l.txt'), exitCode: 0 })?.filter).toBe('wc')
  })

  // Adapted from RTK's wc_cmd.rs tests (Apache-2.0, see third-party/rtk).
  it('handles GNU padding, names that start with a space, and keeps error lines', () => {
    const gnu = '      30      96     978 src/main.rs\n      50     120    1500 src/lib.rs\n      80     216    2478 total\n'
    expect(run(wcFilter, 'wc src/main.rs src/lib.rs', gnu)).toBe('30 96 978 src/main.rs\n50 120 1500 src/lib.rs\n80 216 2478 total\n')
    // The one space before a name is wc's; the rest of the name stays.
    const spaced = '       3  odd name.txt\n       4 b.txt\n       7 total\n'
    expect(run(wcFilter, 'wc -l', spaced)).toBe('3  odd name.txt\n4 b.txt\n7 total\n')
    const missing = '       2 a.txt\nwc: nope.txt: open: No such file or directory\n       3 b.txt\n       5 total\n'
    expect(run(wcFilter, 'wc -l a.txt nope.txt b.txt 2>&1', missing, 1)).toBe('2 a.txt\nwc: nope.txt: open: No such file or directory\n3 b.txt\n5 total\n')
  })

  it('leaves one file, unknown options, other tools and ANSI output alone', () => {
    // The conformance corpus pins this one: a single row passes through.
    expect(run(wcFilter, 'wc -l src/module-0/component-1.ts', '     260 src/module-0/component-1.ts\n')).toBeUndefined()
    const raw = fixture('wc.txt')
    expect(run(wcFilter, 'wc --files0-from=list', raw)).toBeUndefined()
    // BSD lets -c and -m cancel each other, so the column count is not known.
    expect(run(wcFilter, 'wc -cm a b', raw)).toBeUndefined()
    expect(run(wcFilter, 'nl a b', raw)).toBeUndefined()
    expect(run(wcFilter, 'wc a b', `\u001b[1m${raw}`)).toBeUndefined()
    // Three count columns expected, one printed: not a layout this filter reads.
    expect(run(wcFilter, 'wc a b', fixture('wc-l.txt'))).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['wc -l src/*.ts', 'wc a.txt b.txt', 'cd ./repo && wc -w docs/*.md']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('wc -l < input.txt')).toBe(false)
  })
})

describe('ast-grep', () => {
  // Adapted from RTK's ast_grep_lazylock_raw fixtures (Apache-2.0, see third-party/rtk).
  const records = fixture('ast-grep-run.txt')
  const json = fixture('ast-grep-run.json')

  it('groups the records of each file under one header, keeping every match line', () => {
    const projected = run(astGrepFilter, "ast-grep run -p 'LazyLock::new($$$)' src", records)!
    expect(projected).toContain('[matches in src/learn/detector.rs; every match retained]\n  51:static UNKNOWN_FLAG_RE')
    expect(ungroup(projected, '[matches in ', '; every match retained]')).toBe(records)
    expect(projected.length).toBeLessThan(records.length * 0.8)
    expect(run(astGrepFilter, "sg -p 'LazyLock::new($$$)' -l rust", records)).toBe(projected)
  })

  it('keeps one match object per line in --json output, every value as it was', () => {
    const projected = run(astGrepFilter, "ast-grep run -p 'LazyLock::new($$$)' --json", json)!
    expect(JSON.parse(projected)).toEqual(JSON.parse(json))
    expect(projected.replace(/\s+/gu, '')).toBe(json.replace(/\s+/gu, ''))
    expect(projected.split('\n').filter(line => line.startsWith('{"text":'))).toHaveLength(12)
    expect(projected.length).toBeLessThan(json.length * 0.8)
  })

  it('leaves other subcommands, compact JSON, interactive runs and ANSI output alone', () => {
    const scan = 'warning[no-unwrap]: avoid unwrap\n  ┌─ a.rs:2:13\n  │\n2 │     let x = foo().unwrap();\n  │             ^^^^^^^^^^^^^^\n'
    expect(run(astGrepFilter, 'ast-grep scan', scan)).toBeUndefined()
    expect(run(astGrepFilter, 'ast-grep scan', records)).toBeUndefined()
    expect(run(astGrepFilter, "ast-grep run -p 'x' --json=stream", json)).toBeUndefined()
    expect(run(astGrepFilter, "ast-grep run -p 'x' -i", records)).toBeUndefined()
    expect(run(astGrepFilter, "ast-grep run -p 'x'", `\u001b[35m${records}`)).toBeUndefined()
    expect(run(astGrepFilter, "ast-grep run -p 'x' --json", 'not json\n')).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ["ast-grep run -p 'foo($A)' src", "sg -p 'foo($A)' --json", "ast-grep --pattern 'x' src/*.ts"]) expect(mayProject(command), command).toBe(true)
    expect(mayProject('ast-grep scan')).toBe(false)
    expect(mayProject('ast-grep lsp')).toBe(false)
  })
})

describe('df', () => {
  it('cuts the column padding of a real macOS table, leaving a row that does not fit the header as it is', () => {
    const raw = fixture('df-h.txt')
    const projected = run(dfFilter, 'df -h', raw)!
    expect(projected.split('\n')[0]).toBe('Filesystem Size Used Avail Capacity iused ifree %iused Mounted on')
    expect(projected).toContain('\n/dev/disk3s5 926Gi 859Gi 29Gi 97% 8.9M 304M 3% /System/Volumes/Data\n')
    // `map auto_home` has a space in its name: its cells do not line up with the header.
    expect(projected).toContain(raw.split('\n').find(line => line.startsWith('map auto_home'))!)
    sameWords(raw, projected)
    expect(projected.length).toBeLessThan(raw.length * 0.8)
  })

  it('keeps a GNU mount point with spaces whole and rows that mention a problem as printed', () => {
    // Synthetic, GNU coreutils `df -h` layout.
    const gnu = [
      'Filesystem      Size  Used Avail Use% Mounted on',
      'udev            7.8G     0  7.8G   0% /dev',
      'tmpfs           1.6G  2.1M  1.6G   1% /run',
      '/dev/nvme0n1p2  468G  123G  322G  28% /',
      '/dev/sdb1       932G  612G  320G  66% /media/demo/My  Passport',
      "df: /mnt/nfs: Stale file handle (cannot access)",
      '',
    ].join('\n')
    expect(run(dfFilter, 'df -h', gnu)).toBe([
      'Filesystem Size Used Avail Use% Mounted on',
      'udev 7.8G 0 7.8G 0% /dev',
      'tmpfs 1.6G 2.1M 1.6G 1% /run',
      '/dev/nvme0n1p2 468G 123G 322G 28% /',
      '/dev/sdb1 932G 612G 320G 66% /media/demo/My  Passport',
      "df: /mnt/nfs: Stale file handle (cannot access)",
      '',
    ].join('\n'))
    expect(run(dfFilter, 'df -h --output=source,target', gnu)).toBeUndefined()
    expect(run(dfFilter, 'du -h', gnu)).toBeUndefined()
    expect(run(dfFilter, 'df -h', `\u001b[0m${gnu}`)).toBeUndefined()
    expect(run(dfFilter, 'df -h', 'Mounted on /\n')).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['df -h', 'df -h .', 'sudo df -i']) expect(mayProject(command), command).toBe(true)
  })
})

describe('du', () => {
  it('lists a directory\'s rows under one header, keeping every size and path', () => {
    const raw = fixture('du-a.txt')
    const projected = run(duFilter, 'du -a src', raw)!
    expect(projected).toContain('[entries in src/a/]\n  8\tfile2.txt\n')
    expect(projected).toContain('\n96\tsrc/a\n')
    // Rebuild every row from its header.
    let directory = ''
    const rebuilt = projected.split('\n').map(line => {
      const header = /^\[entries in (.+)\]$/u.exec(line)
      if (header) { directory = header[1]!; return undefined }
      return line.startsWith('  ') ? line.slice(2).replace('\t', `\t${directory}`) : line
    }).filter(line => line !== undefined).join('\n')
    expect(rebuilt).toBe(raw)
    expect(projected.length).toBeLessThan(raw.length)
  })

  it('drops the BSD size padding, keeps problem lines and leaves other layouts alone', () => {
    expect(run(duFilter, 'du -sh src/*', fixture('du-sh.txt'))).toBe('48K\tsrc/a\n12K\tsrc/b\n')
    const denied = '8\t./a/x\n8\t./a/y\ndu: ./private: Permission denied\n8\t./a/z\n'
    expect(run(duFilter, 'du -a', denied)).toBeUndefined()
    const raw = fixture('du-a.txt')
    expect(run(duFilter, 'du -a --time src', raw)).toBeUndefined()
    expect(run(duFilter, 'dust src', raw)).toBeUndefined()
    expect(run(duFilter, 'du -a src', `\u001b[0m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['du -a src', 'du -sh *', 'sudo du -h -d 1 /var']) expect(mayProject(command), command).toBe(true)
  })
})

describe('ps', () => {
  // Synthetic, in the exact procps-ng `ps aux` layout (header widths as printed by procps 4).
  const procps = (user: string, pid: number, stat: string, start: string, time: string, command: string, cpu = '0.0', mem = '0.0', vsz = 0, rss = 0, tty = '?') =>
    `${user.padEnd(8)} ${String(pid).padStart(7)} ${cpu.padStart(4)} ${mem.padStart(4)} ${String(vsz).padStart(6)} ${String(rss).padStart(5)} ${tty.padEnd(8)} ${stat.padEnd(4)} ${start.padEnd(5)} ${time.padStart(6)} ${command}`
  const header = `${'USER'.padEnd(8)} ${'PID'.padStart(7)} ${'%CPU'.padStart(4)} ${'%MEM'.padStart(4)} ${'VSZ'.padStart(6)} ${'RSS'.padStart(5)} ${'TTY'.padEnd(8)} ${'STAT'.padEnd(4)} ${'START'.padEnd(5)} ${'TIME'.padStart(6)} COMMAND`
  const rows = [
    procps('root', 1, 'Ss', 'Nov20', '0:05', '/sbin/init splash', '0.0', '0.1', 167744, 11400),
    ...Array.from({ length: 58 }, (_, i) => procps('root', i + 2, 'I<', 'Nov20', '0:00', `[kworker/${i}:0H-events_highpri]`)),
    procps('demo', 4242, 'Z', '10:02', '0:00', '[node] <defunct>'),
    ...Array.from({ length: 10 }, (_, i) => procps('demo', 5000 + i, 'Sl', '09:40', '0:12', `node /home/demo/app/worker.js --id=${i}`, '1.2', '0.8', 1234567, 98765)),
    procps('postgres', 1400, 'Ss', 'Nov20', '0:01', 'postgres: logger --log-error-verbosity=verbose', '0.0', '0.2', 215000, 21000),
    ...Array.from({ length: 49 }, (_, i) => procps('demo', 6000 + i, 'S', '10:1' + (i % 10), '0:00', `/usr/bin/python3 -m http.server ${8000 + i}`, '0.0', '0.1', 31000, 18000, 'pts/1')),
    procps('demo', 90210, 'R+', '10:15', '0:00', 'ps aux', '0.0', '0.0', 12345, 3456, 'pts/0'),
  ]
  const raw = [header, ...rows, ''].join('\n')

  it('previews a long listing: the first and last rows, every zombie and problem row, the rest counted', () => {
    const projected = run(psFilter, 'ps aux', raw)!
    const lines = projected.split('\n')
    expect(lines[0]).toBe('USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND')
    expect(lines[1]).toBe('root 1 0.0 0.1 167744 11400 ? Ss Nov20 0:05 /sbin/init splash')
    expect(lines.at(-2)).toBe('demo 90210 0.0 0.0 12345 3456 pts/0 R+ 10:15 0:00 ps aux')
    expect(projected).toContain('\ndemo 4242 0.0 0.0 0 0 ? Z 10:02 0:00 [node] <defunct>\n')
    // A row that mentions a problem is kept, and as printed.
    expect(projected).toContain(`\n${rows[70]}\n`)
    const notes = lines.filter(line => line.startsWith('['))
    expect(notes).toEqual(['[29 process rows omitted]', '[10 process rows omitted]', '[40 process rows omitted]'])
    expect(lines.length - 1 - notes.length + 29 + 10 + 40).toBe(raw.split('\n').length - 1)
    // Every row kept has its words in order.
    const words = new Set(raw.split('\n').map(line => line.split(/\s+/u).filter(Boolean).join(' ')))
    for (const line of lines.filter(line => line !== '' && !line.startsWith('['))) expect(words.has(line.split(/\s+/u).filter(Boolean).join(' ')), line).toBe(true)
  })

  it('only compacts a short listing, including a real macOS layout where TIME overflows its column', () => {
    // Synthetic rows in the macOS `ps aux` layout (copied widths, TIME 1314:31.74 pushes COMMAND right).
    const mac = [
      'USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND',
      '_windowserver      471  18.8  0.8 436586192 132880   ??  Ss   Mon08AM 1314:31.74 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon',
      'demo             38076  14.3  3.2 441034736 541440 s000  S+    4:26PM   2:24.18 claude',
      'root                 1   0.0  0.1 435318016  13328   ??  Ss   Mon08AM  86:32.38 /sbin/launchd',
      '',
    ].join('\n')
    expect(run(psFilter, 'ps aux', mac)).toBe([
      'USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND',
      '_windowserver 471 18.8 0.8 436586192 132880 ?? Ss Mon08AM 1314:31.74 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon',
      'demo 38076 14.3 3.2 441034736 541440 s000 S+ 4:26PM 2:24.18 claude',
      'root 1 0.0 0.1 435318016 13328 ?? Ss Mon08AM 86:32.38 /sbin/launchd',
      '',
    ].join('\n'))
    const ef = '  UID   PID  PPID   C STIME   TTY           TIME CMD\n    0     1     0   0 Mon08AM ??        86:32.38 /sbin/launchd\n  501 38076 38062   0  4:26PM ttys000    2:24.18 claude  --resume\n'
    expect(run(psFilter, 'ps -ef', ef)).toBe('UID PID PPID C STIME TTY TIME CMD\n0 1 0 0 Mon08AM ?? 86:32.38 /sbin/launchd\n501 38076 38062 0 4:26PM ttys000 2:24.18 claude  --resume\n')
  })

  it('leaves custom columns, other tools and ANSI output alone', () => {
    expect(run(psFilter, 'ps -eo pid,lstart,cmd', raw)).toBeUndefined()
    expect(run(psFilter, 'ps axo pid,comm', raw)).toBeUndefined()
    expect(run(psFilter, 'ps aux --format pid', raw)).toBeUndefined()
    expect(run(psFilter, 'top -l 1', raw)).toBeUndefined()
    expect(run(psFilter, 'ps aux', `\u001b[1m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['ps aux', 'ps -ef', 'ps', 'sudo ps -ef']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('ps -o pid,comm')).toBe(false)
  })
})

describe('stat', () => {
  it('cuts the padding of the size, permission and device rows of real BSD `stat -x` blocks', () => {
    const raw = fixture('stat-x.txt')
    const projected = run(statFilter, 'stat -x src/a/file1.txt src/b', raw)!
    expect(projected).toContain('  File: "src/a/file1.txt"\nSize: 23 FileType: Regular File\nMode: (0644/-rw-r--r--) Uid: ( 501/demo) Gid: ( 20/ staff)\nDevice: 1,17 Inode: 827494049 Links: 1\nAccess: Sun Nov 22 17:14:33 2026\n')
    sameWords(raw, projected)
  })

  // Adapted from RTK's stat filter tests (Apache-2.0, see third-party/rtk), with GNU's real tabs and padding.
  it('handles GNU stat, whose fields are separated by tabs, and keeps the File and time rows as printed', () => {
    const gnu = [
      '  File: my  notes.txt',
      '  Size: 12345     \tBlocks: 24         IO Block: 4096   regular file',
      'Device: 259,2\tInode: 1234567     Links: 1',
      'Access: (0644/-rw-r--r--)  Uid: ( 1000/    demo)   Gid: ( 1000/    demo)',
      'Access: 2026-03-10 12:00:00.000000000 +0100',
      'Modify: 2026-03-10 11:00:00.000000000 +0100',
      'Change: 2026-03-10 11:00:00.000000000 +0100',
      ' Birth: 2026-03-09 10:00:00.000000000 +0100',
      '',
    ].join('\n')
    expect(run(statFilter, 'stat "my  notes.txt"', gnu)).toBe([
      '  File: my  notes.txt',
      'Size: 12345 Blocks: 24 IO Block: 4096 regular file',
      'Device: 259,2 Inode: 1234567 Links: 1',
      'Access: (0644/-rw-r--r--) Uid: ( 1000/ demo) Gid: ( 1000/ demo)',
      'Access: 2026-03-10 12:00:00.000000000 +0100',
      'Modify: 2026-03-10 11:00:00.000000000 +0100',
      'Change: 2026-03-10 11:00:00.000000000 +0100',
      ' Birth: 2026-03-09 10:00:00.000000000 +0100',
      '',
    ].join('\n'))
    const missing = "stat: cannot statx 'nope': No such file or directory\n" + gnu
    expect(run(statFilter, 'stat nope "my  notes.txt"', missing, 1)).toContain("stat: cannot statx 'nope': No such file or directory\n  File: my  notes.txt\nSize: 12345 ")
  })

  it('leaves custom formats, the one-line BSD default, other tools and ANSI output alone', () => {
    const raw = fixture('stat-x.txt')
    expect(run(statFilter, 'stat -c %s a', raw)).toBeUndefined()
    expect(run(statFilter, 'stat -f %z a', raw)).toBeUndefined()
    expect(run(statFilter, 'stat a', '16777233 827494049 -rw-r--r-- 1 demo staff 0 23 "Nov 22 17:14:33 2026" "Nov 22 17:14:33 2026" "Nov 22 17:14:33 2026" "Nov 22 17:14:33 2026" 4096 8 0 a\n')).toBeUndefined()
    expect(run(statFilter, 'file -x a', raw)).toBeUndefined()
    expect(run(statFilter, 'stat -x a', `\u001b[0m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['stat src/main.rs', 'stat -x *.log', 'stat -L link']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('stat -c %s file')).toBe(false)
  })
})

describe('ping', () => {
  const REPLY = /^\d+ bytes from /u

  it('folds the echo replies of a real run, keeping the header and the statistics', () => {
    const raw = fixture('ping.txt')
    const projected = run(pingFilter, 'ping -c 5 -i 0.2 127.0.0.1', raw)!
    expect(projected).toBe('PING 127.0.0.1 (127.0.0.1): 56 data bytes\n[5 echo reply lines omitted]\n\n' + raw.slice(raw.indexOf('--- 127.0.0.1 ping statistics ---')))
    keepsAllBut(raw, projected, REPLY)
  })

  it('keeps timeouts, duplicates and the loss figures between the folded runs (iputils layout)', () => {
    // Synthetic, iputils `ping` layout; seq 5 has no reply, seq 7 times out, seq 9 has a duplicate.
    const raw = [
      'PING example.org (93.184.215.14) 56(84) bytes of data.',
      ...[1, 2, 3, 4].map(seq => `64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=${seq} ttl=56 time=14.${seq} ms`),
      'From 10.0.0.1 icmp_seq=5 Destination Host Unreachable',
      '64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=6 ttl=56 time=14.6 ms',
      'Request timeout for icmp_seq 7',
      ...[8, 9].map(seq => `64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=${seq} ttl=56 time=14.${seq} ms`),
      '64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=9 ttl=56 time=15.0 ms (DUP!)',
      ...[10, 11, 12].map(seq => `64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=${seq} ttl=56 time=13.9 ms`),
      '',
      '--- example.org ping statistics ---',
      '12 packets transmitted, 10 received, +1 duplicates, 16.6667% packet loss, time 11015ms',
      'rtt min/avg/max/mdev = 13.900/14.321/15.000/0.402 ms',
      '',
    ].join('\n')
    const projected = run(pingFilter, 'ping -c 12 example.org', raw, 1)!
    expect(projected).toContain('bytes of data.\n[4 echo reply lines omitted]\nFrom 10.0.0.1 icmp_seq=5 Destination Host Unreachable\n64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=6')
    expect(projected).toContain('Request timeout for icmp_seq 7\n64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=8 ttl=56 time=14.8 ms\n64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=9 ttl=56 time=14.9 ms\n64 bytes from 93.184.215.14 (93.184.215.14): icmp_seq=9 ttl=56 time=15.0 ms (DUP!)\n[3 echo reply lines omitted]\n')
    keepsAllBut(raw, projected, /icmp_seq=(?:[1-4]|1[0-2]) ttl/u)
  })

  // Adapted from RTK's ping filter tests (Apache-2.0, see third-party/rtk).
  it('folds Windows replies too, and leaves an interrupted run, other tools and ANSI output alone', () => {
    const windows = 'Pinging 192.0.2.1 with 32 bytes of data:\nReply from 192.0.2.1: bytes=32 time=14ms TTL=56\nReply from 192.0.2.1: bytes=32 time=13ms TTL=56\nReply from 192.0.2.1: bytes=32 time=14ms TTL=56\nReply from 192.0.2.1: bytes=32 time<1ms TTL=56\n\nPing statistics for 192.0.2.1:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\nApproximate round trip times in milli-seconds:\n    Minimum = 0ms, Maximum = 14ms, Average = 10ms\n'
    expect(run(pingFilter, 'ping -n 4 192.0.2.1', windows)).toBe('Pinging 192.0.2.1 with 32 bytes of data:\n[4 echo reply lines omitted]\n\nPing statistics for 192.0.2.1:\n    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\nApproximate round trip times in milli-seconds:\n    Minimum = 0ms, Maximum = 14ms, Average = 10ms\n')
    const raw = fixture('ping.txt')
    const interrupted = raw.slice(0, raw.indexOf('\n---'))
    expect(run(pingFilter, 'ping 127.0.0.1', interrupted)).toBeUndefined()
    expect(run(pingFilter, 'fping 127.0.0.1', raw)).toBeUndefined()
    expect(run(pingFilter, 'ping 127.0.0.1', `\u001b[0m${raw}`)).toBeUndefined()
    const unreachable = 'PING unreachable.example.com (192.0.2.1): 56 data bytes\nRequest timeout for icmp_seq 0\nRequest timeout for icmp_seq 1\n\n--- unreachable.example.com ping statistics ---\n2 packets transmitted, 0 packets received, 100.0% packet loss\n'
    expect(run(pingFilter, 'ping unreachable.example.com', unreachable, 2)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['ping -c 5 127.0.0.1', 'ping6 -c 3 ::1']) expect(mayProject(command), command).toBe(true)
  })
})

describe('rsync', () => {
  it('previews a long file list of a real (openrsync) transfer, keeping its summary', () => {
    const raw = fixture('rsync.txt')
    const projected = run(rsyncFilter, 'rsync -av big/ dst2/', raw)!
    const rows = raw.split('\n').slice(1, 62)
    expect(projected).toBe(['Transfer starting: 61 files', ...rows.slice(0, 10), '[46 file list rows omitted]', ...rows.slice(-5), ...raw.split('\n').slice(62)].join('\n'))
    expect(projected).toContain('\nsent 4927 bytes  received 1346 bytes  297298 bytes/sec\ntotal size is 171  speedup is 0.03\n')
  })

  it('keeps errors, deletions and the summary of a GNU rsync run with a failure', () => {
    // Synthetic, GNU rsync 3.2 `-av --delete` layout.
    const files = Array.from({ length: 40 }, (_, i) => `src/module${String(i).padStart(2, '0')}/index.ts`)
    const raw = [
      'sending incremental file list',
      'created directory backup',
      './',
      'README.md',
      ...files.slice(0, 20),
      'rsync: [sender] send_files failed to open "/repo/src/secret.key": Permission denied (13)',
      ...files.slice(20),
      'deleting old/obsolete.txt',
      '',
      'sent 1,234,567 bytes  received 1,234 bytes  2,471,602.00 bytes/sec',
      'total size is 1,230,000  speedup is 1.00',
      'rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.2.7]',
      '',
    ].join('\n')
    // Neither run between the messages is longer than 30 rows.
    expect(run(rsyncFilter, 'rsync -av --delete ./ backup/', raw, 23)).toBeUndefined()
    const long = raw.replace(files[19]!, [files[19], ...Array.from({ length: 20 }, (_, i) => `src/extra/file${i}.ts`)].join('\n'))
    const projected = run(rsyncFilter, 'rsync -av --delete ./ backup/', long, 23)!
    expect(projected).toContain('README.md\nsrc/module00/index.ts\n')
    expect(projected).toContain('[27 file list rows omitted]\n')
    keepsAllBut(long, projected, /^src\/(?:module(?:0[8-9]|1\d)|extra\/file(?:\d|1[0-4]))(?:\/index)?\.ts$/u)
  })

  // Adapted from RTK's rsync filter tests (Apache-2.0, see third-party/rtk).
  it('leaves a short sync, a dry run, a listing, a failed run without summary and ANSI output alone', () => {
    const short = 'sending incremental file list\n./\nfile1.txt\nfile2.txt\n\nsent 1,234 bytes  received 42 bytes  2,552.00 bytes/sec\ntotal size is 98,765  speedup is 77.31\n'
    expect(run(rsyncFilter, 'rsync -av src/ dst/', short)).toBeUndefined()
    const raw = fixture('rsync.txt')
    expect(run(rsyncFilter, 'rsync -avn big/ dst2/', raw)).toBeUndefined()
    expect(run(rsyncFilter, 'rsync -av --dry-run big/ dst2/', raw)).toBeUndefined()
    expect(run(rsyncFilter, 'rsync --list-only big/', raw)).toBeUndefined()
    const failed = 'sending incremental file list\nrsync: [Receiver] mkdir "/remote/path" failed: Permission denied (13)\nrsync error: error in file system (code 11) at receiver.c(741) [Receiver=3.2.7]\n'
    expect(run(rsyncFilter, 'rsync -av src/ host:/remote/path', failed, 11)).toBeUndefined()
    expect(run(rsyncFilter, 'cp -av big/ dst2/', raw)).toBeUndefined()
    expect(run(rsyncFilter, 'rsync -av big/ dst2/', `\u001b[0m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['rsync -av src/ dst/', 'rsync -avz --delete ./ backup/', 'rsync -av build/* /srv/www/']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('rsync -avn src/ dst/')).toBe(false)
  })
})

describe('systemctl status', () => {
  // Synthetic, systemd 252 layout (labels right-aligned to the colon at column 11).
  const nginx = [
    '● nginx.service - A high performance web server and a reverse proxy server',
    '     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; preset: enabled)',
    '     Active: active (running) since Mon 2024-01-15 10:30:00 UTC; 2h 5min ago',
    '       Docs: man:nginx(8)',
    '             https://nginx.org/en/docs/',
    '    Process: 1230 ExecStartPre=/usr/sbin/nginx -t -q -g daemon on; master_process on; (code=exited, status=0/SUCCESS)',
    '   Main PID: 1234 (nginx)',
    '      Tasks: 5 (limit: 4915)',
    '     Memory: 8.5M',
    '        CPU: 52ms',
    '     CGroup: /system.slice/nginx.service',
    '             ├─1234 "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;"',
    '             ├─1235 "nginx: worker process"',
    '             ├─1236 "nginx: worker process"',
    '             └─1237 "nginx: worker process"',
    '',
    'Jan 15 10:30:00 web-1 systemd[1]: Starting nginx.service - A high performance web server and a reverse proxy server...',
    'Jan 15 10:30:00 web-1 systemd[1]: Started nginx.service - A high performance web server and a reverse proxy server.',
    '',
  ].join('\n')

  it('drops the label alignment and re-indents continuation rows, keeping every line\'s text', () => {
    const projected = run(systemctlStatusFilter, 'systemctl status nginx --no-pager', nginx)!
    expect(projected).toBe([
      '● nginx.service - A high performance web server and a reverse proxy server',
      'Loaded: loaded (/lib/systemd/system/nginx.service; enabled; preset: enabled)',
      'Active: active (running) since Mon 2024-01-15 10:30:00 UTC; 2h 5min ago',
      'Docs: man:nginx(8)',
      '  https://nginx.org/en/docs/',
      'Process: 1230 ExecStartPre=/usr/sbin/nginx -t -q -g daemon on; master_process on; (code=exited, status=0/SUCCESS)',
      'Main PID: 1234 (nginx)',
      'Tasks: 5 (limit: 4915)',
      'Memory: 8.5M',
      'CPU: 52ms',
      'CGroup: /system.slice/nginx.service',
      '  ├─1234 "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;"',
      '  ├─1235 "nginx: worker process"',
      '  ├─1236 "nginx: worker process"',
      '  └─1237 "nginx: worker process"',
      '',
      'Jan 15 10:30:00 web-1 systemd[1]: Starting nginx.service - A high performance web server and a reverse proxy server...',
      'Jan 15 10:30:00 web-1 systemd[1]: Started nginx.service - A high performance web server and a reverse proxy server.',
      '',
    ].join('\n'))
    sameWords(nginx, projected)
  })

  it('keeps the rows of a failed unit that report the failure as printed', () => {
    const failed = [
      '× api.service - API server',
      '     Loaded: loaded (/etc/systemd/system/api.service; enabled; preset: enabled)',
      '     Active: failed (Result: exit-code) since Tue 2024-01-16 09:00:01 UTC; 3s ago',
      '   Duration: 1.204s',
      '    Process: 4242 ExecStart=/usr/bin/node /srv/api/server.js (code=exited, status=1/FAILURE)',
      '   Main PID: 4242 (code=exited, status=1/FAILURE)',
      '        CPU: 312ms',
      '',
      'Jan 16 09:00:01 web-1 node[4242]: Error: listen EADDRINUSE: address already in use :::3000',
      'Jan 16 09:00:01 web-1 systemd[1]: api.service: Failed with result \'exit-code\'.',
      '',
    ].join('\n')
    const projected = run(systemctlStatusFilter, 'systemctl status api', failed, 3)!
    for (const line of failed.split('\n').filter(line => /fail|error/iu.test(line))) expect(projected).toContain(`${line}\n`)
    expect(projected).toContain('\nLoaded: loaded (/etc/systemd/system/api.service; enabled; preset: enabled)\n')
    expect(projected).toContain('\nDuration: 1.204s\n')
  })

  // Adapted from RTK's systemctl-status filter tests (Apache-2.0, see third-party/rtk).
  it('handles RTK\'s older layout and leaves other verbs, a missing unit and ANSI output alone', () => {
    const rtk = '● nginx.service - A high performance web server\n     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\n     Active: active (running) since Mon 2024-01-15 10:30:00 UTC; 2h ago\n       Docs: man:nginx(8)\n   Main PID: 1234 (nginx)\n      Tasks: 3 (limit: 4915)\n     Memory: 8.5M\n\n     CGroup: /system.slice/nginx.service\n             ├─1234 nginx: master process /usr/sbin/nginx\n             └─1235 nginx: worker process\n\nJan 15 10:30:00 host nginx[1234]: nginx/1.24.0\nJan 15 10:30:00 host systemd[1]: Started nginx.service\n'
    const projected = run(systemctlStatusFilter, 'systemctl status nginx', rtk)!
    expect(projected).toContain('\nMain PID: 1234 (nginx)\n')
    // After the blank line the block is over: those rows stay as printed.
    expect(projected).toContain('\n\n     CGroup: /system.slice/nginx.service\n             ├─1234')
    expect(run(systemctlStatusFilter, 'systemctl show nginx', nginx)).toBeUndefined()
    expect(run(systemctlStatusFilter, 'systemctl -H web-1 status nginx', nginx)).toBeUndefined()
    expect(run(systemctlStatusFilter, 'systemctl status nope', 'Unit nope.service could not be found.\n', 4)).toBeUndefined()
    expect(run(systemctlStatusFilter, 'service nginx status', nginx)).toBeUndefined()
    expect(run(systemctlStatusFilter, 'systemctl status nginx', `\u001b[0;1;32m${nginx}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['systemctl status nginx', 'systemctl --user status app.service', 'sudo systemctl status docker --no-pager']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('systemctl restart nginx')).toBe(false)
  })
})

describe('iptables -L', () => {
  // Synthetic, iptables 1.8 `-L` layout on a Docker host (trailing spaces where a rule has no options).
  const raw = [
    'Chain INPUT (policy ACCEPT)',
    'target     prot opt source               destination         ',
    'ACCEPT     all  --  anywhere             anywhere             state RELATED,ESTABLISHED',
    'ACCEPT     tcp  --  anywhere             anywhere             tcp dpt:ssh',
    'DROP       all  --  anywhere             anywhere             ctstate INVALID',
    '',
    'Chain FORWARD (policy DROP)',
    'target     prot opt source               destination         ',
    'DOCKER-USER  all  --  anywhere             anywhere            ',
    'DOCKER-ISOLATION-STAGE-1  all  --  anywhere             anywhere            ',
    'ACCEPT     all  --  anywhere             anywhere             ctstate RELATED,ESTABLISHED',
    'DOCKER     all  --  anywhere             anywhere            ',
    '           all  --  10.0.0.0/8           anywhere            ',
    '',
    'Chain DOCKER (1 references)',
    'target     prot opt source               destination         ',
    'ACCEPT     tcp  --  anywhere             172.17.0.2           tcp dpt:http /* web  frontend */',
    '',
  ].join('\n')

  it('cuts the column padding of headers and rule rows, keeping chains, options and odd rows as printed', () => {
    const projected = run(iptablesFilter, 'sudo iptables -L', raw)!
    expect(projected).toBe([
      'Chain INPUT (policy ACCEPT)',
      'target prot opt source destination',
      'ACCEPT all -- anywhere anywhere state RELATED,ESTABLISHED',
      'ACCEPT tcp -- anywhere anywhere tcp dpt:ssh',
      'DROP       all  --  anywhere             anywhere             ctstate INVALID',
      '',
      'Chain FORWARD (policy DROP)',
      'target prot opt source destination',
      'DOCKER-USER all -- anywhere anywhere',
      'DOCKER-ISOLATION-STAGE-1 all -- anywhere anywhere',
      'ACCEPT all -- anywhere anywhere ctstate RELATED,ESTABLISHED',
      'DOCKER all -- anywhere anywhere',
      // A rule with no target does not fit the header: as printed.
      '           all  --  10.0.0.0/8           anywhere            ',
      '',
      'Chain DOCKER (1 references)',
      'target prot opt source destination',
      'ACCEPT tcp -- anywhere 172.17.0.2 tcp dpt:http /* web  frontend */',
      '',
    ].join('\n'))
  })

  it('reads the verbose layout with counters and interfaces', () => {
    const verbose = [
      'Chain INPUT (policy ACCEPT 1234 packets, 567K bytes)',
      ' pkts bytes target     prot opt in     out     source               destination         ',
      ' 9876 1234K ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0           ',
      '   12   720 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:22',
      '',
    ].join('\n')
    expect(run(iptablesFilter, 'iptables -L -v -n', verbose)).toBe('Chain INPUT (policy ACCEPT 1234 packets, 567K bytes)\npkts bytes target prot opt in out source destination\n9876 1234K ACCEPT all -- lo * 0.0.0.0/0 0.0.0.0/0\n12 720 ACCEPT tcp -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:22\n')
  })

  // Adapted from RTK's iptables filter tests (Apache-2.0, see third-party/rtk).
  it('leaves rule specs, other tools and ANSI output alone', () => {
    const rtk = 'Chain INPUT (policy ACCEPT)\nnum  target     prot opt source               destination\n1    ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0\n'
    expect(run(iptablesFilter, 'iptables -L -n --line-numbers', rtk)).toBe('Chain INPUT (policy ACCEPT)\nnum target prot opt source destination\n1 ACCEPT all -- 0.0.0.0/0 0.0.0.0/0\n')
    expect(run(iptablesFilter, 'iptables -S', raw)).toBeUndefined()
    expect(run(iptablesFilter, 'iptables -A INPUT -j ACCEPT', raw)).toBeUndefined()
    expect(run(iptablesFilter, 'nft list ruleset', raw)).toBeUndefined()
    expect(run(iptablesFilter, 'iptables -L', `\u001b[0m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['sudo iptables -L', 'iptables -nvL', 'iptables -L INPUT -n --line-numbers']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('iptables -S')).toBe(false)
  })
})

describe('brew install', () => {
  const ok = '✔︎'
  // Synthetic, in the layout Homebrew 4.5+ prints when not on a terminal (download queue rows, then each install).
  const raw = [
    '==> Fetching downloads for: ffmpeg',
    ...['aom (3.12.1)', 'dav1d (1.5.1)', 'lame (3.100)', 'libvpx (1.15.2)', 'opus (1.5.2)', 'x264 (r3222)', 'x265 (4.1)', 'ffmpeg (7.1.1)'].flatMap(name => [`${ok} Bottle Manifest ${name}`, `${ok} Bottle ${name}`]),
    '==> Installing dependencies for ffmpeg: aom, dav1d, lame, libvpx, opus, x264 and x265',
    '==> Installing ffmpeg dependency: aom',
    '==> Pouring aom--3.12.1.arm64_sequoia.bottle.tar.gz',
    '🍺  /opt/homebrew/Cellar/aom/3.12.1: 24 files, 9.8MB',
    '==> Installing ffmpeg',
    '==> Pouring ffmpeg--7.1.1.arm64_sequoia.bottle.tar.gz',
    '🍺  /opt/homebrew/Cellar/ffmpeg/7.1.1: 285 files, 52.8MB',
    '==> Running `brew cleanup ffmpeg`...',
    'Disable this behaviour by setting `HOMEBREW_NO_INSTALL_CLEANUP=1`.',
    'Hide these hints with `HOMEBREW_NO_ENV_HINTS=1` (see `man brew`).',
    '',
  ].join('\n')
  const DOWNLOAD = /^(?:✔︎ (?:Bottle|Bottle Manifest) |==> Fetching downloads for: )/u

  it('folds the download queue, keeping every install, pour and summary line', () => {
    const projected = run(brewInstallFilter, 'brew install ffmpeg', raw)!
    expect(projected.startsWith('[17 download lines omitted]\n==> Installing dependencies for ffmpeg:')).toBe(true)
    keepsAllBut(raw, projected, DOWNLOAD)
    expect(projectStaticFilter({ command: 'brew upgrade ffmpeg', stdout: raw, exitCode: 0 })?.filter).toBe('brew-install')
  })

  it('keeps a failed download, warnings and errors', () => {
    const failing = raw.replace(`${ok} Bottle x265 (4.1)`, '✘ Bottle x265 (4.1)\nError: Failed to download resource "x265"\nDownload failed: https://ghcr.io/v2/homebrew/core/x265/blobs/sha256:0123')
    const projected = run(brewInstallFilter, 'brew install ffmpeg', failing, 1)!
    expect(projected).toContain('[14 download lines omitted]\n✘ Bottle x265 (4.1)\nError: Failed to download resource "x265"\nDownload failed: https://ghcr.io/v2/homebrew/core/x265/blobs/sha256:0123\n')
    keepsAllBut(failing, projected, DOWNLOAD)
  })

  // Adapted from RTK's brew-install filter tests (Apache-2.0, see third-party/rtk).
  it('folds the older serial download rows, and leaves already-installed notices, other subcommands and ANSI output alone', () => {
    const serial = '==> Fetching jq\n==> Downloading https://ghcr.io/v2/homebrew/core/jq/blobs/sha256:4b2e\nAlready downloaded: ~/Library/Caches/Homebrew/downloads/4b2e--jq-1.7.1.arm64_sonoma.bottle.tar.gz\n==> Pouring jq--1.7.1.arm64_sonoma.bottle.tar.gz\n🍺  /opt/homebrew/Cellar/jq/1.7.1: 18 files, 1.2MB\n'
    expect(run(brewInstallFilter, 'brew install jq', serial)).toBe('[3 download lines omitted]\n==> Pouring jq--1.7.1.arm64_sonoma.bottle.tar.gz\n🍺  /opt/homebrew/Cellar/jq/1.7.1: 18 files, 1.2MB\n')
    const installed = 'Warning: rtk 0.27.1 is already installed and up-to-date.\nTo reinstall 0.27.1, run:\n  brew reinstall rtk\n'
    expect(run(brewInstallFilter, 'brew install rtk', installed)).toBeUndefined()
    expect(run(brewInstallFilter, 'brew fetch ffmpeg', raw)).toBeUndefined()
    expect(run(brewInstallFilter, 'port install ffmpeg', raw)).toBeUndefined()
    expect(run(brewInstallFilter, 'brew install ffmpeg', `\u001b[34m==>\u001b[0m ${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['brew install ffmpeg', 'brew upgrade', 'brew reinstall jq']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('brew list')).toBe(false)
  })
})

describe('go-task', () => {
  // Adapted from RTK's task filter tests (Apache-2.0, see third-party/rtk), with more up-to-date tasks.
  const raw = 'task: Task "generate" is up to date\ntask: Task "deps" is up to date\ntask: Task "lint" is up to date\ntask: [build] go build ./...\n\ntask: [test] go test ./...\nok  \tmyapp\t0.5s\n'

  it('folds a run of up-to-date tasks into one note naming them, keeping every command line', () => {
    const projected = run(goTaskFilter, 'task test', raw)!
    expect(projected).toBe('[3 tasks up to date: "generate", "deps", "lint"]\ntask: [build] go build ./...\n\ntask: [test] go test ./...\nok  \tmyapp\t0.5s\n')
    expect(projectStaticFilter({ command: 'task test', stdout: raw, exitCode: 0 })?.filter).toBe('go-task')
  })

  it('keeps failures and short runs, and leaves other tools and ANSI output alone', () => {
    const failing = 'task: Task "generate" is up to date\ntask: Task "deps" is up to date\ntask: [build] go build ./...\n./main.go:10: undefined: foo\ntask: Failed to run task "build": exit status 1\n'
    expect(run(goTaskFilter, 'task build', failing, 201)).toBeUndefined()
    expect(run(goTaskFilter, 'make test', raw)).toBeUndefined()
    expect(run(goTaskFilter, 'task test', `\u001b[32m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['task test', 'task build -- -v', 'go-task lint']) expect(mayProject(command), command).toBe(true)
  })
})

describe('jq', () => {
  it('puts each element of an array on one line, every value as it was', () => {
    const raw = fixture('jq-items.txt')
    const projected = run(jqFilter, 'jq .items data.json', raw)!
    expect(projected).toBe('[\n  {"name":"a","tags":["x","y"],"meta":{"size":1}},\n  {"name":"b","tags":[],"meta":{"size":2.50}}\n]\n')
    expect(JSON.parse(projected)).toEqual(JSON.parse(raw))
  })

  it('keeps the first level of an object and each value of a stream on its own lines', () => {
    const pkg = fixture('jq-package.txt')
    const projected = run(jqFilter, 'jq . package.json', pkg)!
    expect(projected).toContain('\n  "repository": {"type":"git","url":"git+https://github.com/HKUDS/TokenWise.git","directory":"packages/core"},\n')
    expect(projected).toContain('\n  "description": "Host-independent TokenWise logic: deterministic tool-output filters, source maps, admission rules and the learned-rule sandbox.",\n')
    expect(JSON.parse(projected)).toEqual(JSON.parse(pkg))
    expect(projected.replace(/\s+/gu, '')).toBe(pkg.replace(/\s+/gu, ''))
    const stream = fixture('jq-stream.txt')
    expect(run(jqFilter, "jq '.items[]' data.json", stream)).toBe('{\n  "name": "a",\n  "tags": ["x","y"],\n  "meta": {"size":1}\n}\n{\n  "name": "b",\n  "tags": [],\n  "meta": {"size":2.50}\n}\n')
  })

  it('leaves raw output, already compact or flat JSON, errors, other tools and ANSI output alone', () => {
    const raw = fixture('jq-items.txt')
    expect(run(jqFilter, 'jq -r .items data.json', raw)).toBeUndefined()
    expect(run(jqFilter, 'jq -rc .items data.json', raw)).toBeUndefined()
    expect(run(jqFilter, 'jq --raw-output .items data.json', raw)).toBeUndefined()
    expect(run(jqFilter, 'jq -c .items data.json', '[{"name":"a"},{"name":"b"}]\n')).toBeUndefined()
    expect(run(jqFilter, 'jq .name package.json', '{\n  "name": "a",\n  "version": "1"\n}\n')).toBeUndefined()
    expect(run(jqFilter, 'jq .x data.json', 'jq: error (at data.json:0): Cannot index array with "x"\n', 5)).toBeUndefined()
    expect(run(jqFilter, 'jq . broken.json', '{\n  "a": [\n    1,\n')).toBeUndefined()
    expect(run(jqFilter, 'yq . data.yaml', raw)).toBeUndefined()
    expect(run(jqFilter, 'jq -C .items data.json', `\u001b[1;39m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['jq . package.json', "jq '.items[] | .name' data.json", 'jq -S . a.json']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('jq -r .name package.json')).toBe(false)
  })
})

describe('quarto render', () => {
  // Synthetic, in the layout Quarto 1.5 prints for a Jupyter document.
  const raw = [
    'Starting python3 kernel...Done',
    '',
    "Executing 'report.quarto_ipynb'",
    "  Cell 1/5: 'setup'.......................Done",
    "  Cell 2/5: 'load-data'...................Done",
    "  Cell 3/5: ''............................Done",
    "  Cell 4/5: 'fig-trend'...................Done",
    "  Cell 5/5: 'table'.......................Done",
    '',
    'pandoc ',
    '  to: html',
    '  output-file: report.html',
    '  standalone: true',
    '  section-divs: true',
    '  html-math-method: mathjax',
    '  wrap: none',
    '  default-image-extension: png',
    '  ',
    'metadata',
    '  document-css: false',
    '  link-citations: true',
    '  date-format: long',
    '  lang: en',
    '  title: Quarterly report',
    '  ',
    'Output created: report.html',
    '',
  ].join('\n')

  it('folds the pandoc echo and the finished cells, keeping the run and its output', () => {
    const projected = run(quartoRenderFilter, 'quarto render report.qmd', raw)!
    expect(projected).toBe("Starting python3 kernel...Done\n\nExecuting 'report.quarto_ipynb'\n[5 finished cell lines omitted]\n\n[14 pandoc option and metadata lines omitted]\nOutput created: report.html\n")
  })

  it('keeps a failing cell, its traceback and warnings', () => {
    const failing = raw.replace("  Cell 4/5: 'fig-trend'...................Done", "  Cell 4/5: 'fig-trend'...................\n\nAn error occurred while executing the following cell:\n------------------\nplot(df)\n------------------\nNameError: name 'plot' is not defined")
      .replace('  title: Quarterly report', '  title: Quarterly report\nWARNING (/repo/report.qmd): unknown option \'colour\'')
    const projected = run(quartoRenderFilter, 'quarto render report.qmd --to html', failing, 1)!
    expect(projected).toContain("Executing 'report.quarto_ipynb'\n[3 finished cell lines omitted]\n  Cell 4/5: 'fig-trend'...................\n\nAn error occurred")
    expect(projected).toContain("NameError: name 'plot' is not defined\n  Cell 5/5: 'table'")
    expect(projected).toContain("[14 pandoc option and metadata lines omitted]\nWARNING (/repo/report.qmd): unknown option 'colour'\n  \nOutput created: report.html\n")
  })

  // Adapted from RTK's quarto-render filter tests (Apache-2.0, see third-party/rtk).
  it('leaves output with nothing to fold, other subcommands, other tools and ANSI output alone', () => {
    const rtk = 'processing file: index.qmd\n  Validating schema\n  Resolving resources\npandoc to html5\nOutput created: _site/index.html\n'
    expect(run(quartoRenderFilter, 'quarto render index.qmd', rtk)).toBeUndefined()
    expect(run(quartoRenderFilter, 'quarto preview report.qmd', raw)).toBeUndefined()
    expect(run(quartoRenderFilter, 'pandoc report.md', raw)).toBeUndefined()
    expect(run(quartoRenderFilter, 'quarto render report.qmd', `\u001b[1m${raw}`)).toBeUndefined()
  })

  it('is routed before the command runs', () => {
    for (const command of ['quarto render', 'quarto render report.qmd --to pdf']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('quarto preview')).toBe(false)
  })
})

describe('linters', () => {
  // Adapted from RTK's hadolint filter tests (Apache-2.0, see third-party/rtk), with more rows.
  const hadolint = [
    'Dockerfile:3 DL3008 warning: Pin versions in apt get install. Instead of `apt-get install <package>` use `apt-get install <package>=<version>`',
    'Dockerfile:3 DL3015 info: Avoid additional packages by specifying `--no-install-recommends`',
    'Dockerfile:5 DL3009 info: Delete the apt-get lists after installing something',
    'Dockerfile:8 DL4006 warning: Set the SHELL option -o pipefail before RUN with a pipe in it.',
    'Dockerfile:11 SC2086 info: Double quote to prevent globbing and word splitting.',
    'docker/worker.Dockerfile:1 DL3007 warning: Using latest is prone to errors if the image will ever update.',
    '',
  ].join('\n')

  it('hadolint: groups each file\'s diagnostics under one header, keeping every one', () => {
    const projected = run(hadolintFilter, 'hadolint Dockerfile docker/worker.Dockerfile', hadolint, 1)!
    expect(projected).toContain('[diagnostics in Dockerfile]\n  3 DL3008 warning: Pin versions')
    expect(projected).toContain('\ndocker/worker.Dockerfile:1 DL3007 warning: Using latest')
    expect(ungroup(projected, '[diagnostics in ', ']')).toBe(hadolint)
    expect(run(hadolintFilter, 'hadolint -f json Dockerfile', hadolint, 1)).toBeUndefined()
    expect(run(hadolintFilter, 'hadolint --format tty Dockerfile', hadolint, 1)).toBe(projected)
  })

  it('shellcheck -f gcc: groups each file\'s diagnostics under one header (real output)', () => {
    const raw = fixture('shellcheck-gcc.txt')
    const projected = run(shellcheckFilter, 'shellcheck -f gcc sh/deploy.sh sh/build.sh', raw, 1)!
    expect(projected).toContain('[diagnostics in sh/deploy.sh]\n  4:10: error: Iterating over ls output is fragile. Use globs. [SC2045]\n')
    expect(projected).toContain('[diagnostics in sh/build.sh]\n  2:6: note:')
    expect(ungroup(projected, '[diagnostics in ', ']')).toBe(raw)
    expect(projectStaticFilter({ command: 'shellcheck --format=gcc scripts/*.sh', stdout: raw, exitCode: 1 })?.filter).toBe('shellcheck')
  })

  it('shellcheck: the default report, where every line belongs to a diagnostic block, passes through', () => {
    const tty = fixture('shellcheck-tty.txt')
    expect(run(shellcheckFilter, 'shellcheck sh/deploy.sh sh/build.sh', tty, 1)).toBeUndefined()
    expect(projectStaticFilter({ command: 'shellcheck sh/deploy.sh sh/build.sh', stdout: tty, exitCode: 1 })).toBeUndefined()
    expect(run(shellcheckFilter, 'shellcheck -f gcc a.sh', `\u001b[31m${fixture('shellcheck-gcc.txt')}`, 1)).toBeUndefined()
  })

  it('yamllint -f parsable: groups each file\'s diagnostics; the standard report passes through', () => {
    // Synthetic, yamllint 1.35 parsable layout.
    const parsable = [
      '.github/workflows/ci.yml:1:1: [warning] missing document start "---" (document-start)',
      '.github/workflows/ci.yml:3:1: [warning] truthy value should be one of [false, true] (truthy)',
      '.github/workflows/ci.yml:12:81: [error] line too long (96 > 80 characters) (line-length)',
      '.github/workflows/ci.yml:20:5: [error] wrong indentation: expected 6 but found 4 (indentation)',
      'config.yml:5:12: [error] too many spaces inside braces (braces)',
      '',
    ].join('\n')
    const projected = run(yamllintFilter, 'yamllint -f parsable .', parsable, 1)!
    expect(projected).toContain('[diagnostics in .github/workflows/ci.yml]\n  1:1: [warning] missing document start "---" (document-start)\n')
    expect(ungroup(projected, '[diagnostics in ', ']')).toBe(parsable)
    // Adapted from RTK's yamllint filter tests (Apache-2.0, see third-party/rtk).
    const standard = 'config.yml\n  3:1     warning  missing document start "---"  (document-start)\n  5:12    error    too many spaces inside braces  (braces)\n  8:1     error    wrong indentation: expected 2 but found 4  (indentation)\n\n'
    expect(run(yamllintFilter, 'yamllint config.yml', standard, 1)).toBeUndefined()
    expect(run(yamllintFilter, 'yamllint -f parsable .', `\u001b[4m${parsable}`, 1)).toBeUndefined()
  })

  it('are routed before the command runs, for the formats they read', () => {
    for (const command of ['hadolint Dockerfile', 'shellcheck -f gcc scripts/*.sh', 'yamllint -f parsable .']) expect(mayProject(command), command).toBe(true)
    expect(mayProject('shellcheck scripts/deploy.sh')).toBe(false)
    expect(mayProject('yamllint .')).toBe(false)
  })
})
