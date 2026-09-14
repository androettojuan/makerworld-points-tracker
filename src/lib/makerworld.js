/** Helpers para detectar URLs de MakerWorld en dominios base y subdominios. */
export function isMakerWorldUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'makerworld.com' || host.endsWith('.makerworld.com');
  } catch {
    return false;
  }
}
