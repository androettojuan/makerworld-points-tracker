/**
 * MakerWorld no expone un historial de movimientos: solo totales acumulados.
 * Tomamos "fotos" de esos totales cada vez que los vemos pasar y convertimos la
 * diferencia entre dos fotos en registros, así el resto de la extensión (agregado
 * diario, popup, CSV) sigue trabajando igual.
 */
import { dayKey } from './parse.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Busca los totales en una respuesta de Next.js ({ pageProps: … }).
 * `/points` trae `boostAndPointSummary` (con el valor de cada boost); el resto
 * de las páginas trae al menos `session.user`.
 */
export function extractSnapshot(body, ts) {
  const props = body?.pageProps;
  if (!props) return null;

  const s = props.boostAndPointSummary;
  if (s && num(s.userTotalPoint) !== null) {
    return {
      ts,
      total: s.userTotalPoint,
      exclusive: num(s.userTotalExclusivePoint),
      regular: num(s.userTotalRegularPoint),
      boosts: num(s.userTotalBoostIncomes),
      rate: num(s.oneBoostExchangePoint),
    };
  }

  const u = props.session?.user;
  if (u && num(u.point) !== null) {
    return { ts, total: u.point, exclusive: num(u.pointExclusive), regular: num(u.pointRegular), boosts: num(u.boostGained), rate: null };
  }
  return null;
}

/** Registros que explican el paso de `prev` a `cur`. `cur.rate` debe venir resuelto. */
export function diffSnapshots(prev, cur) {
  if (!prev || !cur || cur.ts <= prev.ts) return [];

  const newBoosts = prev.boosts !== null && cur.boosts !== null ? cur.boosts - prev.boosts : 0;
  const boostPts = round(newBoosts * (cur.rate || 0));
  const rest = round(cur.total - prev.total - boostPts);
  const base = { ts: cur.ts, day: dayKey(cur.ts), sourceUrl: 'snapshot', raw: { prev, cur } };
  const out = [];

  if (boostPts !== 0) {
    out.push({ ...base, id: `snap:${cur.ts}:boost`, amount: boostPts, kind: 'boost',
      label: `Boosts recibidos (${newBoosts} × ${cur.rate})` });
  }
  if (rest > 0) {
    out.push({ ...base, id: `snap:${cur.ts}:design`, amount: rest, kind: 'design',
      label: 'Diseños y tareas (variación del total)' });
  } else if (rest < 0) {
    out.push({ ...base, id: `snap:${cur.ts}:other`, amount: rest, kind: 'other',
      label: 'Canjes o ajustes (variación del total)' });
  }
  return out;
}
