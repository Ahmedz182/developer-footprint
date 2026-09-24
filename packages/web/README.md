# @developer-footprint/web

Show and verify a Developer Footprint on **any website**: plain HTML, React, Next.js, Vue, Nuxt,
Svelte, Astro, Angular, static generators, CMSs. One framework-agnostic custom element.

## Plain HTML: no build step, no CDN

```html
<developer-footprint-badge src="/.well-known/developer-footprint/"></developer-footprint-badge>
<script type="module" src="/developer-footprint/badge.js"></script>
```

`badge.js` is one self-contained file (about 13 kB gzipped, includes the verifier). Get it with
`npx developer-footprint export --badge`, or copy `dist/browser/badge.js` from this package.

## With a bundler or framework

```bash
npm install @developer-footprint/web
```

```ts
import { defineFootprintBadge } from "@developer-footprint/web";
defineFootprintBadge(); // in the browser; a harmless no-op during server-side rendering
```

Or `import "@developer-footprint/web/register"`. Then use `<developer-footprint-badge>` in your
templates. Importing the package never touches the DOM, so it is safe in SSR.

## Attributes

| Attribute                 | Meaning                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `src`                     | Folder holding `footprint.json` and `footprint.sig`                              |
| `footprint` / `signature` | Full URLs, overriding `src`                                                      |
| `identity`                | URL of the signer's identity document. Omit to fetch it from the signer's domain |
| `theme`                   | `light`, `dark` or `auto` (default)                                              |

Events: `footprint-verified`, `footprint-invalid`, `footprint-error` (bubbling, composed). The
element carries `data-state` (`loading`, `verified`, `invalid`, `error`, `unconfigured`) and exposes
the result as `.result`.

## Without the element

```ts
import { loadAndVerify } from "@developer-footprint/web";

const outcome = await loadAndVerify({
  footprint: "https://mycoolapp.example/.well-known/developer-footprint/footprint.json",
  signature: "https://mycoolapp.example/.well-known/developer-footprint/footprint.sig",
});
if (outcome.ok) outcome.value.result.valid;
```

## Security and privacy

- Every string from a document is rendered with `textContent`; the browser test runs under a strict
  CSP with **Trusted Types** enforced.
- Requests are credential-free and send no `Referer`; redirects cannot leave the requested origin;
  size and time are bounded; JSON is parsed strictly; only `https` (and loopback `http` for local
  development) is fetched.
- Fetching the identity document contacts the signer's domain from the visitor's browser. If you
  would rather not, verify at build time with the CLI or core SDK.
- The signer's site must serve the identity document with `Access-Control-Allow-Origin: *`.
