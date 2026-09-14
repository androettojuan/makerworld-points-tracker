/**
 * Corre en el mundo MAIN de makerworld.com.
 *
 * MakerWorld protege su API con un WAF: una request "a mano" desde fuera del
 * navegador recibe 403. Por eso no hardcodeamos endpoints: envolvemos fetch y
 * XMLHttpRequest, miramos pasar las llamadas reales de la página y nos quedamos
 * con las que huelen a puntos. De cada una guardamos un "perfil" (URL + headers)
 * que luego reutilizamos para paginar el histórico completo.
 */
(() => {
  const CHANNEL = 'MWPT';
  const POINT_URL_RE = /point|credit|reward|income|earning/i;

  const post = (type, payload) => {
    window.postMessage({ __mwpt: true, type, payload }, window.location.origin);
  };

  const toUrl = (input) => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input && input.url;
  };

  /**
   * Miramos todo el JSON propio de MakerWorld (/api/* y /_next/data/*), no solo
   * las URLs que mencionan puntos: el nombre real del endpoint no lo conocemos
   * y el parser ya descarta lo que no tenga forma de registro.
   */
  const isInteresting = (url) => {
    try {
      const u = new URL(url, location.href);
      if (!/(^|\.)makerworld\.com$/.test(u.hostname)) return false;
      if (u.pathname === '/api/csrf') return false;
      return u.pathname.startsWith('/api/') || u.pathname.startsWith('/_next/data/');
    } catch {
      return false;
    }
  };

  /** Headers que vale la pena replicar al re-emitir la request nosotros. */
  const REPLAYABLE = /^(authorization|accept|accept-language|content-type|x-[\w-]+)$/i;

  const pickHeaders = (headers) => {
    const out = {};
    if (!headers) return out;
    const entries = headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
    for (const [k, v] of entries) {
      if (REPLAYABLE.test(k)) out[k] = String(v);
    }
    return out;
  };

  const report = (url, method, headers, body) => {
    let json;
    try {
      json = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return; // no es JSON, no nos sirve
    }
    if (!json || typeof json !== 'object') return;
    const abs = new URL(url, location.href).href;
    post('capture', { url: abs, method, headers, body: json, at: Date.now(), pageUrl: location.href, pointy: POINT_URL_RE.test(abs) || POINT_URL_RE.test(location.pathname) });
  };

  // --- fetch ---------------------------------------------------------------
  const nativeFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const res = await nativeFetch.apply(this, arguments);
    try {
      const url = toUrl(input);
      if (isInteresting(url)) {
        const method = (init.method || (input && input.method) || 'GET').toUpperCase();
        const headers = pickHeaders(init.headers || (input && input.headers));
        res.clone().text().then((t) => report(url, method, headers, t)).catch(() => {});
      }
    } catch {}
    return res;
  };

  // --- XMLHttpRequest ------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  const open = XHR.prototype.open;
  const send = XHR.prototype.send;
  const setHeader = XHR.prototype.setRequestHeader;

  XHR.prototype.open = function (method, url, ...rest) {
    this.__mwpt = { method: String(method).toUpperCase(), url, headers: {} };
    return open.call(this, method, url, ...rest);
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    if (this.__mwpt && REPLAYABLE.test(name)) this.__mwpt.headers[name] = value;
    return setHeader.apply(this, arguments);
  };
  XHR.prototype.send = function (...args) {
    if (this.__mwpt && isInteresting(this.__mwpt.url)) {
      this.addEventListener('load', () => {
        try {
          const { url, method, headers } = this.__mwpt;
          report(url, method, headers, this.responseText);
        } catch {}
      });
    }
    return send.apply(this, args);
  };

  // --- replay: el background nos pide traer más páginas --------------------
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || !msg.__mwpt || msg.type !== 'replay') return;
    const { id, url, method, headers } = msg.payload;
    try {
      const res = await nativeFetch(url, {
        method: method || 'GET',
        headers: headers || {},
        credentials: 'include',
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {
        // Página HTML: nos quedamos con los props de __NEXT_DATA__.
        const m = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (m) try { body = JSON.parse(m[1]).props; } catch {}
      }
      post('replay-result', { id, ok: res.ok, status: res.status, body });
    } catch (err) {
      post('replay-result', { id, ok: false, status: 0, error: String(err) });
    }
  });

  // --- SSR: la primera carga de una página Next.js no hace fetch, trae los
  // datos en __NEXT_DATA__. Lo reportamos con la URL /_next/data equivalente,
  // que devuelve el mismo JSON y sí se puede re-emitir para paginar.
  const reportNextData = () => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return;
    try {
      const data = JSON.parse(el.textContent);
      if (!data.buildId || !data.props) return;
      const path = location.pathname.replace(/\/$/, '') || '/index';
      const url = `${location.origin}/_next/data/${data.buildId}${path}.json${location.search}`;
      post('capture', { url, method: 'GET', headers: {}, body: data.props, at: Date.now(), pageUrl: location.href, pointy: POINT_URL_RE.test(location.href) });
    } catch {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportNextData, { once: true });
  } else {
    reportNextData();
  }

  post('ready', { url: location.href });
  void CHANNEL;
})();
