'use strict';
// Loads the whole extension against a stand-in editor API and drives the commands, providers and
// views the way the editor would.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMock, install, makeDocument, makeEditor, makeContext, Uri } = require('./shell.vscode-mock');
const pkg = require('../package.json');

const KEY = 'SMOKE-KEY-0001';
const X12_BAD = [
  'ISA*00*          *00*          *ZZ*ACMEBUYER      *ZZ*GLOBALSUPPLY   *240115*0930*U*00401*000000101*0*P*>~',
  'GS*PO*ACMEBUYER*GLOBALSUPPLY*20240115*0930*101*X*004010~',
  'ST*850*0001~',
  'BEG*00*SA*PO-1**20240115~',
  'N1*ST*Acme*92*DC04~',
  'SE*9*0001~',
  'GE*1*101~',
  'IEA*1*000000101~'
].join('');
const X12_OTHER = X12_BAD.replace('PO-1', 'PO-2').replace('Acme', 'Beta');
const HL7_ONE = 'MSH|^~\\&|A|B|C|D|20240115||ADT^A01|MSG1|P|2.5\rPID|1||123^^^H^MR||Doe^Jane\r';
const EDIFACT_ORDERS = "UNA:+.? 'UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1+9'NAD+BY+111::9'NAD+SU+222::9'UNT+5+1'UNZ+1+R1'";

const SRC = path.join(__dirname, '..', 'src');

function bytes(text) { return new Uint8Array(Buffer.from(text, 'utf8')); }

// Starts the extension on a fresh stand-in. Returns helpers to drive it.
function boot(options) {
  const o = options || {};
  const { vscode, state } = createMock();
  Object.assign(state.config, o.config || {});
  const uninstall = install(vscode);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC) && !/[\\/](core|pro)[\\/]/.test(key) && !/[\\/]licence[\\/]/.test(key) && !key.endsWith('format.js')) delete require.cache[key];
  }
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const p = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path: p, body, host: new URL(url).host });
    if (p === '/licenses/activate') return { status: 200, json: async () => ({ id: 'inst-1', product: { product_id: 'pdt_0NriIrMqPm9xOakMMZtw4', name: 'EDI Lens Pro' } }) };
    if (p === '/licenses/validate') return { status: 200, json: async () => ({ valid: true }) };
    return { status: 204, json: async () => { throw new Error('empty'); } };
  };
  for (const doc of o.documents || []) state.textDocuments.push(doc);
  if (o.active) state.activeTextEditor = o.active;

  const extension = require('../src/extension');
  const ctx = makeContext(o.extensionMode);
  extension.activate(ctx);
  return {
    vscode, state, ctx, calls,
    run: (id, ...args) => state.commands.get(id)(...args),
    stop: () => {
      ctx.subscriptions.forEach((d) => { try { d.dispose(); } catch (e) { /* ignore */ } });
      globalThis.fetch = savedFetch;
      uninstall();
    }
  };
}

function open(text, languageId, name, options) {
  const doc = makeDocument(text, languageId, name, options);
  return doc;
}

test('activation registers every contributed command, provider and view without errors', () => {
  const doc = open(X12_BAD, 'x12', 'a.x12');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    for (const c of pkg.contributes.commands) assert.ok(app.state.commands.has(c.command), c.command + ' is not registered');
    assert.equal(app.state.hoverProviders.length, 3);
    assert.equal(app.state.formattingProviders.length, 3);
    assert.deepEqual(app.state.hoverProviders.map((h) => h.selector.language).sort(), ['edifact', 'hl7', 'x12']);
    assert.equal(app.state.treeViews.length, 2);
    assert.equal(app.state.treeViews[0].id, 'ediLens.outline');
    assert.equal(app.state.treeViews[1].id, 'ediLens.queryResults');
    assert.equal(app.state.statusItems.length, 1);
    assert.equal(app.state.outputChannels.length, 0, 'no start-up failure was logged');
    assert.equal(app.calls.length, 0, 'no network request without a licence key');
  } finally { app.stop(); }
});

test('diagnostics: problems appear on open with codes, source and severity; the status bar summarises them', () => {
  const doc = open(X12_BAD, 'x12', 'bad.x12');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    const collection = app.state.diagnosticCollections.find((c) => c.name === 'ediLens');
    const diagnostics = collection.map.get(doc.uri.toString());
    assert.ok(diagnostics && diagnostics.length >= 1);
    const se = diagnostics.find((d) => d.code === 'X12-SE-COUNT');
    assert.ok(se, diagnostics.map((d) => d.code).join(','));
    assert.equal(se.source, 'EDI Lens');
    assert.equal(se.severity, 0);
    assert.ok(se.range.start.character >= 0);
    const status = app.state.statusItems[0];
    assert.equal(status.visible, true);
    assert.match(status.text, /^\$\(error\) ANSI X12 · 8 segments · \d+ issues?$/);
    assert.equal(status.command, 'workbench.actions.view.problems');
  } finally { app.stop(); }
});

test('diagnostics: a clean file has no problems and a closed file is cleared', () => {
  const good = open(HL7_ONE, 'hl7', 'good.hl7');
  const app = boot({ documents: [good], active: makeEditor(good) });
  try {
    const collection = app.state.diagnosticCollections.find((c) => c.name === 'ediLens');
    assert.deepEqual(collection.map.get(good.uri.toString()), []);
    assert.match(app.state.statusItems[0].text, /^\$\(check\) HL7 v2 · 2 segments · 0 issues$/);
    app.state.emitters.close.fire(good);
    assert.equal(collection.map.has(good.uri.toString()), false);
  } finally { app.stop(); }
});

test('diagnostics: files in other languages and other schemes are ignored', () => {
  const text = open(X12_BAD, 'plaintext', 'notes.txt');
  const git = open(X12_BAD, 'x12', 'old.x12', { scheme: 'git' });
  const app = boot({ documents: [text, git] });
  try {
    const collection = app.state.diagnosticCollections.find((c) => c.name === 'ediLens');
    assert.equal(collection.map.size, 0);
  } finally { app.stop(); }
});

