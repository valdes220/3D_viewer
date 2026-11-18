// Юнит-тесты src/tour-io.js — запускаются без браузера: python3 -m http.server не нужен.
// node tests/tour-io.test.mjs
import { normalizeTour, normalizePoi, safeUrl, resolveAsset, cssUrl, isSafeUrl } from '../src/tour-io.js';

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, '\n        получено:', JSON.stringify(a), '\n        ожидалось:', JSON.stringify(b)); }
};
const truthy = (name, v) => eq(name, !!v, true);
const falsy = (name, v) => eq(name, !!v, false);

console.log('\n# Безопасные URL');
truthy('https', isSafeUrl('https://example.com/a.pdf'));
truthy('относительный путь', isSafeUrl('plan.pdf'));
truthy('tel', isSafeUrl('tel:+79001234567'));
truthy('data:image/png', isSafeUrl('data:image/png;base64,iVBORw0KGgo='));
falsy('javascript:', isSafeUrl('javascript:alert(1)'));
falsy('JaVaScRiPt с пробелом', isSafeUrl('  javascript:alert(1)'));
falsy('data:text/html', isSafeUrl('data:text/html,<script>alert(1)</script>'));
falsy('vbscript', isSafeUrl('vbscript:msgbox(1)'));
falsy('пустая строка', isSafeUrl(''));
falsy('не строка', isSafeUrl(null));
eq('safeUrl режет javascript', safeUrl('javascript:alert(1)'), '');
eq('safeUrl пропускает https', safeUrl('https://a.b/c'), 'https://a.b/c');

console.log('\n# resolveAsset');
const base = 'https://site.ru/tours/house/';
eq('относительный', resolveAsset('photos/1.jpg', base), 'https://site.ru/tours/house/photos/1.jpg');
eq('абсолютный https', resolveAsset('https://cdn.ru/x.jpg', base), 'https://cdn.ru/x.jpg');
eq('data:image', resolveAsset('data:image/jpeg;base64,AAAA', base), 'data:image/jpeg;base64,AAAA');
eq('javascript отклонён', resolveAsset('javascript:alert(1)', base), '');
eq('пусто', resolveAsset('', base), '');
eq('без base относительный остаётся относительным', resolveAsset('a.png', ''), 'a.png');

console.log('\n# cssUrl');
eq('кавычка экранируется', cssUrl('https://a.b/x"y.png'), 'url("https://a.b/x%22y.png")');
eq('опасная схема -> пусто', cssUrl('javascript:alert(1)'), '');

console.log('\n# normalizePoi');
{
  const w = [];
  const p = normalizePoi({ title: 'A', pos: [1, 2, 3] }, 0, w);
  eq('дефолты', [p.stay, p.icon, p.color, p.photos.length, p.docs.length], [8, '📍', '#2783DE', 0, 0]);
  eq('нет предупреждений', w.length, 0);
}
{
  const w = [];
  eq('без pos -> null', normalizePoi({ title: 'X' }, 0, w), null);
  truthy('есть предупреждение', w.length);
}
{
  const w = [];
  eq('pos из строк -> null', normalizePoi({ pos: ['1', '2', '3'] }, 0, w), null);
  eq('pos из 2 чисел -> null', normalizePoi({ pos: [1, 2] }, 0, w), null);
  eq('pos с NaN -> null', normalizePoi({ pos: [1, 2, NaN] }, 0, w), null);
}
{
  const w = [];
  const p = normalizePoi({ pos: [0, 0, 0], photos: ['a.png', 'javascript:alert(1)', 'https://x/y.jpg'] }, 0, w);
  eq('небезопасное фото отброшено', p.photos.length, 2);
  eq('порядок сохранён', p.photos[0], 'a.png');
}
{
  const w = [];
  const p = normalizePoi({ pos: [0, 0, 0], image: 'one.jpg' }, 0, w);
  eq('старое поле image -> photos', p.photos, ['one.jpg']);
  eq('stay клампится', normalizePoi({ pos: [0,0,0], stay: 999 }, 0, w).stay, 120);
}
{
  const w = [];
  const p = normalizePoi({ pos: [0, 0, 0], link: { url: 'javascript:alert(1)', label: 'x' } }, 0, w);
  eq('опасная ссылка вырезана', p.link.url, '');
}

