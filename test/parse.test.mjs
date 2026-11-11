import { extractRecords, detectPagination, classify, toEpochMs } from '../src/lib/parse.js';
import { byDay, totals, byModel } from '../src/lib/aggregate.js';
import { isMakerWorldUrl } from '../src/lib/makerworld.js';
import { extractSnapshot, diffSnapshots } from '../src/lib/snapshot.js';
import { parseBills, looksLikeBills, billKind, billDesign } from '../src/lib/bills.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};

// Forma A: envoltorio típico {code,message,data:{list:[...],total}}
const A = { code: 0, message: 'success', data: { total: 3, list: [
  { id: 101, point: 12, createTime: '2026-09-12T10:00:00Z', type: 'Boost Rewards' },
  { id: 102, point: 5,  createTime: '2026-09-12T18:00:00Z', type: 'Model Download Reward', title: 'Llavero' },
  { id: 103, point: 2,  createTime: '2026-09-11T09:00:00Z', type: 'Daily Check-in' },
]}};
const a = extractRecords(A, 'https://makerworld.com/api/v1/point-service/point/record?offset=0&limit=20');
eq('A: cantidad', a.length, 3);
eq('A: tipos', a.map(r => r.kind), ['boost', 'design', 'other']);
eq('A: montos', a.map(r => r.amount), [12, 5, 2]);

// Forma B: epoch en segundos, claves snake_case, array en la raíz
const B = [
  { record_id: 'x1', credits: 8, created_at: 1757635200, source: 'design_reward' },
  { record_id: 'x2', credits: 3, created_at: 1757721600, source: 'boost_received' },
];
const b = extractRecords(B, 'https://makerworld.com/api/v1/point-service/credit?page=2');
eq('B: cantidad', b.length, 2);
eq('B: tipos', b.map(r => r.kind), ['design', 'boost']);
eq('B: ts en ms', b[0].ts, 1757635200000);

// Paginación
eq('pag offset', detectPagination('https://x.com/a?offset=0&limit=20', {}), { style: 'offset', key: 'offset', next: 20, limit: 20 });
eq('pag page', detectPagination('https://x.com/a?page=2', {}), { style: 'page', key: 'page', next: 3 });
eq('pag none', detectPagination('https://x.com/a', {}), null);
eq('pag cursor', detectPagination('https://x.com/a', { data: { nextToken: 'abc' } }), { style: 'cursor', key: 'cursor', next: 'abc' });

// Ruido: no debe tragarse arrays que no son registros
const noise = { data: { banners: [{ id: 1, url: 'x' }], user: { name: 'juan' } } };
eq('ruido', extractRecords(noise, 'https://makerworld.com/api/v1/point-service/x').length, 0);

// Dedup + agregación
const recs = {};
for (const r of [...a, ...extractRecords(A, 'otra-url')]) recs[r.id] = r;
eq('dedup', Object.keys(recs).length, 3);
const s = byDay(recs);
eq('dias', s.map(d => d.day).length, 2);
eq('total', totals(s).total, 19);
eq('boost total', totals(s).boost, 12);
eq('design total', totals(s).design, 5);

eq('classify boost', classify('Boost rewards from user'), 'boost');
eq('classify design', classify('Print Profile reward'), 'design');
eq('classify other', classify('Lottery'), 'other');
eq('epoch string', toEpochMs('1757635200'), 1757635200000);
eq('makerworld root', isMakerWorldUrl('https://makerworld.com/'), true);
eq('makerworld www', isMakerWorldUrl('https://www.makerworld.com/@me'), true);
eq('makerworld subdomain', isMakerWorldUrl('https://shop.makerworld.com/'), true);
eq('other domain', isMakerWorldUrl('https://example.com/'), false);