test('size limit: a large file is skipped automatically and checked only on demand', async () => {
  const big = 'ISA*' + 'x'.repeat(1024 * 1024 + 10);
  const doc = open(big, 'x12', 'big.x12');
  const editor = makeEditor(doc);
  const app = boot({ documents: [doc], active: editor, config: { maxFileSizeMB: 1 } });
  try {
    const collection = app.state.diagnosticCollections.find((c) => c.name === 'ediLens');
    assert.equal(collection.map.has(doc.uri.toString()), false);
    assert.match(app.state.statusItems[0].text, /over limit/);
    const root = await app.state.treeViews[0].options.treeDataProvider.getChildren();
    assert.deepEqual(root, []);
    assert.match(app.state.treeViews[0].message, /larger than the 1 MB limit/);
    await app.run('ediLens.validateFile');
    assert.ok(collection.map.has(doc.uri.toString()), 'on-demand validation ignores the limit');
  } finally { app.stop(); }
});

test('typing triggers a debounced re-check only when validateOnType is on', async () => {
  const doc = open(X12_BAD, 'x12', 'typing.x12');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    const collection = app.state.diagnosticCollections.find((c) => c.name === 'ediLens');
    const before = collection.map.get(doc.uri.toString()).length;
    doc._text = doc._text.replace('SE*9*0001', 'SE*4*0001');
    doc.version++;
    app.state.emitters.change.fire({ document: doc, contentChanges: [{}] });
    await new Promise((r) => setTimeout(r, 600));
    const after = collection.map.get(doc.uri.toString()).length;
    assert.ok(after < before, 'fixing the count removes the problem (' + before + ' -> ' + after + ')');
  } finally { app.stop(); }

  const doc2 = open(X12_BAD, 'x12', 'typing2.x12');
  const app2 = boot({ documents: [doc2], active: makeEditor(doc2), config: { validateOnType: false } });
  try {
    const collection = app2.state.diagnosticCollections.find((c) => c.name === 'ediLens');
    const before = collection.map.get(doc2.uri.toString()).length;
    doc2._text = doc2._text.replace('SE*9*0001', 'SE*4*0001');
    doc2.version++;
    app2.state.emitters.change.fire({ document: doc2, contentChanges: [{}] });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(collection.map.get(doc2.uri.toString()).length, before, 'no re-check while typing');
    app2.state.emitters.save.fire(doc2);
    assert.ok(collection.map.get(doc2.uri.toString()).length < before, 'saving re-checks');
  } finally { app2.stop(); }
});

test('Pretty Print and Minify rewrite the document and keep the data', async () => {
  const doc = open(X12_BAD, 'x12', 'p.x12');
  const editor = makeEditor(doc);
  const app = boot({ documents: [doc], active: editor });
  try {
    await app.run('ediLens.prettyPrint');
    assert.equal(editor.edits.length, 1);
    const pretty = doc.getText();
    assert.equal(pretty.split('\n').length, 8);
    assert.ok(pretty.startsWith('ISA*00*'));
    await app.run('ediLens.prettyPrint');
    assert.deepEqual(app.state.statusMessages.at(-1), 'EDI Lens: nothing to change');
    await app.run('ediLens.minify');
    assert.equal(doc.getText(), X12_BAD);
  } finally { app.stop(); }
});

test('Pretty Print uses the line ending of the document', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'crlf.edi', { eol: 2 });
  const editor = makeEditor(doc);
  const app = boot({ documents: [doc], active: editor });
  try {
    await app.run('ediLens.prettyPrint');
    assert.ok(doc.getText().includes("'\r\nUNB"));
    assert.ok(!/[^\r]\n/.test(doc.getText()));
  } finally { app.stop(); }
});

test('formatting commands refuse files without segments and other languages', async () => {
  const junk = open('hello world', 'x12', 'junk.x12');
  const app = boot({ documents: [junk], active: makeEditor(junk) });
  try {
    await app.run('ediLens.prettyPrint');
    assert.match(app.state.warnMessages.at(-1).text, /No segments were found/);
    const txt = open('hello', 'plaintext', 'a.txt');
    app.state.activeTextEditor = makeEditor(txt);
    await app.run('ediLens.minify');
    assert.match(app.state.warnMessages.at(-1).text, /needs a UN\/EDIFACT, ANSI X12 or HL7 v2 file in the active editor/);
  } finally { app.stop(); }
});

test('Format Document provider returns one edit for unformatted text', () => {
  const doc = open(X12_BAD, 'x12', 'fd.x12');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    const provider = app.state.formattingProviders.find((p) => p.selector.language === 'x12').provider;
    const edits = provider.provideDocumentFormattingEdits(doc);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].newText.split('\n').length, 8);
  } finally { app.stop(); }
});

test('Go to Segment selects the chosen segment', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'g.edi');
  const editor = makeEditor(doc);
  const app = boot({ documents: [doc], active: editor });
  try {
    let items;
    app.state.quickPickAnswer = (list) => { items = list; return list.find((i) => i.label === 'NAD[2]'); };
    await app.run('ediLens.goToSegment');
    assert.ok(items.some((i) => i.label === 'UNH[1]'));
    const start = doc.offsetAt(editor.selection.start);
    const end = doc.offsetAt(editor.selection.end);
    assert.equal(doc.getText().slice(start, end), 'NAD+SU+222::9');
  } finally { app.stop(); }
});

test('Go to Segment restores the cursor when the pick is cancelled', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'g2.edi');
  const editor = makeEditor(doc);
  editor.setCursor(10);
  const before = editor.selection;
  const app = boot({ documents: [doc], active: editor });
  try {
    app.state.quickPickAnswer = undefined;
    await app.run('ediLens.goToSegment');
    assert.equal(editor.selection, before);
  } finally { app.stop(); }
});

