// Sections by department with access codes, in shared (db) mode with the mock store from shared-data.test.js.
// Usage: sh tests/wrap.sh app/index.html /tmp/page.html && node tests/access.test.js <shots-dir> /tmp/page.html
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs');
const crypto = require('crypto');
const OUT = process.argv[2];
const URL = 'file://' + process.argv[3];
const log = (...a) => console.log(...a);
let fails = 0;
const ok = (c, m) => { if (c) log('  PASS', m); else { fails++; log('  FAIL', m); } };
const src = fs.readFileSync(__dirname + '/shared-data.test.js', 'utf8');
const MOCK = eval(src.match(/const MOCK = (`[\s\S]*?`);/)[1]).replace('isOwner: async () => true', 'isOwner: async () => !window.__notOwner');
const sha = (salt, sec, code) => crypto.createHash('sha256').update(`${salt}|${sec}|${code}`).digest('hex');
const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const today = new Date(); const dk = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const base = {
  'vehicles/v1': { plate: '70-5001', type: '22', line: 'south', trailerPlate: '70-6001', ownership: 'SSC', status: 'ready' },
  'drivers/d1': { name: 'ทดสอบ ขับดี', active: true },
  'sites/s3': { name: 'คลังพุทธมณฑลสาย 3', kind: 'base', line: 'south', lat: 13.7881, lng: 100.3163, backhaulCutoff: '10:00' },
  'parcels/p1': { no: 'S' + dk.slice(2, 4) + dk.slice(5, 7) + dk.slice(8, 10) + '0001', day: dk, createdAt: new Date().toISOString(), category: 'เบ็ดเตล็ด', senderName: 'ผู้ส่ง', senderPhone: '081', receiverName: 'ผู้รับ', receiverPhone: '082', province: 'ชุมพร', boxes: 1, weightKg: 5, fee: 100, payer: 'origin', status: 'received', dueDate: dk, scans: { loaded: {}, arrived: {} }, events: [] },
};
const withCodes = { ...base, 'config/access': { salt, codes: { driver: { h: sha(salt, 'driver', '1111'), at: new Date().toISOString() }, checker: { h: sha(salt, 'checker', '2222'), at: new Date().toISOString() }, dispatch: { h: sha(salt, 'dispatch', '3333'), at: new Date().toISOString() } } } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors = [];
  const mk = async (seed, notOwner) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
    await ctx.route(/^https?:\/\//, r => r.abort());
    await ctx.addInitScript(([s, n]) => { if (!localStorage.getItem('mockdb')) localStorage.setItem('mockdb', s); localStorage.setItem('ssc-demo-pref', '"live"'); localStorage.setItem('ssc-popup', '"off"'); if (n) window.__notOwner = true; }, [JSON.stringify(seed), notOwner]);
    await ctx.addInitScript(MOCK);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    return { ctx, p };
  };
  const ready = p => p.waitForFunction(() => !document.querySelector('#main .loading') && !!document.querySelector('#pageTitle').textContent && document.querySelector('#pageTitle').textContent !== 'กำลังโหลด', null, { timeout: 15000 });
  const go = async (p, h) => { await p.evaluate(x => (location.hash = x), h); await p.waitForTimeout(300); };
  const title = p => p.locator('#pageTitle').textContent();
  const tabs = async p => (await p.locator('#tabbar a span').allTextContents()).map(x => x.trim());
  const login = async (p, sec, code) => { await p.locator(`button[data-act="gateRole"][data-v="${sec}"]`).click(); await p.waitForTimeout(150); await p.fill('#gate-code', code); await p.locator('form[data-form="gate"] button[type=submit]').click(); await p.waitForTimeout(500); };

  log('== staff device (not the link owner), codes set ==');
  const { p } = await mk(withCodes, true);
  await p.goto(URL + '#home'); await ready(p);
  ok(/เข้าใช้งานระบบจัดรถ SSC/.test(await p.locator('#main').textContent()) && await p.evaluate(() => document.body.classList.contains('locked')), 'gate shown, menus hidden');
  ok(await p.locator('button[data-act="gateRole"]').count() === 3, 'only departments with a code are offered (driver, checker, dispatch)');
  await p.screenshot({ path: OUT + '/access-gate.png' });
  await login(p, 'checker', '9999');
  ok(/รหัสไม่ถูกต้อง/.test(await p.locator('form[data-form="gate"] .errbox').textContent().catch(() => '')), 'wrong code refused');
  await p.fill('#gate-code', '2222'); await p.locator('form[data-form="gate"] button[type=submit]').click(); await p.waitForTimeout(500);
  ok((await p.evaluate(() => location.hash)) === '#parcels' && (await title(p)) === 'พัสดุรายบิล', 'checker lands on parcels');
  ok(JSON.stringify(await tabs(p)) === JSON.stringify(['พัสดุ', 'รับพัสดุ', 'ยิงบาร์โค้ด', 'แคชเชียร์', 'ออเดอร์', 'เพิ่มเติม']), 'checker menu: ' + (await tabs(p)).join(', '));
  for (const h of ['#dispatch', '#settings', '#trips', '#access', '#home']) { await go(p, h); ok((await title(p)) === 'พัสดุรายบิล', `checker cannot open ${h}`); }
  await go(p, '#cashier'); ok((await title(p)) === 'แคชเชียร์หน้าร้าน', 'checker opens the cashier');
  await go(p, '#more');
  const tiles = (await p.locator('.tile b').allTextContents()).join(',');
  ok(!/ค่าตั้งค่า|สิทธิ์และรหัส|จัดรถ|Maintenance/.test(tiles) && await p.locator('button[data-act="logout"]').count() === 1, 'more page has no other department tiles, only log out: ' + tiles);
  await p.screenshot({ path: OUT + '/access-checker.png' });
  await p.waitForTimeout(2500); // let the browser commit localStorage before an immediate reload
  await p.reload(); await ready(p);
  await p.waitForSelector('.modechip.secchip', { timeout: 6000 }).catch(() => {});
  ok((await title(p)) !== 'เข้าใช้งาน' && await p.locator('.modechip.secchip:has-text("เช็คเกอร์")').count() === 1, 'device remembers the department after reload');
  await p.locator('.modechip.secchip').click(); await p.waitForTimeout(200);
  await p.locator('#sheet button[data-act="logout"]').click(); await p.waitForTimeout(400);
  ok(/เข้าใช้งานระบบจัดรถ SSC/.test(await p.locator('#main').textContent()), 'log out returns to the gate');

  log('== driver link ==');
  await p.goto(URL + '#checkin'); await ready(p); await p.waitForTimeout(300);
  ok(await p.locator('#gate-code').count() === 1 && /คนขับ/.test(await p.locator('label[for="gate-code"]').textContent()), '#checkin link preselects the driver section');
  await p.fill('#gate-code', '1111'); await p.locator('form[data-form="gate"] button[type=submit]').click(); await p.waitForTimeout(500);
  ok(await p.evaluate(() => document.body.classList.contains('driver')) && await p.locator('form[data-form="checkin"]').count() === 1, 'driver sees the check-in page');
  await go(p, '#dispatch');
  ok((await title(p)) === 'เช็คอินคนขับ' && await p.locator('button[data-act="role"][data-v="dispatch"]').count() === 0 && await p.locator('button[data-act="logout"]').count() === 1, 'driver stays on check-in, no switch to dispatch, can log out');
  await p.locator('button[data-act="logout"]').first().click(); await p.waitForTimeout(400);

  log('== dispatch ==');
  await login(p, 'dispatch', '3333');
  ok((await title(p)) === 'ภาพรวม' && (await tabs(p)).includes('จัดรถ'), 'dispatch lands on home with the dispatch menu');
  for (const h of ['#settings', '#access', '#pending']) { await go(p, h); ok((await title(p)) === 'ภาพรวม', `dispatch cannot open ${h}`); }
  await go(p, '#dispatch'); ok((await title(p)) === 'จัดรถ / Matching', 'dispatch opens จัดรถ');
  await go(p, '#more'); ok(!/ค่าตั้งค่า|สิทธิ์และรหัส/.test((await p.locator('.tile b').allTextContents()).join(',')), 'no settings / access tiles for dispatch');
  // เฮีย changes the dispatch code from another device
  await p.evaluate(() => { const st = JSON.parse(localStorage.getItem('mockdb')); st['config/access'].codes.dispatch.h = 'changed'; localStorage.setItem('mockdb', JSON.stringify(st)); window.dispatchEvent(new StorageEvent('storage', { key: 'mockdb' })); });
  await p.waitForFunction(() => document.body.classList.contains('locked'), null, { timeout: 6000 }).catch(() => {});
  ok(/รหัสของแผนกนี้ถูกเปลี่ยนแล้ว/.test(await p.locator('#main').textContent()), 'changing a code logs that department out');
  for (let i = 0; i < 5; i++) { await p.fill('#gate-code', '0000'); await p.locator('form[data-form="gate"] button[type=submit]').click(); await p.waitForTimeout(150); }
  await p.fill('#gate-code', '3333'); await p.locator('form[data-form="gate"] button[type=submit]').click(); await p.waitForTimeout(200);
  ok(/รอ \d+ วินาที/.test(await p.locator('form[data-form="gate"] .errbox').textContent().catch(() => '')), 'five wrong codes → wait before trying again');

  log('== link owner sets the codes ==');
  const O = await mk(base, false);
  await O.p.goto(URL + '#access'); await ready(O.p);
  ok((await title(O.p)) === 'สิทธิ์และรหัสเข้าใช้' && /ยังไม่ได้ตั้งรหัส/.test(await O.p.locator('#main').textContent()), 'owner opens the access page; no codes yet');
  await O.p.fill('#ac-driver', '12'); await O.p.locator('form[data-sec="driver"] button[type=submit]').click(); await O.p.waitForTimeout(300);
  ok(/อย่างน้อย|4–20/.test(await O.p.locator('form[data-sec="driver"] .errbox, form[data-sec="driver"] ~ .errbox').first().textContent().catch(() => '') || await O.p.locator('.errbox').first().textContent().catch(() => '')), 'too-short code refused');
  await O.p.fill('#ac-driver', '5555'); await O.p.locator('form[data-sec="driver"] button[type=submit]').click(); await O.p.waitForTimeout(500);
  let st = await O.p.evaluate(() => JSON.parse(localStorage.getItem('mockdb')));
  const acc = st['config/access'];
  ok(acc && acc.salt && acc.codes.driver.h === sha(acc.salt, 'driver', '5555') && !JSON.stringify(acc).includes('5555'), 'code stored only as a salted hash');
  await O.p.fill('#ac-checker', '5555'); await O.p.locator('form[data-sec="checker"] button[type=submit]').click(); await O.p.waitForTimeout(400);
  ok(/ซ้ำกับ คนขับ/.test(await O.p.locator('#main').textContent()), 'same code for two departments refused');
  await go(O.p, '#settings'); ok((await title(O.p)) === 'ค่าตั้งค่า' && await O.p.locator('.modechip.secchip:has-text("เฮีย (เจ้าของ)")').count() === 1, 'owner keeps every page without a code');
  await O.p.screenshot({ path: OUT + '/access-owner.png', fullPage: true });

  log('== errors ==');
  errors.forEach(e => log('  ' + e));
  ok(errors.length === 0, 'no page errors');
  log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await browser.close(); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
