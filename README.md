# FieldGrade

Browser tool for field drainage and land-leveling estimates from USGS 3DEP lidar (US only).

- Hover the map for elevation (ft).
- **Elevation profile**: click a line, double-click or Done. Chart, slope, CSV.
- **Field area**: click the corners. Best-fit or set slope/fall direction, balanced to a cut:fill ratio.
  Cut/fill in yd³, overlay (red cut, blue fill), existing and design CSV.

Estimates only. Volumes have not been validated against a survey.

## Run
Static files, no build:

    python3 -m http.server 8000   # then open http://localhost:8000

## Test

    node --test

Data: USGS 3DEP ImageServer (bare earth ~1 m), imagery © Esri. Leaflet and geotiff.js load from jsDelivr.
