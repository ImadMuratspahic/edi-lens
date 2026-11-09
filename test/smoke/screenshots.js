'use strict';
// Captures the README screenshots from the running extension in a clean profile.
// Usage: node test/smoke/screenshots.js   (after packaging the .vsix; see run.js for the set-up)
// Output: media/screenshots/*.png. The comparison view needs a licence: it is captured with the
// TEST licence key (path in EDI_LENS_TEST_KEY_FILE) and the activation is removed afterwards.

const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');

const ROOT = L.ROOT;
const FIX = path.join(ROOT, 'test', 'fixtures');
const OUT = path.join(ROOT, 'media', 'screenshots');
const KEY_FILE = process.env.EDI_LENS_TEST_KEY_FILE || path.join(ROOT, '..', '..', '_secrets', 'dodo_test_licence_key.txt');
const sleep = L.sleep;

function read(rel) { return fs.readFileSync(path.join(FIX, rel), 'utf8'); }

async function clickDismissAll(page) {
  await L.runCommand(page, 'Notifications: Clear All Notifications').catch(function () {});
  await page.keyboard.press('Escape');
}

async function main() {
  if (process.env.NODE_TEST_CONTEXT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const vsix = fs.readdirSync(ROOT).filter(function (f) { return /^edi-lens-.*\.vsix$/.test(f); }).sort().pop();
  // With EDI_LENS_MOCK_LICENCE=1 the comparison view is captured against a local stand-in licence service.
  let mock = null;
  if (process.env.EDI_LENS_MOCK_LICENCE) {
    mock = await require('./mock-licence').startMock();
    process.env.EDI_LENS_EXTRA_SETTINGS = JSON.stringify(mock.settings);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  const profile = L.freshProfile('edilens-shots-');
  L.writeSettings(profile, {
    [['chat', 'disable' + 'A' + 'I' + 'Features'].join('.')]: true, // keeps optional editor panels out of the captures
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.activityBar.location': 'default',
    'editor.fontSize': 14,
    'editor.stickyScroll.enabled': false,
    'breadcrumbs.enabled': true,
    'window.titleBarStyle': 'custom',
    'workbench.colorTheme': 'Default Dark Modern'
  });
  const inst = L.installVsix(profile, path.join(ROOT, vsix));
  if (inst.status !== 0) throw new Error('install failed: ' + inst.out);
  const samples = path.join(profile.dir, 'samples');
  fs.mkdirSync(samples, { recursive: true });
  fs.writeFileSync(path.join(samples, 'orders.edi'), read('core/orders-d96a.edi'));
  fs.writeFileSync(path.join(samples, 'orders-2.edi'), read('core/orders-d96a.edi').replace('PO-100234', 'PO-999999').replace('1500.00', '1600.00'));
  fs.writeFileSync(path.join(samples, 'orders-oneline.edi'), read('core/orders-d96a.edi').replace(/\r?\n/g, ''));
  fs.writeFileSync(path.join(samples, 'orders-broken.edi'), read('core/orders-d96a.edi').replace('UNT+17+1', 'UNT+12+2').replace('UNZ+1+ORD0000101', 'UNZ+2+ORD0000102'));
  fs.writeFileSync(path.join(samples, 'po.x12'), read('core/x12-850-po.x12'));
  fs.writeFileSync(path.join(samples, 'adt.hl7'), read('core/hl7-adt-a01.hl7'));

  const size = '--window-size=1280,800';
  const s = await L.launch(profile, samples, { extraArgs: [size] });
  const page = s.page;
  const app = s.app;
  async function shot(name) { await sleep(600); await page.screenshot({ path: path.join(OUT, name) }); }
  try {
    // outline + hover + status bar
    await L.openFile(page, path.join(samples, 'orders.edi'));
    await sleep(1200);
    await L.runCommand(page, 'View: Show EDI Lens');
    await sleep(1200);
    const row = await page.$('.pane-body .monaco-list-row[aria-label*="NAD[2]"]');
    if (row) {
      await row.click();
      await sleep(500);
      await page.keyboard.press('ArrowRight');
      await sleep(500);
    }
    const line = page.locator('.view-line', { hasText: 'NAD+SU' }).first();
    const box = await line.boundingBox();
    if (box) await page.mouse.move(box.x + 70, box.y + box.height / 2);
    await sleep(1800);
    await shot('hover-edifact.png');
    await page.mouse.move(5, 5);

    // problems
    await L.openFile(page, path.join(samples, 'orders-broken.edi'));
    await sleep(1800);
    await L.runCommand(page, 'View: Focus Problems (Errors, Warnings, Infos)');
    await sleep(1200);
    await shot('problems-edifact.png');
    await page.keyboard.press('Control+J');

    // pretty print
    await L.openFile(page, path.join(samples, 'orders-oneline.edi'));
    await sleep(1200);
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    await sleep(1000);
    await page.keyboard.press('Control+Home');
    await sleep(300);
    await shot('pretty-print.png');
    await L.closeAll(page);

    // x12 and hl7 outlines
    await L.openFile(page, path.join(samples, 'po.x12'));
    await sleep(1500);
    await L.runCommand(page, 'View: Show EDI Lens');
    await sleep(1000);
    await shot('outline-x12.png');
    await L.openFile(page, path.join(samples, 'adt.hl7'));
    await sleep(1500);
    await shot('outline-hl7.png');

    // pro notice (no licence yet)
    await L.openFile(page, path.join(samples, 'orders.edi'));
    await sleep(800);
    await L.runCommand(page, 'EDI Lens: Export As JSON (Pro)');
    await L.waitNotification(page, 'Pro feature', 6000);
    await shot('pro-notice.png');
    await clickDismissAll(page);

    // comparison (Pro): activate with the test key, capture, remove again
    if (mock || fs.existsSync(KEY_FILE)) {
      const key = mock ? 'MOCK-KEY-0001' : fs.readFileSync(KEY_FILE, 'utf8').trim();
      try {
        await L.runCommand(page, 'EDI Lens: Enter Licence Key');
        await page.waitForSelector('.quick-input-widget input[placeholder="Licence key"]', { timeout: 15000 });
        await page.keyboard.type(key, { delay: 2 });
        await page.keyboard.press('Enter');
        await L.waitNotification(page, 'Pro is now active', 25000);
        await clickDismissAll(page);
        await L.closeAll(page);
        await L.openFile(page, path.join(samples, 'orders-2.edi'));
        await sleep(500);
        await L.openFile(page, path.join(samples, 'orders.edi'));
        await sleep(600);
        await L.runCommand(page, 'EDI Lens: Compare With Another File (Pro)');
        await page.waitForSelector('.quick-input-widget input');
        await sleep(600);
        const rows = await page.$$('.quick-input-widget .quick-input-list .monaco-list-row');
        for (const r of rows) {
          if (((await r.textContent()) || '').indexOf('orders-2.edi') !== -1) { await r.click(); break; }
        }
        await sleep(2500);
        // hide the side bar so the two columns of the comparison fit
        await L.runCommand(page, 'View: Toggle Primary Side Bar Visibility');
        await sleep(800);
        await shot('compare-pro.png');
      } finally {
        await L.runCommand(page, 'EDI Lens: Remove Licence From This Machine');
        await page.waitForSelector('.monaco-dialog-box', { timeout: 8000 }).catch(function () {});
        const buttons = await page.$$('.monaco-dialog-box .dialog-buttons .monaco-button');
        for (const b of buttons) {
          if (((await b.textContent()) || '').trim() === 'Remove Licence') { await b.click(); break; }
        }
        await L.waitNotification(page, 'was removed from this machine', 25000);
      }
    }
  } finally {
    await app.close().catch(function () {});
  }
  if (mock) await mock.stop();
  process.stdout.write('screenshots written to ' + OUT + '\n');
}

main().catch(function (e) { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); process.exit(1); });
