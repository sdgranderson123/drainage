# FieldGrade

Browser tool for field drainage and land-leveling estimates from USGS 3DEP bare-earth lidar (US only).
Static files, no build step, no backend.

## Using it

1. Search for an address/town or type `lat, lon`, or use the location button.
2. Pick a tool (or press **P** / **F**) and click points on the map.
   Double-click, press **Enter** or tap **Finish** to finish. **Backspace** removes the last point, **Esc** cancels.
3. Drag the white handles to adjust a finished line or field; results update automatically.

- **Elevation profile**: chart with length, start/end, overall grade, low/high, steepest 33 ft run.
  Point at the chart to see that spot on the map. CSV export.
- **Field cut & fill**: best-fit plane or your slope and direction, balanced to a cut:fill ratio
  (e.g. 1.20 for shrink). Area, cut/fill yd³, yd³/ac, deepest cut/fill, fall across the field,
  cut/fill map with legend, existing and design CSVs. Warns about lidar gaps and implausibly large cuts.
- **Lidar relief**: colour-shaded bare-earth elevation for the current view (zoom 13+), with legend.
- Tap/point anywhere for elevation. The last view, field and profile are restored on reload.

Elevations are NAVD88, shown in feet. Estimates only — check against a survey before bidding or moving dirt.

## Run

    npm start            # python3 -m http.server 8000, then open http://localhost:8000

## Checks

    npm install
    npm run check        # unit tests + HTML validation + end-to-end suite
    npm run test:live    # optional: compares grid samples with USGS point queries (needs network)

The end-to-end suite (`tests/e2e.mjs`) runs the real page in headless Chromium with the USGS service
replaced by synthetic lidar of known shape, and checks:

- **Accuracy**: a 0.2% plane toward 135° is recovered by best fit (slope ±0.002%, heading ±1°, ~0 yd³);
  a 0.3 m mound gives the analytically expected cut and fill within 3%; the cut:fill ratio is honoured;
  CSV rows satisfy cut_fill = existing − design.
- **Stability**: lidar gaps produce a warning; a 502 is retried; a persistent outage shows an error
  and clears the busy state.
- **UI**: drawing by mouse and keyboard, double-click without duplicate points, handle dragging,
  chart hover, relief layer, place and coordinate search, session restore.
- **Standards**: axe-core accessibility scan, no horizontal scroll at phone width, dark mode,
  no console errors. `npm run lint` validates the HTML.

## Files

| File | Purpose |
| --- | --- |
| `earthwork.js` | Pure maths: projection, plane fit, volumes, balancing, profile stats, hillshade, CSV |
| `dem.js` | USGS 3DEP access with timeouts, retries and cancellation; Esri place search |
| `app.js` | Map, drawing/editing, results, overlays |
| `index.html`, `styles.css` | Layout and styling (light and dark) |

Data: USGS 3DEP ImageServer (bare earth, ~1 m), imagery and place search © Esri.
Leaflet (with SRI) and geotiff.js load from jsDelivr.
