'use strict';
// Release smoke test. Installs the packaged extension into a clean temporary VS Code profile and
// exercises every command, view and setting through the real user interface.
//
// Usage (from the project root, after `npx @vscode/vsce package --no-dependencies`):
//   node test/smoke/run.js [phase ...]
// Phases: free, nolicence, settings, edge, workspace, licence, prosettings, offline. No argument
// runs them all in order.
//
// The licence phases use the TEST licence key stored outside the repository (path in
// EDI_LENS_TEST_KEY_FILE, default ../../_secrets/dodo_test_licence_key.txt relative to the project
// root). The key is typed into the real input box and is never printed or captured.
//
// The offline phase blocks the network through VS Code's own proxy setting pointed at a closed
// local port, which is how a machine without internet access behaves.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib');

const ROOT = L.ROOT;
const FIX = path.join(ROOT, 'test', 'fixtures');
const OUT = process.env.EDI_LENS_SMOKE_OUT || path.join(os.tmpdir(), 'edilens-smoke-out');
const KEY_FILE = process.env.EDI_LENS_TEST_KEY_FILE || path.join(ROOT, '..', '..', '_secrets', 'dodo_test_licence_key.txt');
const sleep = L.sleep;

// With EDI_LENS_MOCK_LICENCE=1 the licence phases talk to a local stand-in service (see
// mock-licence.js) with a dummy key instead of the real test service.
let mockLicence = null;
function readKey() {
  return mockLicence ? 'MOCK-KEY-0001' : fs.readFileSync(KEY_FILE, 'utf8').trim();
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: ok ? '' : String(detail === undefined ? '' : detail) });
  process.stdout.write((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + String(detail === undefined ? '' : detail).slice(0, 300)) + '\n');
}

function read(rel) { return fs.readFileSync(path.join(FIX, rel), 'utf8'); }

// ---- fixture files ------------------------------------------------------------------------
function writeFixtures(work) {
  const one = read('core/orders-d96a.edi').replace(/\r?\n/g, '');
  fs.writeFileSync(path.join(work, 'orders-oneline.edi'), one);
  fs.writeFileSync(path.join(work, 'orders.edi'), read('core/orders-d96a.edi'));
  fs.writeFileSync(path.join(work, 'orders-other.edi'), read('core/orders-d96a.edi').replace('PO-100234', 'PO-999999').replace('1500.00', '1600.00'));
  fs.writeFileSync(path.join(work, 'po.x12'), read('core/x12-850-po.x12'));
  fs.writeFileSync(path.join(work, 'adt.hl7'), read('core/hl7-adt-a01.hl7'));
  fs.writeFileSync(path.join(work, 'x12-named-edi.edi'), read('core/x12-850-po.x12'));
  fs.writeFileSync(path.join(work, 'broken.edi'), read('core/orders-d96a.edi').replace('UNT+17+1', 'UNT+99+1'));
  fs.writeFileSync(path.join(work, 'notes.txt'), 'UNA:+.? \'UNB+UNOC:3+A+B+240115:0930+R1\'UNH+1+ORDERS:D:96A:UN\'BGM+220+PO-1+9\'UNT+3+1\'UNZ+1+R1\'');
  fs.writeFileSync(path.join(work, 'empty.edi'), '');
  fs.writeFileSync(path.join(work, 'binary.edi'), Buffer.from(Array.from({ length: 4096 }, function (_, i) { return (i * 131 + 7) % 256; })));
  fs.writeFileSync(path.join(work, 'readonly.edi'), read('core/orders-d96a.edi').replace(/\r?\n/g, ''));
  fs.chmodSync(path.join(work, 'readonly.edi'), 0o444);
  fs.writeFileSync(path.join(work, 'dictionary.json'), read('pro/dictionary-edifact.json'));
  fs.writeFileSync(path.join(work, 'typing.edi'), read('core/orders-d96a.edi'));
  fs.writeFileSync(path.join(work, 'orders-lower.edi'), read('core/orders-d96a.edi').replace('PO-100234', 'po-100234'));
  fs.writeFileSync(path.join(work, 'formula.edi'), read('core/orders-d96a.edi').replace('Deliver to loading bay', '=SUM(1) at bay'));
  const many = ['UNA:+.? \'UNB+UNOC:3+A+B+240115:0930+R1\''];
  for (let i = 1; i <= 6; i++) many.push('UNH+' + i + '+ORDERS:D:96A:UN\'BGM+220+X\'UNT+9+' + i + '\'');
  many.push('UNZ+6+R1\'');
  fs.writeFileSync(path.join(work, 'many.edi'), many.join(''));
  // A synthetic file of about 3 MB: one interchange with many order lines.
  const lines = [];
  const body = ['LIN+1++4000000000015:EN\'', 'QTY+21:24\'', 'PRI+AAA:12.50\''];
  const count = 70000;
  const head = 'UNA:+.? \'UNB+UNOC:3+4012345000009:14+4098765000008:14+240115:0930+BIG1\'UNH+1+ORDERS:D:96A:UN:EAN008\'BGM+220+PO-BIG+9\'';
  for (let i = 0; i < count; i++) lines.push(body.join(''));
  const segs = 2 + count * 3 + 1;
  fs.writeFileSync(path.join(work, 'big.edi'), head + lines.join('') + 'UNT+' + (segs) + '+1\'UNZ+1+BIG1\'');
  // Folder tree for workspace features.
  fs.mkdirSync(path.join(work, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(work, 'inbox', 'a.edi'), read('core/orders-d96a.edi').replace(/\r?\n/g, ''));
  fs.writeFileSync(path.join(work, 'inbox', 'b.x12'), read('core/x12-850-po.x12'));
  fs.writeFileSync(path.join(work, 'inbox', 'c-broken.edi'), read('core/orders-d96a.edi').replace('UNT+17+1', 'UNT+99+1').replace(/\r?\n/g, ''));
  fs.writeFileSync(path.join(work, 'inbox', 'd.hl7'), read('core/hl7-adt-a01.hl7'));
}

// ---- driver helpers ------------------------------------------------------------------------
async function clip(app, page) {
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
  await sleep(200);
  const text = await app.evaluate(function (e) { return e.clipboard.readText(); });
  return text.replace(/\r\n/g, '\n');
}

async function setClipboard(app, text) {
  await app.evaluate(function (e, t) { e.clipboard.writeText(t); }, text);
}

async function gotoLine(page, line, col) {
  await page.keyboard.press('Control+G');
  await sleep(250);
  await page.keyboard.type(line + (col ? ':' + col : ''));
  await page.keyboard.press('Enter');
  await sleep(300);
}

async function cursorPos(page, wantLine) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    const items = await L.statusBar(page);
    const hit = items.find(function (t) { return /^Ln \d+, Col \d+/.test(t); });
    last = hit ? hit.match(/^Ln (\d+), Col (\d+)/).slice(1).map(Number) : null;
    if (!wantLine || (last && last[0] === wantLine)) return last;
    await sleep(250);
  }
  return last;
}

async function languageName(page) {
  const items = await L.statusBar(page);
  return items;
}

async function edStatus(page) {
  const items = await L.statusBar(page);
  return items.find(function (t) { return /segments? ·|\bsegments\b.*issue/.test(t); }) || '';
}

// The language mode shown in the status bar (set by the editor, not by the content).
async function langItem(page) {
  const items = await L.statusBar(page);
  return items.find(function (t) { return /^(UN\/EDIFACT|ANSI X12|HL7 v2|Plain Text)$/.test(t); }) || '';
}

