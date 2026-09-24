import { describe, expect, it } from "vitest";
import { describeProblem, describeVerification, loadAndVerify } from "../src/index.js";
import {
  FOOTPRINT_URL,
  IDENTITY_URL,
  SIGNATURE_URL,
  fakeSite,
  genuineSite,
  vectorCase,
  vectors,
} from "./support.js";

const base = { footprint: FOOTPRINT_URL, signature: SIGNATURE_URL };

describe("loadAndVerify", () => {
  it("verifies a genuine footprint, fetching the identity from the signer's own domain", async () => {
    const site = genuineSite();
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { result } = outcome.value;
    expect(result.valid).toBe(true);
    expect(outcome.value.identitySource).toBe("signer-domain");
    expect(outcome.value.identityUrl).toBe(IDENTITY_URL);
    expect(result.checks.identityDocumentResolved).toMatchObject({ status: "pass" });
    expect(result.checks.domainRelationship).toMatchObject({ status: "pass" });
    // Superseded/revoked state needs a registry; it must never be reported as fine.
    expect(result.checks.claimCurrent.status).toBe("not_checked");
    expect(site.calls.map((call) => call.url).sort()).toEqual(
      [FOOTPRINT_URL, IDENTITY_URL, SIGNATURE_URL].sort(),
    );
  });

  it("makes every request credential-free and referrer-free", async () => {
    const site = genuineSite();
    await loadAndVerify({ ...base, fetch: site.fetch });
    for (const call of site.calls) {
      expect(call.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    }
  });

  it("uses a supplied identity instead of fetching one, and says so", async () => {
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: vectors.footprint },
      [SIGNATURE_URL]: { body: vectors.signature },
      "https://mycoolapp.example/identity.json": { body: vectors.identity },
    });
    const outcome = await loadAndVerify({
      ...base,
      identity: "https://mycoolapp.example/identity.json",
      fetch: site.fetch,
    });
    expect(outcome.ok && outcome.value.result.valid).toBe(true);
    expect(outcome.ok && outcome.value.identitySource).toBe("supplied");
    // A copy the page author chose says nothing about the signer's domain.
    expect(outcome.ok && outcome.value.result.checks.identityDocumentResolved.status).toBe(
      "not_checked",
    );
    expect(outcome.ok && outcome.value.result.checks.domainRelationship.status).toBe("not_checked");
    expect(site.calls.some((call) => call.url === IDENTITY_URL)).toBe(false);
  });

  it("reports a tampered footprint as a normal, invalid result", async () => {
    const tampered = vectorCase("role-escalated");
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: tampered.footprint },
      [SIGNATURE_URL]: { body: tampered.signature },
      [IDENTITY_URL]: { body: vectors.identity },
    });
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.result.valid).toBe(false);
    expect(outcome.value.result.errors[0]?.code).toBe("DIGEST_MISMATCH");
  });

  it("rejects an identity document that a hostile site serves under the signer's URL with another key", async () => {
    const wrongKey = vectorCase("wrong-public-key");
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: vectors.footprint },
      [SIGNATURE_URL]: { body: vectors.signature },
      [IDENTITY_URL]: { body: wrongKey.identity },
    });
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    expect(outcome.ok && outcome.value.result.valid).toBe(false);
  });

  it("does not credit the domain when the document belongs to a different one", async () => {
    const impostor = vectorCase("identity-from-another-domain");
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: vectors.footprint },
      [SIGNATURE_URL]: { body: vectors.signature },
      [IDENTITY_URL]: { body: impostor.identity },
    });
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.result.valid).toBe(false);
    expect(outcome.value.result.checks.domainRelationship.status).toBe("fail");
  });

  it("refuses an identity redirect that leaves the signer's domain", async () => {
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: vectors.footprint },
      [SIGNATURE_URL]: { body: vectors.signature },
      [IDENTITY_URL]: {
        body: vectors.identity,
        redirectedTo: "https://attacker.example/identity.json",
      },
    });
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    expect(outcome).toMatchObject({
      ok: false,
      error: { what: "identity", code: "REDIRECTED_OFF_ORIGIN" },
    });
  });

  it("does not fetch an identity when the signature is too malformed to name a signer", async () => {
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: vectors.footprint },
      [SIGNATURE_URL]: { body: { hello: "world" } },
    });
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    expect(outcome.ok && outcome.value.result.valid).toBe(false);
    expect(outcome.ok && outcome.value.identityUrl).toBeUndefined();
    expect(site.calls).toHaveLength(2);
  });

  it("names which document could not be loaded", async () => {
    const missingFootprint = await loadAndVerify({ ...base, fetch: fakeSite({}).fetch });
    expect(missingFootprint).toMatchObject({
      ok: false,
      error: { what: "footprint", code: "HTTP_STATUS" },
    });

    const missingSignature = await loadAndVerify({
      ...base,
      fetch: fakeSite({ [FOOTPRINT_URL]: { body: vectors.footprint } }).fetch,
    });
    expect(missingSignature).toMatchObject({ ok: false, error: { what: "signature" } });

    const blockedIdentity = await loadAndVerify({
      ...base,
      fetch: fakeSite({
        [FOOTPRINT_URL]: { body: vectors.footprint },
        [SIGNATURE_URL]: { body: vectors.signature },
        [IDENTITY_URL]: "network-error",
      }).fetch,
    });
    expect(blockedIdentity).toMatchObject({
      ok: false,
      error: { what: "identity", code: "NETWORK" },
    });
  });

  it("never fetches an identity URL that fails the URL policy", async () => {
    const site = genuineSite();
    const outcome = await loadAndVerify({
      ...base,
      identity: "javascript:alert(1)",
      fetch: site.fetch,
    });
    expect(outcome).toMatchObject({ ok: false, error: { what: "identity", code: "BAD_URL" } });
  });
});

