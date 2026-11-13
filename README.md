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
- **Site design** (appears once a field is outlined):
  - **Drainage paths**: where water flows on the field (blue) and where it goes after it leaves (orange), with
    markers showing the share of the field draining off at each exit. Toggle existing ground / with changes.
  - **+ Pond**: draw it; set depth below the lowest rim and side slope (H:1). Reports area, bottom elevation,
    storage (ac-ft) and excavation (yd³).
  - **+ Raise / lower area** or **Whole field**: raise/lower by a number of feet or set to an elevation.
  - **+ Drain tile**: draw the line; pick diameter and depth. Reports length, slope, full-flow capacity
    (Manning n 0.015) and acres served at 3/8 in/day. Outlet at the low end.
  - Net cut/fill of all changes (import/export yd³).
  - **Wetlands**: USFWS National Wetlands Inventory polygons on the map, acres of mapped wetland inside the field
    by type, and a warning when your changes disturb mapped wetland. Screening only, not a delineation.
  - **Storm 3D with changes**: runs the storm on the changed surface; tile acts as a capacity-limited sink.
- **Import survey data**: total-station point files (PNEZD and other column orders, .csv/.txt), ASCII DXF
  (points, 3D lines/polylines, 3DFACE surfaces), LandXML surfaces (Civil 3D TIN) and points, LAS and LAZ point
  clouds (ground class used when present). The coordinate system is read from the file when it says (LAS,
  LandXML) or entered as an EPSG code (state plane, UTM). Survey elevations replace the USGS lidar wherever the
  survey covers, in every tool. On import the survey is compared with the lidar: a consistent offset flags a
  datum or units problem. DWG can't be read in a browser: save as DXF or export LandXML.
  Accuracy is the survey's: elevations are interpolated linearly between shots (TIN) or averaged per cell (clouds).
- **Design files**: pick a DWG (read in the browser with LibreDWG, loaded on first use, about 11 MB) or DXF and its
  xrefs together. Plan linework is drawn on the map by layer (toggle list; legends and title blocks away from the
  site are skipped), missing xrefs are named, and the drawing's own coordinate-system note is quoted to help pick
  the EPSG code. Click a closed shape to use it as the field outline, a rock surfacing area (depth in inches and
  tons/yd³ → yd³ and tons, from the exact outline), a raise/lower area or a pond. Choose **Proposed design** to load
  a finished-grade surface (LandXML FG or a DXF with elevations): it becomes the design for cut/fill, drainage
  paths and Storm 3D. Civil 3D surfaces only come through via LandXML export.
  Licence note: LibreDWG is GPL-3.0; it is loaded from a CDN only when a DWG is opened.
- **Coordinate system: Automatic.** Tries all 879 US state plane (NAD27/NAD83/HARN/2011, ft/ftUS/m), UTM and Iowa
  regional systems in `crs-us.json` (built from epsg.io), keeps the ones that put the data inside their own area of
  use, and ranks them by the drawing notes, `.prj` files from a scanned folder, optional state/county, and the map
  location. The pick is shown with a list of alternatives.
- **Scan a project folder**: pick a folder; it lists LAS/LAZ, LandXML, point files, DXF/DWG and .prj files with
  EPSG codes and notes, and loads the checked ones. Files are read in the browser only.
- **3D view / Storm 3D: existing vs proposed** side by side with locked cameras and one storm clock, satellite imagery
  or elevation colours, the outline, CAD lines and edits draped on the ground, regraded areas tinted, and a
  comparison table (change in runoff leaving the site, peak flow, deep water). Tracer particles with trails show
  surface water running down slope into low areas and ponds.
- **Profiles** show the proposed grade with cut/fill shading when a design exists.
- **Storm 3D** now shows the water moving: tracer particles ride the simulated flow and rain falls at the
  current intensity.
