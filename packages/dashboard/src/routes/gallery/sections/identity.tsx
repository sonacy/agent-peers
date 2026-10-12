/** Faces, avatars, doors, stacks, status and the Core pill. */
import { AgentFace, EXPRESSIONS, FACE_SIZES } from '../../../components/agent-face'
import { AvatarStack, type StackItem } from '../../../components/avatar-stack'
import { CorePill } from '../../../components/core-pill'
import { MEMBER_SIZES, MemberAvatar } from '../../../components/member-avatar'
import { PeersLogo } from '../../../components/peers-logo'
import { DOOR_SIZES, RoomDoor } from '../../../components/room-door'
import { Status } from '../../../components/status'
import { GALLERY_NOW, GallerySection, Specimen } from '../kit'

/** Ids that hash to each of the six face colors, in palette order. */
const COLOR_IDS = ['sess-01', 'sess-02', 'sess-03', 'sess-04', 'sess-05', 'sess-06', 'sess-07', 'sess-08']

const stack = (n: number): StackItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `stack-${i}`, expression: i % 3 === 2 ? 'offline' : 'idle' }))

export function IdentitySection() {
  return (
    <GallerySection id="identity" title="小脸、头像、门">
      <Specimen label="AgentFace：尺寸 × 表情" wide className="flex-col">
        {EXPRESSIONS.map((expression) => (
          <div key={expression} className="flex items-center gap-3">
            <code className="w-20 font-mono text-meta">{expression}</code>
            {FACE_SIZES.map((size) => (
              <AgentFace
                key={size}
                id="sess-gallery"
                size={size}
                expression={expression}
                label={`${size}px`}
              />
            ))}
            <AgentFace id="sess-gallery-2" size={44} expression={expression} mouth />
          </div>
        ))}
      </Specimen>
      <Specimen label="颜色按 id 哈希">
        {COLOR_IDS.map((id) => (
          <AgentFace key={id} id={id} size={44} label={id} />
        ))}
      </Specimen>
      <Specimen label="MemberAvatar" className="items-center">
        {MEMBER_SIZES.map((size) => (
          <MemberAvatar key={size} memberId="m-gulei" name="gulei.sonacy" size={size} />
        ))}
        <MemberAvatar memberId="m-zhang" name="zhang.wei" />
        <MemberAvatar memberId="m-li" name="li.na" />
        <MemberAvatar memberId="m-empty" name="" />
      </Specimen>
      <Specimen label="RoomDoor" className="items-end">
        {DOOR_SIZES.map((size) => (
          <RoomDoor key={size} roomId="room-timely" size={size} label="timely" />
        ))}
        <RoomDoor roomId="room-pay" size={64} face label="支付联调" />
      </Specimen>
      <Specimen label="AvatarStack（最多 4，+N）" className="flex-col">
        <AvatarStack items={stack(3)} label="3 个 agent" />
        <AvatarStack items={stack(4)} label="4 个 agent" />
        <AvatarStack items={stack(9)} label="9 个 agent" />
        <AvatarStack items={stack(6)} total={240} label="240 个 agent" />
        <AvatarStack
          items={[
            { id: 'm-a', kind: 'member', name: 'gulei' },
            { id: 'm-b', kind: 'member', name: 'zhang.wei' },
          ]}
          label="2 人"
        />
      </Specimen>
      <Specimen label="Status" className="flex-col">
        <Status status="idle" detail="25 秒前" />
        <Status status="busy" detail="正在回答一个问题" />
        <Status status="offline" detail="2 小时前" />
        <Status status="awaiting" />
      </Specimen>
      <Specimen label="Core pill" className="flex-col">
        <CorePill state="connected" />
        <CorePill state="reconnecting" />
        <CorePill
          state="disconnected"
          now={GALLERY_NOW}
          details={{
            url: 'http://localhost:7300',
            lastError: 'ECONNREFUSED',
            nextRetryAt: GALLERY_NOW + 12_000,
          }}
        />
      </Specimen>
      <Specimen label="Logo">
        <PeersLogo />
        <PeersLogo withWord={false} />
      </Specimen>
    </GallerySection>
  )
}
