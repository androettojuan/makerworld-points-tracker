import { byDay, fillGaps, totals, sumLastDays } from '../lib/aggregate.js';
import { dayKey } from '../lib/parse.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('es-AR');

let series = [];

async function load() {
  const state = await chrome.runtime.sendMessage({ type: 'get-state' });
  series = byDay(state.records || {});
  render(state);
}

function render(state) {
  const all = totals(series);
  const today = series.find((d) => d.day === dayKey(Date.now()));

  $('#today').textContent = today ? fmt(today.total) : '0';
  $('#week').textContent = fmt(sumLastDays(series, 7).total);
  $('#month').textContent = fmt(sumLastDays(series, 30).total);
  $('#all').textContent = fmt(all.total);

  renderSplit(all);
  renderChart(Number($('#range').value));
  renderTable();

  const meta = state.meta || {};
  const eps = Object.keys(state.endpoints || {}).length;
  $('#status').textContent = meta.lastSync
    ? `Última sincronización: ${new Date(meta.lastSync).toLocaleString('es-AR')}`
    : eps
      ? `${eps} endpoint(s) detectado(s) — sincronizá`
      : 'Abrí tu historial de puntos en MakerWorld';
}

function renderSplit(t) {
  const bar = $('#split-bar');
  bar.innerHTML = '';
  const sum = t.design + t.boost + t.other;
  for (const kind of ['design', 'boost', 'other']) {
    const el = document.createElement('span');
    el.className = kind;
    el.style.width = sum ? `${(t[kind] / sum) * 100}%` : '0';
    bar.append(el);
  }
  $('#l-design').textContent = fmt(t.design);
  $('#l-boost').textContent = fmt(t.boost);
  $('#l-other').textContent = fmt(t.other);
}

/** Barras apiladas en SVG: diseños abajo, boosts encima, otros arriba. */
function renderChart(days) {
  const host = $('#chart');
  const data = fillGaps(series, days);
  if (!data.length) {
    host.innerHTML = '<p class="empty">Sin datos todavía</p>';
    return;
  }

  const W = 356, H = 110, pad = 2;
  const max = Math.max(...data.map((d) => d.total), 1);
  const bw = W / data.length;
  const scale = (v) => (v / max) * (H - 8);

  const bars = data.map((d, i) => {
    const x = i * bw + pad / 2;
    const w = Math.max(bw - pad, 1);
    let y = H;
    const segs = [];
    for (const kind of ['design', 'boost', 'other']) {
      const h = scale(Math.max(d[kind], 0));
      if (h <= 0) continue;
      y -= h;
      segs.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="var(--${kind})" rx="1"><title>${d.day}\n${kind}: ${fmt(d[kind])}\ntotal: ${fmt(d.total)}</title></rect>`);
    }
    return segs.join('');
  }).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Puntos por día">${bars}</svg>`;
}

function renderTable() {
  const tbody = $('#table').querySelector('tbody');
  const rows = [...series].reverse().slice(0, 14);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="4">Sin registros</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((d) => `
    <tr>
      <td class="day">${d.day}</td>
      <td class="num design">${d.design ? fmt(d.design) : '·'}</td>
      <td class="num boost">${d.boost ? fmt(d.boost) : '·'}</td>
      <td class="tot">${fmt(d.total)}</td>
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
  $('#status').textContent = `+${res.added} registros nuevos (${res.pages} páginas)`;
});

$('#opts').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
