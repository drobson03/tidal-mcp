import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider"
import { TidalConfig, TidalUser } from "@tidal-mcp/tidal-api"
import { Context, Effect, Option, Redacted } from "effect"
import { HttpClient, HttpServerRequest } from "effect/http"
import * as Allowlist from "./Allowlist.ts"
import { AUTH_BASE_PATH, type Auth, type AuthDatabase, makeAuth } from "./BetterAuth.ts"
import { workersFetchClientMetadata } from "./ClientMetadata.ts"

/**
 * The Better Auth database, provided per request: a Worker's D1 binding is
 * only reachable at request time, so the Worker provides it around the router
 * (see `Worker.ts`), and tests provide an in-memory SQLite database.
 */
export class AuthDb extends Context.Service<AuthDb, AuthDatabase>()("@tidal-mcp/worker/AuthDb") {}

export interface AuthSettings {
  /** `BETTER_AUTH_SECRET`: signs cookies and OAuth state, encrypts stored TIDAL tokens. */
  readonly secret: Redacted.Redacted<string>
  /** `ALLOWED_USERS`: TIDAL user ids, usernames or verified emails. */
  readonly allowedUsers: string
  readonly mcpPath: `/${string}`
  readonly fetchClientMetadata?: ClientMetadataResourceFetch | undefined
}

export interface CurrentAuth {
  readonly auth: Auth
  readonly origin: string
  /** Issuer of access tokens: the auth base URL. */
  readonly issuer: string
  /** The protected MCP resource; access tokens are audience-bound to it. */
  readonly resource: string
}

/** The request's public origin. On Workers this is the hostname Cloudflare routed to the Worker. */
export const requestOrigin = (request: HttpServerRequest.HttpServerRequest): string => {
  try {
    return new URL(request.originalUrl).origin
  } catch {
    return Option.match(HttpServerRequest.toURL(request), {
      onNone: () => "http://localhost",
      onSome: (url) => url.origin
    })
  }
}

/**
 * Builds an Effect that yields the Better Auth instance for the current
 * request, creating one per database binding and origin (the issuer and MCP
 * resource URL depend on it), and reusing it for the isolate's lifetime.
 *
 * TIDAL calls made by Better Auth (code exchange, `/users/me`) run as Effects
 * with the `HttpClient` and `TidalConfig` captured here.
 */
export const make = Effect.fnUntraced(function*(settings: AuthSettings) {
  const services = yield* Effect.context<HttpClient.HttpClient | TidalConfig>()
  const tidal = yield* TidalConfig
  const run = Effect.runPromiseWith(services)
  const allowlist = Allowlist.parse(settings.allowedUsers)
  const instances = new WeakMap<object, Map<string, CurrentAuth>>()

  const create = (database: AuthDatabase, origin: string): CurrentAuth => {
    const auth = makeAuth({
      origin,
      mcpPath: settings.mcpPath,
      database,
      secret: Redacted.value(settings.secret),
      allowlist,
      fetchClientMetadata: settings.fetchClientMetadata ?? workersFetchClientMetadata,
      tidal: {
        clientId: Redacted.value(tidal.clientId),
        clientSecret: Redacted.value(tidal.clientSecret),
        loginUrl: tidal.loginUrl,
        tokenUrl: tidal.tokenUrl,
        scopes: TidalUser.USER_SCOPES,
        exchangeCode: (params) => run(TidalUser.exchangeAuthorizationCode(params)),
        fetchProfile: (accessToken) => run(TidalUser.fetchCurrentUser(accessToken))
      }
    })
    return { auth, origin, issuer: `${origin}${AUTH_BASE_PATH}`, resource: `${origin}${settings.mcpPath}` }
  }

  const current: Effect.Effect<CurrentAuth, never, HttpServerRequest.HttpServerRequest | AuthDb> = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const database = yield* AuthDb
    const origin = requestOrigin(request)
    const key = typeof database === "object" && database !== null ? database : instances
    let byOrigin = instances.get(key)
    if (byOrigin === undefined) {
      byOrigin = new Map()
      instances.set(key, byOrigin)
    }
    let current = byOrigin.get(origin)
    if (current === undefined) {
      current = create(database, origin)
      byOrigin.set(origin, current)
    }
    return current
  })
  return current
})
