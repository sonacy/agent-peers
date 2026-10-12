/**
 * The hero's room action (DASHBOARD §4.3): 解散房间 (owner, confirm by typing the name) or 退出房间
 * (member). Wide screens show it as a danger-outline button; phones tuck it into a ⋯ bottom sheet.
 */
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'
import type { RoomDetail } from '../../../api/types'
import { Button } from '../../ui/button'
import { Sheet, SheetActions, SheetClose, SheetContent, SheetDescription, SheetTitle } from '../../ui/sheet'
import { useDissolveRoom, useExitRoom } from '../data/use-room-lifecycle'
import { roomTitle } from '../model/rooms-model'
import { DissolveDialog, LeaveDialog } from './confirm-dialogs'

export interface HeroActionProps {
  readonly detail: RoomDetail
  /** Where to go after leaving or dissolving. */
  readonly onGone: () => void
  /** Phones: a ⋯ button that opens a bottom sheet with the action. */
  readonly menu?: boolean
}

function actionLabel(detail: RoomDetail): string {
  return detail.my_role === 'owner' ? '解散房间' : '退出房间'
}

/** The confirm dialog for the room action, owned by whichever trigger opened it. */
function ActionDialog({
  detail,
  onGone,
  open,
  onOpenChange,
}: Pick<HeroActionProps, 'detail' | 'onGone'> & {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const dissolve = useDissolveRoom(onGone)
  const exit = useExitRoom(onGone)
  const ref = { roomId: detail.room.room_id, name: roomTitle(detail.room) }
  if (detail.my_role === 'owner') {
    return (
      <DissolveDialog
        open={open}
        onOpenChange={onOpenChange}
        roomName={detail.room.name}
        onConfirm={() => dissolve.mutate(ref)}
      />
    )
  }
  return (
    <LeaveDialog
      open={open}
      onOpenChange={onOpenChange}
      roomName={ref.name}
      onConfirm={() => exit.mutate(ref)}
    />
  )
}

function HeroMenu({ detail, onGone }: Pick<HeroActionProps, 'detail' | 'onGone'>) {
  const [sheet, setSheet] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const label = actionLabel(detail)
  const name = roomTitle(detail.room)
  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label={`管理房间 ${name}`} onClick={() => setSheet(true)}>
        <Ellipsis aria-hidden="true" />
      </Button>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent>
          <SheetTitle>管理房间 {name}</SheetTitle>
          <SheetDescription>
            {detail.my_role === 'owner'
              ? '解散后房间里的人和 agent 都会被请出，邀请全部失效。'
              : '退出后你的 agent 都会离开这个房间，想回来要新的邀请或敲门。'}
          </SheetDescription>
          <SheetActions>
            <Button
              variant="danger-outline"
              className="bg-danger-soft"
              onClick={() => {
                setSheet(false)
                setConfirm(true)
              }}
            >
              {label}
            </Button>
            <SheetClose asChild>
              <Button variant="ghost" className="bg-surface-2">
                取消
              </Button>
            </SheetClose>
          </SheetActions>
        </SheetContent>
      </Sheet>
      <ActionDialog detail={detail} onGone={onGone} open={confirm} onOpenChange={setConfirm} />
    </>
  )
}

export function HeroAction({ detail, onGone, menu = false }: HeroActionProps) {
  const [open, setOpen] = useState(false)
  if (menu) return <HeroMenu detail={detail} onGone={onGone} />
  return (
    <>
      <Button size="sm" variant="danger-outline" onClick={() => setOpen(true)}>
        {actionLabel(detail)}
      </Button>
      <ActionDialog detail={detail} onGone={onGone} open={open} onOpenChange={setOpen} />
    </>
  )
}
