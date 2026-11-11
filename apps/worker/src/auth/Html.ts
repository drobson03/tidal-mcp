import { HttpServerResponse } from "effect/http"

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }

/** An HTML fragment whose interpolations are escaped unless they are already `Html`. */
export class Html {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString() {
    return this.value
  }
}

const render = (value: unknown): string => {
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(render).join("")
  if (value === undefined || value === null || value === false) return ""
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!)
}

export const html = (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): Html =>
  new Html(strings.reduce((out, string, i) => out + string + (i < values.length ? render(values[i]) : ""), ""))

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --fg: #18181b; --muted: #5f5f68;
  --border: #e3e3e0; --accent: #111; --accent-fg: #fff; --danger: #b42318 }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0d0f; --card: #17171a; --fg: #f2f2f3;
  --muted: #a1a1aa; --border: #2a2a2f; --accent: #f2f2f3; --accent-fg: #0d0d0f; --danger: #f97066 } }
* { box-sizing: border-box }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
  background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif }
main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; padding: 28px }
h1 { font-size: 20px; margin: 0 0 8px }
p { margin: 0 0 16px; color: var(--muted) }
strong { color: var(--fg) }
code { font-size: 13px; word-break: break-all }
ul { margin: 0 0 20px; padding-left: 20px; color: var(--muted) }
form { display: flex; gap: 8px; flex-wrap: wrap }
button { flex: 1; min-width: 120px; font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 9px;
  border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg) }
.error { color: var(--danger) }
.brand { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 16px }
`

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  // Not no-referrer: that makes browsers send `Origin: null` on form posts,
  // which fails Better Auth's origin check.
  "referrer-policy": "same-origin",
  "cache-control": "no-store"
}

export const page = (title: string, body: Html, options?: { readonly status?: number }) =>
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      render(html`<title>${title}</title>`) + `<style>${STYLE}</style></head>` +
      `<body><main><div class="brand">TIDAL MCP</div>${body.value}</main></body></html>`,
    { status: options?.status ?? 200, headers: SECURITY_HEADERS, contentType: "text/html; charset=utf-8" }
  )
