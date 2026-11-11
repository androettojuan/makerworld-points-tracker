/**
 * Ajustes del usuario. Viven en `meta` (chrome.storage.local) junto al resto del
 * estado, así se exportan e importan con el respaldo.
 */

/** Valor de canje por defecto de un punto exclusivo, en dólares. */
export const DEFAULT_USD_RATE = 0.066;

export const usdRateOf = (meta) => {
  const r = Number(meta?.usdRate);
  return r > 0 && r < 10 ? r : DEFAULT_USD_RATE;
};

/** Sincronizar cada 3 horas abriendo MakerWorld de fondo si no está abierto. */
export const autoOpenOf = (meta) => meta?.autoOpen === true;

/** Hace falta sincronizar al abrir el popup si pasó más de esto. */
export const STALE_MS = 60 * 60 * 1000;