test('Copy Path At Cursor copies the path of the item under the cursor', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'c.edi');
  const editor = makeEditor(doc);
  editor.setCursor(doc.getText().indexOf('222') + 1);
  const app = boot({ documents: [doc], active: editor });
  try {
    await app.run('ediLens.copyPath');
    assert.equal(app.state.clipboard, 'NAD[2]-2.1');
    editor.setCursor(0);
    await app.run('ediLens.copyPath');
    assert.match(app.state.clipboard, /^UNA/);
  } finally { app.stop(); }
});

test('Jump To Matching Trailer moves between UNH and UNT and reports non-envelope segments', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'j.edi');
  const editor = makeEditor(doc);
  const text = doc.getText();
  editor.setCursor(text.indexOf('UNH') + 1);
  const app = boot({ documents: [doc], active: editor });
  try {
    await app.run('ediLens.jumpToTrailer');
    let start = doc.offsetAt(editor.selection.start);
    assert.equal(text.slice(start, start + 3), 'UNT');
    await app.run('ediLens.jumpToTrailer');
    start = doc.offsetAt(editor.selection.start);
    assert.equal(text.slice(start, start + 3), 'UNH');
    editor.setCursor(text.indexOf('BGM') + 1);
    await app.run('ediLens.jumpToTrailer');
    assert.match(app.state.infoMessages.at(-1).text, /BGM is not an envelope segment/);
  } finally { app.stop(); }
});

test('Detect Format switches the language of a plain text file', async () => {
  const doc = open(HL7_ONE, 'plaintext', 'message.txt');
  const editor = makeEditor(doc);
  const app = boot({ documents: [], active: editor });
  try {
    await app.run('ediLens.detectFormat');
    assert.equal(doc.languageId, 'hl7');
    assert.match(app.state.infoMessages.at(-1).text, /Language set to HL7 v2/);
    await app.run('ediLens.detectFormat');
    assert.match(app.state.infoMessages.at(-1).text, /already set to HL7 v2/);
    const other = makeEditor(open('just words', 'plaintext', 'w.txt'));
    app.state.activeTextEditor = other;
    await app.run('ediLens.detectFormat');
    assert.match(app.state.warnMessages.at(-1).text, /No UN\/EDIFACT, ANSI X12 or HL7 v2 content/);
  } finally { app.stop(); }
});

test('automatic language switch corrects an X12 file that opened as EDIFACT, once', async () => {
  const doc = open(X12_BAD, 'edifact', 'x.edi');
  const app = boot({ documents: [doc] });
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(doc.languageId, 'x12');
    doc.languageId = 'edifact';
    app.state.emitters.open.fire(doc);
    await new Promise((r) => setImmediate(r));
    assert.equal(doc.languageId, 'edifact', 'a manual choice is not overridden again');
  } finally { app.stop(); }

  const doc2 = open(X12_BAD, 'edifact', 'y.edi');
  const app2 = boot({ documents: [doc2], config: { autoDetectLanguage: false } });
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(doc2.languageId, 'edifact');
  } finally { app2.stop(); }
});

test('hover shows the path, value and length', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'h.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    const provider = app.state.hoverProviders.find((h) => h.selector.language === 'edifact').provider;
    const pos = doc.positionAt(doc.getText().indexOf('PO-1') + 1);
    const hover = await provider.provideHover(doc, pos);
    assert.ok(hover);
    const md = hover.contents.value;
    assert.match(md, /BGM\[1\]-2/);
    assert.match(md, /PO-1/);
    assert.match(md, /Length: 4 code points/);
    assert.equal(hover.contents.isTrusted, false);
    assert.equal(hover.contents.supportHtml, false);
  } finally { app.stop(); }
});

test('hover can be switched off', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'h2.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc), config: { 'hover.enabled': false } });
  try {
    const provider = app.state.hoverProviders[0].provider;
    assert.equal(await provider.provideHover(doc, doc.positionAt(5)), null);
  } finally { app.stop(); }
});

test('outline: root segments, tree items with reveal command, and a refresh on edit', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 't.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    const provider = app.state.treeViews[0].options.treeDataProvider;
    const root = await provider.getChildren();
    assert.equal(root.length, 8);
    const nad = root.find((d) => d.label === 'NAD[2]');
    const item = provider.getTreeItem(nad);
    assert.equal(item.label, 'NAD[2]');
    assert.equal(item.collapsibleState, 1);
    assert.equal(item.contextValue, 'ediLens.node');
    assert.equal(item.command.command, 'ediLens.revealRange');
    assert.equal(item.command.arguments[0], doc.uri);
    assert.equal(doc.getText().slice(item.command.arguments[1], item.command.arguments[2]), 'NAD+SU+222::9');
    const kids = await provider.getChildren(nad);
    assert.deepEqual(kids.map((k) => k.label), ['NAD-1', 'NAD-2']);

    let fired = 0;
    provider.onDidChangeTreeData(() => { fired++; });
    app.state.emitters.change.fire({ document: doc, contentChanges: [{}] });
    app.state.emitters.change.fire({ document: doc, contentChanges: [{}] });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fired, 1, 'refresh is debounced');
    await app.run('ediLens.copyTreePath', nad);
    assert.equal(app.state.clipboard, 'NAD[2]');
  } finally { app.stop(); }
});

test('outline stays empty for other files and keeps the last EDI file when focus leaves the editors', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 't2.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    const provider = app.state.treeViews[0].options.treeDataProvider;
    assert.equal((await provider.getChildren()).length, 8);
    app.state.activeTextEditor = undefined;
    assert.equal((await provider.getChildren()).length, 8, 'no active editor: keep the last file');
    app.state.activeTextEditor = makeEditor(open('x', 'plaintext', 'x.txt'));
    assert.deepEqual(await provider.getChildren(), []);
  } finally { app.stop(); }
});

