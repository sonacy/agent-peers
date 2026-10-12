/**
 * Room detail mutations (DASHBOARD §4.3): ⇥ 移出房间, 请出房间, 恢复, 开门 / 先不了 / 全部开门, and the
 * invite buttons. Each patches the room cache at once and rolls back with a toast if the hub refuses.
 */
import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../../../api/context'
import { queryKeys } from '../../../api/keys'
import type { InviteAction, Knock, MyRoom, RoomDetail } from '../../../api/types'
import { type BulkOutcome, bulkOutcome, settleBounded } from '../../../lib/settle-bounded'
import { type CachePatch, patchOf, useOptimistic } from './optimistic'
import {
  withFewerKnocks,
  withInvite,
  withInviteClosed,
  withKicked,
  withoutAgent,
  withoutKicked,
  withoutKnocks,
} from './room-cache'

const detailPatch = (roomId: string, update: (detail: RoomDetail) => RoomDetail): CachePatch =>
  patchOf<RoomDetail>(queryKeys.room(roomId), update)

const roomAndList = (roomId: string): readonly QueryKey[] => [queryKeys.room(roomId), queryKeys.rooms]

export interface Person {
  readonly memberId: string
  readonly name: string
}

/** ⇥ 移出房间: releases the agent's handle, keeps the person's grant. */
export function useRemoveAgent(roomId: string) {
  const api = useApi()
  return useOptimistic({
    mutationFn: (sessionId: string) => api.removeSession(roomId, sessionId),
    patches: (sessionId) => [detailPatch(roomId, (d) => withoutAgent(d, sessionId))],
    refetch: () => [...roomAndList(roomId), queryKeys.sessions],
    errorTitle: '没移出去',
  })
}

/** Bulk actions send at most this many requests at once (the hub rate-limits requests). */
export const BULK_CONCURRENCY = 4

export interface RemoveAllVars extends Person {
  readonly sessionIds: readonly string[]
}

/**
 * 把他的 agent 全部移出: one request per agent, a few at a time. If only some go through, those stay
 * removed and the toast says how many didn't; if none do, everything rolls back.
 */
export function useRemoveAllAgents(roomId: string) {
  const api = useApi()
  return useOptimistic({
    mutationFn: async ({ sessionIds }: RemoveAllVars): Promise<BulkOutcome<string>> =>
      bulkOutcome(
        sessionIds,
        await settleBounded(sessionIds, BULK_CONCURRENCY, (id) => api.removeSession(roomId, id)),
      ),
    patches: ({ sessionIds }) => [
      detailPatch(roomId, (d) => sessionIds.reduce((detail, id) => withoutAgent(detail, id), d)),
    ],
    refetch: () => [...roomAndList(roomId), queryKeys.sessions],
    errorTitle: '没全部移出去',
    successToast: (_r, { name }) => `${name} 的 agent 都移出去了`,
    partial: (result, vars) =>
      result.failed === 0
        ? undefined
        : {
            applied: { ...vars, sessionIds: result.done },
            title: `移出了 ${result.done.length} 个，${result.failed} 个没移出去`,
            reason: result.reason,
          },
  })
}

/** 请出房间: revokes the grant; they can't use the invite to come back (the hub rotates it). */
export function useKickPerson(roomId: string) {
  const api = useApi()
  return useOptimistic({
    mutationFn: ({ memberId }: Person) => api.kickMember(roomId, memberId),
    patches: ({ memberId }) => [detailPatch(roomId, (d) => withKicked(d, memberId, Date.now()))],
    refetch: () => roomAndList(roomId),
    errorTitle: '没请出去',
    successToast: (_r, { name }) => `已请 ${name} 出房间，邀请码换新了，要拉人记得重新复制邀请`,
  })
}

/** 恢复: re-grants member access to someone who was removed. */
export function useRestorePerson(roomId: string) {
  const api = useApi()
  return useOptimistic({
    mutationFn: ({ memberId }: Person) => api.restoreMember(roomId, memberId),
    patches: ({ memberId }) => [detailPatch(roomId, (d) => withoutKicked(d, memberId))],
    refetch: () => roomAndList(roomId),
    errorTitle: '没恢复成',
    successToast: (_r, { name }) => `${name} 可以回来了`,
  })
}

export interface DecideVars {
  readonly knocks: readonly Knock[]
  readonly decision: 'accept' | 'decline'
}

function decidePatches(roomId: string, { knocks }: DecideVars): readonly CachePatch[] {
  const ids = new Set(knocks.map((k) => k.knock_id))
  return [
    detailPatch(roomId, (d) => withoutKnocks(d, ids)),
    patchOf<readonly MyRoom[]>(queryKeys.rooms, (list) => withFewerKnocks(list, roomId, ids.size) ?? list),
  ]
}

function decideToast({ knocks, decision }: DecideVars): string | undefined {
  if (decision === 'decline') return undefined
  const first = knocks[0]
  return knocks.length === 1 && first !== undefined
    ? `已开门，${first.member} 进来了`
    : `已开门，${knocks.length} 个人进来了`
}

function partialDecideTitle({ done, failed }: BulkOutcome<Knock>, decision: DecideVars['decision']): string {
  const verb = decision === 'accept' ? '已开门' : '已拒绝'
  return `${verb} ${done.length} 个，${failed} 个没成功`
}

/**
 * 开门 / 先不了 for one knock, or 全部开门 for many (a few requests at a time). A partial failure
 * keeps the knocks that went through and says how many didn't; the refetch brings the rest back.
 */
export function useDecideKnocks(roomId: string) {
  const api = useApi()
  return useOptimistic({
    mutationFn: async ({ knocks, decision }: DecideVars): Promise<BulkOutcome<Knock>> =>
      bulkOutcome(
        knocks,
        await settleBounded(knocks, BULK_CONCURRENCY, (k) => api.decideKnock(k.knock_id, decision)),
      ),
    patches: (vars) => decidePatches(roomId, vars),
    refetch: () => roomAndList(roomId),
    errorTitle: '门没开成',
    successToast: (_r, vars) => decideToast(vars),
    partial: (result, vars) =>
      result.failed === 0
        ? undefined
        : {
            applied: { ...vars, knocks: result.done },
            title: partialDecideTitle(result, vars.decision),
            reason: result.reason,
          },
  })
}

const INVITE_ERROR: Readonly<Record<InviteAction, string>> = {
  rotate: '没换成邀请码',
  close: '邀请没关上',
  reopen: '邀请没重新开启',
}

const INVITE_DONE: Readonly<Record<InviteAction, string>> = {
  rotate: '换好了，旧邀请码失效了',
  close: '邀请已关闭',
  reopen: '邀请重新开启了',
}

/** 换一个邀请码 / 关闭邀请 / 重新开启: the hub's answer replaces the invite in the cache at once. */
export function useInviteAction(roomId: string, action: InviteAction) {
  const api = useApi()
  const client = useQueryClient()
  return useOptimistic({
    mutationFn: () => api.inviteAction(roomId, action),
    patches: () => (action === 'close' ? [detailPatch(roomId, withInviteClosed)] : []),
    refetch: () => [queryKeys.room(roomId)],
    errorTitle: INVITE_ERROR[action],
    successToast: () => INVITE_DONE[action],
    onSuccess: (result) => {
      const detail = client.getQueryData<RoomDetail>(queryKeys.room(roomId))
      if (detail !== undefined) {
        client.setQueryData(queryKeys.room(roomId), withInvite(detail, result.invite, result.join_prompt))
      }
    },
  })
}
