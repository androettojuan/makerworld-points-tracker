const $ = (s) => document.querySelector(s);
let state = { records: {}, endpoints: {}, meta: {} };

async function load() {
  state = await chrome.runtime.sendMessage({ type: 'get-state' });
  renderEndpoints();
  renderKinds();
  renderRaw();
}

function renderEndpoints() {
  const rows = Object.values(state.endpoints || {}).sort((a, b) => b.yields - a.yields);
  $('#endpoints').querySelector('tbody').innerHTML = rows.length
    ? rows.map((e) => `<tr>
        <td><code>${e.key}</code></td>
        <td class="num">${e.yields}</td>
        <td class="num">${e.hits}</td>
        <td>${new Date(e.lastSeen).toLocaleString('es-AR')}</td>
      </tr>`).join('')
    : '<tr><td colspan="4">Nada capturado todavía. Navegá tu historial de puntos en MakerWorld.</td></tr>';
}

/** Agrupa por etiqueta para ver de un vistazo si la heurística acierta. */
function renderKinds() {
  const groups = new Map();
  for (const r of Object.values(state.records)) {
    const key = `${r.label}||${r.kind}`;
    if (!groups.has(key)) groups.set(key, { label: r.label, kind: r.kind, count: 0, sum: 0 });
    const g = groups.get(key);
    g.count++;
    g.sum += r.amount;
  }
  const rows = [...groups.values()].sort((a, b) => b.sum - a.sum);
  $('#kinds').querySelector('tbody').innerHTML = rows.length
    ? rows.map((g) => `<tr>
        <td>${escapeHtml(g.label)}</td>
        <td>${g.kind}</td>
        <td class="num">${g.count}</td>
        <td class="num">${g.sum}</td>
      </tr>`).join('')
    : '<tr><td colspan="4">Sin registros</td></tr>';
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
