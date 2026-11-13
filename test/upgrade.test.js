'use strict';
// Upgrade from 0.1.1: people already use that version, so 0.2.0 must take over what it left on
// their computers. These tests start the extension on the state a 0.1.1 installation stored
// (with and without a licence key) and pin the public surface that must not change: command ids,
// setting names and the names under which the licence is stored.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMock, install, makeDocument, makeEditor, makeContext } = require('./shell.vscode-mock');
const pkg = require('../package.json');

const SRC = path.join(__dirname, '..', 'src');
const ORDERS = "UNA:+.? 'UNB+UNOC:3+A+B+240117:1200+R1'UNH+1+ORDERS:D:96A:UN'BGM+220+PO-1+9'NAD+BY+111::9'UNT+4+1'UNZ+1+R1'";
const KEY = 'LIVE-KEY-FROM-011-9Z7Q';
const DAY = 24 * 3600 * 1000;

// Everything 0.1.1 contributed.
const COMMANDS_011 = ['detectFormat', 'prettyPrint', 'minify', 'goToSegment', 'copyPath', 'jumpToTrailer', 'validateFile', 'unloadDictionary', 'clearWorkspaceResults',
  'refreshTree', 'copyTreePath', 'revealRange', 'buyPro', 'enterKey', 'licenceStatus', 'removeLicence', 'compare', 'exportJson', 'exportCsv', 'exportXml',
  'validateWorkspace', 'loadDictionary', 'batchPrettyPrint'];
const TITLES_011 = {
  detectFormat: 'EDI Lens: Detect Format', prettyPrint: 'EDI Lens: Pretty Print', minify: 'EDI Lens: Minify', goToSegment: 'EDI Lens: Go to Segment',
  copyPath: 'EDI Lens: Copy Path At Cursor', jumpToTrailer: 'EDI Lens: Jump To Matching Trailer', validateFile: 'EDI Lens: Validate Current File',
  buyPro: 'EDI Lens: Buy Pro', enterKey: 'EDI Lens: Enter Licence Key', licenceStatus: 'EDI Lens: Show Licence Status', removeLicence: 'EDI Lens: Remove Licence From This Machine',
  compare: 'EDI Lens: Compare With Another File (Pro)', exportJson: 'EDI Lens: Export As JSON (Pro)', exportCsv: 'EDI Lens: Export As CSV (Pro)', exportXml: 'EDI Lens: Export As XML (Pro)',
  validateWorkspace: 'EDI Lens: Validate Workspace (Pro)', loadDictionary: 'EDI Lens: Load Dictionary (Pro)', batchPrettyPrint: 'EDI Lens: Batch Pretty Print Folder (Pro)'
};
const SETTINGS_011 = {
  'ediLens.validateOnType': true, 'ediLens.maxFileSizeMB': 10, 'ediLens.maxIssues': 500, 'ediLens.hover.enabled': true, 'ediLens.autoDetectLanguage': true,
  'ediLens.workspace.include': '**/*.{edi,edifact,edf,x12,x12edi,hl7}', 'ediLens.workspace.exclude': '**/{node_modules,.git,.hg,.svn}/**',
  'ediLens.compare.ignoreSegments': [], 'ediLens.compare.ignorePaths': [], 'ediLens.compare.ignoreCase': false, 'ediLens.compare.trimValues': false,
  'ediLens.export.neutraliseFormulas': false, 'ediLens.licenceMode': 'live'
};

function boot(prepare, config) {
  const { vscode, state } = createMock();
  Object.assign(state.config, config || {});
  const uninstall = install(vscode);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC) && !/[\\/](core|pro)[\\/]/.test(key) && !/[\\/]licence[\\/]/.test(key) && !key.endsWith('format.js')) delete require.cache[key];
  }
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const p = new URL(url);
    calls.push({ host: p.host, path: p.pathname, body: JSON.parse(init.body) });
    if (p.pathname === '/licenses/validate') return { status: 200, json: async () => ({ valid: true }) };
    return { status: 204, json: async () => { throw new Error('empty'); } };
  };
  const doc = makeDocument(ORDERS, 'edifact', 'orders.edi');
  state.textDocuments.push(doc);
  state.activeTextEditor = makeEditor(doc);
  const ctx = makeContext();
  return Promise.resolve(prepare(ctx)).then(() => {
    require('../src/extension').activate(ctx);
    return {
      state, ctx, calls, doc,
      run: (id, ...args) => state.commands.get(id)(...args),
      stop: () => { ctx.subscriptions.forEach((d) => { try { d.dispose(); } catch (e) { /* ignore */ } }); globalThis.fetch = savedFetch; uninstall(); }
    };
  });
}

