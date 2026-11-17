# FieldGrade: handoff to your PC

Everything you need to run, test, change and publish FieldGrade on your own Windows PC, without the cloud session.

## 1. What it is

FieldGrade is a browser-based grading and drainage tool. It is a **static website**: HTML, CSS and JavaScript files, no
server, no database, no build step. All maps, lidar and calculations happen in the browser.

| Item | Where |
| --- | --- |
| Code | GitHub, `sdgranderson123/drainage` (private) |
| Working branch | `fieldgrade-mvp` (all work so far); `main` is what the website shows |
| Live site | https://sdgranderson123.github.io/drainage/ (GitHub Pages, built from `main`) |
| Open pull request | **#9** (projects, own outline, drawings without elevations). Merge it so `main` has everything. |

## 2. One-time setup on your PC

Install these (all free):

1. **Git for Windows**: https://git-scm.com/download/win (defaults are fine).
2. **Node.js 22 LTS**: https://nodejs.org (choose "LTS"). Includes `npm`.
3. **VS Code** (recommended editor): https://code.visualstudio.com
4. Optional, only to regenerate test files or the coordinate-system table: **Python 3.12+** from https://python.org
   (tick "Add python.exe to PATH").
5. Optional, to keep working with Claude locally: **Claude Code** (https://claude.com/claude-code). The `CLAUDE.md`
   file in the repo gives it the project context.

Then, in a terminal (PowerShell or the VS Code terminal), in a folder on your **C: drive** (not P: or a network share):

```powershell
cd C:\Users\<you>\Projects          # any local folder
git clone https://github.com/sdgranderson123/drainage.git
cd drainage
git checkout main                   # after merging PR #9; or: git checkout fieldgrade-mvp
npm install                         # test tools only; the app itself needs nothing installed
npx playwright install chromium     # browser used by the automated tests (one time, ~150 MB)
```

Git will ask you to sign in to GitHub the first time (a browser window opens).

## 3. Run it

```powershell
npm start
```

Open **http://localhost:8000**. Stop with Ctrl+C. Edit a file, save, refresh the browser.

It must be served over http (not opened by double-clicking `index.html`), because browsers block JavaScript modules
loaded from `file://`.

Internet is still needed while it runs: USGS lidar, Esri imagery and place search, USFWS wetlands, epsg.io, and the
libraries (Leaflet, three.js, proj4, geotiff, laz-perf, LibreDWG) come from those services and CDNs.

## 4. Test it

```powershell
npm test            # 60 unit tests, ~10 s: maths, hydrology, storm model, CAD/survey parsers, coordinate systems
npm run lint        # HTML validation
npm run test:e2e    # ~15 min: 133 checks in a real (headless) Chrome with fake lidar of known shape
npm run check       # all three; run before you publish
npm run test:live   # optional: compares grids with the real USGS service at 4 sites (needs internet)
```

The end-to-end tests replace USGS, Esri, NWI and epsg.io with local fakes, so they are repeatable and work offline
(except loading the CDN libraries). Screenshots land in `tests/out-*.png` (ignored by git).

## 5. Publish changes

The site publishes from `main` automatically (GitHub Pages, about 1–2 minutes after a merge).

```powershell
git checkout -b my-change           # work on a branch
# ...edit, npm run check...
git add -A
git commit -m "Describe the change"
git push -u origin my-change
```

Open a pull request on GitHub (it will offer a button), review, **Merge**, wait 2 minutes, reload the site.

Pages on a private repo needs a paid GitHub plan (or a public repo). Settings → Pages → Source: `main`, folder `/`.

## 6. How the code is organised

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | Page layout, panels, dialogs, light/dark themes, phone layout |
| `app.js` | Everything on the map: tools, drawing/editing, results, survey & design import, projects, undo/redo |
| `earthwork.js` | Core maths: projection, plane fit, cut/fill volumes, balancing, profile stats, hillshade, CSV |
| `dem.js` | USGS 3DEP lidar download (tiled, compressed, retries), point elevations, Esri place search, lidar dates |
| `hydro.js` | Depression filling, D8 flow, drainage areas, Tc, TR-55 runoff and Type II peak flow, curve numbers |
| `design.js` | Ponds, raise/lower, rock, drain tile, exit points, wetland overlap |
| `storm.js` | Storm simulation: shallow-water flow, Manning friction, SCS curve-number losses, tile sinks |
| `storm3d.js` | 3D viewer (three.js): existing vs proposed side by side, imagery, moving water, comparison table |
| `survey.js` | File parsers: point files, DXF (geometry, linework, spot-elevation text, xrefs), LandXML, LAS |
| `surveyio.js` | Browser side of import: LAZ (laz-perf), DWG (LibreDWG), coordinate systems, folder scan |
| `crs.js`, `crs-us.json` | Automatic coordinate-system detection; table of 879 US systems |
| `tests/` | Unit tests (`*.test.mjs`), end-to-end suite (`e2e.mjs`), fixtures |
| `tools/` | `serve.mjs` (local server), `build_crs_table.py`, `make_survey_fixtures.py`, `dwg2dxf.mjs` |

Everything is plain JavaScript modules; no framework, no bundler. Libraries load from jsDelivr with pinned versions
(and integrity hashes for Leaflet and the import-map polyfill).

## 7. External services it depends on

| Service | Used for | Notes |
| --- | --- | --- |
| USGS 3DEP ImageServer | Lidar elevations, lidar dates | Slow and sometimes returns 502/504; the app retries |
| Esri World Imagery, geocoder | Map, 3D imagery, address search | Imagery capped at ~0.3 m/px or the export fails |
| USFWS NWI wetlands | Wetland check | Often returns 503; the app shows "Try again" |
| NOAA Atlas 14 | Rainfall depths | Not callable from a browser; the app links to it and you type the depths |
| epsg.io / spatialreference.org | Coordinate-system definitions | Only for EPSG codes not already handled |
| jsDelivr CDN | Libraries | Versions pinned in `index.html`, `dem.js`, `surveyio.js` |

## 8. Things to know before relying on results

- **Estimates for screening, not stamped design.** Volumes, peaks and storms are checked against known-answer tests,
  not against a real survey. Compare one job you already designed before using it on bids or plans.
- **TR-55 Type II coefficients** in `hydro.js` were entered from memory and are tested for internal consistency only.
  Check them against TR-55 Table F-1 / WinTR-55.
- **Storm 3D** is a screening visual: no culverts or channel shapes, coarse cells (128 across), tile as a capacity sink.
  Use HEC-RAS 2D or similar for design.
- **Lidar shows the ground only**: culverts under roads are missing, so road fills can wrongly block flow.
- **Civil 3D surfaces** inside DWGs can't be read. Use **Output → Export to LandXML** for EG/FG surfaces, or drawings
  whose elevations are spot-elevation text or point blocks.
- **Saved projects** are stored in the browser on that PC. Use **Export** to keep a copy.

## 9. Licences

- Your code: no licence file yet (private repo). Add one if you share it.
- **LibreDWG (DWG reading) is GPL-3.0.** It is not in the repo; the browser downloads it when a DWG is opened. Fine
  for internal use; if the site is public, ask whoever handles licensing at DGR, or remove DWG support (DXF and LandXML
  still work). It is used in `surveyio.js` (`LIB.libredwg`) and `tools/dwg2dxf.mjs`.
- Other libraries: Leaflet (BSD-2), three.js (MIT), proj4 (MIT), delaunator (ISC), geotiff.js (MIT), laz-perf
  (Apache-2.0), es-module-shims (MIT).

## 10. Client data

No DGR drawings are in the repo. The North Substation DWG used during development stayed in the cloud session.
Keep client files out of git (the `.gitignore` already ignores test screenshots; add folders as needed).

## 11. Open items / next steps

1. Merge PR #9.
2. Load the North Substation xrefs (`421019TO-SUBSTATION-2026.dwg`, `NS-200 PROP.dwg`, `NS-200B.dwg`) with **Find them
   in a folder…**, or a LandXML export of EG/FG, and compare cut/fill and rock with your Civil 3D numbers.
3. Substation auto-grade (phase 2): needs your pad standards (slope range, minimum pad elevation, rock section, side
   slopes, balance vs minimum import, topsoil, shrink/swell).
4. Test Firefox and Safari by hand (only Chrome/Edge were automated; a compatibility audit found no problems).
5. Verify the TR-55 coefficients (section 8).

## 12. Regenerating generated files (rarely needed)

```powershell
pip install pyproj "laspy[lazrs]" numpy
python tools/build_crs_table.py crs-us.json            # coordinate-system table (few minutes, needs internet)
python tools/make_survey_fixtures.py tests/fixtures    # survey test files from the known surface
npm i -D @mlightcad/libredwg-web@0.8.8                 # then: node tools/dwg2dxf.mjs in.dwg out.dxf
```
