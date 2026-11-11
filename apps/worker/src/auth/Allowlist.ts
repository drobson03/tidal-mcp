/**
 * Who may use the server. The Worker calls the TIDAL API on its owner's
 * developer app, so only listed TIDAL accounts can sign in.
 *
 * Entries are matched case-insensitively against the TIDAL user id, the
 * username, or the account's email address when TIDAL reports it verified.
 */
export interface Allowlist {
  readonly entries: ReadonlySet<string>
}

/** Parses a comma- or whitespace-separated list, e.g. `ALLOWED_USERS="12345, me@example.com"`. */
export const parse = (raw: string): Allowlist => ({
  entries: new Set(raw.split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""))
})

export interface TidalIdentity {
  readonly tidalUserId?: string | null | undefined
  readonly username?: string | null | undefined
  readonly email?: string | null | undefined
  readonly emailVerified?: boolean | null | undefined
}

export const isAllowed = (allowlist: Allowlist, identity: TidalIdentity): boolean => {
  const candidates = [identity.tidalUserId, identity.username, identity.emailVerified ? identity.email : undefined]
  return candidates.some((candidate) =>
    typeof candidate === "string" && candidate !== "" && allowlist.entries.has(candidate.toLowerCase())
  )
}
