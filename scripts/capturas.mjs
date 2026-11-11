// Capturas del README: npm run capturas
// Abre el popup y la página de diagnóstico con un `chrome` simulado y un historial
// de ejemplo inventado (nunca datos de una cuenta real). Escribe docs/capturas/*.png.
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { parseBills } from '../src/lib/bills.js';

const ROOT = resolve(import.meta.dirname, '..');
const ORIGIN = 'http://extension.local';
const NOW = new Date('2026-10-19T15:30:00');
// LANG_CAPTURAS=en npm run capturas → versión en inglés, en docs/capturas/en.
const LANG = process.env.LANG_CAPTURAS || 'es';
const OUT = LANG === 'es' ? join(ROOT, 'docs/capturas') : join(ROOT, 'docs/capturas', LANG);
const MESSAGES = JSON.parse(await readFile(join(ROOT, `_locales/${LANG}/messages.json`), 'utf8'));

// ---------- historial de ejemplo ----------
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (list) => list[Math.floor(rand() * list.length)];

const DESIGNS = ['Organizador de cables', 'Soporte para auriculares', 'Maceta geométrica', 'Gancho para bicicleta', 'Caja con bisagra impresa'];
const MAKERS = ['impresora_del_sur', 'pla_y_mate', 'capa_por_capa', 'filamento_feliz'];

function sampleBills() {
  const hits = [];
  let id = 1;
  const at = (daysAgo, hour) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, Math.floor(rand() * 60), 0, 0);
    return d.toISOString();
  };
  const bill = (type, createTime, excl, reg, extra = {}) =>
    hits.push({ id: id++, type, createTime, pointChangeExclusive: excl, pointChangeRegular: reg, ...extra });

  for (let n = 200; n >= 0; n--) {
    if (n === 0 && NOW.getHours() < 9) continue;
    const growth = 1 + (200 - n) / 120; // el perfil crece con el tiempo
    if (rand() < 0.8) {
      const title = pick(DESIGNS);
      bill('design_reward_v2', at(n, 9), Math.round(rand() * 14 * growth * 10) / 10, Math.round(rand() * 3),
        { designRewardV2: { title } });
    }
    if (rand() < 0.25) bill('instance_reward_v2', at(n, 11), Math.round(rand() * 5 * 10) / 10, 0,
      { instanceRewardV2: { instanceTitle: '0,2 mm PLA', designTitle: pick(DESIGNS) } });
    const boosts = Math.floor(rand() * 4 * growth);
    for (let b = 0; b < boosts; b++) {
      bill('boost_exchange_point', at(n, 12 + b), 5, 0,
        { extInfoBoostExchangePoint: { designTitle: pick(DESIGNS), fromUserHandle: pick(MAKERS) } });
    }
  }
  bill('academy_course_award', at(170, 18), 20, 0, { extInfoAcademyCourseAward: { courseName: 'Diseño para impresión 3D' } });
  bill('complete_personal_info', at(198, 10), 0, 10);
  bill('exchange_cash', at(95, 20), -1500, 0);
  bill('exchange_cash', at(33, 20), -1500, 0);
  bill('design_exclusive_violation_revoke', at(5, 7), -42.5, 0);
  bill('instance_exclusive_violation_revoke', at(30, 7), -227.25, 0);
  return hits;
}

const records = Object.fromEntries(parseBills({ hits: sampleBills() }).map((r) => [r.id, r]));
let exclusive = 0, regular = 0;
for (const r of Object.values(records)) {
  exclusive += r.raw.pointChangeExclusive;
  regular += r.raw.pointChangeRegular;
}
const round = (n) => Math.round(n * 100) / 100;
const lastSync = NOW.getTime() - 25 * 60e3;
const state = {
  records,
  endpoints: {
    'GET /api/v1/point-service/point-bill/my': {
      key: 'GET /api/v1/point-service/point-bill/my', yields: 100, hits: 14, lastSeen: lastSync,
    },
  },
  meta: { lastSync, snapshot: { exclusive: round(exclusive), regular: round(regular) } },
};

// ---------- navegador ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

async function open(browser, path, { width, height, colorScheme, empty = false, wait = 'tbody tr', unfold = false }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme, locale: LANG === 'es' ? 'es-AR' : 'en-US' });
  await page.clock.setFixedTime(NOW);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const file = join(ROOT, new URL(route.request().url()).pathname);
    route.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] });
  });
  await page.addInitScript(({ s, messages, lang, unfold }) => {
    // Secciones plegables del popup: cerradas como al instalar, o todas abiertas.
    localStorage.setItem('mwpt-open-sections', JSON.stringify(unfold ? ['models', 'months', 'days'] : []));
    window.chrome = {
      runtime: {
        sendMessage: async (msg) => (msg.type === 'get-state' ? s
          : msg.type === 'get-settings' ? { usdRate: 0.066, autoOpen: false }
          : { ok: true, added: 0 }),
        openOptionsPage: () => {},
        getURL: (p) => `/${p}`,
      },
      tabs: { create: () => {}, reload: () => {} },
      // Misma sustitución que Chrome: $1…$9, y $$ para un $ literal.
      i18n: {
        getUILanguage: () => (lang === 'es' ? 'es-419' : 'en-US'),
        getMessage: (key, subs = []) => {
          const m = messages[key]?.message;
          return m == null ? '' : m.replace(/\$(\$|\d)/g, (_, c) => (c === '$' ? '$' : subs[Number(c) - 1] ?? ''));
        },
      },
    };
  }, { s: empty ? { records: {}, endpoints: {}, meta: {} } : state, messages: MESSAGES, lang: LANG, unfold });
  await page.goto(`${ORIGIN}/${path}`);
  // `attached`: las tablas del popup pueden estar plegadas y aun así ya renderizadas.
  if (wait) await page.waitForSelector(wait, { state: 'attached' });
  return page;
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

