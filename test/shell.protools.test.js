'use strict';
// The commands of the Pro tools (anonymise, partner rules, query, envelope tools) driven through
// the stand-in editor API: the Pro gate and the trial, every question a command asks, what it
// reads and writes, and what it tells the user.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMock, install, makeDocument, makeEditor, makeContext, Uri } = require('./shell.vscode-mock');
const pkg = require('../package.json');
const { SAMPLES } = require('../src/samples');
const core = require('../src/format').getCore();

const SRC = path.join(__dirname, '..', 'src');
const KEY = 'TOOLS-KEY-0001';
const E = SAMPLES.edifact.text;
const X = SAMPLES.x12.text;
const H = SAMPLES.hl7.text;
// The X12 sample order without its address lines: nothing in it is named by the healthcare profile.
const PLAIN = X.split('\n').filter((l) => !/^N[34]\*/.test(l)).join('\n');

const PRO_TOOLS = ['anonymise', 'anonymiseFolder', 'exportPseudonymMap', 'validateWithRules', 'createRules', 'validateFolderWithRules', 'query', 'queryExportCsv',
  'splitInterchange', 'mergeMessages', 'renumberControlNumbers', 'generateAcknowledgement'];
const FREE_TOOLS = ['clearRulesResults', 'clearQueryResults', 'deleteSavedQuery', 'revealQueryResult'];

function bytes(text) { return new Uint8Array(Buffer.from(text, 'utf8')); }
function textOf(app, uri) { return Buffer.from(app.state.files.get(uri.toString())).toString('utf8'); }
const issues = (text) => core.validate(core.parse(text), { includeParseIssues: true });

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
    calls.push({ path: p, body: JSON.parse(init.body) });
    if (p === '/licenses/activate') return { status: 201, json: async () => ({ id: 'inst-1', product: { product_id: 'pdt_0NrkGSyl3UXB82kEhwUxy', name: 'EDI Lens Pro Business' }, customer: { name: 'N', email: 'n@example.invalid' } }) };
    if (p === '/licenses/validate') return { status: 200, json: async () => ({ valid: true }) };
    return { status: 200, json: async () => null };
  };
  const doc = o.text === null ? null : makeDocument(o.text || E, o.language || 'edifact', o.name || 'orders.edi');
  if (doc) { state.textDocuments.push(doc); state.activeTextEditor = makeEditor(doc); }
  vscode.workspace.workspaceFolders = o.noFolder ? undefined : [{ uri: Uri.file('/work'), name: 'work' }];
  const ctx = makeContext(o.extensionMode);
  require('../src/extension').activate(ctx);
  const app = {
    vscode, state, ctx, calls, doc,
    run: (id, ...args) => state.commands.get('ediLens.' + id)(...args),
    put: (rel, text) => { const uri = Uri.file('/work/' + rel); state.files.set(uri.toString(), typeof text === 'string' ? bytes(text) : text); return uri; },
    rules: () => state.diagnosticCollections.find((c) => c.name === 'ediLens.rules'),
    view: () => state.treeViews.find((v) => v.id === 'ediLens.queryResults'),
    lastInfo: () => state.infoMessages.at(-1),
    stop: () => { ctx.subscriptions.forEach((d) => { try { d.dispose(); } catch (e) { /* ignore */ } }); globalThis.fetch = savedFetch; uninstall(); }
  };
  return app;
}
async function licensed(options) {
  const app = boot(options);
  app.state.inputAnswer = KEY;
  await app.state.commands.get('ediLens.enterKey')();
  app.state.inputAnswer = undefined;
  app.state.infoMessages.length = 0;
  app.state.inputBoxes.length = 0;
  return app;
}
async function endTrial(app) {
  const t = Date.now() - 20 * 24 * 3600 * 1000;
  await app.ctx.globalState.update('trial.startedAt', t);
  await app.ctx.globalState.update('trial.lastSeenAt', t);
}

test('pro tools: every new command is contributed, registered and marked (Pro) where it is one', () => {
  const app = boot();
  try {
    const titles = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
    for (const id of PRO_TOOLS) {
      assert.ok(app.state.commands.has('ediLens.' + id), id + ' is not registered');
      assert.match(titles['ediLens.' + id], /^EDI Lens: .* \(Pro\)$/, id);
    }
    for (const id of FREE_TOOLS) {
      assert.ok(app.state.commands.has('ediLens.' + id), id);
      assert.ok(!/\(Pro\)$/.test(titles['ediLens.' + id]), id);
    }
    assert.equal(app.state.outputChannels.length, 0, 'nothing failed at start-up');
    assert.deepEqual(app.state.treeViews.map((v) => v.id), ['ediLens.outline', 'ediLens.queryResults']);
    assert.ok(app.state.diagnosticCollections.some((c) => c.name === 'ediLens.rules'));
    assert.equal(app.calls.length, 0);
  } finally { app.stop(); }
});

test('pro tools: without a licence and after the trial every Pro tool shows the one Pro notice and does nothing', async () => {
  const app = boot();
  try {
    await endTrial(app);
    app.put('.edilens/rules.json', JSON.stringify({ format: 'edifact', rules: [{ type: 'segment-required', segment: 'ZZZ' }] }));
    app.state.findResult = [app.put('inbox/a.edi', E)];
    app.state.inputAnswer = 'seed';
    app.state.quickPickAnswer = (items) => items[0];
    app.state.warnAnswer = (text, rest) => rest[rest.length - 1];
    app.state.openDialogAnswer = [Uri.file('/work/out')];
    app.state.saveDialogAnswer = Uri.file('/work/saved.csv');
    for (const id of PRO_TOOLS) {
      app.state.infoMessages.length = 0;
      await app.run(id);
      assert.equal(app.state.infoMessages.length, 1, id + ': ' + JSON.stringify(app.state.infoMessages.map((m) => m.text)));
      assert.match(app.state.infoMessages[0].text, /is an EDI Lens Pro feature\. Your 14-day trial ended on/, id);
      assert.deepEqual(app.state.infoMessages[0].buttons, ['Buy Pro', 'Enter Licence Key'], id);
    }
    assert.equal(app.state.openedDocuments.length, 0, 'nothing was opened');
    assert.deepEqual(app.state.written, [], 'nothing was written');
    assert.equal(app.rules().map.size, 0);
    assert.equal(app.state.panel, undefined);
    assert.equal(app.doc.getText(), E, 'the document was not changed');
    assert.equal(app.state.inputBoxes.length, 0, 'no question was asked before the gate');
    assert.equal(app.calls.length, 0);
    // The free helpers of the tools never show the notice.
    for (const id of ['clearRulesResults', 'clearQueryResults', 'deleteSavedQuery']) {
      app.state.infoMessages.length = 0;
      await app.run(id);
      assert.ok(!app.state.infoMessages.some((m) => /Pro feature/.test(m.text)), id);
    }
    // The free features still work.
    await app.run('validateFile');
    assert.match(app.lastInfo().text, /No problems found/);
  } finally { app.stop(); }
});

