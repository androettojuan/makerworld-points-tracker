import { extractRecords, POINT_URL_RE } from './lib/parse.js';
import { isMakerWorldUrl } from './lib/makerworld.js';
import { extractSnapshot, diffSnapshots } from './lib/snapshot.js';
import { billUrl, isBillUrl, looksLikeBills, parseBills, BILL_LIMIT } from './lib/bills.js';
import { byModel } from './lib/aggregate.js';
import { dayKey } from './lib/parse.js';
import { t, MAKERWORLD_URL, MAKERWORLD_POINTS_URL } from './lib/i18n.js';
import { saveRecords, removeRecords, saveEndpoint, getEndpoints, getRecords, setMeta, getMeta, clearAll, migrate, backupRecords } from './lib/store.js';
import { usdRateOf, autoOpenOf } from './lib/settings.js';

const MAX_BILL_PAGES = 500;    // 50.000 movimientos
const SYNC_ALARM = 'mwpt-sync';
const DEFAULT_BOOST_RATE = 12; // oneBoostExchangePoint observado en /points

/** Replays pendientes: id -> resolve */
const pending = new Map();
let seq = 0;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 180 });
  await serialized(migrate);
  // La primera vez abrimos la guía para que se entienda cómo arrancar.
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
});

chrome.runtime.onStartup.addListener(() => { serialized(migrate); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  // Sin pestaña de MakerWorld, solo abrimos una de fondo si el usuario lo activó.
  const allowOpen = autoOpenOf(await getMeta());
  syncAll({ allowOpen }).catch(() => {});
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
      // Al abrir el popup se sincroniza solo si ya hay una pestaña de MakerWorld.
      return syncAll({ allowOpen: !msg.auto });
    case 'get-models':
      return modelPoints();
    case 'get-settings': {
      const meta = await getMeta();
      return { usdRate: usdRateOf(meta), autoOpen: autoOpenOf(meta) };
    }
    case 'set-settings': {
      const patch = {};
      if ('usdRate' in msg.payload) patch.usdRate = usdRateOf({ usdRate: msg.payload.usdRate });
      if ('autoOpen' in msg.payload) patch.autoOpen = msg.payload.autoOpen === true;
      if ('ignoredDiff' in msg.payload) patch.ignoredDiff = msg.payload.ignoredDiff;
      await serialized(() => setMeta(patch));
      return { ok: true };
    }
    case 'import': {
      const recs = backupRecords(msg.payload);
      if (!recs) return { ok: false };
      const added = await serialized(() => saveRecords(recs));
      return { ok: true, added };
    }
    case 'reset':
      await serialized(clearAll);
      return { ok: true };
    default:
      return { ok: false, unknown: msg.type };
  }
}

/**
 * Puntos por modelo para las tarjetas de makerworld.com: total histórico y
 * últimos 30 días, indexados por cada clave de la publicación (id:, m: y
 * t:título; ver `billDesign`), así src/cards.js la encuentra por cualquiera.
 */
async function modelPoints() {
  const records = await getRecords();
  const from = new Date();
  from.setDate(from.getDate() - 29);
  const recent = new Map(byModel(records, { from: dayKey(from.getTime()) }).map((m) => [m.key, m]));
  const models = {};
  for (const m of byModel(records)) {
    const r = recent.get(m.key);
    const entry = { title: m.title, total: m.total, design: m.design, boost: m.boost, boosts: m.boosts, last30: r ? r.total : 0 };
    for (const k of m.keys) models[k] = entry;
  }
  return { models, usdRate: usdRateOf(await getMeta()) };
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
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'replay', payload: { id, url, method, headers } });
  } catch {
    // La pestaña se cerró o se recargó en medio de la sincronización.
    pending.delete(id);
    throw Object.assign(new Error(t('errReload')), { reloadTab: tabId });
  }
  return result;
}

const MW_PATTERNS = ['https://makerworld.com/*', 'https://*.makerworld.com/*'];

