/**
 * End-to-end test of the Worker's HTTP app, served in-process through
 * `HttpRouter.toWebHandler` with an in-memory SQLite auth database (using the
 * same migrations deployed to D1) and TIDAL replaced by a fake `HttpClient`.
 *
 * It walks the whole flow an MCP client and a user go through:
 *
 * 1. the MCP endpoint answers 401 with a `WWW-Authenticate` challenge;
 * 2. the client discovers the protected-resource and authorization-server
 *    metadata, and starts an authorization request (PKCE, CIMD client id);
 * 3. the user lands on `/sign-in`, continues to TIDAL, comes back through the
 *    Better Auth callback, and approves the client on `/consent`;
 * 4. the client exchanges the code for an access token and uses the TIDAL
 *    catalogue tools with a real `McpClient`.
 *
 * TIDAL accounts outside `ALLOWED_USERS` are turned away at the callback.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Redacted } from "effect"
import { McpClient, McpProtocol } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpRouter } from "effect/http"
import { readdirSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { afterAll } from "vitest"
import { App } from "../src/App.ts"
import type { AuthDatabase } from "../src/auth/BetterAuth.ts"
import { AuthDb } from "../src/auth/CurrentAuth.ts"

const ORIGIN = "http://localhost"
const API = "https://api.tidal.test/v2"
const TOKEN_URL = "https://auth.tidal.test/token"
const LOGIN_URL = "https://login.tidal.test/authorize"

const CLIENT_ID = "https://client.test/oauth/client.json"
const CLIENT_REDIRECT = "http://127.0.0.1:33418/callback"

// ---------------------------------------------------------------------------
// Auth database: the deployed migrations, applied to in-memory SQLite.

const database = new DatabaseSync(":memory:")
const migrations = new URL("../migrations/", import.meta.url)
for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
  database.exec(readFileSync(new URL(file, migrations), "utf8"))
}
const requestContext = Context.make(AuthDb, database as AuthDatabase)

// ---------------------------------------------------------------------------
// Fake TIDAL: client-credentials and authorization-code tokens, `/users/me`
// and a few catalogue endpoints.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/vnd.api+json" } })

const daftPunk = { id: "8847", type: "artists", attributes: { name: "Daft Punk", popularity: 0.9 } }

const oneMoreTime = {
  id: "1",
  type: "tracks",
  attributes: {
    title: "One More Time",
    duration: "PT5M20S",
    explicit: false,
    isrc: "GBDUW0000053",
    key: "D",
    keyScale: "MAJOR",
    mediaTags: ["LOSSLESS"],
    popularity: 0.8
  },
  relationships: {
    artists: { data: [{ id: "8847", type: "artists" }], links: { self: "/tracks/1/relationships/artists" } }
  }
}

// ---------------------------------------------------------------------------
// The user's library, for the user-token tools: playlists "Good" and "Gym" of
// their own, a saved "Good Vibes", and the artists on "Good".

const USER_TOKEN = "Bearer tidal-user-token:code-alice"
const links = (self: string, next?: string) => ({ self, ...(next ? { next } : {}) })
const ids = (type: string, list: ReadonlyArray<string>) => ({
  data: list.map((id) => ({ id, type })),
  links: { self: "/relationships" }
})

const playlist = (id: string, name: string) => ({
  id,
  type: "playlists",
  attributes: {
    accessType: "PUBLIC",
    bounded: true,
    createdAt: "2020-01-01T00:00:00Z",
    externalLinks: [],
    lastModifiedAt: "2026-01-01T00:00:00Z",
    name,
    numberOfFollowers: 0,
    numberOfItems: 2,
    playlistType: "USER"
  }
})

const artist = (id: string, name: string) => ({ id, type: "artists", attributes: { name, popularity: 0.5 } })
const ARTISTS = [artist("a1", "Artist One"), artist("a2", "Artist Two")]

const album = (
  id: string,
  title: string,
  albumType: "ALBUM" | "EP" | "SINGLE",
  releaseDate: string,
  artists: ReadonlyArray<string>
) => ({
  id,
  type: "albums",
  attributes: {
    albumType,
    barcodeId: null,
    duration: "PT40M",
    explicit: false,
    mediaTags: [],
    numberOfItems: 10,
    numberOfVolumes: 1,
    popularity: 0.5,
    releaseDate,
    title
  },
  relationships: { artists: ids("artists", artists) }
})

const track = (id: string, title: string, artists: ReadonlyArray<string>, albums: ReadonlyArray<string> = []) => ({
  ...oneMoreTime,
  id,
  attributes: { ...oneMoreTime.attributes, title },
  relationships: { artists: ids("artists", artists), albums: ids("albums", albums) }
})

/** Discographies. Since 2024-11-11, a1 has a new album (and its deluxe edition), a single the user saved and an EP with a2; a2 also has an album the user saved a track from. */
const DISCOGRAPHY: Record<string, ReadonlyArray<ReturnType<typeof album>>> = {
  a1: [
    album("al-old", "Old Album", "ALBUM", "2020-01-01", ["a1"]),
    album("al-new", "New Album", "ALBUM", "2026-03-01", ["a1"]),
    album("al-new-dlx", "New Album (Deluxe Edition)", "ALBUM", "2026-06-01", ["a1"]),
    album("al-single", "Saved Single", "SINGLE", "2025-10-01", ["a1"]),
    album("al-collab", "Collab EP", "EP", "2025-06-01", ["a1", "a2"])
  ],
  a2: [
    album("al-collab", "Collab EP", "EP", "2025-06-01", ["a1", "a2"]),
    album("al-heard", "Heard It", "ALBUM", "2025-02-01", ["a2"])
  ]
}

