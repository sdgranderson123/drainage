// Minimal little-endian Float32 GeoTIFF writer (one uncompressed strip, EPSG:4326) for test fixtures.
export function writeGeoTiff(values, W, H, { west, north, sx, sy }) {
  const tags = [];
  const add = (tag, type, count, data) => tags.push({ tag, type, count, data });
  const SHORT = 3, LONG = 4, DOUBLE = 12;
  const geoKeys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
  const pixelBytes = W * H * 4;
  add(256, LONG, 1, [W]); add(257, LONG, 1, [H]); add(258, SHORT, 1, [32]); add(259, SHORT, 1, [1]);
  add(262, SHORT, 1, [1]); add(273, LONG, 1, [0]); add(277, SHORT, 1, [1]); add(278, LONG, 1, [H]);
  add(279, LONG, 1, [pixelBytes]); add(284, SHORT, 1, [1]); add(339, SHORT, 1, [3]);
  add(33550, DOUBLE, 3, [sx, sy, 0]); add(33922, DOUBLE, 6, [0, 0, 0, west, north, 0]);
  add(34735, SHORT, geoKeys.length, geoKeys);
  tags.sort((a, b) => a.tag - b.tag);
  const size = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 8 + ifdSize; const extraBlocks = [];
  for (const t of tags) { const n = size[t.type] * t.count; if (n > 4) { t.offset = extra; extraBlocks.push(t); extra += n + (n % 2); } }
  const dataOff = Math.ceil(extra / 8) * 8;
  tags.find((t) => t.tag === 273).data = [dataOff];
  const buf = new ArrayBuffer(dataOff + pixelBytes), dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  let p = 8; dv.setUint16(p, tags.length, true); p += 2;
  const put = (off, type, v) => (type === SHORT ? dv.setUint16(off, v, true) : type === LONG ? dv.setUint32(off, v, true) : dv.setFloat64(off, v, true));
  for (const t of tags) {
    dv.setUint16(p, t.tag, true); dv.setUint16(p + 2, t.type, true); dv.setUint32(p + 4, t.count, true);
    if (t.offset) { dv.setUint32(p + 8, t.offset, true); t.data.forEach((v, i) => put(t.offset + i * size[t.type], t.type, v)); }
    else t.data.forEach((v, i) => put(p + 8 + i * size[t.type], t.type, v));
    p += 12;
  }
  dv.setUint32(p, 0, true);
  new Float32Array(buf, dataOff, W * H).set(values);
  return Buffer.from(buf);
}