test('pro tools: each of the new Pro commands can be the one that starts the 14-day trial', async () => {
  for (const id of PRO_TOOLS) {
    const app = boot();
    try {
      app.state.inputAnswer = undefined;
      assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined);
      await app.run(id);
      assert.equal(typeof app.ctx.globalState.get('trial.startedAt'), 'number', id + ' did not start the trial');
      assert.ok(app.state.infoMessages.some((m) => /Your free 14-day trial of EDI Lens Pro has started/.test(m.text)), id);
      assert.ok(!app.state.infoMessages.some((m) => /is an EDI Lens Pro feature/.test(m.text)), id);
      assert.equal(app.calls.length, 0, 'the trial uses no network');
    } finally { app.stop(); }
  }
});

test('anonymise message: asks for a seed, opens a copy, leaves the original alone and reports counts', async () => {
  const app = await licensed({ text: H, language: 'hl7', name: 'adt.hl7' });
  try {
    // Closing the seed box does nothing.
    await app.run('anonymise');
    assert.equal(app.state.openedDocuments.length, 0);
    assert.equal(app.state.inputBoxes.at(-1).password, true, 'the seed is typed like a password');
    assert.match(app.state.inputBoxes.at(-1).title, /seed \(optional\)/);
    app.state.inputAnswer = 'my seed';
    app.state.infoAnswer = (text, buttons) => (buttons.includes('Show Report') ? 'Show Report' : undefined);
    await app.run('anonymise');
    const copy = app.state.openedDocuments[0];
    assert.equal(copy.languageId, 'hl7');
    assert.equal(copy.uri.scheme, 'untitled');
    assert.ok(!copy.getText().includes('Hartwell') && copy.getText().length === H.length);
    assert.deepEqual(issues(copy.getText()), []);
    assert.equal(app.doc.getText(), H);
    assert.deepEqual(app.state.written, []);
    const told = app.state.infoMessages.find((m) => /Anonymised copy opened/.test(m.text));
    assert.match(told.text, /\d+ values replaced in 6 segments \(4 of them sender and receiver ids of the envelope\)\. The original file was not changed\. Check the copy before you share it/);
    assert.ok(!/ADMITSYS|LABPORTAL|RIVERSIDE/.test(copy.getText()), 'the sending and receiving applications and facilities are replaced too');
    assert.ok(!/Hartwell|Mira|19840712/.test(JSON.stringify(app.state.infoMessages)));
    const report = app.state.openedDocuments[1];
    assert.equal(report.languageId, 'markdown');
    assert.match(report.getText(), /A seed was given/);
    assert.match(report.getText(), /\| PID-5 \| fake-name \| profile hl7-patient \| 3 \|/);
    assert.ok(!/Hartwell|Mira|RS-4471902/.test(report.getText()), 'the report holds no value');
    // The same seed gives the same copy again.
    await app.run('anonymise');
    assert.equal(app.state.openedDocuments[2].getText(), copy.getText());
    assert.equal(app.calls.filter((c) => c.path !== '/licenses/activate').length, 0, 'nothing is sent anywhere');
  } finally { app.stop(); }
});

test('anonymise: the seed box and the report say what a seed repeats, and that other files can move a replacement', async () => {
  const anon = require('../src/pro/anonymise');
  const app = await licensed({ text: H, language: 'hl7', name: 'adt.hl7' });
  try {
    app.state.inputAnswer = 'my seed';
    app.state.infoAnswer = (text, buttons) => (buttons.includes('Show Report') ? 'Show Report' : undefined);
    await app.run('anonymise');
    const box = app.state.inputBoxes.at(-1);
    assert.equal(box.title, 'EDI Lens anonymise: seed (optional). The same seed, files and rules give the same replacements.');
    assert.equal(box.placeHolder, 'Leave empty for a random seed that is used for this run only');
    const seeded = app.state.openedDocuments.at(-1);
    assert.equal(seeded.languageId, 'markdown');
    assert.match(seeded.getText(), /^A seed was given: a later run with the same seed, files and rules gives the same replacements\. With other files, a value whose replacement had to move to stay distinct can get another one\.$/m);
    app.state.inputAnswer = '';
    await app.run('anonymise');
    assert.match(app.state.openedDocuments.at(-1).getText(), /^No seed was given: a random seed was used for this run only, so the replacements cannot be reproduced\.$/m);
    // The absolute wording of earlier builds is gone from the box and from both reports.
    const shown = app.state.inputBoxes.map((b) => b.title).concat(app.state.openedDocuments.map((d) => d.getText())).join('\n');
    assert.ok(!/in every run|produces the same replacements in a later run/.test(shown), shown.slice(0, 300));
  } finally { app.stop(); }
  // What the wording says is what happens. The same seed with the same values in the same order
  // gives the same replacements. When another value takes the first replacement of 042 before it,
  // 042 has to move to stay distinct and gets another one.
  const CTX = { format: 'x12', release: '', escape: '', fixedWidth: false };
  const alone = anon.createRewriter('seed-A').rewrite('pseudonym', '042', CTX).value;
  assert.equal(anon.createRewriter('seed-A').rewrite('pseudonym', '042', CTX).value, alone);
  const other = anon.createRewriter('seed-A');
  assert.equal(other.rewrite('pseudonym', '613', CTX).value, alone, 'the example needs 613 to take the first replacement of 042');
  const moved = other.rewrite('pseudonym', '042', CTX).value;
  assert.notEqual(moved, alone);
  assert.ok(other.distinct());
  const again = anon.createRewriter('seed-A');
  again.rewrite('pseudonym', '613', CTX);
  assert.equal(again.rewrite('pseudonym', '042', CTX).value, moved, 'the same values in the same order give the same replacements again');
});

test('anonymise message: the rule file and the profile setting decide what is replaced', async () => {
  const app = await licensed({ text: H, language: 'hl7', name: 'adt.hl7', config: { 'anonymise.profiles': [] } });
  try {
    app.state.inputAnswer = '';
    await app.run('anonymise');
    assert.match(app.state.warnMessages.at(-1).text, /No anonymise rules are active \(ANON-NO-RULES\)/);
    assert.equal(app.state.openedDocuments.length, 0);
    const file = app.put('.edilens/anonymise.json', JSON.stringify({ rules: [{ format: 'hl7', path: 'PV1-7', action: 'mask' }] }));
    await app.run('anonymise');
    const copy = app.state.openedDocuments.at(-1).getText();
    assert.ok(copy.includes('9999^XXXXXX^XXXX') && copy.includes('Hartwell^Mira^J'), copy);
    app.state.files.set(file.toString(), bytes('{"rules":[{"format":"hl7","path":"PID","action":"mask"}]}'));
    const before = app.state.openedDocuments.length;
    await app.run('anonymise');
    assert.match(app.state.errorMessages.at(-1), /anonymise rule file \.edilens\/anonymise\.json is not valid, so nothing was anonymised \(ANON-RULES-INVALID\)\. rules\[0\]: "path" must name an element/);
    assert.equal(app.state.openedDocuments.length, before);
    app.state.files.set(file.toString(), new Uint8Array([0xff, 0xfe, 0x00]));
    await app.run('anonymise');
    assert.match(app.state.warnMessages.at(-1).text, /is not valid UTF-8 text/);
    // A file in another language is refused with the usual hint.
    app.state.activeTextEditor = makeEditor(makeDocument('hello', 'plaintext', 'notes.txt'));
    await app.run('anonymise');
    assert.match(app.state.warnMessages.at(-1).text, /needs a UN\/EDIFACT, ANSI X12 or HL7 v2 file in the active editor/);
  } finally { app.stop(); }
});