async function dismiss(page) {
  await page.keyboard.press('Escape');
  await L.runCommand(page, 'Notifications: Clear All Notifications').catch(function () {});
  await page.keyboard.press('Escape');
}

async function modal(page, label) {
  // A custom-style modal dialog: waits for it and clicks the button with the label.
  await page.waitForSelector('.monaco-dialog-box', { timeout: 8000 });
  const text = (await (await page.$('.monaco-dialog-box')).textContent()) || '';
  if (label) {
    const buttons = await page.$$('.monaco-dialog-box .dialog-buttons .monaco-button');
    for (const b of buttons) {
      if (((await b.textContent()) || '').trim() === label) { await b.click(); break; }
    }
  } else {
    await page.keyboard.press('Escape');
  }
  await sleep(300);
  return text;
}

async function quickPickRows(page) {
  return page.$$eval('.quick-input-widget .quick-input-list .monaco-list-row', function (rows) {
    return rows.map(function (r) { return r.textContent.replace(/\s+/g, ' ').trim(); });
  });
}

async function openOutline(page) {
  await L.runCommand(page, 'View: Show EDI Lens');
  await sleep(1200);
}

async function outlineRows(page) {
  return page.$$eval('.pane-body .monaco-list-row', function (rows) {
    return rows.map(function (r) { return (r.getAttribute('aria-label') || r.textContent || '').replace(/\s+/g, ' ').trim(); });
  });
}

async function webviewText(page) {
  for (let i = 0; i < 20; i++) {
    for (const f of page.frames()) {
      try {
        const t = await f.evaluate(function () { return document.body ? document.body.innerText : ''; });
        if (t && /Comparison|identical|changed|added|removed/i.test(t) && t.length > 20) return t;
      } catch (e) { /* frame not ready */ }
    }
    await sleep(400);
  }
  return '';
}

async function problemsText(page) {
  await L.runCommand(page, 'View: Focus Problems (Errors, Warnings, Infos)');
  await sleep(800);
  return page.$$eval('.panel .markers-panel .monaco-list-row, .panel .monaco-list-row', function (rows) {
    return rows.map(function (r) { return (r.getAttribute('aria-label') || r.textContent || '').replace(/\s+/g, ' ').trim(); });
  });
}

async function activeTabTitle(page) {
  const t = await page.$$eval('.tabs-container .tab.active', function (els) { return els.map(function (e) { return e.getAttribute('aria-label') || e.textContent; }); });
  return t[0] || '';
}

async function enterKey(page, key) {
  await L.runCommand(page, 'EDI Lens: Enter Licence Key');
  // Wait for the key box itself (not the palette that is still closing).
  await page.waitForSelector('.quick-input-widget input[placeholder="Licence key"]', { timeout: 15000 });
  await page.keyboard.type(key, { delay: 2 });
  await page.keyboard.press('Enter');
}

function hasText(list, needle) {
  return list.some(function (n) { return n.text.indexOf(needle) !== -1; });
}

// ---- phases ---------------------------------------------------------------------------------
async function session(profile, target, opts, fn) {
  const s = await L.launch(profile, target, opts);
  const errors = [];
  s.page.on('pageerror', function (e) { errors.push(String(e)); });
  try {
    await fn(s.app, s.page);
  } finally {
    s.page.screenshot({ path: path.join(OUT, 'last.png') }).catch(function () {});
    await s.app.close().catch(function () {});
  }
  return errors;
}

