/** Not found inside the signed-in shell (DASHBOARD §5: say why and what to do next). */
import { Link } from 'wouter'
import { EmptyState } from '../components/empty-state'
import { RoomDoor } from '../components/room-door'
import { Button } from '../components/ui/button'
import { PATHS } from './paths'

export function NotFound() {
  return (
    <EmptyState
      art={<RoomDoor roomId="not-found" size={44} />}
      title="这里什么都没有"
      description="链接可能写错了，或者页面已经搬走。回到首页再找找。"
    >
      <Button asChild size="sm">
        <Link href={PATHS.home}>回到首页</Link>
      </Button>
    </EmptyState>
  )
}