test('export pseudonym map: nothing without a run, a clear warning, and a file only after two confirmations', async () => {
  const app = await licensed({ text: H, language: 'hl7', name: 'adt.hl7' });
  try {
    await app.run('exportPseudonymMap');
    assert.match(app.lastInfo().text, /There is no replacement table to export/);
    app.state.inputAnswer = 's';
    await app.run('anonymise');
    assert.deepEqual(app.state.written, [], 'anonymising writes no table');
    app.state.warnAnswer = undefined;
    await app.run('exportPseudonymMap');
    assert.match(app.state.warnMessages.at(-1).text, /lists every original value next to its replacement, so it is as sensitive as the original messages\. Nothing is written unless you choose Export/);
    assert.deepEqual(app.state.warnMessages.at(-1).rest[0], { modal: true });
    assert.deepEqual(app.state.written, []);
    app.state.warnAnswer = 'Export';
    app.state.saveDialogAnswer = undefined;
    await app.run('exportPseudonymMap');
    assert.deepEqual(app.state.written, [], 'closing the save dialog writes nothing');
    const target = Uri.file('/work/private/map.csv');
    app.state.saveDialogAnswer = target;
    await app.run('exportPseudonymMap');
    assert.deepEqual(app.state.written, [target.toString()]);
    assert.match(textOf(app, target), /^action,original,replacement\r\n/);
    assert.match(textOf(app, target), /\r\npseudonym,RS-4471902,[A-Z]{2}-\d{7}\r\n/);
    assert.match(textOf(app, target), /fake-name,Hartwell,/);
    assert.match(app.lastInfo().text, /Keep it as safe as the original messages/);
  } finally { app.stop(); }
});

test('anonymise folder: asks first, writes copies next to the folder, keeps the sources and reports', async () => {
  const app = await licensed();
  try {
    const folder = Uri.file('/work/inbox');
    const one = app.put('inbox/one.hl7', H);
    const two = app.put('inbox/sub/two.x12', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(X.replace('410 Harbour View Road', '18 LINDEN WALK'), 'utf8')]));
    const three = app.put('inbox/three.edi', new Uint8Array([0x55, 0x4e, 0x42, 0xff]));
    const four = app.put('inbox/four.edi', 'no segments in here');
    const five = app.put('inbox/five.hl7', H.replace('RS240305-0042', 'RS240305-0043'));
    app.state.findResult = [one, two, three, four, five];
    app.state.warnAnswer = undefined;
    await app.run('anonymiseFolder', folder);
    assert.match(app.state.warnMessages.at(-1).text, /Anonymise 5 files from \/work\/inbox\? The copies are written to \/work\/inbox-anonymised with the same file names; files that are already there are replaced\. The source files are not changed\./);
    assert.deepEqual(app.state.written, []);
    app.state.warnAnswer = 'Anonymise';
    app.state.inputAnswer = 'folder seed';
    await app.run('anonymiseFolder', folder);
    assert.deepEqual(app.state.written.sort(), ['file:///work/inbox-anonymised/five.hl7', 'file:///work/inbox-anonymised/one.hl7', 'file:///work/inbox-anonymised/sub/two.x12']);
    assert.equal(textOf(app, one), H, 'the source is untouched');
    const outOne = textOf(app, Uri.file('/work/inbox-anonymised/one.hl7'));
    const outFive = textOf(app, Uri.file('/work/inbox-anonymised/five.hl7'));
    assert.ok(!outOne.includes('Hartwell') && outOne.length === H.length);
    assert.equal(outFive, outOne.replace('RS240305-0042', 'RS240305-0043'), 'the same patient gets the same replacement in every file of the run');
    const outTwo = Buffer.from(app.state.files.get('file:///work/inbox-anonymised/sub/two.x12'));
    assert.deepEqual([...outTwo.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the byte order mark is kept');
    assert.ok(!outTwo.toString('utf8').includes('18 LINDEN WALK'));
    const report = app.state.openedDocuments.at(-1).getText();
    assert.match(report, /Files anonymised \| 3 \|/);
    assert.match(report, /Files left out \| 2 \|/);
    assert.match(report, /- inbox\/three\.edi: Not valid UTF-8 text\./);
    assert.ok(!/Hartwell|LINDEN/.test(report));
    assert.match(app.lastInfo().text, /Anonymise finished: 3 anonymised copies written to \/work\/inbox-anonymised, 2 files left out/);
    assert.deepEqual(app.state.progressTitles, ['EDI Lens: anonymising files']);
    // Cancelling after the first file leaves a partial result and says so.
    app.state.written.length = 0;
    app.state.cancelAfter = 1;
    await app.run('anonymiseFolder', folder);
    assert.equal(app.state.written.length, 1);
    assert.match(app.lastInfo().text, /\(cancelled, partial result\)/);
    app.state.cancelAfter = undefined;
    app.state.findResult = [];
    await app.run('anonymiseFolder', folder);
    assert.match(app.lastInfo().text, /No EDI files/);
  } finally { app.stop(); }
});

test('partner rules: violations become problems with the rule id; the results can be cleared', async () => {
  const app = await licensed();
  try {
    await app.run('validateWithRules');
    assert.match(app.state.warnMessages.at(-1).text, /No partner rule file was found at \.edilens\/rules\.json in \/work/);
    assert.deepEqual(app.state.warnMessages.at(-1).rest, ['Create Rules From This Message']);
    app.put('.edilens/rules.json', JSON.stringify({ name: 'Harbor Supply orders', format: 'edifact', messageTypes: ['ORDERS'], rules: [
      { id: 'HS-01', type: 'segment-required', segment: 'NAD[DP]', message: 'The delivery party (NAD+DP) is missing.' },
      { id: 'HS-02', type: 'value-in', path: 'CUX-1.2', values: ['USD'], severity: 'warning' },
      { id: 'HS-03', type: 'segment-required', segment: 'BGM' }] }));
    await app.run('validateWithRules');
    const diags = app.rules().map.get(app.doc.uri.toString());
    assert.equal(diags.length, 2);
    assert.deepEqual(diags.map((d) => [d.code, d.source, d.severity]), [['RULES-SEGMENT-REQUIRED', 'EDI Lens rules', 0], ['RULES-VALUE-NOT-IN-LIST', 'EDI Lens rules', 1]]);
    assert.equal(diags[0].message, '[HS-01] The delivery party (NAD+DP) is missing.');
    assert.deepEqual([diags[1].range.start.line, diags[1].range.start.character, diags[1].range.end.character], [9, 6, 9]);
    assert.match(app.lastInfo().text, /^2 rule violations in 1 message\./);
    assert.deepEqual(app.lastInfo().buttons, ['Show Problems']);
    // The structural problems of the free validation are a separate list and stay.
    assert.deepEqual(app.state.diagnosticCollections.find((c) => c.name === 'ediLens').map.get(app.doc.uri.toString()), []);
    await app.run('clearRulesResults');
    assert.equal(app.rules().map.size, 0);
    // A file the rules are not written for is not checked.
    const x = makeDocument(X, 'x12', 'po.x12');
    app.state.activeTextEditor = makeEditor(x);
    await app.run('validateWithRules');
    assert.match(app.lastInfo().text, /The rule file "Harbor Supply orders" is for UN\/EDIFACT messages of type ORDERS; this file is ANSI X12 with 1 message, none of which the rules apply to\. Nothing was checked\./);
    assert.equal(app.rules().map.size, 0);
    // A broken rule file is explained.
    app.put('.edilens/rules.json', JSON.stringify({ format: 'edifact', rules: [{ type: 'pattern', path: 'BGM-2', pattern: '(a+)+' }] }));
    await app.run('validateWithRules');
    assert.match(app.state.errorMessages.at(-1), /partner rule file \.edilens\/rules\.json is not valid, so nothing was checked \(RULES-FILE-INVALID\)\. rules\[0\]: "pattern" was not accepted/);
  } finally { app.stop(); }
});

