/** Clipboard write that reports failure instead of throwing (insecure origins, denied permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard === undefined) return false
    await globalThis.navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
