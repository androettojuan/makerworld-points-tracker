/**
 * Textos traducidos (_locales/<idioma>/messages.json). Chrome elige el idioma del
 * navegador y cae a inglés si no hay traducción.
 */
export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

const ui = chrome.i18n.getUILanguage?.() || 'en';
const nav = globalThis.navigator?.language || '';
/**
 * Locale para números y fechas. En castellano, siempre es-AR (1.234,5): Chrome
 * suele reportar regiones como «es-419», «es-US» o «es-MX» que formatean 1,234.5
 * aunque el usuario espere la coma decimal. En otros idiomas, la región del
 * navegador si coincide con el idioma de la interfaz.
 */
export const LOCALE = ui.startsWith('es')
  ? 'es-AR'
  : (nav.slice(0, 2) === ui.slice(0, 2) && nav.includes('-') ? nav : ui);

/**
 * Traduce el HTML estático:
 * data-i18n → texto, data-i18n-html → HTML (solo <strong>/<em> de nuestros
 * propios mensajes), data-i18n-title → title, data-i18n-aria → aria-label.
 */
export function localize(root = document) {
  document.documentElement.lang = t('htmlLang');
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

export const MAKERWORLD_URL = 'https://makerworld.com/';
export const MAKERWORLD_POINTS_URL = 'https://makerworld.com/points';

/** Abre una URL en una pestaña nueva (sirve desde el popup y desde páginas de la extensión). */
export const openTab = (url) => chrome.tabs.create({ url });
export const openGuide = () => openTab(chrome.runtime.getURL('src/welcome/welcome.html'));
