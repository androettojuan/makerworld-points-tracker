/**
 * Content script en el mundo ISOLATED. Es el único que puede hablar con el
 * service worker, así que hace de puente entre el sniffer (mundo MAIN) y el
 * background en ambos sentidos.
 */
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data;
  if (!msg || !msg.__mwpt) return;
  if (msg.type === 'replay') return; // va en el otro sentido
  chrome.runtime.sendMessage({ type: msg.type, payload: msg.payload }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'replay') return;
  window.postMessage({ __mwpt: true, type: 'replay', payload: msg.payload }, window.location.origin);
  sendResponse({ ok: true });
});