// URL sin "puntos" (p.ej. /_next/data): solo cuentan campos explícitos de puntos
const models = { pageProps: { designs: [{ id: 1, score: 4.8, createTime: '2026-09-01' }] } };
eq('estricto: ignora score', extractRecords(models, 'https://makerworld.com/_next/data/b/en/models.json').length, 0);
const ssr = { pageProps: { list: [{ id: 7, pointChange: 3, createTime: '2026-09-01', type: 'Boost' }] } };
eq('estricto: acepta pointChange', extractRecords(ssr, 'https://makerworld.com/_next/data/b/en/my/wallet.json').map(r => r.kind), ['boost']);

// Fotos de totales
const summary = { pageProps: { boostAndPointSummary: { userTotalPoint: 1939, userTotalBoostIncomes: 30, oneBoostExchangePoint: 12 } } };
eq('snap summary', extractSnapshot(summary, 1), { ts: 1, total: 1939, exclusive: null, regular: null, boosts: 30, rate: 12 });
eq('snap session', extractSnapshot({ pageProps: { session: { user: { point: 5, boostGained: 1 } } } }, 2), { ts: 2, total: 5, exclusive: null, regular: null, boosts: 1, rate: null });
eq('snap nada', extractSnapshot({ pageProps: {} }, 3), null);
const d = diffSnapshots({ ts: 1, total: 1939, boosts: 30, rate: 12 }, { ts: 2, total: 1975, boosts: 32, rate: 12 });
eq('diff boost+diseño', d.map(r => [r.kind, r.amount]), [['boost', 24], ['design', 12]]);
eq('diff canje', diffSnapshots({ ts: 1, total: 100, boosts: 0 }, { ts: 2, total: 40, boosts: 0, rate: 12 }).map(r => [r.kind, r.amount]), [['other', -60]]);
eq('diff primera foto', diffSnapshots(undefined, { ts: 2, total: 1, boosts: 0, rate: 12 }), []);

// Historial point-bill
const bills = { total: 3, hits: [
  { id: 9, type: 'boost_exchange_point', createTime: '2026-09-12T10:00:00Z', pointChangeRegular: 0, pointChangeExclusive: 12, extInfoBoostExchangePoint: { designTitle: 'Llavero', fromUserHandle: 'ana' } },
  { id: 8, type: 'design_reward_v2', createTime: '2026-09-11T10:00:00Z', pointChangeRegular: 5, pointChangeExclusive: 2.5, designRewardV2: { title: 'Capibaras' } },
  { id: 7, type: 'exchange_cash', createTime: '2026-09-10T10:00:00Z', pointChangeRegular: -490, pointChangeExclusive: 0 },
]};
eq('bills detecta', looksLikeBills(bills), true);
eq('bills no detecta ruido', looksLikeBills({ hits: [{ name: 'USA' }] }), false);
const pb = parseBills(bills);
eq('bills kinds', pb.map(r => [r.kind, r.amount]), [['boost', 12], ['design', 7.5], ['other', -490]]);
eq('bills label', pb[0].label, 'Boost — Llavero · @ana');
eq('bills id', pb[1].id, 'bill:8');
eq('bills instance', billKind('instance_reward_v2'), 'design');
const bd = totals(byDay(Object.fromEntries(pb.map(r => [r.id, r]))));
eq('excl ganados', bd.total, 14.5);
eq('excl por tipo', [bd.boost, bd.design], [12, 2.5]);
eq('regulares aparte', [bd.regular, bd.regularSpent, bd.spent], [5, 490, 0]);

