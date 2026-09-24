import { loadAndVerify, type LoadedVerification } from "./load.js";
import {
  LOADING_VIEW,
  UNCONFIGURED_VIEW,
  describeProblem,
  describeVerification,
  type BadgeView,
} from "./view.js";

export const DEFAULT_TAG = "developer-footprint-badge";

export interface BadgeEventDetail {
  readonly loaded?: LoadedVerification;
  readonly problem?: string;
}

const DARK_TOKENS = `
    --dfp-bg: #171a21;
    --dfp-fg: #e8ebf2;
    --dfp-muted: #a3adc2;
    --dfp-border: #343b4a;
    --dfp-ok: #5fd08d;
    --dfp-bad: #ff8a8f;
    --dfp-warn: #f0b95f;`;

// Light by default, dark when the visitor prefers it, and either can be forced with the
// `theme` attribute (a site with its own theme switch needs that).
const STYLE = `
:host {
  --dfp-bg: #ffffff;
  --dfp-fg: #14171f;
  --dfp-muted: #566074;
  --dfp-border: #d5dae3;
  --dfp-ok: #0b6b3a;
  --dfp-bad: #a4262c;
  --dfp-warn: #8a5300;
  display: block;
  max-width: 34rem;
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--dfp-fg);
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {${DARK_TOKENS}
  }
}
:host([theme="dark"]) {${DARK_TOKENS}
}
.card { background: var(--dfp-bg); border: 1px solid var(--dfp-border); border-radius: 12px; padding: 14px 16px; }
.head { display: flex; gap: 10px; align-items: flex-start; }
.icon { flex: none; width: 1.6rem; height: 1.6rem; border-radius: 50%; display: grid; place-items: center;
  font-weight: 700; border: 2px solid currentColor; }
.title { font-weight: 650; margin: 0; }
.sub { margin: 2px 0 0; color: var(--dfp-muted); overflow-wrap: anywhere; }
[data-state="verified"] .icon, [data-state="verified"] .title { color: var(--dfp-ok); }
[data-state="invalid"] .icon, [data-state="invalid"] .title,
[data-state="error"] .icon, [data-state="error"] .title { color: var(--dfp-bad); }
[data-state="loading"] .icon, [data-state="unconfigured"] .icon { color: var(--dfp-muted); }
[data-state="loading"] .icon { animation: dfp-pulse 1.2s ease-in-out infinite; }
@keyframes dfp-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .icon { animation: none !important; } }
ul { list-style: none; margin: 10px 0 0; padding: 0; }
li { margin: 2px 0; overflow-wrap: anywhere; }
.role { display: inline-block; min-width: 6.5rem; font-weight: 600; }
.note { margin: 8px 0 0; color: var(--dfp-muted); font-size: 13px; }
details { margin-top: 10px; border-top: 1px solid var(--dfp-border); padding-top: 8px; }
summary { cursor: pointer; color: var(--dfp-muted); }
summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 4px; }
.row { display: grid; grid-template-columns: 1.4rem 1fr; gap: 4px; margin: 4px 0; font-size: 13px; }
.row .label { font-weight: 600; }
.row .msg { color: var(--dfp-muted); display: block; }
.mark-pass { color: var(--dfp-ok); }
.mark-fail { color: var(--dfp-bad); }
.mark-not_checked { color: var(--dfp-muted); }
`;

let cachedSheet: CSSStyleSheet | null | undefined;

/**
 * One constructable stylesheet shared by every badge. Unlike an inline <style> element it is not
 * blocked by a strict Content-Security-Policy (`style-src` without 'unsafe-inline'), which many
 * framework apps set. Returns undefined where unsupported; the caller then falls back to <style>.
 */
function sharedSheet(): CSSStyleSheet | undefined {
  if (cachedSheet === undefined) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      cachedSheet = sheet;
    } catch {
      cachedSheet = null;
    }
  }
  return cachedSheet ?? undefined;
}

const ICONS: Readonly<Record<BadgeView["state"], string>> = {
  loading: "…",
  verified: "✓",
  invalid: "✗",
  error: "!",
  unconfigured: "i",
};

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  // textContent, never innerHTML: every string shown here came from a document we do not trust.
  element.textContent = content;
  if (className !== undefined) element.className = className;
  return element;
}

const MARKS = { pass: "✓", fail: "✗", not_checked: "–" } as const;
const MARK_WORDS = { pass: "passed", fail: "failed", not_checked: "not checked" } as const;