test('reveal command selects the range in the document', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'r.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    let shown;
    app.vscode.window.showTextDocument = async (d, options) => { shown = { d, options }; };
    await app.run('ediLens.revealRange', doc.uri, 5, 9);
    assert.equal(shown.d, doc);
    assert.equal(shown.options.preserveFocus, true);
    assert.equal(doc.offsetAt(shown.options.selection.start), 5);
    assert.equal(doc.offsetAt(shown.options.selection.end), 9);
  } finally { app.stop(); }
});

// Puts the trial of a booted stand-in into the past, as if it had been started `daysAgo` days ago.
async function ageTrial(app, daysAgo) {
  const t = Date.now() - daysAgo * 24 * 3600 * 1000;
  await app.ctx.globalState.update('trial.startedAt', t);
  await app.ctx.globalState.update('trial.lastSeenAt', t);
  await app.ctx.globalState.update('trial.lastNoticeAt', undefined);
}

test('Pro commands show one clear message with Buy and Enter Key buttons when there is no licence and the trial is over', async () => {
  const doc = open(X12_BAD, 'x12', 'pro.x12');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await ageTrial(app, 20);
    for (const id of ['ediLens.compare', 'ediLens.exportJson', 'ediLens.exportCsv', 'ediLens.exportXml', 'ediLens.validateWorkspace', 'ediLens.loadDictionary', 'ediLens.batchPrettyPrint']) {
      app.state.infoMessages.length = 0;
      await app.run(id);
      assert.equal(app.state.infoMessages.length, 1, id);
      assert.match(app.state.infoMessages[0].text, /is an EDI Lens Pro feature/);
      assert.match(app.state.infoMessages[0].text, /trial ended on/);
      assert.deepEqual(app.state.infoMessages[0].buttons, ['Buy Pro', 'Enter Licence Key']);
    }
    assert.equal(app.state.openedDocuments.length, 0);
    assert.equal(app.calls.length, 0);

    app.state.infoAnswer = (text, buttons) => (buttons.includes('Buy Pro') ? 'Buy Pro' : undefined);
    app.state.quickPickAnswer = (items) => items.find((i) => i.tier === 'personal');
    await app.run('ediLens.exportJson');
    assert.ok(String(app.state.opened).includes('checkout'), 'Buy Pro opens the checkout link');
  } finally { app.stop(); }
});

test('the first Pro command starts the 14-day trial on this computer, with one message and no network', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'trial.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined, 'install alone starts nothing');
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 1, 'the export ran');
    const started = app.state.infoMessages.find((m) => /trial of EDI Lens Pro has started/.test(m.text));
    assert.ok(started, JSON.stringify(app.state.infoMessages.map((m) => m.text)));
    assert.deepEqual(started.buttons, ['Buy Pro', 'Enter Licence Key']);
    assert.match(started.text, /recorded only on this computer/);
    assert.ok(typeof app.ctx.globalState.get('trial.startedAt') === 'number');
    assert.equal(app.calls.length, 0, 'the trial makes no network request');

    // The second command in the same day runs without any further message.
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportCsv');
    assert.equal(app.state.openedDocuments.length, 2);
    assert.deepEqual(app.state.infoMessages.filter((m) => /trial/.test(m.text)), [], 'no second notice on the same day');

    // Show Licence Status reports the days left.
    app.state.infoMessages.length = 0;
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages[0].text, /Pro trial: 14 days left/);
    assert.deepEqual(app.state.infoMessages[0].buttons, ['Buy Pro', 'Enter Licence Key', 'Lost your key?']);
    assert.equal(app.calls.length, 0);
  } finally { app.stop(); }
});

test('during the trial a reminder with the days left appears at most once a day', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'trial2.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await ageTrial(app, 5);
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 1);
    const reminders = app.state.infoMessages.filter((m) => /Pro trial: 9 days left/.test(m.text));
    assert.equal(reminders.length, 1, JSON.stringify(app.state.infoMessages.map((m) => m.text)));
    assert.match(reminders[0].text, /at most once a day/);
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportXml');
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 3);
    assert.equal(app.state.infoMessages.filter((m) => /trial/.test(m.text)).length, 0, 'no further reminder today');
    // Yesterday's reminder does not block today's.
    await app.ctx.globalState.update('trial.lastNoticeAt', Date.now() - 25 * 3600 * 1000);
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.equal(app.state.infoMessages.filter((m) => /days left/.test(m.text)).length, 1);
  } finally { app.stop(); }
});

test('after the trial Pro commands stop, the status says so, and a licence key overrides the trial', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'trial3.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await ageTrial(app, 14);
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 0, 'nothing exported after the trial');
    assert.match(app.state.infoMessages[0].text, /Export is an EDI Lens Pro feature\. Your 14-day trial ended on/);
    app.state.infoMessages.length = 0;
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages[0].text, /EDI Lens Free\. Your 14-day Pro trial ended on/);
    assert.match(app.state.infoMessages[0].text, /one-time purchase: Personal USD 29, Business USD 59 per user; each key works on up to 3 computers/);
    // A key unlocks Pro again; the trial record is left alone.
    app.state.inputAnswer = KEY;
    await app.run('ediLens.enterKey');
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 1);
    assert.deepEqual(app.state.infoMessages.filter((m) => /trial/.test(m.text)), []);
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages.at(-1).text, /Pro is active on this computer/);
    assert.ok(app.ctx.globalState.get('trial.startedAt'));
  } finally { app.stop(); }
});

