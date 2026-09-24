import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, initFlags, tempDir } from "./harness.js";

let dir: { path: string; cleanup: () => Promise<void> };
let keys: string;

beforeEach(async () => {
  dir = await tempDir();
  keys = join(dir.path, "keys");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await dir.cleanup();
});

const read = async (...parts: string[]): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir.path, ".developer-footprint", ...parts), "utf8")) as Record<
    string,
    unknown
  >;

/** init -> keygen -> sign, returning the harness for further commands. */
async function signedProject() {
  const h = harness({ cwd: dir.path });
  expect(await h.run(initFlags())).toBe(0);
  expect(await h.run(["keygen", "--key-dir", keys])).toBe(0);
  expect(await h.run(["sign", "--key-dir", keys])).toBe(0);
  return h;
}

describe("top level", () => {
  it("prints help, with a non-zero exit when no command is given", async () => {
    const none = harness({ cwd: dir.path });
    expect(await none.run([])).toBe(2);
    expect(none.stdout()).toContain("Usage: developer-footprint <command>");
    const explicit = harness({ cwd: dir.path });
    expect(await explicit.run(["--help"])).toBe(0);
    for (const command of ["init", "keygen", "sign", "verify", "validate", "doctor", "id"]) {
      expect(explicit.stdout()).toContain(command);
    }
    expect(explicit.stdout()).toContain("none of these commands touch the network");
  });

  it("prints the version", async () => {
    const h = harness({ cwd: dir.path });
    expect(await h.run(["--version"])).toBe(0);
    expect(h.stdout().trim()).toBe("0.0.0-test");
  });

  it("rejects unknown commands and unknown flags as usage errors", async () => {
    const unknown = harness({ cwd: dir.path });
    expect(await unknown.run(["publish"])).toBe(2);
    expect(unknown.stderr()).toContain('unknown command "publish"');
    const constructor_ = harness({ cwd: dir.path });
    expect(await constructor_.run(["constructor"])).toBe(2);
    const flag = harness({ cwd: dir.path });
    expect(await flag.run(["verify", "--frobnicate"])).toBe(2);
  });

  it("every command documents itself", async () => {
    for (const command of ["init", "keygen", "sign", "verify", "validate", "doctor", "id"]) {
      const h = harness({ cwd: dir.path });
      expect(await h.run([command, "--help"]), command).toBe(0);
      expect(h.stdout()).toContain(`developer-footprint ${command}`);
    }
  });
});

