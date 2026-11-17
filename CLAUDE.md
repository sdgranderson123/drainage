# CLAUDE.md: FieldGrade

Browser grading/drainage tool for a civil engineer (substations, fields). Static site: plain ES modules, no bundler,
no framework, no backend. See HANDOFF.md for setup and file map.

## Commands
- `npm start` → http://localhost:8000 (tools/serve.mjs)
- `npm test` (unit, fast) · `npm run lint` · `npm run test:e2e` (~15 min, headless Chromium) · `npm run check` (all)
- Run `npm run check` before every commit that touches app behaviour. Commit on a branch; `main` publishes to Pages.

## Working rules
- Accuracy over appearance. Every engineering number gets a known-answer test (synthetic surface with an analytic
  result) in `tests/`. If a test disagrees, work the expected value by hand before changing code; several test
  expectations were wrong, and several code bugs were real.
- Test the real UI path, not just functions: `tests/e2e.mjs` drives the page with mocked services
  (USGS exportImage/identify, Esri imagery/geocoder, NWI, epsg.io, crs-us.json). Add a check for each feature.
- Never commit client drawings or data. Fixtures are synthetic (tools/make_survey_fixtures.py).
- Say what is unverified (TR-55 coefficients, storm model limits, Firefox/Safari not run) rather than implying it is.
- Units: internal metres; UI in feet, acres, yd³, cfs. Elevations NAVD88.

## Lessons learned (don't repeat)
- USGS ImageServer times out on big requests (504 without CORS → "Failed to fetch"): fetch ≤600 px compressed tiles.
- Esri imagery export returns 500 if asked for finer than ~0.3 m/px.
- NWI wetlands service flaps with 503s; retries + "Try again" link.
- `Math.min(...bigArray)` overflows the stack on large fields; use loops.
- Leaflet ignores `setView` during a zoom animation; use `{ animate: false }` for jumps.
- Map layers on top swallow clicks: wetlands live in a lower pane; markers/shapes ignore pointer while drawing.
- D8 on perfectly symmetric synthetic valleys makes parallel channels; tilt test surfaces slightly.
- Storm model: water must not rain on drain cells; edges use extrapolated ground; CFL 0.5 (0.7 oscillates).
- Rock quantities use the exact outline area, not counted cells.
- Civil 3D surfaces are custom objects; LibreDWG can't read them. Real fences may be open polylines (gate gaps).
- Avoid regex lookbehind and other post-Safari-16.4 syntax; import maps are polyfilled for older Safari.
- epsg.io rejects Python's default user agent; send a plain client name.

## Licensing
LibreDWG (DWG reading) is GPL-3.0 and loaded from a CDN only when a DWG is opened. Flag any change that bundles it.
