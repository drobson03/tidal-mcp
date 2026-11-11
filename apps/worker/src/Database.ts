import * as Cloudflare from "@alchemy.run/cloudflare"

/**
 * The D1 database behind Better Auth: users, sessions, linked TIDAL accounts,
 * OAuth clients, consents, tokens and signing keys.
 *
 * Alchemy applies the SQL files in `apps/worker/migrations/` on every deploy,
 * in numeric order, skipping ones already applied (tracked in its
 * `__alchemy_migrations` table). The path is relative to the repo root, where
 * `alchemy deploy` runs. Write new files with `pnpm --filter @tidal-mcp/worker auth:generate`.
 */
export const Database = Cloudflare.D1.Database("Auth", {
  migrations: "./apps/worker/migrations"
})
