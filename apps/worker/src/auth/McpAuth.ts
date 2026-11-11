/**
 * Protects the MCP endpoint with Better Auth access tokens.
 *
 * This is `requireMcpAuth` from `@better-auth/mcp` adapted to a Worker. That
 * helper fetches the JWKS over HTTP from the Worker's own URL, which
 * Cloudflare doesn't allow for a Worker calling itself on workers.dev, and
 * would be a wasted round trip anyway. Here the keys come straight from the
 * Better Auth instance. The checks are the same: signature, issuer, `at+jwt`
 * type, audience (the MCP resource), expiry, `azp`, and DPoP binding when the
 * token is sender-constrained. Failures get RFC 9728 / RFC 6750
 * `WWW-Authenticate` challenges, so MCP clients know where to sign in.
 */
import { createResourceServerChallenge } from "@better-auth/oauth-provider"
import { APIError } from "better-auth/api"
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken
} from "better-auth/oauth2"
import { Effect, type Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { type AuthDb, type CurrentAuth, requestOrigin } from "./CurrentAuth.ts"

type AccessTokenClaims = Awaited<ReturnType<typeof verifyJwsAccessToken>>

const unauthorized = (message: string, error?: string) =>
  new APIError("UNAUTHORIZED", error === undefined ? { message } : { message, error, error_description: message })

/** Maps jose failures the way Better Auth's `verifyAccessTokenRequest` does. */
const toVerificationError = (error: unknown): unknown => {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  if (code === "ERR_JWT_EXPIRED") return unauthorized("token expired")
  if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JWKS_INVALID") return error
  if (typeof code === "string" && code.startsWith("ERR_J")) return unauthorized("invalid access token")
  if (error instanceof TypeError) return unauthorized("invalid access token")
  return error
}

export interface McpRequest {
  readonly authorization: string | undefined
  readonly dpop: string | undefined
  readonly method: string
  /** Absolute request URL without the query, as DPoP `htu` expects. */
  readonly url: string
}

/** Verifies an MCP request's access token. Resolves to its claims, or to a challenge response. */
export const verifyMcpRequest = async (
  { auth, issuer, resource }: CurrentAuth,
  request: McpRequest
): Promise<{ readonly claims: AccessTokenClaims } | { readonly response: Response }> => {
  try {
    const authorization = parseAccessTokenAuthorization(request.authorization)
    if (!authorization?.token) throw unauthorized("missing authorization header")
    if (authorization.scheme === "Unknown") {
      // No error code: that keeps the Bearer challenge with `resource_metadata`,
      // so the client can still find where to get a token.
      throw unauthorized("authorization scheme must be Bearer or DPoP")
    }
    const claims = await verifyJwsAccessToken(authorization.token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: auth,
      verifyOptions: { issuer, audience: resource, typ: "at+jwt", requiredClaims: ["azp"] }
    }).catch((error: unknown) => {
      throw toVerificationError(error)
    })
    const { internalAdapter } = await auth.$context
    await enforceDpopBinding({
      payload: claims,
      authorization,
      proofJwt: request.dpop,
      method: request.method,
      url: request.url,
      replayStore: createDpopReplayStore(internalAdapter)
    }).catch((error: unknown) => {
      throw isDpopBindingError(error) ? unauthorized(error.message, error.code) : error
    })
    return { claims }
  } catch (error) {
    const challenge = createResourceServerChallenge(error, resource)
    if (challenge === undefined) throw error
    const headers = new Headers(challenge.headers)
    headers.set("content-type", "application/json")
    return {
      response: new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: challenge.message }, id: null }),
        { status: challenge.statusCode, headers }
      )
    }
  }
}

/** Global router middleware requiring a valid access token on every path under `path`. */
export const layer = (options: {
  readonly path: `/${string}`
  readonly currentAuth: Effect.Effect<CurrentAuth, never, HttpServerRequest.HttpServerRequest | AuthDb>
}): Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request.From<"GlobalRequires", AuthDb>> =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, requestOrigin(request))
        if (url.pathname !== options.path && !url.pathname.startsWith(`${options.path}/`)) {
          return yield* httpEffect
        }
        const current = yield* options.currentAuth
        const result = yield* Effect.promise(() =>
          verifyMcpRequest(current, {
            authorization: request.headers["authorization"],
            dpop: request.headers["dpop"],
            method: request.method,
            url: `${url.origin}${url.pathname}`
          })
        )
        if ("response" in result) return HttpServerResponse.fromWeb(result.response)
        return yield* httpEffect
      }),
    { global: true }
  )