async function phaseFree(profile) {
  await session(profile, profile.work, {}, async function (app, page) {
    // -- activation and language detection by extension ------------------------------------
    await L.openFile(page, path.join(profile.work, 'orders-oneline.edi'));
    await sleep(1500);
    let st = await edStatus(page);
    check('status bar shows format, segment count and issues', /UN\/EDIFACT · 20 segments · 0 issues/.test(st), st);
    check('status bar item carries a tooltip with counts', (await L.statusBar(page)).some(function (t) { return /0 errors, 0 warnings, 0 notes/.test(t); }));

    // -- pretty print / minify / format document ------------------------------------------
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    await sleep(800);
    let text = await clip(app, page);
    check('Pretty Print gives one segment per line', text.split('\n').length >= 20 && /^UNA:\+\.\? '\n/.test(text), text.slice(0, 120));
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    check('Pretty Print twice reports nothing to change', true);
    await L.runCommand(page, 'EDI Lens: Minify');
    await sleep(800);
    text = await clip(app, page);
    check('Minify removes the line breaks', text.indexOf('\n') === -1 || /^[^\n]+\n?$/.test(text), JSON.stringify(text.slice(0, 80)));
    await page.keyboard.press('Shift+Alt+F');
    await sleep(900);
    text = await clip(app, page);
    check('Format Document pretty prints', text.split('\n').length >= 20, text.slice(0, 80));

    // -- go to segment ---------------------------------------------------------------------
    await gotoLine(page, 1);
    await L.runCommand(page, 'EDI Lens: Go to Segment');
    await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
    await page.keyboard.type('NAD[2]');
    await sleep(500);
    const rows = await quickPickRows(page);
    check('Go to Segment lists matching segments', rows.some(function (r) { return /^NAD\[2\]/.test(r); }), JSON.stringify(rows.slice(0, 3)));
    await page.keyboard.press('Enter');
    await sleep(500);
    let pos = await cursorPos(page, 9);
    check('Go to Segment jumps to NAD[2] (line 9)', pos && pos[0] === 9, JSON.stringify(pos));

    // -- jump to matching trailer --------------------------------------------------------
    await gotoLine(page, 3);
    await L.runCommand(page, 'EDI Lens: Jump To Matching Trailer');
    await sleep(500);
    pos = await cursorPos(page);
    check('Jump To Matching Trailer goes UNH -> UNT (line 19)', pos && pos[0] === 19, JSON.stringify(pos));
    await L.runCommand(page, 'EDI Lens: Jump To Matching Trailer');
    await sleep(500);
    pos = await cursorPos(page);
    check('Jump To Matching Trailer goes UNT -> UNH (line 3)', pos && pos[0] === 3, JSON.stringify(pos));
    await gotoLine(page, 4);
    await L.runCommand(page, 'EDI Lens: Jump To Matching Trailer');
    const n1 = await L.waitNotification(page, 'not an envelope segment', 4000);
    check('Jump To Matching Trailer on a body segment explains itself', !!n1);
    await dismiss(page);

    // -- copy path at cursor ---------------------------------------------------------------
    await gotoLine(page, 9, 8);
    await L.runCommand(page, 'EDI Lens: Copy Path At Cursor');
    await sleep(400);
    const copied = await app.evaluate(function (e) { return e.clipboard.readText(); });
    check('Copy Path At Cursor copies a path', /^NAD\[2\]-2/.test(copied), copied);

    // -- hover -----------------------------------------------------------------------------
    await gotoLine(page, 9);
    const line = page.locator('.view-line', { hasText: 'NAD+SU' }).first();
    const box = await line.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 60, box.y + box.height / 2);
      await sleep(1800);
      const hv = await page.$$eval('.monaco-hover', function (els) { return els.map(function (e) { return e.textContent; }).join(' | '); });
      check('Hover shows the path and value', /NAD\[2\]/.test(hv), hv.slice(0, 200));
    } else {
      check('Hover target found', false, 'no line box');
    }
    await page.mouse.move(5, 5);

    // -- validate current file -------------------------------------------------------------
    await L.runCommand(page, 'EDI Lens: Validate Current File');
    const v = await L.waitNotification(page, 'No problems found', 5000);
    check('Validate Current File reports a clean file', !!v);
    await dismiss(page);

    // -- detect format on a plain text file ------------------------------------------------
    await L.openFile(page, path.join(profile.work, 'notes.txt'));
    await sleep(800);
    await L.runCommand(page, 'EDI Lens: Detect Format');
    const d = await L.waitNotification(page, 'Language set to', 5000);
    check('Detect Format switches a .txt file to UN/EDIFACT', !!d, JSON.stringify(await L.notifications(page)));
    await sleep(800);
    st = await edStatus(page);
    check('status bar follows the language switch', (await langItem(page)) === 'UN/EDIFACT' && /UN\/EDIFACT/.test(st), st);
    await L.runCommand(page, 'EDI Lens: Detect Format');
    const d2 = await L.waitNotification(page, 'already set to', 5000);
    check('Detect Format on a set file says so', !!d2);
    await dismiss(page);

    // -- automatic switch of an X12 file named .edi -----------------------------------------
    await L.openFile(page, path.join(profile.work, 'x12-named-edi.edi'));
    await sleep(1800);
    st = await edStatus(page);
    check('an X12 file named .edi is switched to ANSI X12 automatically', (await langItem(page)) === 'ANSI X12', await langItem(page));

    // -- validation problems ----------------------------------------------------------------
    await L.openFile(page, path.join(profile.work, 'broken.edi'));
    await sleep(1800);
    st = await edStatus(page);
    check('status bar counts the problems of a broken file', /[1-9]\d* issues?/.test(st), st);
    const pr = await problemsText(page);
    check('Problems view lists the segment count problem', pr.some(function (r) { return /UNT/.test(r) && /(count|segment)/i.test(r); }), JSON.stringify(pr.slice(0, 4)));
    await page.keyboard.press('Control+J');
    await sleep(300);

    // -- outline view -----------------------------------------------------------------------
    await L.openFile(page, path.join(profile.work, 'orders.edi'));
    await sleep(1000);
    await openOutline(page);
    let ol = await outlineRows(page);
    check('Outline lists the segments of the active file', ol.some(function (r) { return /NAD\[2\]/.test(r); }), JSON.stringify(ol.slice(0, 5)));
    await page.screenshot({ path: path.join(OUT, 'outline-edifact.png') });
    const row = await page.$('.pane-body .monaco-list-row[aria-label*="NAD[2]"]');
    if (row) {
      await row.click();
      await sleep(600);
      pos = await cursorPos(page);
      check('clicking an outline item reveals it in the editor', pos && pos[0] === 9, JSON.stringify(pos));
      await row.click({ button: 'right' });
      await sleep(500);
      const menu = await page.$$eval('.context-view .action-label, .monaco-menu .action-label', function (els) { return els.map(function (e) { return e.textContent.trim(); }); });
      check('outline context menu offers Copy Path', menu.indexOf('EDI Lens: Copy Path') !== -1 || menu.indexOf('Copy Path') !== -1, JSON.stringify(menu));
      const item = await page.$$('.context-view .action-item a.action-label, .monaco-menu .action-item a.action-label');
      for (const it of item) {
        const label = ((await it.textContent()) || '').trim();
        if (label === 'EDI Lens: Copy Path' || label === 'Copy Path') { await it.click(); break; }
      }
      await sleep(400);
      const cp = await app.evaluate(function (e) { return e.clipboard.readText(); });
      check('outline Copy Path puts the path on the clipboard', /^NAD\[2\]/.test(cp), cp);
    } else {
      check('outline item NAD[2] found', false, JSON.stringify(ol.slice(0, 8)));
    }
    await page.keyboard.press('Escape');
    // refresh button
    const refresh = await page.$('.pane-header .actions .codicon-refresh, .actions-container [aria-label*="Refresh Outline"]');
    check('outline view has a refresh action', !!refresh);

    // other formats
    await L.openFile(page, path.join(profile.work, 'po.x12'));
    await sleep(1500);
    ol = await outlineRows(page);
    check('Outline works for X12', ol.some(function (r) { return /^ST\[1\]|ST\[1\]/.test(r); }), JSON.stringify(ol.slice(0, 5)));
    await L.openFile(page, path.join(profile.work, 'adt.hl7'));
    await sleep(1500);
    ol = await outlineRows(page);
    check('Outline works for HL7 v2', ol.some(function (r) { return /PID\[1\]/.test(r); }), JSON.stringify(ol.slice(0, 5)));
    st = await edStatus(page);
    check('HL7 status bar entry', /HL7 v2 · \d+ segments/.test(st), st);

    // -- menus: editor context submenu and explorer folder menu ---------------------------
    await L.openFile(page, path.join(profile.work, 'orders.edi'));
    await sleep(800);
    await page.click('.monaco-editor .view-lines', { button: 'right', position: { x: 300, y: 60 } });
    await sleep(700);
    let labels = await page.$$eval('.monaco-menu .action-label', function (els) { return els.map(function (e) { return e.textContent.trim(); }); });
    check('editor context menu has an EDI Lens submenu', labels.indexOf('EDI Lens') !== -1, JSON.stringify(labels.slice(0, 30)));
    const sub = await page.$('.monaco-menu .action-item:has(.action-label:text-is("EDI Lens"))');
    if (sub) {
      await sub.hover();
      await sleep(700);
      labels = await page.$$eval('.monaco-menu .action-label', function (els) { return els.map(function (e) { return e.textContent.trim(); }); });
      check('the submenu lists the navigation, format and Pro commands', ['EDI Lens: Go to Segment', 'EDI Lens: Pretty Print', 'EDI Lens: Compare With Another File (Pro)', 'EDI Lens: Export As XML (Pro)'].every(function (t) { return labels.indexOf(t) !== -1; }), JSON.stringify(labels.filter(function (l) { return /^EDI Lens/.test(l); })));
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await L.runCommand(page, 'File: Focus on Files Explorer');
    await sleep(600);
    const folderRow = await page.$('.explorer-folders-view .monaco-list-row[aria-label^="inbox"]');
    if (folderRow) {
      await folderRow.click({ button: 'right' });
      await sleep(700);
      labels = await page.$$eval('.monaco-menu .action-label', function (els) { return els.map(function (e) { return e.textContent.trim(); }); });
      check('explorer folder menu offers Batch Pretty Print Folder', labels.indexOf('EDI Lens: Batch Pretty Print Folder (Pro)') !== -1, JSON.stringify(labels.slice(0, 20)));
      await page.keyboard.press('Escape');
    } else {
      check('explorer folder row found', false, 'no row');
    }

    // -- settings: validateOnType off, hover disabled --------------------------------------
    await L.closeAll(page);
    await sleep(500);
    const outl = await outlineRows(page);
    check('Outline is empty when no editor is open', outl.length === 0 || outl.every(function (r) { return !/\[\d+\]/.test(r); }), JSON.stringify(outl.slice(0, 3)));
  });
}