const libraryRoute = (url: URL): Response | undefined => {
  const cursor = url.searchParams.get("page[cursor]")
  switch (url.pathname.replace(/^\/v2/, "")) {
    case "/playlists":
      return json({
        data: [playlist("pl-good", "Good"), playlist("pl-gym", "Gym")],
        links: links("/playlists")
      })
    case "/userCollectionPlaylists/me/relationships/items":
      return json({
        data: [
          { id: "pl-vibes", type: "playlists", meta: { addedAt: "2025-01-01T00:00:00Z" } },
          { id: "pl-good", type: "playlists", meta: { addedAt: "2024-01-01T00:00:00Z" } }
        ],
        included: [playlist("pl-vibes", "Good Vibes"), playlist("pl-good", "Good")],
        links: links(url.pathname)
      })
    case "/playlists/pl-good/relationships/items":
      // Two pages: a1 is on both tracks, a2 on the first.
      return cursor === null
        ? json({
          data: [{ id: "t1", type: "tracks", meta: { itemId: "i1" } }],
          included: [track("t1", "First", ["a1", "a2", "a1"]), ...ARTISTS],
          links: links(url.pathname, `${url.pathname}?page%5Bcursor%5D=p2`)
        })
        : json({
          data: [{ id: "t2", type: "tracks", meta: { itemId: "i2" } }],
          included: [track("t2", "Second", ["a1"]), ARTISTS[0]],
          links: links(url.pathname)
        })
    case "/userCollectionAlbums/me/relationships/items":
      // Newest release first: the second album is older than `since`, so reading stops.
      return json({
        data: [
          { id: "al-single", type: "albums", meta: { addedAt: "2025-10-02T00:00:00Z" } },
          { id: "al-ancient", type: "albums", meta: { addedAt: "2019-01-01T00:00:00Z" } }
        ],
        included: [DISCOGRAPHY["a1"]![3], album("al-ancient", "Ancient", "ALBUM", "2019-01-01", ["a1"]), ...ARTISTS],
        links: links(url.pathname, `${url.pathname}?page%5Bcursor%5D=never-read`)
      })
    case "/userCollectionTracks/me/relationships/items":
      // A track from another edition of "Heard It" (so a different album id), then one saved long ago.
      return json({
        data: [
          { id: "t9", type: "tracks", meta: { addedAt: "2025-05-01T00:00:00Z" } },
          { id: "t8", type: "tracks", meta: { addedAt: "2023-01-01T00:00:00Z" } }
        ],
        included: [
          track("t9", "Heard It Track", ["a2"], ["al-heard-clean"]),
          track("t8", "Older", ["a1"], ["al-old"]),
          album("al-heard-clean", "Heard It (Clean)", "ALBUM", "2025-02-01", ["a2"]),
          DISCOGRAPHY["a1"]![0],
          ...ARTISTS
        ],
        links: links(url.pathname, `${url.pathname}?page%5Bcursor%5D=never-read`)
      })
  }
  return undefined
}

