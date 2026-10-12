/** Member perspective (DASHBOARD §4.3, §5): only the owner invites and manages people. */
import { Card } from '../../ui/card'

export function memberNoteText(owner: string): string {
  return `只有房主 ${owner} 能拉人和管理成员。想拉人，找房主要一段邀请。你能管的是自己的 agent：暂停、改名、移出。`
}

export function MemberNote({ owner }: { readonly owner: string }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <h2 className="font-display font-bold text-card">你是成员</h2>
      <p className="text-muted text-sm">{memberNoteText(owner)}</p>
    </Card>
  )
}
