// Round 2: exercise the shared-database ("ข้อมูลจริง") code path with a mock of window.claude db/user,
// two tabs sharing one store to simulate a driver phone and the dispatcher screen.
// Usage: sh tests/wrap.sh app/index.html /tmp/page.html && node tests/shared-data.test.js <shots-dir> /tmp/page.html
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const OUT = process.argv[2];
const URL = 'file://' + process.argv[3];
const log = (...a) => console.log(...a);
let fails = 0;
const ok = (c, m) => { if (c) log('  PASS', m); else { fails++; log('  FAIL', m); } };

const MOCK = `(() => {
  const KEY = 'mockdb';
  const load = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const save = s => localStorage.setItem(KEY, JSON.stringify(s));
  const listeners = [];
  const notify = () => listeners.forEach(l => l());
  window.addEventListener('storage', e => { if (e.key === KEY) notify(); });
  const snap = (col, filters) => {
    const st = load();
    const docs = Object.entries(st).filter(([p]) => p.startsWith(col + '/') && p.split('/').length === 2)
      .map(([p, data]) => ({ id: p.split('/')[1], exists: true, data: () => Object.freeze({ ...data }), metadata: { fromCache: false, hasPendingWrites: false } }))
      .filter(d => filters.every(([f, op, v]) => op === '>=' ? d.data()[f] >= v : true));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} };
  };
  const query = (col, filters) => ({
    where: (f, op, v) => query(col, [...filters, [f, op, v]]),
    orderBy() { return this; }, limit() { return this; },
    get: async () => snap(col, filters),
    onSnapshot(next) { const l = () => next(snap(col, filters)); listeners.push(l); setTimeout(l, 15); return () => {}; },
  });
  window.__writes = 0;
  const db = Object.freeze({
    collection(col) {
      return Object.assign(query(col, []), {
        path: col,
        doc(id) {
          id = id || Math.random().toString(36).slice(2); const p = col + '/' + id;
          return {
            id, path: p,
            get: async () => { const d = load()[p]; return { id, exists: !!d, data: () => d, metadata: {} }; },
            set: async data => { if (window.__denyWrites) throw { code: 'invalid_argument', message: 'denied' }; window.__writes++; const st = load(); st[p] = JSON.parse(JSON.stringify(data)); save(st); notify(); },
            delete: async () => { const st = load(); delete st[p]; save(st); notify(); },
          };
        },
      });
    },
  });
  const user = Object.freeze({ id: async () => 'u_test', can: async () => (window.__canWrite === false ? false : true), isOwner: async () => true, canEdit: async () => true });
  window.claude = { use: async name => (name === 'db' ? db : name === 'user' ? user : null) };
})();`;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  await ctx.addInitScript(MOCK);
  const errors = [];
  const track = p => { p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/fonts|net::|ERR_/.test(m.text())) errors.push(m.text()); }); };
  const A = await ctx.newPage(); track(A);
  const ready = async p => p.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 15000 });
  const go = async (p, h) => { await p.evaluate(x => (location.hash = x), h); await p.waitForTimeout(250); };
  const store = async () => A.evaluate(() => JSON.parse(localStorage.getItem('mockdb') || '{}'));
  const sheetSave = async p => { await p.locator('#sheet button[type=submit]').click(); await p.waitForTimeout(250); };

  log('== dispatcher tab, empty shared store ==');
  await A.goto(URL); await ready(A);
  ok(await A.locator('.banner').count() === 1, 'empty store -> demo mode offered automatically');
  await A.locator('.banner button[data-act="demoOff"]').click(); await A.waitForTimeout(250);
  ok((await A.locator('#modeChip').textContent()).includes('ข้อมูลจริง'), 'live (shared) mode chip');

  log('== master data into shared store ==');
  await go(A, '#master');
  await A.locator('button[data-act="masterTab"][data-v="sites"]').click(); await A.waitForTimeout(150);
  await A.locator('button[data-act="edit"][data-col="sites"]').first().click(); await A.waitForTimeout(150);
  await A.fill('#f-name', 'คลังพุทธมณฑลสาย 3'); await A.fill('#f-coords', '13.7881, 100.3163'); await sheetSave(A);
  await A.locator('button[data-act="masterTab"][data-v="vehicles"]').click(); await A.waitForTimeout(150);
  await A.locator('button[data-act="edit"][data-col="vehicles"]').first().click(); await A.waitForTimeout(150);
  await A.fill('#f-plate', '70-5001'); await A.selectOption('#f-type', '22'); await A.fill('#f-capWeightKg', '30000'); await A.fill('#f-currentKm', '410000'); await A.fill('#f-lastServiceKm', '400000'); await sheetSave(A);
  await A.locator('button[data-act="masterTab"][data-v="drivers"]').click(); await A.waitForTimeout(150);
  await A.locator('button[data-act="edit"][data-col="drivers"]').first().click(); await A.waitForTimeout(150);
  await A.fill('#f-name', 'ทดสอบ ขับดี'); await sheetSave(A);
  let st = await store();
  const keys = Object.keys(st);
  ok(keys.some(k => k.startsWith('sites/')) && keys.some(k => k.startsWith('vehicles/')) && keys.some(k => k.startsWith('drivers/')), 'site, vehicle, driver written to shared store: ' + keys.join(', '));
  const veh = Object.entries(st).find(([k]) => k.startsWith('vehicles/'))[1];
  ok(veh.capWeightKg === 30000 && veh.type === '22' && !('id' in veh), 'numbers stored as numbers, no id field in body');

  log('== driver tab checks in ==');
  const B = await ctx.newPage(); track(B);
  await B.goto(URL + '#checkin'); await ready(B);
  ok(await B.evaluate(() => document.body.classList.contains('driver')), 'opening #checkin link -> driver view');
  await B.selectOption('#ci-driver', { label: 'ทดสอบ ขับดี' }); await B.waitForTimeout(150);
  await B.selectOption('#ci-veh', { index: 1 }); await B.waitForTimeout(150);
  await B.fill('#ci-loctext', '13.7890, 100.3170'); await B.waitForTimeout(100);
  await B.locator('form[data-form="checkin"] button[type=submit]').click(); await B.waitForTimeout(400);
  ok((await B.locator('.ticket .big').textContent().catch(() => '')) === '01', 'driver gets queue 01');
  st = await store();
  const ci = Object.entries(st).find(([k]) => k.startsWith('checkins/'));
  ok(ci && ci[1].inRadius === true && ci[1].status === 'waiting' && ci[1].by === 'u_test', 'check-in stored with radius result, status and viewer id');
  await B.screenshot({ path: OUT + '/live-driver-ticket.png', fullPage: true });

  log('== dispatcher sees it live ==');
  await A.bringToFront();
  await go(A, '#queue'); await A.waitForTimeout(300);
  ok(await A.locator('.qno').count() === 1, 'queue shows the new check-in on the dispatcher tab');

  log('== order -> dispatch -> driver sees assignment ==');
  await go(A, '#orders');
  await A.locator('button[data-act="edit"][data-col="orders"]').first().click(); await A.waitForTimeout(150);
  await A.fill('#f-customer', 'Dairy Plus'); await A.fill('#f-destination', 'เดโปสุราษฎร์'); await A.fill('#f-weightKg', '24000'); await A.fill('#f-revenue', '34000'); await sheetSave(A);
  await A.locator('button[data-act="ordToDispatch"]').first().click(); await A.waitForTimeout(250);
  ok(await A.locator('.pick .reco').count() === 1, 'checked-in truck recommended');
  await A.locator('.pick:has(.reco)').click(); await A.waitForTimeout(200);
  await A.locator('button[data-act="createTrip"]').click(); await A.waitForTimeout(500);
  ok((await A.evaluate(() => location.hash)).startsWith('#trip-'), 'trip created in shared mode');
  await B.waitForTimeout(400);
  ok((await B.locator('.ticket').textContent()).includes('ได้งานแล้ว'), 'driver tab shows "ได้งานแล้ว" without reload');
  await B.screenshot({ path: OUT + '/live-driver-assigned.png', fullPage: true });

  log('== snapshot during typing does not wipe the close-trip form ==');
  await A.locator('form[data-form="depart"] button[type=submit]').click(); await A.waitForTimeout(400);
  await A.fill('#tc-loaded', '850');
  await A.locator('#tc-l').click();
  await B.evaluate(() => { location.hash = '#x'; });
  await A.evaluate(() => { const st = JSON.parse(localStorage.getItem('mockdb')); st['drivers/zz'] = { name: 'อีกคน', active: true }; localStorage.setItem('mockdb', JSON.stringify(st)); window.dispatchEvent(new StorageEvent('storage', { key: 'mockdb' })); });
  await A.waitForTimeout(300);
  await A.locator('h2:has-text("ปิดทริป")').click(); await A.waitForTimeout(300);
  ok((await A.inputValue('#tc-loaded')) === '850', 'typed Loaded KM survives a background update');

  log('== settings saved to shared store ==');
  await go(A, '#settings');
  await A.fill('#s-m22', '31000');
  await A.locator('form[data-form="settings"] button[type=submit]').click(); await A.waitForTimeout(300);
  st = await store();
  ok(st['config/settings'] && st['config/settings'].minRevenue['22'] === 31000, 'config/settings document written');

  log('== reload keeps data ==');
  await A.reload(); await ready(A); await go(A, '#queue');
  ok((await A.locator('#modeChip').textContent()).includes('ข้อมูลจริง'), 'remembers live mode after reload');
  await go(A, '#trips');
  ok(await A.locator('#main .list a.row').count() === 1, 'trip still there after reload');

  log('== read-only viewer ==');
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(MOCK);
  await ctx2.addInitScript(s => { window.__canWrite = false; if (!localStorage.getItem('mockdb')) localStorage.setItem('mockdb', s); }, JSON.stringify(await store()));
  const C = await ctx2.newPage(); track(C);
  await C.goto(URL + '#orders'); await ready(C);
  ok(await C.locator('.banner.ro').count() === 1, 'read-only banner');
  ok(await C.locator('button[data-act="edit"][data-col="orders"]').first().isDisabled(), 'add/edit disabled for read-only');

  log('== write rejected at runtime ==');
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addInitScript(MOCK);
  await ctx3.addInitScript(s => { window.__denyWrites = true; localStorage.setItem('mockdb', s); localStorage.setItem('ssc-demo-pref', '"live"'); }, JSON.stringify(await store()));
  const D = await ctx3.newPage(); track(D);
  await D.goto(URL + '#master'); await ready(D);
  await D.locator('.row button[data-act="edit"][data-col="vehicles"]').first().click(); await D.waitForTimeout(150);
  await D.locator('#sheet button[type=submit]').click(); await D.waitForTimeout(300);
  ok(!(await D.locator('#sheet-err').isHidden()) && await D.locator('.banner.ro').count() === 1, 'rejected write -> error in sheet + read-only banner');

  errors.forEach(e => log('  error: ' + e));
  ok(errors.length === 0, 'no page errors');
  log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await browser.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