test('a dictionary remembered for the workspace is used during the trial but never starts it', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'trial4.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    const file = Uri.file('/work/dict-trial.json');
    app.state.files.set(file.toString(), bytes(JSON.stringify({ format: 'edifact', name: 'T', segments: { BGM: { name: 'Trial name' } } })));
    await app.ctx.workspaceState.update('ediLens.dictionaryUri', file.toString());
    const provider = app.state.hoverProviders[0].provider;
    let hover = await provider.provideHover(doc, doc.positionAt(doc.getText().indexOf('BGM+220') + 5));
    assert.ok(!/Trial name/.test(hover.contents.value), 'no trial, no names');
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined, 'hovering never starts the trial');
    await app.run('ediLens.exportJson');
    hover = await provider.provideHover(doc, doc.positionAt(doc.getText().indexOf('BGM+220') + 5));
    assert.match(hover.contents.value, /Trial name/);
  } finally { app.stop(); }
});

test('when the editor storage refuses the trial, the Pro notice explains it and nothing is recorded', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'trial5.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    app.ctx.globalState.update = async () => { throw new Error('read-only'); };
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 0);
    assert.match(app.state.infoMessages[0].text, /trial could not be started because the editor's storage is not writable/);
    assert.deepEqual(app.state.infoMessages[0].buttons, ['Buy Pro', 'Enter Licence Key']);
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined);
  } finally { app.stop(); }
});

test('licence flow: enter key, use Pro features, check status, remove', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'lic.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    app.state.inputAnswer = KEY;
    await app.run('ediLens.enterKey');
    assert.match(app.state.infoMessages.at(-1).text, /EDI Lens Pro is now active on this computer \(Personal licence\)/);
    assert.equal(app.calls[0].path, '/licenses/activate');
    assert.equal(app.calls[0].body.name, 'VS Code on ' + ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform));
    assert.equal(app.calls[0].body.license_key, KEY);

    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 1);
    assert.equal(app.state.openedDocuments[0].languageId, 'json');
    const json = JSON.parse(app.state.openedDocuments[0].getText());
    assert.equal(json.format, 'edifact');
    assert.equal(json.segments.length, 8);

    await app.run('ediLens.exportCsv');
    assert.ok(app.state.openedDocuments[1].getText().startsWith('segment,occurrence,path,value\r\n'));
    await app.run('ediLens.exportXml');
    assert.match(app.state.openedDocuments[2].getText(), /<message format="edifact">/);
    assert.equal(app.state.openedDocuments[2].languageId, 'xml');

    app.state.infoMessages.length = 0;
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages.at(-1).text, /Pro is active on this computer \(Personal licence, key \.\.\.0001\)/);
    assert.deepEqual(app.state.infoMessages.at(-1).buttons, ['Remove Licence']);

    app.state.warnAnswer = 'Remove Licence';
    await app.run('ediLens.removeLicence');
    assert.equal(app.calls.at(-1).path, '/licenses/deactivate');
    assert.match(app.state.infoMessages.at(-1).text, /removed from this computer and the activation was freed/);
    await ageTrial(app, 30);
    app.state.infoMessages.length = 0;
    await app.run('ediLens.exportJson');
    assert.match(app.state.infoMessages[0].text, /Pro feature/);
  } finally { app.stop(); }
});

test('entering a wrong key shows the specific reason and changes nothing', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'bad-key.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    globalThis.fetch = async () => ({ status: 404, json: async () => ({}) });
    app.state.inputAnswer = 'nope-nope';
    await app.run('ediLens.enterKey');
    assert.match(app.state.errorMessages.at(-1), /not recognised/);
    globalThis.fetch = async () => ({ status: 403, json: async () => ({}) });
    await app.run('ediLens.enterKey');
    assert.match(app.state.errorMessages.at(-1), /not active \(expired, disabled or refunded\)/);
    globalThis.fetch = async () => ({ status: 422, json: async () => ({}) });
    await app.run('ediLens.enterKey');
    assert.match(app.state.errorMessages.at(-1), /maximum number of computers/);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await app.run('ediLens.enterKey');
    assert.match(app.state.errorMessages.at(-1), /could not be reached/);
    app.state.inputAnswer = undefined;
    const before = app.state.errorMessages.length;
    await app.run('ediLens.enterKey');
    assert.equal(app.state.errorMessages.length, before, 'cancelling the input box is silent');
    app.state.infoMessages.length = 0;
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages[0].text, /EDI Lens Free\. No licence key is stored/);
    assert.match(app.state.infoMessages[0].text, /starts a free 14-day trial/);
    assert.deepEqual(app.state.infoMessages[0].buttons, ['Buy Pro', 'Enter Licence Key', 'Lost your key?']);
    // "Lost your key?" explains where the key is and offers the key box and the issue page.
    app.state.infoAnswer = (text, buttons) => (buttons.includes('Lost your key?') ? 'Lost your key?' : undefined);
    app.state.infoMessages.length = 0;
    await app.run('ediLens.licenceStatus');
    const lost = app.state.infoMessages.find((m) => /e-mailed to the address you entered at checkout/.test(m.text));
    assert.ok(lost, JSON.stringify(app.state.infoMessages.map((m) => m.text)));
    assert.match(lost.text, /spam folder/);
    assert.match(lost.text, /never post a key in a public issue/);
    assert.deepEqual(lost.buttons, ['Enter Licence Key', 'Report A Problem']);
  } finally { app.stop(); }
});

test('Open Sample commands open valid untitled files in the right language and the walkthrough command runs', async () => {
  const app = boot({});
  try {
    for (const [id, language, first] of [['ediLens.openSampleEdifact', 'edifact', 'UNA'], ['ediLens.openSampleX12', 'x12', 'ISA'], ['ediLens.openSampleHl7', 'hl7', 'MSH']]) {
      await app.run(id);
      const doc = app.state.openedDocuments.at(-1);
      assert.equal(doc.languageId, language, id);
      assert.ok(doc.getText().startsWith(first), id);
      assert.equal(doc.uri.scheme, 'untitled');
      const core = require('../src/format').getCore();
      const m = core.parse(doc.getText());
      assert.deepEqual(m.issues, [], id);
      assert.deepEqual(core.validate(m), [], id + ' validates clean');
    }
    assert.equal(app.state.openedDocuments.length, 3);
    let executed;
    const original = app.vscode.commands.executeCommand;
    app.vscode.commands.executeCommand = async (id, ...args) => { executed = [id, ...args]; return original(id, ...args); };
    await app.run('ediLens.openWalkthrough');
    assert.deepEqual(executed, ['workbench.action.openWalkthrough', 'SmallStepsStudio.edi-lens-viewer#ediLens.gettingStarted', false]);
    await app.run('ediLens.showDocumentation');
    assert.equal(String(app.state.opened), 'https://github.com/small-steps-studio/edi-lens#readme');
  } finally { app.stop(); }
});

