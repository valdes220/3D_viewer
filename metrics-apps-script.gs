/**
 * NOMA 3D Tours — приём статистики в Google Таблицу.
 *
 * Как подключить (5 минут, бесплатно):
 * 1. Создай новую Google Таблицу (любое название, например «NOMA — статистика»).
 * 2. Расширения → Apps Script → удали всё и вставь этот файл целиком.
 * 3. Ниже замени SECRET на свой пароль для отчёта (любая строка, 12+ символов).
 * 4. Развернуть → Новое развёртывание → тип «Веб-приложение»:
 *      «Запуск от имени»: Я;  «Доступ»: Все.
 *    Google попросит разрешения — разреши.
 * 5. Скопируй адрес веб-приложения (заканчивается на /exec).
 * 6. В редакторе NOMA: вкладка «Тур» → «Аналитика» → «Адрес приёма статистики» → вставь адрес.
 * 7. Отчёт: открой stats.html, вставь тот же адрес и пароль SECRET.
 *
 * Данные лежат в листе «events» этой таблицы — это и есть «файл» со статистикой.
 * Любое изменение кода требует нового развёртывания (Развернуть → Управление → Изменить → Новая версия).
 */
const SECRET = 'change-me';
const SHEET_NAME = 'events';
const HEAD = ['ts', 'tour', 'sid', 'vid', 'event', 'params', 'device', 'width', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'version'];

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(HEAD); sh.setFrozenRows(1); }
  return sh;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
// Строки, начинающиеся с = + - @, Таблица считает формулами — экранируем
function safe_(v) { v = String(v == null ? '' : v).slice(0, 500); return /^[=+\-@]/.test(v) ? "'" + v : v; }

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents), b = d.base || {}, ev = d.events || [];
    if (!ev.length || ev.length > 100) return json_({ ok: false });
    const rows = ev.map(function (x) {
      return [safe_(x.ts), safe_(b.tour), safe_(b.sid), safe_(b.vid), safe_(x.ev), safe_(JSON.stringify(x.p || {})),
              safe_(b.dev), safe_(b.w), safe_(b.ref), safe_(b.us), safe_(b.um), safe_(b.uc), safe_(b.v)];
    });
    const lock = LockService.getScriptLock(); lock.waitLock(10000);
    try { const sh = sheet_(); sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEAD.length).setValues(rows); }
    finally { lock.releaseLock(); }
    return json_({ ok: true });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function doGet(e) {
  const a = (e && e.parameter) || {};
  if (a.action === 'summary') {
    if (SECRET === 'change-me' || a.key !== SECRET) return json_({ ok: false, error: 'bad key' });
    const sh = sheet_(), last = sh.getLastRow();
    const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, HEAD.length).getValues();
    return json_({ ok: true, data: summarize_(rows, a.tour || '') });
  }
  return json_({ ok: true, hint: 'NOMA metrics endpoint' });
}

function bump_(o, k) { k = String(k == null || k === '' ? '—' : k); o[k] = (o[k] || 0) + 1; }
function top_(o, n) { return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (x, y) { return y[1] - x[1]; }).slice(0, n); }

function summarize_(rows, tourFilter) {
  const T = {};
  rows.forEach(function (r) {
    const tour = String(r[1] || ''); if (!tour || (tourFilter && tour !== tourFilter)) return;
    const t = T[tour] || (T[tour] = { opened: {}, visitors: {}, started: {}, done: {}, leadOpen: {}, sec: {}, max: {}, ev: {}, pois: {}, pdf: {}, links: {}, dev: {}, ref: {}, src: {}, day: {}, leadCh: {}, leads: 0, errors: 0 });
    const sid = String(r[2]), ev = String(r[4]); let p = {};
    try { p = JSON.parse(r[5] || '{}'); } catch (e) {}
    if (r[3]) t.visitors[String(r[3])] = 1;
    bump_(t.ev, ev);
    if (ev === 'tour_open') {
      t.opened[sid] = 1;
      const d = String(r[0]).slice(0, 10); (t.day[d] = t.day[d] || {})[sid] = 1;
      bump_(t.dev, r[6] || '?'); bump_(t.ref, r[8] || 'прямой заход'); if (r[9]) bump_(t.src, r[9]);
    }
    if (ev === 'tour_start') t.started[sid] = 1;
    if (ev === 'tour_complete') t.done[sid] = 1;
    if (ev === 'lead_open') t.leadOpen[sid] = 1;
    if (ev === 'lead_submit') { t.leads++; bump_(t.leadCh, p.ch); }
    if (ev === 'session_end') { t.sec[sid] = Math.max(t.sec[sid] || 0, +p.sec || 0); t.max[sid] = Math.max(t.max[sid] || 0, +p.max || 0); }
    if (ev === 'stop' || ev === 'poi_open') bump_(t.pois, p.t);
    if (ev === 'pdf_open') bump_(t.pdf, p.t);
    if (ev === 'link_click') bump_(t.links, p.t);
    if (ev === 'lead_error' || ev === 'load_error' || ev === 'ctx_lost') t.errors++;
  });
  const out = {};
  Object.keys(T).forEach(function (k) {
    const t = T[k], secs = Object.keys(t.sec).map(function (s) { return t.sec[s]; }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    const n = function (o) { return Object.keys(o).length; };
    out[k] = {
      opens: n(t.opened), visitors: n(t.visitors),
      avgSec: secs.length ? Math.round(secs.reduce(function (a, b) { return a + b; }, 0) / secs.length) : 0,
      medSec: secs.length ? secs[Math.floor(secs.length / 2)] : 0,
      started: n(t.started), done: n(t.done), completion: n(t.started) ? Math.round(100 * n(t.done) / n(t.started)) : 0,
      leadOpen: n(t.leadOpen), leads: t.leads, leadCh: top_(t.leadCh, 6),
      pdfTotal: Object.keys(t.pdf).reduce(function (a, b) { return a + t.pdf[b]; }, 0), pdf: top_(t.pdf, 8),
      links: top_(t.links, 8), pois: top_(t.pois, 10), dev: top_(t.dev, 4), ref: top_(t.ref, 8), src: top_(t.src, 8),
      days: Object.keys(t.day).sort().slice(-30).map(function (d) { return [d, n(t.day[d])]; }),
      errors: t.errors
    };
  });
  return out;
}
