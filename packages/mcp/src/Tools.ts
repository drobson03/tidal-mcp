import { Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

/** A tool failure surfaced to the model as an `isError` result with `message`. */
export class TidalToolError extends Schema.TaggedError<TidalToolError>()("TidalToolError", {
  message: Schema.String
}) {}

/**
 * Every tool returns simplified JSON:API data (attributes inlined, included
 * relationships resolved) plus a cursor when more pages exist.
 */
export const TidalResult = Schema.Struct({
  data: Schema.Json,
  nextCursor: Schema.optionalKey(Schema.String.annotate({
    description: "Pass as `cursor` to the same tool to fetch the next page."
  }))
})

const Id = (what: string) => Schema.String.annotate({ description: `TIDAL ${what} id, e.g. from a search result.` })

const fields = {
  countryCode: Schema.optionalKey(Schema.String.annotate({
    description: "ISO 3166-1 alpha-2 market for availability, e.g. 'US', 'GB', 'NO'. Defaults to the server's market."
  })),
  cursor: Schema.optionalKey(Schema.String.annotate({
    description: "Pagination cursor from a previous call's `nextCursor`."
  }))
}

const IdList = (what: string, example: string) =>
  Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)).annotate({
    description: `1-20 ${what}, e.g. ["${example}"].`
  })

const make = <const Name extends string, Parameters extends Schema.Struct.Fields>(
  name: Name,
  title: string,
  description: string,
  parameters: Parameters
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: TidalResult,
    failure: TidalToolError
  })
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true)

export const SearchTypes = ["topHits", "tracks", "albums", "artists", "playlists", "videos"] as const

export const Search = make(
  "search",
  "Search TIDAL",
  "Search the TIDAL catalogue. `type` picks the result list: 'topHits' (default) mixes the best matches of every kind; the others return one kind. Results include ids for the other tools.",
  {
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: "Free-text query, e.g. 'radiohead ok computer'."
    }),
    type: Schema.optionalKey(Schema.Literals(SearchTypes).annotate({ description: "Which result list to return." })),
    explicit: Schema.optionalKey(Schema.Boolean.annotate({
      description: "Set false to exclude explicit content. Defaults to true."
    })),
    ...fields
  }
)

export const SearchSuggestions = make(
  "search_suggestions",
  "Search suggestions",
  "Autocomplete a partial query: returns suggested query strings and direct hits.",
  {
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: "Partial query, e.g. 'daft pu'."
    }),
    explicit: Schema.optionalKey(Schema.Boolean),
    countryCode: fields.countryCode
  }
)

export const GetTracks = make(
  "get_tracks",
  "Get tracks",
  "Look up tracks by TIDAL id or ISRC, with their artists and album. Provide `ids` or `isrcs`.",
  {
    ids: Schema.optionalKey(IdList("track ids", "251380837")),
    isrcs: Schema.optionalKey(IdList("ISRCs", "USSM19922509")),
    countryCode: fields.countryCode
  }
)

export const GetSimilarTracks = make(
  "get_similar_tracks",
  "Similar tracks",
  "Tracks similar to a given track, with their artists. Useful for recommendations and radio-style lists.",
  { id: Id("track"), ...fields }
)

export const GetTrackLyrics = make(
  "get_track_lyrics",
  "Track lyrics",
  "Lyrics of a track, when TIDAL has them.",
  { id: Id("track") }
)

export const GetAlbums = make(
  "get_albums",
  "Get albums",
  "Look up albums by TIDAL id or barcode (UPC/EAN), with artists and cover art. Provide `ids` or `barcodes`.",
  {
    ids: Schema.optionalKey(IdList("album ids", "251380836")),
    barcodes: Schema.optionalKey(IdList("barcodes", "196589525444")),
    countryCode: fields.countryCode
  }
)

export const GetAlbumTracks = make(
  "get_album_tracks",
  "Album track list",
  "The tracks (and videos) on an album in order, with volume and track numbers in `meta`.",
  { id: Id("album"), ...fields }
)

export const GetArtist = make(
  "get_artist",
  "Get artist",
  "An artist's profile: name, popularity, biography and profile art.",
  { id: Id("artist"), countryCode: fields.countryCode }
)

export const GetArtistAlbums = make(
  "get_artist_albums",
  "Artist discography",
  "Albums, EPs and singles by an artist.",
  { id: Id("artist"), ...fields }
)

export const GetArtistTracks = make(
  "get_artist_tracks",
  "Artist top tracks",
  "An artist's tracks, most popular first, with duplicate recordings collapsed.",
  { id: Id("artist"), ...fields }
)

export const GetSimilarArtists = make(
  "get_similar_artists",
  "Similar artists",
  "Artists similar to a given artist.",
  { id: Id("artist"), ...fields }
)

export const GetPlaylist = make(
  "get_playlist",
  "Get playlist",
  "A playlist's details: name, description, size, owner and cover art. Playlist ids are UUIDs.",
  { id: Id("playlist"), countryCode: fields.countryCode }
)

export const GetPlaylistItems = make(
  "get_playlist_items",
  "Playlist tracks",
  "The tracks and videos in a playlist, in order, with their artists and when each was added (`meta.addedAt`).",
  { id: Id("playlist"), ...fields }
)

export const TidalToolkit = Toolkit.make(
  Search,
  SearchSuggestions,
  GetTracks,
  GetSimilarTracks,
  GetTrackLyrics,
  GetAlbums,
  GetAlbumTracks,
  GetArtist,
  GetArtistAlbums,
  GetArtistTracks,
  GetSimilarArtists,
  GetPlaylist,
  GetPlaylistItems
)
