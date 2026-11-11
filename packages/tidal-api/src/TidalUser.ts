/**
 * TIDAL user sign-in: the OAuth 2 authorization-code grant with PKCE.
 *
 * Client credentials ({@link TidalAuth}) only reach the public catalogue. A
 * user access token, obtained here, acts as that user: `GET /users/me`,
 * their collection, playlists and so on, within the granted scopes.
 */
import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import * as TidalApi from "./generated/TidalApi.ts"
import { TidalAuthError } from "./TidalAuth.ts"
import { JSON_API_MEDIA_TYPE } from "./TidalClient.ts"
import { TidalConfig } from "./TidalConfig.ts"

/** Scopes requested at sign-in. `user.read` covers `GET /users/me`. */
export const USER_SCOPES = ["user.read"] as const

export const UserTokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String)
})
export type UserTokenResponse = typeof UserTokenResponse.Type

/**
 * Exchanges an authorization code for user tokens.
 *
 * TIDAL apps are confidential clients, so the request authenticates with the
 * client secret (HTTP Basic) in addition to the PKCE verifier.
 */
export const exchangeAuthorizationCode = Effect.fn("TidalUser.exchangeAuthorizationCode")(function*(params: {
  readonly code: string
  readonly codeVerifier: string | undefined
  readonly redirectUri: string
}) {
  const config = yield* TidalConfig
  const http = yield* HttpClient.HttpClient
  return yield* HttpClientRequest.post(config.tokenUrl).pipe(
    HttpClientRequest.basicAuth(config.clientId, config.clientSecret),
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyUrlParams({
      grant_type: "authorization_code",
      client_id: Redacted.value(config.clientId),
      code: params.code,
      redirect_uri: params.redirectUri,
      ...(params.codeVerifier === undefined ? {} : { code_verifier: params.codeVerifier })
    }),
    http.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UserTokenResponse)),
    Effect.mapError((cause) => new TidalAuthError({ message: "TIDAL rejected the authorization code", cause }))
  )
})

/** The signed-in user's account, from `GET /users/me`. */
export interface TidalUserProfile {
  readonly id: string
  readonly username: string
  readonly country: string
  readonly email: string | undefined
  readonly emailVerified: boolean
  readonly firstName: string | undefined
  readonly lastName: string | undefined
}

/** Reads the account behind a user access token (needs the `user.read` scope). */
export const fetchCurrentUser = Effect.fn("TidalUser.fetchCurrentUser")(function*(accessToken: string) {
  const config = yield* TidalConfig
  const http = yield* HttpClient.HttpClient
  const api = TidalApi.make(http.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(config.apiUrl),
        HttpClientRequest.accept(JSON_API_MEDIA_TYPE),
        HttpClientRequest.bearerToken(accessToken)
      )
    ),
    HttpClient.retryTransient({ times: 2 })
  ))
  const { data } = yield* api["GET/users/{id}"]("me", undefined).pipe(
    Effect.mapError((cause) => new TidalAuthError({ message: "Failed to read the TIDAL account", cause }))
  )
  const attributes = data.attributes
  if (attributes === undefined) {
    return yield* new TidalAuthError({ message: "TIDAL returned an account without attributes" })
  }
  return {
    id: data.id,
    username: attributes.username,
    country: attributes.country,
    email: attributes.email,
    emailVerified: attributes.emailVerified ?? false,
    firstName: attributes.firstName,
    lastName: attributes.lastName
  } satisfies TidalUserProfile
})