test('Report A Problem copies a diagnostics block without file content, names or the key, and opens the issues page', async () => {
  const doc = open(X12_BAD, 'x12', 'secret-customer-file.x12');
  const app = boot({ documents: [doc], active: makeEditor(doc), config: { maxIssues: 42 } });
  try {
    app.state.inputAnswer = KEY;
    await app.run('ediLens.enterKey');
    app.state.infoMessages.length = 0;
    await app.run('ediLens.reportProblem');
    const block = app.state.clipboard;
    assert.match(block, /^EDI Lens \d+\.\d+\.\d+\n/);
    assert.match(block, /Active file: ANSI X12, \d+ characters, 8 segments, \d+ errors/);
    assert.match(block, /maxIssues = 42/);
    assert.match(block, /Licence: Pro \(licence, verified\)\n/);
    assert.match(block, /workspaceInclude = default\n {2}workspaceExclude = default\n/);
    assert.ok(!/licenceMode/.test(block));
    assert.ok(!block.includes(KEY) && !block.includes('0001'), 'no key and no key hint');
    assert.ok(!block.includes('secret-customer-file') && !block.includes('ACMEBUYER'), 'no file name and no file content');
    assert.ok(!block.includes(require('node:os').hostname()) || require('node:os').hostname().length < 3, 'no host name');
    assert.equal(String(app.state.opened), 'https://github.com/small-steps-studio/edi-lens/issues');
    assert.match(app.state.infoMessages.at(-1).text, /copied to the clipboard/);
    assert.match(app.state.infoMessages.at(-1).text, /no file contents or names/);
  } finally { app.stop(); }
});

