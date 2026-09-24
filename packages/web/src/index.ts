/**
 * @developer-footprint/web
 *
 * Show and verify a Developer Footprint on any website. Importing this module has no side
 * effects and is safe during server-side rendering; call `defineFootprintBadge()` in the browser,
 * or import "@developer-footprint/web/register" to do it for you.
 */
export { DEFAULT_TAG, defineFootprintBadge, type BadgeEventDetail } from "./badge.js";
export {
  fetchDocument,
  resolveFetchUrl,
  type FetchOptions,
  type FetchProblem,
  type FetchProblemCode,
} from "./fetch.js";
export {
  loadAndVerify,
  type LoadOptions,
  type LoadOutcome,
  type LoadProblem,
  type LoadedVerification,
} from "./load.js";
export {
  describeProblem,
  describeVerification,
  type BadgeClaim,
  type BadgeRow,
  type BadgeState,
  type BadgeView,
} from "./view.js";
