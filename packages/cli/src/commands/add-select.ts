/** Which agents `add` installs into (ARCHITECTURE §4 step 2). */
import { isCancel, multiselect } from '@clack/prompts'
import type { CurrentAgent } from '../agents/current'
import type { AgentDetection, AgentId } from '../agents/types'
import type { SelectOption, SelectPrompt } from './installer-deps'

export interface SelectRequest {
  readonly detections: readonly AgentDetection[]
  readonly explicit: readonly AgentId[]
  readonly here: boolean
  readonly yes: boolean
  readonly current?: CurrentAgent
  readonly interactive: boolean
  /** Agents installed by an earlier run (pre-checked). */
  readonly previous: readonly AgentId[]
  readonly prompt: SelectPrompt
}

export type Selection =
  | { readonly kind: 'agents'; readonly ids: readonly AgentId[]; readonly mode: string }
  | { readonly kind: 'error'; readonly message: string; readonly code: number }
  | { readonly kind: 'cancelled' }

/** The default prompt: @clack/prompts multiselect, too-old agents greyed out with the reason. */
export const clackPrompt: SelectPrompt = async (options, initial) => {
  const picked = await multiselect<AgentId>({
    message: 'Install agent-peers into which agents?',
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {}),
      ...(option.disabled ? { disabled: true } : {}),
    })),
    initialValues: [...initial],
    required: false,
  })
  return isCancel(picked) ? undefined : picked
}

export function promptOptions(detections: readonly AgentDetection[]): readonly SelectOption[] {
  return detections
    .filter((detection) => detection.detected)
    .map((detection) => ({
      value: detection.id,
      label: detection.label,
      ...(detection.supported
        ? detection.version
          ? { hint: detection.version }
          : {}
        : { hint: detection.reason ?? 'not supported', disabled: true }),
    }))
}

const supportedIds = (detections: readonly AgentDetection[]): readonly AgentId[] =>
  detections.filter((detection) => detection.supported).map((detection) => detection.id)

function hereSelection(current: CurrentAgent | undefined): Selection {
  if (current?.id) return { kind: 'agents', ids: [current.id], mode: `--here (${current.name})` }
  const name = current ? `"${current.name}", which agent-peers v0 does not support` : 'no agent'
  return { kind: 'error', code: 2, message: `--here: running inside ${name}; pass -a <agent> instead` }
}

async function promptSelection(request: SelectRequest): Promise<Selection> {
  const supported = supportedIds(request.detections)
  const previous = request.previous.filter((id) => supported.includes(id))
  const picked = await request.prompt(
    promptOptions(request.detections),
    previous.length ? previous : supported,
  )
  if (picked === undefined) return { kind: 'cancelled' }
  return { kind: 'agents', ids: picked.filter((id) => supported.includes(id)), mode: 'selected' }
}

/** -a wins, then --here, then -y / non-interactive (all supported), then the prompt. */
export async function selectAgents(request: SelectRequest): Promise<Selection> {
  if (request.explicit.length > 0) return { kind: 'agents', ids: request.explicit, mode: '-a' }
  if (request.here) return hereSelection(request.current)
  const automatic = request.yes || request.current !== undefined || !request.interactive
  if (automatic) {
    const mode = request.yes ? '-y' : request.current ? `inside ${request.current.name}` : 'non-interactive'
    return { kind: 'agents', ids: supportedIds(request.detections), mode }
  }
  return promptSelection(request)
}
