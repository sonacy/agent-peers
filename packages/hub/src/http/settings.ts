/**
 * Operator settings changeable at runtime from the admin listener (DASHBOARD §10): the public URL
 * (invite and login links) and the registration mode. Changes last until the hub restarts; the
 * startup flags remain the persistent source.
 */
import { normalizePublicUrl } from '@agent-peers/protocol'
import type { Registration } from '../config'
import type { HubContext } from '../hub'

export interface HttpSettings {
  registration(): Registration
  publicUrl(): string | undefined
  update(patch: SettingsPatch): void
}

export interface SettingsPatch {
  readonly public_url?: string
  readonly registration?: Registration
}

export function createSettings(hub: HubContext): HttpSettings {
  let registration: Registration = hub.config.registration
  return {
    registration: () => registration,
    publicUrl: () => hub.runtime.publicUrl,
    update(patch) {
      if (patch.public_url !== undefined) hub.runtime.publicUrl = normalizePublicUrl(patch.public_url)
      if (patch.registration !== undefined) registration = patch.registration
    },
  }
}
