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
        <td><code>${escapeHtml(e.key)}</code>${e.sample ? `<details><summary>Ver respuesta</summary><pre>${escapeHtml(e.sample)}</pre></details>` : ''}</td>
        <td class="num">${e.yields}</td>
        <td class="num">${e.hits}</td>
        <td>${new Date(e.lastSeen).toLocaleString('es-AR', { hourCycle: 'h23' })}</td>
      </tr>`).join('')
    : '<tr><td colspan="4">Nada capturado todavía. Navegá tu historial de puntos en MakerWorld.</td></tr>';
}

const num = (n) => (Math.round(n * 100) / 100).toLocaleString('es-AR');

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
  const diff = (a, b) => (b == null ? '–' : Math.abs(a - b) < 0.01 ? '✔ coincide' : num(a - b));
  $('#check').querySelector('tbody').innerHTML = `
    <tr><td>Suma del historial</td><td class="num">${num(excl)}</td><td class="num">${num(reg)}</td></tr>
    <tr><td>Saldo en MakerWorld</td><td class="num">${snap?.exclusive != null ? num(snap.exclusive) : '– (sincronizá)'}</td><td class="num">${snap?.regular != null ? num(snap.regular) : '–'}</td></tr>
    <tr><td>Diferencia</td><td class="num">${diff(excl, snap?.exclusive)}</td><td class="num">${diff(reg, snap?.regular)}</td></tr>`;
}

/** Agrupa por tipo de movimiento para ver de un vistazo si la clasificación acierta. */
function renderKinds() {
  const groups = new Map();
  for (const r of Object.values(state.records)) {
    const type = r.raw?.type || r.label;
    const key = `${type}||${r.kind}`;
    if (!groups.has(key)) groups.set(key, { type, kind: r.kind, count: 0, excl: 0, reg: 0 });
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
    : '<tr><td colspan="5">Sin registros</td></tr>';
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
  download('makerworld-points.json', JSON.stringify(state, null, 2), 'application/json');
});

$('#csv').addEventListener('click', () => {
  const rows = Object.values(state.records).sort((a, b) => a.ts - b.ts);
  const head = 'fecha,timestamp,puntos,tipo,etiqueta';
  const body = rows.map((r) =>
    [r.day, new Date(r.ts).toISOString(), r.amount, r.kind, `"${String(r.label).replace(/"/g, '""')}"`].join(',')
  );
  download('makerworld-points.csv', [head, ...body].join('\n'), 'text/csv');
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('¿Borrar todos los datos guardados?')) return;
  await chrome.runtime.sendMessage({ type: 'reset' });
  await load();
});

load();
