/**
 * Hard limits applied to untrusted input (SPEC.md §3.6). They are part of the protocol so that
 * independent implementations accept and reject the same documents.
 */
export const LIMITS = {
  /** Maximum size of any single protocol document, in UTF-8 bytes. */
  maxDocumentBytes: 256 * 1024,
  /** Maximum JSON nesting depth. Real documents nest at most 4 levels. */
  maxJsonDepth: 32,
  maxUrlLength: 2048,
  maxNameCodePoints: 100,
  maxDescriptionCodePoints: 500,
  maxVersionLength: 64,
  maxContributors: 256,
  maxKeys: 16,
  maxProfiles: 16,
} as const;

/** Path of the identity document under any origin (RFC 8615). */
export const WELL_KNOWN_PATH = "/.well-known/developer-footprint.json";
