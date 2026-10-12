/**
 * Claude Code fallback (ARCHITECTURE §4): a folder `$CLAUDE_CONFIG_DIR/skills/peers/` holding a
 * plugin tree auto-loads as `peers@skills-dir` in new sessions, with no CLI and no marketplace.
 * A marker file proves the folder is ours, so `remove` never deletes a user's own skill.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeConfigDir } from '../agents/claude'
import type { Sys } from '../agents/types'
import { PLUGIN_NAME, syncTree, treeFiles } from '../assets/materialize'
import type { InstallContext, StepOutcome } from './types'

export const SKILLS_DIR_MARKER = '.agent-peers-install.json'

export const skillsDirPath = (sys: Sys): string => join(claudeConfigDir(sys), 'skills', PLUGIN_NAME)

/** True when `skills/peers` exists and carries our marker. */
export async function hasOurSkillsDir(sys: Sys): Promise<boolean> {
  return sys.exists(join(skillsDirPath(sys), SKILLS_DIR_MARKER))
}

/** Copies the Claude Code plugin (shim pinned) into the skills dir. Refuses a folder that isn't ours. */
export async function installSkillsDir(ctx: InstallContext): Promise<StepOutcome> {
  const dir = skillsDirPath(ctx.sys)
  if ((await ctx.sys.exists(dir)) && !(await hasOurSkillsDir(ctx.sys))) {
    return {
      ok: false,
      changed: false,
      lines: [`${dir} exists and was not created by agent-peers; move it away and rerun`],
    }
  }
  const marker = { path: SKILLS_DIR_MARKER, mode: 0o644, content: Buffer.from(markerJson(ctx.version)) }
  const written = await syncTree(dir, [...treeFiles('claude-code', ctx.binary), marker])
  return {
    ok: true,
    changed: written > 0,
    method: 'skills-dir',
    lines: [`copied the plugin to ${dir} (loads as peers@skills-dir in new sessions)`],
  }
}

export async function removeSkillsDir(sys: Sys): Promise<StepOutcome> {
  if (!(await hasOurSkillsDir(sys))) return { ok: true, changed: false, lines: [] }
  const dir = skillsDirPath(sys)
  await rm(dir, { recursive: true, force: true })
  return { ok: true, changed: true, lines: [`removed ${dir}`] }
}

const markerJson = (version: string): string =>
  `${JSON.stringify({ installed_by: 'agent-peers', version }, null, 2)}\n`
