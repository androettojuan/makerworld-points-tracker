/** Capa fina sobre chrome.storage.local. */

const KEYS = { records: 'records', endpoints: 'endpoints', meta: 'meta' };

export async function getRecords() {
  const { [KEYS.records]: r } = await chrome.storage.local.get(KEYS.records);
  return r || {};
}

/** Guarda registros deduplicando por id. Devuelve cuántos eran nuevos. */
export async function saveRecords(list) {
  const records = await getRecords();
  let added = 0;
  for (const rec of list) {
    if (!records[rec.id]) added++;
    records[rec.id] = rec;
  }
  await chrome.storage.local.set({ [KEYS.records]: records });
  return added;
}

/** Borra los registros que cumplan `pred`. Devuelve cuántos borró. */
export async function removeRecords(pred) {
  const records = await getRecords();
  let removed = 0;
  for (const [id, rec] of Object.entries(records)) {
    if (pred(rec)) { delete records[id]; removed++; }
  }
  if (removed) await chrome.storage.local.set({ [KEYS.records]: records });
  return removed;
}

export async function getEndpoints() {
  const { [KEYS.endpoints]: e } = await chrome.storage.local.get(KEYS.endpoints);
  return e || {};
}

/**
 * Un endpoint se identifica por método + path (sin query), así una nueva página
 * pisa el perfil viejo en vez de multiplicarlo.
 */
export async function saveEndpoint(profile) {
  const endpoints = await getEndpoints();
  const u = new URL(profile.url);
  const key = `${profile.method} ${u.pathname}`;
  const prev = endpoints[key];
  // Una página vacía (fin del histórico) no debe borrar lo aprendido: si antes
  // este endpoint dio registros, conservamos esa URL y sus headers para el sync.
  const keepPrev = prev && prev.yields > 0 && !(profile.yields > 0);
  endpoints[key] = {
    ...(keepPrev ? prev : profile),
    yields: Math.max(prev?.yields || 0, profile.yields || 0),
    key,
    firstSeen: prev?.firstSeen || profile.at,
    lastSeen: profile.at,
    hits: (prev?.hits || 0) + 1,
  };
  await chrome.storage.local.set({ [KEYS.endpoints]: endpoints });
  return endpoints[key];
}

export async function getMeta() {
  const { [KEYS.meta]: m } = await chrome.storage.local.get(KEYS.meta);
  return m || {};
}

export async function setMeta(patch) {
  const meta = await getMeta();
  const next = { ...meta, ...patch };
  await chrome.storage.local.set({ [KEYS.meta]: next });
  return next;
}

export async function clearAll() {
  await chrome.storage.local.clear();
  await setMeta({ schema: SCHEMA });
}

/**
 * Versión del formato guardado. Si una versión futura cambia la forma de los
 * registros o de `meta`, sube este número y agrega el paso en `migrate`, así
 * nadie pierde su historial al actualizar.
 */
export const SCHEMA = 1;

export async function migrate() {
  const meta = await getMeta();
  const from = meta.schema || 0;
  if (from >= SCHEMA) return from;
  // 0 → 1: solo marca el formato; los datos de la 0.1 ya tienen la forma actual.
  await setMeta({ schema: SCHEMA });
  return SCHEMA;
}

/** Valida un respaldo exportado y devuelve sus registros, o null si no sirve. */
export function backupRecords(data) {
  const recs = data?.records;
  if (!recs || typeof recs !== 'object' || Array.isArray(recs)) return null;
  const list = Object.values(recs);
  const valid = list.filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.ts) && typeof r.amount === 'number');
  if (list.length && !valid.length) return null;
  if ((data.meta?.schema || 0) > SCHEMA) return null; // de una versión más nueva
  return valid;
}