const catalogueRoute = (url: URL): Response | undefined => {
  const path = url.pathname.replace(/^\/v2/, "")
  if (path === "/artists") {
    const wanted = url.searchParams.getAll("filter[id]")
    return json({ data: ARTISTS.filter((a) => wanted.includes(a.id)), links: links(path) })
  }
  const discography = /^\/artists\/([^/]+)\/relationships\/albums$/.exec(path)
  if (discography) {
    const albums = DISCOGRAPHY[decodeURIComponent(discography[1]!)] ?? []
    return json({ data: albums.map(({ id, type }) => ({ id, type })), included: albums, links: links(path) })
  }
  return undefined
}

/** TIDAL accounts, keyed by the authorization code TIDAL "issues" for them. */
const ACCOUNTS: Record<string, { id: string; username: string; email: string; firstName: string }> = {
  "code-alice": { id: "1001", username: "alice", email: "alice@example.com", firstName: "Alice" },
  "code-mallory": { id: "6666", username: "mallory", email: "mallory@example.com", firstName: "Mallory" }
}

interface TidalRequest {
  readonly method: string
  readonly url: URL
  readonly authorization: string | undefined
  readonly form: URLSearchParams
}

/** Every request the fake TIDAL received. */
const tidalRequests: Array<TidalRequest> = []

const formOf = (body: unknown) =>
  new URLSearchParams(
    typeof body === "object" && body !== null && "body" in body && body.body instanceof Uint8Array
      ? new TextDecoder().decode(body.body)
      : ""
  )

const FakeTidal = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, url) => {
    const form = formOf(request.body)
    const authorization = request.headers["authorization"]
    tidalRequests.push({ method: request.method, url, authorization, form })
    const route = `${request.method} ${url.origin}${url.pathname}`
    const respond = (response: Response) => Effect.succeed(HttpClientResponse.fromWeb(request, response))

    switch (route) {
      case `POST ${TOKEN_URL}`: {
        if (form.get("grant_type") === "client_credentials") {
          return respond(json({ access_token: "tidal-catalogue-token", token_type: "Bearer", expires_in: 86400 }))
        }
        const code = form.get("code") ?? ""
        if (!(code in ACCOUNTS)) return respond(json({ error: "invalid_grant" }, 400))
        return respond(json({
          access_token: `tidal-user-token:${code}`,
          refresh_token: `tidal-refresh:${code}`,
          token_type: "Bearer",
          expires_in: 86400,
          scope: "user.read"
        }))
      }
      case `GET ${API}/users/me`: {
        const account = ACCOUNTS[authorization?.replace("Bearer tidal-user-token:", "") ?? ""]
        if (account === undefined) return respond(json({ errors: [{ status: "401", detail: "Unauthorized" }] }, 401))
        return respond(json({
          data: {
            id: account.id,
            type: "users",
            attributes: {
              username: account.username,
              country: "NO",
              developerAccessTier: "THIRD_PARTY",
              email: account.email,
              emailVerified: true,
              firstName: account.firstName
            }
          },
          links: { self: "/users/me" }
        }))
      }
      case `GET ${API}/searchResults/daft%20punk/relationships/artists`:
        return respond(json({
          data: [{ id: "8847", type: "artists" }],
          included: [daftPunk],
          links: {
            self: "/searchResults/daft%20punk/relationships/artists",
            next: "/searchResults/daft%20punk/relationships/artists?page%5Bcursor%5D=page-2"
          }
        }))
      case `GET ${API}/tracks`:
        return respond(json({ data: [oneMoreTime], included: [daftPunk], links: { self: "/tracks" } }))
      default: {
        const library = libraryRoute(url)
        if (library !== undefined) {
          return respond(
            authorization === USER_TOKEN
              ? library
              : json({ errors: [{ status: "401", detail: "User token required" }] }, 401)
          )
        }
        const catalogue = catalogueRoute(url)
        if (catalogue !== undefined) return respond(catalogue)
        return respond(json({ errors: [{ status: "404", detail: "Resource not found" }] }, 404))
      }
    }
  })
)

