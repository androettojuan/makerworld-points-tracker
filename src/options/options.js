import { t, LOCALE, localize } from '../lib/i18n.js';
import { usdRateOf, autoOpenOf } from '../lib/settings.js';
import { isPenalty } from '../lib/aggregate.js';

const $ = (s) => document.querySelector(s);
let state = { records: {}, endpoints: {}, meta: {} };

async function load() {
  state = await chrome.runtime.sendMessage({ type: 'get-state' });
  renderEndpoints();
  renderCheck();
  renderKinds();
  renderRaw();
}

function renderEndpoints() {
  const rows = Object.values(state.endpoints || {}).sort((a, b) => b.yields - a.yields);
  $('#endpoints').querySelector('tbody').innerHTML = rows.length
    ? rows.map((e) => `<tr>
        <td><code>${escapeHtml(e.key)}</code>${e.sample ? `<details><summary>${t('viewResponse')}</summary><pre>${escapeHtml(e.sample)}</pre></details>` : ''}</td>
        <td class="num">${e.yields}</td>
        <td class="num">${e.hits}</td>
        <td>${new Date(e.lastSeen).toLocaleString(LOCALE, { hourCycle: 'h23' })}</td>
      </tr>`).join('')
    : `<tr><td colspan="4">${t('nothingCaptured')}</td></tr>`;
}

const num = (n) => (Math.round(n * 100) / 100).toLocaleString(LOCALE);

/** Exclusivos y regulares de un registro (el historial los trae separados). */
const pointsOf = (r) => ('pointChangeExclusive' in (r.raw || {}) || 'pointChangeRegular' in (r.raw || {}))
  ? { excl: Number(r.raw.pointChangeExclusive) || 0, reg: Number(r.raw.pointChangeRegular) || 0 }
  : { excl: r.amount, reg: 0 };

function renderCheck() {
  let excl = 0, reg = 0;
  for (const r of Object.values(state.records)) {
    const p = pointsOf(r);
    excl += p.excl;
    reg += p.reg;
  }
  const snap = state.meta?.snapshot;
  const diff = (a, b) => (b == null ? '–' : Math.abs(a - b) < 0.01 ? t('matches') : num(a - b));
  $('#check').querySelector('tbody').innerHTML = `
    <tr><td>${t('historySum')}</td><td class="num">${num(excl)}</td><td class="num">${num(reg)}</td></tr>
    <tr><td>${t('mwBalance')}</td><td class="num">${snap?.exclusive != null ? num(snap.exclusive) : t('syncFirst')}</td><td class="num">${snap?.regular != null ? num(snap.regular) : '–'}</td></tr>
    <tr><td>${t('difference')}</td><td class="num">${diff(excl, snap?.exclusive)}</td><td class="num">${diff(reg, snap?.regular)}</td></tr>`;
}

/** Agrupa por tipo de movimiento para ver de un vistazo si la clasificación acierta. */
function renderKinds() {
  const groups = new Map();
  for (const r of Object.values(state.records)) {
    const type = r.raw?.type || r.label;
    const kind = isPenalty(r) ? t('kindPenalty') : r.kind;
    const key = `${type}||${kind}`;
    if (!groups.has(key)) groups.set(key, { type, kind, count: 0, excl: 0, reg: 0 });
    const g = groups.get(key);
    const p = pointsOf(r);
    g.count++;
    g.excl += p.excl;
    g.reg += p.reg;
  }
  const rows = [...groups.values()].sort((a, b) => b.excl - a.excl);
  $('#kinds').querySelector('tbody').innerHTML = rows.length
    ? rows.map((g) => `<tr>
        <td>${escapeHtml(g.type)}</td>
        <td>${g.kind}</td>
        <td class="num">${g.count}</td>
        <td class="num">${num(g.excl)}</td>
        <td class="num">${num(g.reg)}</td>
      </tr>`).join('')
    : `<tr><td colspan="5">${t('noRecords')}</td></tr>`;
}

function renderRaw() {
  const list = Object.values(state.records).sort((a, b) => b.ts - a.ts);
  $('#count').textContent = `(${list.length})`;
  $('#raw').textContent = JSON.stringify(list.slice(0, 20), null, 2);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

$('#export').addEventListener('click', () => {
  const day = new Date().toISOString().slice(0, 10);
  download(`makerworld-points-${day}.json`, JSON.stringify(state, null, 2), 'application/json');
});

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  const status = $('#import-status');
  let data = null;
  try { data = JSON.parse(await file.text()); } catch { /* no es JSON */ }
  const res = data && await chrome.runtime.sendMessage({ type: 'import', payload: data });
  status.textContent = res?.ok ? t('importOk', res.added) : t('importBad');
  if (res?.ok) await load();
});

// --- Ajustes ---------------------------------------------------------------
let savedTimer = 0;
async function saveSettings(payload) {
  await chrome.runtime.sendMessage({ type: 'set-settings', payload });
  $('#saved').textContent = t('saved');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('#saved').textContent = ''; }, 1500);
}

async function loadSettings() {
  // Si el background no responde (por ejemplo, uno viejo tras actualizar), usamos los valores por defecto.
  const s = await chrome.runtime.sendMessage({ type: 'get-settings' }).catch(() => null);
  $('#usd-rate').value = usdRateOf(s);
  $('#auto-open').checked = autoOpenOf(s);
}

$('#usd-rate').addEventListener('change', (ev) => {
  const v = Number(ev.target.value);
  if (v > 0 && v < 10) saveSettings({ usdRate: v });
  else loadSettings(); // valor inválido: volvemos al guardado
});
$('#auto-open').addEventListener('change', (ev) => saveSettings({ autoOpen: ev.target.checked }));

$('#csv').addEventListener('click', () => {
  const rows = Object.values(state.records).sort((a, b) => a.ts - b.ts);
  const head = 'fecha,timestamp,puntos,tipo,etiqueta';
  const body = rows.map((r) =>
    [r.day, new Date(r.ts).toISOString(), r.amount, r.kind, `"${String(r.label).replace(/"/g, '""')}"`].join(',')
  );
  download('makerworld-points.csv', [head, ...body].join('\n'), 'text/csv');
});

$('#reset').addEventListener('click', async () => {
  if (!confirm(t('confirmReset'))) return;
  await chrome.runtime.sendMessage({ type: 'reset' });
  await load();
  await loadSettings();
});

localize();
loadSettings();
load();