describe("badge wording", () => {
  it("says exactly what was established", async () => {
    const outcome = await loadAndVerify({ ...base, fetch: genuineSite().fetch });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const view = describeVerification(outcome.value);
    expect(view.state).toBe("verified");
    expect(view.headline).toBe("Signature verified");
    expect(view.subline).toBe("MyCoolApp: signed by Sarah (sarah.example) on 2026-09-24");
    expect(view.claims).toEqual([
      { role: "creator", who: "Sarah (sarah.example)", isSigner: true },
      { role: "contributor", who: "john.example", isSigner: false },
    ]);
    expect(view.notes.join(" ")).toContain("asserted by the signer");
    expect(view.notes.join(" ")).toContain("not checked here");
    // Never a stronger claim than the signed data states.
    expect(JSON.stringify(view)).not.toMatch(/\bowner\b/);
    expect(view.rows.find((row) => row.label === "Claim is current")?.status).toBe("not_checked");
  });

  it("explains a failure without accusing anyone", async () => {
    const tampered = vectorCase("role-escalated");
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: tampered.footprint },
      [SIGNATURE_URL]: { body: tampered.signature },
      [IDENTITY_URL]: { body: vectors.identity },
    });
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    if (!outcome.ok) throw new Error("expected a verification result");
    const view = describeVerification(outcome.value);
    expect(view.state).toBe("invalid");
    expect(view.headline).toBe("Could not verify this claim");
    expect(view.claims).toEqual([]);
    expect(view.notes.join(" ")).toContain("does not prove malicious behavior");
  });

  it("describes load failures as unable to check, not as a bad claim", async () => {
    const outcome = await loadAndVerify({ ...base, fetch: fakeSite({}).fetch });
    if (outcome.ok) throw new Error("expected a problem");
    const view = describeProblem(outcome.error);
    expect(view.state).toBe("error");
    expect(view.headline).toBe("Could not check this footprint");
    expect(view.notes.join(" ")).toContain("Nothing is wrong with the claim itself");
  });

  it("carries hostile text through as data, for the element to render as text only", async () => {
    const hostile = structuredClone(vectors.footprint) as { project: { name: string } };
    hostile.project.name = "<img src=x onerror=alert(1)>";
    const site = fakeSite({
      [FOOTPRINT_URL]: { body: hostile },
      [SIGNATURE_URL]: { body: vectors.signature },
      [IDENTITY_URL]: { body: vectors.identity },
    });
    const outcome = await loadAndVerify({ ...base, fetch: site.fetch });
    // (Invalid, since the content changed, but the point is that it stays a plain string.)
    if (!outcome.ok) throw new Error("expected a result");
    expect(typeof describeVerification(outcome.value).subline).toBe("string");
  });
});
