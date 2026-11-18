#!/usr/bin/env node
/**
 * NOMA — анализатор GLB. Показывает, из чего складывается вес сцены:
 * геометрия против текстур, число уникальных мешей, потенциал инстансинга,
 * поддержку сжатия. Нужен, чтобы понять, что оптимизировать в первую очередь.
 *
 * Без зависимостей. Запуск:
 *   node tools/glb-report.mjs путь/к/сцене.glb
 *   node tools/glb-report.mjs tours/room/scene.glb --top 20
 */

import { readFileSync } from 'node:fs';

const COMP = {
  5120: ['BYTE', 1], 5121: ['UNSIGNED_BYTE', 1], 5122: ['SHORT', 2],
  5123: ['UNSIGNED_SHORT', 2], 5125: ['UNSIGNED_INT', 4], 5126: ['FLOAT', 4]
};
const MODE = { 0: 'POINTS', 1: 'LINES', 4: 'TRIANGLES', 5: 'TRIANGLE_STRIP', 6: 'TRIANGLE_FAN' };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '0%';

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('Это не GLB (нет магии glTF)');
  const version = buf.readUInt32LE(4), total = buf.readUInt32LE(8);
  let off = 12, json = null, binLen = 0;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004E4942) binLen = len;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, version, total, binLen, fileSize: buf.length };
}

const args = process.argv.slice(2);
const path = args.find(a => !a.startsWith('--'));
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 ? +(args[topIdx + 1] || 15) : 15;

if (!path) {
  console.error('Укажите путь к .glb\n  node tools/glb-report.mjs scene.glb');
  process.exit(1);
}

const { json: g, version, fileSize, binLen } = readGlb(path);
const bufferViews = g.bufferViews || [];
const accessors = g.accessors || [];

// ---------- размеры частей ----------
let geomBytes = 0, indexBytes = 0, attrBytes = 0, imageBytes = 0, animBytes = 0, otherBytes = 0;

// Драко-примитив: геометрия лежит внутри extension, а не в обычных accessor'ах
let dracoPrims = 0, dracoBytes = 0;
for (const m of g.meshes || []) for (const p of m.primitives || []) {
  const d = p.extensions?.KHR_draco_mesh_compression;
  if (d) {
    dracoPrims++;
    dracoBytes += bufferViews[d.bufferView]?.byteLength || 0;
  }
}

for (const bv of bufferViews) {
  const n = bv.byteLength || 0;
  const isDraco = (() => {
    for (const m of g.meshes || []) for (const p of m.primitives || []) {
      const d = p.extensions?.KHR_draco_mesh_compression;
      if (d && d.bufferView === bufferViews.indexOf(bv)) return true;
    }
    return false;
  })();
  if (isDraco) { geomBytes += n; continue; }
  if (bv.target === 34963) indexBytes += n;
  else if (bv.target === 34962) attrBytes += n;
}
for (const img of g.images || []) {
  if (img.bufferView != null) imageBytes += bufferViews[img.bufferView]?.byteLength || 0;
}
for (const a of g.animations || []) {
  for (const s of a.samplers || []) {
    animBytes += accessors[s.input]?.byteLength || 0;
    animBytes += accessors[s.output]?.byteLength || 0;
  }
}
const usedViews = new Set();
const dracoViews = new Set();
const noteView = i => { if (i != null) usedViews.add(i); };
for (const m of g.meshes || []) for (const p of m.primitives || []) {
  const d = p.extensions?.KHR_draco_mesh_compression;
  if (d && d.bufferView != null) { dracoViews.add(d.bufferView); usedViews.add(d.bufferView); }
}
for (const m of g.meshes || []) for (const p of m.primitives || []) {
  if (p.indices != null) noteView(accessors[p.indices]?.bufferView);
  for (const k in p.attributes || {}) noteView(accessors[p.attributes[k]]?.bufferView);
}
for (const img of g.images || []) noteView(img.bufferView);
for (const a of g.animations || []) for (const s of a.samplers || []) {
  noteView(accessors[s.input]?.bufferView); noteView(accessors[s.output]?.bufferView);
}
bufferViews.forEach((bv, i) => { if (!usedViews.has(i) && !dracoViews.has(i)) otherBytes += bv.byteLength || 0; });
geomBytes = geomBytes || (attrBytes + indexBytes);

// ---------- треугольники и меши ----------
let tris = 0, prims = 0, verts = 0, instanced = 0, drawCalls = 0;
const byMaterial = new Map();
const meshFingerprint = new Map();