describe("init", () => {
  it("creates valid documents from flags and publishes nothing", async () => {
    const fetchTrap = vi.fn(() => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", fetchTrap);
    const h = harness({ cwd: dir.path });
    expect(await h.run(initFlags())).toBe(0);
    expect(fetchTrap).not.toHaveBeenCalled();
    expect(h.stdout()).toContain("Nothing was signed, uploaded or published.");
    expect(h.stdout()).toContain("https://sarah.example/.well-known/developer-footprint.json");

    const identity = await read("identity.json");
    const footprint = (await read("footprint.json")) as {
      contributors: unknown;
      project: { name: string };
    };
    expect(identity).toMatchObject({
      type: "Person",
      name: "Sarah",
      canonicalUrl: "https://sarah.example/",
      keys: [],
    });
    expect(footprint.project.name).toBe("MyCoolApp");
    expect(footprint.contributors).toEqual([
      { identity: "https://sarah.example/.well-known/developer-footprint.json", role: "creator" },
    ]);
    expect(existsSync(join(dir.path, ".developer-footprint", "footprint.sig"))).toBe(false);
  });

  it("never assumes a role", async () => {
    const h = harness({ cwd: dir.path });
    const flags = initFlags();
    flags.splice(flags.indexOf("--role"), 2);
    expect(await h.run(flags)).toBe(2);
    expect(h.stderr()).toContain("missing --role");
    expect(existsSync(join(dir.path, ".developer-footprint"))).toBe(false);
  });

  it("rejects an unknown role and bad URLs before writing anything", async () => {
    for (const override of [
      { role: "boss" },
      { url: "http://sarah.example" },
      { url: "https://127.0.0.1/" },
      { "project-url": "javascript:alert(1)" },
      { type: "robot" },
    ]) {
      const h = harness({ cwd: dir.path });
      expect(await h.run(initFlags(override)), JSON.stringify(override)).toBe(2);
      expect(existsSync(join(dir.path, ".developer-footprint"))).toBe(false);
    }
  });

  it("refuses to overwrite existing documents unless forced", async () => {
    const h = harness({ cwd: dir.path });
    expect(await h.run(initFlags())).toBe(0);
    const before = await readFile(join(dir.path, ".developer-footprint", "identity.json"), "utf8");
    const again = harness({ cwd: dir.path });
    expect(await again.run(initFlags({ name: "Someone Else" }))).toBe(2);
    expect(again.stderr()).toContain("already exists");
    expect(await readFile(join(dir.path, ".developer-footprint", "identity.json"), "utf8")).toBe(
      before,
    );
    const forced = harness({ cwd: dir.path });
    expect(await forced.run([...initFlags({ name: "Someone Else" }), "--force"])).toBe(0);
    expect((await read("identity.json"))["name"]).toBe("Someone Else");
  });

  it("stores hostile-looking text as inert data and never executes it", async () => {
    // Relative marker: if anything ran this through a shell it would appear in the working directory.
    const name = "Sarah $(touch pwned) ; `touch pwned` | rm -rf / && echo hi > pwned";
    const h = harness({ cwd: dir.path });
    expect(await h.run(initFlags({ name }))).toBe(0);
    expect((await read("identity.json"))["name"]).toBe(name);
    expect(existsSync(join(dir.path, "pwned"))).toBe(false);
    expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
    const check = harness({ cwd: dir.path });
    expect(await check.run(["validate"])).toBe(0);
  });

  it("rejects names that could spoof or corrupt the terminal", async () => {
    const h = harness({ cwd: dir.path });
    expect(await h.run(initFlags({ name: `Sarah${String.fromCharCode(27)}[2J` }))).toBe(2);
    const bidi = harness({ cwd: dir.path });
    expect(await bidi.run(initFlags({ name: `Sarah${String.fromCodePoint(0x202e)}gnp` }))).toBe(2);
  });

  it("credits additional contributors explicitly", async () => {
    const h = harness({ cwd: dir.path });
    const john = "https://john.example/.well-known/developer-footprint.json";
    expect(
      await h.run([
        ...initFlags(),
        "--contributor",
        `${john}=contributor`,
        "--contributor",
        `${john}=maintainer`,
      ]),
    ).toBe(0);
    expect((await read("footprint.json"))["contributors"]).toEqual([
      { identity: "https://sarah.example/.well-known/developer-footprint.json", role: "creator" },
      { identity: john, role: "contributor" },
      { identity: john, role: "maintainer" },
    ]);
    const bad = harness({ cwd: dir.path });
    expect(await bad.run([...initFlags(), "--force", "--contributor", `${john}=boss`])).toBe(2);
    const malformed = harness({ cwd: dir.path });
    expect(await malformed.run([...initFlags(), "--force", "--contributor", "nope"])).toBe(2);
  });

  it("asks questions interactively and re-asks on invalid answers", async () => {
    const answers = [
      "person",
      "Sarah",
      "not a url", // rejected, asked again
      "https://sarah.example",
      "https://github.com/sarah",
      "", // LinkedIn skipped
      "MyCoolApp",
      "https://mycoolapp.example",
      "", // repository skipped
      "", // role left blank: not allowed, asked again
      "maintainer",
    ];
    const h = harness({ cwd: dir.path, answers });
    expect(await h.run(["init"])).toBe(0);
    expect(answers).toEqual([]);
    expect(h.stderr()).toContain("URL must be an absolute URL");
    expect(h.stderr()).toContain("a value is required");
    const footprint = (await read("footprint.json")) as { contributors: { role: string }[] };
    expect(footprint.contributors[0]?.role).toBe("maintainer");
  });

  it("reuses an existing identity for another project", async () => {
    const first = harness({ cwd: dir.path });
    expect(await first.run(initFlags())).toBe(0);
    expect(await first.run(["keygen", "--key-dir", keys])).toBe(0);
    const second = join(dir.path, "second-project");
    await mkdir(second);
    const h = harness({ cwd: second });
    const identityFile = join(dir.path, ".developer-footprint", "identity.json");
    expect(
      await h.run([
        "init",
        "--identity-file",
        identityFile,
        "--project-name",
        "Another",
        "--role",
        "author",
      ]),
    ).toBe(0);
    const reused = JSON.parse(
      await readFile(join(second, ".developer-footprint", "identity.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(reused).toEqual(await read("identity.json"));
    // The reused identity keeps its key, so the second project can be signed with the same key.
    expect(await h.run(["sign", "--key-dir", keys])).toBe(0);
  });

  it("fails with a helpful message when input is not interactive and a value is missing", async () => {
    const h = harness({ cwd: dir.path });
    expect(await h.run(["init", "--type", "person"])).toBe(2);
    expect(h.stderr()).toContain("missing --name");
    expect(h.stderr()).toContain("pass every value as a flag");
  });
});

describe("keygen", () => {
  it("stores the private key outside the project, with owner-only permissions", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    expect(await h.run(["keygen", "--key-dir", keys])).toBe(0);

    const identity = (await read("identity.json")) as { keys: { id: string; publicKey: string }[] };
    expect(identity.keys).toHaveLength(1);
    const keyId = identity.keys[0]!.id;
    const keyFile = join(keys, `${keyId}.key.json`);
    const stored = JSON.parse(await readFile(keyFile, "utf8")) as {
      privateKey: string;
      keyId: string;
    };
    expect(stored.keyId).toBe(keyId);
    if (process.platform !== "win32") expect((await stat(keyFile)).mode & 0o777).toBe(0o600);

    // The private key must not be inside the project directory, in the output, or in identity.json.
    expect(keyFile.startsWith(join(dir.path, ".developer-footprint"))).toBe(false);
    expect(h.stdout()).not.toContain(stored.privateKey);
    expect(JSON.stringify(identity)).not.toContain(stored.privateKey);
    expect(h.stdout()).toContain("Keep the private key safe");
  });

  it("needs an identity first", async () => {
    const h = harness({ cwd: dir.path });
    expect(await h.run(["keygen", "--key-dir", keys])).toBe(2);
    expect(h.stderr()).toContain("Run `developer-footprint init` first.");
  });

  it("uses DEVELOPER_FOOTPRINT_KEY_DIR when no flag is given", async () => {
    const h = harness({ cwd: dir.path, env: { DEVELOPER_FOOTPRINT_KEY_DIR: keys } });
    await h.run(initFlags());
    expect(await h.run(["keygen"])).toBe(0);
    expect(h.stdout()).toContain(keys);
  });

  it("adds a second key without disturbing the first", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await h.run(["keygen", "--key-dir", keys]);
    await h.run(["keygen", "--key-dir", keys]);
    expect(((await read("identity.json")) as { keys: unknown[] }).keys).toHaveLength(2);
  });
});

describe("sign and verify", () => {
  it("completes the whole flow and verifies offline", async () => {
    const h = await signedProject();
    const verify = harness({ cwd: dir.path });
    expect(await verify.run(["verify"])).toBe(0);
    const text = verify.stdout();
    expect(text).toContain("Signature valid");
    expect(text).toContain("Footprint unchanged");
    expect(text).toContain("Not checked (needs the network, which this command never uses)");
    expect(text).toContain("The identity document is the bundled copy");
    expect(text).toContain("creator");
    expect(h.stderr()).toBe("");
  });

  it("emits machine-readable results and exit codes", async () => {
    await signedProject();
    const v = harness({ cwd: dir.path });
    expect(await v.run(["verify", "--json"])).toBe(0);
    const parsed = JSON.parse(v.stdout()) as {
      valid: boolean;
      identitySource: string;
      checks: Record<string, { status: string }>;
    };
    expect(parsed).toMatchObject({ valid: true, identitySource: "bundled" });
    expect(parsed.checks["signature"]?.status).toBe("pass");
    expect(parsed.checks["claimCurrent"]?.status).toBe("not_checked");
  });

  it("reports tampering and exits 1", async () => {
    await signedProject();
    const path = join(dir.path, ".developer-footprint", "footprint.json");
    const footprint = JSON.parse(await readFile(path, "utf8")) as {
      contributors: { role: string }[];
    };
    footprint.contributors[0]!.role = "owner"; // creator quietly upgraded to owner
    await writeFile(path, JSON.stringify(footprint, null, 2));

    const v = harness({ cwd: dir.path });
    expect(await v.run(["verify"])).toBe(1);
    expect(v.stdout()).toContain("Not verified.");
    expect(v.stdout()).toContain("do not match the document that was signed");
    expect(v.stdout()).toContain("This does not prove malicious behavior");
    const json = harness({ cwd: dir.path });
    expect(await json.run(["verify", "--json"])).toBe(1);
    expect((JSON.parse(json.stdout()) as { errors: { code: string }[] }).errors[0]?.code).toBe(
      "DIGEST_MISMATCH",
    );
  });

  it("uses an identity document supplied by the verifier", async () => {
    await signedProject();
    const supplied = join(dir.path, "downloaded-identity.json");
    await writeFile(
      supplied,
      await readFile(join(dir.path, ".developer-footprint", "identity.json")),
    );
    const v = harness({ cwd: dir.path });
    expect(await v.run(["verify", "--identity", supplied])).toBe(0);
    expect(v.stdout()).toContain("supplied with --identity");
    expect(v.stdout()).not.toContain("bundled copy");
  });

  it("rejects an attacker's bundled identity that claims the victim's URL", async () => {
    // The attacker signs with their own key but the identity names the victim's domain: the
    // supplied (authentic) identity has a different key, so verification must fail.
    await signedProject();
    const attackerDir = join(dir.path, "attacker");
    await mkdir(attackerDir);
    const attacker = harness({ cwd: attackerDir, randomSeed: 99 });
    await attacker.run(initFlags({ name: "Sarah" }));
    await attacker.run(["keygen", "--key-dir", join(attackerDir, "keys")]);
    await attacker.run(["sign", "--key-dir", join(attackerDir, "keys")]);
    // Self-consistent forgery verifies against its own bundled identity...
    const forged = harness({ cwd: attackerDir });
    expect(await forged.run(["verify"])).toBe(0);
    // ...but not against the genuine identity the real Sarah publishes.
    const genuine = join(dir.path, ".developer-footprint", "identity.json");
    const check = harness({ cwd: attackerDir });
    expect(await check.run(["verify", "--identity", genuine])).toBe(1);
  });

  it("explains a missing private key and points at --key-dir", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await h.run(["keygen", "--key-dir", keys]);
    const elsewhere = harness({ cwd: dir.path });
    expect(await elsewhere.run(["sign", "--key-dir", join(dir.path, "empty")])).toBe(2);
    expect(elsewhere.stderr()).toContain("is not on this machine");
    expect(elsewhere.stderr()).toContain("USB drive");
  });

  it("refuses to guess between several active keys", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await h.run(["keygen", "--key-dir", keys]);
    await h.run(["keygen", "--key-dir", keys]);
    const s = harness({ cwd: dir.path });
    expect(await s.run(["sign", "--key-dir", keys])).toBe(2);
    expect(s.stderr()).toContain("2 active keys");
    const identity = (await read("identity.json")) as { keys: { id: string }[] };
    const chosen = harness({ cwd: dir.path });
    expect(await chosen.run(["sign", "--key-dir", keys, "--key", identity.keys[1]!.id])).toBe(0);
  });

  it("never lets a key id escape the key directory", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await h.run(["keygen", "--key-dir", keys]);
    const s = harness({ cwd: dir.path });
    expect(await s.run(["sign", "--key-dir", keys, "--key", "../../../etc/passwd"])).toBe(2);
    // The same holds when the id comes from an untrusted identity document.
    const path = join(dir.path, ".developer-footprint", "identity.json");
    const identity = JSON.parse(await readFile(path, "utf8")) as { keys: { id: string }[] };
    identity.keys[0]!.id = "../../../etc/passwd";
    await writeFile(path, JSON.stringify(identity));
    const t = harness({ cwd: dir.path });
    expect(await t.run(["sign", "--key-dir", keys])).toBe(1);
  });

  it("refuses to sign as an identity the footprint does not credit", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await h.run(["keygen", "--key-dir", keys]);
    const path = join(dir.path, ".developer-footprint", "footprint.json");
    const footprint = JSON.parse(await readFile(path, "utf8")) as {
      contributors: { identity: string }[];
    };
    footprint.contributors[0]!.identity =
      "https://john.example/.well-known/developer-footprint.json";
    await writeFile(path, JSON.stringify(footprint));
    const s = harness({ cwd: dir.path });
    expect(await s.run(["sign", "--key-dir", keys])).toBe(2);
    expect(s.stderr()).toContain("is not listed as a contributor");
  });

  it("does not sign a footprint that fails validation", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await h.run(["keygen", "--key-dir", keys]);
    await writeFile(
      join(dir.path, ".developer-footprint", "footprint.json"),
      '{"specVersion":"9.9"}',
    );
    const s = harness({ cwd: dir.path });
    expect(await s.run(["sign", "--key-dir", keys])).toBe(1);
    expect(existsSync(join(dir.path, ".developer-footprint", "footprint.sig"))).toBe(false);
  });

  it("exits 2 when files are missing", async () => {
    const v = harness({ cwd: dir.path });
    expect(await v.run(["verify"])).toBe(2);
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    const noSig = harness({ cwd: dir.path });
    expect(await noSig.run(["verify"])).toBe(2);
    expect(noSig.stderr()).toContain("Run `developer-footprint sign` first.");
  });

  it("makes no network requests anywhere in the flow", async () => {
    const trap = vi.fn(() => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", trap);
    await signedProject();
    const v = harness({ cwd: dir.path });
    await v.run(["verify"]);
    await v.run(["validate"]);
    await v.run(["doctor", "--key-dir", keys]);
    expect(trap).not.toHaveBeenCalled();
  });
});

