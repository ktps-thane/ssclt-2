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
  const demo = async () => page.evaluate(() => JSON.parse(localStorage.getItem('ssc-demo-data-v4')));
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
  ok(await page.locator('button.pick .ln:has-text("สายใต้")').count() === 0, 'north filter hides south trucks');
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

  log('== dispatch south with parcels ==');
  await page.locator('button[data-act="dpLine"][data-v="south"]').click(); await page.waitForTimeout(200);
  ok(/นมชุมพร/.test(await page.locator('label.pick').first().textContent()), 'dispatch lists earliest due date first');
  await page.locator('label.pick:has-text("Partner ภูเก็ต") input').check(); await page.waitForTimeout(150);
  await page.locator('label.pick:has-text("นมชุมพร") input').check(); await page.waitForTimeout(200);
  ok(/เลยกำหนดส่ง/.test(await page.locator('.note.crit').first().textContent().catch(() => '')), 'warns when departure date is after the due date');
  await page.fill('#dp-date', await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })); await page.waitForTimeout(250);
  ok(/ไม่ถึง 3 วัน|วันเดียวกับกำหนดส่ง/.test(await page.locator('.note.warn').first().textContent().catch(() => '')), 'departure too close to the due date gets a warning (hub needs up to 3 days)');
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