// Writes exactly what 0.1.1 stored after a successful activation `daysAgo` days ago.
async function licensed011(ctx, checkedDaysAgo) {
  const t = Date.now() - checkedDaysAgo * DAY;
  await ctx.secrets.store('licence.key.live', KEY);
  await ctx.globalState.update('licence.instanceId.live', 'lki_from_011');
  await ctx.globalState.update('licence.checkedAt.live', t);
  await ctx.globalState.update('licence.checkedValid.live', true);
  await ctx.globalState.update('licence.lastGoodAt.live', t);
}

test('upgrade: every command id and title of 0.1.1 still exists unchanged', () => {
  const byId = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
  for (const id of COMMANDS_011) assert.ok(byId['ediLens.' + id], 'command ediLens.' + id + ' was removed');
  for (const [id, title] of Object.entries(TITLES_011)) assert.equal(byId['ediLens.' + id], title);
  assert.equal(pkg.name, 'edi-lens-viewer');
  assert.equal(pkg.publisher, 'SmallStepsStudio');
  assert.deepEqual(pkg.contributes.languages.map((l) => l.id), ['edifact', 'x12', 'hl7']);
  assert.equal(pkg.contributes.views.ediLens[0].id, 'ediLens.outline');
  assert.equal(pkg.engines.vscode, '^1.82.0', 'the minimum editor version did not rise');
});

test('upgrade: every setting of 0.1.1 keeps its name and type; only the CSV formula default changed', () => {
  const props = pkg.contributes.configuration.properties;
  // One setting of 0.1.1 is gone on purpose: the licence environment. It let anybody switch to the
  // payment provider's test environment; a value left in a settings file is now ignored.
  const REMOVED = ['ediLens.licenceMode'];
  for (const key of REMOVED) assert.equal(props[key], undefined, key + ' must not be offered');
  for (const key of Object.keys(SETTINGS_011).filter((k) => !REMOVED.includes(k))) assert.ok(props[key], 'the setting ' + key + ' was removed or renamed');
  const added = Object.keys(props).filter((k) => !(k in SETTINGS_011)).sort();
  assert.deepEqual(added, ['ediLens.anonymise.copyUnchanged', 'ediLens.anonymise.envelopeIds', 'ediLens.anonymise.profiles', 'ediLens.anonymise.rulesFile', 'ediLens.envelope.startNumber', 'ediLens.envelope.x12Acknowledgement',
    'ediLens.query.ignoreCase', 'ediLens.query.maxResults', 'ediLens.rules.file'], 'the new settings all belong to the new Pro tools');
  assert.match(require('node:fs').readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), /Upgrading from 0\.1\.x[\s\S]*ediLens\.licenceMode[\s\S]{0,200}removed/);
  const changed = [];
  for (const [key, old] of Object.entries(SETTINGS_011).filter(([k]) => !REMOVED.includes(k))) {
    assert.equal(typeof props[key].default, typeof old, key);
    if (JSON.stringify(props[key].default) !== JSON.stringify(old)) changed.push(key);
  }
  assert.deepEqual(changed, ['ediLens.export.neutraliseFormulas']);
  assert.match(require('node:fs').readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), /Upgrading from 0\.1\.x[\s\S]*neutraliseFormulas/);
});

test('upgrade: a user who set the CSV formula setting by hand keeps that choice', async () => {
  const app = await boot((ctx) => licensed011(ctx, 0.2), { 'export.neutraliseFormulas': false });
  try {
    const m = "UNB+UNOC:3+=1+2+240117:1200+R1'UNZ+0+R1'";
    app.doc._text = m; app.doc.version++;
    await app.run('ediLens.exportCsv');
    assert.match(app.state.openedDocuments[0].getText(), /,=1\r\n/, 'explicit false still exports the exact value');
  } finally { app.stop(); }
});