/** The MCP client's Client ID Metadata Document, as its URL would serve it. */
const fetchClientMetadata = async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== CLIENT_ID) return new Response("not found", { status: 404 })
  return new Response(
    JSON.stringify({
      client_id: CLIENT_ID,
      client_name: "Test MCP Client",
      redirect_uris: [CLIENT_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    }),
    { headers: { "content-type": "application/json" } }
  )
}

// ---------------------------------------------------------------------------
// The app, and a browser with a cookie jar.

const handler = HttpRouter.toWebHandler(
  App({
    auth: {
      secret: Redacted.make("test-better-auth-secret-at-least-32-characters"),
      allowedUsers: "alice, someone-else@example.com",
      fetchClientMetadata
    },
    tidal: {
      clientId: Redacted.make("client-id"),
      clientSecret: Redacted.make("client-secret"),
      countryCode: "NO",
      apiUrl: API,
      tokenUrl: TOKEN_URL,
      loginUrl: LOGIN_URL
    }
  }).pipe(Layer.provide(FakeTidal)),
  { disableLogger: true }
)
afterAll(() => handler.dispose())

const serve = (input: RequestInfo | URL, init?: RequestInit) =>
  handler.handler(new Request(input, init), requestContext)

const fetchApp = (input: RequestInfo | URL, init?: RequestInit) => Effect.promise(() => serve(input, init))

const readJson = (response: Response) => Effect.promise(() => response.json() as Promise<Record<string, any>>)
const readText = (response: Response) => Effect.promise(() => response.text())

class Browser {
  readonly cookies = new Map<string, string>()

  /** A top-level navigation, with the headers browsers send for one. */
  request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set("accept", "text/html,application/xhtml+xml")
    headers.set("sec-fetch-mode", "navigate")
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "))
    }
    return fetchApp(new URL(path, ORIGIN), { ...init, headers, redirect: "manual" }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          for (const cookie of response.headers.getSetCookie()) {
            const [pair, ...attributes] = cookie.split(";")
            const [name, ...value] = pair!.split("=")
            const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))
            if (expired || value.join("=") === "") this.cookies.delete(name!.trim())
            else this.cookies.set(name!.trim(), value.join("="))
          }
        })
      )
    )
  }

  /** Submits a form the way a browser does: same-origin `Origin` and `Referer`. */
  submit(path: string, fields: Record<string, string>) {
    return this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        referer: `${ORIGIN}${path}`
      },
      body: new URLSearchParams(fields).toString()
    })
  }
}

const location = (response: Response) => {
  if (![302, 303, 307].includes(response.status)) {
    assert.fail(`expected a redirect, got ${response.status}: ${response.headers.get("content-type")}`)
  }
  return new URL(response.headers.get("location")!, ORIGIN)
}

const unescapeHtml = (value: string) =>
  value.replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

const hiddenField = (html: string, name: string) => {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)
  assert.isNotNull(match, `form field ${name}`)
  return unescapeHtml(match![1]!)
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const pkce = Effect.promise(async () => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  return { verifier, challenge }
})

// ---------------------------------------------------------------------------
// The OAuth flow, step by step.

interface Discovery {
  readonly resource: string
  readonly authorizationEndpoint: URL
  readonly tokenEndpoint: string
  readonly scope: string
}

