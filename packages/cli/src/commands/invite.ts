/**
 * `agent-peers invite [room] [--new|--close|--reopen] [--lang en|zh] [--create]` on the hub host
 * (PROTOCOL §8, §10.1, ONBOARDING §1): prints the room's join prompt, rotates, closes or reopens its
 * single invite through the local admin API.
 */
import { DEFAULT_ROOM } from '@agent-peers/hub'
import { type Command, Command as CommanderCommand, Option } from 'commander'
import { renderError, usageError } from '../errors'
import { type GlobalOptions, globalsOf, peersHomeOf } from '../globals'
import type { CliIo } from '../io'
import {
  type AdminClient,
  type AdminClientDeps,
  createAdminClient,
  resolveAdminTarget,
  stringField,
} from './admin-client'
import { type AdminRoomRow, createRoom, findRoom, listInvites, listRooms } from './admin-rooms'
import { addDataDirOption, resolveDataDir } from './hub-options'

export const INVITE_LANGS = ['en', 'zh'] as const
export type InviteLangOption = (typeof INVITE_LANGS)[number]

export interface InviteOptions {
  readonly new?: boolean
  readonly close?: boolean
  readonly reopen?: boolean
  readonly create?: boolean
  readonly lang?: InviteLangOption
  readonly dataDir?: string
  readonly adminUrl?: string
}

export type InviteAction = 'show' | 'new' | 'close' | 'reopen'

export interface InviteResult {
  readonly room: string
  readonly room_id: string
  readonly action: InviteAction
  readonly invite_url?: string
  readonly join_prompt?: string
  readonly join_command?: string
  readonly closed?: boolean
}

export function inviteAction(options: InviteOptions): InviteAction {
  const chosen = (['new', 'close', 'reopen'] as const).filter((flag) => options[flag] === true)
  if (chosen.length > 1) throw usageError('use only one of --new, --close and --reopen')
  return chosen[0] ?? 'show'
}

async function activeInviteId(client: AdminClient, roomId: string): Promise<string | undefined> {
  return (await listInvites(client)).find((invite) => invite.room_id === roomId)?.invite_id
}

async function renderInvite(
  client: AdminClient,
  room: AdminRoomRow,
  action: InviteAction,
  lang: InviteLangOption | undefined,
): Promise<InviteResult> {
  const body = lang === undefined ? {} : { lang }
  const rendered = await client.request('POST', `/v0/admin/rooms/${room.room_id}/invites`, body)
  return {
    room: room.name,
    room_id: room.room_id,
    action,
    invite_url: stringField(rendered, 'invite_url'),
    join_prompt: stringField(rendered, 'join_prompt'),
    join_command: stringField(rendered, 'join_command'),
  }
}

async function resolveRoom(client: AdminClient, ref: string, create: boolean): Promise<AdminRoomRow> {
  const rooms = await listRooms(client)
  try {
    return findRoom(rooms, ref)
  } catch (error) {
    if (!create) throw error
    return createRoom(client, ref)
  }
}

/** Performs the invite action against the admin API. */
export async function inviteWith(
  client: AdminClient,
  roomRef: string,
  options: InviteOptions,
): Promise<InviteResult> {
  const action = inviteAction(options)
  const room = await resolveRoom(client, roomRef, options.create === true)
  if (action === 'close' || action === 'new') {
    const active = await activeInviteId(client, room.room_id)
    if (active !== undefined) await client.request('DELETE', `/v0/admin/invites/${active}`)
    if (action === 'close')
      return { room: room.name, room_id: room.room_id, action, closed: active !== undefined }
  }
  return renderInvite(client, room, action, options.lang)
}

export function inviteLines(result: InviteResult): readonly string[] {
  if (result.action === 'close') {
    return [
      result.closed
        ? `closed the invite to "${result.room}": its code no longer works.`
        : `invites to "${result.room}" were already closed.`,
      `reopen with: agent-peers invite ${result.room} --reopen`,
    ]
  }
  const note =
    result.action === 'new'
      ? ['new invite minted: the previous code no longer works.']
      : result.action === 'reopen'
        ? ['the invite is open.']
        : []
  return [
    ...note,
    `room "${result.room}": ${result.invite_url}`,
    '',
    "paste this join prompt into a teammate's agent:",
    '',
    result.join_prompt ?? '',
  ]
}

export type AdminCommandDeps = AdminClientDeps

/** The data dir the admin commands read (`--data-dir`, else `<home>/hub`). */
export function adminDataDir(io: CliIo, dataDir: string | undefined): string {
  return resolveDataDir(peersHomeOf(io), dataDir)
}

export async function runInvite(
  roomRef: string | undefined,
  options: InviteOptions,
  io: CliIo,
  deps: AdminCommandDeps = {},
  globals: GlobalOptions = {},
): Promise<number> {
  try {
    inviteAction(options)
    const dataDir = adminDataDir(io, options.dataDir)
    const client = createAdminClient(await resolveAdminTarget(dataDir, options.adminUrl), deps)
    const result = await inviteWith(client, roomRef ?? DEFAULT_ROOM, options)
    io.stdout(globals.json ? `${JSON.stringify(result)}\n` : `${inviteLines(result).join('\n')}\n`)
    return 0
  } catch (error) {
    return renderError(io, error, globals)
  }
}

export function addAdminUrlOption(command: Command): Command {
  return command.option(
    '--admin-url <url>',
    'admin listener (default: from <data-dir>/hub.json, else 127.0.0.1:7338)',
  )
}

export function inviteCommand(
  io: CliIo,
  setExit: (code: number) => void,
  deps: AdminCommandDeps = {},
): Command {
  const command = new CommanderCommand('invite')
    .description("print a room's join prompt; rotate, close or reopen its invite (run on the hub host)")
    .argument('[room]', `room name or id (default "${DEFAULT_ROOM}")`)
    .option('--new', 'replace the invite with a new code (the old one stops working)')
    .option('--close', 'close the invite (nobody new can join)')
    .option('--reopen', 'reopen a closed invite')
    .option('--create', 'create the room first if it does not exist')
    .addOption(new Option('--lang <lang>', 'join prompt language').choices(INVITE_LANGS))
  return addAdminUrlOption(addDataDirOption(command)).action(
    async (room: string | undefined, options: InviteOptions, self: Command) => {
      setExit(await runInvite(room, options, io, deps, globalsOf(self)))
    },
  )
}
