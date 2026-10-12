/** Small, dependency-free helpers for validating the adapter trees. Every check returns a list of issues. */
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'

export type JsonObject = { readonly [key: string]: unknown }
export type Issues = readonly string[]

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** `[message]` when the condition fails, `[]` otherwise. */
export const check = (condition: boolean, message: string): Issues => (condition ? [] : [message])

export const sameList = (actual: unknown, expected: readonly string[]): boolean =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((item, i) => item === expected[i])

export const sameSet = (actual: Iterable<string>, expected: Iterable<string>): boolean => {
  const a = [...new Set(actual)].sort()
  const b = [...new Set(expected)].sort()
  return a.length === b.length && a.every((item, i) => item === b[i])
}

export type JsonResult = { readonly value: JsonObject; readonly issues: Issues }

/** Reads a JSON object; a missing file, bad JSON or a non-object yields an issue and an empty object. */
export const readJsonObject = async (path: string, label: string): Promise<JsonResult> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { value: {}, issues: [`${label}: file not found`] }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed)
      ? { value: parsed, issues: [] }
      : { value: {}, issues: [`${label}: not an object`] }
  } catch (error) {
    return { value: {}, issues: [`${label}: invalid JSON (${(error as Error).message})`] }
  }
}

export const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

export const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** A regular file with an execute bit for its owner. */
export const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path)
    await access(path, constants.X_OK)
    return info.isFile()
  } catch {
    return false
  }
}

export type Frontmatter = {
  readonly fields: { readonly [key: string]: string | boolean }
  readonly body: string
}

const parseScalar = (raw: string): string | boolean => {
  if (raw === 'true' || raw === 'false') return raw === 'true'
  if (raw.startsWith('"')) {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'string') throw new Error(`not a string: ${raw}`)
    return parsed
  }
  return raw
}

/**
 * Parses the flat `key: value` YAML frontmatter the skills use (plain, `true`/`false` or double-quoted
 * values). Returns `undefined` when the block is missing or malformed.
 */
export const parseFrontmatter = (text: string): Frontmatter | undefined => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) return undefined
  const [, header = '', body = ''] = match
  try {
    const entries = header.split('\n').map((line) => {
      const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
      if (!pair) throw new Error(`bad line: ${line}`)
      const [, key = '', raw = ''] = pair
      return [key, parseScalar(raw.trim())] as const
    })
    return { fields: Object.fromEntries(entries), body }
  } catch {
    return undefined
  }
}

/** A command path Codex accepts: a bare name, or `./` contained in the plugin with no `..`. */
export const isContainedCommand = (command: string): boolean =>
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(command) ||
  (/^\.\/[^/]/.test(command) && !command.split('/').includes('..'))
