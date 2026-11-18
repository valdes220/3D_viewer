// NOMA — единый слой нормализации tour.json и безопасной работы с URL.
// Подключается как ES-модуль из index.html. Без зависимостей, работает в браузере и в Node (для тестов).

const ALLOWED_PROTOCOLS = new Set([
  'http:', 'https:', 'tel:', 'mailto:',
  'tg:', 'whatsapp:', 'viber:',
  'blob:', 'data:'
]);

// data: разрешаем только картинки — data:text/html или data:image/svg+xml с скриптом опасны
const DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i;

export function isSafeUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s) return false;
  if (/^data:/i.test(s)) return DATA_IMAGE.test(s);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    let proto;
    try { proto = new URL(s, 'https://noma.local/').protocol; } catch { return false; }
    if (!ALLOWED_PROTOCOLS.has(proto)) return false;
    // data и blob сюда не попадают (обработаны выше) — но на всякий случай
    if (proto === 'data:') return DATA_IMAGE.test(s);
    return true;
  }
  // относительный путь или якорь — считаем безопасным
  return !/^javascript:/i.test(s);
}

/** Безопасный URL для href/src. Пустая строка, если схема запрещена. */
export function safeUrl(u) {
  return isSafeUrl(u) ? String(u).trim() : '';
}

/** Абсолютный URL или data/blob как есть. Некорректный ввод -> '' */
export function resolveAsset(path, base) {
  if (typeof path !== 'string') return '';
  const p = path.trim();
  if (!p) return '';
  if (/^(data|blob):/i.test(p)) return isSafeUrl(p) ? p : '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return safeUrl(p);
  try {
    // base обязателен для относительных путей
    return base ? new URL(p, base).href : p;
  } catch {
    return '';
  }
}

/** Экранирование для CSS url("…") — кавычки и обратные слэши ломают строку. */
export function cssUrl(u) {
  const s = resolveAsset(u) || safeUrl(u);
  if (!s) return '';
  const esc = s.replace(/\\/g, '%5C').replace(/"/g, '%22').replace(/\r?\n/g, '').replace(/\)/g, '%29');
  return `url("${esc}")`;
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');

function isVec(a) {
  return Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(v => typeof v === 'number' && Number.isFinite(v));
}
function vec(a) {
  if (!isVec(a)) return null;
  return [+a[0], +a[1], +a[2]];
}
function cam(c) {
  if (!c || typeof c !== 'object') return null;
  const p = vec(c.p), t = vec(c.t);
  return p && t ? { p, t } : null;
}
function hexColor(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : fallback;
}

function normPhotos(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map(s => (typeof s === 'string' ? safeUrl(s) : '')).filter(Boolean);
}

function normDocs(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue;
    const file = safeUrl(str(d.file, 500));
    if (!file) continue;
    out.push({ file, label: str(d.label, 60) || 'Документ' });
  }
  return out;
}

export function normalizePoi(raw, index, warnings) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const pos = vec(d.pos);
  if (!pos) {
    warnings.push(`Точка #${index + 1} пропущена: некорректные координаты pos`);
    return null;
  }
  const title = str(d.title, 120) || 'Точка';
  const c = cam(d.cam);
  const photos = normPhotos(Array.isArray(d.photos) ? d.photos : d.image ? [d.image] : []);
  const plan = d.plan && typeof d.plan === 'object' && safeUrl(str(d.plan.file, 500))
    ? { file: safeUrl(str(d.plan.file, 500)), label: str(d.plan.label, 60) }
    : { file: '', label: '' };
  const link = d.link && typeof d.link === 'object' && safeUrl(str(d.link.url, 1000))
    ? { label: str(d.link.label, 60), url: safeUrl(str(d.link.url, 1000)) }
    : { label: '', url: '' };
  return {
    stay: num(d.stay) != null ? Math.min(Math.max(num(d.stay), 1), 120) : 8,
    tod: num(d.tod) != null ? num(d.tod) : null,
    anim: Array.isArray(d.anim) && d.anim.length ? d.anim.filter(n => num(n) != null) : null,
    skip: !!d.skip,
    id: str(d.id, 80) || `poi-${index}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    subtitle: str(d.subtitle, 160),
    description: str(d.description, 4000),
    icon: str(d.icon, 8) || '📍',
    color: hexColor(d.color, '#2783DE'),
    photos,
    price: str(d.price, 60),
    area: str(d.area, 60),
    specs: str(d.specs, 2000),
    docs: normDocs(d.docs),
    group: str(d.group, 80),
    plan,
    link,
    pos,
    cam: c
  };
}

function normKeys(list, warnings) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const k = arr[i] || {};
    const p = vec(k.p), t = vec(k.t);
    if (!p || !t) { warnings.push(`Ключ пролёта #${i + 1} пропущен: некорректные p/t`); continue; }
    out.push({
      p, t,
      d: num(k.d) != null ? Math.max(0.1, num(k.d)) : 3,
      tod: num(k.tod) != null ? num(k.tod) : undefined,
      c: typeof k.c === 'string' ? k.c : undefined
    });
  }
  return out;
}

