# TIDAL MCP

An [MCP](https://modelcontextprotocol.io) server for the [TIDAL API](https://developer.tidal.com), built with
[Effect v4](https://effect.website) and deployed to Cloudflare Workers with [alchemy](https://alchemy.run).

```
packages/tidal-api   Effect HttpClient generated from TIDAL's OpenAPI spec (@effect/openapi-generator),
                     plus client-credentials auth and JSON:API helpers
packages/mcp         Tool definitions + handlers (effect/ai Tool, Toolkit, McpServer)
apps/worker          Cloudflare Worker: Streamable HTTP endpoint, OAuth (Better Auth + D1), end-to-end tests
alchemy.run.ts       The alchemy Stack that deploys the Worker
```

## Tools

All read-only, against the TIDAL catalogue:

| Tool | What it does |
| --- | --- |
| `search` | Top hits, or tracks / albums / artists / playlists / videos |
| `search_suggestions` | Autocomplete a partial query |
| `get_tracks` | Tracks by id or ISRC, with artists and album |
| `get_similar_tracks` | Tracks similar to a track |
| `get_track_lyrics` | Lyrics, when available |
| `get_albums` | Albums by id or barcode, with artists and cover art |
| `get_album_tracks` | An album's track list |
| `get_artist` | Artist profile, biography and profile art |
| `get_artist_albums` | Discography |
| `get_artist_tracks` | Top tracks |
| `get_similar_artists` | Artists similar to an artist |
| `get_playlist` / `get_playlist_items` | Playlist details and contents |

Responses are JSON:API documents flattened for readability: attributes are inlined and included relationships are
resolved. List tools return a `nextCursor` you pass back as `cursor`. `countryCode` defaults to `TIDAL_COUNTRY_CODE`.

## Setup

1. Create an app at <https://developer.tidal.com/dashboard> to get a client id and secret.
2. `pnpm install`
3. `cp .env.example .env` and fill it in: `openssl rand -base64 32` gives you a `BETTER_AUTH_SECRET`, and
   `ALLOWED_USERS` lists who may connect.

## Deploy to Cloudflare

```sh
pnpm alchemy profile edit --add Cloudflare   # once: OAuth or API token
pnpm deploy                                  # prints the Worker url and mcpEndpoint
```

The secrets in `.env` are read in the Worker's Construction phase, so alchemy binds them as Worker secrets. The
deploy also creates the `Auth` D1 database (`apps/worker/src/Database.ts`) and applies any new files in
`apps/worker/migrations/`, tracked in alchemy's `__alchemy_migrations` table. `pnpm dev` runs the stack locally
with live reload, and `pnpm destroy` tears it down.

After the first deploy, add `https://<worker>/api/auth/callback/tidal` as a redirect URI on the TIDAL app.

Connect a client to `https://<worker>/mcp`. `GET /` is an unauthenticated health/info document.

## Auth

The Worker is an OAuth 2.1 authorization server for its own `/mcp` endpoint, built on
[Better Auth](https://better-auth.com) (`@better-auth/mcp`, `@better-auth/cimd`) with state in D1. MCP clients need
no configuration beyond the URL:

1. `/mcp` answers `401` with a `WWW-Authenticate` challenge pointing at `/.well-known/oauth-protected-resource/mcp`,
   which names the authorization server (`/api/auth`).
2. The client identifies itself with a Client ID Metadata Document URL, as MCP
   `2026-07-28` expects, and starts an authorization-code + PKCE request.
3. The user signs in with TIDAL (`/sign-in`), then approves the client (`/consent`).
4. The client gets a short-lived JWT access token, audience-bound to `https://<worker>/mcp`, plus a refresh token.

Only TIDAL accounts in `ALLOWED_USERS` (id, username, or verified email) can sign in. The list is checked again
whenever a token is issued or refreshed, so removing someone and redeploying locks them out once their current access
token expires. The user's TIDAL tokens are stored encrypted. The catalogue tools still use the app's
client-credentials token, so they show the same catalogue for every user.

Access tokens are checked against the Worker's own signing keys (no JWKS round-trip), including DPoP binding when a
client uses it. The sign-in and consent pages are plain HTML forms with a strict CSP and no scripts.

Migrations are applied only by alchemy, on deploy. If you change Better Auth plugins or user fields, generate the
next migration file (it writes only what's new, and never connects to D1), then deploy:

```sh
pnpm --filter @tidal-mcp/worker auth:generate
pnpm deploy
```

### Protocol note

The Worker serves the **sessionless MCP `2026-07-28`** Streamable HTTP protocol through
`McpServer.layerHttpRequestScoped`: each POST runs its own server inside the request, which is what Workers need.
Older, sessionful revisions keep session state in memory, and a Worker isolate can't promise to keep that between
requests, so the Worker doesn't serve them.

## Regenerating the client

```sh
pnpm generate      # from packages/tidal-api/spec/tidal-api-oas.json
pnpm spec:update   # download the latest spec, then generate
```

`scripts/generate.ts` makes two changes to the spec before running the generator:

- **Prunes** it to read-only (`GET`) catalogue resources, plus `users` for sign-in: 97 of 330 paths. Edit `RESOURCES` and `METHODS` to widen it.
- **Pins discriminators.** TIDAL's `included` array is a `oneOf` with a `type` discriminator, but every resource
  declares `type` as a plain string. The generator ignores discriminators, so without this step every response with
  `included` fails to decode ("Expected exactly one member to match").

The generated schemas decode strictly. If TIDAL adds an enum value, the affected tool returns an error that says to run
`pnpm spec:update`.

## Development

```sh
pnpm typecheck
pnpm test        # in-process e2e: OAuth flow + McpClient → Worker app (SQLite) → fake TIDAL
```

Versions are pinned to Effect `4.1.2` and alchemy `2.0.0-beta.85`. Effect 4.1.3 is newer than the workspace's
pnpm `minimumReleaseAge` policy allows.
