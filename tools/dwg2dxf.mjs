// Convert a DWG to DXF on your computer with LibreDWG (WebAssembly, GPL-3.0). Needs: npm i -D @mlightcad/libredwg-web@0.8.8
// Usage: node tools/dwg2dxf.mjs input.dwg output.dxf
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve('@mlightcad/libredwg-web/package.json'));
const { LibreDwg } = await import('@mlightcad/libredwg-web');
const lib = await LibreDwg.create(path.join(pkg, 'wasm'));
const out = lib.dwg_write_dxf(fs.readFileSync(process.argv[2]));
if (!out) { console.error('Could not convert. Try Save As DXF in AutoCAD.'); process.exit(1); }
fs.writeFileSync(process.argv[3], out); console.log(`Wrote ${process.argv[3]} (${out.length.toLocaleString()} bytes)`);