for (const mesh of g.meshes || []) {
  for (const p of mesh.primitives || []) {
    prims++;
    const mode = p.mode == null ? 4 : p.mode;
    if (mode !== 4) continue;
    const posAcc = accessors[p.attributes?.POSITION];
    const idxAcc = p.indices != null ? accessors[p.indices] : null;
    const count = idxAcc ? idxAcc.count / 3 : (posAcc ? posAcc.count / 3 : 0);
    tris += count;
    if (posAcc) verts += posAcc.count;
    const matName = p.material != null ? (g.materials?.[p.material]?.name || 'material_' + p.material) : '(без материала)';
    byMaterial.set(matName, (byMaterial.get(matName) || 0) + count);
    // отпечаток для поиска дублей геометрии
    const key = `${p.attributes?.POSITION}:${p.indices}:${p.material}`;
    meshFingerprint.set(key, (meshFingerprint.get(key) || 0) + 1);
  }
}

// ---------- инстансы: узлы, ссылающиеся на один и тот же меш ----------
const meshUse = new Map();
for (const node of g.nodes || []) {
  if (node.mesh == null) continue;
  meshUse.set(node.mesh, (meshUse.get(node.mesh) || 0) + 1);
}
let instanceable = 0;
for (const [m, n] of meshUse) {
  if (n > 1) { instanced++; instanceable += n - 1; }
}
drawCalls = [...meshUse.values()].reduce((a, b) => a + b, 0) || prims;

// ---------- сжатие ----------
const extUsed = g.extensionsUsed || [];
const extReq = g.extensionsRequired || [];
const has = n => extUsed.includes(n);

// ---------- текстуры ----------
const imgs = (g.images || []).map((im, i) => {
  const size = im.bufferView != null ? (bufferViews[im.bufferView]?.byteLength || 0) : 0;
  const mime = im.mimeType || '(внешний файл)';
  let wh = '';
  if (im.bufferView != null) {
    const bv = bufferViews[im.bufferView];
    // ищем SOF-маркер в JPEG или IHDR в PNG
    const chunk = readFileSync(path).subarray(0, 0); // не читаем повторно ради экономии
    wh = '';
  }
  return { i, name: im.name || '', mime, size };
}).sort((a, b) => b.size - a.size);

// ---------- вывод ----------
const L = [];
L.push('');
L.push('╔══════════════════════════════════════════════════════════════');
L.push('║  NOMA — отчёт по GLB');
L.push('╚══════════════════════════════════════════════════════════════');
L.push('');
L.push(`Файл:          ${path}`);
L.push(`Размер:        ${kb(fileSize)}  (glTF v${version})`);
L.push(`Бинарный блок: ${kb(binLen)}`);
L.push('');
L.push('── ГЕОМЕТРИЯ ────────────────────────────────────────────────');
L.push(`Треугольников:      ${tris.toLocaleString('ru-RU')}`);
L.push(`Вершин:             ${verts.toLocaleString('ru-RU')}`);
L.push(`Примитивов:         ${prims.toLocaleString('ru-RU')}`);
L.push(`Узлов:              ${(g.nodes || []).length.toLocaleString('ru-RU')}`);
L.push(`Мешей уникальных:   ${(g.meshes || []).length.toLocaleString('ru-RU')}`);
L.push(`Материалов:         ${(g.materials || []).length.toLocaleString('ru-RU')}`);
L.push(`Draw call (узлов):  ${drawCalls.toLocaleString('ru-RU')}`);
L.push('');
L.push('── ВЕС ПО ЧАСТЯМ ────────────────────────────────────────────');
const known = geomBytes + imageBytes + animBytes + otherBytes;
const row = (name, bytes) => L.push(`${name.padEnd(22)} ${kb(bytes).padStart(10)}   ${pct(bytes, known).padStart(6)}`);
if (dracoBytes) row('Геометрия (Draco)', dracoBytes);
row('Геометрия (атриб.)', attrBytes);
row('Индексы', indexBytes);
row('Текстуры (внутри)', imageBytes);
row('Анимации', animBytes);
row('Прочее/не размечено', otherBytes);
L.push('');
L.push('── СЖАТИЕ ───────────────────────────────────────────────────');
L.push(`Draco:              ${(has('KHR_draco_mesh_compression') || dracoPrims) ? `ДА (${dracoPrims} примитивов)` : 'нет'}`);
L.push(`Meshopt:            ${has('EXT_meshopt_compression') ? 'ДА' : 'нет'}`);
L.push(`KTX2 (Basis):       ${has('KHR_texture_basisu') ? 'ДА' : 'нет'}`);
L.push(`WebP текстуры:      ${has('EXT_texture_webp') ? 'ДА' : 'нет'}`);
L.push(`GPU-инстансинг:     ${has('EXT_mesh_gpu_instancing') ? 'ДА' : 'нет'}`);
L.push(`Свет в модели:      ${has('KHR_lights_punctual') ? 'ДА' : 'нет'}`);
if (extReq.length) L.push(`Обязательные:       ${extReq.join(', ')}`);
L.push('');
L.push('── ИНСТАНСИНГ ───────────────────────────────────────────────');
L.push(`Мешей используется >1 раза: ${instanced}`);
L.push(`Лишних узлов можно схлопнуть: ${instanceable.toLocaleString('ru-RU')}`);
L.push(`Потенциал draw call:  ${drawCalls} → ${drawCalls - instanceable}`);
L.push('');