describe("validate", () => {
  it("passes valid documents and prints the canonical digest", async () => {
    await signedProject();
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate"])).toBe(0);
    expect(v.stdout()).toContain("identity document follows Developer Footprint 1.0");
    expect(v.stdout()).toContain("canonical digest  sha256:");
    expect(v.stdout()).toContain("Valid.");
  });

  it("locates every problem by JSON Pointer", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    const path = join(dir.path, ".developer-footprint", "footprint.json");
    const footprint = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & {
      contributors: { role: string }[];
      project: Record<string, unknown>;
    };
    footprint.contributors[0]!.role = "boss";
    footprint.project["url"] = "javascript:alert(1)";
    footprint["extra"] = 1;
    await writeFile(path, JSON.stringify(footprint));
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate"])).toBe(1);
    expect(v.stdout()).toContain("/contributors/0/role");
    expect(v.stdout()).toContain("/project/url");
    expect(v.stdout()).toContain("/extra");
    expect(v.stdout()).toContain("Not valid.");
  });

  it("rejects duplicate JSON keys", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await writeFile(
      join(dir.path, ".developer-footprint", "footprint.json"),
      '{"specVersion":"1.0","specVersion":"1.0"}',
    );
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate"])).toBe(1);
    expect(v.stdout()).toContain("duplicate key");
  });

  it("tolerates a byte-order mark written by Windows tools", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    const path = join(dir.path, ".developer-footprint", "identity.json");
    await writeFile(path, `${String.fromCharCode(0xfeff)}${await readFile(path, "utf8")}`);
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate"])).toBe(0);
  });

  it("refuses oversized documents without reading them", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    await writeFile(
      join(dir.path, ".developer-footprint", "identity.json"),
      " ".repeat(300 * 1024),
    );
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate"])).toBe(1);
    expect(v.stdout()).toContain("larger than");
  });

  it("treats a directory where a document should be as unreadable", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    const path = join(dir.path, ".developer-footprint", "identity.json");
    await (await import("node:fs/promises")).rm(path);
    await mkdir(path);
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate"])).toBe(2);
  });

  it("warns when the identity is not credited in the footprint", async () => {
    const h = harness({ cwd: dir.path });
    await h.run(initFlags());
    const path = join(dir.path, ".developer-footprint", "footprint.json");
    const footprint = JSON.parse(await readFile(path, "utf8")) as {
      contributors: { identity: string }[];
    };
    footprint.contributors[0]!.identity =
      "https://john.example/.well-known/developer-footprint.json";
    await writeFile(path, JSON.stringify(footprint));
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate"])).toBe(0);
    expect(v.stdout()).toContain("is not credited in this footprint");
  });

  it("emits JSON", async () => {
    await signedProject();
    const v = harness({ cwd: dir.path });
    expect(await v.run(["validate", "--json"])).toBe(0);
    expect((JSON.parse(v.stdout()) as { valid: boolean }).valid).toBe(true);
  });
});