test('Buy Pro opens the checkout link of the configured environment', async () => {
  const app = boot({});
  try {
    // Closing the list opens nothing.
    await app.run('ediLens.buyPro');
    assert.equal(app.state.opened, undefined);
    assert.deepEqual(app.state.quickPicks.at(-1).items.map((i) => i.tier), ['personal', 'business']);
    assert.match(app.state.quickPicks.at(-1).items[0].description, /USD 29/);
    assert.match(app.state.quickPicks.at(-1).items[1].description, /USD 59 per user/);
    app.state.quickPickAnswer = (items) => items.find((i) => i.tier === 'personal');
    await app.run('ediLens.buyPro');
    assert.equal(app.state.opened.scheme, 'https');
    assert.equal(app.state.opened.path, 'checkout.dodopayments.com/buy/pdt_0NriIrMqPm9xOakMMZtw4?quantity=1', 'the default is the live checkout link');
  } finally { app.stop(); }
  // Nothing a user can set selects the provider's test environment: not the setting of 0.1.x, not an
  // environment variable in an installed copy.
  const savedEnv = process.env.EDI_LENS_LICENCE_MODE;
  for (const [options, env] of [[{ config: { licenceMode: 'test' } }, undefined], [{ config: { licenceMode: 'test' } }, 'test'], [{ extensionMode: 1 }, 'test'], [{ extensionMode: 2 }, undefined], [{ extensionMode: 3 }, 'live']]) {
    if (env === undefined) delete process.env.EDI_LENS_LICENCE_MODE; else process.env.EDI_LENS_LICENCE_MODE = env;
    const installed = boot(options);
    try {
      installed.state.quickPickAnswer = (items) => items.find((i) => i.tier === 'personal');
      await installed.run('ediLens.buyPro');
      assert.equal(installed.state.opened.path, 'checkout.dodopayments.com/buy/pdt_0NriIrMqPm9xOakMMZtw4?quantity=1', JSON.stringify([options, env]));
      installed.state.inputAnswer = KEY;
      await installed.run('ediLens.enterKey');
      assert.ok(installed.calls.length > 0 && installed.calls.every((c) => c.host === 'live.dodopayments.com'), 'the licence check goes to the live host: ' + JSON.stringify([options, env]));
      await installed.run('ediLens.licenceStatus');
      assert.ok(!/test environment/.test(installed.state.infoMessages.at(-1).text));
    } finally { installed.stop(); }
  }
  // Only a development host of the extension that was started with the variable uses the test environment.
  process.env.EDI_LENS_LICENCE_MODE = 'test';
  const test = boot({ extensionMode: 2 });
  try {
    test.state.quickPickAnswer = (items) => items.find((i) => i.tier === 'personal');
    await test.run('ediLens.buyPro');
    assert.equal(test.state.opened.scheme, 'https');
    assert.match(test.state.opened.path, /^test\.checkout\.dodopayments\.com\/buy\//);
  } finally {
    test.stop();
    if (savedEnv === undefined) delete process.env.EDI_LENS_LICENCE_MODE; else process.env.EDI_LENS_LICENCE_MODE = savedEnv;
  }
  // No contributed command, setting or menu entry names the environment.
  assert.ok(!/licenceMode|licence mode|test environment/i.test(JSON.stringify(pkg.contributes)));
});

async function goPro(app) {
  app.state.inputAnswer = KEY;
  await app.run('ediLens.enterKey');
  app.state.infoMessages.length = 0;
}

test('Compare shows a side-by-side report for two files in the same format', async () => {
  const a = open(X12_BAD, 'x12', 'a.x12');
  const b = open(X12_OTHER, 'x12', 'b.x12');
  const app = boot({ documents: [a, b], active: makeEditor(a) });
  try {
    await goPro(app);
    app.state.quickPickAnswer = (items) => items.find((i) => i.doc === b);
    await app.run('ediLens.compare');
    assert.ok(app.state.panel, 'a panel was opened');
    assert.match(app.state.panel.title, /a\.x12/);
    assert.match(app.state.panel.webview.html, /<table>/);
    assert.match(app.state.panel.webview.html, /PO-2/);
    assert.match(app.state.panel.webview.html, /Content-Security-Policy/);
  } finally { app.stop(); }
});

test('Compare refuses files in different formats and applies the ignore settings', async () => {
  const a = open(X12_BAD, 'x12', 'a.x12');
  const h = open(HL7_ONE, 'hl7', 'h.hl7');
  const app = boot({ documents: [a, h], active: makeEditor(a) });
  try {
    await goPro(app);
    app.state.quickPickAnswer = (items) => items.find((i) => i.doc === h);
    await app.run('ediLens.compare');
    assert.match(app.state.warnMessages.at(-1).text, /different formats \(ANSI X12 and HL7 v2\)/);
    assert.equal(app.state.panel, undefined);
  } finally { app.stop(); }

  const a2 = open(X12_BAD, 'x12', 'a2.x12');
  const b2 = open(X12_OTHER, 'x12', 'b2.x12');
  const app2 = boot({ documents: [a2, b2], active: makeEditor(a2), config: { 'compare.ignoreSegments': ['BEG', 'N1'] } });
  try {
    await goPro(app2);
    app2.state.quickPickAnswer = (items) => items.find((i) => i.doc === b2);
    await app2.run('ediLens.compare');
    assert.match(app2.state.panel.webview.html, /The messages are identical/);
  } finally { app2.stop(); }
});

test('Compare can browse for a file on disk', async () => {
  const a = open(X12_BAD, 'x12', 'a.x12');
  const app = boot({ documents: [a], active: makeEditor(a) });
  try {
    await goPro(app);
    const other = Uri.file('/work/other.x12');
    app.state.files.set(other.toString(), bytes(X12_OTHER));
    app.state.quickPickAnswer = (items) => items.find((i) => i.browse);
    app.state.openDialogAnswer = [other];
    await app.run('ediLens.compare');
    assert.match(app.state.panel.webview.html, /other\.x12/);
    // Not valid UTF-8: a clear error instead of a broken comparison.
    app.state.panel = undefined;
    app.state.files.set(other.toString(), new Uint8Array([0x55, 0xff, 0xfe]));
    await app.run('ediLens.compare');
    assert.match(app.state.errorMessages.at(-1), /not valid UTF-8/);
    assert.equal(app.state.panel, undefined);
  } finally { app.stop(); }
});

test('dictionary: Pro names appear in the hover and the outline, and the dictionary is remembered', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'd.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await goPro(app);
    const dict = {
      format: 'edifact', name: 'Partner profile',
      segments: { BGM: { name: 'Beginning of message', elements: { 1: { name: 'Document name', values: { 220: 'Order' } } } } }
    };
    const file = Uri.file('/work/dict.json');
    app.state.files.set(file.toString(), bytes(JSON.stringify(dict)));
    app.state.openDialogAnswer = [file];
    await app.run('ediLens.loadDictionary');
    assert.match(app.state.infoMessages.at(-1).text, /Dictionary "Partner profile" \(UN\/EDIFACT\) loaded/);
    assert.equal(app.ctx.workspaceState.get('ediLens.dictionaryUri'), file.toString());

    const provider = app.state.hoverProviders.find((h) => h.selector.language === 'edifact').provider;
    const hover = await provider.provideHover(doc, doc.positionAt(doc.getText().indexOf('BGM+220') + 5));
    assert.match(hover.contents.value, /Segment: Beginning of message/);
    assert.match(hover.contents.value, /Element: Document name/);
    assert.match(hover.contents.value, /Value: Order/);

    const tree = app.state.treeViews[0].options.treeDataProvider;
    const bgm = (await tree.getChildren()).find((d) => d.label === 'BGM[1]');
    assert.match(bgm.description, /^Beginning of message/);

    await app.run('ediLens.unloadDictionary');
    const plain = await provider.provideHover(doc, doc.positionAt(doc.getText().indexOf('BGM+220') + 5));
    assert.ok(!/Beginning of message/.test(plain.contents.value));
    assert.equal(app.ctx.workspaceState.get('ediLens.dictionaryUri'), undefined);
  } finally { app.stop(); }
});

test('dictionary: an invalid file is reported and nothing is loaded; free users never see names', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'd2.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await goPro(app);
    const file = Uri.file('/work/bad.json');
    app.state.files.set(file.toString(), bytes('{ not json'));
    app.state.openDialogAnswer = [file];
    await app.run('ediLens.loadDictionary');
    assert.match(app.state.errorMessages.at(-1), /dictionary could not be loaded/);
    assert.equal(app.ctx.workspaceState.get('ediLens.dictionaryUri'), undefined);
  } finally { app.stop(); }

  const doc2 = open(EDIFACT_ORDERS, 'edifact', 'd3.edi');
  const ctxApp = boot({ documents: [doc2], active: makeEditor(doc2) });
  try {
    // A remembered dictionary without a licence stays unused.
    const file = Uri.file('/work/dict2.json');
    ctxApp.state.files.set(file.toString(), bytes(JSON.stringify({ format: 'edifact', name: 'X', segments: { BGM: { name: 'Hidden name' } } })));
    await ctxApp.ctx.workspaceState.update('ediLens.dictionaryUri', file.toString());
    const provider = ctxApp.state.hoverProviders[0].provider;
    const hover = await provider.provideHover(doc2, doc2.positionAt(doc2.getText().indexOf('BGM+220') + 5));
    assert.ok(!/Hidden name/.test(hover.contents.value));
  } finally { ctxApp.stop(); }
});