if (imgs.length) {
  L.push(`── ТЕКСТУРЫ (топ ${Math.min(TOP, imgs.length)}) ───────────────────────────`);
  for (const im of imgs.slice(0, TOP)) {
    L.push(`  ${kb(im.size).padStart(9)}  ${im.mime.padEnd(12)} ${im.name || 'изображение #' + im.i}`);
  }
  L.push('');
}

const mats = [...byMaterial.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
if (mats.length) {
  L.push(`── ТРЕУГОЛЬНИКИ ПО МАТЕРИАЛАМ (топ ${mats.length}) ──────────────`);
  for (const [name, n] of mats) {
    L.push(`  ${n.toLocaleString('ru-RU').padStart(12)}  ${pct(n, tris).padStart(6)}  ${name}`);
  }
  L.push('');
}

// ---------- вердикт ----------
const verdicts = [];
const mobile = [];
const bytesPerTri = tris ? geomBytes / tris : 0;

if (tris > 2_000_000) verdicts.push(`Геометрия ${(tris/1e6).toFixed(1)} млн треугольников — для смартфона это много. Цель: ≤ 500 тыс. на сцену, ≤ 150 тыс. на кадр.`);
if (tris > 500_000 && tris <= 2_000_000) mobile.push(`${(tris/1e6).toFixed(2)} млн треугольников — потянет на флагмане, на среднем телефоне будет тяжело.`);
if (imageBytes > 300 * 1048576) verdicts.push(`Текстуры занимают ${kb(imageBytes)} — это главный вес. Перевести в KTX2 (Basis) и понизить разрешение: даст в 4–10 раз меньше.`);
if (imageBytes > 100 * 1048576 && imageBytes <= 300 * 1048576) mobile.push(`Текстуры ${kb(imageBytes)} — нужен KTX2 и ревизия разрешений.`);
if (bytesPerTri > 200) verdicts.push(`На треугольник приходится ${bytesPerTri.toFixed(0)} байт геометрии — многовато. Обычно значит: несжатые нормали/UV лишних каналов или дубли вершин из-за разбиения по материалам.`);
if (drawCalls > 1500) verdicts.push(`${drawCalls} draw call — телефон упрётся в CPU. Нужен инстансинг повторяющихся объектов (деревья, скамейки, урны, светильники) и слияние статики.`);
if (instanceable > 100) mobile.push(`Найдено ${instanceable} дублирующихся узлов — инстансинг даст ощутимый выигрыш.`);
if (!has('KHR_draco_mesh_compression') && !has('EXT_meshopt_compression')) verdicts.push('Геометрия не сжата. Meshopt уменьшит файл в 2–5 раз без потери качества.');
if (!has('KHR_texture_basisu') && imageBytes > 50 * 1048576) verdicts.push('Текстуры не в KTX2. В браузере они распаковываются в память GPU целиком — на телефоне это главная причина падения.');
if (fileSize > 100 * 1048576) verdicts.push(`Файл ${kb(fileSize)} грузится целиком в память. Нужна разбивка на зоны (см. docs/optimization.md).`);
if (!verdicts.length && !mobile.length) verdicts.push('Ничего критичного не найдено по формальным признакам.');

L.push('── ВЕРДИКТ ──────────────────────────────────────────────────');
for (const v of verdicts) L.push('  ⚠  ' + v);
for (const v of mobile) L.push('  •  ' + v);
if (bytesPerTri > 0) L.push(`\n  Байт геометрии на треугольник: ${bytesPerTri.toFixed(1)}`);
L.push('');

console.log(L.join('\n'));
