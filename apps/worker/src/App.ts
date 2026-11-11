import { layerHttp, SERVER_NAME, SERVER_VERSION } from "@tidal-mcp/mcp"
import { TidalConfig, type TidalConfigShape, TidalLive } from "@tidal-mcp/tidal-api"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import * as CurrentAuth from "./auth/CurrentAuth.ts"
import * as McpAuth from "./auth/McpAuth.ts"
import * as Pages from "./auth/Pages.ts"

export const MCP_PATH = "/mcp"

export interface AppOptions {
  readonly tidal: TidalConfigShape
  readonly auth: Omit<CurrentAuth.AuthSettings, "mcpPath">
}

/**
 * The Worker's HTTP application as a router layer, independent of alchemy so
 * it can be served in-process by tests via `HttpRouter.toWebHandler`.
 *
 * - `POST /mcp`: MCP Streamable HTTP endpoint (protocol 2026-07-28), requiring an OAuth access token
 * - `/.well-known/*`, `/api/auth/*`: OAuth discovery and endpoints (Better Auth)
 * - `/sign-in`, `/consent`: the pages users see while connecting a client
 * - `GET /`: unauthenticated health/info document
 *
 * Requires an `HttpClient` for calling TIDAL (`FetchHttpClient.layer` in
 * production), and the auth database per request (`CurrentAuth.AuthDb`).
 */
export const App = (options: AppOptions) =>
  Layer.unwrap(Effect.gen(function*() {
    const currentAuth = yield* CurrentAuth.make({ ...options.auth, mcpPath: MCP_PATH })
    return Layer.mergeAll(
      layerHttp({ path: MCP_PATH }),
      Pages.layer(currentAuth),
      McpAuth.layer({ path: MCP_PATH, currentAuth }),
      HttpRouter.add(
        "GET",
        "/",
        HttpServerResponse.jsonUnsafe({
          name: SERVER_NAME,
          version: SERVER_VERSION,
          mcp: { path: MCP_PATH, transport: "streamable-http", protocolVersion: "2026-07-28", auth: "oauth" }
        })
      )
    )
  })).pipe(
    Layer.provide(TidalLive),
    Layer.provide(TidalConfig.layer(options.tidal))
  )
