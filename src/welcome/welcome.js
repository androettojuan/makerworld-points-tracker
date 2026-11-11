import { t, LOCALE, localize, openTab, MAKERWORLD_URL } from '../lib/i18n.js';
import { usdRateOf } from '../lib/settings.js';

const $ = (sel) => document.querySelector(sel);

localize();
const showRate = (rate) => { $('#help-usd').innerHTML = t('helpUsd', usdRateOf({ usdRate: rate }).toLocaleString(LOCALE, { maximumFractionDigits: 4 })); };
showRate();
chrome.runtime.sendMessage({ type: 'get-settings' }).then((s) => showRate(s?.usdRate), () => {});

$('#open-mw').addEventListener('click', () => openTab(MAKERWORLD_URL));

$('#sync').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const status = $('#sync-status');
  const fix = $('#sync-fix');
  btn.disabled = true;
  btn.textContent = t('syncing');
  status.className = '';
  status.textContent = '';
  fix.hidden = true;

  const res = await chrome.runtime.sendMessage({ type: 'sync' }).catch(() => null);
  btn.disabled = false;
  btn.textContent = t('syncNow');

  if (res?.ok) {
    status.className = 'ok';
    status.textContent = t('wSyncOk', res.added);
    return;
  }
  status.className = 'err';
  status.textContent = res?.error || t('syncError');
  // Mismo arreglo que ofrece el popup: recargar la pestaña o abrir MakerWorld.
  if (res?.reloadTab) {
    fix.textContent = t('reloadMakerWorld');
    fix.onclick = () => chrome.tabs.reload(res.reloadTab);
    fix.hidden = false;
  } else if (res?.openUrl) {
    fix.textContent = t('openMakerWorld');
    fix.onclick = () => openTab(res.openUrl);
    fix.hidden = false;
  }
});