test('partner rules: the rule file can sit anywhere the setting says; without a folder an absolute path is needed', async () => {
  const absolute = process.platform === 'win32' ? 'C:\\guides\\partner.json' : '/guides/partner.json';
  const app = await licensed({ noFolder: true, config: { 'rules.file': absolute } });
  try {
    app.state.files.set(Uri.file(absolute).toString(), bytes(JSON.stringify({ format: 'edifact', rules: [{ id: 'A', type: 'segment-forbidden', segment: 'CUX' }] })));
    await app.run('validateWithRules');
    assert.equal(app.rules().map.get(app.doc.uri.toString()).length, 1);
  } finally { app.stop(); }
  const none = await licensed({ noFolder: true });
  try {
    await none.run('validateWithRules');
    assert.match(none.state.warnMessages.at(-1).text, /open a folder, or set an absolute path in ediLens\.rules\.file/);
  } finally { none.stop(); }
});

test('create rules: a starting rule file opens as JSON, is valid and the message passes it', async () => {
  const app = await licensed();
  try {
    await app.run('createRules');
    const doc = app.state.openedDocuments.at(-1);
    assert.equal(doc.languageId, 'json');
    const guide = JSON.parse(doc.getText());
    assert.equal(guide.name, 'Rules created from orders.edi');
    assert.match(app.lastInfo().text, /A starting rule file with \d+ rules was created from 1 message and opened in a new editor\. It describes only what this file shows: review it[\s\S]*save it as \.edilens\/rules\.json/);
    assert.deepEqual(app.state.written, [], 'nothing is saved for the user');
    app.put('.edilens/rules.json', doc.getText());
    await app.run('validateWithRules');
    assert.match(app.lastInfo().text, /^No rule violations: 1 message checked against \d+ partner rules\.$/);
    assert.deepEqual(app.rules().map.get(app.doc.uri.toString()), []);
  } finally { app.stop(); }
});

test('partner rules over a folder: progress, problems per file, an HTML report and CSV on request', async () => {
  const app = await licensed();
  try {
    const folder = Uri.file('/work/inbox');
    const good = app.put('inbox/good.edi', E);
    const bad = app.put('inbox/bad.edi', E.replace("CUX+2:EUR:9'", "CUX+2:<b>=x</b>:9'"));
    const other = app.put('inbox/po.x12', X);
    const junk = app.put('inbox/junk.edi', new Uint8Array([0xff, 0xff]));
    app.put('inbox/.edilens/rules.json', JSON.stringify({ name: 'Folder guide', format: 'edifact', rules: [{ id: 'C1', type: 'value-in', path: 'CUX-1.2', values: ['EUR'] }] }));
    app.state.findResult = [good, bad, other, junk];
    app.state.saveDialogAnswer = Uri.file('/work/report.csv');
    app.state.infoAnswer = (text, buttons) => (buttons.includes('Save CSV Report...') ? 'Save CSV Report...' : undefined);
    await app.run('validateFolderWithRules', folder);
    assert.deepEqual(app.state.progressTitles, ['EDI Lens: checking files against the partner rules']);
    assert.deepEqual([...app.rules().map.keys()], [bad.toString()]);
    assert.equal(app.state.panel.type, 'ediLensRulesReport');
    assert.deepEqual(app.state.panel.options, { enableScripts: false });
    assert.match(app.state.panel.webview.html, /Rule file: Folder guide\.[\s\S]*2 files checked, 1 rule violations, 2 files not checked/);
    assert.ok(!app.state.panel.webview.html.includes('<b>=x</b>'), 'values from files are escaped');
    assert.match(app.state.panel.webview.html, /&lt;b&gt;=x&lt;\/b&gt;/);
    assert.match(app.lastInfo().text, /^Checked 2 files against 1 partner rule: 1 violation, 2 files not checked\./);
    assert.deepEqual(app.lastInfo().buttons, ['Save HTML Report...', 'Save CSV Report...']);
    const csv = textOf(app, Uri.file('/work/report.csv'));
    assert.equal(csv.split('\r\n')[1], 'inbox/bad.edi,10,7,error,RULES-VALUE-NOT-IN-LIST,C1,1,ORDERS,"[C1] CUX-1.2 has the value ""<b>=x</b>"", which is not in the list of allowed values (EUR)."');
    // Without the rule file in that folder the command explains where it looked.
    app.state.files.delete('file:///work/inbox/.edilens/rules.json');
    await app.run('validateFolderWithRules', folder);
    assert.match(app.state.warnMessages.at(-1).text, /No partner rule file was found at \.edilens\/rules\.json in \/work\/inbox/);
  } finally { app.stop(); }
});

