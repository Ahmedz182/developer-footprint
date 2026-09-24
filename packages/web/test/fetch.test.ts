import { describe, expect, it } from "vitest";
import { fetchDocument, resolveFetchUrl } from "../src/index.js";
import { fakeSite } from "./support.js";

const URL_OK = "https://example.com/.well-known/developer-footprint.json";

describe("resolveFetchUrl", () => {
  it("allows https and loopback http only", () => {
    expect(resolveFetchUrl("https://example.com/a")).toMatchObject({ ok: true });
    expect(resolveFetchUrl("http://localhost:8080/a")).toMatchObject({ ok: true });
    expect(resolveFetchUrl("http://127.0.0.1:3000/a")).toMatchObject({ ok: true });
    expect(resolveFetchUrl("http://[::1]:3000/a")).toMatchObject({ ok: true });
    for (const bad of [
      "http://example.com/a",
      "javascript:alert(1)",
      "data:application/json,{}",
      "file:///etc/passwd",
      "blob:https://example.com/x",
      "ftp://example.com/a",
      "https://user:pw@example.com/a",
      "not a url",
      "",
    ]) {
      expect(resolveFetchUrl(bad), bad).toMatchObject({ ok: false, error: { code: "BAD_URL" } });
    }
  });

  it("resolves relative URLs against a base and drops fragments", () => {
    const result = resolveFetchUrl("../x.json#frag", "https://example.com/a/b/");
    expect(result.ok && result.value.href).toBe("https://example.com/a/x.json");
  });

  it("does not let a relative URL escape to another scheme", () => {
    expect(resolveFetchUrl("//evil.example/x", "https://example.com/")).toMatchObject({ ok: true });
    expect(resolveFetchUrl("javascript:alert(1)", "https://example.com/")).toMatchObject({
      ok: false,
    });
  });
});

describe("fetchDocument", () => {
  it("fetches and parses JSON, sending no cookies and no referrer", async () => {
    const site = fakeSite({ [URL_OK]: { body: { hello: "world" } } });
    expect(await fetchDocument(URL_OK, { fetch: site.fetch })).toEqual({
      ok: true,
      value: { hello: "world" },
    });
    const init = site.calls[0]?.init;
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
    });
  });

  it("does not require a JSON content type", async () => {
    const site = fakeSite({
      [URL_OK]: { body: '{"a":1}', headers: { "content-type": "text/plain" } },
    });
    expect(await fetchDocument(URL_OK, { fetch: site.fetch })).toMatchObject({ ok: true });
  });

  it("tolerates a byte-order mark", async () => {
    const site = fakeSite({ [URL_OK]: { body: `${String.fromCharCode(0xfeff)}{"a":1}` } });
    expect(await fetchDocument(URL_OK, { fetch: site.fetch })).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("rejects non-2xx answers", async () => {
    const site = fakeSite({ [URL_OK]: { body: "nope", status: 404 } });
    expect(await fetchDocument(URL_OK, { fetch: site.fetch })).toMatchObject({
      ok: false,
      error: { code: "HTTP_STATUS" },
    });
    expect(
      await fetchDocument("https://example.com/missing.json", { fetch: site.fetch }),
    ).toMatchObject({
      ok: false,
      error: { code: "HTTP_STATUS" },
    });
  });

  it("reports network failures with a CORS hint", async () => {
    const site = fakeSite({ [URL_OK]: "network-error" });
    const result = await fetchDocument(URL_OK, { fetch: site.fetch });
    expect(result).toMatchObject({ ok: false, error: { code: "NETWORK" } });
    expect(!result.ok && result.error.message).toContain("CORS");
  });

  it("times out", async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      })) as unknown as typeof fetch;
    const result = await fetchDocument(URL_OK, { fetch: hanging, timeoutMs: 30 });
    expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });

  it("follows a redirect within the same origin but refuses one to another site", async () => {
    const same = fakeSite({
      [URL_OK]: { body: { a: 1 }, redirectedTo: "https://example.com/elsewhere.json" },
    });
    expect(await fetchDocument(URL_OK, { fetch: same.fetch })).toMatchObject({ ok: true });

    const cross = fakeSite({
      [URL_OK]: { body: { a: 1 }, redirectedTo: "https://evil.example/x.json" },
    });
    expect(await fetchDocument(URL_OK, { fetch: cross.fetch })).toMatchObject({
      ok: false,
      error: { code: "REDIRECTED_OFF_ORIGIN" },
    });

    const downgrade = fakeSite({
      [URL_OK]: { body: { a: 1 }, redirectedTo: "http://example.com/x.json" },
    });
    expect(await fetchDocument(URL_OK, { fetch: downgrade.fetch })).toMatchObject({ ok: false });
  });

  it("enforces the size limit from the declared length and while streaming", async () => {
    const declared = fakeSite({
      [URL_OK]: { body: "{}", headers: { "content-length": "999999" } },
    });
    expect(await fetchDocument(URL_OK, { fetch: declared.fetch, maxBytes: 1000 })).toMatchObject({
      ok: false,
      error: { code: "TOO_LARGE" },
    });
    // No content-length, so it must be caught while reading.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 50; i++) controller.enqueue(new TextEncoder().encode(" ".repeat(100)));
        controller.close();
      },
    });
    const streaming = (() =>
      Promise.resolve(new Response(stream, { status: 200 }))) as unknown as typeof fetch;
    expect(await fetchDocument(URL_OK, { fetch: streaming, maxBytes: 1000 })).toMatchObject({
      ok: false,
      error: { code: "TOO_LARGE" },
    });
  });

  it("uses the strict parser: duplicates, fractions and garbage are rejected", async () => {
    for (const body of ['{"a":1,"a":2}', '{"a":1.5}', "not json", "", "[1,]", "<html></html>"]) {
      const site = fakeSite({ [URL_OK]: { body } });
      expect(await fetchDocument(URL_OK, { fetch: site.fetch }), body).toMatchObject({
        ok: false,
        error: { code: "INVALID_JSON" },
      });
    }
  });

  it("rejects invalid UTF-8", async () => {
    const bytes = Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d);
    const site = (() => Promise.resolve(new Response(bytes))) as unknown as typeof fetch;
    expect(await fetchDocument(URL_OK, { fetch: site })).toMatchObject({
      ok: false,
      error: { code: "INVALID_JSON" },
    });
  });

  it("never fetches a URL that fails the policy", async () => {
    const site = fakeSite({});
    expect(await fetchDocument("javascript:alert(1)", { fetch: site.fetch })).toMatchObject({
      ok: false,
    });
    expect(await fetchDocument("http://example.com/x", { fetch: site.fetch })).toMatchObject({
      ok: false,
    });
    expect(site.calls).toHaveLength(0);
  });
});