- **Drainage area & peak flow** (press **D**): click a culvert, tile outlet or ditch point. Delineates the
  contributing area from the lidar (depression filling + D8 flow), shows the channel network and the longest
  flow path, and reports area, relief, slopes and time of concentration (NRCS lag and Kirpich). Pick land
  cover and soil group for the curve number, enter NOAA Atlas 14 24-hour depths (link provided; NOAA's
  service can't be read from the browser), and get TR-55 runoff depth, volume and graphical peak discharge
  for each storm. Drag the outlet to move it. CSV export. Warns when the basin is cut off by the study area.
- **Storm 3D** (from a drainage area or a field): 3D terrain with live water during an NRCS Type II 24-hour
  storm. Curve-number losses, 2D overland flow with Manning friction (virtual-pipe shallow-water scheme),
  ponding, outflow hydrograph, mass balance. A screening visual, not a design model: no culverts, tile or
  channel geometry, and cells are coarsened to at most 128 across.
- **Lidar relief**: colour-shaded bare-earth elevation for the current view (zoom 13+), with legend.
- Tap/point anywhere for elevation (inside a field it also shows the cut or fill depth there).
- **Lidar flown**: collection window of the 1 m lidar project at the field or profile, with a warning if older than 5 years.
- **Print / PDF**: one-page report of the map and results (use the browser’s Save as PDF).
- The last view, field and profile are restored on reload.

Elevations are NAVD88, shown in feet. Estimates only — check against a survey before bidding or moving dirt.

## Run

    npm start            # python3 -m http.server 8000, then open http://localhost:8000

## Checks

    npm install
    npm run check        # unit tests + HTML validation + end-to-end suite
    npm run test:live    # optional, needs network: grid vs. USGS point queries at 4 sites + lidar source lookup

The end-to-end suite (`tests/e2e.mjs`) runs the real page in headless Chromium with the USGS service
replaced by synthetic lidar of known shape, and checks:

- **Accuracy**: a 0.2% plane toward 135° is recovered by best fit (slope ±0.002%, heading ±1°, ~0 yd³);
  a 0.3 m mound gives the analytically expected cut and fill within 3%; the cut:fill ratio is honoured;
  CSV rows satisfy cut_fill = existing − design.
- **Stability**: lidar gaps produce a warning; a 502 is retried; a persistent outage shows an error
  and clears the busy state.
- **Engineering**: on a synthetic valley the delineated area is within 4% of the analytic area; the
  results table matches TR-55 computed independently; the 3D storm runs with WebGL and conserves mass.
  Unit tests cover filling, D8, basin splits, SCS runoff, Kirpich, Type II tables, friction, rim leakage.
- **UI**: drawing by mouse and keyboard, double-click without duplicate points, handle dragging,
  chart hover, relief layer, place and coordinate search, session restore.
- **Standards**: axe-core accessibility scan, no horizontal scroll at phone width, dark mode,
  no console errors. `npm run lint` validates the HTML.

## Files

| File | Purpose |
| --- | --- |
| `survey.js`, `surveyio.js` | Survey parsers (PNEZD, DXF, LandXML, LAS), LAZ via laz-perf, projection, TIN/cloud gridding |
| `design.js` | Ponds, raise/lower, tile, exit points, wetland overlap on a grid |
| `hydro.js` | Depression filling, D8 flow, watershed, Tc, TR-55 (runoff, Type II peak), Type II rainfall |
| `storm.js`, `storm3d.js` | Storm simulation and its three.js viewer |
| `earthwork.js` | Pure maths: projection, plane fit, volumes, balancing, profile stats, hillshade, CSV |
| `dem.js` | USGS 3DEP access with timeouts, retries and cancellation; Esri place search |
| `app.js` | Map, drawing/editing, results, overlays |
| `index.html`, `styles.css` | Layout and styling (light and dark) |

Data: USGS 3DEP ImageServer (bare earth, ~1 m), imagery and place search © Esri.
Leaflet (with SRI) and geotiff.js load from jsDelivr.
