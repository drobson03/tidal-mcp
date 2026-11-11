import * as Cloudflare from "@alchemy.run/cloudflare"
import { tidalConfig } from "@tidal-mcp/tidal-api"
import * as Alchemy from "alchemy"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { App } from "./App.ts"
import type { AuthDatabase } from "./auth/BetterAuth.ts"
import { AuthDb } from "./auth/CurrentAuth.ts"
import { Database } from "./Database.ts"

/**
 * The TIDAL MCP server as a Cloudflare Worker.
 *
 * The generator below is the Construction phase: it runs at deploy time and
 * again when an isolate boots. Every `Config` yielded here is bound onto the
 * Worker as a secret by alchemy, then read back from the binding at runtime.
 * `BETTER_AUTH_SECRET` is an `Alchemy.Random` instead: generated on the first
 * deploy, kept in stack state, and bound the same way.
 * The router layer is built once per isolate; each request runs its own MCP
 * server (see `McpServer.layerHttpRequestScoped`), with the D1 binding
 * provided as the auth database.
 */
export default class TidalMcpWorker extends Cloudflare.Worker<TidalMcpWorker>()(
  "TidalMcp",
  {
    main: import.meta.url,
    observability: { enabled: true },
    // Client ID Metadata Documents are fetched from URLs that MCP clients
    // choose; this flag stops those fetches from reaching private addresses.
    compatibility: { flags: ["global_fetch_strictly_public"] }
  },
  Effect.gen(function*() {
    const tidal = yield* tidalConfig
    // 32 random bytes, hex-encoded. Destroying the stack discards it, which
    // signs everyone out and makes stored TIDAL tokens unreadable.
    const authSecret = yield* Alchemy.Random("BetterAuthSecret")
    const secret = yield* authSecret.text
    const allowedUsers = yield* Config.String("ALLOWED_USERS")
    const db = yield* Cloudflare.D1.QueryDatabase(Database)

    // `IllegalArgumentError` here means a misconfigured McpServer (e.g. a
    // sessionful protocol on the request-scoped transport): a bug, not an
    // operational failure.
    const app = yield* HttpRouter.toHttpEffect(
      App({ tidal, auth: { secret, allowedUsers } }).pipe(Layer.provide(FetchHttpClient.layer))
    ).pipe(Effect.orDie)

    const fetch = Effect.flatMap(
      db.raw,
      (raw) => Effect.provideService(app, AuthDb, raw as unknown as AuthDatabase)
    )

    return { fetch }
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
) {}
