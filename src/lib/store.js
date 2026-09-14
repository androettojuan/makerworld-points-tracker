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
  endpoints[key] = {
    ...profile,
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
}
