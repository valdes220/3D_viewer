import asyncio, json
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8765'
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))

        tour = {
            "noma": 1, "title": "Зоны", "model": "main.glb",
            "scene": {
                "version": 1, "model": "main.glb",
                "pois": [{"id": "p1", "title": "Точка в парке", "pos": [2.8, 1.3, -1.4],
                          "cam": {"p": [2.0, 1.5, -1.3], "t": [3.1, 1.1, -1.4]}}],
                "groups": [
                    {"id": "all", "title": "Весь объект", "pois": []},
                    {"id": "park", "title": "Парк", "model": "park.glb",
                     "cam": {"p": [0, 5, 8], "t": [0, 1, 0]}, "pois": ["p1"]}
                ]
            }
        }
        glb = open('tours/room/scene.glb', 'rb').read()

        async def tour_route(route):
            await route.fulfill(status=200, content_type='application/json', body=json.dumps(tour))

        async def glb_route(route):
            await route.fulfill(status=200, content_type='model/gltf-binary', body=glb)

        await pg.route('**/tours/zones/tour.json', tour_route)
        await pg.route('**/tours/zones/main.glb', glb_route)
        await pg.route('**/tours/zones/park.glb', glb_route)

        await pg.goto(BASE + '/?tour=zones')
        await pg.wait_for_function("window.__nomaDebug?.ready === true", timeout=90000)
        await pg.wait_for_timeout(800)

        print('после загрузки:', json.dumps(await pg.evaluate("()=>window.__nomaDebug.stats()")))
        ui = await pg.evaluate("""() => ({
            shown: document.body.classList.contains('hasGroups'),
            buttons: [...document.querySelectorAll('#groups button')].map(b => b.textContent)
        })""")
        print('панель зон:', json.dumps(ui, ensure_ascii=False))

        await pg.click('#groups button:has-text("Парк")')
        await pg.wait_for_timeout(3500)
        print('после выбора зоны:', json.dumps(await pg.evaluate("()=>window.__nomaDebug.stats()")))

        await pg.click('#groups button:has-text("Все")')
        await pg.wait_for_timeout(2000)
        print('после возврата:', json.dumps(await pg.evaluate("()=>window.__nomaDebug.stats()")))

        print('ошибки JS:', errs)
        await b.close()

asyncio.run(main())
