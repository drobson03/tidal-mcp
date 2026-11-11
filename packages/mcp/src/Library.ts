/**
 * Tools that do more than one TIDAL request per call: reading a whole
 * playlist, finding the user's playlists, and checking artists' discographies
 * against the user's library.
 *
 * Every page costs one request from a {@link Budget}. Cloudflare caps
 * outbound requests per Worker invocation, so these tools stop at the budget
 * and report what's left instead of failing.
 */
import { JsonApi, type TidalApi } from "@tidal-mcp/tidal-api"
import { Effect } from "effect"
import { toToolError } from "./Errors.ts"
import type { ReleaseTypes, TidalResult } from "./Tools.ts"

type Simplified = JsonApi.Simplified
// Any error type: clients differ (catalogue vs. user token) and every function
// below maps its failures with `toToolError`. `unknown` doesn't fit, since the
// client's error parameter is invariant.
type Api = TidalApi.TidalApi<any>

export interface Budget {
  readonly limit: number
  /** Claims one request; `false` once the budget is spent. */
  readonly take: Effect.Effect<boolean>
}

export const makeBudget = (limit: number): Budget => {
  let used = 0
  return {
    limit,
    take: Effect.sync(() => {
      if (used >= limit) return false
      used++
      return true
    })
  }
}

export const page = (cursor: string | undefined) => (cursor === undefined ? {} : { "page[cursor]": cursor })

const itemsOf = (document: JsonApi.Document): ReadonlyArray<Simplified> => {
  const { data } = JsonApi.simplify(document)
  return data === null ? [] : Array.isArray(data) ? data : [data as Simplified]
}

export interface Pages {
  readonly items: ReadonlyArray<Simplified>
  /** Every page was read (or `stopAfter` said the rest isn't needed). */
  readonly complete: boolean
  /** Reading stopped because the request budget ran out. */
  readonly outOfBudget: boolean
}

/** Follows `links.next` until the last page, `maxPages`, `stopAfter`, or the budget. */
export const collectPages = <E>(
  fetch: (cursor: string | undefined) => Effect.Effect<JsonApi.Document, E>,
  budget: Budget,
  options: {
    readonly maxPages: number
    /** Called with each page's items; `true` stops after that page. */
    readonly stopAfter?: (items: ReadonlyArray<Simplified>) => boolean
  }
): Effect.Effect<Pages, E> =>
  Effect.gen(function*() {
    const items: Array<Simplified> = []
    let cursor: string | undefined
    for (let count = 0; count < options.maxPages; count++) {
      if (!(yield* budget.take)) return { items, complete: false, outOfBudget: true }
      const document = yield* fetch(cursor)
      const pageItems = itemsOf(document)
      items.push(...pageItems)
      if (options.stopAfter?.(pageItems) === true) return { items, complete: true, outOfBudget: false }
      cursor = JsonApi.nextCursor(document.links)
      if (cursor === undefined) return { items, complete: true, outOfBudget: false }
    }
    return { items, complete: false, outOfBudget: false }
  })

/** A tool result. JSON round-tripping drops `undefined` fields, which aren't JSON. */
const result = (data: unknown): typeof TidalResult.Type => ({ data: JSON.parse(JSON.stringify(data)) })

const string = (item: Simplified, key: string): string | undefined =>
  typeof item[key] === "string" ? item[key] : undefined

const related = (item: Simplified, key: string): ReadonlyArray<Simplified> => {
  const value = item[key]
  return Array.isArray(value) ? value as ReadonlyArray<Simplified> : []
}

const addedAt = (item: Simplified): string | undefined => {
  const meta = item["meta"]
  return typeof meta === "object" && meta !== null && "addedAt" in meta && typeof meta.addedAt === "string"
    ? meta.addedAt
    : undefined
}

// ---------------------------------------------------------------------------
// find_my_playlists

export const findMyPlaylists = (user: Api, budget: Budget, query: string | undefined) =>
  Effect.gen(function*() {
    const owned = yield* collectPages(
      (cursor) => user["GET/playlists"]({ params: { "filter[owners.id]": ["me"], sort: ["name"], ...page(cursor) } }),
      budget,
      { maxPages: 10 }
    )
    const saved = yield* collectPages(
      (cursor) =>
        user["GET/userCollectionPlaylists/{id}/relationships/items"]("me", {
          params: { include: ["items"], collectionView: "FLAT", ...page(cursor) }
        }),
      budget,
      { maxPages: 10 }
    )

    const playlists = new Map<string, Record<string, unknown>>()
    const add = (item: Simplified, source: "owned" | "saved") => {
      if (item.type !== "playlists" || string(item, "name") === undefined) return
      const existing = playlists.get(item.id)
      if (existing !== undefined) {
        existing[source] = true
        return
      }
      playlists.set(item.id, {
        id: item.id,
        name: item["name"],
        ...(string(item, "description") ? { description: item["description"] } : {}),
        numberOfItems: item["numberOfItems"],
        accessType: item["accessType"],
        playlistType: item["playlistType"],
        lastModifiedAt: item["lastModifiedAt"],
        owned: source === "owned",
        saved: source === "saved"
      })
    }
    for (const item of owned.items) add(item, "owned")
    for (const item of saved.items) add(item, "saved")

    const needle = query?.trim().toLowerCase()
    const rank = (name: string) => (name === needle ? 0 : name.startsWith(needle ?? "") ? 1 : 2)
    const matches = [...playlists.values()]
      .filter((playlist) => needle === undefined || String(playlist["name"]).toLowerCase().includes(needle))
      .sort((a, b) => {
        const [nameA, nameB] = [String(a["name"]).toLowerCase(), String(b["name"]).toLowerCase()]
        return rank(nameA) - rank(nameB) || nameA.localeCompare(nameB)
      })

    const complete = owned.complete && saved.complete
    return result({
      playlists: matches,
      ...(complete ? {} : { note: "Not every playlist was read (too many, or the request budget ran out)." })
    })
  }).pipe(Effect.mapError(toToolError))

