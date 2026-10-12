import '../helpers/dom'
import { describe, expect, it } from 'bun:test'
import { AgentFace, EXPRESSIONS, FACE_SIZES } from '../../src/components/agent-face'
import { AvatarStack } from '../../src/components/avatar-stack'
import { CorePill, secondsUntil } from '../../src/components/core-pill'
import { MEMBER_SIZES, MemberAvatar } from '../../src/components/member-avatar'
import { PeersLogo } from '../../src/components/peers-logo'
import { DOOR_SIZES, RoomDoor } from '../../src/components/room-door'
import { Status } from '../../src/components/status'
import { faceColor } from '../../src/lib/hash'
import { renderUi, screen, setupUi, user, waitFor } from '../helpers/render'

setupUi()

describe('AgentFace', () => {
  it('uses the hashed color and the same color for the same id', () => {
    const { container } = renderUi(
      <>
        <AgentFace id="sess-42" />
        <AgentFace id="sess-42" size={22} />
      </>,
    )
    const faces = container.querySelectorAll('[data-face-color]')
    expect(faces[0]?.getAttribute('data-face-color')).toBe(faceColor('sess-42'))
    expect(faces[1]?.getAttribute('data-face-color')).toBe(faceColor('sess-42'))
    expect(faces[0]?.className).toContain(`bg-face-${faceColor('sess-42')}`)
  })
  it('draws each expression so status is not color-only', () => {
    const eyes: Record<string, string> = {
      idle: 'open',
      busy: 'sideways',
      offline: 'closed',
      awaiting: 'open',
    }
    for (const expression of EXPRESSIONS) {
      const { container, unmount } = renderUi(<AgentFace id="x" expression={expression} />)
      expect(container.querySelector('[data-eyes]')?.getAttribute('data-eyes')).toBe(eyes[expression] ?? '')
      expect(container.querySelector('[data-brow]') !== null).toBe(expression === 'awaiting')
      unmount()
    }
  })
  it('supports every size, and labels or hides itself', () => {
    for (const size of FACE_SIZES) {
      const { unmount } = renderUi(<AgentFace id="x" size={size} label={`face ${size}`} />)
      expect(screen().getByRole('img', { name: `face ${size}（有空）` })).toBeDefined()
      unmount()
    }
    const { container } = renderUi(<AgentFace id="y" mouth expression="busy" />)
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('path').length).toBe(1)
  })
})

describe('MemberAvatar / RoomDoor / logo', () => {
  it('draws a circle with the initial in the hashed color', () => {
    for (const size of MEMBER_SIZES) {
      const { unmount } = renderUi(<MemberAvatar memberId="m-1" name="zhang.wei" size={size} />)
      const avatar = screen().getByRole('img', { name: 'zhang.wei' })
      expect(avatar.textContent).toBe('Z')
      expect(avatar.className).toContain('rounded-full')
      expect(avatar.getAttribute('data-face-color')).toBe(faceColor('m-1'))
      unmount()
    }
    const { container } = renderUi(<MemberAvatar memberId="m-2" name="li" decorative />)
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  })
  it('draws a door with a knob or a face', () => {
    for (const size of DOOR_SIZES) {
      const { container, unmount } = renderUi(<RoomDoor roomId="r-1" size={size} />)
      expect(container.querySelector('circle')).not.toBeNull()
      unmount()
    }
    const { container } = renderUi(<RoomDoor roomId="r-1" size={64} face label="timely" />)
    expect(screen().getByRole('img', { name: 'timely' })).toBeDefined()
    expect(container.querySelector('[data-door-face]')).not.toBeNull()
    expect(container.querySelector('[data-door-panel]')).toBeNull()
  })
  it('draws the hero door on the violet band with a surface fill and a colored panel', () => {
    const { container } = renderUi(<RoomDoor roomId="r-1" size={64} face onBand />)
    const [body] = Array.from(container.querySelectorAll('path'))
    expect(body?.getAttribute('fill')).toBe('var(--surface)')
    const panel = container.querySelector('[data-door-panel]')
    expect(panel?.getAttribute('fill')).toBe(`var(--face-${faceColor('r-1')})`)
  })
  it('renders the logo with and without the word', () => {
    const { container } = renderUi(
      <>
        <PeersLogo />
        <PeersLogo withWord={false} />
      </>,
    )
    expect(container.textContent).toBe('Peers')
  })
})

