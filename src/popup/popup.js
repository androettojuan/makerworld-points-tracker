import { byDay, byModel, byMonth, fillGaps, sumRange, historyTotals } from '../lib/aggregate.js';
import { dayKey } from '../lib/parse.js';
import { t, LOCALE, localize, openTab, openGuide, MAKERWORLD_URL } from '../lib/i18n.js';
import { usdRateOf, STALE_MS } from '../lib/settings.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString(LOCALE);
const dash = (n) => (n ? fmt(n) : '·');

/** Valor de canje de un punto exclusivo, en dólares (configurable en Ajustes). */
let usdRate = usdRateOf(null);
const usd = (points) => `US$ ${(points * usdRate).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Mediodía para que ningún huso horario corra la fecha al día anterior.
const monthFmt = new Intl.DateTimeFormat(LOCALE, { month: 'short', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit' });
const monthName = (ym) => monthFmt.format(new Date(`${ym}-15T12:00:00`)).replace('.', '');
const shortDay = (day) => dayFmt.format(new Date(`${day}T12:00:00`));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let series = [];
let records = {};
let showAllModels = false;
const MODELS_SHOWN = 10;

let meta = {};

async function load() {
  const state = await chrome.runtime.sendMessage({ type: 'get-state' });
  records = state.records || {};
  meta = state.meta || {};
  series = byDay(records);
  usdRate = usdRateOf(meta);
  const rate = usdRate.toLocaleString(LOCALE, { maximumFractionDigits: 4 });
  $('#note').textContent = t('note', rate);
  $('#help-usd').innerHTML = t('helpUsd', rate);
  // Hasta la primera sincronización mostramos los pasos en lugar de tablas vacías.
  const fresh = !meta.lastSync && !Object.keys(records).length;
  $('#start').hidden = !fresh;
  $('#main').hidden = fresh;
  document.body.classList.toggle('has-data', !fresh);
  render(state);
  warnings();
}

/**
 * Avisos que no son de una sincronización puntual: MakerWorld cambió su API, o la
 * suma del historial no cierra con el saldo real (falta algún movimiento).
 */
function warnings() {
  if (meta.apiChangedAt) {
    notice(t('apiChangedNotice'));
    return;
  }
  const snap = meta.snapshot;
  if (!meta.billsSynced || snap?.exclusive == null) return notice('');
  const sum = historyTotals(records).exclusive;
  const diff = Math.round((sum - snap.exclusive) * 100) / 100;
  if (Math.abs(diff) <= 0.5 || diff === meta.ignoredDiff) return notice('');
  notice(t('balanceMismatch', fmt(sum), fmt(snap.exclusive)), [
    { label: t('viewDetail'), run: () => chrome.runtime.openOptionsPage() },
    { label: t('dismiss'), run: async () => {
      await chrome.runtime.sendMessage({ type: 'set-settings', payload: { ignoredDiff: diff } });
      notice('');
    } },
  ], 'warn');
}

function render(state) {
  const now = new Date();
  const today = dayKey(now.getTime());
  const monthStart = `${today.slice(0, 8)}01`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = dayKey(prev.getTime()).slice(0, 7);

  card('today', sumRange(series, today, today));
  card('this-month', sumRange(series, monthStart, today));
  card('last-month', sumRange(series, `${prevMonth}-01`, `${prevMonth}-31`));

  const snap = state.meta?.snapshot;
  // Nunca mostramos el total como si fuera exclusivo: sin el dato, pedimos sincronizar.
  const hasExcl = snap?.exclusive != null;
  $('#balance').textContent = hasExcl ? fmt(snap.exclusive) : '–';
  $('#balance-reg').innerHTML = hasExcl
    ? `<span class="usd">${usd(snap.exclusive)}</span>${snap.regular != null ? t('regShort', fmt(snap.regular)) : ''}`
    : t('syncPrompt');

  renderChart(Number($('#range').value));
  renderModels();
  renderMonths(today.slice(0, 7));
  renderDays();

  const meta = state.meta || {};
  $('#status').textContent = meta.lastSync
    ? t('syncedAt', new Date(meta.lastSync).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }))
    : t('notSynced');
}

/**
 * Lo que salió en un período, debajo de lo ganado: canjes (los pidió el usuario)
 * y penalizaciones (las aplicó MakerWorld), cada uno con su nombre.
 */
const outflows = (x) =>
  (x.spent ? `<span class="spent">${t('redeemed', fmt(x.spent))}</span>` : '') +
  (x.penalty ? `<span class="penalty">${t('penalty', fmt(x.penalty))}</span>` : '');

/** Tarjeta: exclusivos grande, regulares chico debajo y, si hubo, la penalización. */
function card(id, tot) {
  $(`#${id}`).textContent = fmt(tot.total);
  $(`#${id}-reg`).innerHTML = `<span class="usd">${usd(tot.total)}</span>${tot.regular ? `+${t('regShort', fmt(tot.regular))}` : ''}${tot.penalty ? `<span class="penalty">${t('penalty', fmt(tot.penalty))}</span>` : ''}`;
}

