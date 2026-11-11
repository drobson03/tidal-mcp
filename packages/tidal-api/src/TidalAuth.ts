import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TidalConfig } from "./TidalConfig.ts"

export class TidalAuthError extends Schema.TaggedError<TidalAuthError>()("TidalAuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number
})

interface CachedToken {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

/** Refresh this long before the token actually expires. */
const EXPIRY_MARGIN_MS = 60_000

/**
 * Supplies OAuth access tokens for the TIDAL API using the client-credentials
 * grant, which is enough for every catalogue endpoint.
 *
 * Tokens are cached until shortly before they expire. The cache holds a plain
 * value, never an in-flight request, so concurrent Worker requests never wait
 * on I/O started by another request: on a cold cache each one fetches its own
 * token and the last write wins.
 */
export class TidalAuth extends Context.Service<TidalAuth, {
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, TidalAuthError>
  readonly invalidate: Effect.Effect<void>
}>()("@tidal-mcp/tidal-api/TidalAuth") {
  static readonly layer: Layer.Layer<TidalAuth, never, TidalConfig | HttpClient.HttpClient> = Layer.effect(
    TidalAuth,
    Effect.gen(function*() {
      const config = yield* TidalConfig
      const http = yield* HttpClient.HttpClient
      const cache = yield* Ref.make(Option.none<CachedToken>())

      const fetchToken = HttpClientRequest.post(config.tokenUrl).pipe(
        HttpClientRequest.basicAuth(config.clientId, config.clientSecret),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyUrlParams({ grant_type: "client_credentials" }),
        http.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
        Effect.mapError((cause) =>
          new TidalAuthError({ message: "Failed to obtain a TIDAL access token (check TIDAL_CLIENT_ID/SECRET)", cause })
        ),
        Effect.flatMap((body) =>
          Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            const cached: CachedToken = {
              token: Redacted.make(body.access_token),
              expiresAt: now + body.expires_in * 1000 - EXPIRY_MARGIN_MS
            }
            yield* Ref.set(cache, Option.some(cached))
            return cached.token
          })
        ),
        Effect.withSpan("TidalAuth.fetchToken")
      )

      const accessToken = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const cached = yield* Ref.get(cache)
        if (Option.isSome(cached) && cached.value.expiresAt > now) {
          return cached.value.token
        }
        return yield* fetchToken
      })

      return { accessToken, invalidate: Ref.set(cache, Option.none()) }
    })
  )
}
