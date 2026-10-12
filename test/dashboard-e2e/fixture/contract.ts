/**
 * The control API between the Playwright run (Node) and the fixture server (Bun), which owns the
 * seeded demo hubs. Plain types only, so both sides can import it.
 */

/** Which demo world to seed: `small` has a 12-person big room (fast); `full` matches the mockup. */
export type WorldSize = 'small' | 'full'

export interface CreateHubRequest {
  readonly size?: WorldSize
}

/** One seeded hub, as the tests see it. */
export interface HubInfo {
  readonly id: string
  /** The public origin, e.g. `http://127.0.0.1:53021`. */
  readonly url: string
  readonly adminUrl: string
  readonly adminToken: string
  /**
   * Seeded room ids: timely (gulei owns), pay (支付联调), llmEval (invite closed), onboarding (big),
   * and discoverable rooms gulei is not in: apiReview, apiDocs (gulei is knocking), growthLab.
   */
  readonly rooms: {
    readonly timely: string
    readonly pay: string
    readonly llmEval: string
    readonly onboarding: string
    readonly apiReview: string
    readonly apiDocs: string
    readonly growthLab: string
  }
  /** Demo agent key (`sync`, `t3code`, `popular`, `prd2demo`, `paygw`, …) → session id. */
  readonly sessions: Readonly<Record<string, string>>
}

export interface LoginRequest {
  /**
   * A demo member with at least one connected agent: gulei, zhang-wei, li-na, wang-fang, zhou-min,
   * he-yu (13 rooms), lin-feng, xiao-bai (no rooms).
   */
  readonly member: string
}

export interface LoginResponse {
  readonly url: string
}

export interface TitleRequest {
  /** Demo agent key, e.g. `t3code`. */
  readonly agent: string
  readonly title: string
}

export interface ErrorResponse {
  readonly error: string
}

export const CONTROL_ENV = 'PEERS_E2E_CONTROL'
