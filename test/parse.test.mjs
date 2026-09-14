import { extractRecords, detectPagination, classify, toEpochMs } from '../src/lib/parse.js';
import { byDay, totals } from '../src/lib/aggregate.js';

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

console.log(fail ? `\n${fail} fallos` : '\nTodo verde');
process.exit(fail ? 1 : 0);