// ---------------------------------------------------------------------------
// get_playlist_artists

export const getPlaylistArtists = (user: Api, budget: Budget, id: string, countryCode: string) =>
  Effect.gen(function*() {
    const read = yield* collectPages(
      (cursor) =>
        user["GET/playlists/{id}/relationships/items"](id, {
          params: { countryCode, include: ["items", "items.artists"], ...page(cursor) }
        }),
      budget,
      { maxPages: 100 }
    )
    const artists = new Map<string, { id: string; name: string | undefined; tracks: number }>()
    for (const item of read.items) {
      // An artist credited twice on one track still counts once for it.
      for (const artist of new Map(related(item, "artists").map((artist) => [artist.id, artist])).values()) {
        const entry = artists.get(artist.id) ?? { id: artist.id, name: string(artist, "name"), tracks: 0 }
        entry.tracks++
        artists.set(artist.id, entry)
      }
    }
    return result({
      playlistId: id,
      itemsRead: read.items.length,
      artists: [...artists.values()].sort((a, b) => b.tracks - a.tracks || (a.name ?? "").localeCompare(b.name ?? "")),
      ...(read.complete
        ? {}
        : { note: `Read the first ${read.items.length} items only: the request budget ran out.` })
    })
  }).pipe(Effect.mapError(toToolError))

// ---------------------------------------------------------------------------
// get_new_releases

/**
 * Normalizes a release title so editions group together: "Album (Deluxe
 * Edition)", "Album [Remastered]" and "Album - Live Version" become "album".
 */
export const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    .replace(/\s+-\s+.*\b(edition|version|remaster(ed)?|deluxe|expanded|live|mix)\b.*$/, "")
    .replace(/\s+/g, " ")
    .trim()

interface Release {
  id: string
  title: string
  type: string
  releaseDate: string
  numberOfItems: unknown
  explicit: unknown
  artistIds: Set<string>
  otherVersionIds: Array<string>
  inLibrary: boolean
}

export interface NewReleasesInput {
  readonly artistIds: ReadonlyArray<string>
  readonly since: string
  readonly types?: ReadonlyArray<typeof ReleaseTypes[number]>
  readonly excludeLibrary?: boolean
}

/** What the user already has: saved albums, plus the albums of saved tracks, back to `since`. */
const readLibrary = (user: Api, budget: Budget, since: string) =>
  Effect.gen(function*() {
    const ids = new Set<string>()
    const titles = new Set<string>()
    const remember = (album: Simplified, artists: ReadonlyArray<Simplified>) => {
      ids.add(album.id)
      const title = string(album, "title")
      if (title !== undefined) for (const artist of artists) titles.add(`${artist.id}|${normalizeTitle(title)}`)
    }

    // Newest releases first, so the first album older than `since` ends it.
    const albums = yield* collectPages(
      (cursor) =>
        user["GET/userCollectionAlbums/{id}/relationships/items"]("me", {
          params: { include: ["items", "items.artists"], sort: ["-releaseDate"], ...page(cursor) }
        }),
      budget,
      { maxPages: 5, stopAfter: (items) => items.some((album) => (string(album, "releaseDate") ?? "9999") < since) }
    )
    for (const album of albums.items) remember(album, related(album, "artists"))

    // A track from a release after `since` was saved after `since` too.
    const tracks = yield* collectPages(
      (cursor) =>
        user["GET/userCollectionTracks/{id}/relationships/items"]("me", {
          params: { include: ["items", "items.albums", "items.artists"], sort: ["-addedAt"], ...page(cursor) }
        }),
      budget,
      { maxPages: 5, stopAfter: (items) => items.some((track) => (addedAt(track) ?? "9999").slice(0, 10) < since) }
    )
    for (const track of tracks.items) {
      for (const album of related(track, "albums")) remember(album, related(track, "artists"))
    }

    return { ids, titles, complete: albums.complete && tracks.complete }
  })

