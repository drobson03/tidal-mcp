import * as Cloudflare from "@alchemy.run/cloudflare"
import TidalMcpWorker from "@tidal-mcp/worker"
import { Database } from "@tidal-mcp/worker/Database"
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import { Effect } from "effect"

export default Alchemy.Stack(
  "TidalMcp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state()
  },
  Effect.gen(function*() {
    // Creates the D1 database and applies apps/worker/migrations/.
    const db = yield* Database
    const worker = yield* TidalMcpWorker

    return {
      databaseName: db.databaseName,
      url: worker.url,
      mcpEndpoint: Output.map(worker.url, (url) => `${url}/mcp`)
    }
  })
)
