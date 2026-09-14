import { dayKey } from './parse.js';

/** Agrupa registros por día con el desglose boost / diseño / otros. */
export function byDay(records) {
  const days = new Map();
  for (const rec of Object.values(records)) {
    const d = rec.day || dayKey(rec.ts);
    if (!days.has(d)) days.set(d, { day: d, total: 0, boost: 0, design: 0, other: 0, count: 0 });
    const bucket = days.get(d);
    bucket.total += rec.amount;
    bucket[rec.kind] = (bucket[rec.kind] || 0) + rec.amount;
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
    out.push(index.get(key) || { day: key, total: 0, boost: 0, design: 0, other: 0, count: 0 });
  }
  return out;
}

export function totals(series) {
  return series.reduce(
    (acc, d) => ({
      total: acc.total + d.total,
      boost: acc.boost + d.boost,
      design: acc.design + d.design,
      other: acc.other + d.other,
    }),
    { total: 0, boost: 0, design: 0, other: 0 }
  );
}

export function sumLastDays(series, n) {
  return totals(series.slice(-n));
}
