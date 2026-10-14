// V3 features in demo mode (phone width): fleet overview, route fuel + Feed Card, late parcels, Partner provinces,
// trailer rules, Dairy Plus arrival time, south hub consolidation, contract-cargo alert + urgent popup,
// back-haul pickup check-in, counter cashier with change, งานเหมา quotes.
// Usage: sh tests/wrap.sh app/index.html /tmp/page.html && node tests/v3-features.test.js <shots-dir> /tmp/page.html [libs-dir]
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2];
const URL = 'file://' + process.argv[3];
const LIBS = process.argv[4];
const log = (...a) => console.log(...a);
let fails = 0;
const ok = (cond, msg) => { if (cond) log('  PASS', msg); else { fails++; log('  FAIL', msg); } };
const KEY = 'ssc-demo-data-v6';
const dk = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptDownloads: true });
  await ctx.grantPermissions(['geolocation']).catch(() => {});
  await ctx.setGeolocation({ latitude: 9.0605, longitude: 99.0960, accuracy: 20 }).catch(() => {}); // a palm yard near ท่าฉาง
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('popup-test')) localStorage.setItem('ssc-popup', '"off"'); });
  if (LIBS) {
    await ctx.route('https://cdnjs.cloudflare.com/**', route => {
      const u = route.request().url();
      const f = u.includes('jsbarcode') ? 'JsBarcode.all.min.js' : u.includes('jspdf') ? 'jspdf.umd.min.js' : null;
      if (f) route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(LIBS + '/' + f) }); else route.abort();
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  const ready = () => page.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 15000 });
  await page.goto(URL); await ready();
  const go = async h => { await page.evaluate(x => (location.hash = x), h); await page.waitForTimeout(250); };
  const shot = async n => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const demo = async () => page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const edit = async fn => { await page.evaluate(([k, src]) => { const x = JSON.parse(localStorage.getItem(k)); (new Function('x', src))(x); localStorage.setItem(k, JSON.stringify(x)); }, [KEY, fn]); await page.reload(); await ready(); };
  const sheetOk = async () => { await page.locator('#sheet button[type=submit]').click(); await page.waitForTimeout(300); };
  const sheetErr = async () => (await page.locator('#sheet-err').textContent().catch(() => '')) || '';
  const img = OUT + '/v3-pixel.png';
  await page.screenshot({ path: img, clip: { x: 0, y: 0, width: 120, height: 120 } });

  log('== new pages render at 390 / 360 px ==');
  for (const w of [390, 360]) {
    await page.setViewportSize({ width: w, height: 844 });
    for (const h of ['fleet', 'quotes', 'quote-q1', 'cashier', 'receive', 'parcels', 'trips', 'trip-t20', 'trip-t21', 'settings', 'pending']) {
      await go('#' + h);
      const bad = await page.locator('#main .note.crit:has-text("แสดงผลไม่ได้")').count();
      const ov = await overflow();
      ok(ov <= 0 && bad === 0, `${w}px #${h} renders, no horizontal overflow (${ov})`);
      if (w === 390) await shot('v3-' + h);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });

  log('== fleet overview: every truck, what it does, where, maintenance ==');
  await go('#fleet');
  ok(await page.locator('#main .list .row').count() === 14, 'all 14 demo trucks listed');
  const r12 = page.locator('#main .list .row:has(.plate:text-is("70-1012"))');
  ok(/กำลังวิ่ง/.test(await r12.textContent()) && /ทริป T/.test(await r12.textContent()) && /ตอนนี้ อ\.บางสะพาน จ\.ประจวบคีรีขันธ์/.test(await r12.textContent()), 'running truck shows its trip, route and the province it is in now');
  ok(/กำลังไป สาขา/.test(await r12.textContent()), 'running truck shows the next stop it is heading to');
  ok(/รถที่กำลังวิ่งอยู่ในจังหวัด/.test(await page.locator('#main').textContent()), 'summary of provinces the running trucks are in');
  ok(await page.locator('#main .list .row:has(.plate:text-is("70-1010")) .chip.serious:has-text("ซ่อม")').count() === 1, 'truck under repair flagged');
  ok(await page.locator('#main .list .row .chip.crit:has-text("เกินรอบ")').count() >= 1, 'maintenance over-due chip on the fleet list');
  ok(await page.locator('#main .list .row:has(.plate:text-is("70-1005")) .chip:has-text("ใช้หางสำรอง 70-9005")').count() === 1, 'spare trailer shown on the truck');
  await page.locator('button.stat[data-act="fleetF"][data-v="run"]').click(); await page.waitForTimeout(200);
  ok(await page.locator('#main .list .row').count() === 2, 'filter: running trucks only (2)');
  await page.locator('button.stat[data-act="fleetF"][data-v="run"]').click(); await page.waitForTimeout(200);
  await page.fill('#fq', '1012'); await page.waitForTimeout(600);
  ok(await page.locator('#main .list .row').count() === 1, 'search by plate');
  await page.fill('#fq', ''); await page.waitForTimeout(500);
  await go('#home');
  ok(await page.locator('a.card[href="#fleet"] .chip:has-text("กำลังวิ่ง 2")').count() === 1, 'home has the all-trucks strip linking to the fleet page');

  log('== route fuel + Feed Card checklist ==');
  await go('#master'); await page.locator('button[data-act="masterTab"][data-v="routes"]').click(); await page.waitForTimeout(200);
  ok(/10 ล้อ 29 ล\. · 18 ล้อ 35 ล\. · 22 ล้อ 35 ล\./.test(await page.locator('.row:has-text("นครสวรรค์ → เดโปพิษณุโลก")').first().textContent()), 'route shows the fuel given per truck type (140 km ÷ 4.8 / 4)');
  await go('#trips');
  ok(await page.locator('section:has(h2:has-text("Feed Card")) .row').count() === 2, 'trips page lists the 2 active trips not keyed into Feed Card');
  await go('#trip-t22');
  ok(await page.locator('section:has(h2:has-text("Feed Card")) .chip.good:has-text("คีย์เข้า Feed Card แล้ว")').count() === 1, 'keyed trip shows done');
  await go('#trip-t20');
  ok(/205 ลิตร/.test(await page.locator('section:has(h2:has-text("Feed Card"))').textContent()), 'fuel to give for the trip = 820 km ÷ 4 = 205 L');
  await page.locator('button[data-act="feedKey"]').click(); await page.waitForTimeout(200);
  ok((await page.inputValue('#f-liters')) === '205', 'Feed Card sheet defaults to the litres to give');
  await page.fill('#f-card', 'FC-7712'); await sheetOk();
  let d = await demo();
  ok(d.trips.t20.feed && d.trips.t20.feed.liters === 205 && d.trips.t20.feed.card === 'FC-7712' && d.vehicles.v12.feedCard === 'FC-7712', 'Feed Card keyed saved on the trip and remembered on the truck');

  log('== late parcels ==');
  await go('#parcels'); await page.locator('button[data-act="parcelStatus"][data-v="late"]').click(); await page.waitForTimeout(200);
  const lateRow = page.locator('#main .list a.row').first();
  ok(/ช้า 1 วัน/.test(await lateRow.textContent()) && /ยังอยู่คลังสาย 3/.test(await lateRow.textContent()), 'late tab shows days late and where the bill is now');

  log('== contract cargo still at Sai 3 + urgent popup ==');
  await go('#home');
  if (await page.locator('button[data-act="homeAllAtt"]').count()) { await page.locator('button[data-act="homeAllAtt"]').click(); await page.waitForTimeout(200); }
  ok(await page.locator('#main .list .row:has-text("งานสัญญายังอยู่คลังสาย 3 ต้องโหลดวันนี้") .chip.crit').count() === 1, 'contract cargo that must load today is flagged');
  ok(await page.locator('#main .list .row:has-text("แจ้งล่วงหน้า 1 วัน")').count() === 1, 'one-day-ahead warning for contract cargo due to load tomorrow');
  ok(await page.locator('#main .list .row:has-text("ยังไม่ได้แจ้งทะเบียนโรงงาน") .chip.crit').count() >= 1 && /เลยเวลาแจ้งทะเบียนโรงงาน \(14:00/.test(await page.locator('#main .list').first().textContent()), 'missed 14:00 factory plate deadline is critical');
  ok(await page.locator('#main .list .row:has-text("ใช้หางสำรอง 70-9005")').count() === 1, 'spare trailer on a trip flagged on home');
  await page.evaluate(() => { sessionStorage.setItem('popup-test', '1'); localStorage.setItem('ssc-popup', '"on"'); });
  await page.reload(); await ready();
  await page.waitForSelector('#sheet:not([hidden]) h2:has-text("แจ้งเตือนด่วน")', { timeout: 12000 }).catch(() => {});
  const pop = await page.locator('#sheet:not([hidden])').textContent().catch(() => '');
  ok(/แจ้งเตือนด่วน/.test(pop) && /เลยเวลาแจ้งทะเบียนโรงงาน/.test(pop) && /ต้องโหลดวันนี้/.test(pop) && /หางสำรอง/.test(pop), 'urgent popup lists the factory deadline, contract cargo and spare trailers');
  await shot('v3-popup');
  await sheetOk();
  await page.reload(); await ready(); await page.waitForTimeout(2600);
  ok(await page.locator('#sheet:not([hidden])').count() === 0, 'popup does not repeat for items already shown');
  await page.evaluate(() => { sessionStorage.removeItem('popup-test'); localStorage.setItem('ssc-popup', '"off"'); });

  log('== Partner provinces need a Partner truck; spare trailer needs a reason ==');
  await go('#dispatch');
  await page.locator('button[data-act="dpLine"][data-v="south"]').click(); await page.waitForTimeout(200);
  await page.locator('label.pick:has-text("Partner ภูเก็ต") input').check(); await page.waitForTimeout(250);
  ok((await page.locator('button.pick:not([disabled]) .plate').first().textContent()) === '70-1013', 'a Partner truck is listed first for a Partner province');
  await page.locator('button.pick:has(.plate:text-is("70-1011"))').click(); await page.waitForTimeout(250);
  ok(await page.locator('.check.crit:has-text("ต้องใช้รถ Partner")').count() === 1, 'company truck to a Partner province fails the Partner check');
  ok(/ใช้หางสำรอง 70-9003/.test(await page.locator('.note.crit:has-text("หางสำรอง")').textContent().catch(() => '')), 'spare trailer from the check-in is flagged at dispatch');
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(300);
  let err = await page.locator('.errbox').textContent().catch(() => '');
  ok(/จังหวัด Partner/.test(err) && /เหตุผลที่ใช้หางสำรอง/.test(err), 'blocked until Partner override and spare-trailer reason');
  await page.fill('#dp-spr', 'หางประจำเข้าซ่อม'); await page.locator('input[data-bind="dp.partnerOk"]').check(); await page.fill('#dp-pr', 'Partner ไม่มีรถว่าง');
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(400);
  err = await page.locator('.errbox').textContent().catch(() => '');
  if (/ผู้อนุมัติ/.test(err)) { await page.fill('#dp-ab', 'ทดสอบ'); await page.fill('#dp-ar', 'ทดสอบ'); await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(400); }
  let h = await page.evaluate(() => location.hash);
  ok(h.startsWith('#trip-'), 'trip created after the reasons are given');
  d = await demo(); const tp = d.trips[h.slice(6)] || {};
  ok(tp.spareTrailer && tp.spareTrailer.plate === '70-9003' && tp.partnerOverride && /Partner ไม่มีรถว่าง/.test(tp.partnerOverride.reason), 'trip keeps the spare trailer and Partner override');
  ok(Object.values(d.trailers).some(x => x.trailerPlate === '70-9003' && x.vehicleId === 'v11' && x.status === 'out' && x.auto), 'spare trailer logged automatically');

  log('== driver and trailer are mandatory ==');
  await edit("x.vehicles.v13.trailerPlate = '';");
  await go('#dispatch'); await page.locator('button[data-act="dpLine"][data-v="south"]').click(); await page.waitForTimeout(200);
  await page.locator('label.pick:has-text("Partner ยะลา") input').check(); await page.waitForTimeout(200);
  await page.locator('button.pick:has(.plate:text-is("70-1013"))').click(); await page.waitForTimeout(200);
  await page.selectOption('#dp-driver', ''); await page.waitForTimeout(100);
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(300);
  err = await page.locator('.errbox').textContent().catch(() => '');
  ok(/เลือกคนขับ/.test(err) && /ใส่ทะเบียนหาง/.test(err), 'no driver / no trailer → cannot dispatch');

  log('== Dairy Plus charter needs the arrival time ==');
  await edit("x.orders.o2.unloadAt = null;");
  await go('#dispatch'); await page.locator('button[data-act="dpLine"][data-v="north"]').click(); await page.waitForTimeout(200);
  await page.locator('label.pick:has-text("เดโปชลบุรี") input').check(); await page.waitForTimeout(250);
  ok(await page.locator('label.req[for="dp-fha"]').count() === 1 && /ยังไม่กำหนด/.test(await page.locator('#dp-fha + .hint').textContent()), 'arrival time field required when the order has none');
  await page.locator('button.pick:not([disabled]):has(.plate:text-is("70-1001"))').click(); await page.waitForTimeout(200);
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(300);
  ok(/ต้องถึงปลายทาง/.test(await page.locator('.errbox').textContent().catch(() => '')), 'cannot dispatch without the arrival time');
  await page.fill('#dp-fha', dk(2) + 'T06:30'); await page.waitForTimeout(100);
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(400);
  err = await page.locator('.errbox').textContent().catch(() => '');
  if (/ผู้อนุมัติ/.test(err)) { await page.fill('#dp-ab', 'ทดสอบ'); await page.fill('#dp-ar', 'ทดสอบ'); await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(400); }
  h = await page.evaluate(() => location.hash); d = await demo();
  const tf = d.trips[h.slice(6)] || { jobs: [] };
  ok(h.startsWith('#trip-') && tf.jobs[0].unloadAt === dk(2) + 'T06:30' && d.orders.o2.unloadAt === dk(2) + 'T06:30', 'arrival time saved on the job and the order');
  ok(/ต้องถึงก่อน/.test(await page.locator('section:has(h2:has-text("ตำแหน่งและจุดส่ง")) .list').textContent()), 'trip shows the destination deadline');

  log('== south: one province per truck, combine along the road ==');
  await go('#dispatch'); await page.locator('button[data-act="dpLine"][data-v="south"]').click(); await page.waitForTimeout(250);
  const panel = await page.locator('details:has-text("รวมงานตามจังหวัด")').textContent();
  ok(/สาขาชุมพร/.test(panel) && /สาขาสุราษฎร์ธานี/.test(panel) && /ควบ/.test(panel), 'hub panel lists provinces with fill % and suggests combining');
  const hubs = (await page.locator('details:has-text("รวมงานตามจังหวัด") .list .row b').allTextContents()).map(x => x.trim());
  ok(hubs.indexOf('สาขาชุมพร') < hubs.indexOf('สาขาสุราษฎร์ธานี') && hubs.indexOf('สาขาสุราษฎร์ธานี') < hubs.indexOf('สาขานครศรีธรรมราช'), 'hubs in road order: ' + hubs.join(', '));
  await page.locator('details:has-text("รวมงานตามจังหวัด") .note button[data-act="dpHubs"]').first().click(); await page.waitForTimeout(250);
  ok(await page.locator('label.pick input:checked').count() >= 3, 'combo selects the orders and parcels of those provinces');
  await shot('v3-dispatch-hubs');
  const cand = page.locator('button.pick:not([disabled])').filter({ hasNot: page.locator('.chip.crit') }).first();
  await cand.click(); await page.waitForTimeout(250);
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(400);
  for (let i = 0; i < 3 && !(await page.evaluate(() => location.hash)).startsWith('#trip-'); i++) {
    err = await page.locator('.errbox').textContent().catch(() => '');
    if (/ผู้อนุมัติ/.test(err)) { await page.fill('#dp-ab', 'ทดสอบ'); await page.fill('#dp-ar', 'ทดสอบ'); }
    if (/ความจุ/.test(err)) await page.locator('input[data-bind="dp.confirmOver"]').check();
    if (/หางสำรอง/.test(err)) await page.fill('#dp-spr', 'ทดสอบ');
    if (/จังหวัด Partner/.test(err)) { await page.locator('input[data-bind="dp.partnerOk"]').check(); await page.fill('#dp-pr', 'ทดสอบ'); }
    await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(400);
  }
  h = await page.evaluate(() => location.hash); d = await demo();
  const ts = d.trips[h.slice(6)];
  const so = ts && ts.jobs.find(j => j.kind === 'SOUTH' && !j.parcel);
  const ordr = ['ชุมพร', 'สุราษฎร์', 'ทุ่งสง', 'นครศรี'];
  const seq = so ? so.destination.split(' → ').map(x => ordr.findIndex(k => x.includes(k))) : [];
  ok(!!so && seq.length >= 2 && seq.every((v, i) => i === 0 || v >= seq[i - 1]), 'combined trip stops sorted along the road: ' + (so ? so.destination : err));

  log('== back-haul pickup check-in (south) ==');
  await go('#trip-t20');
  await page.locator('button[data-act="pickupOpen"]').first().click(); await page.waitForTimeout(300);
  await page.fill('#pk-prod', 'ทลายปาล์ม'); await page.fill('#pk-dest', 'สมุทรสาคร'); await page.fill('#pk-kg', '32000');
  await sheetOk();
  ok(/เกิน/.test(await sheetErr()), 'over-weight from the weighbridge is refused');
  await page.fill('#pk-kg', '24500'); await sheetOk();
  ok(/รูปใบชั่ง/.test(await sheetErr()), 'weighbridge photo required');
  await page.setInputFiles('input[data-pk="scale"]', img); await page.waitForSelector('#pk-slot-scale.ok', { timeout: 8000 });
  await page.waitForTimeout(500); await sheetOk(); await page.waitForTimeout(500);
  d = await demo();
  const bh = d.trips.t20.jobs.find(j => j.pickup);
  ok(!!bh && bh.kind === 'BH' && bh.actualKg === 24500 && bh.destination === 'สมุทรสาคร' && /^data:image/.test(bh.pickup.photos.scale || '') && bh.pickup.loc && bh.pickup.loc.province === 'สุราษฎร์ธานี', 'pickup saved: product, weight, weighbridge photo, GPS province');
  ok(Object.values(d.trips.t20.arr || {}).some(a => a.loc && a.loc.province === 'สุราษฎร์ธานี'), 'pickup point marked as reached on the trip');
  ok(await page.locator('.row:has-text("ทลายปาล์ม") .chip.good:has-text("เช็คอินรับของ")').count() === 1 && await page.locator('.row:has-text("ทลายปาล์ม") .podthumbs img').count() === 1, 'job shows the pickup check-in and photo');
  await shot('v3-trip-pickup');

  log('== counter: receive → label → cashier with change ==');
  await go('#cashier');
  d = await demo();
  const p3 = d.parcels.p3, p1 = d.parcels.p1;
  await page.fill('#cash-in', p3.no + '-01'); await page.press('#cash-in', 'Enter'); await page.waitForTimeout(300);
  await page.fill('#cash-in', p1.no); await page.press('#cash-in', 'Enter'); await page.waitForTimeout(300);
  await page.fill('#cash-in', p3.no); await page.press('#cash-in', 'Enter'); await page.waitForTimeout(300);
  ok(/อยู่ในรายการแล้ว/.test(await page.locator('.scanbox .errbox').textContent().catch(() => '')), 'scanning the same bill twice is caught');
  ok(/฿220/.test(await page.locator('.cashtotal').textContent()) && /เก็บปลายทาง/.test(await page.locator('#main').textContent()), 'total = fee of the bill paid by the sender; COD bill not charged');
  await page.fill('#cash-recv', '100'); await page.waitForTimeout(150);
  ok(/ยังขาด ฿120/.test(await page.locator('#cash-change').textContent()), 'short cash shown');
  await page.locator('button[data-act="cashQuick"][data-v="500"]').click(); await page.waitForTimeout(150);
  ok(/เงินทอน ฿380/.test(await page.locator('#cash-change').textContent()), 'quick +500 → change ฿380');
  await page.fill('#cash-recv', '500'); await page.waitForTimeout(150);
  ok(/เงินทอน ฿280/.test(await page.locator('#cash-change').textContent()), 'change = 500 − 220 = ฿280');
  await page.locator('button[data-act="cashPay"]').click(); await page.waitForTimeout(400);
  d = await demo();
  ok(d.parcels.p3.paid && d.parcels.p3.paid.change === 280 && d.parcels.p3.paid.cash === 500 && !d.parcels.p1.paid, 'payment saved with cash and change');
  ok(/ทอน ฿280/.test(await page.locator('.paidbox').textContent()), 'cashier shows the change to give back');
  await shot('v3-cashier');

  log('== งานเหมา: quote for customer-chosen pickup and drop ==');
  await go('#quotes');
  ok(await page.locator('#main .list a.row').count() === 1, 'sample quote listed');
  await page.locator('button[data-act="quoteNew"]').click(); await page.waitForTimeout(300);
  await page.fill('#f-customer', 'ลูกค้าทดสอบงานเหมา'); await page.fill('#f-pickName', 'Dairy Plus นครสวรรค์'); await page.fill('#f-dropName', 'เดโปพิษณุโลก');
  await page.fill('#f-toll', '60'); await page.fill('#f-allowance', '300'); await page.waitForTimeout(250);
  const pv = await page.locator('#q-preview').textContent();
  ok(/140 กม\./.test(pv) && /Standard KM/.test(pv) && /70 ลิตร/.test(pv) && /฿3,200/.test(pv), 'preview: 140 km from Standard KM, return empty → 70 L, price ฿3,200 (' + pv.replace(/\s+/g, ' ').slice(0, 160) + ')');
  await sheetOk(); await page.waitForTimeout(300);
  h = await page.evaluate(() => location.hash);
  ok(h.startsWith('#quote-'), 'saved quote opens');
  ok(/ราคาเหมาเที่ยวนี้ ฿3,200/.test(await page.locator('pre').textContent()), 'customer message has the price');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.locator('button[data-act="quotePdf"]').click()]);
  const buf = fs.readFileSync(await dl.path());
  ok(buf.slice(0, 4).toString() === '%PDF' && buf.length > 20000, `quote PDF downloaded (${buf.length} bytes)`);
  fs.copyFileSync(await dl.path(), OUT + '/quote.pdf');
  await page.locator('button[data-act="quoteWin"]').click(); await page.waitForTimeout(200); await sheetOk();
  d = await demo();
  const qn = Object.values(d.quotes).find(q => q.customer === 'ลูกค้าทดสอบงานเหมา');
  const on = qn && d.orders[qn.orderId];
  ok(qn && qn.status === 'won' && on && on.kind === 'CHARTER' && on.revenue === 3200 && on.origin === 'Dairy Plus นครสวรรค์' && on.destination === 'เดโปพิษณุโลก', 'customer accepted → charter order created for dispatch');
  await go('#orders');
  ok(await page.locator('.row:has-text("ลูกค้าทดสอบงานเหมา") .kind:has-text("งานเหมา")').count() === 1, 'charter order listed as งานเหมา');

  log('== settings keep the new values ==');
  await go('#settings');
  ok((await page.inputValue('#s-nb')) === '14:00' && (await page.inputValue('#s-fp')) === '32', 'plate deadline 14:00 and fuel price shown');
  await page.fill('#s-fp', '33.5'); await page.locator('form[data-form="settings"] button[type=submit]').click(); await page.waitForTimeout(300);
  d = await demo();
  ok(d.config.settings.fuelPrice === 33.5 && d.config.settings.notifyBy === '14:00' && d.config.settings.timeMatchAt === 'Dairy Plus นครสวรรค์', 'saving settings keeps every rule');

  log('== dark ==');
  await page.emulateMedia({ colorScheme: 'dark' });
  await go('#fleet'); await shot('v3-fleet-dark');
  await go('#cashier'); await shot('v3-cashier-dark');

  log('== errors ==');
  errors.forEach(e => log('  ' + e));
  ok(errors.length === 0, 'no page/console errors');
  log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