test('query: runs on the open file, lists the matches, reveals them, saves the query and exports CSV', async () => {
  const app = await licensed();
  try {
    const answers = ['NAD[SU]-2.1 == "5498*" AND count(LIN) > 1', 'supplier with lines'];
    app.state.inputAnswer = () => answers.shift();
    app.state.quickPickAnswer = (items) => items[0];
    await app.run('query');
    assert.match(app.state.inputBoxes[0].title, /Brackets hold a qualifier \(NAD\[BY\]\); #2 counts/);
    assert.equal(app.state.inputBoxes[0].validateInput('exists('), 'The query is not valid at position 8: a segment or a path is expected inside exists(...).');
    assert.equal(app.state.inputBoxes[0].validateInput('exists(BGM)'), null);
    assert.match(app.lastInfo().text, /^1 message in 1 file match the query\. They are listed in the Query Results view/);
    assert.deepEqual(app.lastInfo().buttons, ['Export As CSV']);
    const provider = app.view().options.treeDataProvider;
    assert.match(app.view().message, /^Query: NAD\[SU\]-2\.1 == "5498\*" AND count\(LIN\) > 1: 1 message in 1 file$/);
    const files = provider.getChildren();
    assert.equal(files.length, 1);
    assert.equal(provider.getTreeItem(files[0]).label, 'orders.edi');
    const matches = provider.getChildren(files[0]);
    assert.equal(provider.getTreeItem(matches[0]).label, 'Message 1 \u00b7 ORDERS \u00b7 1');
    assert.equal(provider.getTreeItem(matches[0]).description, 'line 3');
    const hit = provider.getTreeItem(provider.getChildren(matches[0])[0]);
    assert.equal(hit.label, 'NAD[2]-2.1 = 5498765000134');
    assert.equal(hit.description, 'line 9');
    assert.deepEqual(hit.command.arguments.slice(1), [8, 7, 13]);
    await app.run('revealQueryResult', ...hit.command.arguments);
    const sel = app.state.shownOptions.selection;
    assert.equal(app.doc.getText().slice(app.doc.offsetAt(sel.start), app.doc.offsetAt(sel.end)), '5498765000134');
    // The query was saved for this workspace and is offered next time.
    assert.deepEqual(app.ctx.workspaceState.get('ediLens.savedQueries'), [{ name: 'supplier with lines', text: 'NAD[SU]-2.1 == "5498*" AND count(LIN) > 1' }]);
    app.state.quickPickAnswer = (items) => items.find((i) => i.label === 'supplier with lines') || items[0];
    app.state.inputAnswer = () => { throw new Error('a saved query needs no typing'); };
    await app.run('query');
    assert.match(app.lastInfo().text, /^1 message in 1 file match/);
    // CSV export into a new editor, with the formula protection named.
    await app.run('queryExportCsv');
    assert.equal(app.state.openedDocuments.at(-1).getText(), 'file,message_number,message_type,reference,line,column,path,value\r\norders.edi,1,ORDERS,1,9,8,NAD[2]-2.1,5498765000134\r\n');
    assert.match(app.lastInfo().text, /written as CSV into a new editor\. Values that start with =/);
    await app.run('clearQueryResults');
    assert.deepEqual(provider.getChildren(), []);
    assert.equal(app.view().message, undefined);
    await app.run('queryExportCsv');
    assert.match(app.lastInfo().text, /There are no query results to export/);
    app.state.quickPickAnswer = (items) => items[0];
    await app.run('deleteSavedQuery');
    assert.deepEqual(app.ctx.workspaceState.get('ediLens.savedQueries'), []);
    await app.run('deleteSavedQuery');
    assert.match(app.lastInfo().text, /No queries are saved in this workspace/);
  } finally { app.stop(); }
});

test('query: searches a folder with progress, skips what is no message, honours the limit and cancel', async () => {
  const app = await licensed({ config: { 'query.maxResults': 2, 'query.ignoreCase': true } });
  try {
    const folder = Uri.file('/work/inbox');
    const files = [app.put('inbox/a.edi', E), app.put('inbox/b.edi', E.replace('PO-24-00318', 'PO-24-00999')), app.put('inbox/c.x12', X), app.put('inbox/d.bin', new Uint8Array([0xff])), app.put('inbox/e.edi', E), app.put('inbox/f.edi', E)];
    app.state.findResult = files;
    const typed = ['bgm-2 == "po-24-*"', ''];
    app.state.inputAnswer = () => typed.shift();
    await app.run('query', folder);
    // Segment ids are case-sensitive, so the lower-case id finds nothing; the text comparison ignores case.
    assert.match(app.lastInfo().text, /^No message matches the query in \d+ files/);
    const again = ['BGM-2 == "po-24-*"', ''];
    app.state.inputAnswer = () => again.shift();
    await app.run('query', folder);
    assert.match(app.lastInfo().text, /^2 messages in 2 files match the query \(cut at the limit of ediLens\.query\.maxResults or at 2000 files\)/);
    assert.deepEqual(app.state.progressTitles, ['EDI Lens: searching files', 'EDI Lens: searching files']);
    assert.equal(app.ctx.workspaceState.get('ediLens.savedQueries'), undefined, 'an empty name saves nothing');
    const provider = app.view().options.treeDataProvider;
    assert.deepEqual(provider.getChildren().map((n) => provider.getTreeItem(n).label), ['inbox/a.edi', 'inbox/b.edi']);
    // Revealing a match in a file that is not open opens it.
    const hit = provider.getTreeItem(provider.getChildren(provider.getChildren(provider.getChildren()[1])[0])[0]);
    await app.run('revealQueryResult', ...hit.command.arguments);
    assert.equal(app.state.shown.uri.toString(), files[1].toString());
    // Without an editor and without a folder there is nothing to search.
    app.state.activeTextEditor = undefined;
    app.vscode.workspace.workspaceFolders = undefined;
    await app.run('query');
    assert.match(app.state.warnMessages.at(-1).text, /Query needs a UN\/EDIFACT, ANSI X12 or HL7 v2 file in the active editor, or an open folder to search/);
  } finally { app.stop(); }
});

test('split: one file per message in the chosen folder, existing files only after a confirmation', async () => {
  const three = require('node:fs').readFileSync(path.join(__dirname, 'fixtures', 'corpus', 'x12', '850-three-sets.x12'), 'utf8');
  const app = await licensed({ text: three, language: 'x12', name: 'batch.x12', config: { 'envelope.startNumber': 900 } });
  try {
    app.state.openDialogAnswer = undefined;
    await app.run('splitInterchange');
    assert.deepEqual(app.state.written, [], 'closing the folder dialog writes nothing');
    let asked;
    app.state.openDialogAnswer = (options) => { asked = options; return [Uri.file('/work/out')]; };
    await app.run('splitInterchange');
    assert.deepEqual([asked.canSelectFolders, asked.canSelectFiles, asked.openLabel, asked.defaultUri.path], [true, false, 'Write 3 Files Here', '/work']);
    assert.deepEqual(app.state.written, ['file:///work/out/batch-001.x12', 'file:///work/out/batch-002.x12', 'file:///work/out/batch-003.x12']);
    for (const [i, uri] of app.state.written.entries()) {
      const text = Buffer.from(app.state.files.get(uri)).toString('utf8');
      assert.deepEqual(issues(text), [], uri);
      assert.match(text, new RegExp('\\*00401\\*00000090' + i + '\\*0\\*P'));
      assert.match(text, new RegExp('ST\\*850\\*000' + (i + 1) + '~'));
    }
    assert.match(app.lastInfo().text, /^Wrote 3 files to \/work\/out \(batch-001\.x12 to batch-003\.x12\)\. Each one holds one message in its own envelope with a fresh control number\. The open file was not changed\.$/);
    assert.equal(app.doc.getText(), three);
    // The same folder again: the files exist, so the command asks.
    app.state.written.length = 0;
    app.state.warnAnswer = undefined;
    await app.run('splitInterchange');
    assert.match(app.state.warnMessages.at(-1).text, /3 files with the same name already exist in \/work\/out\. Replace them\? Nothing is written unless you choose Replace\./);
    assert.deepEqual(app.state.written, []);
    app.state.warnAnswer = 'Replace';
    await app.run('splitInterchange');
    assert.equal(app.state.written.length, 3);
    // A damaged envelope is refused with the reason and the code.
    app.doc._text = three.replace('SE*22*0002~\n', ''); app.doc.version++;
    app.state.written.length = 0;
    await app.run('splitInterchange');
    assert.match(app.state.warnMessages.at(-1).text, /The envelope of the file is damaged, so it was not changed: Message 0002 opened by ST is not closed by SE\.[\s\S]*\(ENV-BAD-ENVELOPE\)$/);
    assert.deepEqual(app.state.written, []);
  } finally { app.stop(); }
});

test('merge: chosen files or a folder become one interchange in a new editor', async () => {
  const app = await licensed({ text: null });
  try {
    const a = app.put('in/a.x12', X);
    const b = app.put('in/b.x12', X.replace('PO-24-00318', 'PO-24-00400'));
    app.state.openDialogAnswer = [b, a];
    await app.run('mergeMessages');
    const merged = app.state.openedDocuments.at(-1);
    assert.equal(merged.languageId, 'x12');
    assert.deepEqual(issues(merged.getText()), []);
    assert.ok(merged.getText().indexOf('PO-24-00318') < merged.getText().indexOf('PO-24-00400'), 'the files are merged in name order');
    assert.match(app.lastInfo().text, /^Merged 2 messages from 2 files into one interchange in a new editor\./);
    assert.deepEqual(app.state.written, []);
    // From the Explorer: every message file of the folder.
    app.state.findResult = [a, b];
    await app.run('mergeMessages', Uri.file('/work/in'));
    assert.equal(app.state.openedDocuments.at(-1).getText(), merged.getText());
    // Files that do not fit are named.
    const e = app.put('in/c.edi', E);
    app.state.openDialogAnswer = [a, e];
    await app.run('mergeMessages');
    assert.match(app.state.warnMessages.at(-1).text, /^in\/c\.edi: File 2 is in another format than file 1\.[\s\S]*\(ENV-MIXED-FORMATS\)$/);
    const junk = app.put('in/z.x12', new Uint8Array([0xff, 0x00]));
    app.state.openDialogAnswer = [a, junk];
    await app.run('mergeMessages');
    assert.match(app.state.warnMessages.at(-1).text, /^Nothing was merged: in\/z\.x12 could not be used\. Not valid UTF-8 text\.$/);
    app.state.openDialogAnswer = undefined;
    const before = app.state.openedDocuments.length;
    await app.run('mergeMessages');
    assert.equal(app.state.openedDocuments.length, before);
  } finally { app.stop(); }
});

test('renumber: asks for the start value and the references, edits the document once, can be undone', async () => {
  const app = await licensed({ text: X, language: 'x12', name: 'po.x12' });
  try {
    app.state.inputAnswer = undefined;
    await app.run('renumberControlNumbers');
    assert.equal(app.doc.getText(), X, 'closing the box changes nothing');
    const box = app.state.inputBoxes.at(-1);
    assert.match(box.title, /Renumber Control Numbers: first control number \(1 to 999999999\)/);
    assert.equal(box.value, '1');
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1000000000', ' ']) assert.match(String(box.validateInput(bad)), /whole number from 1 to 999999999/, bad);
    assert.equal(box.validateInput('500'), null);
    app.state.inputAnswer = 'abc';
    await app.run('renumberControlNumbers');
    assert.match(app.state.warnMessages.at(-1).text, /Enter a whole number from 1 to 999999999\. Nothing was changed\./);
    app.state.inputAnswer = '500';
    app.state.quickPickAnswer = undefined;
    await app.run('renumberControlNumbers');
    assert.equal(app.doc.getText(), X, 'closing the list changes nothing');
    assert.deepEqual(app.state.quickPicks.at(-1).items.map((i) => [i.label, i.keep]), [['Keep references', true], ['Update references', false]]);
    app.state.quickPickAnswer = (items) => items[0];
    const version = app.doc.version;
    await app.run('renumberControlNumbers');
    assert.equal(app.doc.version, version + 1, 'one edit');
    assert.deepEqual(issues(app.doc.getText()), []);
    assert.match(app.doc.getText(), /\*00401\*000000500\*0\*P[\s\S]*\*1015\*500\*X\*[\s\S]*ST\*850\*0500~[\s\S]*SE\*13\*0500~\nGE\*1\*500~\nIEA\*1\*000000500~/);
    assert.match(app.lastInfo().text, /^6 control numbers changed, starting at 500\. Headers and trailers agree; counts were not touched\. Use Undo to go back\.$/);
    await app.run('renumberControlNumbers');
    assert.match(app.lastInfo().text, /already start at 500; nothing was changed/);
    // A read-only editor is reported, as for Pretty Print.
    app.state.activeTextEditor.edit = async () => false;
    app.state.inputAnswer = '7';
    await app.run('renumberControlNumbers');
    assert.match(app.state.warnMessages.at(-1).text, /could not be changed, so nothing was modified\. It is probably read-only/);
  } finally { app.stop(); }
});

test('acknowledgement: a test acknowledgement opens beside the file and is named as a test', async () => {
  const app = await licensed({ text: X, language: 'x12', name: 'po.x12', config: { 'envelope.x12Acknowledgement': '999', 'envelope.startNumber': 12 } });
  try {
    await app.run('generateAcknowledgement');
    const ack = app.state.openedDocuments.at(-1);
    assert.equal(ack.languageId, 'x12');
    assert.deepEqual(issues(ack.getText()), []);
    assert.match(ack.getText(), /\*000000012\*0\*T\*>~\nGS\*FA\*HARBORSUPPLY\*NORTHBAYRETAIL\*\d{8}\*\d{4}\*12\*X\*005010X231A1~\nST\*999\*0001\*005010X231A1~\nAK1\*PO\*417\*004010~\nAK2\*850\*0001~\nIK5\*A~/);
    assert.match(app.lastInfo().text, /^TEST acknowledgement \(999\) opened in a new editor: 1 message acknowledged, 1 accepted, 0 rejected\. It is marked as a test \(ISA15 is T\) and only reflects the envelope checks of EDI Lens, not a business decision\. Do not send it as a production acknowledgement\.$/);
    assert.equal(app.doc.getText(), X);
    assert.deepEqual(app.state.written, []);
    // An acknowledgement is not acknowledged again.
    app.state.activeTextEditor = makeEditor(ack);
    ack.uri = Uri.file('/work/ack.x12');
    await app.run('generateAcknowledgement');
    assert.match(app.state.warnMessages.at(-1).text, /only functional acknowledgements \(group FA\), which are not acknowledged again\. \(ENV-NOTHING-TO-ACK\)$/);
  } finally { app.stop(); }
  for (const [text, language, kind, mark] of [[E, 'edifact', 'CONTRL', 'the UNB test indicator is 1'], [H, 'hl7', 'ACK', 'MSH-11 is T']]) {
    const other = await licensed({ text, language, name: 'm.' + language });
    try {
      await other.run('generateAcknowledgement');
      assert.deepEqual(issues(other.state.openedDocuments.at(-1).getText()), []);
      assert.ok(other.lastInfo().text.includes('TEST acknowledgement (' + kind + ')') && other.lastInfo().text.includes(mark));
    } finally { other.stop(); }
  }
});

test('pro tools: files above the size limit are refused with the usual message, for every single-file tool', async () => {
  const big = "UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'" + "LIN+1++X:EN'".repeat(100000) + "UNT+100002+1'UNZ+1+R1'";
  const app = await licensed({ text: big, name: 'big.edi', config: { maxFileSizeMB: 1 } });
  try {
    app.put('.edilens/rules.json', JSON.stringify({ format: 'edifact', rules: [] }));
    app.state.inputAnswer = '5';
    app.state.quickPickAnswer = (items) => items[0];
    for (const id of ['anonymise', 'validateWithRules', 'createRules', 'splitInterchange', 'renumberControlNumbers', 'generateAcknowledgement', 'query']) {
      app.state.warnMessages.length = 0;
      await app.run(id);
      assert.match(app.state.warnMessages.at(-1).text, /larger than the 1 MB limit, so it is not .*Raise the setting ediLens\.maxFileSizeMB/, id);
    }
    assert.equal(app.state.openedDocuments.length, 0);
    assert.equal(app.doc.getText(), big);
  } finally { app.stop(); }
});

test('pro tools: a licensed user sees no trial or Pro notice from any tool, and nothing but the licence check uses the network', async () => {
  const app = await licensed();
  try {
    app.put('.edilens/rules.json', JSON.stringify({ format: 'edifact', rules: [{ type: 'segment-required', segment: 'BGM' }] }));
    app.state.inputAnswer = (options) => (/query/i.test(options.title || '') ? (/name to save/.test(options.title) ? '' : 'exists(BGM)') : '3');
    app.state.quickPickAnswer = (items) => items[0];
    app.state.openDialogAnswer = [Uri.file('/work/out')];
    for (const id of ['anonymise', 'validateWithRules', 'createRules', 'query', 'queryExportCsv', 'splitInterchange', 'renumberControlNumbers', 'generateAcknowledgement']) await app.run(id);
    assert.deepEqual(app.state.infoMessages.filter((m) => /trial|Pro feature/i.test(m.text)), []);
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined, 'a licence never starts the trial');
    assert.deepEqual(app.calls.map((c) => c.path), ['/licenses/activate']);
    assert.deepEqual(app.state.errorMessages, []);
    assert.equal(app.ctx.globalState.get('licence.productId.live'), 'pdt_0NrkGSyl3UXB82kEhwUxy', 'the product id of the Business key is what is kept');
  } finally { app.stop(); }
});

