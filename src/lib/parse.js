/**
 * Normalización de respuestas de la API de MakerWorld.
 *
 * No sabemos de antemano la forma exacta del JSON, así que en vez de acoplarnos
 * a un esquema recorremos la respuesta buscando arrays de objetos que parezcan
 * registros de puntos: algo con una cantidad y una fecha.
 */

const AMOUNT_KEYS = ['point', 'points', 'pointamount', 'pointnum', 'pointvalue', 'changepoint', 'pointchange', 'changeamount', 'amount', 'credit', 'credits', 'value', 'num', 'quantity', 'score'];
const TIME_KEYS = ['createtime', 'createdat', 'created_at', 'createat', 'time', 'date', 'datetime', 'timestamp', 'ts', 'day', 'updatetime'];
const ID_KEYS = ['id', 'recordid', 'record_id', 'uid', 'bizid', 'orderid', 'serialno', 'no'];
const TEXT_KEYS = ['type', 'subtype', 'category', 'source', 'title', 'name', 'desc', 'description', 'remark', 'reason', 'action', 'event', 'bizType', 'pointtype', 'scene'];

const lower = (o) => {
  const m = {};
  for (const k of Object.keys(o)) m[k.toLowerCase().replace(/[_-]/g, '')] = k;
  return m;
};

const findKey = (obj, candidates) => {
  const map = lower(obj);
  for (const c of candidates) {
    const norm = c.toLowerCase().replace(/[_-]/g, '');
    if (map[norm] !== undefined) return map[norm];
  }
  return null;
};

/** Convierte lo que sea (ms, segundos, ISO, "2026-09-13") en epoch ms, o null. */
export function toEpochMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    // < 1e12 lo interpretamos como segundos
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return toEpochMs(Number(s));
    const t = Date.parse(s.includes('T') || s.includes('-') ? s : s.replace(/\//g, '-'));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * En URLs que no hablan de puntos solo aceptamos campos de cantidad que digan
 * "point"/"credit" explícitamente; si no, cualquier lista con `score` o `value`
 * y fecha (modelos, comentarios…) se colaría como registro.
 */
const STRICT_AMOUNT_KEYS = AMOUNT_KEYS.filter((k) => /point|credit/.test(k));

const looksLikeRecord = (o, amountKeys = AMOUNT_KEYS) =>
  o && typeof o === 'object' && !Array.isArray(o) &&
  findKey(o, amountKeys) !== null &&
  findKey(o, TIME_KEYS) !== null;

/** Recorre el JSON y devuelve todos los arrays de objetos con pinta de registros. */
function collectCandidateArrays(node, amountKeys, path = '$', out = []) {
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length && objs.filter((o) => looksLikeRecord(o, amountKeys)).length >= Math.ceil(objs.length / 2)) {
      out.push({ path, items: objs });
      return out; // no bajamos más: este array ya es la lista
    }
    node.forEach((child, i) => collectCandidateArrays(child, amountKeys, `${path}[${i}]`, out));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) collectCandidateArrays(v, amountKeys, `${path}.${k}`, out);
  }
  return out;
}

const textBlob = (o) => {
  const parts = [];
  for (const key of TEXT_KEYS) {
    const k = findKey(o, [key]);
    if (k && (typeof o[k] === 'string' || typeof o[k] === 'number')) parts.push(String(o[k]));
  }
  return parts.join(' | ');
};

/**
 * Clasifica un registro en 'boost' | 'design' | 'other'.
 * Las reglas viven acá a propósito: son lo primero que habrá que ajustar cuando
 * veamos los textos reales que devuelve la API.
 */
export function classify(text) {
  const t = (text || '').toLowerCase();
  if (/boost/.test(t)) return 'boost';
  if (/(design|model|print[\s_-]?profile|download|make|remix|upload|creator|exchange rate|reward)/.test(t)) return 'design';
  return 'other';
}

export const POINT_URL_RE = /point|credit|reward|income|earning/i;

/** Extrae y normaliza registros desde una respuesta cruda de la API. */
export function extractRecords(body, sourceUrl = '', { pointy = POINT_URL_RE.test(sourceUrl) } = {}) {
  const amountKeys = pointy ? AMOUNT_KEYS : STRICT_AMOUNT_KEYS;
  const arrays = collectCandidateArrays(body, amountKeys);
  const records = [];

  for (const { path, items } of arrays) {
    for (const item of items) {
      const amountKey = findKey(item, amountKeys);
      const timeKey = findKey(item, TIME_KEYS);
      if (!amountKey || !timeKey) continue;

      const amount = Number(item[amountKey]);
      const ts = toEpochMs(item[timeKey]);
      if (!Number.isFinite(amount) || ts == null) continue;

      const idKey = findKey(item, ID_KEYS);
      const text = textBlob(item);
      const rawId = idKey ? String(item[idKey]) : null;

      records.push({
        // Sin id propio, uno sintético estable: mismo registro => misma clave.
        id: rawId ? `${path}:${rawId}` : `syn:${ts}:${amount}:${text.slice(0, 60)}`,
        ts,
        day: dayKey(ts),
        amount,
        kind: classify(text),
        label: text || '(sin descripción)',
        sourceUrl,
        raw: item,
      });
    }
  }
  return records;
}

/** Fecha local en YYYY-MM-DD (los días los cuenta el usuario en su huso, no en UTC). */
export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Detecta paginación para poder pedir la página siguiente al replay. */
export function detectPagination(url, body) {
  const u = new URL(url);
  const params = u.searchParams;
  const numeric = (k) => {
    const v = params.get(k);
    return v !== null && /^\d+$/.test(v) ? Number(v) : null;
  };

  for (const key of ['offset', 'skip']) {
    const cur = numeric(key);
    if (cur !== null) {
      const limit = numeric('limit') ?? numeric('pageSize') ?? numeric('size') ?? 20;
      return { style: 'offset', key, next: cur + limit, limit };
    }
  }
  for (const key of ['page', 'pageNum', 'pageNumber', 'current']) {
    const cur = numeric(key);
    if (cur !== null) return { style: 'page', key, next: cur + 1 };
  }
  // Sin parámetro en la URL: si la respuesta trae un cursor, lo usamos.
  const cursor = deepFind(body, ['nexttoken', 'nextcursor', 'cursor', 'next']);
  if (cursor && typeof cursor === 'string') return { style: 'cursor', key: 'cursor', next: cursor };
  return null;
}

function deepFind(node, keys, depth = 0) {
  if (depth > 4 || !node || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (keys.includes(k.toLowerCase().replace(/[_-]/g, ''))) return v;
  }
  for (const v of Object.values(node)) {
    const found = deepFind(v, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
}