// Por modelo
const mb = parseBills({ hits: [
  ...bills.hits,
  { id: 10, type: 'design_reward_v2', createTime: '2026-09-13T10:00:00Z', pointChangeRegular: 1, pointChangeExclusive: 3, designRewardV2: { title: 'Llavero' } },
  { id: 11, type: 'instance_reward_v2', createTime: '2026-09-13T11:00:00Z', pointChangeRegular: 0, pointChangeExclusive: 1.5, instanceRewardV2: { instanceTitle: '0,2 mm', designTitle: ' Llavero ' } },
  { id: 12, type: 'design_reward_v2', createTime: '2026-08-01T10:00:00Z', pointChangeRegular: 0, pointChangeExclusive: 4, designRewardV2: { title: 'Capibaras' } },
]});
const mrec = Object.fromEntries(mb.map(r => [r.id, r]));
eq('modelo boost', billDesign(bills.hits[0]), { key: 't:llavero', keys: ['t:llavero'], title: 'Llavero' });
eq('modelo con id', billDesign({ type: 'design_reward_v2', designRewardV2: { title: 'X', designId: 55 } }).key, 'id:55');
eq('modelo canje', billDesign(bills.hits[2]), null);
eq('modelo con modelId', billDesign({ type: 'boost_exchange_point', extInfoBoostExchangePoint: { designTitle: 'X', modelId: 'USab12' } }).key, 'm:USab12');
eq('por modelo', byModel(mrec).map(m => [m.title, m.total, m.design, m.boost, m.boosts]), [['Llavero', 16.5, 4.5, 12, 1], ['Capibaras', 6.5, 6.5, 0, 0]]);
// Una publicación con dos perfiles: el perfil no separa, y el id une al título.
const perfiles = Object.fromEntries(parseBills({ hits: [
  { id: 20, type: 'instance_reward_v2', createTime: '2026-09-13T10:00:00Z', pointChangeRegular: 0, pointChangeExclusive: 2, instanceRewardV2: { instanceId: 1, instanceTitle: '0,2 mm', designId: 77, designTitle: 'GTA VI' } },
  { id: 21, type: 'instance_reward_v2', createTime: '2026-09-13T11:00:00Z', pointChangeRegular: 0, pointChangeExclusive: 3, instanceRewardV2: { instanceId: 2, instanceTitle: 'Plano', designId: 77, designTitle: 'GTA VI' } },
  { id: 22, type: 'design_reward_v2', createTime: '2026-09-13T12:00:00Z', pointChangeRegular: 0, pointChangeExclusive: 4, designRewardV2: { title: 'GTA VI', designId: 77 } },
  { id: 23, type: 'boost_exchange_point', createTime: '2026-09-13T13:00:00Z', pointChangeRegular: 0, pointChangeExclusive: 5, extInfoBoostExchangePoint: { designTitle: 'GTA VI' } },
]}).map(r => [r.id, r]));
eq('perfiles juntos', byModel(perfiles).map(m => [m.key, m.title, m.total, m.design, m.boost]), [['id:77', 'GTA VI', 14, 9, 5]]);
eq('perfiles claves', byModel(perfiles)[0].keys.sort(), ['id:77', 't:gta vi']);
eq('perfil sin designTitle', billDesign({ type: 'instance_reward_v2', instanceRewardV2: { instanceTitle: '0,2 mm' } }), null);
eq('por modelo rango', byModel(mrec, { from: '2026-09-01', to: '2026-09-30' }).map(m => [m.title, m.total]), [['Llavero', 16.5], ['Capibaras', 2.5]]);

// Penalizaciones aparte de los canjes: las aplica MakerWorld, no el usuario.
const neg = Object.fromEntries(parseBills({ hits: [
  { id: 1, type: 'design_reward_v2', createTime: '2026-09-24T10:00:00Z', pointChangeExclusive: 50, pointChangeRegular: 0 },
  { id: 2, type: 'design_exclusive_violation_revoke', createTime: '2026-09-24T11:00:00Z', pointChangeExclusive: -223.5, pointChangeRegular: 0 },
  { id: 3, type: 'instance_exclusive_violation_revoke', createTime: '2026-09-24T11:05:00Z', pointChangeExclusive: -3.75, pointChangeRegular: 0 },
  { id: 4, type: 'exchange_cash', createTime: '2026-09-24T15:00:00Z', pointChangeExclusive: -1500, pointChangeRegular: 0 },
] }).map((r) => [r.id, r]));
const negDay = byDay(neg)[0];
eq('penalización aparte', [negDay.total, negDay.spent, negDay.penalty], [50, 1500, 227.25]);
eq('penalización etiqueta', neg['bill:2'].label, 'Penalización por exclusividad (diseño)');

console.log(fail ? `\n${fail} fallos` : '\nTodo verde');
process.exit(fail ? 1 : 0);