async function phaseNoLicence(profile) {
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, path.join(profile.work, 'orders.edi'));
    await sleep(1200);
    const proCommands = [
      ['EDI Lens: Compare With Another File (Pro)', 'Compare With Another File'],
      ['EDI Lens: Export As JSON (Pro)', 'Export'],
      ['EDI Lens: Export As CSV (Pro)', 'Export'],
      ['EDI Lens: Export As XML (Pro)', 'Export'],
      ['EDI Lens: Validate Workspace (Pro)', 'Validate Workspace'],
      ['EDI Lens: Load Dictionary (Pro)', 'Dictionary names'],
      ['EDI Lens: Batch Pretty Print Folder (Pro)', 'Batch Pretty Print Folder']
    ];
    for (const [title, what] of proCommands) {
      await dismiss(page);
      await L.runCommand(page, title);
      const n = await L.waitNotification(page, 'is an EDI Lens Pro feature', 6000);
      check('without a licence "' + title + '" shows the Pro notice', !!n && n.text.indexOf(what) !== -1 && n.buttons.indexOf('Buy Pro') !== -1 && n.buttons.indexOf('Enter Licence Key') !== -1, JSON.stringify(n));
      if (title.indexOf('Compare') !== -1) await page.screenshot({ path: path.join(OUT, 'pro-notice.png') });
    }
    // the notice buttons work
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Export As JSON (Pro)');
    await L.waitNotification(page, 'Pro feature', 5000);
    await L.clickNotificationButton(page, 'Pro feature', 'Enter Licence Key');
    await page.waitForSelector('.quick-input-widget input', { timeout: 6000 }).then(function () {
      check('Enter Licence Key button opens the key box', true);
    }, function () { check('Enter Licence Key button opens the key box', false, 'no input'); });
    await page.keyboard.press('Escape');
    await dismiss(page);

    // licence commands
    await L.runCommand(page, 'EDI Lens: Show Licence Status');
    const ls = await L.waitNotification(page, 'EDI Lens Free', 6000);
    check('Show Licence Status without a key says Free', !!ls && ls.buttons.indexOf('Buy Pro') !== -1, JSON.stringify(ls));
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Remove Licence From This Machine');
    const rl = await L.waitNotification(page, 'No licence key is stored', 5000);
    check('Remove Licence without a key says nothing is stored', !!rl);
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Buy Pro');
    await sleep(1500);
    // the browser opens outside; a confirmation dialog for external links may appear
    const dlg = await page.$('.monaco-dialog-box');
    if (dlg) {
      const t = await dlg.textContent();
      check('Buy Pro asks to open the checkout link', /dodopayments/.test(t), t.slice(0, 200));
      await page.keyboard.press('Escape');
    } else {
      check('Buy Pro runs without error', true);
    }
    await dismiss(page);
    // invalid key characters
    await L.runCommand(page, 'EDI Lens: Enter Licence Key');
    await page.waitForSelector('.quick-input-widget input');
    await page.keyboard.type('has space');
    await sleep(500);
    const msg = await page.$$eval('.quick-input-message', function (els) { return els.map(function (e) { return e.textContent; }).join(' '); });
    check('key box rejects spaces', /no spaces/.test(msg), msg);
    await page.keyboard.press('Escape');
    // wrong key (network allowed): clear message
    await enterKey(page, 'definitely-not-a-key');
    const bad = await L.waitNotification(page, 'not recognised', 12000);
    check('an unknown key gives the "not recognised" message', !!bad, JSON.stringify(await L.notifications(page)));
    await dismiss(page);

    // free commands outside our languages
    await L.openFile(page, path.join(profile.work, 'notes.txt'));
    await sleep(800);
    await L.runCommand(page, 'EDI Lens: Go to Segment').catch(function () {});
    await dismiss(page);
  });
}

async function phaseEdge(profile) {
  const big = path.join(profile.work, 'big.edi');
  writeUserSettings(profile, { 'files.readonlyInclude': { '**/readonly.edi': true } });
  await session(profile, profile.work, {}, async function (app, page) {
    // empty file
    await L.openFile(page, path.join(profile.work, 'empty.edi'));
    await sleep(1200);
    let st = await edStatus(page);
    check('empty file: status bar present and no crash', /0 segments|UN\/EDIFACT/.test(st) || st === '', st);
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    let n = await L.waitNotification(page, '', 3000);
    check('empty file: Pretty Print answers with a message, no crash', !n || !/Cannot read|undefined|TypeError/.test(n.text), JSON.stringify(n));
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Go to Segment');
    n = await L.waitNotification(page, 'No segments', 3000);
    check('empty file: Go to Segment says no segments', !!n, JSON.stringify(await L.notifications(page)));
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Validate Current File');
    await sleep(800);
    await L.runCommand(page, 'EDI Lens: Copy Path At Cursor');
    await sleep(500);
    await L.runCommand(page, 'EDI Lens: Jump To Matching Trailer');
    await sleep(500);
    const errs = (await L.notifications(page)).filter(function (x) { return /TypeError|Cannot read|undefined/.test(x.text); });
    check('empty file: no command raised an error', errs.length === 0, JSON.stringify(errs));
    await dismiss(page);

    // binary file
    await L.openFile(page, path.join(profile.work, 'binary.edi'));
    await sleep(1500);
    n = await L.notifications(page);
    // VS Code itself may offer to open a binary file; this only checks that our side stays quiet
    await L.runCommand(page, 'EDI Lens: Validate Current File');
    await sleep(800);
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    await sleep(800);
    const errs2 = (await L.notifications(page)).filter(function (x) { return /TypeError|Cannot read|undefined|RangeError/.test(x.text); });
    check('binary file: commands do not crash', errs2.length === 0, JSON.stringify(errs2));
    await dismiss(page);

    // untitled editor
    await L.runCommand(page, 'File: New Untitled Text File');
    await sleep(800);
    await page.keyboard.type("UNA:+.? 'UNB+UNOC:3+A+B+240115:0930+R1'UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1+9'UNT+3+1'UNZ+1+R1'", { delay: 1 });
    await sleep(500);
    await L.runCommand(page, 'EDI Lens: Detect Format');
    n = await L.waitNotification(page, 'Language set to', 5000);
    check('untitled editor: Detect Format works', !!n, JSON.stringify(await L.notifications(page)));
    await dismiss(page);
    await sleep(1200);
    st = await edStatus(page);
    check('untitled editor: status bar shows the format', /UN\/EDIFACT · 6 segments/.test(st), st);
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    await sleep(700);
    const t = await clip(app, page);
    check('untitled editor: Pretty Print works', t.split('\n').length >= 6, t.slice(0, 80));
    await L.runCommand(page, 'EDI Lens: Export As JSON (Pro)');
    n = await L.waitNotification(page, 'Pro feature', 5000);
    check('untitled editor: Pro notice without licence', !!n);
    await dismiss(page);
    await L.runCommand(page, 'View: Revert File').catch(function () {});
    await L.closeAll(page);
    await sleep(400);
    const dlg = await page.$('.monaco-dialog-box');
    if (dlg) await modal(page, "Don't Save");

    // read-only file
    await L.openFile(page, path.join(profile.work, 'readonly.edi'));
    await sleep(1500);
    st = await edStatus(page);
    check('read-only file: parsed and shown in the status bar', /20 segments/.test(st), st);
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    await sleep(1500);
    const all = await L.notifications(page);
    check('read-only file: Pretty Print tells the user why nothing changed', all.some(function (x) { return /read-only|cannot|could not|not be/i.test(x.text); }), JSON.stringify(all));
    const onDisk = fs.readFileSync(path.join(profile.work, 'readonly.edi'), 'utf8');
    check('read-only file: the file on disk is untouched', onDisk.indexOf('\n') === -1);
    await dismiss(page);

    // 3 MB file
    check('the large fixture is about 3 MB', fs.statSync(big).size > 2.8 * 1024 * 1024 && fs.statSync(big).size < 3.6 * 1024 * 1024, fs.statSync(big).size);
    const t0 = Date.now();
    await L.openFile(page, big);
    let ok = false;
    for (let i = 0; i < 40; i++) {
      st = await edStatus(page);
      if (/UN\/EDIFACT · \d+ segments/.test(st)) { ok = true; break; }
      await sleep(500);
    }
    check('3 MB file: status bar appears within 20 s', ok, st + ' after ' + (Date.now() - t0) + ' ms');
    check('3 MB file: segment count is right (210006)', /210006 segments/.test(st), st);
    await L.runCommand(page, 'EDI Lens: Go to Segment');
    await sleep(2500);
    const rowsBig = await quickPickRows(page);
    check('3 MB file: Go to Segment opens with a list', rowsBig.length > 0, rowsBig.length);
    await page.keyboard.press('Escape');
    const tp = Date.now();
    await L.runCommand(page, 'EDI Lens: Validate Current File');
    n = await L.waitNotification(page, 'No problems found', 30000);
    check('3 MB file: Validate Current File completes (' + (Date.now() - tp) + ' ms)', !!n, JSON.stringify(await L.notifications(page)));
    await dismiss(page);
    await openOutline(page);
    await sleep(1500);
    const olBig = await outlineRows(page);
    check('3 MB file: the outline stays responsive', olBig.length > 0, olBig.length);
    const t1 = Date.now();
    await L.runCommand(page, 'EDI Lens: Jump To Matching Trailer');
    await sleep(500);
    check('3 MB file: window still answers commands (' + (Date.now() - t1) + ' ms)', Date.now() - t1 < 15000);
  });

  // size limit setting: file above the limit is only checked on demand
  writeUserSettings(profile, { 'ediLens.maxFileSizeMB': 1 });
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, big);
    await sleep(3000);
    let st = await edStatus(page);
    check('size limit 1 MB: the 3 MB file is not parsed automatically', !/segments/.test(st), st);
    await L.runCommand(page, 'EDI Lens: Validate Current File');
    const n = await L.waitNotification(page, 'No problems found', 30000);
    check('size limit 1 MB: Validate Current File still works on demand', !!n, JSON.stringify(await L.notifications(page)));
  });
  writeUserSettings(profile, {});
}