function renderView(view: BadgeView): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset["state"] = view.state;

  // role=status makes screen readers announce changes politely, and the outcome is words + a
  // symbol as well as a colour, so it never depends on colour alone (WCAG 1.4.1).
  const head = document.createElement("div");
  head.className = "head";
  head.setAttribute("role", view.state === "loading" ? "status" : "group");
  head.setAttribute("aria-live", "polite");
  const icon = text("span", ICONS[view.state], "icon");
  icon.setAttribute("aria-hidden", "true");
  const words = document.createElement("div");
  words.append(text("p", view.headline, "title"));
  if (view.subline !== "") words.append(text("p", view.subline, "sub"));
  head.append(icon, words);
  card.append(head);

  if (view.claims.length > 0) {
    const list = document.createElement("ul");
    for (const claim of view.claims) {
      const item = document.createElement("li");
      item.append(text("span", claim.role, "role"), document.createTextNode(claim.who));
      list.append(item);
    }
    card.append(list);
  }
  for (const note of view.notes) card.append(text("p", note, "note"));

  if (view.rows.length > 0) {
    const details = document.createElement("details");
    details.append(text("summary", "What was checked"));
    for (const row of view.rows) {
      const line = document.createElement("div");
      line.className = "row";
      const mark = text("span", MARKS[row.status], `mark-${row.status}`);
      mark.setAttribute("aria-hidden", "true");
      const body = document.createElement("span");
      body.append(
        text("span", `${row.label}: ${MARK_WORDS[row.status]}`, "label"),
        text("span", row.message, "msg"),
      );
      line.append(mark, body);
      details.append(line);
    }
    card.append(details);
  }
  return card;
}

/**
 * Registers `<developer-footprint-badge>`. Safe to call anywhere: it does nothing (and returns
 * false) on the server or in any runtime without custom elements, so importing this package
 * during server-side rendering never throws.
 *
 * Attributes:
 *   src        Folder holding footprint.json and footprint.sig, e.g. "/.well-known/developer-footprint/"
 *   footprint  Full URL of the footprint (overrides src)
 *   signature  Full URL of the signature (overrides src)
 *   identity   URL of the signer's identity document. Omit to fetch it from the signer's domain.
 *   theme      "light" | "dark" | "auto" (default: follow the visitor's colour scheme)
 *
 * Events (bubbling, composed): `footprint-verified`, `footprint-invalid`, `footprint-error`.
 * The host element carries `data-state` (loading | verified | invalid | error | unconfigured).
 */
export function defineFootprintBadge(tagName: string = DEFAULT_TAG): boolean {
  if (typeof HTMLElement === "undefined" || typeof customElements === "undefined") return false;
  if (customElements.get(tagName) !== undefined) return true;

  class FootprintBadge extends HTMLElement {
    static observedAttributes = ["src", "footprint", "signature", "identity"];

    #root: ShadowRoot | undefined;
    #run = 0;
    #result: LoadedVerification | undefined;

    /** The most recent verification, once finished. */
    get result(): LoadedVerification | undefined {
      return this.#result;
    }

    connectedCallback(): void {
      this.#root ??= this.attachShadow({ mode: "open" });
      void this.#load();
    }

    attributeChangedCallback(): void {
      if (this.isConnected) void this.#load();
    }

    #urls(): { footprint: string; signature: string; identity: string | undefined } | undefined {
      const src = this.getAttribute("src");
      const folder = src === null || src === "" ? undefined : src.endsWith("/") ? src : `${src}/`;
      const footprint =
        this.getAttribute("footprint") ??
        (folder === undefined ? undefined : `${folder}footprint.json`);
      const signature =
        this.getAttribute("signature") ??
        (folder === undefined ? undefined : `${folder}footprint.sig`);
      if (footprint === undefined || signature === undefined) return undefined;
      return { footprint, signature, identity: this.getAttribute("identity") ?? undefined };
    }

    #show(view: BadgeView): void {
      const root = this.#root;
      if (root === undefined) return;
      this.dataset["state"] = view.state;
      const sheet = sharedSheet();
      if (sheet !== undefined) {
        root.adoptedStyleSheets = [sheet];
        root.replaceChildren(renderView(view));
      } else {
        const style = document.createElement("style");
        style.textContent = STYLE;
        root.replaceChildren(style, renderView(view));
      }
    }

    #emit(name: string, detail: BadgeEventDetail): void {
      this.dispatchEvent(
        new CustomEvent<BadgeEventDetail>(name, { detail, bubbles: true, composed: true }),
      );
    }

    async #load(): Promise<void> {
      const run = ++this.#run;
      const urls = this.#urls();
      if (urls === undefined) {
        this.#show(UNCONFIGURED_VIEW);
        return;
      }
      this.#show(LOADING_VIEW);
      const outcome = await loadAndVerify({
        footprint: urls.footprint,
        signature: urls.signature,
        ...(urls.identity === undefined ? {} : { identity: urls.identity }),
      });
      if (run !== this.#run) return; // a newer load superseded this one
      if (!outcome.ok) {
        this.#result = undefined;
        this.#show(describeProblem(outcome.error));
        this.#emit("footprint-error", {
          problem: `${outcome.error.what}: ${outcome.error.message}`,
        });
        return;
      }
      this.#result = outcome.value;
      this.#show(describeVerification(outcome.value));
      this.#emit(outcome.value.result.valid ? "footprint-verified" : "footprint-invalid", {
        loaded: outcome.value,
      });
    }
  }

  customElements.define(tagName, FootprintBadge);
  return true;
}
