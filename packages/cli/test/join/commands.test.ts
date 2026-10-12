import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Command } from 'commander'
import { askCommand } from '../../src/commands/ask'
import { dashboardCommand } from '../../src/commands/dashboard'
import { inboxCommand } from '../../src/commands/inbox'
import { joinCommand } from '../../src/commands/join'
import { knockCommand } from '../../src/commands/knock'
import { leaveCommand } from '../../src/commands/leave'
import { renameCommand } from '../../src/commands/rename'
import { sayCommand } from '../../src/commands/say'
import { statusCommand } from '../../src/commands/status'
import { whoCommand } from '../../src/commands/who'
import { main } from '../../src/program'
import { installFakeClaude } from '../helpers/fake-agents'
import { type JoinWorld, output, roomTexts, startJoinWorld } from '../helpers/join-world'

let w: JoinWorld
beforeEach(async () => {
  w = await startJoinWorld()
  await installFakeClaude(w.m)
})
afterEach(async () => {
  await w.stop()
})

const AGENT = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-bob' }

/** Parses `argv` through the real commander definitions, with the test seams. */
async function cli(argv: readonly string[]) {
  const io = w.io(AGENT)
  let code: number | undefined = 0
  const setExit = (value: number | undefined) => {
    code = value
  }
  const deps = w.deps({ openUrl: async () => true })
  const root = new Command('agent-peers').exitOverride().configureOutput({
    writeOut: (text) => io.stdout(text),
    writeErr: (text) => io.stderr(text),
  })
  for (const factory of [
    joinCommand,
    whoCommand,
    askCommand,
    sayCommand,
    inboxCommand,
    renameCommand,
    statusCommand,
    leaveCommand,
    knockCommand,
    dashboardCommand,
  ])
    root.addCommand(factory(io, setExit, deps).copyInheritedSettings(root))
  try {
    await root.parseAsync([...argv], { from: 'user' })
  } catch (error) {
    code = (error as { exitCode?: number }).exitCode ?? 1
  }
  return { code, ...output(io) }
}

it('every command parses its flags and runs', async () => {
  const joined = await cli(['join', w.inviteUrl, '--here', '--remember', 'workspace', '-y'])
  expect(joined.code).toBe(0)
  expect((await cli(['join', w.inviteUrl, '--remember', 'forever'])).code).not.toBe(0)
  expect((await cli(['who', 'payments', '--hub', w.url])).out).toContain('#payments')
  expect((await cli(['ask', '@alice', 'hi', 'there', '--write'])).out).toContain('to @alice in #payments')
  expect((await cli(['ask', '@alice', 'q', '--wait', '0.1'])).out).toContain('pending')
  expect((await cli(['ask', '@alice', 'q', '--wait', 'soon'])).code).not.toBe(0)
  expect((await cli(['say', 'hello', 'all', '--room', 'payments'])).code).toBe(0)
  expect(await roomTexts(w)).toContain('hello all')
  expect((await cli(['inbox', '--room', 'payments', '--peek'])).code).toBe(0)
  expect((await cli(['rename', 'new', 'title'])).out).toContain('title: new title')
  expect((await cli(['rename', '--handle', 'api', '--room', 'payments'])).out).toContain('is now @api')
  expect((await cli(['status', 'busy', 'here', '--dnd'])).out).toContain('do not disturb')
  expect((await cli(['status', '--open'])).out).toContain('accepting asks')
  expect((await cli(['knock', 'nope', 'note'])).code).toBe(1)
  expect((await cli(['dashboard'])).out).toContain('opened')
  expect((await cli(['leave', 'payments'])).out).toContain('left #payments')
})

it('the program mounts join and the shell commands', async () => {
  const io = w.io({})
  expect(await main(['join', '--help'], io)).toBe(0)
  expect(io.out.join('')).toContain('--remember <scope>')
})
