# developer-footprint

**Know who built it. Verify the claim.** Verifiable software authorship and provenance: create an
identity, sign a project footprint, verify it offline, and show it on any website.

One package, three things:

- a **CLI**: `npx developer-footprint …`
- an **SDK**: `import { verifyFootprint } from "developer-footprint"`
- a **badge for any website** (plain HTML, React, Vue, Svelte, Astro, Angular…):
  `developer-footprint/web` and `developer-footprint/browser`

> Developer Footprint does not track application users, collect hidden telemetry, or require runtime
> network requests. No dependencies; Node.js 22 or newer.

<p align="center">
  <img src="https://raw.githubusercontent.com/Ahmedz182/developer-footprint/main/docs/images/cli-verify.png" width="760" alt="Terminal: developer-footprint verify lists the checks that passed, the three that are not evaluated offline, and 'Signature valid for the supplied documents'" />
</p>

## CLI

```bash
npx developer-footprint init      # identity + project + your explicit role
npx developer-footprint keygen    # a signing key; the private half stays on your machine
npx developer-footprint sign
npx developer-footprint verify    # offline, no network
npx developer-footprint export --badge   # static files + HTML snippet for any site
```

| Command    | What it does                                                     |
| ---------- | ---------------------------------------------------------------- |
| `init`     | Create `.developer-footprint/identity.json` and `footprint.json` |
| `keygen`   | Generate an Ed25519 key; add the public half to your identity    |
| `sign`     | Sign the footprint; write `footprint.sig`                        |
| `verify`   | Verify offline; says exactly what was and was not checked        |
| `validate` | Check the documents against the protocol                         |
| `export`   | Write static files for a website (plain HTML or any framework)   |
| `doctor`   | Diagnose this machine and project                                |
| `id`       | Print fresh identifiers, on any machine, offline                 |

Exit codes: `0` success, `1` documents checked and not valid, `2` could not run. Every command
takes `--help`. Private keys are stored outside your project (`--key-dir`,
`DEVELOPER_FOOTPRINT_KEY_DIR`, or your user config directory) with owner-only permissions, and are
never overwritten or uploaded. No computer of your own? Put the key on a USB stick with `--key-dir`.

## SDK

```ts
import {
  addIdentityKey,
  createFootprint,
  createIdentity,
  generateId,
  generateKeyPair,
  signFootprint,
  unwrap,
  verifyFootprint,
} from "developer-footprint";

const person = unwrap(
  createIdentity({ type: "Person", name: "Sarah", canonicalUrl: "https://sarah.example" }),
);
const { publicKey, privateKey } = unwrap(await generateKeyPair());
const keyId = generateId("key");
const identity = unwrap(addIdentityKey(person, { id: keyId, publicKey }));
const footprint = unwrap(
  createFootprint({
    project: { name: "MyCoolApp" },
    contributors: [{ identity, role: "creator" }], // there is deliberately no default role
  }),
);
const signature = unwrap(await signFootprint({ footprint, identity, keyId, privateKey }));
const result = await verifyFootprint({ footprint, signature, identity });
result.valid; // true. Each check is also reported separately; nothing is assumed.
```

The SDK performs no I/O, has no telemetry, and returns `{ ok, value | error }` instead of throwing.

## On a website

```html
<developer-footprint-badge src="/.well-known/developer-footprint/"></developer-footprint-badge>
<script type="module" src="/developer-footprint/badge.js"></script>
```

`npx developer-footprint export --badge` writes the files (including `badge.js`) into your site's
public folder. With a bundler or framework:

```ts
import { defineFootprintBadge } from "developer-footprint/web"; // no-op on the server
defineFootprintBadge();
// or: import "developer-footprint/register";
```

`developer-footprint/browser` is the path of the self-contained script. Also exported:
`loadAndVerify` (fetch and verify a footprint in the browser).

Full documentation, screenshots, framework guides (React, Next.js, Vue, Nuxt, Svelte, Astro,
Angular, Hugo, Jekyll, CMSs) and the security model:
[github.com/Ahmedz182/developer-footprint](https://github.com/Ahmedz182/developer-footprint#readme).
