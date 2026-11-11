import { Predicate } from "effect"
import { TidalToolError } from "./Tools.ts"

const detailOf = (body: unknown): string | undefined => {
  if (!Predicate.hasProperty(body, "errors") || !Array.isArray(body.errors)) return undefined
  const details = body.errors
    .map((error: unknown) =>
      Predicate.hasProperty(error, "detail") && typeof error.detail === "string" ? error.detail : undefined
    )
    .filter(Predicate.isNotUndefined)
  return details.length > 0 ? details.join("; ") : undefined
}

/**
 * Converts any failure from the TIDAL client into a message the model can act
 * on. Declared tool failures are returned to the client as `isError` results,
 * so the message must not leak secrets: it only ever contains status codes and
 * TIDAL's own error details.
 */
export const toToolError = (error: unknown): TidalToolError => {
  // Generated `TidalApiError`: a documented 4xx/5xx with a JSON:API error body.
  if (Predicate.hasProperty(error, "response") && Predicate.hasProperty(error, "cause")) {
    const status = Predicate.hasProperty(error.response, "status") ? error.response.status : undefined
    const detail = detailOf(error.cause)
    const hint = status === 404
      ? "Not found: check the id, or try another countryCode (availability is per market)."
      : status === 429
      ? "Rate limited by TIDAL; retry shortly."
      : `TIDAL returned HTTP ${String(status)}.`
    return new TidalToolError({ message: detail === undefined ? hint : `${hint} ${detail}` })
  }
  if (Predicate.isTagged(error, "SchemaError")) {
    return new TidalToolError({
      message:
        "TIDAL's response did not match the generated client's schema (the API may have changed; run `pnpm spec:update`). " +
        String(Predicate.hasProperty(error, "message") ? error.message : "")
    })
  }
  if (Predicate.hasProperty(error, "message") && typeof error.message === "string") {
    return new TidalToolError({ message: error.message })
  }
  return new TidalToolError({ message: "Unexpected error calling TIDAL." })
}
