import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { PeersError } from '@agent-peers/protocol'
import { Command } from 'commander'
import { versionCommand } from '../src/commands/version'
import { EXIT, exitCodeFor, renderError, usageError } from '../src/errors'
import { globalsOf, homeFlag, peersHomeOf, userHomeOf, withHome } from '../src/globals'
import { commandName, earlyFlags, runRoot } from '../src/root'
import { CLI_VERSION } from '../src/version'
import { hubMain, runCli } from './helpers/hub-cli'
import { memoryIo } from './helpers/world'

describe('root command', () => {
  it('prints help with the global flags and the hub commands', async () => {
    const result = await runCli(['--help'], {})
    expect(result.code).toBe(0)
    for (const text of [
      '--home <dir>',
      '--json',
      '--verbose',
      'hub [options]',
      'invite',
      'rooms',
      'version',
    ]) {
      expect(result.out).toContain(text)
    }
    const hubHelp = await runCli(['hub', 'service', 'install', '--help'], {})
    expect(hubHelp.code).toBe(0)
    expect(hubHelp.out).toContain('Usage: agent-peers hub service install')
  })

  it('prints versions, as text or JSON', async () => {
    expect((await runCli(['--version'], {})).out).toBe(`${CLI_VERSION}\n`)
    const text = await runCli(['version'], {})
    expect(text.out).toContain(`agent-peers ${CLI_VERSION}\nprotocol    agent-peers/0.3\nruntime     bun `)
    const json = JSON.parse((await runCli(['version', '--json'], {})).out)
    expect(json).toMatchObject({ cli: CLI_VERSION, protocol: 'agent-peers/0.3' })
  })

  it('exits 2 (usage) for unknown commands, options and invalid arguments', async () => {
    const unknown = await runCli(['teleport'], {})
    expect(unknown.code).toBe(EXIT.usage)
    expect(unknown.err).toContain("unknown command 'teleport'")
    expect((await runCli(['rooms', '--bogus'], {})).code).toBe(EXIT.usage)
    expect((await runCli(['hub', '--port', 'abc'], {})).code).toBe(EXIT.usage)
  })

  it('renders parse errors as the JSON error envelope under --json', async () => {
    const result = await runCli(['--json', 'rooms', '--bogus'], {})
    expect(result.code).toBe(EXIT.usage)
    expect(result.err).toBe('')
    expect(JSON.parse(result.out)).toEqual({
      error: { code: 'invalid_params', message: "unknown option '--bogus'" },
    })
    const port = await runCli(['hub', '--port', 'abc', '--json'], {})
    expect(JSON.parse(port.out).error.code).toBe('invalid_params')
  })

  it('keeps commander exit code 1 for a hook (exit 2 would wake the agent)', async () => {
    expect((await runCli(['hook', 'stop', '--bogus'], {})).code).toBe(1)
    expect(commandName(['--home', 'h', '--json', 'hook', 'x'])).toBe('hook')
    expect(commandName(['--', 'hook'])).toBeUndefined()
    expect(commandName(['--json'])).toBeUndefined()
  })

  it('renders errors thrown by a command with their code', async () => {
    const boom = (message: unknown) =>
      new Command('boom').action(() => {
        throw message
      })
    const io = memoryIo({})
    expect(await runRoot(['boom'], io, () => [boom(new PeersError('forbidden', 'nope'))])).toBe(EXIT.auth)
    expect(io.err.join('')).toBe('agent-peers: nope [forbidden]\n')
    const json = memoryIo({})
    expect(await runRoot(['boom', '--json'], json, () => [boom(new Error('raw'))])).toBe(1)
    expect(JSON.parse(json.out.join(''))).toEqual({ error: { code: 'internal', message: 'raw' } })
    const verbose = memoryIo({})
    await runRoot(['--verbose', 'boom'], verbose, () => [boom('text')])
    expect(verbose.err.join('')).toContain('agent-peers: text [internal]\nPeersError: text')
  })

  it('scopes the env with --home before building the commands', async () => {
    const seen: string[] = []
    const probe = (io: { env: Record<string, string | undefined> }) =>
      new Command('probe').action(() => {
        seen.push(io.env.AGENT_PEERS_HOME ?? '')
      })
    await runRoot(['--home', 'rel/home', 'probe'], memoryIo({}), (io) => [probe(io)])
    await runRoot(['probe', '--home=/abs'], memoryIo({}), (io) => [probe(io)])
    expect(seen).toEqual([join(process.cwd(), 'rel/home'), '/abs'])
  })

  it('passes globals to commands', async () => {
    let globals = {}
    const probe = new Command('probe').action((_o: unknown, self: Command) => {
      globals = globalsOf(self)
    })
    await runRoot(['--json', 'probe', '--verbose', '--home', '/h'], memoryIo({}), () => [probe])
    expect(globals).toEqual({ home: '/h', json: true, verbose: true })
    expect(await hubMain(['version'], memoryIo({}))).toBe(0)
    expect(await runRoot(['version'], memoryIo({}), (io, setExit) => [versionCommand(io, setExit)])).toBe(0)
  })
})

describe('globals and errors', () => {
  it('finds --home up to the -- separator', () => {
    expect(homeFlag(['--home', 'a', 'x', '--home=b'])).toBe('b')
    expect(homeFlag(['--', '--home', 'a'])).toBeUndefined()
    expect(homeFlag(['--home'])).toBeUndefined()
    expect(homeFlag(['--home', ' '])).toBeUndefined()
    const io = memoryIo({ HOME: '/u' })
    expect(withHome(io, undefined)).toBe(io)
    expect(userHomeOf(io)).toBe('/u')
    expect(peersHomeOf(io)).toBe('/u/.agent-peers')
    expect(peersHomeOf(withHome(io, '/p'))).toBe('/p')
    expect(earlyFlags(['a', '--', '--json'])).toEqual({ json: false, verbose: false })
  })

  it('maps error codes to exit codes', () => {
    expect(exitCodeFor(usageError('x'))).toBe(EXIT.usage)
    expect(exitCodeFor(new PeersError('invalid_name'))).toBe(EXIT.usage)
    expect(exitCodeFor(new PeersError('not_connected'))).toBe(EXIT.unreachable)
    expect(exitCodeFor(new PeersError('timeout'))).toBe(EXIT.unreachable)
    expect(exitCodeFor(new PeersError('unauthorized'))).toBe(EXIT.auth)
    expect(exitCodeFor(new PeersError('room_not_found'))).toBe(EXIT.failure)
    const io = memoryIo({})
    expect(renderError(io, new PeersError('timeout', 'slow'))).toBe(4)
    expect(io.err).toEqual(['agent-peers: slow [timeout]\n'])
  })
})