describe('AvatarStack', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s-${i}` }))
  it('shows at most 4 then +N', () => {
    const { container } = renderUi(<AvatarStack items={items(9)} label="9 个 agent" />)
    expect(screen().getByRole('img', { name: '9 个 agent' })).toBeDefined()
    expect(container.querySelectorAll('[data-face-color]')).toHaveLength(4)
    expect(container.textContent).toBe('+5')
    // 22px faces, each ringed in the surface color; +N is its own chip after a gap.
    const faces = container.querySelectorAll('[data-stack-item]')
    expect(Array.from(faces).every((f) => f.className.includes('ring-surface'))).toBe(true)
    expect(container.querySelector('[data-face-color]')?.className).toContain('size-[22px]')
    expect(container.querySelector('[data-stack-overflow]')?.className).toContain('ml-1')
  })
  it('counts against a total and caps at 99+', () => {
    const { container } = renderUi(<AvatarStack items={items(6)} total={240} label="240" />)
    expect(container.textContent).toBe('99+')
  })
  it('has no overflow tile when everything fits, and renders members', () => {
    const { container } = renderUi(
      <AvatarStack
        items={[
          { id: 'm-a', kind: 'member', name: 'gulei' },
          { id: 'm-b', kind: 'member' },
        ]}
        label="2 人"
        max={3}
      />,
    )
    expect(container.textContent).toBe('G?')
  })
})

describe('Status', () => {
  it('pairs every mark with a label', () => {
    const marks = { idle: 'pulse', busy: 'spinner', offline: 'ring', awaiting: 'dot' } as const
    const labels = { idle: '有空', busy: '正在忙', offline: '离线', awaiting: '等你确认' } as const
    for (const status of ['idle', 'busy', 'offline', 'awaiting'] as const) {
      const { container, unmount } = renderUi(
        <Status status={status} detail={status === 'idle' ? '25 秒前' : ''} />,
      )
      expect(container.querySelector(`[data-mark="${marks[status]}"]`)).not.toBeNull()
      expect(container.textContent).toContain(labels[status])
      unmount()
    }
    const { container } = renderUi(<Status status="idle" detail="25 秒前" />)
    expect(container.textContent).toBe('有空· 25 秒前')
  })
})

describe('CorePill (§7)', () => {
  it('shows connected and reconnecting', () => {
    renderUi(
      <>
        <CorePill state="connected" />
        <CorePill state="reconnecting" />
      </>,
    )
    expect(screen().getByText('Core 已连接')).toBeDefined()
    expect(screen().getByText('正在连 Core…')).toBeDefined()
    expect(screen().getAllByRole('status')).toHaveLength(2)
  })
  it('shows disconnected without details as a plain pill', () => {
    renderUi(<CorePill state="disconnected" />)
    expect(screen().getByText('连不上 Core').getAttribute('data-state')).toBe('disconnected')
    expect(screen().queryByRole('button')).toBeNull()
  })
  it('reveals url, last error and retry time on click or tap', async () => {
    const now = 1_000_000
    renderUi(
      <CorePill
        state="disconnected"
        now={now}
        details={{ url: 'http://localhost:7300', lastError: 'ECONNREFUSED', nextRetryAt: now + 12_000 }}
      />,
    )
    expect(screen().queryByText('http://localhost:7300')).toBeNull()
    await user().click(screen().getByRole('button', { name: '连不上 Core，查看详情' }))
    await waitFor(() => expect(screen().getByText('http://localhost:7300')).toBeDefined())
    expect(screen().getByText('ECONNREFUSED')).toBeDefined()
    expect(screen().getByText('12 秒后')).toBeDefined()
  })
  it('handles missing error and retry time', async () => {
    renderUi(<CorePill state="disconnected" details={{ url: 'http://h' }} />)
    const u = user()
    await u.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('连不上 Core，查看详情')
    await u.keyboard('{Enter}')
    await waitFor(() => expect(screen().getByText('没有返回错误信息')).toBeDefined())
    expect(screen().getByText('马上')).toBeDefined()
  })
  it('computes whole seconds until a time', () => {
    expect(secondsUntil(10_500, 10_000)).toBe(1)
    expect(secondsUntil(5_000, 10_000)).toBe(0)
  })
})
