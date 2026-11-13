// Guess the coordinate system of survey coordinates.
// For every US state plane / UTM / regional system in crs-us.json, place the data with that system and keep the
// ones that land inside the system's own area of use. Rank by what the drawing notes say (state, zone, units,
// datum), how close the result is to the map location / given state and county, and a mild datum preference.
// proj4 is passed in so this runs in Node tests and the browser.

const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii',
  'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
  'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
  'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas',
  'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];
const ZONES = ['North Central', 'South Central', 'North', 'South', 'East Central', 'West Central', 'Central', 'East', 'West', 'Mainland', 'Offshore'];

// What a note like "NSRS 2011 Minnesota State Plane, South Zone, US Survey Foot" says.
export function readNotes(text) {
  const t = ` ${text} `.replace(/\s+/g, ' ');
  // Longest state name first so "West Virginia" beats "Virginia", "Arkansas" beats "Kansas".
  const state = [...STATES].sort((a, b) => b.length - a.length).find((s) => new RegExp(`\\b${s}\\b`, 'i').test(t)) || null;
  let zone = null;
  for (const z of ZONES) if (new RegExp(`\\b${z}\\b(?=\\s*(Zone|,|\\)|$|\\s))`, 'i').test(t.replace(state || '#', ''))) { zone = z; break; }
  const unit = /us\s*survey\s*f(oo|ee)t|ftUS|US\s*ft|survey feet/i.test(t) ? 'ftUS' : /international\s*f(oo|ee)t|\bIFT\b/i.test(t) ? 'ft' : /\bmet(er|re)s?\b/i.test(t) ? 'm' : null;
  const datum = /NSRS\s*2011|NAD\s*83\s*\(?\s*2011|2011\s*adj/i.test(t) ? '2011' : /HARN|HPGN/i.test(t) ? 'HARN' : /NAD\s*27/i.test(t) ? 'NAD27' : /NAD\s*83/i.test(t) ? 'NAD83' : null;
  const utm = (t.match(/UTM\s*(zone)?\s*(\d{1,2})\s*N?/i) || [])[2] || null;
  const regional = (t.match(/\b(IaRCS|Iowa Regional)\b.*?\bzone\s*(\d+)/i) || [])[2] || null;
  return { state, zone, unit, datum, utm: utm && +utm, regional: regional && +regional };
}
const sysUnit = (s) => (/\(ftUS\)/.test(s.n) || /us-ft/.test(s.p) ? 'ftUS' : /\(ft\)|\+units=ft/.test(s.n + s.p) ? 'ft' : 'm');
const sysDatum = (s) => (/NAD83\(2011\)/.test(s.n) ? '2011' : /NAD83\((HARN|HPGN)\)/.test(s.n) ? 'HARN' : /NAD27/.test(s.n) ? 'NAD27' : /NAD83\(CSRS|NSRS2007|NAD83\(NSRS/.test(s.n) ? 'other' : 'NAD83');

// xy: [[x, y], ...] sample of the data (file units). table: crs-us.json. hints: { notes, lat, lon, state, county }.
export function detectCRS(xy, table, proj4, hints = {}) {
  const want = readNotes([hints.notes || '', hints.state || ''].join(' '));
  const out = [];
  const cx = xy.reduce((a, p) => a + p[0], 0) / xy.length, cy = xy.reduce((a, p) => a + p[1], 0) / xy.length;
  for (const s of table) {
    let ll;
    try { const [lo, la] = proj4(s.p, 'WGS84', [cx, cy]); ll = [la, lo]; } catch { continue; }
    if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) continue;
    const [S, W, N, E] = s.b, m = 0.05;
    if (!(ll[0] >= S - m && ll[0] <= N + m && ll[1] >= W - m && ll[1] <= E + m)) continue;
    let score = 0; const why = [];
    if (want.state && s.n.includes(want.state)) { score += 40; why.push(want.state); }
    else if (want.state) score -= 40;
    if (want.zone) { if (new RegExp(`\\b${want.zone}\\b`).test(s.n)) { score += 25; why.push(`${want.zone} zone`); } else score -= 15; }
    const u = sysUnit(s); if (want.unit) { if (u === want.unit) { score += 15; why.push(u === 'ftUS' ? 'US survey feet' : u === 'ft' ? 'international feet' : 'metres'); } else score -= 15; }
    const d = sysDatum(s); if (want.datum) { if (d === want.datum) { score += 10; why.push(d === '2011' ? 'NAD83(2011)' : d); } else score -= d === 'NAD27' || want.datum === 'NAD27' ? 30 : 5; }
    else score += { '2011': 3, NAD83: 2, HARN: 1, NAD27: -10, other: -20 }[d];
    if (want.utm && /UTM zone/.test(s.n)) { if (s.n.includes(`zone ${want.utm}N`)) { score += 30; why.push(`UTM ${want.utm}`); } else score -= 20; }
    if (want.regional && /IaRCS/.test(s.n)) { if (s.n.endsWith(`zone ${want.regional}`)) { score += 30; why.push(`IaRCS ${want.regional}`); } }
    if (hints.county && new RegExp(`\\b${hints.county}\\b`, 'i').test(s.a)) { score += 10; why.push(`${hints.county} County`); }
    // County-based (regional) systems only when asked for: they overlap the state plane zones.
    if (/IaRCS|County/i.test(s.n) && !want.regional && !hints.county) score -= 8;
    if (/UTM zone/.test(s.n) && !want.utm) score -= 6;
    // Distance to where the user is looking (km).
    let km = null;
    if (Number.isFinite(hints.lat) && Number.isFinite(hints.lon)) {
      km = 6371 * Math.hypot((ll[0] - hints.lat) * Math.PI / 180, (ll[1] - hints.lon) * Math.PI / 180 * Math.cos(hints.lat * Math.PI / 180));
      score += km < 2 ? 25 : km < 20 ? 15 : km < 100 ? 5 : km > 500 ? -10 : 0;
    }
    if (u === 'ftUS') score += 1; // most US surveys
    out.push({ code: s.c, name: s.n, proj4: s.p, lat: ll[0], lon: ll[1], km, score, why });
  }
  out.sort((a, b) => b.score - a.score || a.code - b.code);
  return out;
}

// Coordinate-system clues in a project folder: ESRI .prj text, LandXML, LAS headers, drawing notes.
// .prj names look like NAD_1983_2011_StatePlane_Minnesota_South_FIPS_2203_Ft_US.
export function prjToNotes(wkt) {
  const name = (wkt.match(/PROJCS\["([^"]+)"/) || [])[1] || wkt;
  return name.replace(/_/g, ' ').replace(/NAD 1983 2011/i, 'NAD83(2011)').replace(/NAD 1983 HARN/i, 'NAD83 HARN').replace(/NAD 1983/i, 'NAD83')
    .replace(/NAD 1927/i, 'NAD27').replace(/\bFt US\b/i, 'US survey foot').replace(/\bFeet\b|\bFt\b/i, 'international foot').replace(/StatePlane/i, 'State Plane');
}
