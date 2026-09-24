import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface SigningVectors {
  identity: unknown;
  footprint: unknown;
  signature: { signer: string };
  cases: { name: string; footprint: unknown; signature: unknown; identity: unknown }[];
}

const specDir = fileURLToPath(new URL("../../../spec/test-vectors/", import.meta.url));
export const vectors = JSON.parse(readFileSync(`${specDir}signing.json`, "utf8")) as SigningVectors;

export const FOOTPRINT_URL =
  "https://mycoolapp.example/.well-known/developer-footprint/footprint.json";
export const SIGNATURE_URL =
  "https://mycoolapp.example/.well-known/developer-footprint/footprint.sig";
export const IDENTITY_URL = vectors.signature.signer;

export function vectorCase(name: string) {
  const found = vectors.cases.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no vector named ${name}`);
  return found;
}

export interface Served {
  readonly body: unknown;
  readonly status?: number;
  readonly redirectedTo?: string;
  readonly headers?: Record<string, string>;
}

export interface CallRecord {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fake `fetch` over an in-memory site. Records every request it receives. */
export function fakeSite(site: Record<string, Served | "network-error">): {
  fetch: typeof fetch;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const served = site[url];
    if (served === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (served === "network-error") return Promise.reject(new TypeError("Failed to fetch"));
    const response = new Response(
      typeof served.body === "string" ? served.body : JSON.stringify(served.body),
      {
        status: served.status ?? 200,
        ...(served.headers === undefined ? {} : { headers: served.headers }),
      },
    );
    if (served.redirectedTo !== undefined) {
      Object.defineProperty(response, "redirected", { value: true });
      Object.defineProperty(response, "url", { value: served.redirectedTo });
    }
    return Promise.resolve(response);
  };
  return { fetch: fetchImpl, calls };
}

/** The genuine site: project files on the project's domain, identity on the signer's domain. */
export function genuineSite() {
  return fakeSite({
    [FOOTPRINT_URL]: { body: vectors.footprint },
    [SIGNATURE_URL]: { body: vectors.signature },
    [IDENTITY_URL]: { body: vectors.identity },
  });
}