test('Buy Pro: Business asks for the number of users and puts it into the checkout link', async () => {
  const app = boot();
  try {
    app.state.quickPickAnswer = (items) => items.find((i) => i.tier === 'business');
    app.state.inputAnswer = undefined;
    await app.run('buyPro');
    assert.equal(app.state.opened, undefined, 'closing the box opens nothing');
    const box = app.state.inputBoxes.at(-1);
    assert.equal(box.title, 'EDI Lens Pro Business: How many users? (1-100)');
    assert.equal(box.value, '1');
    for (const bad of ['0', '101', '2.5', 'x', '', '-1']) assert.equal(box.validateInput(bad), 'Enter a whole number from 1 to 100.', bad);
    assert.equal(box.validateInput('25'), null);
    app.state.inputAnswer = '0';
    await app.run('buyPro');
    assert.equal(app.state.opened, undefined);
    assert.match(app.state.warnMessages.at(-1).text, /Enter a whole number from 1 to 100\. The checkout page was not opened\./);
    app.state.inputAnswer = ' 25 ';
    await app.run('buyPro');
    assert.equal(app.state.opened.path, 'checkout.dodopayments.com/buy/pdt_0NrkGSyl3UXB82kEhwUxy?quantity=25');
    const detail = app.state.quickPicks.at(-1).items[1].detail;
    assert.ok(detail.includes(require('../src/licence/config').businessSeatsText));
    assert.equal(app.calls.length, 0, 'the Buy command itself sends nothing');
  } finally { app.stop(); }
  const savedEnv = process.env.EDI_LENS_LICENCE_MODE;
  process.env.EDI_LENS_LICENCE_MODE = 'test';
  const sandbox = boot({ extensionMode: 2 });
  try {
    sandbox.state.quickPickAnswer = (items) => items.find((i) => i.tier === 'business');
    sandbox.state.inputAnswer = '3';
    await sandbox.run('buyPro');
    assert.equal(sandbox.state.opened.path, 'test.checkout.dodopayments.com/buy/pdt_0NrkHV1XKbwlRjMEHbo4V?quantity=3');
  } finally {
    sandbox.stop();
    if (savedEnv === undefined) delete process.env.EDI_LENS_LICENCE_MODE; else process.env.EDI_LENS_LICENCE_MODE = savedEnv;
  }
});

