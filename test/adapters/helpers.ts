import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ADAPTERS_DIR = resolve(import.meta.dir, '../../adapters')

export const makeTempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `agent-peers-${prefix}-`))

/** Copies `adapters/` (without the generated marketplace copy) into a fresh temp dir. */
export const copyAdapters = async (): Promise<string> => {
  const root = await makeTempDir('adapters')
  const target = join(root, 'adapters')
  await cp(ADAPTERS_DIR, target, {
    recursive: true,
    filter: (source) => !source.includes(join('marketplace', 'plugins')),
  })
  return target
}

export const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true })

type Json = { [key: string]: unknown }

/** Reads a JSON file, applies `edit` to a structured clone, and writes the result back. */
export const editJson = async (path: string, edit: (value: Json) => void): Promise<void> => {
  const value = JSON.parse(await readFile(path, 'utf8')) as Json
  const copy = structuredClone(value)
  edit(copy)
  await writeFile(path, JSON.stringify(copy, null, 2))
}

export const readJson = async (path: string): Promise<Json> =>
  JSON.parse(await readFile(path, 'utf8')) as Json
