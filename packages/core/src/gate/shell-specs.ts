/**
 * Per-command flag knowledge for the peer-turn shell allowlist. `rg` uses an allowlist (new flags
 * fail closed: rg 14 added `--hostname-bin`, which runs a program); the rest deny known-dangerous
 * flags. Flags not listed for a deny-list command are treated as booleans.
 */

export interface CommandSpec {
  /** Short flags (single letters) and long flags that consume a value. */
  readonly valueFlags: ReadonlySet<string>
  /** Value flags whose value names a file (or `rev:path`). */
  readonly pathFlags: ReadonlySet<string>
  /** Denied flags: exact long names (also `--x-…` variants), or single short letters. */
  readonly deny: readonly string[]
  /** Allowlisted boolean flags (letters and long names); when set, any other flag is refused. */
  readonly allow?: ReadonlySet<string>
  /** The first positional is a search pattern, unless one of `patternFlags` supplied one. */
  readonly patternFirst?: boolean
  /** Flags that supply the pattern (`-e`, `-f`, `--regexp`, `--file`). */
  readonly patternFlags?: ReadonlySet<string>
  /** `--glob`-style filters for recursive searches. */
  readonly globFlags?: ReadonlySet<string>
  readonly iglobFlags?: ReadonlySet<string>
}

const set = (...values: string[]): ReadonlySet<string> => new Set(values)

const RG_VALUE_FLAGS = set(
  'e',
  'f',
  'g',
  't',
  'T',
  'm',
  'A',
  'B',
  'C',
  'j',
  'M',
  'E',
  'r',
  'd',
  '--regexp',
  '--file',
  '--glob',
  '--iglob',
  '--type',
  '--type-not',
  '--type-add',
  '--type-clear',
  '--max-count',
  '--after-context',
  '--before-context',
  '--context',
  '--threads',
  '--max-columns',
  '--encoding',
  '--replace',
  '--sort',
  '--sortr',
  '--max-depth',
  '--max-filesize',
  '--ignore-file',
  '--engine',
  '--dfa-size-limit',
  '--regex-size-limit',
  '--color',
  '--colors',
  '--context-separator',
  '--field-context-separator',
  '--field-match-separator',
  '--path-separator',
)

/** rg flags that only change matching or output (ripgrep 14). */
const RG_ALLOW = set(
  ...'sFivxUPSawbnN0opqHIclhV'.split(''),
  '--case-sensitive',
  '--ignore-case',
  '--smart-case',
  '--fixed-strings',
  '--no-fixed-strings',
  '--invert-match',
  '--line-regexp',
  '--word-regexp',
  '--crlf',
  '--no-crlf',
  '--mmap',
  '--no-mmap',
  '--multiline',
  '--no-multiline',
  '--multiline-dotall',
  '--no-multiline-dotall',
  '--unicode',
  '--no-unicode',
  '--null-data',
  '--pcre2',
  '--no-pcre2',
  '--no-pcre2-unicode',
  '--auto-hybrid-regex',
  '--no-auto-hybrid-regex',
  '--stop-on-nonmatch',
  '--text',
  '--no-text',
  '--binary',
  '--no-binary',
  '--glob-case-insensitive',
  '--no-glob-case-insensitive',
  '--ignore-file-case-insensitive',
  '--one-file-system',
  '--no-one-file-system',
  '--no-require-git',
  '--require-git',
  '--block-buffered',
  '--line-buffered',
  '--byte-offset',
  '--no-byte-offset',
  '--column',
  '--no-column',
  '--no-context-separator',
  '--heading',
  '--no-heading',
  '--include-zero',
  '--no-include-zero',
  '--line-number',
  '--no-line-number',
  '--max-columns-preview',
  '--no-max-columns-preview',
  '--null',
  '--only-matching',
  '--passthru',
  '--pretty',
  '--quiet',
  '--trim',
  '--no-trim',
  '--vimgrep',
  '--with-filename',
  '--no-filename',
  '--sort-files',
  '--count',
  '--count-matches',
  '--files-with-matches',
  '--files-without-match',
  '--json',
  '--no-json',
  '--no-messages',
  '--messages',
  '--no-ignore-messages',
  '--stats',
  '--no-stats',
  '--files',
  '--type-list',
  '--help',
  '--version',
)

export const SPECS: Readonly<Record<string, CommandSpec>> = {
  rg: {
    valueFlags: RG_VALUE_FLAGS,
    pathFlags: set('f', '--file', '--ignore-file'),
    deny: [
      '--pre',
      '--pre-glob',
      '--search-zip',
      '--hidden',
      '--unrestricted',
      '--no-ignore',
      '--follow',
      '--no-config',
      '--hostname-bin',
      '--hyperlink-format',
      'z',
      'u',
      'L',
      '.',
    ],
    allow: RG_ALLOW,
    patternFirst: true,
    patternFlags: set('e', 'f', '--regexp', '--file'),
    globFlags: set('g', '--glob'),
    iglobFlags: set('--iglob'),
  },
  grep: {
    valueFlags: set(
      'e',
      'f',
      'm',
      'A',
      'B',
      'C',
      'd',
      'D',
      '--regexp',
      '--file',
      '--max-count',
      '--context',
      '--directories',
      '--devices',
      '--exclude-from',
    ),
    pathFlags: set('f', '--file', '--exclude-from'),
    deny: ['r', 'R', 'd', '--recursive', '--dereference-recursive', '--directories'],
    patternFirst: true,
    patternFlags: set('e', 'f', '--regexp', '--file'),
  },
  git: {
    valueFlags: set('n', 'S', 'G', 'O', 'L', '--max-count', '--author', '--grep', '--since', '--until'),
    pathFlags: set('O', 'L'),
    deny: [
      '--output',
      '--no-index',
      '--ext-diff',
      '--exec-path',
      '--git-dir',
      '--work-tree',
      '--textconv',
      '--open-files-in-pager',
    ],
  },
  tail: { valueFlags: set('n', 'c'), pathFlags: set(), deny: ['f', 'F', '--follow'] },
  head: { valueFlags: set('n', 'c'), pathFlags: set(), deny: [] },
  wc: { valueFlags: set(), pathFlags: set(), deny: ['--files0-from'] },
}

export const GENERIC: CommandSpec = { valueFlags: set(), pathFlags: set(), deny: [] }

/** `git log` prints file contents only with these; `git diff` / `git show` always unless suppressed. */
export const GIT_PATCH_SHORT = set('p', 'u', 'U', 'L', 'c', 'W')
export const GIT_PATCH_LONG = [
  '--patch',
  '--unified',
  '--word-diff',
  '--color-words',
  '--cc',
  '--function-context',
]
export const GIT_NO_PATCH = [
  '--no-patch',
  '--stat',
  '--numstat',
  '--shortstat',
  '--name-only',
  '--name-status',
  '--summary',
  '--raw',
  '--dirstat',
  '--compact-summary',
]