test('licence in the editor: a key of another product is refused with a clear message and Pro stays off', async () => {
  const app = boot();
  try {
    await endTrial(app);
    const saved = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const p = new URL(url).pathname;
      seen.push({ path: p, body: JSON.parse(init.body) });
      if (p === '/licenses/activate') return { status: 201, json: async () => ({ id: 'lki_other', product: { product_id: 'pdt_0SomeOtherProduct123', name: 'Another product' }, customer: { name: 'N', email: 'n@example.invalid' } }) };
      return { status: 200, json: async () => null };
    };
    app.state.inputAnswer = 'KEY-OF-ANOTHER-PRODUCT';
    await app.run('enterKey');
    globalThis.fetch = saved;
    assert.match(app.state.errorMessages.at(-1), /^EDI Lens: This key belongs to another product, not to EDI Lens Pro, so it was not accepted\. The activation that was made for the check was released again and nothing was stored\./);
    assert.deepEqual(seen.map((c) => c.path), ['/licenses/activate', '/licenses/deactivate']);
    assert.equal(seen[1].body.license_key_instance_id, 'lki_other');
    assert.equal(await app.ctx.secrets.get('licence.key.live'), undefined);
    app.state.infoMessages.length = 0;
    app.state.inputAnswer = undefined;
    await app.run('query');
    assert.match(app.state.infoMessages[0].text, /Query is an EDI Lens Pro feature/);
    await app.run('licenceStatus');
    assert.match(app.lastInfo().text, /^EDI Lens Free\./);
  } finally { app.stop(); }
});

test('pro tools started from the editor context menu get the file of the editor, not a folder', async () => {
  const app = await licensed();
  try {
    // The editor context menu passes the document's address as the first argument.
    app.state.files.set(app.doc.uri.toString(), bytes(E));
    app.state.findResult = [];
    const typed = ['exists(BGM)', ''];
    app.state.inputAnswer = () => typed.shift();
    app.state.quickPickAnswer = (items) => items[0];
    await app.run('query', app.doc.uri);
    assert.match(app.lastInfo().text, /^1 message in 1 file match the query/, 'the open file was searched, not a folder');
    assert.deepEqual(app.state.progressTitles, []);
    // A folder from the Explorer is still a folder, also when another file is open.
    const inbox = Uri.file('/work/inbox');
    app.state.findResult = [app.put('inbox/a.edi', E)];
    const again = ['exists(BGM)', ''];
    app.state.inputAnswer = () => again.shift();
    await app.run('query', inbox);
    assert.deepEqual(app.state.progressTitles, ['EDI Lens: searching files']);
  } finally { app.stop(); }
});

test('partner rules: the violations of a file are removed when the file is edited, and only of that file', async () => {
  const app = await licensed();
  try {
    app.put('.edilens/rules.json', JSON.stringify({ format: 'edifact', rules: [{ id: 'A', type: 'segment-forbidden', segment: 'CUX' }] }));
    await app.run('validateWithRules');
    const other = Uri.file('/work/other.edi');
    app.rules().set(other, [{ message: 'kept' }]);
    assert.equal(app.rules().map.get(app.doc.uri.toString()).length, 1);
    // A change event without a change (for example a save) keeps the list.
    app.state.emitters.change.fire({ document: app.doc, contentChanges: [] });
    assert.equal(app.rules().map.get(app.doc.uri.toString()).length, 1);
    app.state.emitters.change.fire({ document: app.doc, contentChanges: [{ text: 'x' }] });
    assert.equal(app.rules().map.has(app.doc.uri.toString()), false, 'stale positions are not kept');
    assert.equal(app.rules().map.has(other.toString()), true);
    // The structural problems of the free validation are not touched by this.
    assert.ok(app.state.diagnosticCollections.find((c) => c.name === 'ediLens').map.has(app.doc.uri.toString()));
  } finally { app.stop(); }
});

