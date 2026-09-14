import { extractRecords, detectPagination } from './lib/parse.js';
import { saveRecords, saveEndpoint, getEndpoints, getRecords, setMeta, getMeta, clearAll } from './lib/store.js';

const MAX_PAGES = 60;          // techo duro para no paginar al infinito
const SYNC_ALARM = 'mwpt-sync';

/** Replays pendientes: id -> resolve */
const pending = new Map();
let seq = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 180 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
  return true; // respuesta asíncrona
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'capture':
      return onCapture(msg.payload, sender);
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
      await clearAll();
      return { ok: true };
    default:
      return { ok: false, unknown: msg.type };
  }
}

/** Llega una respuesta capturada del sniffer: la guardamos y aprendemos el endpoint. */
async function onCapture({ url, method, headers, body, at }, sender) {
  const records = extractRecords(body, url);
  const profile = await saveEndpoint({
    url, method: method || 'GET', headers: headers || {}, at,
    yields: records.length,
    tabId: sender?.tab?.id ?? null,
  });
  if (!records.length) return { ok: true, added: 0, endpoint: profile.key };

  const added = await saveRecords(records);
  await setMeta({ lastCapture: at });
  return { ok: true, added, endpoint: profile.key };
}

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
  const tabs = await chrome.tabs.query({ url: 'https://makerworld.com/*' });
  return tabs[0] || null;
}

/**
 * Recorre hacia atrás cada endpoint conocido hasta que una página no aporte
 * registros nuevos: eso significa que ya tenemos ese tramo del histórico.
 */
async function syncAll() {
  const tab = await findMakerWorldTab();
  if (!tab) {
    return { ok: false, error: 'Abrí una pestaña en makerworld.com (con tu sesión iniciada) y volvé a sincronizar.' };
  }

  const endpoints = Object.values(await getEndpoints()).filter((e) => e.yields > 0);
  if (!endpoints.length) {
    return { ok: false, error: 'Todavía no capturé ningún endpoint de puntos. Entrá a tu historial de puntos en MakerWorld y desplazate por la lista.' };
  }

  let added = 0;
  let pages = 0;

  for (const ep of endpoints) {
    let url = ep.url;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await replay(tab.id, url, ep.method, ep.headers);
      pages++;
      if (!res.ok || !res.body) break;

      const recs = extractRecords(res.body, url);
      if (!recs.length) break;

      const newOnes = await saveRecords(recs);
      added += newOnes;
      if (newOnes === 0) break; // ya conocíamos toda esta página

      const page = detectPagination(url, res.body);
      if (!page) break;
      const u = new URL(url);
      u.searchParams.set(page.key, String(page.next));
      url = u.toString();
    }
  }

  await setMeta({ lastSync: Date.now() });
  return { ok: true, added, pages };
}
