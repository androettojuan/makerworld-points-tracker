// Capturas del README: npm run capturas
// Abre el popup y la página de diagnóstico con un `chrome` simulado y un historial
// de ejemplo inventado (nunca datos de una cuenta real). Escribe docs/capturas/*.png.
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { parseBills } from '../src/lib/bills.js';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs/capturas');
const ORIGIN = 'http://extension.local';
const NOW = new Date('2026-10-19T15:30:00');

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

async function open(browser, path, { width, height, colorScheme }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme, locale: 'es-AR' });
  await page.clock.setFixedTime(NOW);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const file = join(ROOT, new URL(route.request().url()).pathname);
    route.fulfill({ body: await readFile(file), contentType: TYPES[extname(file)] });
  });
  await page.addInitScript((s) => {
    window.chrome = {
      runtime: {
        sendMessage: async (msg) => (msg.type === 'get-state' ? s : { ok: true, added: 0 }),
        openOptionsPage: () => {},
      },
    };
  }, state);
  await page.goto(`${ORIGIN}/${path}`);
  await page.waitForSelector('tbody tr');
  return page;
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const scheme of ['light', 'dark']) {
  const page = await open(browser, 'src/popup/popup.html', { width: 400, height: 600, colorScheme: scheme });
  // Chrome corta los popups a 600 px de alto: la captura muestra lo mismo que se ve al abrirlo.
  await page.screenshot({ path: join(OUT, `popup-${scheme === 'light' ? 'claro' : 'oscuro'}.png`) });
  await page.close();
}

// Hasta antes de los registros crudos, que son un volcado de JSON.
const opts = await open(browser, 'src/options/options.html', { width: 960, height: 720, colorScheme: 'light' });
await opts.screenshot({ path: join(OUT, 'diagnostico.png') });

await browser.close();
console.log(`Capturas en ${OUT}`);
