/**
 * The pages a user sees while connecting an MCP client:
 *
 * 1. `GET /sign-in`: the authorize endpoint sends signed-out users here with
 *    a signed copy of the authorization request. "Continue with TIDAL" posts
 *    it back, and the server starts TIDAL's sign-in (PKCE) through Better Auth.
 * 2. TIDAL redirects to `/api/auth/callback/tidal`. Better Auth checks the
 *    allowlist, creates the session and resumes the authorization request.
 * 3. `GET /consent`: the user approves or denies the client, and the server
 *    forwards the decision to Better Auth, which redirects to the client with
 *    an authorization code.
 *
 * The pages are plain HTML forms. They work without JavaScript and the strict
 * CSP allows no scripts. Better Auth's origin check still applies to the
 * forwarded requests, because the browser's `Origin` header is passed on.
 */
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http"
import {
  AUTH_BASE_PATH,
  type Auth,
  CONSENT_PATH,
  SIGN_IN_ERROR_PATH,
  SIGN_IN_PATH,
  TIDAL_PROVIDER_ID
} from "./BetterAuth.ts"
import type { AuthDb, CurrentAuth } from "./CurrentAuth.ts"
import { html, page } from "./Html.ts"

const FORWARDED_HEADERS = ["cookie", "origin", "referer", "user-agent", "cf-connecting-ip"] as const

const forwardedHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  const headers = new Headers()
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers[name]
    if (value !== undefined) headers.set(name, value)
  }
  return headers
}

