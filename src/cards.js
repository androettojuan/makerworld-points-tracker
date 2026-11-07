/**
 * Content script (mundo ISOLATED) que agrega, en las tarjetas de modelos de
 * makerworld.com, los puntos exclusivos que lleva generando cada modelo, al lado
 * de likes, descargas e impresiones.
 *
 * Las tarjetas se reconocen por el link `/models/<id>-slug` con el título original
 * en `title=`. El historial de puntos identifica los modelos por id si MakerWorld
 * lo manda o, si no, por título; probamos las dos claves (ver `billDesign`).
 */
(() => {
  const USD_PER_POINT = 0.066;
  const ATTR = 'data-mwpt';
  const MODEL_RE = /\/models\/(\d+)/;

  const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('es-AR');
  const usd = (p) => `US$ ${(p * USD_PER_POINT).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  /** Misma normalización que `billDesign` en src/lib/bills.js. */
  const titleKey = (t) => `t:${String(t || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;

  const MODEL_ID_RE = /\/model\/(US[0-9a-zA-Z]+)\//;

  let models = {};

  /** Primer modelo con puntos que coincida con alguna de las claves. */
  function find(keys) {
    for (const k of keys) if (k && models[k]) return models[k];
    return null;
  }

  /** `modelId` sacado de la URL de la portada (…/model/USxxxx/design/…). */
  function modelIdNear(el) {
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
      const img = el.querySelector?.('img[src*="/model/US"]');
      if (img) return img.getAttribute('src').match(MODEL_ID_RE)?.[1] || null;
    }
    return null;
  }

  function lookup(link, row) {
    const id = link.getAttribute('href').match(MODEL_RE)?.[1];
    const mid = modelIdNear(row);
    return find([id && `id:${id}`, mid && `m:${mid}`, link.title && titleKey(link.title), titleKey(link.textContent)]);
  }

  /**
   * Fila de estadísticas de la tarjeta: el contenedor de los ítems `svg + span`
   * (likes, descargas, impresiones…) más cercano al link del título.
   */
  function statRow(link) {
    let el = link;
    for (let i = 0; i < 6 && el; i++) {
      el = el.parentElement;
      if (!el) return null;
      const items = [...el.querySelectorAll('span')].filter((s) => s.previousElementSibling?.tagName.toLowerCase() === 'svg' && !s.closest(`[${ATTR}]`));
      if (items.length >= 2) return items[items.length - 1].parentElement.parentElement;
    }
    return null;
  }

  const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style="flex:none"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5l1 2.1 2.3.3-1.7 1.6.4 2.3L8 9.7l-2 1.1.4-2.3-1.7-1.6 2.3-.3z" fill="currentColor"/></svg>';

  function badge(m) {
    const el = document.createElement('div');
    el.setAttribute(ATTR, 'badge');
    el.style.cssText = 'display:inline-flex;align-items:center;gap:4px;color:#1f9d55;font-weight:600;white-space:nowrap;cursor:default';
    el.title = [
      `${fmt(m.total)} puntos exclusivos (${usd(m.total)})`,
      `Diseño y perfiles: ${fmt(m.design)}`,
      `Boosts: ${fmt(m.boost)} (${m.boosts})`,
      `Últimos 30 días: ${fmt(m.last30)} (${usd(m.last30)})`,
    ].join('\n');
    el.innerHTML = `${ICON}<span>${fmt(m.total)}</span>`;
    return el;
  }

  /** Pone, cambia o saca el badge de `row`. `before` = insertarlo antes de ese hijo. */
  function place(row, m, before = null) {
    const old = row.querySelector(`[${ATTR}="badge"]`);
    const sig = m ? `${m.total}|${m.last30}` : '';
    if (old && old.dataset.sig === sig) return;
    old?.remove();
    if (!m || m.total <= 0) return;
    const b = badge(m);
    b.dataset.sig = sig;
    row.insertBefore(b, before);
  }

  /**
   * Página de un modelo (/models/<id>): la fila "boosts · descargas · impresiones ·
   * Publicado <fecha>" debajo del botón de abrir en Bambu Studio. La reconocemos
   * por la fecha (independiente del idioma) y ponemos el badge antes de ella.
   */
  function annotateDetail() {
    const id = location.pathname.match(MODEL_RE)?.[1];
    if (!id) return;
    const date = [...document.querySelectorAll('div')].find((d) =>
      d.children.length === 1 && d.firstElementChild.tagName === 'SPAN' &&
      /\d{4}-\d{2}-\d{2}\s*$/.test(d.textContent) && d.parentElement?.querySelector('svg'));
    if (!date) return;
    const keys = [`id:${id}`];
    // __NEXT_DATA__ solo vale si es de este modelo (tras navegar en la SPA queda viejo).
    try {
      const d = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}').props?.pageProps?.design;
      if (d && String(d.id) === id) keys.push(d.modelId && `m:${d.modelId}`, titleKey(d.title), titleKey(d.titleTranslated));
    } catch { /* sin datos de la página */ }
    const h1 = document.querySelector('h1');
    if (h1) keys.push(titleKey(h1.textContent));
    place(date.parentElement, find(keys), date);
  }

  function annotate() {
    for (const link of document.querySelectorAll('a[href*="/models/"][title]')) {
      if (!MODEL_RE.test(link.getAttribute('href'))) continue;
      const row = statRow(link);
      if (row) place(row, lookup(link, row));
    }
    annotateDetail();
  }

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(annotate, 300);
  };

  async function load() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'get-models' });
      models = res?.models || {};
    } catch {
      models = {};
    }
    schedule();
  }

  // MakerWorld es una SPA: las tarjetas aparecen al navegar y al hacer scroll.
  const start = () => {
    new MutationObserver((muts) => {
      if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.hasAttribute?.(ATTR)))) schedule();
    }).observe(document.body, { childList: true, subtree: true });
    load();
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.records) load();
  });
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
