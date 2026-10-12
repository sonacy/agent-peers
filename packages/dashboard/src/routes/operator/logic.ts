/** Pure helpers of the operator view: labels, search matching, the settings diff, the clipboard. */
import type { AdminMember, AdminRoom, HubSettings, Registration, SettingsPatch } from './admin-schemas'

export function roomLabel(room: AdminRoom['room']): string {
  return room.display_name ?? room.name
}

export function matchRoom(row: AdminRoom, needle: string): boolean {
  const { name, display_name, owner } = row.room
  return [name, display_name ?? '', owner ?? ''].some((value) => value.toLowerCase().includes(needle))
}

export function matchMember(member: AdminMember, needle: string): boolean {
  return member.name.toLowerCase().includes(needle)
}

/** Only the fields that differ from the saved settings. */
export function settingsPatch(saved: HubSettings, url: string, registration: Registration): SettingsPatch {
  const trimmed = url.trim()
  return {
    ...(trimmed !== (saved.public_url ?? '') ? { public_url: trimmed } : {}),
    ...(registration !== saved.registration ? { registration } : {}),
  }
}

/** Copies to the clipboard; false when the browser refuses (no permission, insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
