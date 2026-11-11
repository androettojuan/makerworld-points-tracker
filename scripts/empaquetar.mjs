// Arma el ZIP para la Chrome Web Store: npm run empaquetar
// Solo lleva lo que usa la extensión (manifest, traducciones, íconos y src), sin
// tests, capturas ni node_modules. Escribe dist/points-tracker-<versión>.zip.
// Sin dependencias: ZIP con deflate de zlib, igual en Windows, macOS y Linux.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const INCLUDE = ['manifest.json', '_locales', 'icons', 'src'];

const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`La versión de manifest.json (${manifest.version}) y package.json (${pkg.version}) no coinciden.`);
  process.exit(1);
}
// En CI, el tag (v1.2.3) tiene que coincidir con la versión.
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag !== `v${manifest.version}`) {
  console.error(`El tag ${tag} no coincide con la versión ${manifest.version}.`);
  process.exit(1);
}

async function walk(p) {
  const full = join(ROOT, p);
  try {
    const entries = await readdir(full, { withFileTypes: true });
    const out = [];
    for (const e of entries) out.push(...await walk(join(p, e.name)));
    return out;
  } catch (err) {
    if (err.code === 'ENOTDIR') return [p];
    throw err;
  }
}

const files = (await Promise.all(INCLUDE.map(walk))).flat().sort();

// Fecha fija: el mismo código da el mismo ZIP.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01

const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(relative(ROOT, join(ROOT, file)).split(sep).join('/'));
  const data = await readFile(join(ROOT, file));
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + packed.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const out = join(ROOT, 'dist', `points-tracker-${manifest.version}.zip`);
await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`${relative(ROOT, out)} (${files.length} archivos)`);
