/**
 * Self-hosted fonts (DASHBOARD §3). Registered through the FontFace API so the bundler emits them
 * as same-origin files: CSS `url()` fonts get inlined as `data:` URIs, which CSP `default-src 'self'`
 * blocks.
 */
import bricolage700 from '@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff2'
import bricolage800 from '@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-800-normal.woff2'
import inter400 from '@fontsource/inter-tight/files/inter-tight-latin-400-normal.woff2'
import inter500 from '@fontsource/inter-tight/files/inter-tight-latin-500-normal.woff2'
import inter600 from '@fontsource/inter-tight/files/inter-tight-latin-600-normal.woff2'
import inter700 from '@fontsource/inter-tight/files/inter-tight-latin-700-normal.woff2'
import mono400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'
import mono500 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2'

export interface FontSource {
  readonly family: string
  readonly weight: string
  readonly url: string
}

export const FONT_SOURCES: readonly FontSource[] = [
  { family: 'Bricolage Grotesque', weight: '700', url: bricolage700 },
  { family: 'Bricolage Grotesque', weight: '800', url: bricolage800 },
  { family: 'Inter Tight', weight: '400', url: inter400 },
  { family: 'Inter Tight', weight: '500', url: inter500 },
  { family: 'Inter Tight', weight: '600', url: inter600 },
  { family: 'Inter Tight', weight: '700', url: inter700 },
  { family: 'JetBrains Mono', weight: '400', url: mono400 },
  { family: 'JetBrains Mono', weight: '500', url: mono500 },
]

/** Adds every face to `document.fonts` (display: swap); returns how many were registered. */
export function registerFonts(fonts: FontFaceSet | undefined = globalThis.document?.fonts): number {
  if (fonts === undefined || typeof FontFace === 'undefined') return 0
  for (const source of FONT_SOURCES) {
    const face = new FontFace(source.family, `url(${source.url}) format("woff2")`, {
      weight: source.weight,
      style: 'normal',
      display: 'swap',
    })
    fonts.add(face)
  }
  return FONT_SOURCES.length
}
