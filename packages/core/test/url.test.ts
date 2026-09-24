import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  describeUrlProblem,
  isIdentityDocumentUrl,
  normalizeUrl,
  wellKnownUrlFor,
} from "../src/index.js";

function normalized(input: string): string {
  const result = normalizeUrl(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("normalizeUrl", () => {
  it("lower-cases hosts, resolves dot segments and adds the root slash", () => {
    expect(normalized("https://Sarah.DEV")).toBe("https://sarah.dev/");
    expect(normalized("  https://sarah.dev/a/./b/../c  ")).toBe("https://sarah.dev/a/c");
    expect(normalized("https://sarah.dev:443/x")).toBe("https://sarah.dev/x");
    expect(normalized("https://github.com/sarah/mycoolapp")).toBe(
      "https://github.com/sarah/mycoolapp",
    );
  });

  it("converts internationalized hosts to Punycode so lookalikes are visible", () => {
    // Cyrillic "\u{430}" (U+0430) in place of Latin "a": renders identically, is a different host.
    expect(normalized("https://\u{430}pple.com")).toBe("https://xn--pple-43d.com/");
  });

  it("is idempotent (property)", () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ["https"] }), (url) => {
        const once = normalizeUrl(url);
        if (!once.ok) return true;
        const twice = normalizeUrl(once.value);
        return twice.ok && twice.value === once.value;
      }),
    );
  });
});

describe("URL safety", () => {
  const rejected: Record<string, string> = {
    "javascript scheme": "javascript:alert(1)",
    "data scheme": "data:text/html,<script>alert(1)</script>",
    "file scheme": "file:///etc/passwd",
    "plain http": "http://sarah.dev/",
    "ftp scheme": "ftp://sarah.dev/",
    "scheme-relative": "//sarah.dev/",
    "relative path": "/.well-known/developer-footprint.json",
    "embedded credentials": "https://user:pass@sarah.dev/",
    "username only": "https://user@sarah.dev/",
    "explicit port": "https://sarah.dev:8443/",
    query: "https://sarah.dev/?a=1",
    "empty query": "https://sarah.dev/?",
    fragment: "https://sarah.dev/#top",
    localhost: "https://localhost/",
    "localhost subdomain": "https://api.localhost/",
    "mDNS name": "https://printer.local/",
    "internal name": "https://db.internal/",
    "single label": "https://intranet/",
    "IPv4 loopback": "https://127.0.0.1/",
    "IPv4 private 10/8": "https://10.0.0.1/",
    "IPv4 private 172.16/12": "https://172.16.0.1/",
    "IPv4 private 192.168/16": "https://192.168.1.1/",
    "IPv4 link-local / metadata": "https://169.254.169.254/latest/meta-data/",
    "IPv4 as integer": "https://2130706433/",
    "IPv4 as hex": "https://0x7f.0.0.1/",
    "IPv4 shorthand": "https://127.1/",
    "IPv6 loopback": "https://[::1]/",
    "IPv6 mapped IPv4": "https://[::ffff:127.0.0.1]/",
    "IPv6 unique local": "https://[fd00::1]/",
    "trailing dot": "https://sarah.dev./",
    "underscore host": "https://bad_host.example/",
    "space in host": "https://sarah .dev/",
    empty: "",
    "too long": `https://sarah.dev/${"a".repeat(2100)}`,
  };

  for (const [label, url] of Object.entries(rejected)) {
    it(`rejects ${label}`, () => {
      expect(normalizeUrl(url), url).toMatchObject({
        ok: false,
        error: { code: "INVALID_SCHEMA" },
      });
      expect(describeUrlProblem(url), url).toBeDefined();
    });
  }

  it("validators demand the normalized form and say what it should be", () => {
    expect(describeUrlProblem("https://sarah.dev/")).toBeUndefined();
    expect(describeUrlProblem("https://SARAH.dev/")).toEqual({
      code: "not_normalized",
      message: "URL is not normalized; use https://sarah.dev/",
    });
    expect(describeUrlProblem("https://sarah.dev")).toMatchObject({ code: "not_normalized" });
    expect(describeUrlProblem("https://sarah.dev/a/../b")).toMatchObject({
      code: "not_normalized",
    });
    expect(describeUrlProblem("https://sarah.dev:443/")).toMatchObject({ code: "not_normalized" });
    expect(describeUrlProblem("https://sarah.dev:8443/")).toMatchObject({ code: "invalid_url" });
    // A backslash is a path separator to browsers; it must not slip through as-is.
    expect(describeUrlProblem("https://sarah.dev\\@evil.example/")).toBeDefined();
  });
});

describe("identity document URLs", () => {
  it("derives the well-known URL from an identity's website", () => {
    expect(wellKnownUrlFor("https://sarah.dev/")).toEqual({
      ok: true,
      value: "https://sarah.dev/.well-known/developer-footprint.json",
    });
    // The well-known location is per-origin (RFC 8615), whatever path the website uses.
    expect(wellKnownUrlFor("https://example.com/~sarah")).toEqual({
      ok: true,
      value: "https://example.com/.well-known/developer-footprint.json",
    });
    expect(wellKnownUrlFor("http://sarah.dev/")).toMatchObject({ ok: false });
  });

  it("recognizes only the exact well-known path", () => {
    expect(isIdentityDocumentUrl("https://sarah.dev/.well-known/developer-footprint.json")).toBe(
      true,
    );
    expect(isIdentityDocumentUrl("https://sarah.dev/")).toBe(false);
    expect(isIdentityDocumentUrl("https://sarah.dev/.well-known/developer-footprint.json/x")).toBe(
      false,
    );
    expect(isIdentityDocumentUrl("https://sarah.dev/x/.well-known/developer-footprint.json")).toBe(
      false,
    );
    expect(isIdentityDocumentUrl("https://127.0.0.1/.well-known/developer-footprint.json")).toBe(
      false,
    );
  });
});
