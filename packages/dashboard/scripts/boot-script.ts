/** index.html rewriting for the boot script (see `addBootScript` in build-spa.ts). Pure, so it is unit tested. */

/** Puts `<script src>` for the boot file before the first script of the page. */
export function injectBootScript(html: string, src: string): string {
  const tag = `<script src="${src}"></script>`
  const at = html.indexOf('<script')
  return at === -1 ? html.replace('</head>', `${tag}</head>`) : `${html.slice(0, at)}${tag}${html.slice(at)}`
}
