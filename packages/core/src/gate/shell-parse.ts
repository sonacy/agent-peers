/**
 * A deliberately strict POSIX-shell tokenizer for the peer-turn gate. It understands quoting,
 * escapes, line continuations and the list/pipe operators, and refuses everything that could run or
 * read something the words don't show: expansions (`$`, `~user`, zsh `=cmd`), substitutions,
 * redirections, subshells, globs, braces, background jobs, env assignments and unusual whitespace.
 */

export type ShellParse =
  | { readonly ok: true; readonly segments: readonly (readonly string[])[] }
  | { readonly ok: false; readonly reason: string }

const OPERATORS = ['&&', '||', '|', ';', '\n'] as const
const FORBIDDEN: Readonly<Record<string, string>> = {
  $: 'variable expansion and command substitution',
  '`': 'command substitution',
  '>': 'redirection',
  '<': 'redirection',
  '(': 'subshells',
  ')': 'subshells',
  '&': 'background jobs',
  '*': 'unquoted globs',
  '?': 'unquoted globs',
  '[': 'unquoted globs',
  '{': 'brace expansion',
  '}': 'brace expansion',
}

/** Word separators the shell and this parser agree on. Every other whitespace character is refused. */
const BLANK = /^[ \t\r]$/
/** Any whitespace, including NBSP, \v, \f and Unicode spaces the shell would keep inside a word. */
const WHITESPACE = /^\s$/
/** Characters a double-quoted backslash escapes (POSIX); before anything else it stays literal. */
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\'])

interface Cursor {
  readonly text: string
  index: number
}

function readSingle(cur: Cursor): string | undefined {
  const end = cur.text.indexOf("'", cur.index + 1)
  if (end < 0) return undefined
  const value = cur.text.slice(cur.index + 1, end)
  cur.index = end + 1
  return value
}

function readDouble(cur: Cursor): { value?: string; reason?: string } {
  let value = ''
  for (let i = cur.index + 1; i < cur.text.length; i++) {
    const ch = cur.text[i] as string
    if (ch === '"') {
      cur.index = i + 1
      return { value }
    }
    if (ch === '$' || ch === '`') return { reason: `"${ch}" (${FORBIDDEN[ch]}) is not allowed` }
    if (ch === '\\' && i + 1 < cur.text.length) {
      const next = cur.text[i + 1] as string
      i++
      // Backslash-newline is a line continuation: both characters disappear.
      if (next === '\n') continue
      value += DQ_ESCAPABLE.has(next) ? next : `\\${next}`
      continue
    }
    value += ch
  }
  return { reason: 'unterminated double quote' }
}

function operatorAt(text: string, index: number): string | undefined {
  return OPERATORS.find((op) => text.startsWith(op, index))
}

type Step = { word?: string; op?: string; reason?: string }

const isWordEnd = (text: string, index: number): boolean =>
  index >= text.length || BLANK.test(text[index] as string) || operatorAt(text, index) !== undefined

/** `~` and `~/…` expand to $HOME, which the path checks model; `~user`, `~+`, `~-` are refused. */
function tildeProblem(cur: Cursor): string | undefined {
  const next = cur.index + 1
  if (isWordEnd(cur.text, next) || cur.text[next] === '/') return undefined
  return '"~" followed by a name (~user, ~+, ~-) is not allowed'
}

/** One unquoted, unescaped character of a word; returns a refusal reason or the text to append. */
function plainChar(cur: Cursor, atStart: boolean): { text?: string; reason?: string } {
  const ch = cur.text[cur.index] as string
  if (FORBIDDEN[ch]) return { reason: `"${ch}" (${FORBIDDEN[ch]}) is not allowed` }
  if (WHITESPACE.test(ch)) return { reason: 'unusual whitespace characters are not allowed' }
  if (atStart && ch === '~') {
    const problem = tildeProblem(cur)
    if (problem) return { reason: problem }
  }
  if (atStart && ch === '=')
    return { reason: 'a word starting with "=" (zsh command expansion) is not allowed' }
  cur.index++
  return { text: ch }
}

/** Reads one word or operator starting at a non-blank character. */
function readToken(cur: Cursor): Step {
  const op = operatorAt(cur.text, cur.index)
  if (op) {
    cur.index += op.length
    return { op }
  }
  if (cur.text[cur.index] === '#') return { reason: 'comments are not allowed' }
  const start = cur.index
  let word = ''
  let quoted = false
  while (!isWordEnd(cur.text, cur.index)) {
    const ch = cur.text[cur.index] as string
    if (ch === "'") {
      const value = readSingle(cur)
      if (value === undefined) return { reason: 'unterminated single quote' }
      word += value
      quoted = true
    } else if (ch === '"') {
      const res = readDouble(cur)
      if (res.reason !== undefined) return { reason: res.reason }
      word += res.value
      quoted = true
    } else if (ch === '\\') {
      if (cur.index + 1 >= cur.text.length) return { reason: 'dangling backslash' }
      const next = cur.text[cur.index + 1] as string
      cur.index += 2
      // Backslash-newline is a line continuation: the shell deletes both characters.
      if (next !== '\n') {
        word += next
        quoted = true
      }
    } else {
      const res = plainChar(cur, cur.index === start)
      if (res.reason !== undefined) return { reason: res.reason }
      word += res.text
    }
  }
  if (cur.index === start) return { reason: 'unexpected character in the command' }
  // A word that was only line continuations is no word at all.
  return word === '' && !quoted ? {} : { word }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Splits a command line into simple commands (lists and pipelines), or explains the refusal. */
export function parseShell(command: string): ShellParse {
  const cur: Cursor = { text: command, index: 0 }
  const segments: string[][] = []
  let current: string[] = []
  let danglingOperator = false
  const flush = (): string | undefined => {
    if (current.length === 0) return 'empty command in a list or pipeline'
    if (current[0] && ASSIGNMENT.test(current[0])) return 'environment assignments are not allowed'
    segments.push(current)
    current = []
    return undefined
  }
  while (cur.index < cur.text.length) {
    if (BLANK.test(cur.text[cur.index] as string)) {
      cur.index++
      continue
    }
    const step = readToken(cur)
    if (step.reason) return { ok: false, reason: step.reason }
    if (step.op) {
      if (step.op === '\n' && current.length === 0) continue
      const problem = flush()
      if (problem) return { ok: false, reason: problem }
      danglingOperator = step.op !== '\n' && step.op !== ';'
    } else if (step.word !== undefined) {
      current.push(step.word)
      danglingOperator = false
    }
  }
  if (current.length > 0) {
    const problem = flush()
    if (problem) return { ok: false, reason: problem }
  }
  if (danglingOperator) return { ok: false, reason: 'empty command in a list or pipeline' }
  if (segments.length === 0) return { ok: false, reason: 'empty command' }
  return { ok: true, segments }
}

const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh'])

/**
 * Codex sends `command` as argv (`["bash", "-lc", "git status"]`) or a string; Claude sends a
 * string. Returns the shell script to parse, or the argv to check as one simple command.
 */
export function commandFromInput(
  command: unknown,
): { readonly script: string } | { readonly argv: readonly string[] } | undefined {
  if (typeof command === 'string') return { script: command }
  if (!Array.isArray(command) || command.length === 0) return undefined
  if (!command.every((part): part is string => typeof part === 'string')) return undefined
  const [first, flag, script, ...rest] = command
  if (
    first &&
    SHELLS.has(first) &&
    flag &&
    /^-[a-z]*c$/.test(flag) &&
    script !== undefined &&
    rest.length === 0
  )
    return { script }
  return { argv: command }
}
