/**
 * Server-rendered pages (invite landing, login, placeholders). The `html` tag escapes every
 * interpolated value unless it is already `SafeHtml`, so hub- and member-supplied text can't inject
 * markup. Pages carry no inline script or style, which `default-src 'self'` would block anyway.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

type HtmlValue = string | number | SafeHtml | null | undefined

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (ch) => ESCAPES[ch] ?? ch)
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof SafeHtml) return value.value
  return escapeHtml(String(value))
}

export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  return new SafeHtml(
    strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? render(values[i]) : ''), ''),
  )
}

export const PAGE_CSS_PATH = '/_hub/page.css'

export const PAGE_CSS = `:root{color-scheme:light dark;--bg:#F3F1FB;--surface:#fff;--ink:#16142B;--muted:#6B6888;--primary:#7357FF;--lime:#DFF26B}
@media (prefers-color-scheme:dark){:root{--bg:#0F0E1A;--surface:#1A1830;--ink:#ECEAF7;--muted:#A8A5C3}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "Inter Tight",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
.card{background:var(--surface);border:2px solid var(--ink);border-radius:16px;box-shadow:4px 4px 0 var(--ink);padding:24px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px}.muted{color:var(--muted)}
pre{background:#16142B;color:#F3F1FB;border-radius:12px;padding:16px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font:13px/1.5 "JetBrains Mono",ui-monospace,monospace}
button{font:inherit;font-weight:600;background:var(--primary);color:#fff;border:2px solid var(--ink);border-radius:12px;box-shadow:3px 3px 0 var(--ink);padding:12px 20px;min-height:44px;cursor:pointer}
button:active{box-shadow:none;transform:translate(2px,2px)}.warn{background:#FFF4D6;color:#7A5200;border-radius:12px;padding:12px}
`

export function page(title: string, content: SafeHtml): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${title}</title>
<link rel="stylesheet" href="${PAGE_CSS_PATH}">
</head>
<body><main><div class="card">${content}</div></main></body>
</html>
`.value
}

export function htmlResponse(markup: string, status = 200): Response {
  return new Response(markup, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** A simple titled message page. */
export function messagePage(title: string, message: string, status: number): Response {
  return htmlResponse(page(title, html`<h1>${title}</h1><p>${message}</p>`), status)
}
