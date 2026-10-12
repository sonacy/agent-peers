/** Helpers for `run/`: one `<bridge_pid>.sock` plus `<bridge_pid>.json` per bridge (ARCHITECTURE §5). */
import { readdir, rm } from 'node:fs/promises'
import { errnoCode } from './fs'
import { infoPathFor, pidFromRunFile, socketPathFor } from './paths'

/** PIDs with a `<pid>.json` or `<pid>.sock` in `runDir`, ascending; empty when the dir is missing. */
export async function listRunPids(runDir: string): Promise<readonly number[]> {
  let names: string[]
  try {
    names = await readdir(runDir)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return []
    throw error
  }
  const pids = new Set<number>()
  for (const name of names) {
    const pid = pidFromRunFile(name, '.json') ?? pidFromRunFile(name, '.sock')
    if (pid !== undefined) pids.add(pid)
  }
  return [...pids].sort((a, b) => a - b)
}

/** Removes a bridge's socket and info file; missing files are fine. */
export async function removeRunFiles(runDir: string, pid: number): Promise<void> {
  await rm(socketPathFor(runDir, pid), { force: true })
  await rm(infoPathFor(runDir, pid), { force: true })
}