const discover = Effect.gen(function*() {
  const challenge = yield* fetchApp(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" })
  })
  assert.strictEqual(challenge.status, 401)
  const wwwAuthenticate = challenge.headers.get("www-authenticate") ?? ""
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)?.[1]
  assert.isDefined(metadataUrl, `WWW-Authenticate: ${wwwAuthenticate}`)

  const resourceMetadata = yield* readJson(yield* fetchApp(metadataUrl!))
  assert.strictEqual(resourceMetadata["resource"], `${ORIGIN}/mcp`)
  const [issuer] = resourceMetadata["authorization_servers"] as Array<string>
  assert.strictEqual(issuer, `${ORIGIN}/api/auth`)

  const issuerUrl = new URL(issuer!)
  const asMetadataResponse = yield* fetchApp(`${ORIGIN}/.well-known/oauth-authorization-server${issuerUrl.pathname}`)
  assert.strictEqual(asMetadataResponse.status, 200)
  const asMetadata = yield* readJson(asMetadataResponse)
  assert.strictEqual(asMetadata["issuer"], issuer)
  assert.isTrue(asMetadata["client_id_metadata_document_supported"], "CIMD is advertised")
  assert.include(asMetadata["code_challenge_methods_supported"], "S256")

  const scopes = (resourceMetadata["scopes_supported"] ?? asMetadata["scopes_supported"] ?? []) as Array<string>
  return {
    resource: resourceMetadata["resource"] as string,
    authorizationEndpoint: new URL(asMetadata["authorization_endpoint"] as string),
    tokenEndpoint: asMetadata["token_endpoint"] as string,
    scope: scopes.filter((scope) => ["openid", "profile", "offline_access"].includes(scope)).join(" ")
  } satisfies Discovery
})