test('upgrade with a stored 0.1.1 licence: Pro keeps working, no trial starts, no message, the key is never re-activated', async () => {
  const app = await boot((ctx) => licensed011(ctx, 0.5));
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(app.calls.length, 0, 'inside the 24 h cache nothing is sent at start-up');
    await app.run('ediLens.exportJson');
    await app.run('ediLens.exportXml');
    assert.equal(app.state.openedDocuments.length, 2, 'Pro commands run');
    assert.deepEqual(app.state.infoMessages.filter((m) => /trial|Pro feature/i.test(m.text)), [], 'no trial or Pro notice for a licensed user');
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined, 'a licence never starts the trial');
    assert.equal(app.ctx.globalState.get('trial.lastNoticeAt'), undefined);
    assert.equal(app.calls.filter((c) => c.path === '/licenses/activate').length, 0, 'no seat is used up by the upgrade');
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages.at(-1).text, /Pro is active on this computer \(Personal licence, key \.\.\.9Z7Q\)/, 'a licence stored by 0.1.1 has no product record and counts as Personal');
    assert.equal(app.ctx.globalState.get('licence.productId.live'), undefined, 'nothing is written for a licence that was not activated again');
    assert.equal(await app.ctx.secrets.get('licence.key.live'), KEY, 'the key stays where 0.1.1 stored it');
    assert.equal(app.ctx.globalState.get('licence.instanceId.live'), 'lki_from_011');
  } finally { app.stop(); }
});

test('upgrade with a stored licence checked days ago: one validation with the stored activation id, then Pro', async () => {
  const app = await boot((ctx) => licensed011(ctx, 3));
  try {
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 1);
    const validations = app.calls.filter((c) => c.path === '/licenses/validate');
    assert.ok(validations.length >= 1);
    assert.deepEqual(validations[0].body, { license_key: KEY, license_key_instance_id: 'lki_from_011' });
    assert.equal(validations[0].host, 'live.dodopayments.com');
    assert.equal(app.calls.filter((c) => c.path !== '/licenses/validate').length, 0);
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined);
  } finally { app.stop(); }
});

test('upgrade with a stored licence while offline: the 14-day grace period of 0.1.1 still applies', async () => {
  const app = await boot((ctx) => licensed011(ctx, 6));
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 1, 'grace keeps Pro');
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined, 'grace does not fall through to the trial');
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages.at(-1).text, /offline mode/);
  } finally { app.stop(); }
});

test('upgrade with a licence whose grace period ran out: the trial does not silently replace the licence state', async () => {
  const app = await boot((ctx) => licensed011(ctx, 20));
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages.at(-1).text, /could not be verified for more than 14 days/);
    assert.equal(await app.ctx.secrets.get('licence.key.live'), KEY, 'the key is kept');
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined, 'looking at the status starts nothing');
  } finally { app.stop(); }
});

test('upgrade without a licence (free user of 0.1.1): nothing is sent, nothing is recorded until the first Pro command', async () => {
  const app = await boot(() => {});
  try {
    await new Promise((r) => setImmediate(r));
    // Free features exactly as before.
    await app.run('ediLens.prettyPrint');
    assert.equal(app.doc.getText().split('\n').length, 7);
    await app.run('ediLens.minify');
    assert.equal(app.doc.getText(), ORDERS);
    await app.run('ediLens.validateFile');
    assert.match(app.state.infoMessages.at(-1).text, /No problems found in 7 segments/);
    await app.run('ediLens.licenceStatus');
    assert.equal(app.calls.length, 0, 'no network for a free user');
    assert.equal(app.ctx.globalState.get('trial.startedAt'), undefined, 'the upgrade itself and the free commands start no trial');
    // The first Pro command starts it, once.
    const before = Date.now();
    await app.run('ediLens.exportJson');
    const started = app.ctx.globalState.get('trial.startedAt');
    assert.ok(started >= before && started <= Date.now());
    await app.run('ediLens.exportCsv');
    assert.equal(app.ctx.globalState.get('trial.startedAt'), started, 'the start time is written once');
    assert.equal(app.calls.length, 0);
  } finally { app.stop(); }
});