// Кнопки-триггеры анимации: необязательный список, как точки, но без карточки.
function normTriggers(list, warnings) {
  const arr = Array.isArray(list) ? list : [];
  if (list != null && !Array.isArray(list)) warnings.push('triggers: ожидался массив');
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i];
    if (!d || typeof d !== 'object') { warnings.push(`Триггер #${i + 1} пропущен: не объект`); continue; }
    const pos = vec(d.pos);
    if (!pos) { warnings.push(`Триггер #${i + 1} пропущен: некорректные координаты`); continue; }
    const anim = (Array.isArray(d.anim) ? d.anim : (typeof d.anim === 'string' ? [d.anim] : []))
      .filter(x => typeof x === 'string' && x.length && x.length < 120);
    out.push({
      id: str(d.id, 80) || `trig-${i}`,
      pos,
      anim,
      label: str(d.label, 60),
      color: /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : '#8E8E93'
    });
  }
  return out;
}

function normGroups(list, poiIds, warnings) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const g = arr[i];
    if (!g || typeof g !== 'object') { warnings.push(`Группа #${i + 1} пропущена: не объект`); continue; }
    const id = str(g.id, 80).replace(/[^\w\-.]/g, '');
    const title = str(g.title, 80);
    if (!id || !title) { warnings.push(`Группа #${i + 1} пропущена: нужны id и title`); continue; }
    if (seen.has(id)) { warnings.push(`Группа «${id}» повторяется — оставлена первая`); continue; }
    seen.add(id);
    const ids = (Array.isArray(g.pois) ? g.pois : []).filter(x => typeof x === 'string');
    out.push({
      id,
      title,
      cam: cam(g.cam),
      // Необязательная модель зоны: тяжёлую детализацию держим отдельным файлом
      // и подгружаем только при выборе этого корпуса.
      model: safeUrl(str(g.model, 500)),
      pois: ids.filter(x => !poiIds.length || poiIds.includes(x))
    });
  }
  return out;
}

/**
 * Нормализация tour.json. Старые файлы (noma:1 / scene.version:1) читаются как есть,
 * новые поля опциональны. Никогда не бросает исключение на кривых данных.
 * Возвращает объект с тем же набором полей + __warnings.
 */
export function normalizeTour(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  if (!raw || typeof raw !== 'object') warnings.push('tour.json пуст или не является объектом');
  if (src.noma != null && num(src.noma) == null) warnings.push('Поле noma: ожидалось число');

  const sceneIn = src.scene && typeof src.scene === 'object' ? src.scene : {};
  if (src.scene != null && typeof src.scene !== 'object') warnings.push('scene: ожидался объект');

  const rawPois = Array.isArray(sceneIn.pois) ? sceneIn.pois : [];
  const pois = [];
  rawPois.forEach((p, i) => {
    const n = normalizePoi(p, i, warnings);
    if (n) pois.push(n);
  });
  const poiIds = pois.map(p => p.id);

  const slotsIn = Array.isArray(sceneIn.slots) ? sceneIn.slots : [];
  const slots = [0, 1, 2].map(i => cam(slotsIn[i]));

  const view = sceneIn.view && typeof sceneIn.view === 'object' ? { ...sceneIn.view } : null;
  if (view) {
    // числовые поля — только числа
    for (const k of ['tod', 'az', 'cloud', 'snow', 'cloudSpd', 'mist', 'envInt', 'envRot', 'exposure', 'aoInt']) {
      if (k in view && num(view[k]) == null) delete view[k];
    }
  }

  const groups = normGroups(sceneIn.groups, poiIds, warnings);

  const lead = src.lead && typeof src.lead === 'object' ? src.lead : {};
  const analytics = src.analytics && typeof src.analytics === 'object' ? src.analytics : {};

  return {
    noma: 1,
    title: str(src.title, 200),
    subtitle: str(src.subtitle, 300),
    accent: hexColor(src.accent, ''),
    cover: safeUrl(str(src.cover, 500)),
    cta: {
      label: str(src.cta?.label, 60),
      url: safeUrl(str(src.cta?.url, 1000))
    },
    site: {
      label: str(src.site?.label, 60),
      url: safeUrl(str(src.site?.url, 1000))
    },
    lead: {
      label: str(lead.label, 60),
      wa: str(lead.wa, 40),
      tg: str(lead.tg, 200),
      tel: str(lead.tel, 40),
      email: str(lead.email, 200),
      key: str(lead.key, 200)
    },
    legal: {
      operator: str(src.legal?.operator, 200),
      policy: safeUrl(str(src.legal?.policy, 1000))
    },
    analytics: {
      ym: str(analytics.ym, 40),
      hook: safeUrl(str(analytics.hook, 1000)),
      note: analytics.note !== false
    },
    lock: str(src.lock, 128),
    model: str(src.model, 500),
    hdri: safeUrl(str(src.hdri, 500)),
    stages: Array.isArray(src.stages)
      ? src.stages
          .filter(s => s && typeof s === 'object')
          .map(s => ({
            label: str(s.label, 60),
            file: safeUrl(str(s.file, 500)),
            mode: str(s.mode, 20) || 'replace',
            fx: str(s.fx, 20) || 'dust',
            fxPower: str(s.fxPower, 20) || 'calm'
          }))
      : undefined,
    scene: {
      version: num(sceneIn.version) != null ? num(sceneIn.version) : 1,
      model: str(sceneIn.model, 500),
      camera: cam(sceneIn.camera),
      startView: cam(sceneIn.startView),
      keys: normKeys(sceneIn.keys, warnings),
      slots,
      path: sceneIn.path && typeof sceneIn.path === 'object' ? { ...sceneIn.path } : undefined,
      anim: sceneIn.anim && typeof sceneIn.anim === 'object' ? { ...sceneIn.anim } : undefined,
      view: view || undefined,
      pois,
      groups,
      triggers: normTriggers(sceneIn.triggers, warnings)
    },
    groups,
    __warnings: warnings,
    __raw: src
  };
}