test('Batch Pretty Print Folder asks first, rewrites safely and keeps byte order mark and line endings', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'batch.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await goPro(app);
    const folder = Uri.file('/work/inbox');
    const one = Uri.file('/work/inbox/one.x12');
    const two = Uri.file('/work/inbox/two.hl7');
    const three = Uri.file('/work/inbox/three.edi');
    const four = Uri.file('/work/inbox/four.edi');
    const five = Uri.file('/work/inbox/five.x12');
    app.state.files.set(one.toString(), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(X12_BAD.replace(/~/g, '~\r\n'), 'utf8')]));
    app.state.files.set(two.toString(), bytes('MSH|^~\\&|A|B|C|D|20240115||ADT^A01|M1|P|2.5\rPID|1||123\r'));
    app.state.files.set(three.toString(), new Uint8Array([0x55, 0x4e, 0x42, 0xff]));
    app.state.files.set(four.toString(), bytes('no segments in here'));
    app.state.files.set(five.toString(), bytes(X12_BAD));
    app.state.findResult = [one, two, three, four, five];
    app.vscode.workspace.workspaceFolders = [{ uri: folder, name: 'inbox' }];

    // Declining writes nothing.
    app.state.warnAnswer = undefined;
    await app.run('ediLens.batchPrettyPrint', folder);
    assert.deepEqual(app.state.written, []);
    assert.match(app.state.warnMessages.at(-1).text, /Nothing is written unless you choose Rewrite Files/);
    assert.match(app.state.warnMessages.at(-1).text, /Rewrite 5 files/);

    app.state.warnAnswer = 'Rewrite Files';
    await app.run('ediLens.batchPrettyPrint', folder);
    assert.deepEqual(app.state.written.sort(), [one.toString(), five.toString(), two.toString()].sort());
    const rewrittenFive = Buffer.from(app.state.files.get(five.toString())).toString('utf8');
    assert.equal(rewrittenFive.split('\n').length, 8);
    const rewrittenOne = Buffer.from(app.state.files.get(one.toString()));
    assert.deepEqual([...rewrittenOne.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept');
    assert.ok(rewrittenOne.toString('utf8').includes('~\r\nGS'), 'CRLF kept');
    assert.ok(Buffer.from(app.state.files.get(three.toString())).equals(Buffer.from([0x55, 0x4e, 0x42, 0xff])), 'invalid UTF-8 left untouched');
    assert.match(app.state.infoMessages.at(-1).text, /3 rewritten, 0 already formatted, 2 skipped/);

    const core = require('../src/format').getCore();
    assert.equal(core.minify(core.parse(rewrittenFive)), core.minify(core.parse(X12_BAD)));
    const hl7 = Buffer.from(app.state.files.get(two.toString())).toString('utf8');
    assert.equal(core.minify(core.parse(hl7)), core.minify(core.parse('MSH|^~\\&|A|B|C|D|20240115||ADT^A01|M1|P|2.5\rPID|1||123\r')));
    assert.ok(!hl7.includes('\n'), 'a CR-only file stays CR-only');
  } finally { app.stop(); }
});

test('Batch Pretty Print Folder needs a folder', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'nofolder.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await goPro(app);
    await app.run('ediLens.batchPrettyPrint');
    assert.match(app.state.warnMessages.at(-1).text, /Open a folder first/);
    app.vscode.workspace.workspaceFolders = [{ uri: Uri.file('/work/empty'), name: 'empty' }];
    await app.run('ediLens.batchPrettyPrint');
    assert.match(app.state.infoMessages.at(-1).text, /No EDI files/);
  } finally { app.stop(); }
});

test('Validate Workspace writes a report and fills the workspace problems collection', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'ws.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await goPro(app);
    const folder = Uri.file('/work');
    const bad = Uri.file('/work/bad.x12');
    app.state.files.set(bad.toString(), bytes(X12_BAD));
    app.state.findResult = [bad];
    app.vscode.workspace.workspaceFolders = [{ uri: folder, name: 'work' }];
    await app.run('ediLens.validateWorkspace');
    const report = app.state.openedDocuments.at(-1);
    assert.equal(report.languageId, 'markdown');
    assert.match(report.getText(), /EDI Lens workspace report/);
    assert.match(report.getText(), /bad\.x12/);
    const collection = app.state.diagnosticCollections.find((c) => c.name === 'ediLens.workspace');
    assert.ok(collection.map.size >= 1);
    assert.match(app.state.infoMessages.at(-1).text, /Scanned 1 files: \d+ errors/);
    await app.run('ediLens.clearWorkspaceResults');
    assert.equal(collection.map.size, 0);
  } finally { app.stop(); }
});

test('Validate Workspace without a folder explains what to do', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'ws2.edi');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    await goPro(app);
    await app.run('ediLens.validateWorkspace');
    assert.match(app.state.warnMessages.at(-1).text, /Open a folder first/);
  } finally { app.stop(); }
});

test('a command that fails shows an error instead of throwing', async () => {
  const doc = open(EDIFACT_ORDERS, 'edifact', 'fail.edi');
  const editor = makeEditor(doc);
  editor.edit = async () => { throw new Error('the editor refused the edit'); };
  const app = boot({ documents: [doc], active: editor });
  try {
    await app.run('ediLens.prettyPrint');
    assert.match(app.state.errorMessages.at(-1), /EDI Lens: the editor refused the edit/);
  } finally { app.stop(); }
});

test('the extension still loads when optional modules are missing', () => {
  // Loading the extension must not require any Pro module up front.
  const fmt = require('../src/format');
  assert.equal(fmt.loadModule('nonexistent'), null);
  const doc = open(HL7_ONE, 'hl7', 'm.hl7');
  const app = boot({ documents: [doc], active: makeEditor(doc) });
  try {
    assert.equal(app.state.outputChannels.length, 0);
  } finally { app.stop(); }
});
