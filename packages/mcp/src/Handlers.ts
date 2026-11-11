import { JsonApi, TidalClient, TidalConfig } from "@tidal-mcp/tidal-api"
import { Effect } from "effect"
import { toToolError } from "./Errors.ts"
import { type SearchTypes, TidalResult, TidalToolError, TidalToolkit } from "./Tools.ts"

type Result = typeof TidalResult.Type

const simplified = <E, R>(request: Effect.Effect<JsonApi.Document, E, R>): Effect.Effect<Result, TidalToolError, R> =>
  request.pipe(
    // Simplified documents only ever hold JSON values decoded from TIDAL.
    Effect.map((document) => JsonApi.simplify(document) as Result),
    Effect.mapError(toToolError)
  )

const page = (cursor: string | undefined) => (cursor === undefined ? {} : { "page[cursor]": cursor })

export const TidalToolkitHandlers = TidalToolkit.toLayer(Effect.gen(function*() {
  const tidal = yield* TidalClient
  const config = yield* TidalConfig
  const market = (countryCode: string | undefined) => countryCode ?? config.countryCode

  const search = {
    topHits: (id: string, params: SearchParams) =>
      simplified(tidal["GET/searchResults/{id}/relationships/topHits"](id, { params: { ...params, include: ["topHits"] } })),
    tracks: (id: string, params: SearchParams) =>
      simplified(tidal["GET/searchResults/{id}/relationships/tracks"](id, {
        params: { ...params, include: ["tracks", "tracks.artists", "tracks.albums"] }
      })),
    albums: (id: string, params: SearchParams) =>
      simplified(tidal["GET/searchResults/{id}/relationships/albums"](id, {
        params: { ...params, include: ["albums", "albums.artists"] }
      })),
    artists: (id: string, params: SearchParams) =>
      simplified(tidal["GET/searchResults/{id}/relationships/artists"](id, { params: { ...params, include: ["artists"] } })),
    playlists: (id: string, params: SearchParams) =>
      simplified(tidal["GET/searchResults/{id}/relationships/playlists"](id, { params: { ...params, include: ["playlists"] } })),
    videos: (id: string, params: SearchParams) =>
      simplified(tidal["GET/searchResults/{id}/relationships/videos"](id, {
        params: { ...params, include: ["videos", "videos.artists"] }
      }))
  } satisfies Record<typeof SearchTypes[number], unknown>

  return TidalToolkit.of({
    search: ({ query, type, explicit, countryCode, cursor }) =>
      search[type ?? "topHits"](query, {
        countryCode: market(countryCode),
        explicitFilter: explicit === false ? "EXCLUDE" : "INCLUDE",
        ...page(cursor)
      }),

    search_suggestions: ({ query, explicit, countryCode }) =>
      simplified(tidal["GET/searchSuggestions"]({
        params: {
          "filter[query]": query,
          countryCode: market(countryCode),
          explicitFilter: explicit === false ? "EXCLUDE" : "INCLUDE",
          include: ["directHits"]
        }
      })),

    get_tracks: ({ ids, isrcs, countryCode }) =>
      ids === undefined && isrcs === undefined
        ? Effect.fail(new TidalToolError({ message: "Provide `ids` or `isrcs`." }))
        : simplified(tidal["GET/tracks"]({
          params: {
            countryCode: market(countryCode),
            include: ["artists", "albums"],
            ...(ids === undefined ? {} : { "filter[id]": ids }),
            ...(isrcs === undefined ? {} : { "filter[isrc]": isrcs })
          }
        })),

    get_similar_tracks: ({ id, countryCode, cursor }) =>
      simplified(tidal["GET/tracks/{id}/relationships/similarTracks"](id, {
        params: {
          countryCode: market(countryCode),
          include: ["similarTracks", "similarTracks.artists"],
          ...page(cursor)
        }
      })),

    get_track_lyrics: ({ id }) =>
      simplified(tidal["GET/tracks/{id}/relationships/lyrics"](id, { params: { include: ["lyrics"] } })),

    get_albums: ({ ids, barcodes, countryCode }) =>
      ids === undefined && barcodes === undefined
        ? Effect.fail(new TidalToolError({ message: "Provide `ids` or `barcodes`." }))
        : simplified(tidal["GET/albums"]({
          params: {
            countryCode: market(countryCode),
            include: ["artists", "coverArt"],
            ...(ids === undefined ? {} : { "filter[id]": ids }),
            ...(barcodes === undefined ? {} : { "filter[barcodeId]": barcodes })
          }
        })),

    get_album_tracks: ({ id, countryCode, cursor }) =>
      simplified(tidal["GET/albums/{id}/relationships/items"](id, {
        params: { countryCode: market(countryCode), include: ["items", "items.artists"], ...page(cursor) }
      })),

    get_artist: ({ id, countryCode }) =>
      simplified(tidal["GET/artists/{id}"](id, {
        params: { countryCode: market(countryCode), include: ["biography", "profileArt"] }
      })),

    get_artist_albums: ({ id, countryCode, cursor }) =>
      simplified(tidal["GET/artists/{id}/relationships/albums"](id, {
        params: { countryCode: market(countryCode), include: ["albums"], ...page(cursor) }
      })),

    get_artist_tracks: ({ id, countryCode, cursor }) =>
      simplified(tidal["GET/artists/{id}/relationships/tracks"](id, {
        params: {
          countryCode: market(countryCode),
          collapseBy: "FINGERPRINT",
          include: ["tracks", "tracks.albums"],
          ...page(cursor)
        }
      })),

    get_similar_artists: ({ id, countryCode, cursor }) =>
      simplified(tidal["GET/artists/{id}/relationships/similarArtists"](id, {
        params: { countryCode: market(countryCode), include: ["similarArtists"], ...page(cursor) }
      })),

    get_playlist: ({ id, countryCode }) =>
      simplified(tidal["GET/playlists/{id}"](id, {
        params: { countryCode: market(countryCode), include: ["coverArt"] }
      })),

    get_playlist_items: ({ id, countryCode, cursor }) =>
      simplified(tidal["GET/playlists/{id}/relationships/items"](id, {
        params: { countryCode: market(countryCode), include: ["items", "items.artists"], ...page(cursor) }
      }))
  })
}))

interface SearchParams {
  readonly countryCode: string
  readonly explicitFilter: "INCLUDE" | "EXCLUDE"
  readonly "page[cursor]"?: string
}
