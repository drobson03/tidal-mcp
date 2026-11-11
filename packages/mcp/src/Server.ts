import { Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { TidalToolkitHandlers } from "./Handlers.ts"
import { TidalToolkit } from "./Tools.ts"

export const SERVER_NAME = "tidal"
export const SERVER_VERSION = "0.1.0"

export const INSTRUCTIONS = `Tools for the TIDAL music catalogue (read-only).
Start with \`search\` to find ids, then use the get_* tools for details.
Ids are per resource type (track, album, artist, playlist); playlist ids are UUIDs.
Availability depends on the market: pass \`countryCode\` to look at a specific country.
List tools are paginated: when a result has \`nextCursor\`, pass it back as \`cursor\` for more.`

/**
 * Registers the TIDAL toolkit with an `McpServer`. Requires `TidalClient` and
 * `TidalConfig`; pass it to a transport layer as `registrations`.
 */
export const TidalTools = McpServer.toolkit(TidalToolkit).pipe(Layer.provide(TidalToolkitHandlers))

const serverInfo = {
  name: SERVER_NAME,
  version: SERVER_VERSION,
  description: "Search and browse the TIDAL music catalogue",
  websiteUrl: "https://developer.tidal.com",
  instructions: INSTRUCTIONS
}

/**
 * Streamable HTTP endpoint for serverless hosts such as Cloudflare Workers.
 *
 * Each POST runs its own MCP server in the request scope, so nothing outlives
 * the request. That requires the sessionless `2026-07-28` protocol: sessionful
 * revisions keep session state in memory, which a Worker isolate cannot
 * promise to keep between requests.
 */
export const layerHttp = (options: { readonly path: `/${string}` }) =>
  McpServer.layerHttpRequestScoped({
    ...serverInfo,
    path: options.path,
    protocols: [McpProtocol.v2026_07_28],
    registrations: TidalTools
  })