export const getNewReleases = (
  catalogue: Api,
  user: Api,
  budget: Budget,
  input: NewReleasesInput,
  countryCode: string
) =>
  Effect.gen(function*() {
    const { since } = input
    const types = new Set<string>(input.types ?? ["ALBUM", "EP", "SINGLE"])
    const excludeLibrary = input.excludeLibrary ?? true
    const artistIds = [...new Set(input.artistIds)]

    const library = excludeLibrary ? yield* readLibrary(user, budget, since) : undefined

    const names = new Map<string, string>()
    for (let i = 0; i < artistIds.length; i += 20) {
      if (!(yield* budget.take)) break
      const document = yield* catalogue["GET/artists"]({
        params: { "filter[id]": artistIds.slice(i, i + 20), countryCode }
      })
      for (const artist of itemsOf(document)) {
        const name = string(artist, "name")
        if (name !== undefined) names.set(artist.id, name)
      }
    }

    const discographies = yield* Effect.forEach(
      artistIds,
      (artistId) =>
        collectPages(
          (cursor) =>
            catalogue["GET/artists/{id}/relationships/albums"](artistId, {
              params: { countryCode, include: ["albums"], ...page(cursor) }
            }),
          budget,
          { maxPages: 10 }
        ).pipe(
          Effect.map((pages) => ({ artistId, pages, error: undefined })),
          Effect.catch((error: unknown) =>
            Effect.succeed({ artistId, pages: undefined, error: toToolError(error).message })
          )
        ),
      { concurrency: 4 }
    )

    const releases = new Map<string, Release>()
    const remaining: Array<string> = []
    const partial: Array<string> = []
    const failed: Array<{ artistId: string; message: string }> = []

    for (const { artistId, pages, error } of discographies) {
      if (pages === undefined) {
        failed.push({ artistId, message: error ?? "Unknown error" })
        continue
      }
      if (pages.outOfBudget) {
        remaining.push(artistId)
        continue
      }
      if (!pages.complete) partial.push(artistId)

      // Group this artist's editions of the same release; the earliest is the original.
      const groups = new Map<string, Array<Simplified>>()
      for (const album of pages.items) {
        const title = string(album, "title")
        const type = string(album, "albumType")
        const releaseDate = string(album, "releaseDate")
        if (title === undefined || type === undefined || releaseDate === undefined) continue
        if (releaseDate < since || !types.has(type)) continue
        const key = `${normalizeTitle(title)}|${type}`
        groups.set(key, [...(groups.get(key) ?? []), album])
      }
      for (const versions of groups.values()) {
        versions.sort((a, b) => string(a, "releaseDate")!.localeCompare(string(b, "releaseDate")!))
        const original = versions[0]!
        const inLibrary = library !== undefined &&
          (versions.some((version) => library.ids.has(version.id)) ||
            library.titles.has(`${artistId}|${normalizeTitle(string(original, "title")!)}`))
        // Collaborations show up under each artist; keep one entry.
        const existing = releases.get(original.id)
        if (existing !== undefined) {
          existing.artistIds.add(artistId)
          existing.inLibrary ||= inLibrary
          continue
        }
        releases.set(original.id, {
          id: original.id,
          title: string(original, "title")!,
          type: string(original, "albumType")!,
          releaseDate: string(original, "releaseDate")!,
          numberOfItems: original["numberOfItems"],
          explicit: original["explicit"],
          artistIds: new Set([artistId]),
          otherVersionIds: versions.slice(1).map((version) => version.id),
          inLibrary
        })
      }
    }

    const all = [...releases.values()].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
    const shown = excludeLibrary ? all.filter((release) => !release.inLibrary) : all
    const notes: Array<string> = []
    if (remaining.length > 0) {
      notes.push(
        `The request budget ran out before ${remaining.length} artist(s) were checked: call again with remainingArtistIds.`
      )
    }
    if (partial.length > 0) notes.push("Some discographies were too long to read in full: see partialArtistIds.")
    if (library !== undefined && !library.complete) {
      notes.push("Only part of the library was checked, so a few releases shown may already be saved.")
    }

    return result({
      since,
      artistsChecked: artistIds.length - remaining.length - failed.length,
      releases: shown.map((release) => ({
        id: release.id,
        title: release.title,
        type: release.type,
        releaseDate: release.releaseDate,
        numberOfItems: release.numberOfItems,
        explicit: release.explicit,
        artists: [...release.artistIds].map((id) => ({ id, name: names.get(id) })),
        ...(release.otherVersionIds.length > 0 ? { otherVersionIds: release.otherVersionIds } : {})
      })),
      ...(excludeLibrary ? { leftOutAlreadyInLibrary: all.length - shown.length } : {}),
      ...(remaining.length > 0 ? { remainingArtistIds: remaining } : {}),
      ...(partial.length > 0 ? { partialArtistIds: partial } : {}),
      ...(failed.length > 0 ? { failed } : {}),
      ...(notes.length > 0 ? { notes } : {})
    })
  }).pipe(Effect.mapError(toToolError))