const shots = {};
for (const scheme of ['light', 'dark']) {
  const page = await open(browser, 'src/popup/popup.html', { width: 400, height: 600, colorScheme: scheme });
  // Chrome corta los popups a 600 px de alto: la captura muestra lo mismo que se ve al abrirlo.
  shots[scheme] = await page.screenshot({ path: join(OUT, `popup-${scheme === 'light' ? 'claro' : 'oscuro'}.png`) });
  await page.close();
}

// La tabla por modelo queda debajo del corte: la capturamos sola.
const models = await open(browser, 'src/popup/popup.html', { width: 400, height: 600, colorScheme: 'light', unfold: true });
shots.models = await models.locator('[data-fold=models]').screenshot({ path: join(OUT, 'por-modelo.png') });
await models.locator('[data-fold=months]').screenshot({ path: join(OUT, 'por-mes.png') });
await models.close();

// Hasta antes de los registros crudos, que son un volcado de JSON.
const opts = await open(browser, 'src/options/options.html', { width: 960, height: 720, colorScheme: 'light' });
await opts.screenshot({ path: join(OUT, 'diagnostico.png') });

// Primera vez: el popup sin datos muestra los pasos para empezar.
const first = await open(browser, 'src/popup/popup.html', { width: 400, height: 380, colorScheme: 'light', empty: true, wait: '#start:not([hidden])' });
shots.first = await first.screenshot({ path: join(OUT, 'primera-vez.png') });

const help = await open(browser, 'src/popup/popup.html', { width: 400, height: 600, colorScheme: 'light' });
await help.click('#help-btn');
shots.help = await help.screenshot({ path: join(OUT, 'ayuda.png') });

const welcome = await open(browser, 'src/welcome/welcome.html', { width: 900, height: 900, colorScheme: 'light', wait: 'h1:not(:empty)' });
await welcome.screenshot({ path: join(OUT, 'bienvenida.png'), fullPage: true });

// ---------- Chrome Web Store ----------
// Capturas de 1280×800 (título a la izquierda, popup a la derecha) y la imagen
// promocional chica de 440×280. Van en docs/tienda/<idioma>.
const STORE = {
  es: {
    shots: [
      ['dark', 'Tus puntos de MakerWorld, día a día', 'Hoy, este mes y tu saldo de exclusivos, con su valor en dólares y separados en diseños y boosts.'],
      ['models', 'Cuánto te da cada modelo', 'Ordenados del que más dio al que menos, por día, mes o de siempre.'],
      ['first', 'Empezás en un minuto', 'Iniciás sesión en MakerWorld y tocás Sincronizar. Todo queda guardado en tu navegador.'],
      ['help', 'Sin dudas sobre qué es cada número', 'Exclusivos, regulares, boosts y canjes explicados dentro de la extensión.'],
    ],
    tagline: 'Tus puntos de MakerWorld, día a día',
    unofficial: 'Extensión no oficial',
  },
  en: {
    shots: [
      ['dark', 'Your MakerWorld points, day by day', 'Today, this month and your exclusive balance, in dollars too, split into designs and boosts.'],
      ['models', 'What each model earns you', 'Ranked from top earner down, for today, this month or all time.'],
      ['first', 'Up and running in a minute', 'Sign in to MakerWorld and click Sync. Everything stays in your browser.'],
      ['help', 'Every number explained', 'Exclusive, regular, boosts and redemptions, explained inside the extension.'],
    ],
    tagline: 'Your MakerWorld points, day by day',
    unofficial: 'Unofficial extension',
  },
}[LANG];

const STORE_OUT = join(ROOT, 'docs/tienda', LANG);
await mkdir(STORE_OUT, { recursive: true });
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const icon = dataUrl(await readFile(join(ROOT, 'icons/icon128.png')));
const name = MESSAGES.extName.message;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"; // va dentro de style="…": sin comillas dobles

const canvas = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
for (const [i, [shot, title, sub]] of STORE.shots.entries()) {
  await canvas.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;gap:64px;padding:0 80px;box-sizing:border-box;background:linear-gradient(135deg,#16213a,#0f1626);color:#fff;font-family:${FONT}">
    <div style="flex:1">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:28px;opacity:.85"><img src="${icon}" width="40" height="40" style="border-radius:9px"><span style="font-size:20px;font-weight:600">${name}</span></div>
      <h1 style="font-size:52px;line-height:1.1;margin:0 0 20px">${title}</h1>
      <p style="font-size:24px;line-height:1.45;margin:0;color:#b8c2d6">${sub}</p>
    </div>
    <img src="${dataUrl(shots[shot])}" style="max-height:680px;max-width:560px;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);${shot === 'models' ? 'padding:20px;background:#fff' : ''}">
  </body>`);
  await canvas.waitForLoadState('load');
  await canvas.screenshot({ path: join(STORE_OUT, `captura-${i + 1}.png`) });
}

await canvas.setViewportSize({ width: 440, height: 280 });
await canvas.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:0 36px;box-sizing:border-box;background:linear-gradient(135deg,#16213a,#0f1626);color:#fff;font-family:${FONT}">
  <img src="${icon}" width="64" height="64" style="border-radius:14px">
  <div style="font-size:28px;font-weight:700;line-height:1.15">${name}</div>
  <div style="font-size:16px;color:#b8c2d6">${STORE.tagline} · ${STORE.unofficial}</div>
</body>`);
await canvas.waitForLoadState('load');
await canvas.screenshot({ path: join(STORE_OUT, 'promo-440x280.png') });

await browser.close();
console.log(`Capturas en ${OUT} y ${STORE_OUT}`);
