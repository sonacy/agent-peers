import { describe, expect, it } from 'bun:test'
import { buildProgram, main } from '../src/program'
import { memoryIo } from './helpers/world'

/** Every top-level command of the binary (ARCHITECTURE §9, ONBOARDING §3). */
const COMMANDS = [
  'add',
  'remove',
  'doctor',
  'join',
  'who',
  'ask',
  'say',
  'inbox',
  'rename',
  'status',
  'leave',
  'knock',
  'dashboard',
  'hub',
  'invite',
  'rooms',
  'version',
  'mcp',
  'hook',
]

describe('agent-peers program', () => {
  it('mounts every command under the global flags', async () => {
    const io = memoryIo({})
    expect(await main(['--help'], io)).toBe(0)
    const help = io.out.join('')
    for (const name of COMMANDS) expect(help).toMatch(new RegExp(`\\n  ${name}\\b`))
    for (const flag of ['--home <dir>', '--json', '--verbose']) expect(help).toContain(flag)
  })

  it('buildProgram exposes the same command tree without running it', () => {
    const program = buildProgram(memoryIo({}), () => undefined)
    expect(program.commands.map((command) => command.name())).toEqual(COMMANDS)
  })

  it('routes to the hub-side commands', async () => {
    const io = memoryIo({})
    expect(await main(['version', '--json'], io)).toBe(0)
    expect(JSON.parse(io.out.join('')).protocol).toBe('agent-peers/0.3')
    const hub = memoryIo({})
    expect(await main(['hub', '--help'], hub)).toBe(0)
    expect(hub.out.join('')).toContain('rotate-admin-token')
  })
})