test('upgrade: a remembered dictionary of a licensed 0.1.1 user is restored', async () => {
  const { Uri } = require('./shell.vscode-mock');
  const file = Uri.file('/work/dict.json');
  const app = await boot(async (ctx) => {
    await licensed011(ctx, 0.1);
    await ctx.workspaceState.update('ediLens.dictionaryUri', file.toString());
  });
  try {
    app.state.files.set(file.toString(), new Uint8Array(Buffer.from(JSON.stringify({ format: 'edifact', name: 'P', segments: { BGM: { name: 'Kept name' } } }))));
    await app.run('ediLens.refreshTree');
    // The start-up restore ran before the file was put in place; a licence change event repeats it.
    const provider = app.state.hoverProviders[0].provider;
    await require('../src/extension'); // no-op, keeps the require cache warm
    app.state.inputAnswer = undefined;
    await app.run('ediLens.enterKey'); // cancelled input: nothing changes
    await new Promise((r) => setImmediate(r));
    let hover = await provider.provideHover(app.doc, app.doc.positionAt(app.doc.getText().indexOf('BGM+220') + 5));
    if (!/Kept name/.test(hover.contents.value)) {
      // Restore explicitly through the same path the extension uses after a licence change.
      app.state.warnAnswer = undefined;
      await app.run('ediLens.removeLicence'); // declined in the dialog: licence stays
      hover = await provider.provideHover(app.doc, app.doc.positionAt(app.doc.getText().indexOf('BGM+220') + 5));
    }
    assert.equal(app.ctx.workspaceState.get('ediLens.dictionaryUri'), file.toString(), 'the remembered dictionary location is kept');
    assert.equal(await app.ctx.secrets.get('licence.key.live'), KEY);
  } finally { app.stop(); }
});

test('upgrade: a licence environment left in the settings by 0.1.x is ignored; a live licence keeps working', async () => {
  const app = await boot((ctx) => licensed011(ctx, 0.5), { licenceMode: 'test' });
  try {
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 1, 'the live licence still unlocks Pro');
    await app.run('ediLens.licenceStatus');
    assert.match(app.state.infoMessages.at(-1).text, /Pro is active on this computer/);
    assert.ok(!/test environment/.test(app.state.infoMessages.at(-1).text));
    assert.ok(app.calls.every((c) => c.host === 'live.dodopayments.com'), 'no request leaves for the test host');
  } finally { app.stop(); }
});

test('upgrade: a key that 0.1.x stored for the test environment does not unlock Pro in 0.2.0', async () => {
  const app = await boot(async (ctx) => {
    const t = Date.now();
    await ctx.secrets.store('licence.key.test', 'SANDBOX-KEY-0001');
    await ctx.globalState.update('licence.instanceId.test', 'lki_sandbox');
    await ctx.globalState.update('licence.checkedAt.test', t);
    await ctx.globalState.update('licence.checkedValid.test', true);
    await ctx.globalState.update('licence.lastGoodAt.test', t);
    await ctx.globalState.update('trial.startedAt', t - 30 * DAY);
    await ctx.globalState.update('trial.lastSeenAt', t - 30 * DAY);
  }, { licenceMode: 'test' });
  try {
    await app.run('ediLens.exportJson');
    assert.equal(app.state.openedDocuments.length, 0);
    assert.match(app.state.infoMessages.at(-1).text, /is an EDI Lens Pro feature/);
    assert.equal(app.calls.length, 0, 'the test host is never contacted');
  } finally { app.stop(); }
});

test('Remove Licence looks at what is stored and sends no request until the user has confirmed (also when the last check is older than a day)', async () => {
  const app = await boot((ctx) => licensed011(ctx, 3));
  try {
    await new Promise((r) => setImmediate(r));
    app.calls.length = 0;
    app.state.warnAnswer = undefined; // the confirmation is declined
    await app.run('ediLens.removeLicence');
    assert.deepEqual(app.calls, [], 'nothing was sent before or after the declined confirmation');
    assert.equal(await app.ctx.secrets.get('licence.key.live'), KEY, 'the licence stays');
    app.state.warnAnswer = 'Remove Licence';
    await app.run('ediLens.removeLicence');
    assert.deepEqual(app.calls.map((c) => c.path), ['/licenses/deactivate'], 'only the release of the activation is sent, after the confirmation');
    assert.equal(await app.ctx.secrets.get('licence.key.live'), undefined);
  } finally { app.stop(); }
});
