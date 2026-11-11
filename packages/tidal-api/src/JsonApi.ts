/**
 * Helpers for turning TIDAL's JSON:API documents into compact, self-contained
 * objects that are pleasant for an LLM (or a human) to read.
 *
 * A JSON:API document spreads one logical result over `data` (resources or
 * resource identifiers), `included` (side-loaded resources) and `links`.
 * {@link simplify} inlines each resource's attributes next to its `id`/`type`
 * and resolves relationships against `included`, so
 *
 * ```json
 * { "data": { "id": "1", "type": "tracks", "attributes": { "title": "x" },
 *             "relationships": { "artists": { "data": [{ "id": "2", "type": "artists" }] } } },
 *   "included": [{ "id": "2", "type": "artists", "attributes": { "name": "y" } }] }
 * ```
 *
 * becomes `{ "id": "1", "type": "tracks", "title": "x", "artists": [{ "id": "2", "type": "artists", "name": "y" }] }`.
 */

export interface Document {
  readonly data?: unknown
  readonly included?: ReadonlyArray<unknown> | undefined
  readonly links?: unknown
}

export type Simplified = { readonly id: string; readonly type: string; readonly [key: string]: unknown }

export interface SimplifyOptions {
  /**
   * How many levels of relationships to resolve against `included`.
   * Defaults to 1: the primary resources' relationships are inlined, theirs
   * are not.
   */
  readonly depth?: number
}

export interface SimplifiedDocument {
  readonly data: Simplified | ReadonlyArray<Simplified> | null
  /** Pass back as `cursor` to fetch the next page, when there is one. */
  readonly nextCursor?: string
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

const isIdentifier = (value: unknown): value is Json & { id: string; type: string } =>
  isObject(value) && typeof value["id"] === "string" && typeof value["type"] === "string"

const key = (type: string, id: string) => `${type}:${id}`

/** Extracts `page[cursor]` from a JSON:API `links.next` URL. */
export const nextCursor = (links: unknown): string | undefined => {
  if (!isObject(links) || typeof links["next"] !== "string") return undefined
  try {
    return new URL(links["next"], "https://openapi.tidal.com").searchParams.get("page[cursor]") ?? undefined
  } catch {
    return undefined
  }
}

const simplifyResource = (
  identifier: Json & { id: string; type: string },
  index: ReadonlyMap<string, Json>,
  depth: number
): Simplified => {
  // Relationship documents carry bare identifiers; their bodies live in `included`.
  const resource = index.get(key(identifier.type, identifier.id)) ?? identifier
  const out: Record<string, unknown> = { id: identifier.id, type: identifier.type }
  // Identifier meta carries per-edge data such as a playlist item's `addedAt`.
  if (isObject(identifier["meta"])) out["meta"] = identifier["meta"]
  if (isObject(resource["attributes"])) Object.assign(out, resource["attributes"])

  if (depth > 0 && isObject(resource["relationships"])) {
    for (const [name, relationship] of Object.entries(resource["relationships"])) {
      if (!isObject(relationship) || !("data" in relationship)) continue
      const data = relationship["data"]
      if (Array.isArray(data)) {
        const resolved = data.filter(isIdentifier).filter((item) => index.has(key(item.type, item.id)))
        if (resolved.length > 0) out[name] = resolved.map((item) => simplifyResource(item, index, depth - 1))
      } else if (isIdentifier(data) && index.has(key(data.type, data.id))) {
        out[name] = simplifyResource(data, index, depth - 1)
      }
    }
  }
  return out as Simplified
}

/** Flattens a JSON:API document; see the module docs for the shape. */
export const simplify = (document: Document, options: SimplifyOptions = {}): SimplifiedDocument => {
  const depth = options.depth ?? 1
  const index = new Map<string, Json>()
  for (const resource of document.included ?? []) {
    if (isIdentifier(resource)) index.set(key(resource.type, resource.id), resource)
  }
  // Primary resources may also be referenced from `included` relationships.
  const primary = Array.isArray(document.data) ? document.data : [document.data]
  for (const resource of primary) {
    if (isIdentifier(resource) && "attributes" in resource) index.set(key(resource.type, resource.id), resource)
  }

  const data = Array.isArray(document.data)
    ? document.data.filter(isIdentifier).map((item) => simplifyResource(item, index, depth))
    : isIdentifier(document.data)
    ? simplifyResource(document.data, index, depth)
    : null

  const cursor = nextCursor(document.links)
  return cursor === undefined ? { data } : { data, nextCursor: cursor }
}
