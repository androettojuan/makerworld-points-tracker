/**
 * Historial de puntos de MakerWorld: `/api/v1/point-service/point-bill/my`.
 * Devuelve { total, hits: [...] } con un movimiento por item, del más nuevo al
 * más viejo. Cada movimiento separa puntos regulares y exclusivos.
 */
import { toEpochMs, dayKey } from './parse.js';

export const BILL_LIMIT = 100;

export const billUrl = (origin, offset) =>
  `${origin}/api/v1/point-service/point-bill/my?offset=${offset}&limit=${BILL_LIMIT}&filter=all`;

export const isBillUrl = (url) => /\/point-service\/point-bill\//.test(url);

const LABELS = {
  design_reward: 'Recompensa de diseño',
  design_reward_v2: 'Recompensa de diseño',
  instance_reward: 'Recompensa de perfil de impresión',
  instance_reward_v2: 'Recompensa de perfil de impresión',
  upload_model: 'Subida de modelo',
  boost_exchange_point: 'Boost',
  exchange: 'Canje',
  exchange_cash: 'Canje por dinero',
  redeem_product_request: 'Canje de producto',
  operation_cancel_exchange_cash: 'Reintegro de canje',
  academy_course_award: 'Curso de Academy',
  makerlab_first_export: 'Exportación MakerLab',
  complete_personal_info: 'Perfil completo',
};

export function billKind(type) {
  if (type === 'boost_exchange_point') return 'boost';
  if (/^(design_reward|instance_reward|upload_model)/.test(type || '')) return 'design';
  return 'other';
}

function billDetail(t) {
  if (/^design_reward/.test(t.type)) return t.designRewardV2?.title || t.designReward?.title || '';
  if (/^instance_reward/.test(t.type)) {
    const i = t.instanceRewardV2 || t.instanceReward || {};
    return [i.instanceTitle, i.designTitle].filter(Boolean).join(' — ');
  }
  if (t.type === 'boost_exchange_point') {
    const b = t.extInfoBoostExchangePoint || {};
    const who = b.fromUserHandle || b.fromUsername;
    return [b.designTitle, who && `@${who}`].filter(Boolean).join(' · ');
  }
  if (t.type === 'academy_course_award') return t.extInfoAcademyCourseAward?.courseName || '';
  return '';
}

/** Bloque del movimiento que describe el modelo, según el tipo. */
function designInfo(t) {
  if (/^design_reward/.test(t.type)) return t.designRewardV2 || t.designReward || null;
  if (/^instance_reward/.test(t.type)) return t.instanceRewardV2 || t.instanceReward || null;
  if (t.type === 'boost_exchange_point') return t.extInfoBoostExchangePoint || null;
  return null;
}

const present = (...vals) => vals.find((v) => v != null && v !== '') ?? null;
export const titleKey = (title) => `t:${String(title).trim().toLowerCase().replace(/\s+/g, ' ')}`;

/**
 * Publicación a la que corresponde un movimiento crudo del historial, o null.
 * Una publicación tiene varios perfiles de impresión y cada uno genera sus
 * propios movimientos: siempre tomamos los datos de la publicación (`designId`,
 * `designTitle`), nunca los del perfil (`instanceId`, `instanceTitle`).
 *
 * MakerWorld tiene dos ids por publicación: `designId` (el número de la URL
 * /models/<id>) y `modelId` (tipo "USb8af7bcb95daa5", el de las URLs de
 * imágenes). `keys` trae todas las claves que identifican la publicación
 * (`id:`, `m:`, `t:<título>`); `byModel` une los movimientos que compartan alguna
 * y src/cards.js busca con las mismas.
 */
export function billDesign(t) {
  if (!t || typeof t !== 'object') return null;
  const info = designInfo(t);
  if (!info) return null;
  const design = info.design && typeof info.design === 'object' ? info.design : {};
  const designId = present(info.designId, design.id);
  const modelId = present(info.modelId, design.modelId);
  // En design_reward `title` es el de la publicación; en los demás bloques el
  // título suelto puede ser el del perfil, así que solo vale `designTitle`.
  const fallback = /^design_reward/.test(t.type) ? info.title : null;
  const title = String(present(info.designTitle, design.title, fallback) || '').trim();
  const keys = [];
  if (designId != null) keys.push(`id:${designId}`);
  if (modelId != null) keys.push(`m:${modelId}`);
  if (title) keys.push(titleKey(title));
  if (!keys.length) return null;
  return { key: keys[0], keys, title: title || `Modelo ${designId ?? modelId}` };
}

export const looksLikeBills = (body) =>
  Array.isArray(body?.hits) &&
  body.hits.some((t) => t && ('pointChangeRegular' in t || 'pointChangeExclusive' in t));

/** Convierte una página del historial en registros normalizados. */
export function parseBills(body, sourceUrl = '') {
  const out = [];
  for (const t of body?.hits || []) {
    const ts = toEpochMs(t.createTime);
    if (ts == null) continue;
    const amount = Math.round(((t.pointChangeRegular || 0) + (t.pointChangeExclusive || 0)) * 1000) / 1000;
    const base = LABELS[t.type] || t.type || '(sin tipo)';
    const detail = billDetail(t);
    out.push({
      id: `bill:${t.id ?? `${t.type}:${t.createTime}:${amount}:${detail.slice(0, 40)}`}`,
      ts,
      day: dayKey(ts),
      amount,
      kind: billKind(t.type),
      label: detail ? `${base} — ${detail}` : base,
      sourceUrl,
      raw: t,
    });
  }
  return out;
}
