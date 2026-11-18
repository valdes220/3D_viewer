"""Диагностика: куда попадает двойной клик и насколько близко можно подойти."""
import asyncio, json
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8765'
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

STATE = """() => {
    const d = window.__nomaDebug;
    return {
        dist: +d.camera.position.distanceTo(d.controls.target).toFixed(3),
        near: +d.camera.near.toFixed(4),
        target: d.controls.target.toArray().map(v => +v.toFixed(2))
    };
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await pg.goto(BASE + '/?tour=room')
        await pg.wait_for_function("window.__nomaDebug?.ready === true", timeout=90000)
        await pg.wait_for_timeout(1500)

        # ищем пиксель, где есть попадание в модель
        pxy = await pg.evaluate("""() => {
            const d = window.__nomaDebug, THREE = d.THREE;
            const rc = new THREE.Raycaster();
            for (let y = 200; y < 700; y += 25) {
                for (let x = 200; x < 1100; x += 25) {
                    rc.setFromCamera(new THREE.Vector2((x/1280)*2-1, -(y/800)*2+1), d.camera);
                    const h = rc.intersectObject(d.model, true);
                    if (h.length) return { x, y, dist: +h[0].distance.toFixed(2) };
                }
            }
            return null;
        }""")
        print('попадание в модель:', json.dumps(pxy))
        if not pxy:
            await b.close(); return

        print('старт:', json.dumps(await pg.evaluate(STATE)))

        await pg.mouse.dblclick(pxy['x'], pxy['y'])
        await pg.wait_for_timeout(2000)
        print('после двойного клика:', json.dumps(await pg.evaluate(STATE)))

        await pg.mouse.move(pxy['x'], pxy['y'])
        for _ in range(60):
            await pg.mouse.wheel(0, -150)
            await pg.wait_for_timeout(20)
        await pg.wait_for_timeout(800)
        print('после зума:', json.dumps(await pg.evaluate(STATE)))

        info = await pg.evaluate("""() => {
            const d = window.__nomaDebug, THREE = d.THREE;
            const dir = new THREE.Vector3(); d.camera.getWorldDirection(dir);
            const rc = new THREE.Raycaster(); rc.set(d.camera.position, dir); rc.far = 100;
            const hits = rc.intersectObject(d.model, true);
            return {
                camToSurface: hits.length ? +hits[0].distance.toFixed(3) : null,
                near: +d.camera.near.toFixed(4)
            };
        }""")
        print('камера до поверхности:', json.dumps(info))
        await b.close()

asyncio.run(main())
