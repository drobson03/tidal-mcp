/**
 * The Better Auth instance: an OAuth 2.1 authorization server for MCP
 * clients, with "Sign in with TIDAL" as the only way to log in.
 *
 * - `mcp()` turns Better Auth into the authorization server for the `/mcp`
 *   resource. It serves the RFC 9728 protected-resource metadata and issues
 *   audience-bound JWT access tokens signed by the `jwt()` plugin.
 * - `cimd()` lets MCP clients identify themselves with a Client ID Metadata
 *   Document URL, which MCP 2026-07-28 uses instead of dynamic registration.
 * - `genericOAuth()` adds TIDAL as a social provider (authorization code +
 *   PKCE). The token exchange and `/users/me` lookup run through the app's
 *   Effect `HttpClient`, so tests can fake TIDAL.
 *
 * Only TIDAL accounts on the allowlist can sign in, and the list is checked
 * again whenever an access token is issued or refreshed.
 */
import { cimd } from "@better-auth/cimd"
import { mcp } from "@better-auth/mcp"
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider"
import type { TidalUser } from "@tidal-mcp/tidal-api"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import { APIError } from "better-auth/api"
import { genericOAuth, jwt } from "better-auth/plugins"
import * as Allowlist from "./Allowlist.ts"

export const AUTH_BASE_PATH = "/api/auth"
export const SIGN_IN_PATH = "/sign-in"
export const SIGN_IN_ERROR_PATH = "/sign-in/error"
export const CONSENT_PATH = "/consent"
export const TIDAL_PROVIDER_ID = "tidal"

/** A D1 binding in the Worker, or a `node:sqlite` database in tests and migration generation. */
export type AuthDatabase = BetterAuthOptions["database"]

export interface TidalSignIn {
  readonly clientId: string
  readonly clientSecret: string
  readonly loginUrl: string
  readonly tokenUrl: string
  readonly scopes: ReadonlyArray<string>
  readonly exchangeCode: (params: {
    readonly code: string
    readonly codeVerifier: string | undefined
    readonly redirectUri: string
  }) => Promise<TidalUser.UserTokenResponse>
  readonly fetchProfile: (accessToken: string) => Promise<TidalUser.TidalUserProfile>
}

export interface AuthConfig {
  /** Public origin of the Worker, e.g. `https://tidal-mcp.example.workers.dev`. */
  readonly origin: string
  readonly mcpPath: `/${string}`
  readonly database: AuthDatabase
  readonly secret: string
  readonly allowlist: Allowlist.Allowlist
  readonly tidal: TidalSignIn
  /** Transport for fetching Client ID Metadata Documents (see `ClientMetadata.ts`). */
  readonly fetchClientMetadata: ClientMetadataResourceFetch
}

const notAllowed = () =>
  new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description: "This TIDAL account is not allowed to use this server",
    message: "This TIDAL account is not allowed to use this server"
  })

/**
 * TIDAL failures while signing in end on the sign-in error page instead of a
 * bare 500. The cause is logged by Better Auth.
 */
const tidalFailed = (what: string) => (cause: unknown): never => {
  console.error(`TIDAL sign-in: failed to ${what}`, cause)
  throw new APIError("BAD_GATEWAY", {
    error: "temporarily_unavailable",
    error_description: `Couldn't ${what} with TIDAL. Try again in a moment.`,
    message: `Couldn't ${what} with TIDAL. Try again in a moment.`
  })
}

/** TIDAL doesn't always share an email, but Better Auth users need one. */
const placeholderEmail = (tidalUserId: string) => `tidal-${tidalUserId}@users.tidal-mcp.invalid`

export const authOptions = (config: AuthConfig) => {
  const { tidal, allowlist } = config
  return {
    appName: "TIDAL MCP",
    baseURL: config.origin,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database: config.database,
    telemetry: { enabled: false },
    // Access tokens are JWTs from the jwt plugin; its session-token endpoint
    // would mint JWTs with the same key, so it stays off. Profile edits are
    // off because users are TIDAL accounts.
    disabledPaths: ["/token", "/update-user", "/delete-user", "/change-email"],
    // `input: true` is what lets the TIDAL profile set these at sign-in;
    // Better Auth drops `input: false` fields from provider profiles too.
    // Users can't set them: there's no email sign-up and `/update-user` is
    // disabled, so TIDAL sign-in is the only way user data is written.
    user: {
      additionalFields: {
        tidalUserId: { type: "string", required: false, input: true },
        tidalUsername: { type: "string", required: false, input: true }
      }
    },
    account: { encryptOAuthTokens: true },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    onAPIError: { errorURL: SIGN_IN_ERROR_PATH },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      genericOAuth({
        config: [{
          providerId: TIDAL_PROVIDER_ID,
          name: "TIDAL",
          authorizationUrl: tidal.loginUrl,
          tokenUrl: tidal.tokenUrl,
          clientId: tidal.clientId,
          clientSecret: tidal.clientSecret,
          scopes: [...tidal.scopes],
          pkce: true,
          overrideUserInfo: true,
          getToken: async ({ code, codeVerifier, redirectURI }) => {
            const tokens = await tidal.exchangeCode({ code, codeVerifier, redirectUri: redirectURI })
              .catch(tidalFailed("complete the sign-in"))
            return {
              tokenType: tokens.token_type,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
              scopes: tokens.scope?.split(" ") ?? [...tidal.scopes],
              raw: { ...tokens }
            }
          },
          getUserInfo: async (tokens) => {
            if (tokens.accessToken === undefined) return null
            const profile = await tidal.fetchProfile(tokens.accessToken).catch(tidalFailed("read your account"))
            const identity = {
              tidalUserId: profile.id,
              username: profile.username,
              email: profile.email,
              emailVerified: profile.emailVerified
            }
            if (!Allowlist.isAllowed(allowlist, identity)) throw notAllowed()
            return {
              id: profile.id,
              name: [profile.firstName, profile.lastName].filter(Boolean).join(" ") || profile.username,
              email: profile.email ?? placeholderEmail(profile.id),
              emailVerified: profile.email !== undefined && profile.emailVerified,
              tidalUserId: profile.id,
              tidalUsername: profile.username
            }
          },
          mapProfileToUser: (profile) => ({
            tidalUserId: typeof profile["tidalUserId"] === "string" ? profile["tidalUserId"] : undefined,
            tidalUsername: typeof profile["tidalUsername"] === "string" ? profile["tidalUsername"] : undefined
          })
        }]
      }),
      mcp({
        loginPage: SIGN_IN_PATH,
        consentPage: CONSENT_PATH,
        resource: `${config.origin}${config.mcpPath}`,
        // Re-check the allowlist on every issuance, including refreshes, so
        // removing someone locks them out once their access token expires.
        customAccessTokenClaims: ({ user }) => {
          if (user === undefined) return {}
          const allowed = user !== null && Allowlist.isAllowed(allowlist, {
            tidalUserId: user["tidalUserId"] as string | undefined,
            username: user["tidalUsername"] as string | undefined,
            email: user.email,
            emailVerified: user.emailVerified
          })
          if (!allowed) throw notAllowed()
          return {}
        }
      }),
      cimd({
        fetchClientMetadataResource: config.fetchClientMetadata,
        metadataProfile: "mcp-2026-07-28"
      })
    ]
  } satisfies BetterAuthOptions
}

export const makeAuth = (config: AuthConfig) => betterAuth(authOptions(config))
export type Auth = ReturnType<typeof makeAuth>
