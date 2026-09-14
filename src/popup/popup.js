import { byDay, byMonth, fillGaps, sumRange } from '../lib/aggregate.js';
import { dayKey } from '../lib/parse.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('es-AR');
const dash = (n) => (n ? fmt(n) : '·');

/** Valor de canje de un punto exclusivo, en dólares. */
const USD_PER_POINT = 0.066;
const usd = (points) => `US$ ${(points * USD_PER_POINT).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const shortDay = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

let series = [];

async function load() {
  const state = await chrome.runtime.sendMessage({ type: 'get-state' });
  series = byDay(state.records || {});
  render(state);
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
    ? `<span class="usd">${usd(snap.exclusive)}</span>${snap.regular != null ? `${fmt(snap.regular)} reg.` : ''}`
    : 'Sincronizá';

  renderChart(Number($('#range').value));
  renderMonths(today.slice(0, 7));
  renderDays();

  const meta = state.meta || {};
  $('#status').textContent = meta.lastSync
    ? `Sincronizado: ${new Date(meta.lastSync).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}`
    : 'Abrí makerworld.com y tocá Sincronizar';
}

/** Tarjeta: exclusivos grande, regulares chico debajo. */
function card(id, t) {
  $(`#${id}`).textContent = fmt(t.total);
  $(`#${id}-reg`).innerHTML = `<span class="usd">${usd(t.total)}</span>${t.regular ? `+${fmt(t.regular)} reg.` : ''}`;
}

/** Barras apiladas en SVG con fechas en el eje: diseños abajo, boosts y otros encima. */
function renderChart(days) {
  const host = $('#chart');
  const data = fillGaps(series, days);
  if (!data.length) {
    host.innerHTML = '<p class="empty">Sin datos todavía</p>';
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
    const tip = `${shortDay(d.day)}: ${fmt(d.total)} exclusivos (diseños ${fmt(d.design)} · boosts ${fmt(d.boost)}) · ${fmt(d.regular)} regulares`;
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
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Puntos exclusivos ganados por día">
    <line class="grid" x1="0" x2="${W}" y1="${base}" y2="${base}"></line>${bars}${ticks}${maxLabel}</svg>`;
}

function renderMonths(currentMonth) {
  const tbody = $('#months').querySelector('tbody');
  const rows = byMonth(series).slice(0, 12);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="5">Sin registros</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((m) => {
    const current = m.month === currentMonth;
    return `<tr>
      <td class="label${current ? ' current' : ''}">${monthName(m.month)}${current ? ' (en curso)' : ''}</td>
      <td class="num design">${dash(m.design)}</td>
      <td class="num boost">${dash(m.boost)}</td>
      <td class="tot">${fmt(m.total)}<span class="usd">${usd(m.total)}</span>${m.spent ? `<span class="spent">canje −${fmt(m.spent)}</span>` : ''}</td>
      <td class="num reg">${dash(m.regular)}</td>
    </tr>`;
  }).join('');
}

function renderDays() {
  const tbody = $('#days').querySelector('tbody');
  const rows = [...series].reverse().slice(0, 14);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="5">Sin registros</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((d) => `
    <tr>
      <td class="label">${shortDay(d.day)}</td>
      <td class="num design">${dash(d.design)}</td>
      <td class="num boost">${dash(d.boost)}</td>
      <td class="tot">${fmt(d.total)}<span class="usd">${usd(d.total)}</span>${d.spent ? `<span class="spent">canje −${fmt(d.spent)}</span>` : ''}</td>
      <td class="num reg">${dash(d.regular)}</td>
    </tr>`).join('');
}

$('#range').addEventListener('change', () => renderChart(Number($('#range').value)));

$('#sync').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Sincronizando…';
  const res = await chrome.runtime.sendMessage({ type: 'sync' });
  btn.disabled = false;
  btn.textContent = 'Sincronizar';
  if (!res?.ok) {
    $('#status').textContent = res?.error || 'Error al sincronizar';
    return;
  }
  await load();
  $('#status').textContent = `+${res.added} movimientos nuevos`;
});

$('#opts').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
