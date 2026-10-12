/** Hub → bridge notifications (§6.4). Every one carries `session_id`. */
import { z } from 'zod'
import { SessionCardSchema } from './card'
import { AskFailReasonSchema, AskStateSchema, MessageSchema } from './message'
import { KnockStateSchema } from './room'
import { IdSchema, NameSchema, SeqSchema } from './schema-util'
import type { DeepReadonly } from './types'

const scoped = <T extends z.ZodRawShape>(shape: T) => z.object({ session_id: IdSchema, ...shape })

/** Who caused a change: a member, handle or session id, or an object naming them. */
export const ActorSchema = z.union([
  z.string().max(128),
  z.object({
    member: z.string().optional(),
    handle: z.string().optional(),
    session_id: z.string().optional(),
    role: z.string().optional(),
  }),
])

export const ROOM_REMOVED_REASONS = ['removed', 'kicked', 'dissolved'] as const
export const RoomRemovedReasonSchema = z.enum(ROOM_REMOVED_REASONS)
export type RoomRemovedReason = z.infer<typeof RoomRemovedReasonSchema>

export const NOTIFICATIONS = {
  'msg.new': scoped({ message: MessageSchema, replay: z.boolean().optional() }),
  'replay.done': scoped({ room_id: IdSchema, head_seq: SeqSchema }),
  'ask.updated': scoped({ ask_id: IdSchema, state: AskStateSchema, reason: AskFailReasonSchema.optional() }),
  'presence.changed': scoped({ room_id: IdSchema, handle: NameSchema, card: SessionCardSchema }),
  'handle.lost': scoped({
    room_id: IdSchema,
    handle: NameSchema,
    by: ActorSchema.optional(),
    ask_ids: z.array(IdSchema).default([]),
  }),
  'handle.renamed': scoped({
    room_id: IdSchema,
    old: NameSchema,
    new: NameSchema,
    by: ActorSchema.optional(),
  }),
  /** The owning member changed the session from the dashboard; it overrides the bridge's own value. */
  'session.patched': scoped({ accepting: z.boolean().optional(), title: z.string().optional() }),
  /** Sent to the knocking member's sessions. */
  'knock.updated': scoped({ knock_id: IdSchema, room_id: IdSchema, state: KnockStateSchema }),
  /** This session was removed from the room. */
  'room.removed': scoped({ room_id: IdSchema, reason: RoomRemovedReasonSchema }),
  'room.closed': scoped({ room_id: IdSchema.optional() }),
  kicked: scoped({ room_id: IdSchema, reason: z.string().max(256).optional() }),
} as const

export type NotificationName = keyof typeof NOTIFICATIONS
export const NOTIFICATION_NAMES = Object.keys(NOTIFICATIONS) as readonly NotificationName[]
export type NotificationOf<N extends NotificationName> = DeepReadonly<z.output<(typeof NOTIFICATIONS)[N]>>
/** What a hub passes when it sends one. */
export type NotificationInputOf<N extends NotificationName> = DeepReadonly<z.input<(typeof NOTIFICATIONS)[N]>>
export type NotificationMap = { [N in NotificationName]: NotificationOf<N> }

export function isNotificationName(name: unknown): name is NotificationName {
  return typeof name === 'string' && Object.hasOwn(NOTIFICATIONS, name)
}

export type ParsedNotification =
  | { readonly ok: true; readonly name: NotificationName; readonly params: NotificationOf<NotificationName> }
  /** §11: unknown notifications are ignored, so `unknown` is not an error. */
  | { readonly ok: false; readonly reason: 'unknown' | 'invalid'; readonly message: string }

export function parseNotification(name: string, params: unknown): ParsedNotification {
  if (!isNotificationName(name))
    return { ok: false, reason: 'unknown', message: `unknown notification ${name}` }
  const parsed = NOTIFICATIONS[name].safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', message: `invalid ${name} notification: ${parsed.error.message}` }
  }
  return { ok: true, name, params: parsed.data as NotificationOf<NotificationName> }
}
