import { Context, Effect, Layer, type Redacted } from "effect"
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import * as TidalApi from "./generated/TidalApi.ts"
import { TidalAuth, type TidalAuthError } from "./TidalAuth.ts"
import { TidalConfig, type TidalConfigShape } from "./TidalConfig.ts"

export const JSON_API_MEDIA_TYPE = "application/vnd.api+json"

/**
 * The generated TIDAL client, pre-configured with the API base URL, JSON:API
 * content negotiation, a client-credentials bearer token, and retries for
 * transient failures (network errors, 429 and 5xx, honouring `Retry-After`).
 *
 * Operations are keyed by `"METHOD/path"`, e.g.
 *
 * ```ts
 * const tidal = yield* TidalClient
 * const doc = yield* tidal["GET/tracks/{id}"]("75413016", {
 *   params: { countryCode: "US", include: ["artists", "albums"] }
 * })
 * ```
 */
/**
 * Builds a generated TIDAL client that sends `accessToken` as its bearer
 * token: the app's client-credentials token for {@link TidalClient}, or a
 * signed-in user's token for calls made on their behalf.
 */
export const makeClient = <E>(
  http: HttpClient.HttpClient,
  config: TidalConfigShape,
  accessToken: Effect.Effect<string | Redacted.Redacted<string>, E>
): TidalApi.TidalApi<HttpClientError.HttpClientError | E> =>
  TidalApi.make(http.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(config.apiUrl),
        HttpClientRequest.accept(JSON_API_MEDIA_TYPE)
      )
    ),
    HttpClient.mapRequestEffect((request) =>
      Effect.map(accessToken, (token) => HttpClientRequest.bearerToken(request, token))
    ),
    HttpClient.retryTransient({ times: 2 })
  ))

export class TidalClient extends Context.Service<
  TidalClient,
  TidalApi.TidalApi<HttpClientError.HttpClientError | TidalAuthError>
>()("@tidal-mcp/tidal-api/TidalClient") {
  static readonly layer: Layer.Layer<TidalClient, never, TidalAuth | TidalConfig | HttpClient.HttpClient> = Layer
    .effect(
      TidalClient,
      Effect.gen(function*() {
        const config = yield* TidalConfig
        const auth = yield* TidalAuth
        const http = yield* HttpClient.HttpClient
        return makeClient(http, config, auth.accessToken)
      })
    )
}
