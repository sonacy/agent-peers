/** Browser entry: fonts, theme, then the React root (member app at /app, operator view at /admin). */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, modeFor } from './app'
import { registerFonts } from './lib/fonts'
import { readStored } from './lib/storage'
import { applyTheme, parseTheme, THEME_KEY } from './lib/theme'

registerFonts()
applyTheme(parseTheme(readStored(THEME_KEY)))

const root = document.getElementById('root')
if (root === null) throw new Error('missing #root element')
const { mode, base } = modeFor(location.pathname)
createRoot(root).render(
  <StrictMode>
    <App mode={mode} base={base} />
  </StrictMode>,
)
