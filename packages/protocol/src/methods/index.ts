/** The typed map of every request method (§6.4, §10) and the boundary parsers. */
import type { z } from 'zod'
import { PeersError, type WireErrorCode } from '../errors'
import type { DeepReadonly } from '../types'
import { messageMethods } from './messages'
import { roomMethods } from './rooms'
import { sessionMethods } from './session'

export interface MethodSpec {
  readonly params: z.ZodType
  readonly result: z.ZodType
}

export const METHODS = {
  ...sessionMethods,
  ...roomMethods,
  ...messageMethods,
} as const satisfies Record<string, MethodSpec>

export type MethodName = keyof typeof METHODS
export const METHOD_NAMES = Object.keys(METHODS) as readonly MethodName[]

/** What a caller sends. */
export type ParamsOf<M extends MethodName> = DeepReadonly<z.input<(typeof METHODS)[M]['params']>>
/** What the hub gets after `parseParams` (sanitized, defaults applied). */
export type ParsedParamsOf<M extends MethodName> = z.output<(typeof METHODS)[M]['params']>
/** What the bridge gets after `parseResult`. */
export type ResultOf<M extends MethodName> = DeepReadonly<z.output<(typeof METHODS)[M]['result']>>
/** What a hub handler returns (before encoding). */
export type ResultInputOf<M extends MethodName> = DeepReadonly<z.input<(typeof METHODS)[M]['result']>>

export type ParamsMap = { readonly [M in MethodName]: ParamsOf<M> }
export type ResultMap = { readonly [M in MethodName]: ResultOf<M> }

/** §6.4: `bye` gets no response. */
export const ONE_WAY_METHODS: ReadonlySet<MethodName> = new Set(['bye'])

export function isMethodName(name: unknown): name is MethodName {
  return typeof name === 'string' && Object.hasOwn(METHODS, name)
}

interface IssueLike {
  readonly code?: string
  readonly params?: { readonly code?: unknown }
  readonly errors?: readonly (readonly IssueLike[])[]
}

/** The codes tagged on failed checks (`params.code`), searched through union branches too. */
function taggedCodes(issues: readonly IssueLike[]): readonly string[] {
  return issues.flatMap((issue) => [
    ...(typeof issue.params?.code === 'string' ? [issue.params.code] : []),
    ...(issue.errors ?? []).flatMap((branch) => taggedCodes(branch)),
  ])
}

const PRIORITY: readonly WireErrorCode[] = ['payload_too_large', 'invalid_name']

/**
 * Maps a zod failure to a protocol error: oversize text → `payload_too_large`, a bad name →
 * `invalid_name`, anything else → `invalid_params`. The zod issues ride along in `data.issues`.
 */
export function paramsError(error: z.ZodError, context = 'invalid params'): PeersError {
  const tagged = new Set(taggedCodes(error.issues as readonly IssueLike[]))
  const code = PRIORITY.find((candidate) => tagged.has(candidate)) ?? 'invalid_params'
  const issues = error.issues
    .slice(0, 10)
    .map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  return new PeersError(
    code,
    `${context}: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
    {
      issues,
    },
  )
}

/** Hub boundary: validates and sanitizes params. Throws `method_not_found` or a params error. */
export function parseParams<M extends MethodName>(method: M, params: unknown): ParsedParamsOf<M> {
  const parsed = METHODS[method].params.safeParse(params ?? {})
  if (!parsed.success) throw paramsError(parsed.error, `invalid ${method} params`)
  return parsed.data as ParsedParamsOf<M>
}

/** Like `parseParams`, for a method name read off the wire. */
export function parseRequest(method: string, params: unknown): ParsedParamsOf<MethodName> {
  if (!isMethodName(method)) throw new PeersError('method_not_found', `method not found: ${method}`)
  return parseParams(method, params)
}

/** Bridge boundary: validates a result. Throws `invalid_result`. */
export function parseResult<M extends MethodName>(method: M, result: unknown): ResultOf<M> {
  const parsed = METHODS[method].result.safeParse(result)
  if (!parsed.success) {
    throw new PeersError('invalid_result', `invalid ${method} result: ${parsed.error.message}`)
  }
  return parsed.data as ResultOf<M>
}

// ---- convenience aliases ---------------------------------------------------------------------------
export type BridgeInfo = ParamsOf<'hello'>['bridge']
export type Welcome = ResultOf<'hello'>
export type SessionPatch = Omit<ParamsOf<'session.update'>, 'session_id'>
export type MsgSendParams = ParamsOf<'msg.send'>
export type MsgReplyParams = ParamsOf<'msg.reply'>
