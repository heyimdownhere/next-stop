// MapLibre 6 ships only as an ES module. map.js expects the `maplibregl` global it had
// with the old script build, so this sets it. index.html loads this module first and
// the app's scripts with `defer`: both run in page order once the page has loaded.
import * as maplibregl from "./maplibre-gl.mjs";
window.maplibregl = maplibregl;
