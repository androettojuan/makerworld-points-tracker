import { dayKey } from './parse.js';
import { billDesign } from './bills.js';

const round = (n) => Math.round(n * 100) / 100;
const FIELDS = ['total', 'boost', 'design', 'other', 'spent', 'regular', 'regularSpent'];
const emptyBucket = (extra) => ({ ...extra, ...Object.fromEntries(FIELDS.map((f) => [f, 0])), count: 0 });

/**
 * Puntos exclusivos y regulares de un registro. El historial de MakerWorld los
 * trae separados; registros de otras fuentes cuentan todo como exclusivo.
 */
function pointsOf(rec) {
  const raw = rec.raw;
  if (raw && ('pointChangeExclusive' in raw || 'pointChangeRegular' in raw)) {
    return { exclusive: Number(raw.pointChangeExclusive) || 0, regular: Number(raw.pointChangeRegular) || 0 };
  }
  return { exclusive: rec.amount, regular: 0 };
}

/**
 * Agrupa registros por día.
 * `total` y el desglose boost / diseño / otros son puntos **exclusivos** ganados;
 * los regulares van en `regular`. Lo negativo (canjes) va aparte en `spent` y
 * `regularSpent` para que no achique las ganancias del período.
 */
export function byDay(records) {
  const days = new Map();
  for (const rec of Object.values(records)) {
    const d = rec.day || dayKey(rec.ts);
    if (!days.has(d)) days.set(d, emptyBucket({ day: d }));
    const bucket = days.get(d);
    const { exclusive, regular } = pointsOf(rec);

    if (exclusive < 0) bucket.spent += -exclusive;
    else if (exclusive > 0) {
      bucket.total += exclusive;
      bucket[rec.kind] = (bucket[rec.kind] || 0) + exclusive;
    }
    if (regular < 0) bucket.regularSpent += -regular;
    else bucket.regular += regular;

    bucket.count++;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Rellena los días sin registros para que el gráfico no mienta con huecos. */
export function fillGaps(series, days) {
  if (!series.length) return [];
  const end = new Date();
  const out = [];
  const index = new Map(series.map((s) => [s.day, s]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());
    out.push(index.get(key) || emptyBucket({ day: key }));
  }
  return out;
}

export function totals(series) {
  const acc = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const d of series) {
    for (const f of FIELDS) acc[f] += d[f] || 0;
  }
  for (const f of FIELDS) acc[f] = round(acc[f]);
  return acc;
}

/** Suma los días entre `from` y `to` (YYYY-MM-DD, ambos incluidos). */
export function sumRange(series, from, to) {
  return totals(series.filter((d) => d.day >= from && d.day <= to));
}

export function sumLastDays(series, n) {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  return sumRange(series, dayKey(d.getTime()), dayKey(Date.now()));
}

/** Totales por mes (YYYY-MM), del más nuevo al más viejo. */
export function byMonth(series) {
  const months = new Map();
  for (const d of series) {
    const m = d.day.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(d);
  }
  return [...months.entries()]
    .map(([month, days]) => ({ month, ...totals(days) }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/**
 * Exclusivos ganados por modelo entre `from` y `to` (YYYY-MM-DD, incluidos;
 * sin límites = todo el historial), del que más dio al que menos.
 * Junta recompensas de diseño, de todos los perfiles de impresión (`design`) y
 * boosts (`boost`) de una misma publicación: dos movimientos van juntos si
 * comparten id o título (ver `billDesign`). Las equivalencias se aprenden de todo
 * el historial, no solo del período. Si una publicación cambió de título y
 * MakerWorld no manda su id, queda partida en dos.
 * Cada resultado trae en `keys` todas las claves que la identifican.
 */
export function byModel(records, { from = '', to = '9999-99-99' } = {}) {
  const all = Object.values(records).map((rec) => [rec, billDesign(rec.raw)]).filter(([, m]) => m);

  // Unión de claves: cada movimiento une todas las suyas en un mismo grupo.
  const parent = new Map();
  const root = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(k, r);
    return r;
  };
  for (const [, m] of all) {
    const first = root(m.keys[0]);
    for (const k of m.keys.slice(1)) {
      const r = root(k);
      if (r !== root(first)) parent.set(r, root(first));
    }
  }
  const groupKeys = new Map();
  for (const k of [...parent.keys()]) {
    const r = root(k);
    if (!groupKeys.has(r)) groupKeys.set(r, []);
    groupKeys.get(r).push(k);
  }

  const models = new Map();
  for (const [rec, model] of all) {
    const d = rec.day || dayKey(rec.ts);
    if (d < from || d > to) continue;
    const { exclusive, regular } = pointsOf(rec);
    const r = root(model.keys[0]);
    if (!models.has(r)) {
      const keys = groupKeys.get(r);
      // Clave estable: preferimos el id de la publicación.
      const key = keys.find((k) => k.startsWith('id:')) || keys.find((k) => k.startsWith('m:')) || keys[0];
      models.set(r, { key, keys, title: model.title, total: 0, design: 0, boost: 0, regular: 0, boosts: 0, last: 0 });
    }
    const m = models.get(r);
    if (exclusive > 0) {
      m.total += exclusive;
      if (rec.kind === 'boost') m.boost += exclusive;
      else m.design += exclusive;
    }
    if (regular > 0) m.regular += regular;
    if (rec.kind === 'boost') m.boosts++;
    if (rec.ts > m.last) { m.last = rec.ts; m.title = model.title; }
  }
  return [...models.values()]
    .map((m) => ({ ...m, total: round(m.total), design: round(m.design), boost: round(m.boost), regular: round(m.regular) }))
    .filter((m) => m.total > 0 || m.regular > 0)
    .sort((a, b) => b.total - a.total || b.regular - a.regular || a.title.localeCompare(b.title));
}
