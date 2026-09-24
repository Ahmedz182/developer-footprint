# developer-footprint (CLI)

Create an identity, sign a project footprint, verify it offline, and put it on any website.

```bash
npx developer-footprint init      # identity + project + your explicit role
npx developer-footprint keygen    # a signing key; the private half stays on your machine
npx developer-footprint sign
npx developer-footprint verify    # offline, no network
npx developer-footprint export --badge   # static files + HTML snippet for any site
```

Node.js ≥ 22. No telemetry, and none of these commands touch the network.

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

Exit codes: `0` success, `1` documents checked and not valid, `2` could not run (usage error,
missing or unreadable file). Every command takes `--help`.

Private keys are stored outside your project (`--key-dir`, `DEVELOPER_FOOTPRINT_KEY_DIR`, or your
user config directory), with owner-only permissions, and are never overwritten or uploaded.

Full documentation, screenshots and guides: the [repository README](../../README.md).
