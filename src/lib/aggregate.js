import { dayKey } from './parse.js';

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