/** From the authorization request to the TIDAL callback. Returns the browser and where the callback sent it. */
const signIn = Effect.fn("signIn")(function*(discovery: Discovery, tidalCode: string) {
  const browser = new Browser()
  const { verifier, challenge } = yield* pkce
  const state = crypto.randomUUID()
  const authorize = new URL(discovery.authorizationEndpoint)
  for (
    const [name, value] of Object.entries({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      scope: discovery.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: discovery.resource
    })
  ) authorize.searchParams.set(name, value)

  const toSignIn = location(yield* browser.request(authorize.pathname + authorize.search))
  assert.strictEqual(toSignIn.pathname, "/sign-in")

  const signInPage = yield* browser.request(toSignIn.pathname + toSignIn.search)
  assert.strictEqual(signInPage.status, 200)
  const signInHtml = yield* readText(signInPage)
  assert.include(signInHtml, "Continue with TIDAL")

  const toTidal = location(yield* browser.submit("/sign-in", { oauth_query: hiddenField(signInHtml, "oauth_query") }))
  assert.strictEqual(`${toTidal.origin}${toTidal.pathname}`, LOGIN_URL)
  assert.strictEqual(toTidal.searchParams.get("client_id"), "client-id")
  assert.strictEqual(toTidal.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/tidal`)
  assert.strictEqual(toTidal.searchParams.get("code_challenge_method"), "S256")
  assert.include(toTidal.searchParams.get("scope") ?? "", "user.read")

  // The user signs in at TIDAL, which redirects back with a code.
  const callback = new URL("/api/auth/callback/tidal", ORIGIN)
  callback.searchParams.set("code", tidalCode)
  callback.searchParams.set("state", toTidal.searchParams.get("state")!)
  const afterCallback = location(yield* browser.request(callback.pathname + callback.search))
  return { browser, afterCallback, verifier, state }
})

const connect = Effect.gen(function*() {
  const discovery = yield* discover
  const { browser, afterCallback, verifier, state } = yield* signIn(discovery, "code-alice")

  // Better Auth resumes the authorization request, which needs consent.
  assert.strictEqual(afterCallback.pathname, "/consent", afterCallback.href)
  const consentPage = yield* browser.request(afterCallback.pathname + afterCallback.search)
  assert.strictEqual(consentPage.status, 200)
  const consentHtml = yield* readText(consentPage)
  assert.include(consentHtml, "Allow Test MCP Client?")
  assert.include(consentHtml, "<strong>Alice</strong>")
  assert.include(consentHtml, CLIENT_REDIRECT)

  const toClient = location(
    yield* browser.submit("/consent", { oauth_query: hiddenField(consentHtml, "oauth_query"), accept: "true" })
  )
  assert.strictEqual(`${toClient.origin}${toClient.pathname}`, CLIENT_REDIRECT)
  assert.strictEqual(toClient.searchParams.get("state"), state)
  const code = toClient.searchParams.get("code")
  assert.isNotNull(code, toClient.href)

  const tokenResponse = yield* fetchApp(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: discovery.resource
    }).toString()
  })
  const tokens = yield* readJson(tokenResponse)
  assert.strictEqual(tokenResponse.status, 200, JSON.stringify(tokens))
  assert.strictEqual(tokens["token_type"], "Bearer")
  return { discovery, tokens: tokens as { access_token: string; refresh_token?: string } }
})

/** The flow runs once, on first use; the tests after it share its access token. */
let connection: Promise<Effect.Success<typeof connect>> | undefined
const connected = Effect.promise(() => connection ??= Effect.runPromise(connect))

const accessToken = Effect.map(connected, ({ tokens }) => tokens.access_token)

/** An MCP client whose HTTP traffic goes straight to the in-process handler. */
const client = (headers: Record<string, string>) =>
  McpClient.layerHttp({
    name: "test-client",
    version: "0.0.0",
    url: `${ORIGIN}/mcp`,
    protocol: McpProtocol.v2026_07_28,
    headers
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, serve as typeof globalThis.fetch))
  )

const authorized = Layer.unwrap(Effect.map(accessToken, (token) => client({ authorization: `Bearer ${token}` })))

const callTool = Effect.fn("callTool")(function*(name: string, args: Record<string, unknown>) {
  const mcp = yield* McpClient.McpClient
  const tools = yield* mcp.listTools()
  const tool = tools.find((tool) => tool.name === name)
  assert.isDefined(tool, `tool ${name} should be listed`)
  return yield* mcp.callTool({ tool: tool!, arguments: args })
})

describe("worker app", () => {
  it.effect("serves an unauthenticated info document on /", () =>
    Effect.gen(function*() {
      const response = yield* fetchApp(`${ORIGIN}/`)
      assert.strictEqual(response.status, 200)
      const body = yield* readJson(response)
      assert.deepStrictEqual(body["mcp"], {
        path: "/mcp",
        transport: "streamable-http",
        protocolVersion: "2026-07-28",
        auth: "oauth"
      })
    }))

  it.effect("rejects MCP requests without a valid access token", () =>
    Effect.gen(function*() {
      for (const authorization of [undefined, "Bearer not-a-jwt", "Basic dXNlcjpwYXNz"]) {
        const response = yield* fetchApp(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" })
        })
        assert.strictEqual(response.status, 401, `authorization: ${authorization}`)
        assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/)
      }
    }))

  it.effect("connects a client: discovery, TIDAL sign-in, consent and token exchange", () =>
    Effect.gen(function*() {
      const { tokens } = yield* connected
      const [, payload] = tokens.access_token.split(".")
      const claims = JSON.parse(atob(payload!.replaceAll("-", "+").replaceAll("_", "/")))
      assert.include([claims.aud].flat(), `${ORIGIN}/mcp`)
      assert.strictEqual(claims.iss, `${ORIGIN}/api/auth`)
      assert.strictEqual(claims.azp, CLIENT_ID)

      // The code was exchanged with PKCE and the app's TIDAL credentials.
      const exchange = tidalRequests.findLast((request) => request.form.get("grant_type") === "authorization_code")!
      assert.strictEqual(exchange.form.get("code"), "code-alice")
      assert.isNotEmpty(exchange.form.get("code_verifier"))
      assert.strictEqual(exchange.form.get("redirect_uri"), `${ORIGIN}/api/auth/callback/tidal`)
      assert.strictEqual(exchange.authorization, `Basic ${btoa("client-id:client-secret")}`)

      // The stored TIDAL tokens are encrypted at rest.
      const account = database.prepare(`select "accountId", "accessToken" from "account" where "providerId" = 'tidal'`)
        .get() as { accountId: string; accessToken: string }
      assert.strictEqual(account.accountId, "1001")
      assert.notInclude(account.accessToken, "tidal-user-token")
    }))

  it.effect("turns away TIDAL accounts that aren't on the allowlist", () =>
    Effect.gen(function*() {
      const discovery = yield* discover
      const { browser, afterCallback } = yield* signIn(discovery, "code-mallory")
      assert.strictEqual(afterCallback.pathname, "/sign-in/error", afterCallback.href)
      assert.isFalse([...browser.cookies.keys()].some((name) => name.includes("session_token")), "no session")

      const errorPage = yield* browser.request(afterCallback.pathname + afterCallback.search)
      assert.strictEqual(errorPage.status, 400)
      const errorHtml = yield* readText(errorPage)
      assert.include(errorHtml, "Sign-in failed")
      assert.include(errorHtml, "This TIDAL account is not allowed to use this server")

      const users = database.prepare(`select count(*) as count from "user" where "tidalUserId" = '6666'`).get() as {
        count: number
      }
      assert.strictEqual(users.count, 0)
    }))

  it.effect("lists the TIDAL tools over 2026-07-28 Streamable HTTP", () =>
    Effect.gen(function*() {
      const mcp = yield* McpClient.McpClient
      assert.strictEqual(mcp.protocolVersion, "2026-07-28")
      assert.strictEqual(mcp.serverInfo?.name, "tidal")
      const tools = yield* mcp.listTools()
      assert.includeMembers(tools.map((tool) => tool.name), [
        "search",
        "get_tracks",
        "get_album_tracks",
        "get_artist",
        "get_playlist_items"
      ])
      for (const tool of tools) assert.isTrue(tool.annotations?.readOnlyHint, `${tool.name} is read-only`)
    }).pipe(Effect.provide(authorized)))

  it.effect("search returns simplified results with a cursor", () =>
    Effect.gen(function*() {
      const result = yield* callTool("search", { query: "daft punk", type: "artists" })
      assert.isFalse(result.isError, JSON.stringify(result.content))
      assert.deepStrictEqual(result.structuredContent, {
        data: [{ id: "8847", type: "artists", name: "Daft Punk", popularity: 0.9 }],
        nextCursor: "page-2"
      })

      const search = tidalRequests.find((request) => request.url.pathname.includes("/searchResults/"))!
      assert.strictEqual(search.authorization, "Bearer tidal-catalogue-token")
      assert.strictEqual(search.url.searchParams.get("countryCode"), "NO")
      assert.strictEqual(search.url.searchParams.get("explicitFilter"), "INCLUDE")
      assert.deepStrictEqual(search.url.searchParams.getAll("include"), ["artists"])
    }).pipe(Effect.provide(authorized)))

  it.effect("get_tracks resolves included artists", () =>
    Effect.gen(function*() {
      const result = yield* callTool("get_tracks", { ids: ["1"], countryCode: "US" })
      assert.isFalse(result.isError, JSON.stringify(result.content))
      const [track] = (result.structuredContent as { data: Array<Record<string, unknown>> }).data
      assert.strictEqual(track!["title"], "One More Time")
      assert.deepStrictEqual(track!["artists"], [{ id: "8847", type: "artists", name: "Daft Punk", popularity: 0.9 }])

      const lookup = tidalRequests.findLast((request) => request.url.pathname.endsWith("/tracks"))!
      assert.deepStrictEqual(lookup.url.searchParams.getAll("filter[id]"), ["1"])
      assert.strictEqual(lookup.url.searchParams.get("countryCode"), "US")
    }).pipe(Effect.provide(authorized)))

  it.effect("maps TIDAL 404s to an isError tool result", () =>
    Effect.gen(function*() {
      const result = yield* callTool("get_artist", { id: "missing" })
      assert.isTrue(result.isError)
      const text = result.content[0]
      assert.strictEqual(text?.type, "text")
      assert.match((text as { text: string }).text, /Not found.*Resource not found/)
    }).pipe(Effect.provide(authorized)))

  it.effect("find_my_playlists finds owned and saved playlists with the user's token", () =>
    Effect.gen(function*() {
      const result = yield* callTool("find_my_playlists", { query: "good" })
      assert.isFalse(result.isError, JSON.stringify(result.content))
      const { playlists } = (result.structuredContent as { data: { playlists: Array<Record<string, unknown>> } }).data
      assert.deepStrictEqual(playlists.map((p) => [p["id"], p["owned"], p["saved"]]), [
        ["pl-good", true, true],
        ["pl-vibes", false, true]
      ])
      const owned = tidalRequests.findLast((request) => request.url.pathname.endsWith("/playlists"))!
      assert.strictEqual(owned.authorization, USER_TOKEN)
      assert.deepStrictEqual(owned.url.searchParams.getAll("filter[owners.id]"), ["me"])
    }).pipe(Effect.provide(authorized)))

  it.effect("get_playlist_artists reads every page of a playlist", () =>
    Effect.gen(function*() {
      const result = yield* callTool("get_playlist_artists", { id: "pl-good" })
      assert.isFalse(result.isError, JSON.stringify(result.content))
      assert.deepStrictEqual(result.structuredContent, {
        data: {
          playlistId: "pl-good",
          itemsRead: 2,
          artists: [{ id: "a1", name: "Artist One", tracks: 2 }, { id: "a2", name: "Artist Two", tracks: 1 }]
        }
      })
    }).pipe(Effect.provide(authorized)))

  it.effect("get_new_releases leaves out what's already in the library", () =>
    Effect.gen(function*() {
      const result = yield* callTool("get_new_releases", { artistIds: ["a1", "a2"], since: "2024-11-11" })
      assert.isFalse(result.isError, JSON.stringify(result.content))
      const data = (result.structuredContent as { data: Record<string, any> }).data
      assert.deepStrictEqual(
        data["releases"].map((r: Record<string, unknown>) => [r["id"], r["type"], r["otherVersionIds"]]),
        [["al-new", "ALBUM", ["al-new-dlx"]], ["al-collab", "EP", undefined]]
      )
      assert.deepStrictEqual(data["releases"][1]["artists"], [
        { id: "a1", name: "Artist One" },
        { id: "a2", name: "Artist Two" }
      ])
      // "Saved Single" is a saved album; "Heard It" is saved through a track from another edition.
      assert.strictEqual(data["leftOutAlreadyInLibrary"], 2)
      assert.strictEqual(data["artistsChecked"], 2)
      assert.isUndefined(data["notes"])
      // Library reading stopped at the first page of each, once past `since`.
      const libraryReads = tidalRequests.filter((request) => request.url.pathname.includes("/userCollection"))
      assert.isFalse(libraryReads.some((request) => request.url.searchParams.get("page[cursor]") === "never-read"))
    }).pipe(Effect.provide(authorized)))

  it.effect("get_new_releases stops at the request budget and says which artists are left", () =>
    Effect.gen(function*() {
      // Budget 40: 2 library pages, 2 name lookups, then 36 discographies.
      const artistIds = ["a1", "a2", ...Array.from({ length: 38 }, (_, i) => `x${i + 3}`)]
      const result = yield* callTool("get_new_releases", { artistIds, since: "2024-11-11" })
      assert.isFalse(result.isError, JSON.stringify(result.content))
      const data = (result.structuredContent as { data: Record<string, any> }).data
      assert.lengthOf(data["remainingArtistIds"], 4)
      assert.notInclude(data["remainingArtistIds"], "a1")
      assert.strictEqual(data["artistsChecked"], 36)
      assert.match(data["notes"][0], /remainingArtistIds/)
      assert.lengthOf(data["releases"], 2)
    }).pipe(Effect.provide(authorized)))

  it.effect("get_my_collection maps sorts to TIDAL's", () =>
    Effect.gen(function*() {
      const result = yield* callTool("get_my_collection", { type: "albums", sort: "releaseDate" })
      assert.isFalse(result.isError, JSON.stringify(result.content))
      const read = tidalRequests.findLast((request) => request.url.pathname.includes("/userCollectionAlbums/"))!
      assert.deepStrictEqual(read.url.searchParams.getAll("sort"), ["-releaseDate"])

      const unsupported = yield* callTool("get_my_collection", { type: "artists", sort: "releaseDate" })
      assert.isTrue(unsupported.isError)
    }).pipe(Effect.provide(authorized)))

  it.effect("fetches the TIDAL catalogue token once and reuses it", () =>
    Effect.sync(() => {
      const tokenRequests = tidalRequests.filter((request) => request.form.get("grant_type") === "client_credentials")
      assert.strictEqual(tokenRequests.length, 1)
      assert.strictEqual(tokenRequests[0]!.authorization, `Basic ${btoa("client-id:client-secret")}`)
    }))
})
