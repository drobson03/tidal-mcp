import { Config, Context, Layer } from "effect"
import type { Redacted } from "effect"

export interface TidalConfigShape {
  /** OAuth client id of a TIDAL developer app. */
  readonly clientId: Redacted.Redacted<string>
  /** OAuth client secret of a TIDAL developer app. */
  readonly clientSecret: Redacted.Redacted<string>
  /** ISO 3166-1 alpha-2 market used when a call does not pass `countryCode`. */
  readonly countryCode: string
  /** Base URL of the JSON:API, e.g. `https://openapi.tidal.com/v2`. */
  readonly apiUrl: string
  /** OAuth 2 token endpoint. */
  readonly tokenUrl: string
  /** OAuth 2 authorization endpoint, where users sign in to TIDAL. */
  readonly loginUrl: string
  /**
   * Most TIDAL requests one tool call may make (default
   * {@link DEFAULT_REQUEST_BUDGET}). Tools that walk many pages stop at the
   * budget and say how to continue. Cloudflare caps outbound requests per
   * Worker invocation (50 on the Free plan), so raise this only on Paid.
   */
  readonly requestBudget?: number | undefined
}

export const DEFAULT_API_URL = "https://openapi.tidal.com/v2"
export const DEFAULT_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token"
export const DEFAULT_LOGIN_URL = "https://login.tidal.com/authorize"
export const DEFAULT_REQUEST_BUDGET = 40

/**
 * The `Config` description of the TIDAL settings, read from:
 *
 * - `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` (required)
 * - `TIDAL_COUNTRY_CODE` (default `US`)
 * - `TIDAL_API_URL` / `TIDAL_TOKEN_URL` / `TIDAL_LOGIN_URL` (default production endpoints)
 * - `TIDAL_REQUEST_BUDGET` (default 40 requests per tool call)
 *
 * On Cloudflare, yield this in the Worker's Construction phase so alchemy
 * binds the values onto the Worker as secrets.
 */
export const tidalConfig: Config.Config<TidalConfigShape> = Config.all({
  clientId: Config.Redacted("TIDAL_CLIENT_ID"),
  clientSecret: Config.Redacted("TIDAL_CLIENT_SECRET"),
  countryCode: Config.String("TIDAL_COUNTRY_CODE").pipe(Config.withDefault("US")),
  apiUrl: Config.String("TIDAL_API_URL").pipe(Config.withDefault(DEFAULT_API_URL)),
  tokenUrl: Config.String("TIDAL_TOKEN_URL").pipe(Config.withDefault(DEFAULT_TOKEN_URL)),
  loginUrl: Config.String("TIDAL_LOGIN_URL").pipe(Config.withDefault(DEFAULT_LOGIN_URL)),
  requestBudget: Config.Int("TIDAL_REQUEST_BUDGET").pipe(Config.withDefault(DEFAULT_REQUEST_BUDGET))
})

export class TidalConfig extends Context.Service<TidalConfig, TidalConfigShape>()(
  "@tidal-mcp/tidal-api/TidalConfig"
) {
  static readonly layer = (config: TidalConfigShape): Layer.Layer<TidalConfig> => Layer.succeed(TidalConfig, config)
}
