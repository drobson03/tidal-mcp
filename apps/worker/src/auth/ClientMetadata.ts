import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider"

/**
 * Fetches Client ID Metadata Documents from a Cloudflare Worker.
 *
 * `cimd()` asks for a transport that resolves the hostname once, refuses
 * special-use (private, loopback, link-local) addresses, pins the address and
 * never follows redirects, so a malicious `client_id` URL can't reach internal
 * services. On Workers:
 *
 * - outbound `fetch` runs on Cloudflare's network, and with the
 *   `global_fetch_strictly_public` compatibility flag (set on the Worker)
 *   every subrequest goes out over the public internet. No private address
 *   space is reachable, and DNS is resolved and connected by Cloudflare;
 * - IP-literal and non-HTTPS `client_id`s are rejected by `cimd()` itself
 *   before any fetch;
 * - redirects are returned, never followed (`redirect: "manual"`).
 */
export const workersFetchClientMetadata: ClientMetadataResourceFetch = (input, init) =>
  fetch(input, { ...init, redirect: "manual" })
