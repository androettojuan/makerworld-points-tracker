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

  const isInteresting = (url) => {
    try {
      const u = new URL(url, location.href);
      if (!/makerworld\.com$/.test(u.hostname)) return false;
      if (!u.pathname.startsWith('/api/')) return false;
      return POINT_URL_RE.test(u.pathname) || POINT_URL_RE.test(u.search);
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
    post('capture', { url, method, headers, body: json, at: Date.now() });
  };

  // --- fetch ---------------------------------------------------------------
  const nativeFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const res = await nativeFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input.url;
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
      try { body = JSON.parse(text); } catch {}
      post('replay-result', { id, ok: res.ok, status: res.status, body });
    } catch (err) {
      post('replay-result', { id, ok: false, status: 0, error: String(err) });
    }
  });

  post('ready', { url: location.href });
  void CHANNEL;
})();
