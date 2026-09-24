import { LIMITS, ok, parseJson, type JsonValue, type Result } from "@developer-footprint/core";

export type FetchProblemCode =
  | "BAD_URL"
  | "NETWORK"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "REDIRECTED_OFF_ORIGIN"
  | "TOO_LARGE"
  | "INVALID_JSON";

export interface FetchProblem {
  readonly code: FetchProblemCode;
  readonly message: string;
  readonly url: string;
}

export interface FetchOptions {
  /** Injectable for tests and for runtimes without a global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Abort after this many milliseconds. Default 8000. */
  readonly timeoutMs?: number;
  /** Refuse responses larger than this. Default: the protocol's document limit. */
  readonly maxBytes?: number;
  /** Base for relative URLs. Defaults to the page's own URL in a browser. */
  readonly baseUrl?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function problem(
  code: FetchProblemCode,
  message: string,
  url: string,
): Result<never, FetchProblem> {
  return { ok: false, error: { code, message, url } };
}

/**
 * The URL policy for everything this package fetches: https, or plain http on a loopback host
 * so local development works. No credentials in the URL, no other schemes (`javascript:`,
 * `data:`, `file:`, `blob:`).
 */
export function resolveFetchUrl(raw: string, baseUrl?: string): Result<URL, FetchProblem> {
  let url: URL;
  try {
    url = baseUrl === undefined ? new URL(raw) : new URL(raw, baseUrl);
  } catch {
    return problem("BAD_URL", "not a valid URL", raw);
  }
  const allowed =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!allowed)
    return problem("BAD_URL", "only https URLs are fetched (http is allowed for localhost)", raw);
  if (url.username !== "" || url.password !== "")
    return problem("BAD_URL", "URLs must not contain credentials", raw);
  url.hash = "";
  return ok(url);
}

async function readLimited(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Result<string, FetchProblem>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return problem("TOO_LARGE", `the document is larger than ${maxBytes} bytes`, url);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body === null) {
    const text = await response.text();
    return text.length > maxBytes
      ? problem("TOO_LARGE", `the document is larger than ${maxBytes} bytes`, url)
      : ok(text);
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return problem("TOO_LARGE", `the document is larger than ${maxBytes} bytes`, url);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return problem("INVALID_JSON", "the document is not valid UTF-8", url);
  }
}

/**
 * Fetches and strictly parses one protocol document. Deliberately conservative, because the URL
 * may come from a signed-but-untrusted document:
 *  - only https (or loopback http), no credentials, no cookies (`credentials: "omit"`)
 *  - no `Referer`, so the visited page's address is not leaked to the other site
 *  - a redirect may not leave the requested origin
 *  - bounded time and size, then the strict JSON parser
 * The response content type is not trusted or required: static hosts often mislabel JSON.
 */
export async function fetchDocument(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<Result<JsonValue, FetchProblem>> {
  const target = resolveFetchUrl(
    rawUrl,
    options.baseUrl ?? (typeof document === "undefined" ? undefined : document.baseURI),
  );
  if (!target.ok) return target;
  const url = target.value;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = options.maxBytes ?? LIMITS.maxDocumentBytes;

  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
      return problem("TIMEOUT", "the request timed out", url.href);
    }
    // Browsers report CORS refusals and network failures identically, so mention both.
    return problem(
      "NETWORK",
      `the request failed (offline, blocked, or the site does not allow cross-origin requests: CORS)`,
      url.href,
    );
  }

  if (response.redirected) {
    const finalUrl = resolveFetchUrl(response.url);
    if (!finalUrl.ok || finalUrl.value.origin !== url.origin) {
      return problem(
        "REDIRECTED_OFF_ORIGIN",
        "the request was redirected to a different site",
        url.href,
      );
    }
  }
  if (!response.ok)
    return problem("HTTP_STATUS", `the server answered ${response.status}`, url.href);

  const text = await readLimited(response, maxBytes, url.href);
  if (!text.ok) return text;
  const content = text.value.startsWith(String.fromCharCode(0xfeff))
    ? text.value.slice(1)
    : text.value;
  const parsed = parseJson(content, { maxBytes });
  return parsed.ok ? parsed : problem("INVALID_JSON", parsed.error.message, url.href);
}
