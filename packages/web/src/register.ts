// Side-effect entry point: importing this file registers <developer-footprint-badge>.
// It is a no-op during server-side rendering. This is also the entry of the browser bundle.
import { defineFootprintBadge } from "./badge.js";

defineFootprintBadge();