/** Barras apiladas en SVG con fechas en el eje: diseños abajo, boosts y otros encima. */
function renderChart(days) {
  const host = $('#chart');
  const data = fillGaps(series, days);
  if (!data.length) {
    host.innerHTML = `<p class="empty">${t('noData')}</p>`;
    return;
  }

  const W = 376, H = 130, top = 4, axis = 16, pad = days > 30 ? 0.5 : 2;
  const plotH = H - axis - top;
  const max = Math.max(...data.map((d) => d.total), 1);
  const bw = W / data.length;
  const scale = (v) => (v / max) * plotH;
  const base = H - axis;

  const bars = data.map((d, i) => {
    const x = i * bw + pad / 2;
    const w = Math.max(bw - pad, 1);
    let y = base;
    const segs = [];
    for (const kind of ['design', 'boost', 'other']) {
      const h = scale(Math.max(d[kind], 0));
      if (h <= 0) continue;
      y -= h;
      segs.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="var(--${kind})" rx="1"></rect>`);
    }
    const tip = t('chartTip', shortDay(d.day), fmt(d.total), fmt(d.design), fmt(d.boost), fmt(d.regular));
    // Rect invisible de toda la columna para que el tooltip funcione aunque la barra sea baja.
    return `<g><title>${tip}</title><rect x="${(i * bw).toFixed(2)}" y="${top}" width="${bw.toFixed(2)}" height="${plotH}" fill="transparent"></rect>${segs.join('')}</g>`;
  }).join('');

  // 5 fechas repartidas a lo largo del eje.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const i = Math.round(f * (data.length - 1));
    const x = i * bw + bw / 2;
    const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle';
    const tx = f === 0 ? i * bw : f === 1 ? W : x;
    return `<text class="axis" x="${tx.toFixed(2)}" y="${H - 3}" text-anchor="${anchor}">${shortDay(data[i].day)}</text>`;
  }).join('');

  const maxLabel = `<text class="axis" x="0" y="${top + 8}">${fmt(max)}</text>`;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('chartTitle'))}">
    <line class="grid" x1="0" x2="${W}" y1="${base}" y2="${base}"></line>${bars}${ticks}${maxLabel}</svg>`;
}

/** Rango de días (YYYY-MM-DD) que eligió el usuario para la tabla por modelo. */
function modelRange(value) {
  const now = new Date();
  const today = dayKey(now.getTime());
  if (value === 'all') return {};
  if (value === 'today') return { from: today, to: today };
  if (value === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  if (value === 'prev') {
    const ym = dayKey(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime()).slice(0, 7);
    return { from: `${ym}-01`, to: `${ym}-31` };
  }
  const d = new Date(now);
  d.setDate(d.getDate() - (Number(value) - 1));
  return { from: dayKey(d.getTime()), to: today };
}

function renderModels() {
  const tbody = $('#models').querySelector('tbody');
  const more = $('#models-more');
  const all = byModel(records, modelRange($('#model-range').value));
  if (!all.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="4">${t('noModelPoints')}</td></tr>`;
    more.hidden = true;
    return;
  }
  const rows = showAllModels ? all : all.slice(0, MODELS_SHOWN);
  tbody.innerHTML = rows.map((m) => {
    const tip = t('modelTip', m.title, fmt(m.design), fmt(m.boost), m.boosts) + (m.regular ? t('modelTipRegular', fmt(m.regular)) : '');
    return `<tr title="${esc(tip)}">
      <td class="model">${esc(m.title)}</td>
      <td class="num design">${dash(m.design)}</td>
      <td class="num boost">${dash(m.boost)}</td>
      <td class="tot">${fmt(m.total)}<span class="usd">${usd(m.total)}</span></td>
    </tr>`;
  }).join('');
  const hidden = all.length - MODELS_SHOWN;
  more.hidden = hidden <= 0;
  more.textContent = showAllModels ? t('showLess') : hidden === 1 ? t('moreOne') : t('moreMany', hidden);
}

function renderMonths(currentMonth) {
  const tbody = $('#months').querySelector('tbody');
  const rows = byMonth(series).slice(0, 12);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="5">${t('noRecords')}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((m) => {
    const current = m.month === currentMonth;
    return `<tr>
      <td class="label${current ? ' current' : ''}">${monthName(m.month)}${current ? `<small>${t('inProgress')}</small>` : ''}</td>
      <td class="num design">${dash(m.design)}</td>
      <td class="num boost">${dash(m.boost)}</td>
      <td class="tot">${fmt(m.total)}<span class="usd">${usd(m.total)}</span>${outflows(m)}</td>
      <td class="num reg">${dash(m.regular)}</td>
    </tr>`;
  }).join('');
}

function renderDays() {
  const tbody = $('#days').querySelector('tbody');
  const rows = [...series].reverse().slice(0, 14);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="5">${t('noRecords')}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((d) => `
    <tr>
      <td class="label">${shortDay(d.day)}</td>
      <td class="num design">${dash(d.design)}</td>
      <td class="num boost">${dash(d.boost)}</td>
      <td class="tot">${fmt(d.total)}<span class="usd">${usd(d.total)}</span>${outflows(d)}</td>
      <td class="num reg">${dash(d.regular)}</td>
    </tr>`).join('');
}

$('#range').addEventListener('change', () => renderChart(Number($('#range').value)));
$('#model-range').addEventListener('change', () => { showAllModels = false; renderModels(); });
$('#models-more').addEventListener('click', () => { showAllModels = !showAllModels; renderModels(); });

/** Aviso arriba del popup, con botones para resolverlo cuando los hay. */
function notice(text, actions = [], tone = 'error') {
  const box = $('#notice');
  box.hidden = !text;
  box.className = `notice ${tone}`;
  $('#notice-text').textContent = text || '';
  const host = $('#notice-actions');
  host.replaceChildren(...actions.map((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    btn.onclick = a.run;
    return btn;
  }));
}

/** El background dice cómo se arregla el error: recargar la pestaña o abrir MakerWorld. */
function fixFor(res) {
  if (res?.reloadTab) return [{ label: t('reloadMakerWorld'), run: () => { chrome.tabs.reload(res.reloadTab); notice(''); } }];
  if (res?.openUrl) return [{ label: t('openMakerWorld'), run: () => openTab(res.openUrl) }];
  return [];
}

/**
 * `auto`: sincronización al abrir el popup. Solo usa una pestaña de MakerWorld ya
 * abierta y, si no hay, no molesta con errores.
 */
async function sync({ auto = false } = {}) {
  const btn = $('#sync');
  btn.disabled = true;
  btn.textContent = t('syncing');
  if (!auto) notice('');
  const res = await chrome.runtime.sendMessage({ type: 'sync', auto }).catch(() => null);
  btn.disabled = false;
  btn.textContent = t('sync');
  if (!res?.ok) {
    if (auto && res?.skipped) return;
    await load();
    notice(res?.error || t('syncError'), fixFor(res));
    return;
  }
  await load();
  $('#status').textContent = t('added', res.added);
}

$('#sync').addEventListener('click', () => sync());

/**
 * Por modelo, por mes y últimos días arrancan cerradas para que el popup sea corto.
 * Lo que el usuario abre queda abierto la próxima vez (solo en este navegador).
 */
const FOLD_KEY = 'mwpt-open-sections';
const openSections = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY)) || []); } catch { return new Set(); }
})();
function setFold(section, open) {
  section.classList.toggle('open', open);
  section.querySelector('.fold-toggle').setAttribute('aria-expanded', String(open));
  // Cerrada sigue en el DOM (para animar), pero sin foco ni lector de pantalla.
  section.querySelector('.fold-body').inert = !open;
}
for (const section of document.querySelectorAll('.fold')) {
  const name = section.dataset.fold;
  setFold(section, openSections.has(name));
  section.querySelector('.fold-toggle').addEventListener('click', () => {
    const open = !section.classList.contains('open');
    setFold(section, open);
    // Al abrir, si la tabla queda por debajo de lo visible, la acompañamos con un scroll suave.
    if (open) {
      section.querySelector('.fold-body').addEventListener('transitionend', () => {
        section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, { once: true });
    }
    open ? openSections.add(name) : openSections.delete(name);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...openSections])); } catch { /* sin almacenamiento: solo esta vez */ }
  });
}

// Recién después del primer cuadro habilitamos las animaciones (ver .preload en popup.css).
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('preload')));

function toggleHelp(show) {
  $('#help').hidden = !show;
  $('#help-btn').setAttribute('aria-expanded', String(show));
}
$('#help-btn').addEventListener('click', () => toggleHelp($('#help').hidden));
$('#help-close').addEventListener('click', () => toggleHelp(false));

$('#start-open').addEventListener('click', () => openTab(MAKERWORLD_URL));
for (const a of document.querySelectorAll('.guide-link')) {
  a.addEventListener('click', (ev) => { ev.preventDefault(); openGuide(); });
}

$('#opts').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

localize();
// Las opciones de días se arman acá para traducir "N días".
for (const opt of document.querySelectorAll('#range option, #model-range option')) {
  if (/^\d+$/.test(opt.value)) opt.textContent = t('daysN', opt.value);
}
load().then(() => {
  // Datos de hace más de una hora: los refrescamos solos si hay MakerWorld abierto.
  if (meta.lastSync && Date.now() - meta.lastSync > STALE_MS) sync({ auto: true });
});
