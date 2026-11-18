#!/usr/bin/env python3
"""
NOMA — smoke-тесты в реальном браузере (Playwright + headless Chromium).

Запуск:
    python3 -m http.server 8765        # из корня проекта, в отдельном терминале
    python3 tests/smoke.py

Проверяются реальные пользовательские сценарии, а не наличие строк в коде.
WebGL работает через программный растеризатор SwiftShader, поэтому картинка
может отличаться от настоящей видеокарты, но логика приложения — та же.
"""
import asyncio, sys, json, os

BASE = os.environ.get('NOMA_URL', 'http://127.0.0.1:8765')
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

results = []
def ok(name, cond, detail=''):
    results.append((bool(cond), name, detail))
    print(('  ok   ' if cond else '  FAIL ') + name + (('  — ' + str(detail)) if detail and not cond else ''))

async def load(pg, url, timeout=90000):
    await pg.goto(BASE + url)
    await pg.wait_for_function(
        "window.__nomaDebug?.ready === true || !!document.querySelector('#splash.err')",
        timeout=timeout)
    await pg.wait_for_timeout(900)

async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)

        # ---------- 1. Старый тур room открывается ----------
        print('\n# Открытие существующего тура room (обратная совместимость)')
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        errors, failed_req = [], []
        pg.on('pageerror', lambda e: errors.append(str(e)[:200]))
        pg.on('response', lambda r: failed_req.append(f'{r.status} {r.url[-50:]}') if r.status >= 400 else None)
        await load(pg, '/?tour=room')
        st = await pg.evaluate("""() => ({
            ready: !!window.__nomaDebug?.ready,
            viewer: document.body.classList.contains('viewer'),
            present: document.body.classList.contains('present'),
            err: document.querySelector('#splash.err')?.innerText || '',
            pois: window.__nomaDebug?.pois.length ?? -1,
            title: document.title
        })""")
        ok('модель загрузилась', st['ready'], st)
        ok('клиентский режим включён', st['viewer'])
        ok('ошибки на стартовом экране нет', st['err'] == '', st['err'])
        ok('точки интереса прочитаны', st['pois'] == 3, st['pois'])
        ok('нет 404 по ресурсам', failed_req == [], failed_req[:3])
        ok('нет ошибок JS', errors == [], errors[:3])
        ok('название в заголовке из тура', 'Экосистема' in st['title'], st['title'])

        # ---------- 2. Редакторские элементы не видны ----------
        print('\n# Клиентский режим: инструменты автора скрыты')
        vis = await pg.evaluate("""() => {
            const shown = id => {
                const e = document.getElementById(id);
                if (!e) return false;
                const cs = getComputedStyle(e), r = e.getBoundingClientRect();
                return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 0 && r.height > 0
                    && !e.closest('[hidden]');
            };
            return {
                inspector: shown('inspector'), cEdit: shown('cEdit'), fileLabel: shown('file'),
                drop: shown('drop'), settings: shown('settingsBtn'), lite: shown('liteBtn'),
                help: shown('helpBtn'), toolbar: shown('toolbar'), tourBtn: shown('tourBtn'),
                fpBtn: shown('fpBtn'), fs: shown('fs'), card: shown('poiCard')
            };
        }""")
        ok('инспектор редактора скрыт', not vis['inspector'], vis)
        ok('кнопка «Изменить» скрыта', not vis['cEdit'], vis)
        ok('загрузка файла скрыта', not vis['fileLabel'], vis)
        ok('настройки скрыты', not vis['settings'], vis)
        ok('«лёгкая графика» скрыта', not vis['lite'], vis)
        ok('справка скрыта', not vis['help'], vis)
        ok('тулбар показан (нужные кнопки)', vis['toolbar'], vis)
        ok('полный экран доступен', vis['fs'], vis)

        # ---------- 3. Карточка точки интереса ----------
        print('\n# Карточка точки интереса')
        ok('карточка изначально закрыта', not vis['card'], vis)
        opened = await pg.evaluate("""() => {
            const d = window.__nomaDebug;
            const pin = document.querySelector('#pins .pin');
            if (!pin) return { err: 'нет пина' };
            pin.click();
            return { clicked: true };
        }""")
        await pg.wait_for_timeout(700)
        card = await pg.evaluate("""() => {
            const c = document.getElementById('poiCard');
            return {
                open: document.body.classList.contains('cardOpen'),
                title: document.getElementById('cTitle').textContent,
                count: document.getElementById('cCnt').textContent,
                emptyGallery: document.getElementById('cGal').classList.contains('empty'),
                acts: document.getElementById('cActs').children.length
            };
        }""")
        ok('карточка открылась по клику на пин', card['open'], card)
        ok('в карточке есть название', bool(card['title']), card)
        ok('счётчик вида «1 / 3»', '/' in card['count'], card['count'])
        ok('пустая галерея показывает заглушку', card['emptyGallery'], card)

        # ---------- 4. Экскурсия с гидом ----------
        print('\n# Экскурсия с гидом')
        await pg.evaluate("() => document.getElementById('cardClose').click()")
        await pg.wait_for_timeout(300)
        await pg.evaluate("() => document.getElementById('tourBtn').click()")
        await pg.wait_for_timeout(1500)
        tour = await pg.evaluate("""() => ({
            touring: document.body.classList.contains('touring'),
            barVisible: getComputedStyle(document.getElementById('tourBar')).display !== 'none',
            segs: document.querySelectorAll('#tSegs .seg').length,
            title: document.getElementById('tbTitle').textContent
        })""")
        ok('экскурсия запустилась', tour['touring'], tour)
        ok('панель экскурсии видна', tour['barVisible'], tour)
        ok('сегментов = числу точек', tour['segs'] == 3, tour['segs'])
        ok('название остановки заполнено', bool(tour['title']), tour)

        # ---------- 5. Переключение корпусов во время экскурсии не ломает сцену ----------
        print('\n# Остановка экскурсии')
        await pg.evaluate("() => document.getElementById('tbExit').click()")
        await pg.wait_for_timeout(500)
        ok('экскурсия выключилась', not await pg.evaluate("() => document.body.classList.contains('touring')"))
        await pg.close()

        # ---------- 6. Тур test ----------
        print('\n# Тур test')
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await load(pg, '/?tour=test')
        st = await pg.evaluate("""() => ({
            ready: !!window.__nomaDebug?.ready,
            pois: window.__nomaDebug?.pois.length,
            err: document.querySelector('#splash.err')?.innerText || ''
        })""")
        ok('test загрузился', st['ready'], st)
        ok('одна точка', st['pois'] == 1, st['pois'])
        await pg.close()

        # ---------- 7. Режим презентации ----------
        print('\n# ?mode=present')
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await load(pg, '/?tour=room&mode=present')
        pres = await pg.evaluate("""() => ({
            present: document.body.classList.contains('present'),
            viewer: document.body.classList.contains('viewer'),
            chipBg: getComputedStyle(document.getElementById('fileChip')).backgroundColor,
            groups: document.body.classList.contains('hasGroups')
        })""")
        ok('класс present выставлен', pres['present'], pres)
        ok('клиентский режим активен', pres['viewer'], pres)
        ok('панель бренда без «стекла»', 'rgba(0, 0, 0, 0)' in pres['chipBg'], pres['chipBg'])
        await pg.close()

        # ---------- 8. Битый tour.json: точка пропускается, тур живёт ----------
        print('\n# Устойчивость: битая точка не роняет тур')
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await pg.route('**/tours/broken/tour.json', lambda route: route.fulfill(
            status=200, content_type='application/json',
            body=json.dumps({
                'noma': 1, 'title': 'Битый тур', 'model': 'scene.glb',
                'scene': {'version': 1, 'model': 'scene.glb', 'pois': [
                    {'title': 'Хорошая', 'pos': [2.8, 1.3, -1.4], 'cam': {'p': [2.0, 1.5, -1.3], 't': [3.1, 1.1, -1.4]}},
                    {'title': 'Без координат'},
                    {'title': 'Кривая', 'pos': 'мусор'},
                    {'title': 'Вторая', 'pos': [-2.9, 1.2, 1.0], 'cam': {'p': [-2.0, 1.5, 1.0], 't': [-2.9, 1.2, 1.0]}}
                ]}
            }, ensure_ascii=False)))
        await pg.route('**/tours/broken/*.glb', lambda route: route.fulfill(
            status=200, content_type='model/gltf-binary',
            body=open('tours/room/scene.glb', 'rb').read()))
        await load(pg, '/?tour=broken')
        br = await pg.evaluate("""() => ({
            ready: !!window.__nomaDebug?.ready,
            pois: window.__nomaDebug?.pois.length,
            titles: window.__nomaDebug?.pois.map(p => p.title),
            err: document.querySelector('#splash.err')?.innerText || ''
        })""")
        ok('тур с битыми точками открылся', br['ready'], br)
        ok('остались только корректные точки', br['pois'] == 2, br['pois'])
        ok('названия верные', br['titles'] == ['Хорошая', 'Вторая'], br['titles'])
        ok('нет экрана ошибки', br['err'] == '', br['err'])
        await pg.close()

        # ---------- 9. Отсутствующая модель: понятная ошибка ----------
        print('\n# Отсутствующая модель -> понятное сообщение')
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await pg.route('**/tours/nomodel/tour.json', lambda route: route.fulfill(
            status=200, content_type='application/json',
            body=json.dumps({'noma': 1, 'title': 'Нет модели', 'model': 'нет-такой.glb', 'scene': {'pois': []}})))
        await pg.goto(BASE + '/?tour=nomodel')
        await pg.wait_for_function("!!document.querySelector('#splash.err')", timeout=60000)
        err = await pg.evaluate("() => document.querySelector('#spErr').innerText.toLowerCase()")
        ok('показан экран ошибки', bool(err), err)
        ok('сообщение упоминает модель', 'модел' in err, err)
        await pg.close()

        # ---------- 9b. Зоны: подгрузка и выгрузка ----------
        print('\n# Зоны: тяжёлая детализация грузится по выбору и выгружается')
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        zone_errors = []
        pg.on('pageerror', lambda e: zone_errors.append(str(e)[:200]))
        glb = open('tours/room/scene.glb', 'rb').read()

        async def tour_route(route):
            await route.fulfill(status=200, content_type='application/json', body=json.dumps({
                'noma': 1, 'title': 'Зоны', 'model': 'main.glb',
                'scene': {'version': 1, 'model': 'main.glb',
                          'pois': [{'id': 'p1', 'title': 'Точка', 'pos': [2.8, 1.3, -1.4],
                                    'cam': {'p': [2.0, 1.5, -1.3], 't': [3.1, 1.1, -1.4]}}],
                          'groups': [
                              {'id': 'all', 'title': 'Весь объект', 'pois': []},
                              {'id': 'park', 'title': 'Парк', 'model': 'park.glb',
                               'cam': {'p': [0, 5, 8], 't': [0, 1, 0]}, 'pois': ['p1']}]}}))

        async def glb_route(route):
            await route.fulfill(status=200, content_type='model/gltf-binary', body=glb)

        await pg.route('**/tours/zones/tour.json', tour_route)
        await pg.route('**/tours/zones/main.glb', glb_route)
        await pg.route('**/tours/zones/park.glb', glb_route)
        await load(pg, '/?tour=zones')

        z0 = await pg.evaluate("() => window.__nomaDebug.stats()")
        ok('панель зон показана', await pg.evaluate(
            "() => document.body.classList.contains('hasGroups')"))
        ok('на старте зона не загружена', z0['zoneLoaded'] is False, z0)

        await pg.click('#groups button:has-text("Парк")')
        await pg.wait_for_timeout(3500)
        z1 = await pg.evaluate("() => window.__nomaDebug.stats()")
        ok('модель зоны загрузилась', z1['zoneLoaded'] is True, z1)
        ok('имя зоны запомнено', z1['zone'] == 'park.glb', z1)
        ok('геометрии стало больше', z1['geometries'] > z0['geometries'], [z0, z1])
        ok('draw call вырос ожидаемо', z1['drawCalls'] > z0['drawCalls'], [z0, z1])

        await pg.click('#groups button:has-text("Все")')
        await pg.wait_for_timeout(2000)
        z2 = await pg.evaluate("() => window.__nomaDebug.stats()")
        ok('при возврате зона выгружена', z2['zoneLoaded'] is False, z2)
        ok('память геометрии вернулась к базовой', z2['geometries'] == z0['geometries'], [z0, z2])
        ok('нет ошибок JS при работе с зонами', zone_errors == [], zone_errors[:3])
        await pg.close()

        # ---------- 10. Невалидные URL отклоняются ----------
        print('\n# Безопасность: опасные URL отклоняются')
        pg = await b.new_page()
        await pg.goto(BASE + '/?tour=room')
        saf = await pg.evaluate("""async () => {
            const m = await import('/src/tour-io.js');
            return {
                js: m.safeUrl('javascript:alert(1)'),
                data: m.safeUrl('data:text/html,<script>x</script>'),
                ok: m.safeUrl('https://example.com'),
                rel: m.resolveAsset('plan.pdf', 'https://s.ru/t/')
            };
        }""")
        ok('javascript: отклонён', saf['js'] == '', saf)
        ok('data:text/html отклонён', saf['data'] == '', saf)
        ok('https разрешён', saf['ok'] == 'https://example.com', saf)
        ok('относительный путь разрешён от каталога тура', saf['rel'] == 'https://s.ru/t/plan.pdf', saf)
        await pg.close()

        # ---------- 11. Рендер по требованию: гейт закрывается в простое ----------
        print('\n# Производительность: рендер по требованию')
        pg = await b.new_page(viewport={'width': 900, 'height': 600})
        await pg.route('**/tours/perf/tour.json', lambda route: route.fulfill(
            status=200, content_type='application/json',
            body=json.dumps({'noma': 1, 'title': 'Perf', 'model': 'scene.glb',
                             'scene': {'version': 1, 'model': 'scene.glb', 'pois': []}})))
        await pg.route('**/tours/perf/*.glb', lambda route: route.fulfill(
            status=200, content_type='model/gltf-binary',
            body=open('tours/room/scene.glb', 'rb').read()))
        await load(pg, '/?tour=perf')
        await pg.wait_for_timeout(3000)          # ждём, пока сцена успокоится

        # (а) сцена неподвижна: гейт закрыт, кадр рисоваться не будет.
        # Счётчики rAF в headless нестабильны (браузер сам перестаёт слать кадры
        # в фоне), поэтому критерий — состояние гейта, а не число кадров.
        await pg.wait_for_timeout(1200)
        idle_gate = await pg.evaluate("() => window.__nomaDebug.gate()")
        ok('гейт рендера включён в клиентском режиме', idle_gate['gateOn'], idle_gate)
        ok('в покое гейт закрыт — кадр пропускается', idle_gate['willSkip'], idle_gate)
        ok('редактор не включён (клиентский режим)', not idle_gate['editing'], idle_gate)

        # (б) wake() снова включает рендер
        woke = await pg.evaluate("""() => {
            const before = window.__nomaDebug.gate().willSkip;
            window.__nomaDebug.wake(5);
            return { before, after: window.__nomaDebug.gate().willSkip };
        }""")
        ok('wake() открывает гейт рендера', woke['before'] and not woke['after'], woke)

        # (в) движение камеры рисует кадры
        await pg.evaluate("() => window.__nomaDebug.framesReset()")
        await pg.mouse.move(450, 300)
        await pg.mouse.down()
        for i in range(14):
            await pg.mouse.move(450 + i * 6, 300 + i * 2)
            await pg.wait_for_timeout(35)
        await pg.mouse.up()
        await pg.wait_for_timeout(300)
        act = await pg.evaluate("() => window.__nomaDebug.frames()")
        ok('при вращении камеры кадры рисуются', act['drawn'] > 0, act)
        print(f'       при вращении: запрошено {act["raf"]}, нарисовано {act["drawn"]}')

        # (г) в редакторе рендер остаётся непрерывным (не ломаем рабочий процесс автора)
        await pg.close()
        pg = await b.new_page(viewport={'width': 900, 'height': 600})
        await pg.goto(BASE + '/')
        await pg.wait_for_function("window.__nomaDebug !== undefined", timeout=60000)
        await pg.evaluate("() => window.__nomaDebug.framesReset()")
        await pg.wait_for_timeout(1200)
        ed = await pg.evaluate("() => ({...window.__nomaDebug.frames(), gate: window.__nomaDebug.gate()})")
        ok('в редакторе рендер непрерывный', ed['drawn'] >= ed['raf'] - 2, ed)
        ok('гейт в редакторе всегда открыт', ed['gate']['editing'] and not ed['gate']['willSkip'], ed['gate'])
        await pg.close()

        await b.close()

    total = len(results)
    passed = sum(1 for r in results if r[0])
    print(f'\n{"ПРОВАЛ" if passed != total else "УСПЕХ"}: {passed} из {total} проверок прошло')
    if passed != total:
        print('\nНе прошли:')
        for good, name, det in results:
            if not good: print('  -', name, det)
        sys.exit(1)

if __name__ == '__main__':
    asyncio.run(main())
