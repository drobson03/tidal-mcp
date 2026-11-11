/**
 * Generates `src/generated/TidalApi.ts` from the TIDAL OpenAPI spec with
 * `@effect/openapi-generator`.
 *
 *   node scripts/generate.ts             # generate from spec/tidal-api-oas.json
 *   node scripts/generate.ts --download  # refresh the spec first, then generate
 *
 * The published spec covers ~330 paths, most of them partner/back-office
 * resources (Stripe, Square, artist claims, …) that a catalogue MCP server
 * never touches. Generating all of it produces ~23k lines and bloats the
 * Worker bundle, so the spec is pruned to the resources and methods below
 * before generation. Widen these to expose more of the API.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator"
import { Console, Effect, FileSystem, Path } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import type { OpenAPISpec } from "effect/http-api/OpenApi"

const SPEC_URL = "https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json"

/** Top-level resources to keep (first path segment). */
const RESOURCES = new Set([
  "albums",
  "artists",
  "artworks",
  "credits",
  "genres",
  "lyrics",
  "playlists",
  "providers",
  "searchResults",
  "searchSuggestions",
  "tracks",
  // The signed-in user's library, as `me` (needs the user's token with `collection.read`).
  "userCollectionAlbums",
  "userCollectionArtists",
  "userCollectionPlaylists",
  "userCollectionTracks",
  "users",
  "videos"
])

/** HTTP methods to keep. The server is read-only. */
const METHODS = new Set(["get"])

type Spec = {
  paths: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

const prune = (spec: Spec): Spec => {
  const paths: Spec["paths"] = {}
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!RESOURCES.has(path.split("/")[1] ?? "")) continue
    const kept = Object.fromEntries(
      Object.entries(item).filter(([key]) => key === "parameters" || METHODS.has(key))
    )
    if (Object.keys(kept).some((key) => METHODS.has(key))) paths[path] = kept
  }
  return { ...spec, paths }
}

/**
 * Makes `discriminator` mappings explicit in the schemas they point at.
 *
 * TIDAL's `Included` array is a `oneOf` over ~90 resource objects with a
 * `discriminator` on `type`, but every resource object declares `type` as a
 * plain string. The generator ignores discriminators and emits `oneOf` as an
 * exclusive union, so any included resource matches several members and fails
 * to decode ("Expected exactly one member to match"). Pinning each mapped
 * schema's discriminator property to its mapped value(s) makes the union
 * exclusive again, and narrows the generated `type` fields to literals.
 */
const pinDiscriminators = (spec: Spec): number => {
  const components = (spec["components"] as { schemas?: Record<string, any> } | undefined)?.schemas ?? {}
  const values = new Map<string, { property: string; values: Set<string> }>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node !== "object" || node === null) return
    const { discriminator } = node as { discriminator?: { propertyName?: string; mapping?: Record<string, string> } }
    if (discriminator?.propertyName && discriminator.mapping) {
      for (const [value, ref] of Object.entries(discriminator.mapping)) {
        const name = ref.split("/").pop()!
        const entry = values.get(name) ?? { property: discriminator.propertyName, values: new Set() }
        entry.values.add(value)
        values.set(name, entry)
      }
    }
    Object.values(node).forEach(visit)
  }
  visit(spec)
  let pinned = 0
  for (const [name, { property, values: allowed }] of values) {
    const target = components[name]?.properties?.[property]
    if (target === undefined || target.enum !== undefined) continue
    target.enum = [...allowed]
    pinned++
  }
  return pinned
}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "..")
  const specFile = path.join(root, "spec", "tidal-api-oas.json")
  const outFile = path.join(root, "src", "generated", "TidalApi.ts")

  if (process.argv.includes("--download")) {
    yield* Console.log(`Downloading ${SPEC_URL}`)
    const body = yield* HttpClient.get(SPEC_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text)
    )
    yield* fs.writeFileString(specFile, body)
  }

  const spec = JSON.parse(yield* fs.readFileString(specFile)) as Spec
  const pruned = prune(spec)
  const pinned = pinDiscriminators(pruned)
  const info = spec["info"] as { version?: string } | undefined
  yield* Console.log(
    `Spec v${info?.version ?? "?"}: keeping ${Object.keys(pruned.paths).length}/${
      Object.keys(spec.paths).length
    } paths, pinned ${pinned} discriminator values`
  )

  const generator = yield* OpenApiGenerator.OpenApiGenerator
  const source = yield* generator.generate(pruned as unknown as OpenAPISpec, {
    name: "TidalApi",
    format: "httpclient",
    onWarning: (warning) => console.warn(OpenApiGenerator.formatWarning(warning))
  })

  const header = [
    "// Generated by scripts/generate.ts from the TIDAL OpenAPI spec",
    `// (v${info?.version ?? "unknown"}). Do not edit by hand: run \`pnpm generate\`.`,
    ""
  ].join("\n")
  yield* fs.makeDirectory(path.dirname(outFile), { recursive: true })
  yield* fs.writeFileString(outFile, header + source)
  yield* Console.log(`Wrote ${path.relative(process.cwd(), outFile)}`)
})

program.pipe(
  Effect.provide([OpenApiGenerator.layerTransformerSchema, NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain
)