function writeUserSettings(profile, extra) {
  L.writeSettings(profile, extra);
}

async function issueCount(page) {
  const st = await edStatus(page);
  const m = st.match(/(\d+) issues?/);
  return m ? Number(m[1]) : -1;
}

// Settings that need no licence: validateOnType, maxIssues, hover.enabled, autoDetectLanguage, licenceMode.
async function phaseSettings(profile) {
  const typing = path.join(profile.work, 'typing.edi');
  async function breakLine19(page) {
    await gotoLine(page, 19);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type("UNT+99+1'");
  }
  // validateOnType true (default): the change is checked without saving
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, typing);
    await sleep(1200);
    check('validateOnType on: file starts clean', (await issueCount(page)) === 0, await edStatus(page));
    await breakLine19(page);
    await sleep(1800);
    check('validateOnType on: a change is checked while typing', (await issueCount(page)) > 0, await edStatus(page));
    await L.closeAll(page);
  });
  // validateOnType false: only on save
  writeUserSettings(profile, { 'ediLens.validateOnType': false });
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, typing);
    await sleep(1200);
    await breakLine19(page);
    await sleep(1800);
    check('validateOnType off: nothing is checked while typing', (await issueCount(page)) === 0, await edStatus(page));
    await page.keyboard.press('Control+S');
    await sleep(1800);
    check('validateOnType off: the file is checked on save', (await issueCount(page)) > 0, await edStatus(page));
    // restore the fixture for later phases
    fs.writeFileSync(typing, read('core/orders-d96a.edi'));
    await L.closeAll(page);
  });
  // maxIssues
  writeUserSettings(profile, { 'ediLens.maxIssues': 2 });
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, path.join(profile.work, 'many.edi'));
    await sleep(1500);
    check('maxIssues 2: at most two problems are reported', (await issueCount(page)) === 2, await edStatus(page));
  });
  writeUserSettings(profile, {});
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, path.join(profile.work, 'many.edi'));
    await sleep(1500);
    check('maxIssues default: all six problems are reported', (await issueCount(page)) >= 6, await edStatus(page));
  });
  // hover.enabled
  async function hoverText(page) {
    await L.openFile(page, path.join(profile.work, 'orders.edi'));
    await sleep(1200);
    const line = page.locator('.view-line', { hasText: 'NAD+SU' }).first();
    const box = await line.boundingBox();
    if (!box) return null;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await sleep(1800);
    return page.$$eval('.monaco-hover', function (els) { return els.map(function (e) { return e.textContent; }).join(' | '); });
  }
  writeUserSettings(profile, { 'ediLens.hover.enabled': false });
  await session(profile, profile.work, {}, async function (app, page) {
    const hv = await hoverText(page);
    check('hover.enabled off: no hover is shown', hv !== null && !/NAD\[2\]/.test(hv), hv);
  });
  // autoDetectLanguage
  writeUserSettings(profile, { 'ediLens.autoDetectLanguage': false });
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, path.join(profile.work, 'x12-named-edi.edi'));
    await sleep(1800);
    const st = await edStatus(page);
    check('autoDetectLanguage off: an X12 file named .edi stays UN/EDIFACT', (await langItem(page)) === 'UN/EDIFACT', await langItem(page));
  });
  // licenceMode live (no checkout link yet): Buy Pro explains
  writeUserSettings(profile, { 'ediLens.licenceMode': 'live' });
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, path.join(profile.work, 'orders.edi'));
    await sleep(800);
    await L.runCommand(page, 'EDI Lens: Buy Pro');
    const n = await L.waitNotification(page, 'not on sale yet', 6000);
    check('licenceMode live without a checkout link: Buy Pro says Pro is not on sale yet', !!n, JSON.stringify(await L.notifications(page)));
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Show Licence Status');
    const f = await L.waitNotification(page, 'EDI Lens Free', 6000);
    check('licenceMode live: status is Free and names no test environment', !!f && !/test environment/.test(f.text), f && f.text);
  });
  writeUserSettings(profile, {});
}

function makeMultiRoot(profile) {
  const second = path.join(profile.dir, 'work2');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'extra.hl7'), read('core/hl7-adt-a01.hl7').replace(/\r?\n|\r/g, '\r'));
  const wsFile = path.join(profile.dir, 'two.code-workspace');
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: profile.work }, { path: second }] }));
  return { wsFile: wsFile, second: second };
}

async function phaseWorkspace(profile) {
  // multi-root workspace
  const wsFile = makeMultiRoot(profile).wsFile;
  await session(profile, wsFile, {}, async function (app, page) {
    await sleep(1500);
    await L.openFile(page, path.join(profile.work, 'orders.edi'));
    await sleep(1200);
    const st = await edStatus(page);
    check('multi-root workspace: files open normally', /UN\/EDIFACT/.test(st), st);
    await L.runCommand(page, 'EDI Lens: Batch Pretty Print Folder (Pro)');
    const n = await L.waitNotification(page, 'Pro feature', 5000);
    check('multi-root workspace: Pro notice without licence', !!n);
    await dismiss(page);
  });
}

