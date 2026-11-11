// Chequea las traducciones de _locales: que castellano e inglés tengan las mismas
// claves y sustituciones, que todo texto usado en el código exista, y que no haya
// un `$` suelto (Chrome lo interpreta como sustitución: un `$` literal va como `$$`).
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const load = async (lang) => JSON.parse(await readFile(join(ROOT, `_locales/${lang}/messages.json`), 'utf8'));
const locales = { es: await load('es'), en: await load('en') };

let fails = 0;
const check = (ok, name) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fails++;
};

const subs = (m) => [...new Set(m.replace(/\$\$/g, '').match(/\$\d/g) || [])].sort().join(',');

const esKeys = Object.keys(locales.es).sort();
const enKeys = Object.keys(locales.en).sort();
check(JSON.stringify(esKeys) === JSON.stringify(enKeys),
  `mismas claves (solo es: ${esKeys.filter((k) => !locales.en[k])}; solo en: ${enKeys.filter((k) => !locales.es[k])})`);

for (const key of esKeys) {
  const es = locales.es[key]?.message;
  const en = locales.en[key]?.message;
  if (es == null || en == null) continue;
  if (subs(es) !== subs(en)) check(false, `${key}: sustituciones distintas (es ${subs(es)} / en ${subs(en)})`);
  for (const [lang, m] of [['es', es], ['en', en]]) {
    if (/\$(?![$\d])/.test(m.replace(/\$\$/g, ''))) check(false, `${lang}.${key}: "$" suelto, usá "$$"`);
  }
}
check(true, 'sustituciones y "$" revisados');

// Límites de la Chrome Web Store.
for (const lang of ['es', 'en']) {
  check(locales[lang].extName.message.length <= 75, `${lang}.extName ≤ 75 caracteres`);
  check(locales[lang].extDescription.message.length <= 132, `${lang}.extDescription ≤ 132 caracteres`);
}

// Claves usadas en el código: t('x'), getMessage('x'), data-i18n*="x" y __MSG_x__.
async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(p));
    else if (/\.(js|html|json)$/.test(e.name)) out.push(p);
  }
  return out;
}
const used = new Set();
for (const f of [...await files(join(ROOT, 'src')), join(ROOT, 'manifest.json')]) {
  const text = await readFile(f, 'utf8');
  for (const re of [/\bt\('([A-Za-z0-9_]+)'/g, /getMessage\('([A-Za-z0-9_]+)'/g, /data-i18n(?:-html|-title|-aria)?="([A-Za-z0-9_]+)"/g, /__MSG_([A-Za-z0-9_]+)__/g]) {
    for (const m of text.matchAll(re)) used.add(m[1]);
  }
}
const missing = [...used].filter((k) => !locales.en[k] || !locales.es[k]);
check(missing.length === 0, `todas las claves usadas existen${missing.length ? ` (faltan: ${missing})` : ''} [${used.size} usadas]`);

if (fails) {
  console.log(`\n${fails} fallas`);
  process.exit(1);
}
console.log('\nTraducciones en verde');
