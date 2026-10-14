// Round tests for the V2 draft: every page + main flows in demo mode (phone width), parcels/labels/scan,
// north/south lines and the 10:00 back-haul queue rule, plus desktop and dark screenshots.
// Usage: sh tests/wrap.sh app/index.html /tmp/page.html && node tests/app-flows.test.js <shots-dir> /tmp/page.html [libs-dir]
// libs-dir holds JsBarcode.all.min.js and jspdf.umd.min.js (served in place of cdnjs when the CDN is unreachable).
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2];
const URL = 'file://' + process.argv[3];
const LIBS = process.argv[4];
const log = (...a) => console.log(...a);
let fails = 0;
const ok = (cond, msg) => { if (cond) log('  PASS', msg); else { fails++; log('  FAIL', msg); } };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptDownloads: true });
  // phone GPS: start at Chumphon (moved per step below)
  await ctx.grantPermissions(['geolocation']).catch(() => {});
  await ctx.setGeolocation({ latitude: 10.4930, longitude: 99.1800, accuracy: 20 }).catch(() => {});
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
  await page.goto(URL);
  await page.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 15000 });
  const go = async h => { await page.evaluate(x => (location.hash = x), h); await page.waitForTimeout(250); };
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const shot = async n => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
  const demo = async () => page.evaluate(() => JSON.parse(localStorage.getItem('ssc-demo-data-v5')));
  const waitDemo = async (pred, ms = 9000) => { const t0 = Date.now(); let d = null; while (Date.now() - t0 < ms) { d = await demo(); try { if (pred(d)) return d; } catch {} await page.waitForTimeout(150); } return d; };
  const podFill = async () => {
    const img = OUT + '/m-home.png';
    for (const k of ['bill', 'goods', 'empty']) { await page.setInputFiles(`input[data-pod="${k}"]`, img); await page.waitForSelector(`#pod-slot-${k}.ok`, { timeout: 8000 }); }
    const box = await page.locator('#pod-sig').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.7, { steps: 10 }); await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3, { steps: 10 }); await page.mouse.up();
  };
  const sheetOk = async () => { await page.locator('#sheet button[type=submit]').click(); await page.waitForTimeout(250); };

  log('== pages (demo, phone 390 & 360) ==');
  ok(await page.locator('.banner').count() === 1, 'demo banner shown on first open with no real data');
  ok(await page.evaluate(() => !!window.JsBarcode), 'barcode library loaded');
  const pages = ['home', 'queue', 'checkin', 'orders', 'parcels', 'receive', 'scan', 'parcel-p1', 'dispatch', 'trips', 'trip-t20', 'maint', 'master', 'trailers', 'settings', 'spec', 'pending', 'more'];
  for (const w of [390, 360]) {
    await page.setViewportSize({ width: w, height: 844 });
    for (const h of pages) {
      await go('#' + h);
      const ov = await overflow();
      const bad = await page.locator('#main .note.crit:has-text("แสดงผลไม่ได้")').count();
      ok(ov <= 0 && bad === 0, `${w}px #${h} renders, no horizontal overflow (${ov})`);
      if (w === 390) await shot('m-' + h);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });

  log('== home line filter ==');
  await go('#home');
  ok(await page.locator('h2:has-text("พัสดุรายบิล")').count() === 1, 'parcel summary on all lines');
  await page.locator('button[data-act="homeLine"][data-v="north"]').click(); await page.waitForTimeout(200);
  ok(await page.locator('h2:has-text("พัสดุรายบิล")').count() === 0 && await page.locator('h2:has-text("Southern Load Planning")').count() === 0, 'north view hides southern sections');
  await page.locator('button[data-act="homeLine"][data-v="all"]').click(); await page.waitForTimeout(150);

  log('== due dates ==');
  ok(/ต้องถึงลูกค้าวันนี้/.test(await page.locator('#main .list').first().textContent()), 'home flags an order due today that has no truck yet');
  ok(/ยังไม่ได้แจ้งทะเบียนโรงงาน/.test(await page.locator('#main .list').first().textContent()), 'home flags a planned trip whose plate was not sent to the factory');
  await go('#orders');
  ok(/นมชุมพร/.test(await page.locator('#main .list .row').first().textContent()), 'orders sorted by due date (due today first)');
  ok(await page.locator('.row:has-text("นมชุมพร") .chip.crit:has-text("ต้องถึงลูกค้าวันนี้")').count() === 1, 'order row shows due-today chip');

  log('== queue: 10:00 back-haul rule ==');
  await go('#queue');
  const groups = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#main section.sec')].find(s => s.querySelector('h2') && s.querySelector('h2').textContent.includes('คลังพุทธมณฑลสาย 3'));
    return [...sec.querySelectorAll('.row')].map(r => { const t = r.textContent; return t.includes('Backhaul ทันรอบ') ? 0 : t.includes('Backhaul มาหลังรอบ') ? 2 : t.includes('สแตนด์บาย') ? 1 : -1; });
  });
  ok(groups.length >= 5 && groups.every((g, i) => g >= 0 && (i === 0 || g >= groups[i - 1])), 'south queue ordered: Backhaul on time → standby → Backhaul late ' + JSON.stringify(groups));
  ok(await page.locator('h2:has-text("ปั๊มนครสวรรค์")').count() === 1, 'north check-in point (pump) has its own queue');

  log('== check-in at Sai 3 asks about back-haul ==');
  await go('#checkin');
  await page.selectOption('#ci-site', 's3'); await page.waitForTimeout(200);
  await page.selectOption('#ci-driver', 'd14'); await page.waitForTimeout(150);
  await page.selectOption('#ci-veh', 'v14'); await page.waitForTimeout(150);
  await page.fill('#ci-loctext', '13.7885, 100.3170'); await page.waitForTimeout(100);
  await page.locator('form[data-form="checkin"] button[type=submit]').click(); await page.waitForTimeout(250);
  ok(/Backhaul/.test(await page.locator('.errbox').textContent().catch(() => '')), 'must answer back-haul question at Sai 3');
  await page.locator('input[name="ci-bh"][value="yes"]').check(); await page.waitForTimeout(100);
  await page.fill('#ci-loctext', '13.7885, 100.3170'); await page.waitForTimeout(100);
  await page.locator('form[data-form="checkin"] button[type=submit]').click(); await page.waitForTimeout(300);
  ok(await page.locator('.ticket .big').count() === 1 && /Backhaul (ทันรอบ|มาหลังรอบ)|สแตนด์บาย/.test(await page.locator('.ticket').textContent()), 'ticket shows queue group');
  await shot('m-ticket');
  await page.locator('button[data-act="ciNew"]').first().click(); await page.waitForTimeout(150);
  await page.selectOption('#ci-site', 'pump'); await page.waitForTimeout(200);
  ok(await page.locator('input[name="ci-bh"]').count() === 0, 'pump (north) has no back-haul cut-off question');

  log('== dispatch north ==');
  await go('#dispatch');
  await page.locator('button[data-act="dpLine"][data-v="north"]').click(); await page.waitForTimeout(200);
  ok(await page.locator('label.pick:has-text("พัสดุ")').count() === 0, 'no parcel groups on north line');
  await page.locator('label.pick:has-text("เดโปพิษณุโลก") input').check(); await page.waitForTimeout(200);
  const recoN = await page.locator('.pick:has(.reco) .plate').first().textContent().catch(() => '');
  ok(recoN === '70-1002' || recoN === '70-1001', `recommended north truck is a 22-wheeler from the pump queue (${recoN})`);
  const bases = (await page.locator('button.pick .ln').allTextContents()).map(x => x.trim());
  ok(bases.slice(0, 3).every(x => x === 'ฐานเหนือ') && bases.includes('ฐานใต้'), 'north line: north-base trucks first, south-base trucks still listed (' + bases.slice(0, 5).join(',') + ')');
  ok(await page.locator('button.pick:has(.plate:text-is("70-1007")) .chip:has-text("มาเสริมสายเหนือ")').count() === 1, 'a south-base truck can reinforce the north line');
  ok(await page.locator('button.pick:not([disabled]):has(.plate:text-is("70-1004")) .chip.good:has-text("ว่างหลัง")').count() === 1, 'truck unloading at 08:00 is offered for a 10:00 load (2 h buffer)');
  await page.fill('#dp-lt', '09:00'); await page.waitForTimeout(250);
  ok(await page.locator('button.pick[disabled]:has(.plate:text-is("70-1004")) .chip.crit:has-text("ชนเวลาโหลด")').count() === 1, 'same truck blocked when the load time overlaps');
  await page.fill('#dp-lt', '10:00'); await page.waitForTimeout(250);
  await page.locator('label.pick:has-text("เดโปชลบุรี") input').check(); await page.waitForTimeout(200);
  await page.locator('button.pick:not([disabled]):has(.plate:text-is("70-1001"))').click(); await page.waitForTimeout(200);
  ok(await page.locator('.check.crit:has-text("น้ำหนักบรรทุก")').count() === 1, 'two full loads exceed the 30 t payload of a 22-wheeler');
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(250);
  ok(/น้ำหนักเกิน/.test(await page.locator('.errbox').textContent().catch(() => '')), 'over-weight trip cannot be created');
  await page.locator('label.pick:has-text("เดโปชลบุรี") input').uncheck(); await page.waitForTimeout(200);
  await page.locator('label.pick:has-text("เดโปพิษณุโลก") input').uncheck(); await page.locator('label.pick:has-text("กระดาษ ASA") input').check(); await page.waitForTimeout(250);
  ok(await page.locator('button.pick[disabled]:has(.plate:text-is("70-1004")) .chip:has-text("จับคู่เวลาได้เฉพาะงานโหลดที่ Dairy Plus นครสวรรค์")').count() === 1, 'unload→load time matching only for loads at Dairy Plus นครสวรรค์ (ASA load keeps a busy truck blocked)');
  await page.locator('label.pick:has-text("กระดาษ ASA") input').uncheck(); await page.waitForTimeout(150);

  log('== dispatch south with parcels ==');
  await page.locator('button[data-act="dpLine"][data-v="south"]').click(); await page.waitForTimeout(200);
  ok(/นมชุมพร/.test(await page.locator('label.pick').first().textContent()), 'dispatch lists earliest due date first');
  await page.locator('label.pick:has-text("Partner ภูเก็ต") input').check(); await page.waitForTimeout(150);
  await page.locator('label.pick:has-text("นมชุมพร") input').check(); await page.waitForTimeout(200);
  ok(/เลยกำหนดส่ง/.test(await page.locator('.note.crit').first().textContent().catch(() => '')), 'warns when departure date is after the due date');
  await page.fill('#dp-date', await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })); await page.waitForTimeout(250);
  ok(/ไม่ถึง 3 วัน|วันเดียวกับกำหนดส่ง/.test(await page.locator('.note.warn').first().textContent().catch(() => '')), 'departure too close to the due date gets a warning (hub needs up to 3 days)');
  const tmrKey = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  ok((await page.inputValue('#dp-arr').catch(() => '')) === tmrKey && /07:00/.test(await page.locator('label[for="dp-arr"]').textContent()), 'south load asks for the hub arrival date (before 07:00, default next morning)');
  ok(await page.locator('button.pick[disabled]:has(.plate:text-is("70-1012")) .chip:has-text("จับคู่เวลาได้เฉพาะ")').count() === 1, 'busy south truck is not time-matched (rule is Dairy Plus only)');
  const tot = await page.locator('#dp-totals').textContent();
  ok(/2\s*พัสดุ/.test(tot) || /\+ 2 พัสดุ/.test(tot), 'totals include parcels: ' + tot.replace(/\s+/g, ' '));
  await page.locator('.pick:has(.reco)').first().click(); await page.waitForTimeout(200);
  await shot('m-dispatch-south');
  const before = await page.evaluate(() => location.hash);
  await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(500);
  let h = await page.evaluate(() => location.hash);
  if (!h.startsWith('#trip-')) {
    const err = await page.locator('.errbox').textContent().catch(() => '');
    if (/ผู้อนุมัติ/.test(err)) { await page.fill('#dp-ab', 'ทดสอบ'); await page.fill('#dp-ar', 'ทดสอบ'); }
    if (/ความจุ/.test(err)) await page.locator('input[data-bind="dp.confirmOver"]').check();
    await page.locator('button[data-act="createTrip"]').click(); await page.waitForTimeout(500);
    h = await page.evaluate(() => location.hash);
  }
  ok(h.startsWith('#trip-') && h !== before, 'south trip with parcels created');
  const tripId = h.slice(6);
  let dd = await demo();
  ok(dd.parcels.p1.tripId === tripId && dd.parcels.p2.tripId === tripId, 'parcels assigned to the new trip');
  ok(dd.trips[tripId].arriveDate === tmrKey, 'south trip stores the hub arrival date');
  ok(await page.locator('.row:has-text("พัสดุรายบิล")').count() === 1, 'trip shows parcel job');

  log('== scan station ==');
  await page.locator('a[data-act="scanForTrip"]').first().click(); await page.waitForTimeout(300);
  ok((await page.evaluate(() => location.hash)) === '#scan' && (await page.inputValue('#sc-trip')) === tripId, 'scan page opens with this trip selected');
  const no1 = dd.parcels.p1.no;
  const scan = async code => { await page.fill('#scan-in', code); await page.press('#scan-in', 'Enter'); await page.waitForTimeout(250); return page.locator('.log .row').first().textContent(); };
  ok(/ขึ้นรถ 1\/3/.test(await scan(no1 + '-01')), 'box 1/3 loaded');
  ok(/ยิงซ้ำ/.test(await scan(no1 + '-01')), 'duplicate scan warned');
  ok(/ไม่พบ/.test(await scan('S9901010001-01')), 'unknown number rejected');
  ok(/รูปแบบ/.test(await scan('HELLO')), 'bad format rejected');
  ok(/เลขกล่อง/.test(await scan(no1 + '-09')), 'box number beyond count rejected');
  ok(/ครบแล้ว/.test(await scan(no1)), 'number without box loads all boxes');
  ok((await page.inputValue('#scan-in')) === '' && await page.evaluate(() => document.activeElement && document.activeElement.id === 'scan-in'), 'input cleared and keeps focus for the next scan');
  dd = await demo();
  ok(dd.parcels.p1.status === 'loaded', 'parcel status loaded after all boxes');
  await page.locator('button[data-act="scanMode"][data-v="arrived"]').click(); await page.waitForTimeout(200);
  await page.selectOption('#sc-br', 'br-hkt');
  ok(/ถึงปลายทาง 3\/3/.test(await scan(no1)), 'arrival scan for all boxes');
  dd = await demo();
  ok(!!(dd.trips[tripId].arr && dd.trips[tripId].arr['b_br-hkt'] && dd.trips[tripId].arr['b_br-hkt'].src === 'scan'), 'arrival scan at the hub records the truck arrival time for that stop');
  await page.locator('button[data-act="scanMode"][data-v="delivered"]').click(); await page.waitForTimeout(200);
  await scan(no1);
  ok(await page.locator('button[data-act="scanDeliver"]').count() === 1, 'deliver mode asks for receiver name');
  await page.locator('input[data-bind="scan.codOk"]').check();
  await page.fill('#sc-pod', 'คนรับทดสอบ');
  await page.locator('button[data-act="scanDeliver"]').click(); await page.waitForTimeout(300);
  dd = await demo();
  ok(dd.parcels.p1.status === 'delivered' && dd.parcels.p1.codCollected === true && dd.parcels.p1.podName === 'คนรับทดสอบ', 'delivered with COD collected and receiver name');
  await shot('m-scan');

  log('== receive parcel + labels ==');
  await go('#receive');
  ok((await page.inputValue('#rc-due')) !== '', 'misc parcel gets a default due date (+3 days)');
  await page.locator('input[name="rc-cat"][value="ขนม"]').check(); await page.waitForTimeout(250);
  ok((await page.inputValue('#rc-due')) === '' && (await page.inputValue('#rc-sn')) === 'อาหารยอดคุณ', 'snack contract clears due date (from bill) and fills the sender');
  await page.locator('input[name="rc-cat"][value="เบ็ดเตล็ด"]').check(); await page.waitForTimeout(250);
  await page.fill('#rc-sn', '');
  await page.locator('form[data-form="receive"] button[type=submit]').click(); await page.waitForTimeout(200);
  ok(/กรอกให้ครบ/.test(await page.locator('.errbox').textContent().catch(() => '')), 'receive form validates');
  await page.fill('#rc-sn', 'ร้านทดสอบส่ง'); await page.fill('#rc-sp', '0811111111');
  await page.fill('#rc-rn', 'คุณทดสอบรับ'); await page.fill('#rc-rp', '0822222222');
  await page.selectOption('#rc-pv', 'ยะลา'); await page.waitForTimeout(250);
  ok((await page.inputValue('#rc-br')) === 'br-yla', 'branch auto-selected from province');
  await page.fill('#rc-bx', '3'); await page.fill('#rc-w', '27.5'); await page.fill('#rc-fee', '250');
  await page.locator('input[name="rc-pay"][value="cod"]').check();
  await page.locator('form[data-form="receive"] button[type=submit]').click(); await page.waitForTimeout(500);
  ok((await page.evaluate(() => location.hash)).startsWith('#parcel-'), 'goes to parcel detail after save');
  ok(await page.locator('.label').count() === 3, 'one label per box');
  ok(await page.locator('.label svg.bc rect').count() > 20, 'barcodes drawn on labels');
  const trk = (await page.locator('h2.trk').textContent()).trim();
  ok(/^S\d{10}$/.test(trk), 'tracking number format ' + trk);
  ok(/ส่งภายใน/.test(await page.locator('.label').first().textContent()), 'label shows the due date');
  await shot('m-parcel-labels');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.locator('button[data-act="labelsPdf"]').click()]);
  const pth = await dl.path(); const buf = fs.readFileSync(pth);
  ok(buf.slice(0, 4).toString() === '%PDF' && buf.length > 5000, `label PDF downloaded (${dl.suggestedFilename()}, ${buf.length} bytes)`);
  fs.copyFileSync(pth, OUT + '/labels.pdf');

  log('== Checker sorts store milk ==');
  await go('#orders');
  await page.locator('button[data-act="ordStatus"][data-v="all"]').click(); await page.waitForTimeout(150);
  await page.locator('.row:has-text("DP-ตย-210") button[data-act="sortStore"]').click(); await page.waitForTimeout(200);
  await page.fill('#srt-text', 'จังหวัด\tร้าน\tกำหนดส่ง\tชิ้น\tพาเลท\tน้ำหนัก(กก.)\tรายได้\nภูเก็ต\tร้านทดสอบ A\t20/10/2569\t300\t4\t4500\t6000\nตรัง\tร้านทดสอบ B\t\t120\t2\t1800\t2600');
  await page.waitForTimeout(150);
  ok(/จะสร้าง 2/.test(await page.locator('#srt-preview').textContent()) && /มีกำหนดส่งในตาราง 1 แถว/.test(await page.locator('#srt-preview').textContent()), 'sort preview counts rows and due dates');
  await sheetOk();
  ok(/ระบุกำหนดส่ง/.test(await page.locator('#sheet-err').textContent()), 'rows without a due date are refused');
  await page.fill('#srt-due', '2026-10-21');
  await sheetOk();
  dd = await demo();
  const kids = Object.values(dd.orders).filter(o => o.parentId === 'o3');
  ok(kids.length === 2 && kids.some(o => o.customer === 'นมภูเก็ต ร้านทดสอบ A' && o.kind === 'SOUTH' && o.line === 'south'), 'creates south orders named นม+จังหวัด+ร้าน');
  ok(kids.find(o => o.customer.includes('ร้านทดสอบ A')).dueDate === '2026-10-20' && kids.find(o => o.customer.includes('ร้านทดสอบ B')).dueDate === '2026-10-21', 'due date from the table (Thai year) or the default');

  log('== factory notice ==');
  await go('#trips');
  ok(await page.locator('h2:has-text("แจ้งทะเบียนโรงงาน")').count() === 1 && /แจ้งทะเบียนรถเข้าโหลด/.test(await page.locator('pre').first().textContent()), 'trips page lists plates to send to the factory');
  await page.locator('button[data-act="notifyGroup"]').first().click(); await page.waitForTimeout(300);
  dd = await demo();
  ok(!!dd.trips.t21.notifiedAt, 'marked as sent to the factory');
  await go('#trip-t20');
  ok(await page.locator('h2:has-text("แจ้งทะเบียนโรงงาน")').count() === 0, 'a trip loading at the company warehouse (สาย 3) needs no factory notice');

  log('== running trucks: where now + hub arrival before 07:00 ==');
  await go('#home');
  ok(await page.locator('h2:has-text("รถกำลังวิ่ง")').count() === 1, 'home has a running-trucks board');
  const run12 = await page.locator('#main .row:has(.plate:text-is("70-1012")):has-text("ต่อไป")').first().textContent().catch(() => '');
  ok(/อ\.บางสะพาน จ\.ประจวบคีรีขันธ์/.test(run12) && /ต่อไป สาขาชุมพร/.test(run12) && /คลังพุทธมณฑลสาย 3/.test(run12), 'running row shows origin → stops, current อำเภอ/จังหวัด and next hub: ' + run12.replace(/\s+/g, ' ').slice(0, 160));
  await go('#trip-t20');
  ok(await page.locator('h2:has-text("ตำแหน่งและจุดส่ง")').count() === 1, 'trip detail has a position + stops card');
  const stopTxt = await page.locator('section:has(h2:has-text("ตำแหน่งและจุดส่ง")) .list').textContent();
  ok(['สาขาชุมพร', 'สาขาสุราษฎร์ธานี', 'สาขาทุ่งสง', 'สาขานครศรีธรรมราช'].every(x => stopTxt.includes(x)) && (stopTxt.match(/07:00/g) || []).length >= 4, 'southern stops resolved to hubs, each due before 07:00');
  const posSubmit = async (field, val) => {
    const det = page.locator('details:has(form[data-form="pos"])'); if (await det.count() && !(await det.evaluate(e => e.open))) await det.locator('summary').click();
    await page.fill(`#pf-${field}-t20`, val); await page.locator('form[data-form="pos"] button[type=submit]').click(); await page.waitForTimeout(250);
    return (await demo()).trips.t20;
  };
  let t20 = await posSubmit('loc', '9.1382, 99.3215');
  ok(t20.pos.district === 'เมืองสุราษฎร์ธานี' && t20.pos.province === 'สุราษฎร์ธานี' && t20.pos.src === 'map' && t20.posLog.length === 4, 'pasted coordinates → อ.เมืองสุราษฎร์ธานี จ.สุราษฎร์ธานี');
  t20 = await posSubmit('loc', 'https://www.google.com/maps/@7.0086,100.4747,15z');
  ok(t20.pos.district === 'หาดใหญ่' && t20.pos.province === 'สงขลา', 'Google Maps link → อ.หาดใหญ่ จ.สงขลา');
  t20 = await posSubmit('loc', '8.1636, 99.6800');
  ok(t20.pos.district === 'ทุ่งสง' && t20.pos.province === 'นครศรีธรรมราช', 'Thung Song coordinates → อ.ทุ่งสง');
  t20 = await posSubmit('loc', '13.7563, 100.5018');
  ok(t20.pos.province === 'กรุงเทพมหานคร' && /เขต.+กรุงเทพฯ/.test(await page.locator('section:has(h2:has-text("ตำแหน่งและจุดส่ง"))').textContent()), 'Bangkok shows as เขต… กรุงเทพฯ');
  await posSubmit('loc', '1.3521, 103.8198');
  ok(/นอกประเทศไทย/.test(await page.locator('form[data-form="pos"] .errbox').textContent().catch(() => '')), 'coordinates outside Thailand rejected');
  await page.fill('#pf-loc-t20', '');
  t20 = await posSubmit('place', 'อ.ท่าชนะ จ.สุราษฎร์ธานี');
  ok(t20.pos.district === 'ท่าชนะ' && t20.pos.src === 'manual' && t20.pos.lat === null, 'district picked from the list (when calling the driver)');
  await posSubmit('place', 'อำเภอที่ไม่มีจริง');
  ok(/ไม่พบชื่ออำเภอ/.test(await page.locator('form[data-form="pos"] .errbox').textContent().catch(() => '')), 'unknown district rejected');
  await page.locator('button[data-act="stopArrive"][data-k="b_br-cpn"]').click();
  t20 = (await waitDemo(x => x.trips.t20.arr && x.trips.t20.arr['b_br-cpn'])).trips.t20; await page.waitForTimeout(200);
  ok(!!(t20.arr && t20.arr['b_br-cpn'] && t20.arr['b_br-cpn'].at), 'dispatcher marks arrival at สาขาชุมพร');
  ok(!!(t20.arr['b_br-cpn'].loc && t20.arr['b_br-cpn'].loc.district === 'เมืองชุมพร'), 'pressing "ถึงแล้ว" also records the GPS position (' + JSON.stringify(t20.arr['b_br-cpn'].loc && t20.arr['b_br-cpn'].loc.district) + ')');
  ok(await page.locator('section:has(h2:has-text("ตำแหน่งและจุดส่ง")) .row:has-text("สาขาชุมพร") .chip.good:has-text("กำลังลงของ")').count() === 1, 'arrived before 07:00 shows as on time, then unloading');
  await page.locator('button[data-act="stopUndo"][data-k="b_br-cpn"]').click(); await page.waitForTimeout(250);
  ok(!((await demo()).trips.t20.arr || {})['b_br-cpn'], 'arrival can be undone');
  await page.locator('button[data-act="stopArrive"][data-k="b_br-cpn"]').click();
  await waitDemo(x => x.trips.t20.arr && x.trips.t20.arr['b_br-cpn']); await page.waitForTimeout(200);
  const d2 = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 2); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await page.fill('#ad-t20', d2); await page.locator('form[data-form="arrDate"] button[type=submit]').click(); await page.waitForTimeout(250);
  ok((await demo()).trips.t20.arriveDate === d2, 'hub arrival date can be changed on the trip');

  log('== ส่งงาน: unload done with photos, signature and GPS ==');
  await page.locator('button[data-act="podOpen"][data-k="b_br-cpn"]').click(); await page.waitForTimeout(300);
  ok(/ส่งงาน · สาขาชุมพร/.test(await page.locator('#sheet h2').textContent()), 'ลงของเสร็จ opens the ส่งงาน form');
  await page.locator('#sheet button[type=submit]').click(); await page.waitForTimeout(300);
  ok(/ยังขาด: รูปบิล \/ ใบส่งของ, รูปสินค้าที่ลง, รูปรถว่างหลังลงของ, ลายเซ็นผู้รับ/.test(await page.locator('#sheet-err').textContent()), 'bill, goods, empty-truck photos and signature are required');
  await podFill();
  await page.locator('button[data-act="sigClear"]').click(); await page.waitForTimeout(200);
  ok(await page.locator('#sheet form[data-sheet]').count() === 1, '"ล้างลายเซ็น" keeps the ส่งงาน form open');
  await page.locator('#sheet button[type=submit]').click(); await page.waitForTimeout(300);
  ok(/ยังขาด: ลายเซ็นผู้รับ$/.test((await page.locator('#sheet-err').textContent()).trim()), 'cleared signature must be signed again (photos kept)');
  { const box = await page.locator('#pod-sig').boundingBox(); await page.mouse.move(box.x + 30, box.y + 50); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 12 }); await page.mouse.up(); }
  await page.fill('#pod-recv', 'คุณรับของ ทดสอบ');
  await shot('m-pod-sheet');
  await page.locator('#sheet button[type=submit]').click();
  t20 = (await waitDemo(x => x.trips.t20.arr['b_br-cpn'].doneAt)).trips.t20; await page.waitForTimeout(300);
  const pa = t20.arr['b_br-cpn'];
  ok(!!pa.doneAt && Object.keys(pa.photos || {}).sort().join() === 'bill,empty,goods,sign' && Object.values(pa.photos).every(v => /^data:image\/(jpeg|png)/.test(v)), 'unload done saved with bill, goods, empty-truck photos and the signature');
  ok(pa.recv === 'คุณรับของ ทดสอบ' && pa.doneLoc && pa.doneLoc.district === 'เมืองชุมพร', 'ส่งงาน records the receiver and where it was pressed');
  ok(await page.locator('section:has(h2:has-text("ตำแหน่งและจุดส่ง")) .row:has-text("สาขาชุมพร") .podthumbs img').count() === 4 && await page.locator('section:has(h2:has-text("ตำแหน่งและจุดส่ง")) .row:has-text("สาขาชุมพร") .chip:has-text("ลงของเสร็จ")').count() === 1, 'trip shows the 4 proof pictures and the unload time');
  await shot('m-trip-track');
  // late: due date already passed and the truck has not reached สุราษฎร์
  await page.evaluate(() => { const k = 'ssc-demo-data-v5'; const x = JSON.parse(localStorage.getItem(k)); const d = new Date(); d.setDate(d.getDate() - 1); x.trips.t20.arriveDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; x.trips.t20.date = x.trips.t20.arriveDate; localStorage.setItem(k, JSON.stringify(x)); });
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 15000 });
  await go('#home');
  if (await page.locator('button[data-act="homeAllAtt"]').count()) { await page.locator('button[data-act="homeAllAtt"]').click(); await page.waitForTimeout(200); }
  ok(await page.locator('#main .list .row:has-text("ยังไม่ถึง สาขาสุราษฎร์ธานี") .chip.crit').count() === 1, 'home flags a truck that missed the 07:00 hub time');
  ok(/เข้าสาขาทันก่อน 07:00 น\.\s*\d+%/.test(await page.locator('#main').textContent()), 'monthly on-time hub arrival rate shown');
  await shot('m-home-running');
  await page.evaluate(() => { const k = 'ssc-demo-data-v5'; const x = JSON.parse(localStorage.getItem(k)); const d = new Date(); x.trips.t20.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; delete x.trips.t20.arriveDate; localStorage.setItem(k, JSON.stringify(x)); localStorage.setItem('ssc-me', JSON.stringify({ driverId: 'd12', vehicleId: 'v12', siteId: 's3' })); });
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 15000 });
  await go('#checkin');
  ok(await page.locator('h2:has-text("ทริปของฉัน")').count() === 1 && await page.locator('button[data-act="posGps"]').count() === 1, 'driver page shows my running trip with a send-position button');
  await ctx.setGeolocation({ latitude: 9.1382, longitude: 99.3215, accuracy: 20 }).catch(() => {});
  const nextBtn = page.locator('section:has(h2:has-text("ทริปของฉัน")) button[data-act="stopArrive"]');
  ok(/ถึง สาขาสุราษฎร์ธานี แล้ว/.test(await nextBtn.textContent().catch(() => '')), 'driver gets a one-tap "arrived" for the next hub');
  await nextBtn.click();
  const srt = (await waitDemo(x => (x.trips.t20.arr || {})['b_br-srt'])).trips.t20.arr['b_br-srt']; await page.waitForTimeout(250);
  ok(!!srt && srt.loc && srt.loc.district === 'เมืองสุราษฎร์ธานี', 'driver arrival saved with GPS position');
  ok(/ลงของเสร็จ \/ ส่งงาน สาขาสุราษฎร์ธานี/.test(await page.locator('section:has(h2:has-text("ทริปของฉัน")) button[data-act="podOpen"]').textContent().catch(() => '')), 'after arriving the driver gets "ลงของเสร็จ / ส่งงาน"');
  await ctx.setGeolocation({ latitude: 8.4304, longitude: 99.9631, accuracy: 20 }).catch(() => {});
  await page.locator('button[data-act="posGps"]').click();
  const g = (await waitDemo(x => x.trips.t20.pos && x.trips.t20.pos.src === 'gps' && x.trips.t20.pos.province === 'นครศรีธรรมราช')).trips.t20.pos;
  ok(g.src === 'gps' && g.province === 'นครศรีธรรมราช', 'GPS position saved with district (' + g.district + ' / ' + g.province + ')');
  await shot('m-driver-trip');
  await page.evaluate(() => localStorage.removeItem('ssc-me'));
  await go('#home'); await page.reload(); await page.waitForFunction(() => !document.querySelector('#main .loading'), null, { timeout: 15000 });

  log('== Dairy Plus: actual unload time + 2 h ==');
  await ctx.setGeolocation({ latitude: 15.7047, longitude: 100.1372, accuracy: 20 }).catch(() => {});
  await go('#trip-t22');
  const dpKey = 'n_dairyplusนครสวรรค์';
  await page.locator(`button[data-act="stopArrive"][data-k="${dpKey}"]`).click();
  await waitDemo(x => (x.trips.t22.arr || {})[dpKey]); await page.waitForTimeout(250);
  await page.locator(`button[data-act="podOpen"][data-k="${dpKey}"]`).click(); await page.waitForTimeout(300);
  await podFill(); await page.locator('#sheet button[type=submit]').click();
  const dpa = (await waitDemo(x => x.trips.t22.arr[dpKey].doneAt)).trips.t22.arr[dpKey]; await page.waitForTimeout(250);
  ok(!!dpa.doneAt && dpa.doneLoc && dpa.doneLoc.district === 'เมืองนครสวรรค์', 'unload done at Dairy Plus นครสวรรค์ with GPS');
  await go('#dispatch');
  await page.locator('button[data-act="dpLine"][data-v="north"]').click(); await page.waitForTimeout(200);
  await page.locator('label.pick:has-text("เดโปพิษณุโลก") input').check(); await page.waitForTimeout(200);
  await page.fill('#dp-lt', '07:00'); await page.waitForTimeout(250);
  ok(await page.locator('button.pick:not([disabled]):has(.plate:text-is("70-1004")) .chip.good:has-text("ลงของเสร็จจริง")').count() === 1, 'finished unloading early → truck can load earlier (actual unload + 2 h, before the planned 08:00)');
  await page.locator('label.pick:has-text("เดโปพิษณุโลก") input').uncheck(); await page.waitForTimeout(150);

  log('== GPS เทเลเทค: paste the current-location list ==');
  await go('#home');
  await page.locator('button[data-act="gpsImport"]').first().click(); await page.waitForTimeout(250);
  const today = await page.evaluate(() => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; });
  const hm = mins => page.evaluate(m => { const d = new Date(Date.now() - m * 60000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; }, mins);
  // a whole-page copy: map labels and buttons first, then the list
  const messy = ['แผนที่ ดาวเทียม', '70-1012กก', '700-6453กก', 'ตำแหน่งปัจจุบัน', 'ค้นหา ซ่อนรถที่ไม่เกี่ยวข้อง', 'ขยายทั้งหมด เลือกทั้งหมด ไม่เลือกทั้งหมด', 'บริษัท ภูเก็ตศรีสุชาติขนส่ง จำกัด', 'จำนวน 43 รายการ',
    '70-1012กก', today, '68 กม/ชม', 'V.2', await hm(0), 'ปตท.บางสะพาน/ เพชรเกษม ตำบลกำเนิดนพคุณ อำเภอบางสะพาน', 'จังหวัดประจวบคีรีขันธ์',
    '70-1006กก', today, '0 กม/ชม', 'V.2', await hm(1), 'พุทธมณฑลสาย 3 แขวงศาลาธรรมสพน์ เขตทวีวัฒนา กรุงเทพมหานคร',
    '70-1004กก', today, '0 กม/ชม', 'V.2', await hm(0), 'Dairy Plus นครสวรรค์/ ตำบลนครสวรรค์ตก อำเภอเมืองนครสวรรค์ จังหวัดนครสวรรค์',
    '99-9999กก', today, '0 กม/ชม', 'V.2', await hm(20), 'เดโปตัวอย่าง/ เพชรเกษม ตำบลเขาน้อย อำเภอปราณบุรี จังหวัดประจวบคีรีขันธ์',
    '63-5494กก เข้าจุดจอด : กม./ชม. 14/10/2026 08:39:47'].join('\n');
  await page.fill('#gps-in', messy); await page.waitForTimeout(250);
  const gp = (await page.locator('#gps-prev').textContent()).replace(/\s+/g, ' ');
  ok(/อ่านได้ 4 คัน · ตรงกับรถในระบบ 3 คัน \(กำลังวิ่ง 2 คัน\) · ยังไม่มีในข้อมูลรถ 1 คัน/.test(gp) && /99-9999/.test(gp), 'preview reads trucks from a whole-page copy: ' + gp.slice(0, 110));
  await page.locator('#sheet button[type=submit]').click();
  dd = await waitDemo(x => x.vehicles.v12.gps && x.vehicles.v06.gps && x.vehicles.v04.gps); await page.waitForTimeout(250);
  ok(dd.vehicles.v12.gps.district === 'บางสะพาน' && dd.vehicles.v12.gps.province === 'ประจวบคีรีขันธ์' && dd.vehicles.v12.gps.place === 'ปตท.บางสะพาน' && dd.vehicles.v12.gps.speed === 68 && dd.vehicles.v12.gps.src === 'teletec', 'truck position from Teletec: place, district, province, speed');
  ok(dd.vehicles.v06.gps.district === 'ทวีวัฒนา' && dd.vehicles.v06.gps.province === 'กรุงเทพมหานคร' && dd.vehicles.v04.gps.district === 'เมืองนครสวรรค์', 'Bangkok เขต and อำเภอเมือง read correctly');
  ok(dd.trips.t20.pos.src === 'teletec' && dd.trips.t20.pos.district === 'บางสะพาน' && dd.trips.t22.pos.src === 'teletec', 'running trips get the new position too');
  ok(/ปตท\.บางสะพาน · อ\.บางสะพาน จ\.ประจวบคีรีขันธ์ .*68 กม\.\/ชม\. · GPS เทเลเทค/.test(await page.locator('section:has(h2:has-text("รถกำลังวิ่ง"))').textContent()), 'running board shows the Teletec position and speed');
  await page.locator('button[data-act="gpsImport"]').first().click(); await page.waitForTimeout(250);
  await page.locator('button[data-act="gpsSample"]').click(); await page.waitForTimeout(150);
  await page.locator('#sheet button[type=submit]').click(); await page.waitForTimeout(400);
  ok(/ไม่มีตำแหน่งที่ใหม่กว่า/.test(await page.locator('#toast').textContent()), 'an older list does not overwrite newer positions');
  // copying from the browser keeps the Google Maps link → coordinates
  await page.locator('button[data-act="gpsImport"]').first().click(); await page.waitForTimeout(250);
  const now1 = await hm(0);
  await page.evaluate(([d, t]) => {
    const html = `<div><div><b>70-1006กก</b></div><div>${d}</div><div>0 กม/ชม</div><div>${t}</div><div>พุทธมณฑลสาย 3/ แขวงศาลาธรรมสพน์ เขตทวีวัฒนา กรุงเทพมหานคร <a href="https://www.google.com/maps?q=13.78812,100.31634"><img alt=""></a></div></div>`;
    const dt = new DataTransfer(); dt.setData('text/html', html); dt.setData('text/plain', 'x');
    document.getElementById('gps-in').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [today, now1]);
  await page.waitForTimeout(250);
  ok(/\[GPS 13\.78812,100\.31634\]/.test(await page.inputValue('#gps-in')) && /มีพิกัด/.test(await page.locator('#gps-prev').textContent()), 'HTML paste keeps the map pin coordinates');
  await page.locator('#sheet button[type=submit]').click();
  dd = await waitDemo(x => x.vehicles.v06.gps.lat === 13.78812);
  ok(dd.vehicles.v06.gps.lat === 13.78812 && dd.vehicles.v06.gps.place === 'พุทธมณฑลสาย 3', 'coordinates saved with the truck');
  await go('#master');
  ok(await page.locator('.row:has(.plate:text-is("70-1006")) :text("GPS เทเลเทค")').count() >= 1, 'vehicle list shows the last GPS position');
  await go('#home'); await shot('m-home-gps');

  log('== settings: time rules ==');
  await go('#settings');
  ok((await page.inputValue('#s-tm')) === 'Dairy Plus นครสวรรค์' && (await page.inputValue('#s-arr')) === '07:00', 'settings show the Dairy Plus time-matching point and the 07:00 hub time');
  await page.fill('#s-arr', '06:30'); await page.locator('form[data-form="settings"] button[type=submit]').click(); await page.waitForTimeout(250);
  ok((await demo()).config.settings.southArriveBy === '06:30', 'hub arrival time is editable');
  await go('#settings'); await page.fill('#s-arr', '07:00'); await page.locator('form[data-form="settings"] button[type=submit]').click(); await page.waitForTimeout(250);

  log('== north trip legs + close ==');
  await go('#trip-t21');
  await page.locator('form[data-form="depart"] button[type=submit]').click(); await page.waitForTimeout(300);
  ok(/น้ำหนักสินค้าจริง/.test(await page.locator('form[data-form="depart"] .errbox').textContent().catch(() => '')), 'cannot depart without the actual loaded weight');
  await page.fill('#tf-cargo', '29000'); await page.locator('form[data-form="depart"] button[type=submit]').click(); await page.waitForTimeout(300);
  ok(/เกินที่รถ 18 ล้อบรรทุกได้/.test(await page.locator('form[data-form="depart"] .errbox').textContent().catch(() => '')), 'cargo above 28 t blocked for an 18-wheeler');
  await page.fill('#tf-cargo', '21000'); await page.fill('#tf-gross', '46000'); await page.locator('form[data-form="depart"] button[type=submit]').click(); await page.waitForTimeout(300);
  ok(/เกินกฎหมาย/.test(await page.locator('form[data-form="depart"] .errbox').textContent().catch(() => '')), 'weighbridge total above 45 t blocked');
  await page.fill('#tf-gross', '36500'); await page.locator('form[data-form="depart"] button[type=submit]').click(); await page.waitForTimeout(300);
  await page.locator('button[data-act="addJob"]').click(); await page.waitForTimeout(200);
  await page.selectOption('#f-kind', 'EMPTY'); await page.selectOption('#f-routeId', 'n-empty-skn'); await sheetOk();
  await page.locator('button[data-act="addJob"]').click(); await page.waitForTimeout(200);
  await page.selectOption('#f-kind', 'BH'); await page.selectOption('#f-routeId', 'n-bh-asa'); await page.fill('#f-revenue', '12000'); await sheetOk();
  dd = await demo();
  ok(dd.trips.t21.jobs.length === 3 && dd.trips.t21.standardKm === 500, 'legs add up Standard KM (200+40+260=' + dd.trips.t21.standardKm + ')');
  ok((await page.inputValue('#tc-std')) === '500', 'close form pre-fills trip Standard KM');
  const mo = dd.trips.t21.mileOut;
  await page.fill('#tc-in', String(mo + 9000)); await page.locator('form[data-form="closeTrip"] button[type=submit]').click(); await page.waitForTimeout(300);
  ok(/ผิดปกติ/.test(await page.locator('form[data-form="closeTrip"] .errbox').textContent().catch(() => '')), 'odd mileage needs confirmation');
  await page.fill('#tc-in', String(mo + 512)); await page.fill('#tc-loaded', '460');
  await page.locator('form[data-form="closeTrip"] button[type=submit]').click(); await page.waitForTimeout(300);
  ok(/น้ำหนักจริงของงานขากลับ/.test(await page.locator('form[data-form="closeTrip"] .errbox').textContent().catch(() => '')), 'back-haul needs its actual weight before closing');
  await page.locator('button[data-act="jobWeight"]').click(); await page.waitForTimeout(200);
  await page.fill('#f-actualKg', '25500'); await sheetOk();
  await page.fill('#tc-in', String(mo + 512)); await page.fill('#tc-loaded', '460');
  await page.locator('form[data-form="closeTrip"] button[type=submit]').click(); await page.waitForTimeout(300);
  ok(await page.locator('.chip:has-text("ปิดทริปแล้ว")').count() >= 1, 'north trip closed');
  ok(/\+12/.test(await page.locator('.kv').textContent()), 'variance vs summed legs shown (+12)');

  log('== master: vehicle head/trailer, site cut-off validation ==');
  await go('#master');
  ok(await page.locator('.row:has(.plate:text-is("70-1006")) :text("หาง 70-8006")').count() === 1, 'vehicle row shows trailer plate');
  await page.locator('button[data-act="masterTab"][data-v="sites"]').click(); await page.waitForTimeout(150);
  await page.locator('.row:has-text("คลังพุทธมณฑลสาย 3") button[data-act="edit"]').click(); await page.waitForTimeout(150);
  await page.fill('#f-backhaulCutoff', '25:99'); await sheetOk();
  ok(/ชั่วโมง:นาที/.test(await page.locator('#sheet-err').textContent()), 'bad cut-off time rejected');
  await page.locator('#sheet button[data-act="closeSheet"]').first().click(); await page.waitForTimeout(150);

  log('== cancel trip returns parcels ==');
  await go('#trip-' + tripId);
  await page.locator('form[data-form="depart"] button[data-act="tripCancel"]').click(); await page.waitForTimeout(150);
  await sheetOk(); await page.waitForTimeout(200);
  dd = await demo();
  ok(dd.parcels.p2.tripId === null && dd.parcels.p2.status === 'received', 'parcels back to waiting after trip cancel');

  log('== driver mode + real-data mode ==');
  await go('#more');
  await page.locator('button[data-act="role"][data-v="driver"]').click(); await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.body.classList.contains('driver')), 'driver mode');
  await page.locator('button[data-act="role"][data-v="dispatch"]').first().click(); await page.waitForTimeout(300);
  await page.locator('.banner button[data-act="demoOff"]').click(); await page.waitForTimeout(300);
  await go('#home');
  ok(await page.locator('h2:has-text("ยังไม่มีข้อมูลรถและคนขับจริง")').count() === 1, 'empty real-data onboarding');
  await go('#parcels'); ok(await page.locator('.empty').count() >= 1, 'parcels empty state in real mode');
  await go('#home'); await page.locator('button[data-act="demoOn"]').first().click(); await page.waitForTimeout(300);

  log('== desktop + dark ==');
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const h of ['home', 'dispatch', 'queue', 'parcel-p4', 'scan']) { await go('#' + h); await shot('d-' + h.replace('-', '_')); }
  await page.emulateMedia({ colorScheme: 'dark' });
  await go('#home'); await shot('d-home-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('#parcel-p4'); await shot('m-parcel-dark');
  await go('#queue'); await shot('m-queue-dark');

  log('== errors ==');
  errors.forEach(e => log('  ' + e));
  ok(errors.length === 0, 'no page/console errors');
  log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
