/** Counts cap at `99+` (DASHBOARD §8). */

export const COUNT_CAP = 99

export function formatCount(count: number, cap: number = COUNT_CAP): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  const whole = Math.floor(count)
  return whole > cap ? `${cap}+` : String(whole)
}

/** "+N" overflow label for stacks and tag rows (`99+` past the cap); empty when nothing overflows. */
export function formatOverflow(hidden: number, cap: number = COUNT_CAP): string {
  if (!(hidden > 0)) return ''
  return hidden > cap ? `${cap}+` : `+${Math.floor(hidden)}`
}
