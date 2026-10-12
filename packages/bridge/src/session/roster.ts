/** Cached cards of the sessions in this session's rooms, from `peers.list` and `presence.changed`. */
import type { DeepReadonly, EnvelopeSender, SessionCard } from '@agent-peers/protocol'

type Card = DeepReadonly<SessionCard>

const key = (roomId: string, handle: string): string => `${roomId}\u0000${handle}`

export interface RosterMember {
  readonly room_id: string
  readonly handle: string
  readonly card: Card
}

export class Roster {
  private cards: ReadonlyMap<string, Card> = new Map()
  private names: ReadonlyMap<string, string> = new Map()

  set(roomId: string, handle: string, card: Card): void {
    this.cards = new Map(this.cards).set(key(roomId, handle), card)
  }

  setAll(members: readonly RosterMember[]): void {
    const next = new Map(this.cards)
    for (const m of members) next.set(key(m.room_id, m.handle), m.card)
    this.cards = next
  }

  card(roomId: string, handle: string): Card | undefined {
    return this.cards.get(key(roomId, handle))
  }

  setRoomName(roomId: string, name: string): void {
    if (this.names.get(roomId) === name) return
    this.names = new Map(this.names).set(roomId, name)
  }

  roomName(roomId: string): string | undefined {
    return this.names.get(roomId)
  }

  /** Envelope header details for a sender (PROTOCOL §7.2: member · agent · model). */
  sender(roomId: string, handle: string | undefined, member: string | undefined): EnvelopeSender {
    const card = handle === undefined ? undefined : this.card(roomId, handle)
    return {
      ...(member ? { member } : card ? { member: card.member } : {}),
      ...(card ? { agent: card.agent.kind } : {}),
      ...(card?.model ? { model: card.model } : {}),
    }
  }
}