describe("doctor", () => {
  it("reports a healthy setup", async () => {
    await signedProject();
    const d = harness({ cwd: dir.path });
    expect(await d.run(["doctor", "--key-dir", keys])).toBe(0);
    expect(d.stdout()).toContain("Ed25519 signatures supported");
    expect(d.stdout()).toContain("Private key for");
    expect(d.stdout()).toContain("footprint.sig verifies against this identity");
    expect(d.stdout()).toContain("No network requests were made.");
  });

  it("treats a key that lives elsewhere as a warning, not a failure", async () => {
    await signedProject();
    const d = harness({ cwd: dir.path });
    expect(await d.run(["doctor", "--key-dir", join(dir.path, "elsewhere")])).toBe(0);
    expect(d.stdout()).toContain("is not on this machine");
  });

  it("fails when the signature no longer verifies", async () => {
    await signedProject();
    const path = join(dir.path, ".developer-footprint", "footprint.json");
    const footprint = JSON.parse(await readFile(path, "utf8")) as { project: { name: string } };
    footprint.project.name = "Renamed";
    await writeFile(path, JSON.stringify(footprint));
    const d = harness({ cwd: dir.path });
    expect(await d.run(["doctor", "--key-dir", keys])).toBe(1);
    expect(d.stdout()).toContain("does not verify");
  });

  it("guides a first-time user when there is no project", async () => {
    const d = harness({ cwd: dir.path });
    expect(await d.run(["doctor"])).toBe(0);
    expect(d.stdout()).toContain("developer-footprint init");
  });

  it("flags an unsupported Node.js version", async () => {
    const d = harness({ cwd: dir.path });
    (d.context as { nodeVersion: string }).nodeVersion = "18.0.0";
    expect(await d.run(["doctor"])).toBe(1);
    expect(d.stdout()).toContain("Node.js 22 or newer is required");
  });
});