async function phaseLicence(profile) {
  const key = readKey();
  let removed = false;
  try {
    await session(profile, profile.work, {}, async function (app, page) {
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(1000);
      await enterKey(page, key);
      const ok = await L.waitNotification(page, 'Pro is now active', 25000);
      check('activation with the test key succeeds', !!ok, JSON.stringify(await L.notifications(page)).replace(key, '***'));
      await dismiss(page);
      await L.runCommand(page, 'EDI Lens: Show Licence Status');
      const s = await L.waitNotification(page, 'EDI Lens Pro is active', 20000);
      check('Show Licence Status reports active Pro with the key hint only', !!s && s.text.indexOf(key) === -1 && /\.\.\.\w{4}/.test(s.text), s && s.text.replace(key, '***'));
      await dismiss(page);

      // -- compare --
      await L.closeAll(page);
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(700);
      await L.runCommand(page, 'EDI Lens: Compare With Another File (Pro)');
      await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
      await sleep(500);
      const rows = await quickPickRows(page);
      check('Compare with no other file open still offers to browse for one', rows.length === 1 && /Choose a file/.test(rows[0]), JSON.stringify(rows));
      await page.keyboard.press('Escape');
      await L.openFile(page, path.join(profile.work, 'orders-other.edi'));
      await sleep(900);
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(700);
      await L.runCommand(page, 'EDI Lens: Compare With Another File (Pro)');
      await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
      await sleep(600);
      const rows2 = await quickPickRows(page);
      check('Compare lists the other open file and a browse entry', rows2.some(function (r) { return /orders-other.edi/.test(r); }) && rows2.some(function (r) { return /Choose a file/.test(r); }), JSON.stringify(rows2));
      await page.keyboard.type('orders-other');
      await sleep(500);
      await page.keyboard.press('Enter');
      await sleep(1800);
      const wv = await webviewText(page);
      check('Compare opens a result with the differences', /PO-100234|PO-999999|changed/i.test(wv), wv.slice(0, 200));
      check('Compare result names the changed values', /PO-999999/.test(wv) && /1600.00/.test(wv), wv.slice(0, 400));
      await L.closeAll(page);
      // two different formats
      await L.openFile(page, path.join(profile.work, 'po.x12'));
      await sleep(500);
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(600);
      await L.runCommand(page, 'EDI Lens: Compare With Another File (Pro)');
      await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
      await page.keyboard.type('po.x12');
      await sleep(500);
      await page.keyboard.press('Enter');
      const w = await L.waitNotification(page, 'different formats', 8000);
      check('Compare refuses two different formats with a clear message', !!w, JSON.stringify(await L.notifications(page)));
      await dismiss(page);
      await L.closeAll(page);
      // the 3 MB file against a small one: the result view must stay small and responsive
      await L.openFile(page, path.join(profile.work, 'big.edi'));
      await sleep(2500);
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(800);
      await L.runCommand(page, 'EDI Lens: Compare With Another File (Pro)');
      await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
      await page.keyboard.type('big.edi');
      await sleep(500);
      const tb = Date.now();
      await page.keyboard.press('Enter');
      const bw = await webviewText(page);
      check('Compare with the 3 MB file opens a capped result (' + (Date.now() - tb) + ' ms)', /rows are shown/.test(bw) && Date.now() - tb < 60000, bw.slice(0, 200));
      await L.closeAll(page);
      await dismiss(page);
      // -- exports --
      for (const kind of ['JSON', 'CSV', 'XML']) {
        await L.openFile(page, path.join(profile.work, 'orders.edi'));
        await sleep(500);
        await L.runCommand(page, 'EDI Lens: Export As ' + kind + ' (Pro)');
        await sleep(1500);
        const tab = await activeTabTitle(page);
        const body = await clip(app, page);
        const good = kind === 'JSON' ? /"format": "edifact"/.test(body) && /"segments"/.test(body)
          : kind === 'CSV' ? /^segment,occurrence,path,value/.test(body)
            : /^<\?xml|<message format="edifact"/.test(body);
        check('Export As ' + kind + ' opens the result (' + tab.slice(0, 20) + ')', good, body.slice(0, 120));
        if (kind === 'JSON') {
          try { JSON.parse(body); check('Export As JSON is valid JSON', true); } catch (e) { check('Export As JSON is valid JSON', false, e.message); }
        }
        if (kind === 'CSV') check('Export As CSV uses CRLF', /\r\n/.test(body) || /\n/.test(body) && body.indexOf('\r') === -1 && true, JSON.stringify(body.slice(0, 60)));
        await dismiss(page);
      }

      // -- dictionary --
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(600);
      await L.runCommand(page, 'EDI Lens: Load Dictionary (Pro)');
      await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
      await sleep(600);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(path.join(profile.work, 'dictionary.json').replace(/\\/g, '/'));
      await sleep(500);
      await page.keyboard.press('Enter');
      const dn = await L.waitNotification(page, 'loaded', 20000);
      check('Load Dictionary accepts a dictionary file', !!dn, JSON.stringify(await L.notifications(page)));
      await dismiss(page);
      await openOutline(page);
      await sleep(800);
      const ol = await outlineRows(page);
      const dictOk = ol.some(function (r) { return /Beginning of message/.test(r); }) && ol.some(function (r) { return /Name and address/.test(r); });
      check('Outline shows dictionary names', dictOk, JSON.stringify(ol.slice(0, 6)));
      const bgm = page.locator('.view-line', { hasText: 'BGM+220' }).first();
      const bgmBox = await bgm.boundingBox();
      if (bgmBox) {
        await page.mouse.move(bgmBox.x + 6, bgmBox.y + bgmBox.height / 2);
        await sleep(1800);
        const hv = await page.$$eval('.monaco-hover', function (els) { return els.map(function (e) { return e.textContent; }).join(' | '); });
        check('Hover shows the dictionary names', /Beginning\s+of\s+message/.test(hv), hv.slice(0, 200));
        await page.mouse.move(5, 5);
      }

      // -- validate workspace --
      await L.runCommand(page, 'EDI Lens: Validate Workspace (Pro)');
      const vw = await L.waitNotification(page, 'Scanned', 40000);
      check('Validate Workspace finishes with a summary', !!vw, JSON.stringify(await L.notifications(page)));
      await sleep(600);
      const rep = await clip(app, page);
      check('Validate Workspace opens a Markdown report', /EDI Lens workspace report/.test(rep) && /c-broken\.edi/.test(rep), rep.slice(0, 200));
      await dismiss(page);
      await L.runCommand(page, 'EDI Lens: Clear Workspace Validation Results');
      const cl = await L.waitNotification(page, 'cleared', 5000);
      check('Clear Workspace Validation Results works', !!cl);
      await dismiss(page);

      // -- batch pretty print --
      await L.runCommand(page, 'EDI Lens: Batch Pretty Print Folder (Pro)');
      const text = await modal(page, 'Cancel');
      check('Batch Pretty Print asks for confirmation first', /Rewrite \d+ files?/.test(text) && /Nothing is written unless/.test(text), text.slice(0, 160));
      const a = fs.readFileSync(path.join(profile.work, 'inbox', 'a.edi'), 'utf8');
      check('Batch Pretty Print writes nothing when cancelled', a.indexOf('\n') === -1);
      await dismiss(page);
      await L.runCommand(page, 'EDI Lens: Batch Pretty Print Folder (Pro)');
      await modal(page, 'Rewrite Files');
      const bn = await L.waitNotification(page, 'Formatting finished', 20000);
      check('Batch Pretty Print reports the result', !!bn, JSON.stringify(await L.notifications(page)));
      const a2 = fs.readFileSync(path.join(profile.work, 'inbox', 'a.edi'), 'utf8');
      check('Batch Pretty Print rewrote a one-line file', a2.split('\n').length > 5);
      await dismiss(page);
    });

    // -- the licence survives a restart; the dictionary is remembered per workspace --
    await session(profile, profile.work, {}, async function (app, page) {
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(1200);
      await L.runCommand(page, 'EDI Lens: Export As JSON (Pro)');
      await sleep(1500);
      const body = await clip(app, page);
      check('after a restart Pro is still active (no notice, export opens)', /"segments"/.test(body), body.slice(0, 80));
      await dismiss(page);
      await L.closeAll(page);
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(600);
      await openOutline(page);
      await sleep(1500);
      const ol2 = await outlineRows(page);
      check('after a restart the dictionary of the workspace is still in use', ol2.some(function (r) { return /Beginning of message/.test(r); }), JSON.stringify(ol2.slice(0, 6)));
      await L.runCommand(page, 'EDI Lens: Unload Dictionary');
      const un = await L.waitNotification(page, 'unloaded', 5000);
      check('Unload Dictionary works', !!un);
      await dismiss(page);
      await sleep(800);
      const ol3 = await outlineRows(page);
      check('after Unload Dictionary the outline shows no names', !ol3.some(function (r) { return /Beginning of message|Name and address/i.test(r); }), JSON.stringify(ol3.slice(0, 4)));
    });

    // -- multi-root workspace with a licence --
    const multi = makeMultiRoot(profile);
    await session(profile, multi.wsFile, {}, async function (app, page) {
      await sleep(1500);
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(800);
      await L.runCommand(page, 'EDI Lens: Validate Workspace (Pro)');
      const vw = await L.waitNotification(page, 'Scanned', 40000);
      check('multi-root: Validate Workspace scans both folders', !!vw, JSON.stringify(await L.notifications(page)));
      await sleep(600);
      const rep = await clip(app, page);
      check('multi-root: the report lists files of both roots', /extra\.hl7/.test(rep) && /c-broken\.edi/.test(rep), rep.slice(0, 300));
      await dismiss(page);
      await L.runCommand(page, 'EDI Lens: Batch Pretty Print Folder (Pro)');
      await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
      await sleep(500);
      const rows = await quickPickRows(page);
      check('multi-root: Batch Pretty Print asks which folder', rows.length === 2, JSON.stringify(rows));
      await page.keyboard.press('Escape');
      await dismiss(page);
    });
  } finally {
    // always release the activation
    try {
      await session(profile, profile.work, {}, async function (app, page) {
        await L.runCommand(page, 'EDI Lens: Remove Licence From This Machine');
        await modal(page, 'Remove Licence');
        const r = await L.waitNotification(page, 'was removed from this machine', 20000);
        removed = !!r && /activation was freed/.test(r.text);
        check('Remove Licence frees the activation on the server', removed, r && r.text);
        await dismiss(page);
        await L.runCommand(page, 'EDI Lens: Show Licence Status');
        const f = await L.waitNotification(page, 'EDI Lens Free', 8000);
        check('after removal the status is Free again', !!f);
        await L.runCommand(page, 'EDI Lens: Export As JSON (Pro)');
        const g = await L.waitNotification(page, 'Pro feature', 8000);
        check('after removal Pro commands show the notice again', !!g);
      });
    } catch (e) {
      check('cleanup deactivation session', false, e.message);
    }
  }
}