/** Calls a Better Auth JSON endpoint on behalf of the browser and returns its `url` redirect. */
const forwardForRedirect = (
  { auth, origin }: CurrentAuth,
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  body: Record<string, unknown>
) =>
  Effect.promise(async () => {
    const headers = forwardedHeaders(request)
    headers.set("content-type", "application/json")
    headers.set("accept", "application/json")
    const response = await auth.handler(
      new Request(`${origin}${AUTH_BASE_PATH}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
    )
    const json = await response.json().catch(() => undefined) as
      | { readonly url?: string; readonly message?: string; readonly error_description?: string }
      | undefined
    const redirect = new Headers({ "cache-control": "no-store" })
    for (const cookie of response.headers.getSetCookie()) redirect.append("set-cookie", cookie)
    if (!response.ok || typeof json?.url !== "string") {
      const message = json?.error_description ?? json?.message ?? `Request failed (${response.status})`
      redirect.set("location", `${SIGN_IN_ERROR_PATH}?${new URLSearchParams({ error_description: message })}`)
    } else {
      redirect.set("location", json.url)
    }
    return HttpServerResponse.fromWeb(new Response(null, { status: 303, headers: redirect }))
  })

const searchOf = (request: HttpServerRequest.HttpServerRequest) => {
  const index = request.url.indexOf("?")
  return index === -1 ? "" : request.url.slice(index + 1)
}

const formField = (request: HttpServerRequest.HttpServerRequest, name: string) =>
  request.urlParamsBody.pipe(
    Effect.map((params) => Option.getOrUndefined(UrlParams.getFirst(params, name))),
    Effect.orElseSucceed(() => undefined)
  )

const startOver = html`<p>Start again from your MCP client to connect it to this server.</p>`

const signInPage = (current: CurrentAuth, request: HttpServerRequest.HttpServerRequest) =>
  Effect.promise(async () => {
    const query = searchOf(request)
    if (!new URLSearchParams(query).has("sig") || !await verifyOAuthQueryParams(query, current.auth.options.secret)) {
      return page("Sign in", html`<h1>Nothing to sign in to</h1>${startOver}`, { status: 400 })
    }
    return page(
      "Sign in",
      html`<h1>Connect to TIDAL MCP</h1>
<p>An MCP client wants to use this server. Sign in with your TIDAL account to continue.</p>
<form method="post" action="${SIGN_IN_PATH}">
  <input type="hidden" name="oauth_query" value="${query}">
  <button class="primary" type="submit">Continue with TIDAL</button>
</form>`
    )
  })

const signInErrorPage = (request: HttpServerRequest.HttpServerRequest) => {
  const params = new URLSearchParams(searchOf(request))
  const description = params.get("error_description") ?? params.get("error") ?? "Something went wrong"
  return page(
    "Sign-in failed",
    html`<h1>Sign-in failed</h1><p class="error">${description.replaceAll("_", " ")}</p>${startOver}`,
    { status: 400 }
  )
}

const consentPage = (current: CurrentAuth, request: HttpServerRequest.HttpServerRequest) =>
  Effect.promise(async () => {
    const { auth } = current
    const query = searchOf(request)
    const params = new URLSearchParams(query)
    const clientId = params.get("client_id")
    if (clientId === null || !await verifyOAuthQueryParams(query, auth.options.secret)) {
      return page("Authorize", html`<h1>Nothing to authorize</h1>${startOver}`, { status: 400 })
    }
    const headers = forwardedHeaders(request)
    const session = await auth.api.getSession({ headers })
    if (session === null) {
      return page("Authorize", html`<h1>Your session expired</h1>${startOver}`, { status: 401 })
    }
    const client = await clientInfo(auth, clientId, headers)
    const scopes = (params.get("scope") ?? "").split(" ").filter((scope) => scope !== "")
    const redirectUri = params.get("redirect_uri")
    return page(
      "Authorize",
      html`<h1>Allow ${client.name}?</h1>
<p><strong>${client.name}</strong> wants to use the TIDAL catalogue tools on this server as
<strong>${session.user.name}</strong>.</p>
<p>Client: <code>${clientId}</code>${
        redirectUri === null ? "" : html`<br>Returns to: <code>${redirectUri}</code>`
      }</p>
${scopes.length === 0 ? "" : html`<ul>${scopes.map((scope) => html`<li><code>${scope}</code></li>`)}</ul>`}
<form method="post" action="${CONSENT_PATH}">
  <input type="hidden" name="oauth_query" value="${query}">
  <button type="submit" name="accept" value="false">Deny</button>
  <button class="primary" type="submit" name="accept" value="true">Allow</button>
</form>`
    )
  })

const clientInfo = async (auth: Auth, clientId: string, headers: Headers) => {
  const client = await auth.api.getOAuthClientPublic({ query: { client_id: clientId }, headers }).catch(() => null)
  const name = client !== null && typeof client.client_name === "string" && client.client_name !== ""
    ? client.client_name
    : clientId
  return { name }
}

export const layer = (
  currentAuth: Effect.Effect<CurrentAuth, never, HttpServerRequest.HttpServerRequest | AuthDb>
) =>
  Layer.mergeAll(
    HttpRouter.add("GET", SIGN_IN_PATH, (request) => Effect.flatMap(currentAuth, (current) => signInPage(current, request))),
    HttpRouter.add("POST", SIGN_IN_PATH, (request) =>
      Effect.gen(function*() {
        const current = yield* currentAuth
        const oauthQuery = yield* formField(request, "oauth_query")
        return yield* forwardForRedirect(current, request, "/sign-in/social", {
          provider: TIDAL_PROVIDER_ID,
          callbackURL: "/",
          errorCallbackURL: SIGN_IN_ERROR_PATH,
          oauth_query: oauthQuery
        })
      })),
    HttpRouter.add("GET", SIGN_IN_ERROR_PATH, (request) => Effect.succeed(signInErrorPage(request))),
    HttpRouter.add("GET", CONSENT_PATH, (request) => Effect.flatMap(currentAuth, (current) => consentPage(current, request))),
    HttpRouter.add("POST", CONSENT_PATH, (request) =>
      Effect.gen(function*() {
        const current = yield* currentAuth
        const oauthQuery = yield* formField(request, "oauth_query")
        const accept = (yield* formField(request, "accept")) === "true"
        return yield* forwardForRedirect(current, request, "/oauth2/consent", { accept, oauth_query: oauthQuery })
      })),
    // Better Auth's own endpoints, plus the OAuth discovery documents it
    // serves at the origin root (RFC 8414 and RFC 9728 well-known paths).
    HttpRouter.add("*", `${AUTH_BASE_PATH}/*`, authHandler(currentAuth)),
    HttpRouter.add("*", "/.well-known/*", authHandler(currentAuth))
  )

const CALLBACK_PATH = `${AUTH_BASE_PATH}/callback/`

/**
 * Errors thrown while handling TIDAL's redirect (the allowlist check, TIDAL
 * being down) come back from Better Auth as JSON. The user is in a browser
 * at that point, so they get the sign-in error page instead.
 */
const callbackErrorToPage = async (response: Response) => {
  if (response.status < 400) return response
  const body = await response.json().catch(() => undefined) as
    | { readonly error?: string; readonly error_description?: string; readonly message?: string }
    | undefined
  const params = new URLSearchParams({ error: body?.error ?? "server_error" })
  const description = body?.error_description ?? body?.message
  if (description !== undefined) params.set("error_description", description)
  const headers = new Headers({ location: `${SIGN_IN_ERROR_PATH}?${params}`, "cache-control": "no-store" })
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie)
  return new Response(null, { status: 302, headers })
}

const authHandler = (
  currentAuth: Effect.Effect<CurrentAuth, never, HttpServerRequest.HttpServerRequest | AuthDb>
) =>
(request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function*() {
    const { auth } = yield* currentAuth
    const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie)
    const isCallback = new URL(webRequest.url).pathname.startsWith(CALLBACK_PATH)
    const response = yield* Effect.promise(async () => {
      const response = await auth.handler(webRequest)
      return isCallback ? callbackErrorToPage(response) : response
    })
    return HttpServerResponse.fromWeb(response)
  })
