import { describe, expect, it } from "vitest";

describe("server-side rendering safety", () => {
  it("can be imported where there is no DOM, and registering is a harmless no-op", async () => {
    expect(typeof (globalThis as { HTMLElement?: unknown }).HTMLElement).toBe("undefined");
    const web = await import("../src/index.js");
    expect(web.defineFootprintBadge()).toBe(false);
    expect(web.DEFAULT_TAG).toBe("developer-footprint-badge");
    // The side-effect entry must not throw either (frameworks import it during SSR).
    await expect(import("../src/register.js")).resolves.toBeDefined();
  });
});