test('licence in the editor: entering the same key four times uses one activation', async () => {
  const app = boot();
  try {
    app.state.inputAnswer = KEY;
    for (let i = 0; i < 4; i++) await app.run('enterKey');
    const paths = app.calls.map((c) => c.path);
    assert.equal(paths.filter((p) => p === '/licenses/activate').length, 1, paths.join(' '));
    assert.equal(paths.filter((p) => p === '/licenses/deactivate').length, 0);
    assert.equal(paths.filter((p) => p === '/licenses/validate').length, 3, 'the later entries only check the stored activation');
    assert.equal(app.state.errorMessages.length, 0);
    app.state.inputAnswer = undefined;
    await app.run('licenceStatus');
    assert.match(app.lastInfo().text, /^EDI Lens Pro/);
  } finally { app.stop(); }
});

test('licence in the editor: at the activation limit the message says what to do and nothing stored is lost', async () => {
  const app = await licensed();
  try {
    const saved = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const p = new URL(url).pathname;
      seen.push(p);
      if (p === '/licenses/activate') return { status: 422, json: async () => ({ code: 'LICENSE_KEY_LIMIT_REACHED', message: 'License key activation limit reached' }) };
      if (p === '/licenses/validate') return { status: 200, json: async () => ({ valid: true }) };
      return { status: 200, json: async () => null };
    };
    app.state.inputAnswer = 'ANOTHER-KEY-AT-ITS-LIMIT';
    await app.run('enterKey');
    globalThis.fetch = saved;
    assert.match(app.state.errorMessages.at(-1), /already active on the maximum number of computers \(3\), so it was not activated here\. Run "EDI Lens: Remove Licence From This Machine" on one of the other computers/);
    assert.match(app.state.errorMessages.at(-1), /The licence that is already stored on this computer was not changed\.$/);
    assert.ok(!seen.includes('/licenses/deactivate'), 'the stored activation is not released for a key that was refused');
    assert.equal(await app.ctx.secrets.get('licence.key.live'), KEY, 'the stored key is still there');
    app.state.inputAnswer = undefined;
    await app.run('licenceStatus');
    assert.match(app.lastInfo().text, /^EDI Lens Pro/);
  } finally { app.stop(); }
});

test('anonymise message: when no rule matches, a warning is shown and no copy is opened', async () => {
  const order = PLAIN;
  const app = await licensed({ text: order, language: 'x12', name: 'order.x12', config: { 'anonymise.profiles': ['x12-healthcare'] } });
  try {
    app.state.inputAnswer = 'seed';
    await app.run('anonymise');
    assert.equal(app.state.openedDocuments.length, 0, 'a text with only its envelope ids replaced is not handed out as anonymised');
    assert.match(app.state.warnMessages.at(-1).text, /No rule matched a value in this ANSI X12 file, so no anonymised copy was made\./);
    assert.ok(!app.state.infoMessages.some((m) => /Anonymised copy opened/.test(m.text)));
    await app.run('exportPseudonymMap');
    assert.match(app.lastInfo().text, /There is no replacement table to export/);
  } finally { app.stop(); }
});

test('anonymise folder: a file no rule matched is reported as unchanged and is not written', async () => {
  const app = await licensed({ config: { 'anonymise.profiles': ['hl7-patient', 'x12-healthcare'] } });
  try {
    const folder = Uri.file('/work/inbox');
    const one = app.put('inbox/one.hl7', H);
    const two = app.put('inbox/order.x12', PLAIN);
    app.state.findResult = [one, two];
    app.state.warnAnswer = 'Anonymise';
    app.state.inputAnswer = 's';
    await app.run('anonymiseFolder', folder);
    assert.deepEqual(app.state.written, ['file:///work/inbox-anonymised/one.hl7'], 'the order is not copied into the folder of anonymised files');
    const warned = app.state.warnMessages.at(-1).text;
    assert.match(warned, /1 file unchanged: no rule matched a value in it, so it is NOT anonymised and was not written to the target folder\. Anonymise finished: 1 anonymised copy written to \/work\/inbox-anonymised, 0 files left out/);
    assert.ok(!app.state.infoMessages.some((m) => /Anonymise finished/.test(m.text)), 'the result is a warning, not a plain notice');
    const report = app.state.openedDocuments.at(-1).getText();
    assert.match(report, /Files anonymised \| 1 \|/);
    assert.match(report, /Files unchanged: no rule matched \| 1 \|/);
    assert.match(report, /- inbox\/order\.x12 \(ANSI X12\): nothing was written/);
  } finally { app.stop(); }
});

test('anonymise folder: unchanged files are copied only when the setting says so, and still reported', async () => {
  const app = await licensed({ config: { 'anonymise.profiles': ['hl7-patient', 'x12-healthcare'], 'anonymise.copyUnchanged': true } });
  try {
    const folder = Uri.file('/work/inbox');
    const one = app.put('inbox/one.hl7', H);
    const two = app.put('inbox/order.x12', PLAIN);
    app.state.findResult = [one, two];
    app.state.warnAnswer = 'Anonymise';
    app.state.inputAnswer = 's';
    await app.run('anonymiseFolder', folder);
    assert.deepEqual(app.state.written.slice().sort(), ['file:///work/inbox-anonymised/one.hl7', 'file:///work/inbox-anonymised/order.x12']);
    assert.equal(textOf(app, Uri.file('/work/inbox-anonymised/order.x12')), PLAIN, 'the copy is the source, byte for byte, envelope ids included');
    assert.match(app.state.warnMessages.at(-1).text, /1 file unchanged: no rule matched a value in it, so it is NOT anonymised and was copied as it is \(setting ediLens\.anonymise\.copyUnchanged\); the report names it\./);
    assert.match(app.state.openedDocuments.at(-1).getText(), /- inbox\/order\.x12 \(ANSI X12\): copied unchanged because the setting ediLens\.anonymise\.copyUnchanged is on/);
  } finally { app.stop(); }
});

test('anonymise message: with envelopeIds "keep" the envelope stays and the notice says so', async () => {
  const app = await licensed({ text: X, language: 'x12', name: 'order.x12', config: { 'anonymise.envelopeIds': 'keep' } });
  try {
    app.state.inputAnswer = 'seed';
    await app.run('anonymise');
    const copy = app.state.openedDocuments[0].getText();
    assert.ok(copy.startsWith('ISA*00*          *00*          *ZZ*NORTHBAYRETAIL *ZZ*HARBORSUPPLY   *'));
    assert.ok(!copy.includes('410 Harbour View Road'));
    assert.match(app.state.infoMessages.find((m) => /Anonymised copy opened/.test(m.text)).text, /\(the sender and receiver ids of the envelope were kept, as set\)/);
  } finally { app.stop(); }
});

test('settings: nothing a user can set chooses the licence server', async () => {
  const props = pkg.contributes.configuration.properties;
  assert.ok(!Object.keys(props).some((k) => /licenceMode|licenseMode|licence\.mode/i.test(k)));
  assert.deepEqual(props['ediLens.anonymise.envelopeIds'].enum, ['pseudonymise', 'keep']);
  assert.equal(props['ediLens.anonymise.envelopeIds'].default, 'pseudonymise');
  assert.equal(props['ediLens.anonymise.copyUnchanged'].default, false);
  // A value left over in a settings file from 0.1.x has no effect: the key is checked on the live server.
  const app = boot({ config: { licenceMode: 'test' } });
  try {
    app.state.inputAnswer = KEY;
    await app.run('enterKey');
    assert.equal(await app.ctx.secrets.get('licence.key.live'), KEY);
    assert.equal(await app.ctx.secrets.get('licence.key.test'), undefined);
  } finally { app.stop(); }
});
