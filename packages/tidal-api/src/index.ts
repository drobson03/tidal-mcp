import { Layer } from "effect"
import { TidalAuth } from "./TidalAuth.ts"
import { TidalClient } from "./TidalClient.ts"

export * as TidalApi from "./generated/TidalApi.ts"
export * as JsonApi from "./JsonApi.ts"
export * from "./TidalAuth.ts"
export * from "./TidalClient.ts"
export * from "./TidalConfig.ts"
export * as TidalUser from "./TidalUser.ts"

/**
 * `TidalClient` with its `TidalAuth` dependency wired in. Still requires
 * `TidalConfig` and an `HttpClient` (e.g. `FetchHttpClient.layer`).
 */
export const TidalLive = TidalClient.layer.pipe(Layer.provideMerge(TidalAuth.layer))
