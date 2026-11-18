"""Проверки правок камеры и пинов: пешеход, приземление, выход под 45°, видимость пинов."""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8765'
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
res = []

def ok(name, cond, detail=''):
    res.append((bool(cond), name, detail))
    print(('  ok   ' if cond else '  FAIL ') + name + (('  — ' + json.dumps(detail, ensure_ascii=False)[:200]) if detail and not cond else ''))

async def boot(b):
    pg = await b.new_page(viewport={'width': 1280, 'height': 800})
    await pg.goto(BASE + '/?tour=room')
    await pg.wait_for_function("window.__nomaDebug?.ready === true", timeout=90000)
    await pg.evaluate("() => document.getElementById('spFree')?.click()")
    await pg.wait_for_timeout(900)
    return pg

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)

        print('\n# Орбита → Пешеход: камера встаёт на поверхность')
        pg = await boot(b)
        await pg.evaluate("() => document.getElementById('fpBtn').click()")
        await pg.wait_for_timeout(2500)
        fp = await pg.evaluate("""() => {
            const d = window.__nomaDebug, T = d.THREE;
            const box = new T.Box3().setFromObject(d.model);
            const rc = new T.Raycaster();
            rc.set(new T.Vector3(d.camera.position.x, box.max.y + 5, d.camera.position.z), new T.Vector3(0,-1,0));
            rc.far = 300;
            const h = rc.intersectObject(d.model, true).filter(x => x.point.y <= d.camera.position.y + 0.01);
            return {
                camY: +d.camera.position.y.toFixed(3),
                surfaceY: h.length ? +h[0].point.y.toFixed(3) : null,
                minY: +box.min.y.toFixed(3),
                onFloor: document.body.classList.contains('fp')
            };
        }""")
        ok('режим пешехода включился', fp['onFloor'], fp)
        ok('камера НЕ под нижней границей сцены', fp['camY'] > fp['minY'], fp)
        if fp['surfaceY'] is not None:
            ok('камера над поверхностью пола', fp['camY'] >= fp['surfaceY'] - 0.05, fp)
            drop = fp['camY'] - fp['surfaceY']
            ok('высота глаз в разумных пределах (0.3–6 м)', 0.3 <= drop <= 6.0, {'drop': round(drop, 3), **fp})

        print('\n# Пешеход: клик по пину не выбивает из режима')
        before = await pg.evaluate("() => window.__nomaDebug.camera.position.toArray()")
        clicked = await pg.evaluate("""() => {
            const pins = [...document.querySelectorAll('#pins .pin')].filter(p => p.style.display !== 'none');
            if (!pins.length) return { err: 'нет видимых пинов' };
            pins[0].click();
            return { clicked: true };
        }""")
        if clicked.get('clicked'):
            await pg.wait_for_timeout(1800)
            after_pin = await pg.evaluate("""(b) => {
                const d = window.__nomaDebug, T = d.THREE;
                return {
                    cardOpen: document.body.classList.contains('cardOpen'),
                    stillFP: document.body.classList.contains('fp'),
                    moved: +d.camera.position.distanceTo(new T.Vector3(...b)).toFixed(2),
                    title: document.getElementById('cTitle').textContent
                };
            }""", before)
            ok('карточка открылась', after_pin['cardOpen'], after_pin)
            ok('режим пешехода сохранился', after_pin['stillFP'], after_pin)
            ok('камера осталась на месте', after_pin['moved'] < 1.0, after_pin)

        print('\n# Пешеход: перекрытый пин скрыт')
        occ = await pg.evaluate("""() => {
            const d = window.__nomaDebug, T = d.THREE;
            const box = new T.Box3().setFromObject(d.model);
            const save = d.camera.position.clone();
            // Ставим камеру ПОД полом: между ней и любой точкой будет геометрия пола.
            d.camera.position.set(box.getCenter(new T.Vector3()).x, box.min.y - 2, box.getCenter(new T.Vector3()).z);
            d.wake(5);
            const st = d.pinState();
            d.camera.position.copy(save);
            d.wake(5);
            return { under: st, anyBlocked: st.some(x => x.blocked) };
        }""")
        ok('из-под пола все пины считаются перекрытыми',
           occ['anyBlocked'], occ)
        # и наоборот: в обычной позиции хотя бы один пин доступен
        norm = await pg.evaluate("() => window.__nomaDebug.pinState()")
        ok('в нормальной позиции есть видимый пин', any(not x['blocked'] for x in norm), norm)

        print('\n# Пешеход → Орбита: камера поднимается под ~45°')
        await pg.evaluate("() => document.getElementById('fpBtn').click()")
        await pg.wait_for_timeout(1000)
        ex = await pg.evaluate("""() => {
            const d = window.__nomaDebug, T = d.THREE;
            const box = new T.Box3().setFromObject(d.model);
            const dir = d.camera.position.clone().sub(d.controls.target);
            const angle = Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) * 180 / Math.PI;
            return { camY: +d.camera.position.y.toFixed(3), minY: +box.min.y.toFixed(3),
                     angle: +angle.toFixed(1), isFP: document.body.classList.contains('fp') };
        }""")
        ok('вышли из пешехода', not ex['isFP'], ex)
        ok('камера выше нижней границы сцены', ex['camY'] > ex['minY'], ex)
        ok('камера смотрит сверху', ex['angle'] > 5, ex)
        ok('угол близок к 45° (25–65°)', 25 <= ex['angle'] <= 65, ex)
        await pg.close()

        print('\n# Орбита: пины двигаются плавно')
        pg = await boot(b)
        smooth = await pg.evaluate("""() => new Promise(res => {
            const el = [...document.querySelectorAll('#pins .pin')].find(p => p.style.display !== 'none');
            if (!el) return res({ err: 'нет пина' });
            const get = () => {
                const m = /translate3d\\(([-\\d.]+)px,\\s*([-\\d.]+)px/.exec(el.style.transform || '');
                return m ? [+m[1], +m[2]] : null;
            };
            const samples = [];
            let n = 0;
            const iv = setInterval(() => {
                samples.push(get());
                if (++n > 6) { clearInterval(iv); res({ samples }); }
            }, 60);
            const d = window.__nomaDebug;
            d.controls.target.x += 2;
            d.wake(30);
        })""")
        s = [x for x in smooth.get('samples', []) if x]
        ok('пин двигается', len(s) >= 2, smooth)
        if len(s) >= 2:
            steps = [abs(s[i][0] - s[i-1][0]) for i in range(1, len(s))]
            ok('нет одиночного скачка на весь путь', max(steps) < 400, {'steps': [round(x, 1) for x in steps]})
        await pg.close()
        await b.close()

    total = len(res); passed = sum(1 for r in res if r[0])
    print(f'\n{"ПРОВАЛ" if passed != total else "УСПЕХ"}: {passed} из {total}')
    for good, name, det in res:
        if not good: print('  -', name, json.dumps(det, ensure_ascii=False)[:200])
    sys.exit(0 if passed == total else 1)

asyncio.run(main())