/** ¿La pestaña tiene nuestros scripts? Las abiertas antes de instalar o actualizar, no. */
async function hasBridge(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

/** Primera pestaña de MakerWorld cargada (no suspendida) y con nuestros scripts. */
async function findMakerWorldTab() {
  const tabs = await chrome.tabs.query({ url: MW_PATTERNS });
  for (const tab of tabs) {
    if (!tab.url || !isMakerWorldUrl(tab.url) || tab.discarded || tab.status !== 'complete') continue;
    if (await hasBridge(tab.id)) return tab;
  }
  return null;
}

/** Espera a que una pestaña termine de cargar. */
function waitForLoad(tabId, ms = 30000) {
  return new Promise((resolve, reject) => {
    const done = (ok) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      ok ? resolve() : reject(new Error('load'));
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    const onRemoved = (id) => { if (id === tabId) done(false); };
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(true); }, () => done(false));
  });
}

/**
 * Abre MakerWorld en una pestaña de fondo (sin quitarle el foco a la actual) y
 * espera a que nuestros scripts estén listos. MakerWorld solo acepta consultas
 * hechas desde su propia página, así que esta es la única forma de sincronizar
 * sin que el usuario tenga una pestaña abierta.
 */
async function openBackgroundTab() {
  const tab = await chrome.tabs.create({ url: MAKERWORLD_POINTS_URL, active: false });
  try {
    await waitForLoad(tab.id);
    for (let i = 0; i < 10; i++) {
      if (await hasBridge(tab.id)) return chrome.tabs.get(tab.id);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch { /* abajo la cerramos */ }
  chrome.tabs.remove(tab.id).catch(() => {});
  return null;
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
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(t('errAuth')), { openUrl: MAKERWORLD_URL });
      // Respondió bien pero con otra forma: MakerWorld cambió su API.
      if (pages === 1 && res.ok && res.body) throw Object.assign(new Error(t('errApiChanged')), { apiChanged: true });
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

/** Una sola sincronización a la vez: si ya hay una en curso, esperamos esa. */
let running = null;
function syncAll(opts) {
  running ||= doSync(opts).finally(() => { running = null; });
  return running;
}

/**
 * `allowOpen`: si no hay una pestaña de MakerWorld utilizable, abrir una de fondo
 * y cerrarla al terminar.
 */
async function doSync({ allowOpen = true } = {}) {
  let tab = await findMakerWorldTab();
  let opened = false;
  if (!tab) {
    if (!allowOpen) return { ok: false, error: t('errNoTab'), openUrl: MAKERWORLD_URL, skipped: true };
    tab = await openBackgroundTab().catch(() => null);
    if (!tab) return { ok: false, error: t('errNoTab'), openUrl: MAKERWORLD_URL };
    opened = true;
  }
  try {
    return await syncFromTab(tab);
  } finally {
    if (opened) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function syncFromTab(tab) {
  let added = 0;
  let pages = 0;
  const meta = await getMeta();

  // 1) Historial completo de movimientos.
  let bills = null;
  try {
    bills = await syncBills(tab, !meta.billsSynced);
  } catch (err) {
    if (err.apiChanged) await serialized(() => setMeta({ apiChangedAt: Date.now() }));
    return { ok: false, error: err.message, openUrl: err.openUrl, reloadTab: err.reloadTab, apiChanged: err.apiChanged };
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
  const snapRes = await replay(tab.id, page, 'GET', {}).catch(() => ({ ok: false }));
  pages++;
  const snap = snapRes.ok && extractSnapshot(snapRes.body, Date.now());
  if (snap) added += await serialized(() => applySnapshot(snap, page));

  if (!bills && !snap) {
    return { ok: false, error: t('errNoPoints'), openUrl: MAKERWORLD_POINTS_URL };
  }

  await serialized(() => setMeta({ lastSync: Date.now(), apiChangedAt: null }));
  return { ok: true, added, pages };
}
