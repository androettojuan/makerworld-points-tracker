import { extractRecords, POINT_URL_RE } from './lib/parse.js';
import { isMakerWorldUrl } from './lib/makerworld.js';
import { extractSnapshot, diffSnapshots } from './lib/snapshot.js';
import { billUrl, isBillUrl, looksLikeBills, parseBills, BILL_LIMIT } from './lib/bills.js';
import { saveRecords, removeRecords, saveEndpoint, getEndpoints, getRecords, setMeta, getMeta, clearAll } from './lib/store.js';

const MAX_BILL_PAGES = 500;    // 50.000 movimientos
const SYNC_ALARM = 'mwpt-sync';
const DEFAULT_BOOST_RATE = 12; // oneBoostExchangePoint observado en /points

/** Replays pendientes: id -> resolve */
const pending = new Map();
let seq = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 180 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll().catch(() => {});
});

/**
 * store.js hace leer-modificar-escribir sobre chrome.storage; con varias
 * capturas llegando juntas se pisarían. Las serializamos en una cola.
 */
let queue = Promise.resolve();
const serialized = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
  return true; // respuesta asíncrona
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'capture':
      return serialized(() => onCapture(msg.payload, sender));
    case 'replay-result': {
      const resolve = pending.get(msg.payload.id);
      if (resolve) { pending.delete(msg.payload.id); resolve(msg.payload); }
      return { ok: true };
    }
    case 'ready':
      return { ok: true };
    case 'get-state':
      return { records: await getRecords(), endpoints: await getEndpoints(), meta: await getMeta() };
    case 'sync':
      return syncAll();
    case 'reset':
      await serialized(clearAll);
      return { ok: true };
    default:
      return { ok: false, unknown: msg.type };
  }
}

/** Llega una respuesta capturada del sniffer: la guardamos y aprendemos el endpoint. */
async function onCapture({ url, method, headers, body, at, pointy, pageUrl }, sender) {
  const snap = extractSnapshot(body, at);
  if (snap) await applySnapshot(snap, pageUrl);

  if (isBillUrl(url) || looksLikeBills(body)) {
    const added = await saveRecords(parseBills(body, url));
    await setMeta({ lastCapture: at });
    return { ok: true, added };
  }

  pointy = Boolean(pointy || POINT_URL_RE.test(url));
  const records = extractRecords(body, url, { pointy });
  if (!records.length && (!pointy || snap)) return { ok: true, added: 0 };
  const profile = await saveEndpoint({
    url, method: method || 'GET', headers: headers || {}, at, pointy,
    yields: records.length,
    // Sin registros guardamos un pedazo de la respuesta para poder ver su forma.
    sample: records.length ? undefined : sampleOf(body),
    tabId: sender?.tab?.id ?? null,
  });
  if (!records.length) return { ok: true, added: 0, endpoint: profile.key };

  const added = await saveRecords(records);
  await setMeta({ lastCapture: at });
  return { ok: true, added, endpoint: profile.key };
}

/** Compara con la última foto de totales y guarda la diferencia como registros. */
async function applySnapshot(snap, pageUrl) {
  const meta = await getMeta();
  const prev = meta.snapshot;
  if (prev && snap.ts <= prev.ts) return 0; // llegó desordenada
  const rate = snap.rate ?? meta.boostRate ?? DEFAULT_BOOST_RATE;
  const cur = { ...snap, rate };
  const added = meta.billsSynced ? 0 : await saveRecords(diffSnapshots(prev, cur));
  const patch = { snapshot: cur, boostRate: rate, lastCapture: snap.ts };
  // Guardamos la página de puntos para re-pedirla al sincronizar.
  if (snap.rate !== null && pageUrl) patch.snapshotPage = pageUrl;
  await setMeta(patch);
  return added;
}

const SAMPLE_MAX = 20000;
const sampleOf = (body) => {
  const s = JSON.stringify(body, null, 2);
  return s.length > SAMPLE_MAX ? `${s.slice(0, SAMPLE_MAX)}\n… (${s.length} caracteres)` : s;
};

/** Pide al sniffer de una pestaña de MakerWorld que re-emita una request. */
async function replay(tabId, url, method, headers) {
  const id = `r${++seq}`;
  const result = new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ id, ok: false, status: 0, error: 'timeout' }); }
    }, 20000);
  });
  await chrome.tabs.sendMessage(tabId, { type: 'replay', payload: { id, url, method, headers } });
  return result;
}

async function findMakerWorldTab() {
  const tabs = await chrome.tabs.query({ url: ['https://makerworld.com/*', 'https://*.makerworld.com/*'] });
  const match = tabs.find((tab) => {
    if (!tab.url) return false;
    return isMakerWorldUrl(tab.url);
  });
  return match || null;
}

/**
 * Trae el historial de puntos (point-bill) desde la pestaña de MakerWorld.
 * La primera vez lo recorre entero; después para en la primera página que no
 * aporte nada nuevo, porque viene ordenado del más nuevo al más viejo.
 */
async function syncBills(tab, full) {
  const origin = new URL(tab.url).origin;
  let added = 0;
  let pages = 0;
  for (let offset = 0; pages < MAX_BILL_PAGES; offset += BILL_LIMIT) {
    const res = await replay(tab.id, billUrl(origin, offset), 'GET', {});
    pages++;
    if (!res.ok || !looksLikeBills(res.body)) {
      if (res.status === 401 || res.status === 403) throw new Error('MakerWorld rechazó la consulta: iniciá sesión en makerworld.com y volvé a sincronizar.');
      if (pages === 1) return null; // endpoint no disponible
      break;
    }
    const recs = parseBills(res.body, billUrl(origin, offset));
    const newOnes = await serialized(() => saveRecords(recs));
    added += newOnes;
    const total = Number(res.body.total) || 0;
    if (!recs.length || offset + BILL_LIMIT >= total) break;
    if (!full && newOnes === 0) break;
  }
  return { added, pages };
}

async function syncAll() {
  const tab = await findMakerWorldTab();
  if (!tab) {
    return { ok: false, error: 'Abrí una pestaña en makerworld.com (con tu sesión iniciada) y volvé a sincronizar.' };
  }

  let added = 0;
  let pages = 0;
  const meta = await getMeta();

  // 1) Historial completo de movimientos.
  let bills = null;
  try {
    bills = await syncBills(tab, !meta.billsSynced);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (bills) {
    added += bills.added;
    pages += bills.pages;
    if (!meta.billsSynced) {
      // Los registros estimados por fotos de totales se solaparían con los reales.
      await serialized(async () => {
        await removeRecords((r) => r.sourceUrl === 'snapshot');
        await setMeta({ billsSynced: true });
      });
    }
  }

  // 2) Foto de totales para mostrar el total actual.
  const page = meta.snapshotPage || `${new URL(tab.url).origin}/points`;
  const snapRes = await replay(tab.id, page, 'GET', {});
  pages++;
  const snap = snapRes.ok && extractSnapshot(snapRes.body, Date.now());
  if (snap) added += await serialized(() => applySnapshot(snap, page));

  if (!bills && !snap) {
    return { ok: false, error: 'No pude leer tus puntos. Entrá a makerworld.com/points con tu sesión iniciada y volvé a sincronizar.' };
  }

  await serialized(() => setMeta({ lastSync: Date.now() }));
  return { ok: true, added, pages };
}