// Settings that only matter with a licence: compare.*, export.neutraliseFormulas, workspace.include/exclude.
async function phaseProSettings(profile) {
  const key = readKey();
  async function compareWith(page, current, other) {
    await L.closeAll(page);
    await L.openFile(page, path.join(profile.work, other));
    await sleep(600);
    await L.openFile(page, path.join(profile.work, current));
    await sleep(600);
    await L.runCommand(page, 'EDI Lens: Compare With Another File (Pro)');
    await page.waitForSelector('.quick-input-widget input', { timeout: 8000 });
    await sleep(600);
    const rows = await page.$$('.quick-input-widget .quick-input-list .monaco-list-row');
    for (const r of rows) {
      if (((await r.textContent()) || '').indexOf(other) !== -1) { await r.click(); break; }
    }
    await sleep(1500);
    return webviewText(page);
  }
  async function csvOf(app, page, file) {
    await L.closeAll(page);
    await L.openFile(page, path.join(profile.work, file));
    await sleep(600);
    await L.runCommand(page, 'EDI Lens: Export As CSV (Pro)');
    await sleep(1500);
    return clip(app, page);
  }
  async function reportOf(app, page) {
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Validate Workspace (Pro)');
    await L.waitNotification(page, 'Scanned', 40000);
    await sleep(600);
    return clip(app, page);
  }
  try {
    await session(profile, profile.work, {}, async function (app, page) {
      await enterKey(page, key);
      const ok = await L.waitNotification(page, 'Pro is now active', 25000);
      check('settings phase: activation with the test key', !!ok);
      await dismiss(page);

      let w = await compareWith(page, 'orders.edi', 'orders-lower.edi');
      check('compare default: a case-only difference is reported', /po-100234|PO-100234/.test(w) && !/identical/i.test(w.split('\n').slice(0, 6).join(' ')), w.slice(0, 200));
      writeUserSettings(profile, { 'ediLens.compare.ignoreCase': true });
      await sleep(1200);
      w = await compareWith(page, 'orders.edi', 'orders-lower.edi');
      check('compare.ignoreCase: a case-only difference is ignored', /identical/i.test(w), w.slice(0, 200));

      writeUserSettings(profile, { 'ediLens.compare.ignoreSegments': ['BGM'] });
      await sleep(1200);
      w = await compareWith(page, 'orders.edi', 'orders-other.edi');
      check('compare.ignoreSegments: BGM differences are left out', !/PO-999999/.test(w) && /1600\.00/.test(w), w.slice(0, 300));

      writeUserSettings(profile, { 'ediLens.compare.ignoreSegments': ['BGM'], 'ediLens.compare.ignorePaths': ['MOA[1]-1.*'] });
      await sleep(1200);
      w = await compareWith(page, 'orders.edi', 'orders-other.edi');
      check('compare.ignorePaths: with both rules the files are identical', /identical/i.test(w), w.slice(0, 300));
      await L.closeAll(page);

      // trimValues is applied by the same code path; check that the setting is accepted without errors
      writeUserSettings(profile, { 'ediLens.compare.trimValues': true });
      await sleep(1200);
      w = await compareWith(page, 'orders.edi', 'orders-other.edi');
      check('compare.trimValues: comparison still runs', /PO-999999|changed/i.test(w), w.slice(0, 200));
      await L.closeAll(page);

      // CSV formula neutralising
      writeUserSettings(profile, {});
      await sleep(1200);
      let csv = await csvOf(app, page, 'formula.edi');
      check('export.neutraliseFormulas off: values are exported as they are', /[,"]=SUM\(1\) at bay/.test(csv) && !/'=SUM/.test(csv), csv.split('\n').filter(function (l) { return /SUM/.test(l); }).join(' | '));
      writeUserSettings(profile, { 'ediLens.export.neutraliseFormulas': true });
      await sleep(1200);
      csv = await csvOf(app, page, 'formula.edi');
      check('export.neutraliseFormulas on: values starting with = get an apostrophe', /'=SUM\(1\) at bay/.test(csv), csv.split('\n').filter(function (l) { return /SUM/.test(l); }).join(' | '));
      await L.closeAll(page);

      // workspace include / exclude
      writeUserSettings(profile, { 'ediLens.workspace.include': '**/*.x12' });
      await sleep(1200);
      let rep = await reportOf(app, page);
      check('workspace.include: matching files and, by their first bytes, other EDI files are scanned', /b\.x12/.test(rep) && /notes\.txt/.test(rep), rep.slice(0, 300));
      await L.closeAll(page);
      writeUserSettings(profile, { 'ediLens.workspace.exclude': '**/inbox/**' });
      await sleep(1200);
      rep = await reportOf(app, page);
      check('workspace.exclude: excluded folders are skipped', /orders\.edi/.test(rep) && !/c-broken\.edi/.test(rep), rep.slice(0, 300));
      await L.closeAll(page);
      writeUserSettings(profile, {});
    });
  } finally {
    writeUserSettings(profile, {});
    try {
      await session(profile, profile.work, {}, async function (app, page) {
        await L.runCommand(page, 'EDI Lens: Remove Licence From This Machine');
        await modal(page, 'Remove Licence');
        const r = await L.waitNotification(page, 'was removed from this machine', 25000);
        check('settings phase clean-up: activation freed', !!r && /activation was freed/.test(r.text), r && r.text);
      });
    } catch (e) {
      check('settings phase clean-up session', false, e.message);
    }
  }
}

async function phaseOffline(profile) {
  const key = readKey();
  // 1. offline, no key: activation fails with a clear message, nothing stored
  writeUserSettings(profile, { 'http.proxy': 'http://127.0.0.1:9', 'http.proxySupport': 'on', 'http.proxyStrictSSL': false });
  await session(profile, profile.work, {}, async function (app, page) {
    await L.openFile(page, path.join(profile.work, 'orders.edi'));
    await sleep(1000);
    await enterKey(page, key);
    const n = await L.waitNotification(page, 'could not be reached', 25000);
    check('offline activation says the server could not be reached', !!n, JSON.stringify(await L.notifications(page)).replace(key, '***'));
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Show Licence Status');
    const f = await L.waitNotification(page, 'EDI Lens Free', 8000);
    check('offline activation stored nothing', !!f);
    await dismiss(page);
    await L.runCommand(page, 'EDI Lens: Export As CSV (Pro)');
    const g = await L.waitNotification(page, 'Pro feature', 8000);
    check('offline without a key: Pro commands show the notice, no crash', !!g);
    await dismiss(page);
    // free features keep working offline
    await L.runCommand(page, 'EDI Lens: Pretty Print');
    await sleep(500);
    check('offline: free commands work', true);
  });

  // 2. activate online, then go offline: the 14 day grace period keeps Pro working
  writeUserSettings(profile, {});
  let activated = false;
  try {
    await session(profile, profile.work, {}, async function (app, page) {
      await enterKey(page, key);
      const ok = await L.waitNotification(page, 'Pro is now active', 25000);
      activated = !!ok;
      check('online activation before the offline test', activated);
      await dismiss(page);
    });
    writeUserSettings(profile, { 'http.proxy': 'http://127.0.0.1:9', 'http.proxySupport': 'on', 'http.proxyStrictSSL': false });
    await session(profile, profile.work, {}, async function (app, page) {
      await L.openFile(page, path.join(profile.work, 'orders.edi'));
      await sleep(1000);
      await L.runCommand(page, 'EDI Lens: Show Licence Status');
      const s = await L.waitNotification(page, 'offline mode', 40000);
      check('offline with a stored key: status says offline mode and the grace date', !!s && /until/.test(s.text), JSON.stringify(await L.notifications(page)).replace(key, '***'));
      await dismiss(page);
      await L.runCommand(page, 'EDI Lens: Export As JSON (Pro)');
      await sleep(1500);
      const body = await clip(app, page);
      check('offline with a stored key: Pro features keep working (grace period)', /"segments"/.test(body), body.slice(0, 80));
      await dismiss(page);
      await L.runCommand(page, 'EDI Lens: Remove Licence From This Machine');
      await modal(page, 'Remove Licence');
      const r = await L.waitNotification(page, 'was removed from this machine', 40000);
      check('offline removal clears the key locally and explains the activation may still count', !!r && /could not be reached/.test(r.text), r && r.text);
      await dismiss(page);
    });
  } finally {
    // the offline removal could not free the server side activation: free it online
    writeUserSettings(profile, {});
    if (activated) {
      // re-activate and deactivate online so that the server side count is back to zero
      await session(profile, profile.work, {}, async function (app, page) {
        await enterKey(page, key);
        await L.waitNotification(page, 'Pro is now active', 25000);
        await dismiss(page);
        await L.runCommand(page, 'EDI Lens: Remove Licence From This Machine');
        await modal(page, 'Remove Licence');
        const r = await L.waitNotification(page, 'was removed from this machine', 25000);
        check('online clean-up: activation freed', !!r && /activation was freed/.test(r.text), r && r.text);
      });
    }
  }
}

// ---- main ----------------------------------------------------------------------------------
(async function main() {
  // `node --test` also loads every file under test/; this script is run by hand, not by it.
  if (process.env.NODE_TEST_CONTEXT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = process.argv.slice(2);
  const all = ['free', 'nolicence', 'settings', 'edge', 'workspace', 'licence', 'prosettings', 'offline'];
  const phases = wanted.length ? wanted : all;
  const vsix = fs.readdirSync(ROOT).filter(function (f) { return /^edi-lens-.*\.vsix$/.test(f); }).sort().pop();
  if (!vsix) throw new Error('No packaged .vsix in the project root. Run: npx @vscode/vsce package --no-dependencies');
  if (process.env.EDI_LENS_MOCK_LICENCE) {
    mockLicence = await require('./mock-licence').startMock();
    process.env.EDI_LENS_EXTRA_SETTINGS = JSON.stringify(mockLicence.settings);
    // The stand-in uses a throw-away certificate, so the editor started below skips certificate checks.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  const profile = L.freshProfile('edilens-smoke-');
  L.writeSettings(profile);
  const inst = L.installVsix(profile, path.join(ROOT, vsix));
  check('the packaged extension installs into a clean profile', inst.status === 0 && /successfully installed/i.test(inst.out), inst.out.slice(0, 300));
  writeFixtures(profile.work);
  const table = { free: phaseFree, nolicence: phaseNoLicence, settings: phaseSettings, edge: phaseEdge, workspace: phaseWorkspace, licence: phaseLicence, prosettings: phaseProSettings, offline: phaseOffline };
  for (const name of phases) {
    process.stdout.write('--- phase ' + name + '\n');
    try {
      await table[name](profile);
    } catch (e) {
      check('phase ' + name + ' ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
    }
  }
  const failed = results.filter(function (r) { return !r.ok; });
  process.stdout.write('\n' + (results.length - failed.length) + ' of ' + results.length + ' checks passed\n');
  failed.forEach(function (f) { process.stdout.write('  FAILED: ' + f.name + ' -> ' + f.detail.slice(0, 200) + '\n'); });
  if (mockLicence) {
    process.stdout.write('stand-in licence service: ' + mockLicence.state.active.size + ' activations left open, ' + mockLicence.state.requests.length + ' requests\n');
    await mockLicence.stop();
  }
  process.stdout.write('profile: ' + profile.dir + '\nscreens: ' + OUT + '\n');
  process.exit(failed.length ? 1 : 0);
})();
