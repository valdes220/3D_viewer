"""Тесты: высота выхода из пешехода + кнопки анимации (триггеры)."""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8765'
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
res = []

def ok(name, cond, detail=''):
    res.append((bool(cond), name, detail))
    print(('  ok   ' if cond else '  FAIL ') + name + (('  — ' + json.dumps(detail, ensure_ascii=False)[:250]) if detail and not cond else ''))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)

        # ============ 1. Высота выхода из пешехода ============
        print('\n# Пешеход → Орбита: камера на ~3 м над полом')
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        await pg.goto(BASE + '/?tour=room')
        await pg.wait_for_function("window.__nomaDebug?.ready === true", timeout=90000)
        await pg.evaluate("() => document.getElementById('spFree')?.click()")
        await pg.wait_for_timeout(900)

        await pg.evaluate("() => document.getElementById('fpBtn').click()")
        await pg.wait_for_timeout(2400)
        # уровень пола берём у самого пешехода — это и есть «земля под ногами»
        feet = await pg.evaluate("() => window.__nomaDebug.fp().feet")
        await pg.evaluate("() => document.getElementById('fpBtn').click()")
        await pg.wait_for_timeout(1200)

        out = await pg.evaluate("""(feet) => {
            const d = window.__nomaDebug;
            const dir = d.camera.position.clone().sub(d.controls.target);
            return {
                camY: +d.camera.position.y.toFixed(3),
                floorY: +feet.toFixed(3),
                above: +(d.camera.position.y - feet).toFixed(3),
                angle: +(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) * 180 / Math.PI).toFixed(1),
                isFP: document.body.classList.contains('fp')
            };
        }""", feet)
        ok('вышли из пешехода', not out['isFP'], out)
        if out['above'] is not None:
            ok('высота над полом 2–5 м', 2.0 <= out['above'] <= 5.0, out)
        ok('угол обзора сверху 20–70°', 20 <= out['angle'] <= 70, out)
        ok('нет ошибок JS', errs == [], errs[:2])
        await pg.close()

        # ============ 2. Триггеры ============
        print('\n# Кнопки анимации: чтение из tour.json')
        pg2 = await b.new_page(viewport={'width': 1280, 'height': 800})
        zerr = []
        pg2.on('pageerror', lambda e: zerr.append(str(e)[:200]))
        glb = open('tours/room/scene.glb', 'rb').read()

        async def tour_route(route):
            await route.fulfill(status=200, content_type='application/json', body=json.dumps({
                'noma': 1, 'title': 'С кнопками', 'model': 'm.glb',
                'scene': {'version': 1, 'model': 'm.glb',
                          'pois': [],
                          'triggers': [
                              {'id': 'door', 'pos': [2.8, 1.3, -1.4], 'anim': ['DoorOpen'], 'label': 'Открыть дверь'},
                              {'id': 'light', 'pos': [-2.9, 1.2, 1.0], 'anim': ['LightOn']},
                              {'pos': 'мусор'},
                              {'id': 'empty'}
                          ]}}))

        async def glb_route(route):
            await route.fulfill(status=200, content_type='model/gltf-binary', body=glb)

        await pg2.route('**/tours/trig/tour.json', tour_route)
        await pg2.route('**/tours/trig/m.glb', glb_route)
        await pg2.goto(BASE + '/?tour=trig')
        await pg2.wait_for_function("window.__nomaDebug?.ready === true", timeout=90000)
        await pg2.wait_for_timeout(1200)

        tr = await pg2.evaluate("""() => ({
            count: window.__nomaDebug.triggers.length,
            labels: window.__nomaDebug.triggers.map(t => t.label),
            anims: window.__nomaDebug.triggers.map(t => t.anim),
            buttons: document.querySelectorAll('#triggers .trig').length,
            hasClass: document.body.classList.contains('hasTriggers')
        })""")
        ok('корректных кнопок 2', tr['count'] == 2, tr)
        ok('подписи прочитаны', tr['labels'] == ['Открыть дверь', ''], tr)
        ok('анимации привязаны', tr['anims'] == [['DoorOpen'], ['LightOn']], tr)
        ok('кнопки отрисованы в DOM', tr['buttons'] == 2, tr)
        ok('класс hasTriggers выставлен', tr['hasClass'], tr)

        vis = await pg2.evaluate("""() => [...document.querySelectorAll('#triggers .trig')]
            .map(e => ({ display: e.style.display, opacity: e.style.opacity, w: Math.round(e.getBoundingClientRect().width) }))""")
        ok('в орбите кнопки видимы', all(v['display'] != 'none' and v['w'] > 0 for v in vis), vis)
        ok('точки мелкие (≤20px)', all(v['w'] <= 20 for v in vis if v['w'] > 0), vis)

        await pg2.evaluate("() => document.querySelector('#triggers .trig')?.click()")
        await pg2.wait_for_timeout(800)
        ok('нет ошибок JS при клике', zerr == [], zerr[:2])

        saved = await pg2.evaluate("() => window.__nomaDebug.serializeScene()")
        ok('сериализация работает', isinstance(saved, dict), {'type': type(saved).__name__})
        if isinstance(saved, dict):
            ok('кнопки попали в JSON', isinstance(saved.get('triggers'), list) and len(saved['triggers']) == 2,
               saved.get('triggers'))
            if isinstance(saved.get('triggers'), list) and saved['triggers']:
                ok('в JSON есть координаты и анимация',
                   'pos' in saved['triggers'][0] and 'anim' in saved['triggers'][0], saved['triggers'][0])
        await pg2.close()

        # ============ 3. Пешеход: кнопки проявляются не все сразу ============
        print('\n# Пешеход: кнопки проявляются по близости и направлению')
        pg3 = await b.new_page(viewport={'width': 1280, 'height': 800})
        pg3.on('pageerror', lambda e: zerr.append(str(e)[:200]))
        await pg3.route('**/tours/trig/tour.json', tour_route)
        await pg3.route('**/tours/trig/m.glb', glb_route)
        await pg3.goto(BASE + '/?tour=trig')
        await pg3.wait_for_function("window.__nomaDebug?.ready === true", timeout=90000)
        await pg3.wait_for_timeout(1000)
        orbit_vis = await pg3.evaluate("""() => [...document.querySelectorAll('#triggers .trig')]
            .filter(e => e.style.display !== 'none').length""")
        await pg3.evaluate("() => document.getElementById('fpBtn').click()")
        await pg3.wait_for_timeout(2600)
        fp_vis = await pg3.evaluate("""() => {
            const d = window.__nomaDebug;
            return {
                visible: [...document.querySelectorAll('#triggers .trig')].filter(e => e.style.display !== 'none' && +e.style.opacity > 0.05).length,
                alphas: d.triggers.map(t => +(t.alpha || 0).toFixed(2))
            };
        }""")
        ok('в пешеходе видно меньше кнопок, чем в орбите',
           fp_vis['visible'] <= orbit_vis, {'orbit': orbit_vis, 'fp': fp_vis})
        await pg3.close()
        ok('нет ошибок JS во всех сценариях', zerr == [], zerr[:3])

        await b.close()

    total = len(res); passed = sum(1 for r in res if r[0])
    print(f'\n{"ПРОВАЛ" if passed != total else "УСПЕХ"}: {passed} из {total}')
    for good, name, det in res:
        if not good: print('  -', name, json.dumps(det, ensure_ascii=False)[:250])
    sys.exit(0 if passed == total else 1)

asyncio.run(main())
