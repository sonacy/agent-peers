/** Phone person sheet (DASHBOARD §4.3): 管理 {name} → remove all their agents, kick, or cancel. */
import type { RoomPerson } from '../../../api/types'
import { useStale } from '../../../live/live-provider'
import { StaleHint } from '../../error-banner'
import { Button } from '../../ui/button'
import { Sheet, SheetActions, SheetClose, SheetContent, SheetDescription, SheetTitle } from '../../ui/sheet'

export interface PersonSheetProps {
  readonly person: RoomPerson | undefined
  readonly onClose: () => void
  readonly onRemoveAll: (person: RoomPerson) => void
  readonly onKick: (person: RoomPerson) => void
}

export function PersonSheet({ person, onClose, onRemoveAll, onKick }: PersonSheetProps) {
  const stale = useStale()
  const run = (action: (p: RoomPerson) => void) => () => {
    if (person !== undefined) action(person)
    onClose()
  }
  return (
    <Sheet
      open={person !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent>
        <SheetTitle>管理 {person?.member}</SheetTitle>
        <SheetDescription>他在这个房间有 {person?.agents.length ?? 0} 个 agent。</SheetDescription>
        <StaleHint stale={stale} />
        <SheetActions>
          <Button onClick={run(onRemoveAll)} disabled={stale || (person?.agents.length ?? 0) === 0}>
            把他的 agent 全部移出
          </Button>
          <Button variant="danger-outline" className="bg-danger-soft" onClick={run(onKick)} disabled={stale}>
            请出房间（之后不能再用邀请码进来）
          </Button>
          <SheetClose asChild>
            <Button variant="ghost" className="bg-surface-2">
              取消
            </Button>
          </SheetClose>
        </SheetActions>
      </SheetContent>
    </Sheet>
  )
}
