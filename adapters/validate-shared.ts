/** Checks shared by the Claude Code and Codex trees: skills and the shim. */
import { join } from 'node:path'
import { PEERS_TOOLS, type PeersCommand, SHIM_PATH } from './tools'
import {
  check,
  fileExists,
  type Issues,
  isExecutableFile,
  isNonEmptyString,
  parseFrontmatter,
  readText,
} from './validate-common'

export type SkillFlavor = 'claude-code' | 'codex'

/** Every command maps to a registered `user` tool. */
export const validateCommandTools = (commands: readonly PeersCommand[]): Issues =>
  commands.flatMap((command) => {
    const tool = PEERS_TOOLS.find((candidate) => candidate.name === command.tool)
    if (!tool) return [`command ${command.name}: ${command.tool} is not a peers MCP tool`]
    return check(tool.audience === 'user', `command ${command.name}: ${command.tool} is not a user tool`)
  })

const flavorChecks = (
  flavor: SkillFlavor,
  command: PeersCommand,
  fields: { readonly [key: string]: string | boolean },
  body: string,
): Issues => {
  const where = `skills/${command.name}`
  if (flavor === 'claude-code') {
    const disabled = fields['disable-model-invocation'] === true
    return [
      ...check(body.includes('$ARGUMENTS'), `${where}: must pass $ARGUMENTS`),
      ...check(
        disabled === command.userOnly,
        `${where}: disable-model-invocation must be ${command.userOnly}`,
      ),
    ]
  }
  return [
    ...check(fields.name === command.name, `${where}: name must be "${command.name}"`),
    ...check(!body.includes('$ARGUMENTS'), `${where}: Codex does not substitute $ARGUMENTS`),
  ]
}

const validateSkill = async (dir: string, flavor: SkillFlavor, command: PeersCommand): Promise<Issues> => {
  const where = `skills/${command.name}`
  const text = await readText(join(dir, 'skills', command.name, 'SKILL.md'))
  if (text === undefined) return [`${where}/SKILL.md: missing`]
  const parsed = parseFrontmatter(text)
  if (!parsed) return [`${where}/SKILL.md: missing or malformed frontmatter`]
  const policyPath = join(dir, 'skills', command.name, 'agents', 'openai.yaml')
  const policy = flavor === 'codex' ? await readText(policyPath) : undefined
  const policyIssues =
    flavor === 'codex'
      ? check(
          (policy?.includes('allow_implicit_invocation: false') ?? false) === command.userOnly,
          `${where}: agents/openai.yaml implicit-invocation policy must match userOnly=${command.userOnly}`,
        )
      : []
  return [
    ...check(isNonEmptyString(parsed.fields.description), `${where}: description is required`),
    ...check(parsed.body.includes(`\`${command.tool}\``), `${where}: must name the ${command.tool} tool`),
    ...flavorChecks(flavor, command, parsed.fields, parsed.body),
    ...policyIssues,
  ]
}

export const validateSkills = async (
  dir: string,
  flavor: SkillFlavor,
  commands: readonly PeersCommand[],
): Promise<Issues> => {
  const perSkill = await Promise.all(commands.map((command) => validateSkill(dir, flavor, command)))
  return [...validateCommandTools(commands), ...perSkill.flat()]
}

export const validateShim = async (dir: string): Promise<Issues> => {
  const path = join(dir, SHIM_PATH)
  if (!(await fileExists(path))) return [`${SHIM_PATH}: missing`]
  const text = (await readText(path)) ?? ''
  return [
    ...check(await isExecutableFile(path), `${SHIM_PATH}: must be executable`),
    ...check(text.startsWith('#!/bin/sh\n'), `${SHIM_PATH}: must be a POSIX sh script`),
    ...check(/\bexec "\$bin" "\$@"/.test(text), `${SHIM_PATH}: must exec the binary with "$@"`),
    ...check(text.includes('CURSOR_VERSION'), `${SHIM_PATH}: must no-op hooks under Cursor`),
  ]
}
