/**
 * Codex CLI (plugin `peers`, `--surface codex`): `mcp_tool` hooks call peers_hook; tools/call carry
 * `_meta["x-codex-turn-metadata"].thread_id`; an idle thread is woken with `codex queue` (a fake CLI
 * here), and UserPromptSubmit / Stop deliver what the queue could not.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { CodexAgent, DesktopAgent } from './support/agents'
import { codexSteps } from './support/codex-steps'
import { askState } from './support/flows'
import { runLifecycle } from './support/lifecycle'
import { eventually } from './support/wait'
import { cardFor, createWorld, joinRoom, seenAs, type World } from './support/world'

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

async function codexAndAsker(w: World) {
  const asker = (await w.agent(await w.machine('asker'), 'claude-desktop')) as DesktopAgent
  await joinRoom(asker, w, 'asker')
  const machine = await w.machine('box')
  const codex = (await w.agent(machine, 'codex', { key: 'thread-1' })) as CodexAgent
  await codex.start()
  await joinRoom(codex, w, 'box')
  return { asker, codex }
}

async function ask(asker: DesktopAgent, question: string): Promise<string> {
  const out = await asker.ok('peers_ask', { target: '@box', question, wait_seconds: 1 })
  return String(out.structured?.ask_id)
}

describe('e2e: Codex CLI lifecycle', () => {
  it('start → join → ask via codex queue → reply → rename → offline → resume → queued ask via UserPromptSubmit → close', async () => {
    world = await createWorld()
    await runLifecycle(world, 'codex', { steps: codexSteps })
  }, 120_000)

  it('a busy thread gets its ask at Stop (decision: block), never through the queue', async () => {
    world = await createWorld()
    const { asker, codex } = await codexAndAsker(world)
    await codex.prompt('implement the feature')
    const askId = await ask(asker, 'quick question while you work?')
    await Bun.sleep(500)
    expect(await codex.machine.queueCalls()).toEqual([])
    expect((await world.hub.ask(world.room.roomId, askId))?.ask?.state).not.toBe('working')
    const stop = await codex.endTurn('feature done')
    expect(stop.decision).toBe('block')
    expect(String(stop.reason)).toContain(`ask_id ${askId}`)
    await askState(world, askId, 'working')
    await codex.ok('peers_reply', { ask_id: askId, text: 'answered at the turn boundary' })
    expect(await codex.endTurn('answered')).toEqual({})
    await askState(world, askId, 'answered')
    expect(await codex.machine.queueCalls()).toEqual([])
  }, 120_000)

  it('a failing `codex queue` falls back to UserPromptSubmit and drops the card to boundary', async () => {
    world = await createWorld()
    const { asker, codex } = await codexAndAsker(world)
    await codex.machine.failQueue(true)
    const askId = await ask(asker, 'is the queue down?')
    const card = await eventually('the card to drop to boundary', async () => {
      const c = await cardFor(world as World, 'box')
      return c.inject === 'boundary' ? c : undefined
    })
    expect(card.connection).toBe('online')
    expect(codex.bridge.stderr()).toContain('holding envelopes for hooks')
    const context = await codex.prompt('next request')
    expect(context).toContain(`ask_id ${askId}`)
    await codex.ok('peers_reply', { ask_id: askId, text: 'yes, delivered by the prompt hook' })
    await codex.endTurn('answered')
    await askState(world, askId, 'answered')
  }, 120_000)

  it('a new thread in the remembered workspace auto-joins and takes over queued asks', async () => {
    world = await createWorld()
    const { asker, codex } = await codexAndAsker(world)
    // The first join happened before any hook told the bridge the thread's cwd, so it could only
    // remember the session. Now that hooks reported it, remember the workspace (same room, same handle).
    const again = await codex.ok('peers_join', {
      invite: world.room.name,
      handle: 'box',
      remember: 'workspace',
    })
    expect(again.text).toContain(`future sessions in ${codex.machine.workspace} will auto-join @box`)
    const entry = (await codex.machine.autojoin()).find((e) => e.scope === 'workspace')
    expect(entry).toMatchObject({ scope: 'workspace', workspace: codex.machine.workspace, handle: 'box' })
    const mark = world.watcher.mark()
    await codex.close()
    await seenAs(world, 'box', 'offline', mark)
    const askId = await ask(asker, 'for whoever is @box next')

    // Next day: a new Codex process, a new thread in the same workspace.
    const next = (await world.agent(codex.machine, 'codex', { key: 'thread-2' })) as CodexAgent
    await next.start()
    const card = await cardFor(world, 'box')
    expect(card.connection).toBe('online')
    const context = await next.prompt('good morning')
    expect(context).toContain(`ask_id ${askId}`)
    await next.ok('peers_reply', { ask_id: askId, text: 'the new thread answers' })
    await next.endTurn('answered')
    await askState(world, askId, 'answered')
    const who = await next.ok('peers_who')
    expect(who.text).toContain('this session: thread-2')
  }, 120_000)
})