console.log('\n# normalizeTour: обратная совместимость');
{
  const old = {
    noma: 1, title: 'Старый тур', subtitle: 'подзаголовок', accent: '#123456',
    model: 'scene.glb', cover: 'cover.png',
    scene: {
      version: 1, model: 'scene.glb',
      camera: { p: [1, 2, 3], t: [0, 0, 0] },
      keys: [], slots: [null, null, null],
      path: { sync: true, loop: false, todKeys: true, ease: 'smooth' },
      pois: [{ id: 'a', title: 'Точка', pos: [1, 1, 1], cam: { p: [2, 2, 2], t: [1, 1, 1] }, photos: [] }],
      view: { light: 'sun', tod: 12, exposure: 0.7 }
    }
  };
  const t = normalizeTour(old);
  eq('нет предупреждений', t.__warnings, []);
  eq('noma сохранён', t.noma, 1);
  eq('модель', t.model, 'scene.glb');
  eq('версия сцены', t.scene.version, 1);
  eq('точек', t.scene.pois.length, 1);
  eq('камера сцены', t.scene.camera, { p: [1, 2, 3], t: [0, 0, 0] });
  eq('слотов три', t.scene.slots.length, 3);
  eq('слот null остаётся null', t.scene.slots[0], null);
  eq('path сохранён', t.scene.path.ease, 'smooth');
  eq('view сохранён', t.scene.view.tod, 12);
  eq('групп нет', t.groups, []);
}

console.log('\n# normalizeTour: битые данные не роняют тур');
{
  const bad = {
    noma: 1, model: 'scene.glb',
    scene: {
      version: 1,
      pois: [
        { title: 'Хорошая', pos: [1, 2, 3] },
        { title: 'Без координат' },
        { title: 'Кривые координаты', pos: 'nope' },
        { title: 'Ещё одна', pos: [4, 5, 6] }
      ]
    }
  };
  const t = normalizeTour(bad);
  eq('осталось 2 хороших точки', t.scene.pois.length, 2);
  eq('первая', t.scene.pois[0].title, 'Хорошая');
  eq('предупреждения есть', t.__warnings.length > 0, true);
}
eq('пустой объект не бросает', normalizeTour({}).model, '');
eq('null не бросает', normalizeTour(null).__warnings.length > 0, true);
eq('мусор не бросает', normalizeTour('строка').model, '');
eq('scene не объект', normalizeTour({ scene: 5 }).scene.pois.length, 0);
{
  const t = normalizeTour({ scene: { pois: 'нет' } });
  eq('pois не массив', t.scene.pois.length, 0);
}

console.log('\n# normalizeTour: числа и цвета');
{
  const t = normalizeTour({ accent: 'синий', scene: { view: { tod: 'день', exposure: 1.2 } } });
  eq('битый accent -> пусто', t.accent, '');
  eq('битый tod удалён', 'tod' in (t.scene.view || {}), false);
  eq('нормальный exposure остался', t.scene.view.exposure, 1.2);
}

console.log('\n# normalizeTour: группы (новое, опционально)');
{
  const t = normalizeTour({
    scene: {
      pois: [{ id: 'p1', pos: [0, 0, 0] }, { id: 'p2', pos: [1, 0, 0] }],
      groups: [
        { id: 'k1', title: 'Корпус 1', cam: { p: [0, 5, 10], t: [0, 0, 0] }, pois: ['p1'] },
        { id: 'k2', title: 'Корпус 2', pois: ['p2', 'нет-такой'] },
        { id: '', title: 'Без id' },
        { id: 'k3' }
      ]
    }
  });
  eq('валидных групп 2', t.groups.length, 2);
  eq('камера группы', t.groups[0].cam.p, [0, 5, 10]);
  eq('несуществующие poi отфильтрованы', t.groups[1].pois, ['p2']);
  eq('битые группы в предупреждениях', t.__warnings.some(w => w.includes('Группа')), true);
}

console.log('\n# normalizeTour: слоты и ключи');
{
  const t = normalizeTour({ scene: { slots: [{ p: [1, 1, 1], t: [0, 0, 0] }, { p: 'битое' }], keys: [{ p: [1, 1, 1], t: [0, 0, 0], d: 4 }, { p: [1, 1, 1] }] } });
  eq('слот 1 прочитан', t.scene.slots[0].p, [1, 1, 1]);
  eq('слот 2 битый -> null', t.scene.slots[1], null);
  eq('ключей 1', t.scene.keys.length, 1);
  eq('длительность ключа', t.scene.keys[0].d, 4);
}

console.log(`\n${fail ? 'ПРОВАЛ' : 'УСПЕХ'}: ${pass} прошло, ${fail} не прошло`);
process.exit(fail ? 1 : 0);
