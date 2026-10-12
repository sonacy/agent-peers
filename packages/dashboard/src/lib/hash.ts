/** Stable colors from ids (DASHBOARD §3): `hash(id) % 6` picks one of the six pastel face colors. */

export const FACE_COLORS = ['violet', 'sky', 'butter', 'mint', 'blush', 'cloud'] as const
export type FaceColor = (typeof FACE_COLORS)[number]

/** 32-bit FNV-1a over UTF-16 code units: fast, stable across sessions and browsers. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function faceColor(id: string): FaceColor {
  return FACE_COLORS[hashString(id) % FACE_COLORS.length] ?? 'cloud'
}

/** Tailwind background class per face color (spelled out so the class scanner sees them). */
export const FACE_BG: Readonly<Record<FaceColor, string>> = {
  violet: 'bg-face-violet',
  sky: 'bg-face-sky',
  butter: 'bg-face-butter',
  mint: 'bg-face-mint',
  blush: 'bg-face-blush',
  cloud: 'bg-face-cloud',
}

/** CSS variable per face color, for SVG fills. */
export const FACE_VAR: Readonly<Record<FaceColor, string>> = {
  violet: 'var(--face-violet)',
  sky: 'var(--face-sky)',
  butter: 'var(--face-butter)',
  mint: 'var(--face-mint)',
  blush: 'var(--face-blush)',
  cloud: 'var(--face-cloud)',
}