describe("id", () => {
  it("prints well-formed ids of every kind without any project or network", async () => {
    for (const [kind, pattern] of [
      ["identity", /^df:identity:[0-9A-HJKMNP-TV-Z]{26}$/],
      ["project", /^df:project:[0-9A-HJKMNP-TV-Z]{26}$/],
      ["footprint", /^fp_[0-9A-HJKMNP-TV-Z]{26}$/],
      ["key", /^key_[0-9A-HJKMNP-TV-Z]{26}$/],
    ] as const) {
      const h = harness({ cwd: dir.path });
      expect(await h.run(["id", kind])).toBe(0);
      expect(h.stdout().trim()).toMatch(pattern);
    }
  });

  it("defaults to an identity id and supports --count", async () => {
    const h = harness({ cwd: dir.path });
    expect(await h.run(["id", "--count", "3"])).toBe(0);
    const lines = h.stdout().trim().split("\n");
    expect(new Set(lines).size).toBe(3);
    expect(lines.every((line) => line.startsWith("df:identity:"))).toBe(true);
  });

  it("rejects bad arguments", async () => {
    for (const argv of [
      ["id", "user"],
      ["id", "--count", "0"],
      ["id", "--count", "101"],
      ["id", "--count", "x"],
      ["id", "key", "extra"],
    ]) {
      const h = harness({ cwd: dir.path });
      expect(await h.run(argv), argv.join(" ")).toBe(2);
    }
  });
});
