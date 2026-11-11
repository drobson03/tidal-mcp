import { Context, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

/** A tool failure surfaced to the model as an `isError` result with `message`. */
export class TidalToolError extends Schema.TaggedError<TidalToolError>()("TidalToolError", {
  message: Schema.String
}) {}

/**
 * The signed-in TIDAL user behind the current MCP request, provided per
 * request by the host (the Worker resolves it from the OAuth access token).
 * `accessToken` is the user's TIDAL token, refreshed when needed; tools that
 * read the user's library or private playlists call TIDAL with it.
 */
export class CurrentTidalUser extends Context.Service<CurrentTidalUser, {
  readonly accessToken: Effect.Effect<string, TidalToolError>
}>()("@tidal-mcp/mcp/CurrentTidalUser") {
  /** For requests without a signed-in user. */
  static readonly signedOut = CurrentTidalUser.of({
    accessToken: Effect.fail(new TidalToolError({ message: "Not signed in to TIDAL." }))
  })
}

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

/** A tool that calls TIDAL as the signed-in user. */
const makeUser = <const Name extends string, Parameters extends Schema.Struct.Fields>(
  name: Name,
  title: string,
  description: string,
  parameters: Parameters
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: TidalResult,
    failure: TidalToolError,
    dependencies: [CurrentTidalUser]
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

export const GetPlaylist = makeUser(
  "get_playlist",
  "Get playlist",
  "A playlist's details: name, description, size, owner and cover art. Playlist ids are UUIDs. Works for the user's private playlists.",
  { id: Id("playlist"), countryCode: fields.countryCode }
)

export const GetPlaylistItems = makeUser(
  "get_playlist_items",
  "Playlist tracks",
  "The tracks and videos in a playlist, in order, with their artists and when each was added (`meta.addedAt`). Works for the user's private playlists.",
  { id: Id("playlist"), ...fields }
)

export const FindMyPlaylists = makeUser(
  "find_my_playlists",
  "Find my playlists",
  "The signed-in user's playlists: ones they own (including private ones) and ones saved to their library. Pass `query` to match names, e.g. 'good'. Returns playlist ids for get_playlist_artists and get_playlist_items.",
  {
    query: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
      description: "Case-insensitive text to find in playlist names. Omit to list every playlist."
    }))
  }
)

export const CollectionTypes = ["albums", "tracks", "artists", "playlists"] as const
export const CollectionSorts = ["recentlyAdded", "oldestAdded", "name", "releaseDate"] as const

export const GetMyCollection = makeUser(
  "get_my_collection",
  "My collection",
  "One page of the signed-in user's saved albums, tracks, artists or playlists (their TIDAL library), with when each was saved (`meta.addedAt`).",
  {
    type: Schema.Literals(CollectionTypes).annotate({ description: "What to list." }),
    sort: Schema.optionalKey(Schema.Literals(CollectionSorts).annotate({
      description: "Order: 'recentlyAdded' (default), 'oldestAdded', 'name' (title for albums and tracks), or 'releaseDate' (newest first; albums only)."
    })),
    cursor: fields.cursor
  }
)

export const GetPlaylistArtists = makeUser(
  "get_playlist_artists",
  "Playlist artists",
  "Every artist on a playlist, with how many of its tracks each appears on, most frequent first. Reads the whole playlist in one call, so prefer it to paging get_playlist_items when you only need the artists. Works for the user's private playlists.",
  { id: Id("playlist"), countryCode: fields.countryCode }
)

export const ReleaseTypes = ["ALBUM", "EP", "SINGLE"] as const

export const GetNewReleases = makeUser(
  "get_new_releases",
  "New releases from artists",
  "Albums, EPs and singles that the given artists released on or after `since`, newest first, with editions of the same release grouped. By default it leaves out releases already in the signed-in user's library (saved albums, or albums of saved tracks), which answers 'what have I missed from these artists'. Each call has a request budget: if `remainingArtistIds` is returned, call again with those ids to finish.",
  {
    artistIds: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(50)).annotate({
      description: "1-50 TIDAL artist ids, e.g. from get_playlist_artists."
    }),
    since: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
      description: "Earliest release date to include, as YYYY-MM-DD, e.g. two years before today."
    }),
    types: Schema.optionalKey(Schema.Array(Schema.Literals(ReleaseTypes)).check(Schema.isMinLength(1)).annotate({
      description: "Release types to include. Defaults to all: ALBUM, EP and SINGLE."
    })),
    excludeLibrary: Schema.optionalKey(Schema.Boolean.annotate({
      description: "Leave out releases already in the user's library. Defaults to true."
    })),
    countryCode: fields.countryCode
  }
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
  GetPlaylistItems,
  FindMyPlaylists,
  GetMyCollection,
  GetPlaylistArtists,
  GetNewReleases
)
