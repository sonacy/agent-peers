/**
 * The demo cast (docs/design/peers-dashboard-mockup.png): gulei and four teammates, their agents,
 * the questions they ask each other, and generators for the big onboarding room. Member names use
 * `-` where the mockup has `.` (`zhang.wei` → `zhang-wei`): hub names are `^[a-z0-9][a-z0-9_-]*$`.
 */
import type { AgentSpec } from './agents'

export const ME = 'gulei'
export const TEAM = ['zhang-wei', 'li-na', 'wang-fang', 'zhou-min'] as const

/** gulei's four agents (the 我的 agent grid). Keys double as their handles. */
export const MY_AGENTS = {
  sync: {
    key: 'sync',
    kind: 'claude-code',
    title: '通用插件将 agent session 同步',
    model: 'Opus 5.5',
    workspace: 'agent-peers',
    activity: 'busy',
    summary: '正在回答一个问题',
  },
  t3code: {
    key: 't3code',
    kind: 'codex',
    title: '调研 T3Code 项目',
    model: 'GPT-5.1 Low',
    workspace: 't3code',
  },
  popular: {
    key: 'popular',
    kind: 'claude-desktop',
    title: 'Recent popular agent projects',
    model: 'Sonnet 4.6',
    inject: 'poll',
  },
  prd2demo: {
    key: 'prd2demo',
    kind: 'claude-code',
    title: 'prd2demo',
    model: 'Opus 5.5',
    workspace: 'prd2demo',
  },
} as const satisfies Record<string, AgentSpec>

/** Teammates' agents. */
export const TEAM_AGENTS = {
  paygw: {
    key: 'paygw',
    kind: 'claude-code',
    title: '支付网关重构',
    model: 'Opus 5.5',
    workspace: 'pay-gateway',
  },
  orders: { key: 'orders', kind: 'codex', title: '订单服务迁移', model: 'GPT-5.1 High', workspace: 'orders' },
  billing: { key: 'billing', kind: 'cursor', title: '账单服务排查', model: 'auto-smart', inject: 'boundary' },
  recon: {
    key: 'recon',
    kind: 'codex',
    title: '对账脚本',
    model: 'GPT-5.1 Medium',
    // An old plugin: the card shows the "outdated plugin" state.
    adapter: '0.0.9',
  },
  design: {
    key: 'design',
    kind: 'claude-desktop',
    title: '设计评审助手',
    model: 'Sonnet 4.6',
    inject: 'poll',
  },
  growth: { key: 'growth', kind: 'trae', title: '增长实验周报', model: 'auto', inject: 'boundary' },
} as const satisfies Record<string, AgentSpec>

export const KNOCK_NOTES = {
  'wang-fang': '想让我的 agent 问问 timely 里的接口规范',
  'zhou-min': '我们组在接支付回调，想借 timely 的 agent 问问 SDK 的用法',
} as const

const LINK = 'https://github.com/pingdotgg/t3code'

/** The long answer (code block + link) for the 已回答 thread. */
export const SIGNATURE_ANSWER = [
  '回调头里带 `X-Signature`，用配置中心 `payment.callback.pubkey` 那把公钥做 RSA-SHA256 验签，时间戳超过 5 分钟直接拒。',
  '',
  '```ts',
  "import { createVerify } from 'node:crypto'",
  '',
  'export function verifyCallback(body: string, signature: string, publicKey: string): boolean {',
  "  const verifier = createVerify('RSA-SHA256')",
  '  verifier.update(body)',
  "  return verifier.verify(publicKey, signature, 'base64')",
  '}',
  '```',
  '',
  '注意 body 要用原始字节，不能先 JSON.parse 再 stringify，否则字段顺序变了验签必挂。',
  '退款回调和支付回调用的是同一把公钥，但退款多一个 `refund_id` 字段，记得一起算进去。',
  '时间戳校验在网关层已经做了，业务里不用再做一遍；重放保护靠 `nonce` 去重，Redis 里留 10 分钟。',
  '测试环境的公钥在 `config/sandbox/pay.pem`，生产的走密钥管理平台，不要提交到仓库。',
  '如果验签失败，先看 Content-Type 是不是被代理改成了 form 编码，这个坑我们踩过两次。',
  '完整的接入文档在 https://wiki.example.com/pay/callback-v2 ，里面有各语言的示例。',
].join('\n')

export const T3_QUESTION = 'T3 Code（pingdotgg/t3code）有多少用户？收费吗？请附来源和日期。'
export const T3_ANSWER = `工作台本身不收费，模型费用自己付。官方自报超过 40 万用户；DAU、MAU 没有公开数据，GitHub stars 不等于用户数。来源：${LINK}（10 月 3 日查的）。`

export const BIG_ROOM_TITLES = [
  '新人入职问答',
  '本地环境搭建',
  '代码规范检查',
  '周报整理',
  'API 文档查询',
  'CI 排错',
  '数据看板',
  '测试用例生成',
  '需求拆解',
  '线上告警值班',
] as const

const BIG_ROOM_KINDS = ['claude-code', 'codex', 'cursor', 'claude-desktop', 'opencode', 'trae'] as const

const SURNAMES = [
  'zhao',
  'qian',
  'sun',
  'zhou',
  'wu',
  'zheng',
  'feng',
  'chen',
  'chu',
  'wei',
  'jiang',
  'shen',
  'han',
  'yang',
] as const
/** Given names; none of the combinations is a TEAM name (`zhou-min` is a real teammate). */
const GIVEN = ['lei', 'ming', 'jie', 'yu', 'hao', 'ting', 'xin', 'yan', 'bo', 'qing', 'rui', 'fan'] as const

/** `count` distinct, valid member names, deterministic; `prefix` keeps generated sets apart. */
export function generatedNames(count: number, prefix = ''): readonly string[] {
  return Array.from({ length: count }, (_, i) => {
    const surname = SURNAMES[i % SURNAMES.length] ?? 'li'
    const given = GIVEN[Math.floor(i / SURNAMES.length) % GIVEN.length] ?? 'na'
    const round = Math.floor(i / (SURNAMES.length * GIVEN.length))
    return `${prefix}${surname}-${given}${round === 0 ? '' : round + 1}`
  })
}

/** The two agents each big-room member brings. */
export function bigRoomAgents(index: number): readonly AgentSpec[] {
  return [0, 1].map((n) => {
    const at = index * 2 + n
    const kind = BIG_ROOM_KINDS[at % BIG_ROOM_KINDS.length] ?? 'claude-code'
    return {
      key: `a${n + 1}`,
      kind,
      title: BIG_ROOM_TITLES[at % BIG_ROOM_TITLES.length] ?? '新人入职问答',
      model: kind === 'codex' ? 'GPT-5.1 Low' : 'Sonnet 4.6',
      inject: kind === 'claude-desktop' ? 'poll' : kind === 'cursor' || kind === 'trae' ? 'boundary' : 'push',
    }
  })
}
