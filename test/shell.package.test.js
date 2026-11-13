'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes;
const OUR_LANGUAGES = ['edifact', 'x12', 'hl7'];

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

function listFiles(dir, out) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) listFiles(rel, out);
    else out.push(rel);
  }
  return out;
}

test('manifest has the fields the marketplace needs', () => {
  assert.equal(pkg.name, 'edi-lens-viewer');
  assert.equal(pkg.displayName, 'EDI Lens - EDIFACT, X12 and HL7 Viewer');
  assert.equal(pkg.publisher, 'SmallStepsStudio');
  assert.equal(pkg.version, '0.2.1');
  assert.equal(pkg.engines.vscode, '^1.82.0');
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE.txt');
  assert.equal(pkg.icon, 'media/icon.png');
  assert.equal(pkg.main, './src/extension.js');
  assert.equal(pkg.homepage, 'https://github.com/small-steps-studio/edi-lens#readme');
  assert.equal(pkg.repository.url, 'https://github.com/small-steps-studio/edi-lens');
  assert.equal(pkg.bugs.url, 'https://github.com/small-steps-studio/edi-lens/issues');
  assert.equal(pkg.pricing, 'Trial', 'the Marketplace pricing label is Free or Trial; Pro is sold outside the Marketplace');
  assert.deepEqual(pkg.categories, ['Formatters', 'Linters', 'Visualization', 'Other']);
  assert.ok(pkg.keywords.length >= 5 && pkg.keywords.length <= 30, 'vsce allows at most 30 keywords');
  assert.equal(new Set(pkg.keywords.map((k) => k.toLowerCase())).size, pkg.keywords.length, 'keywords are unique');
  for (const k of pkg.keywords) assert.ok(!/free|best|#1|seller/i.test(k), 'no marketing claims in keywords: ' + k);
  assert.deepEqual(pkg.galleryBanner, { color: '#17324d', theme: 'dark' });
  assert.ok(pkg.description.length > 20 && pkg.description.length <= 200);
  assert.match(pkg.description, /14-day trial/);
  assert.match(pkg.description, /licence check/);
  assert.match(pkg.description, /offline/);
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, true);
  assert.equal(pkg.capabilities.virtualWorkspaces.supported, 'limited');
  assert.ok(pkg.capabilities.virtualWorkspaces.description);
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(pkg.devDependencies, undefined);
});

test('every file the manifest points to exists', () => {
  const files = [pkg.icon, pkg.main, 'language-configuration.json', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'TERMS.md', 'PRIVACY.md', '.vscodeignore', '.gitignore', '.gitattributes',
    'docs/getting-started.md', 'docs/formats.md', 'docs/licence.md', 'docs/troubleshooting.md', 'docs/anonymise.md', 'docs/partner-rules.md', 'docs/query.md', 'docs/envelope-tools.md', '.github/workflows/ci.yml'];
  for (const v of contributes.jsonValidation) files.push(v.url.slice(2));
  for (const l of contributes.languages) files.push(l.configuration);
  for (const g of contributes.grammars) files.push(g.path);
  for (const c of contributes.viewsContainers.activitybar) files.push(c.icon);
  for (const w of contributes.walkthroughs) for (const s of w.steps) files.push(s.media.markdown);
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f + ' is missing');
  // File names are referenced with their exact case (case-sensitive file systems).
  for (const f of files) {
    const dir = path.dirname(path.join(root, f));
    assert.ok(fs.readdirSync(dir).includes(path.basename(f)), f + ' differs in case from the file on disk');
  }
});

test('the walkthrough has six steps that point at real commands and views', () => {
  assert.equal(contributes.walkthroughs.length, 1);
  const w = contributes.walkthroughs[0];
  assert.equal(w.id, 'ediLens.gettingStarted');
  assert.ok(w.title && w.description);
  assert.equal(w.steps.length, 6);
  const ids = new Set(contributes.commands.map((c) => c.command));
  const stepIds = new Set();
  for (const s of w.steps) {
    assert.ok(!stepIds.has(s.id), 'duplicate step id ' + s.id);
    stepIds.add(s.id);
    assert.ok(s.title && s.description && s.media && s.media.markdown, s.id);
    for (const m of s.description.matchAll(/\(command:([A-Za-z.]+)\)/g)) {
      assert.ok(ids.has(m[1]) || m[1].startsWith('workbench.'), s.id + ' links to ' + m[1]);
    }
    assert.ok(Array.isArray(s.completionEvents) && s.completionEvents.length > 0, s.id + ' has completion events');
    for (const e of s.completionEvents) {
      if (e.startsWith('onCommand:')) assert.ok(ids.has(e.slice('onCommand:'.length)), e);
      else if (e.startsWith('onView:')) assert.equal(e, 'onView:ediLens.outline');
      else assert.equal(e, 'stepSelected', e);
    }
    const text = read(s.media.markdown);
    assert.ok(text.length > 200, s.media.markdown + ' is too short to help');
  }
  assert.deepEqual(w.steps.map((s) => s.title), ['Open a sample message', 'Read the outline', 'Hover a value', 'Run validation', 'Try Pro', 'Share, check and split with Pro']);
  assert.match(contributes.viewsWelcome[0].contents, /command:ediLens\.openSampleEdifact/);
  assert.match(contributes.viewsWelcome[0].contents, /command:ediLens\.openWalkthrough/);
  assert.equal(require('../src/commands').WALKTHROUGH_ID, pkg.publisher + '.' + pkg.name + '#' + w.id);
});

test('the sample messages are valid, short and use invented data', () => {
  const { SAMPLES, sampleFor } = require('../src/samples');
  const core = require('../src/format').getCore();
  for (const format of ['edifact', 'x12', 'hl7']) {
    const s = sampleFor(format);
    assert.equal(s.format, format);
    assert.equal(s.languageId, format);
    const m = core.parse(s.text);
    assert.equal(m.format, format);
    assert.deepEqual(m.issues, [], format);
    assert.deepEqual(core.validate(m), [], format + ' sample has no problems');
    assert.ok(m.segments.length >= 6 && m.segments.length <= 25, format + ' sample is short');
    assert.ok(s.text.length < 2000);
    assert.equal(core.minify(core.parse(core.pretty(m))), core.minify(m), format + ' round trip');
  }
  assert.equal(sampleFor('other'), null);
  assert.equal(Object.keys(SAMPLES).length, 3);
  const all = Object.values(SAMPLES).map((s) => s.text).join('\n');
  // Nothing that looks like a real company, a real-looking person record from a well-known list, or a tool.
  assert.ok(!/Acme|Contoso|Globex|Initech|Microsoft|Google|Amazon/i.test(all));
  assert.equal(SAMPLES.x12.text.split('\n')[0].length, 106, 'the X12 sample ISA is exactly 106 characters');
});

test('the icon is a 128x128 PNG without metadata chunks', () => {
  const data = fs.readFileSync(path.join(root, 'media/icon.png'));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(data.readUInt32BE(16), 128);
  assert.equal(data.readUInt32BE(20), 128);
  const chunks = [];
  let pos = 8;
  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    chunks.push(data.toString('ascii', pos + 4, pos + 8));
    pos += 12 + length;
  }
  for (const c of chunks) assert.ok(['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS'].includes(c), 'unexpected chunk ' + c);
  assert.ok(data.length < 100 * 1024);
});

test('languages cover the specified extensions and are tied to grammars', () => {
  const byId = Object.fromEntries(contributes.languages.map((l) => [l.id, l]));
  assert.deepEqual(Object.keys(byId).sort(), [...OUR_LANGUAGES].sort());
  assert.deepEqual(byId.edifact.extensions, ['.edi', '.edifact', '.edf']);
  assert.deepEqual(byId.x12.extensions, ['.x12', '.x12edi']);
  assert.deepEqual(byId.hl7.extensions, ['.hl7']);
  for (const id of OUR_LANGUAGES) {
    const g = contributes.grammars.find((x) => x.language === id);
    assert.ok(g, id);
    assert.equal(g.scopeName, 'source.' + id);
    assert.equal(JSON.parse(read(g.path.slice(2))).scopeName, g.scopeName);
    new RegExp(byId[id].firstLine);
  }
});

test('first-line patterns recognise the three formats and nothing else', () => {
  const re = Object.fromEntries(contributes.languages.map((l) => [l.id, new RegExp(l.firstLine)]));
  assert.ok(re.edifact.test("UNA:+.? 'UNB+UNOC:3"));
  assert.ok(re.edifact.test('UNB+UNOC:3+A'));
  assert.ok(re.edifact.test('  UNH+1+ORDERS'));
  assert.ok(!re.edifact.test('UNBOUND text'));
  assert.ok(re.x12.test('ISA*00*   '));
  assert.ok(re.x12.test('ISA|00|'));
  assert.ok(!re.x12.test('ISAAC Newton'));
  assert.ok(re.hl7.test('MSH|^~\\&|A'));
  assert.ok(!re.hl7.test('MSHA|x'));
});

test('commands are namespaced, titled with the product prefix and unique', () => {
  const ids = contributes.commands.map((c) => c.command);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of contributes.commands) {
    assert.ok(c.command.startsWith('ediLens.'), c.command);
    assert.ok(c.title.startsWith('EDI Lens: '), c.title);
  }
  for (const pro of ['compare', 'exportJson', 'exportCsv', 'exportXml', 'validateWorkspace', 'loadDictionary', 'batchPrettyPrint']) {
    assert.ok(contributes.commands.find((c) => c.command === 'ediLens.' + pro).title.endsWith('(Pro)'), pro);
  }
  for (const free of ['prettyPrint', 'minify', 'goToSegment', 'copyPath', 'jumpToTrailer', 'detectFormat', 'buyPro', 'enterKey', 'licenceStatus', 'removeLicence',
    'openSampleEdifact', 'openSampleX12', 'openSampleHl7', 'openWalkthrough', 'showDocumentation', 'reportProblem']) {
    assert.ok(ids.includes('ediLens.' + free), free);
    assert.ok(!contributes.commands.find((c) => c.command === 'ediLens.' + free).title.endsWith('(Pro)'), free + ' is free');
  }
});

test('activation events list only the three languages (commands and views activate on their own since 1.74)', () => {
  assert.deepEqual([...pkg.activationEvents].sort(), OUR_LANGUAGES.map((l) => 'onLanguage:' + l).sort());
});

test('menus only reference real commands and restrict editor entries to our languages', () => {
  const ids = new Set(contributes.commands.map((c) => c.command));
  const submenuIds = new Set(contributes.submenus.map((s) => s.id));
  const langClause = OUR_LANGUAGES.map((l) => 'editorLangId == ' + l).join(' || ');
  for (const [menu, items] of Object.entries(contributes.menus)) {
    for (const item of items) {
      if (item.command) assert.ok(ids.has(item.command), menu + ': ' + item.command);
      if (item.submenu) assert.ok(submenuIds.has(item.submenu), item.submenu);
    }
  }
  for (const item of contributes.menus['editor/context']) assert.equal(item.when, langClause);
  for (const id of submenuIds) assert.ok(contributes.menus[id], 'submenu ' + id + ' has entries');
  const palette = Object.fromEntries(contributes.menus.commandPalette.map((i) => [i.command, i.when]));
  for (const hidden of ['ediLens.revealRange', 'ediLens.copyTreePath', 'ediLens.refreshTree', 'ediLens.revealQueryResult']) assert.equal(palette[hidden], 'false');
  for (const needsEditor of ['ediLens.prettyPrint', 'ediLens.minify', 'ediLens.compare', 'ediLens.exportJson']) assert.equal(palette[needsEditor], langClause);
  assert.deepEqual(contributes.keybindings, undefined, 'no keyboard shortcuts by default');
});

test('view, container and welcome content are wired together', () => {
  assert.equal(contributes.viewsContainers.activitybar[0].id, 'ediLens');
  assert.equal(contributes.views.ediLens[0].id, 'ediLens.outline');
  assert.equal(contributes.viewsWelcome[0].view, 'ediLens.outline');
  assert.match(contributes.viewsWelcome[0].contents, /command:ediLens\.detectFormat/);
});

test('every setting is documented, namespaced and read by the code', () => {
  const props = contributes.configuration.properties;
  for (const [key, def] of Object.entries(props)) {
    assert.ok(key.startsWith('ediLens.'), key);
    assert.ok(def.markdownDescription || def.description, key + ' needs a description');
    assert.notEqual(def.default, undefined, key + ' needs a default');
    assert.ok(def.type, key);
  }
  assert.equal(props['ediLens.validateOnType'].default, true);
  assert.equal(props['ediLens.maxFileSizeMB'].default, 10);
  assert.equal(props['ediLens.export.neutraliseFormulas'].default, true, 'CSV formula cells are neutralised by default');
  assert.match(props['ediLens.export.neutraliseFormulas'].markdownDescription, /tab or a carriage return/);
  assert.equal(props['ediLens.licenceMode'], undefined, 'the licence environment is not a setting');
  assert.ok(!Object.keys(props).some((k) => /mode|environment|server/i.test(k)), 'no setting selects a server or an environment');
  assert.equal(props['ediLens.anonymise.envelopeIds'].default, 'pseudonymise');
  assert.deepEqual(props['ediLens.anonymise.envelopeIds'].enum, ['pseudonymise', 'keep']);
  assert.equal(props['ediLens.anonymise.copyUnchanged'].default, false);

  const source = read('src/extension.js');
  const read_keys = [...source.matchAll(/c\.get\('([A-Za-z0-9.]+)'/g)].map((m) => 'ediLens.' + m[1]);
  assert.ok(read_keys.length >= 12);
  for (const key of read_keys) assert.ok(props[key], 'the code reads ' + key + ' which package.json does not declare');
  for (const key of Object.keys(props)) assert.ok(read_keys.includes(key), key + ' is declared but never read');

  // The README documents every setting.
  const readme = read('README.md');
  for (const key of Object.keys(props)) assert.ok(readme.includes('`' + key + '`'), key + ' is missing from the README');
});

test('README documents every command title', () => {
  const readme = read('README.md');
  for (const c of contributes.commands) {
    if (['ediLens.refreshTree', 'ediLens.copyTreePath', 'ediLens.revealRange', 'ediLens.revealQueryResult'].includes(c.command)) continue;
    const name = c.title.replace(/ \(Pro\)$/, '');
    const short = name.replace('EDI Lens: ', '');
    assert.ok(readme.includes(short), 'README does not mention "' + short + '"');
  }
});

test('shipped code has no console output and no external dependencies', () => {
  const builtins = new Set(require('node:module').builtinModules);
  for (const f of listFiles('src', []).filter((x) => x.endsWith('.js'))) {
    const text = read(f);
    assert.ok(!/\bconsole\./.test(text), f + ' uses console');
    for (const m of text.matchAll(/require\('([^']+)'\)/g)) {
      const name = m[1];
      const ok = name.startsWith('.') || name === 'vscode' || builtins.has(name) || builtins.has(name.replace(/^node:/, ''));
      assert.ok(ok, f + ' requires ' + name);
    }
  }
});

test('the editor-only parts load lazily: extension.js can be required with the core removed', () => {
  // The lazy loaders in format.js must not throw when a module is missing.
  const fmt = require('../src/format');
  assert.equal(fmt.loadModule('does-not-exist'), null);
});

test('the package script refuses to build with live mode and no buy link', () => {
  assert.match(pkg.scripts['vscode:prepublish'], /assertShippable/);
  assert.ok(!/scripts\//.test(pkg.scripts['vscode:prepublish']), 'packaging itself needs no file outside src');
  assert.equal(pkg.scripts.test, 'node --test');
});

test('grammars are valid JSON with compilable patterns', () => {
  function collect(node, out) {
    if (Array.isArray(node)) node.forEach((n) => collect(n, out));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'match' || k === 'begin' || k === 'end') && typeof v === 'string') out.push(v);
        else collect(v, out);
      }
    }
    return out;
  }
  for (const id of OUR_LANGUAGES) {
    const grammar = JSON.parse(read('syntaxes/' + id + '.tmLanguage.json'));
    const patterns = collect(grammar, []);
    assert.ok(patterns.length >= 6, id);
    for (const p of patterns) new RegExp(p);
    // Every include points at something that exists.
    const text = JSON.stringify(grammar);
    for (const m of text.matchAll(/"include":"#([a-z0-9-]+)"/g)) assert.ok(grammar.repository[m[1]], id + ': ' + m[1]);
  }
});

test('grammar patterns recognise the segment structure of sample lines', () => {
  const edifact = JSON.parse(read('syntaxes/edifact.tmLanguage.json')).repository;
  const segment = new RegExp(edifact.segment.begin);
  assert.ok(segment.test("UNH+1+ORDERS:D:96A:UN'"));
  assert.ok(segment.test("\nBGM+220'"));
  assert.ok(segment.test("UNZ+1+R'"));
  assert.ok(!segment.test('?'), 'a lone release character is no segment');
  const una = new RegExp(edifact['service-string-advice'].match);
  assert.ok(una.test("UNA:+.? '"));
  assert.ok(new RegExp(edifact.release.match).test("?'"));

  const x12 = JSON.parse(read('syntaxes/x12.tmLanguage.json')).repository;
  const x12seg = new RegExp(x12.segment.begin);
  assert.ok(x12seg.test('ISA*00*'));
  assert.ok(x12seg.test('~ST*850*0001~'));
  assert.ok(x12seg.test('N1*ST~'));

  const hl7 = JSON.parse(read('syntaxes/hl7.tmLanguage.json')).repository;
  assert.ok(new RegExp(hl7['msh-segment'].begin).test('MSH|^~\\&|A|B'));
  assert.ok(new RegExp(hl7.segment.begin).test('PID|1||123'));
  assert.ok(!new RegExp(hl7.segment.begin).test('  PID|1'));
  assert.ok(new RegExp(hl7.escape.match).test('text \\F\\ more'));
  assert.ok(new RegExp(hl7.timestamp.match).test('|20240115093000|'));
});

test('licence file and terms state what a buyer must know and promise nothing about refunds', () => {
  const text = read('LICENSE.txt');
  assert.match(text, /free features/i);
  assert.match(text, /paid licence key/i);
  assert.match(text, /redistribute/i);
  assert.match(text, /without warranty/i);
  assert.match(text, /no bundled third-party components/i);
  assert.match(text, /three computers/i);
  assert.match(text, /price you paid/i);
  assert.match(text, /merchant of record/i);
  const terms = read('TERMS.md');
  assert.match(terms, /merchant of record/i);
  assert.match(terms, /14-day/);
  assert.match(terms, /three computers/i);
  const everywhere = ['LICENSE.txt', 'TERMS.md', 'README.md', 'PRIVACY.md', 'CHANGELOG.md'].concat(listFiles('docs', []).filter((f) => /\.(md|json)$/.test(f)), listFiles('media/walkthrough', []));
  for (const f of everywhere) {
    const t = read(f);
    assert.ok(!/money.back|no refunds|refund guarantee|refund within|full refund|refunded within/i.test(t), f + ' makes a refund promise or a refund claim');
  }
  // The publisher is Small Steps Studio everywhere: no personal name, no personal site, no
  // personal mail address in any file of the extension or of its repository.
  assert.match(read('LICENSE.txt'), /Copyright \(c\) 2026 Small Steps Studio/);
  assert.match(read('LICENSE.txt'), /author of EDI Lens, Small Steps Studio/);
  const personal = new RegExp(['ima' + 'd', 'murat' + 'spahic', 'car' + 'rd', 'gma' + 'il'].join('|'), 'i');
  for (const f of everywhere.concat(['package.json'])) {
    assert.ok(!personal.test(read(f)), f + ' names a person, a personal site or a personal mail address');
  }
});

test('privacy statement, README and docs agree on the network use, the trial and the limits', () => {
  const privacy = read('PRIVACY.md');
  const readme = read('README.md');
  const licenceDoc = read('docs/licence.md');
  for (const t of [privacy, readme]) {
    assert.match(t, /VS Code on <platform>/);
    assert.match(t, /no telemetry/i);
    assert.match(t, /24 hours/);
    assert.match(t, /14 days/);
    assert.match(t, /14-day/);
  }
  assert.match(privacy, /trial/i);
  assert.match(privacy, /only on your computer|stays on your computer|recorded only on/i);
  assert.match(readme, /three computers/i);
  assert.match(readme, /USD 29/);
  assert.match(readme, /never expires|does not expire/i);
  assert.match(readme, /Remove Licence From This Machine/);
  assert.match(readme, /neutralise|apostrophe/i);
  assert.match(licenceDoc, /three computers/i);
  assert.match(licenceDoc, /14 days/);
  const config = require('../src/licence/config');
  assert.match(readme, new RegExp(config.trialDays + '-day'));
  assert.ok(readme.includes(config.issuesUrl));
  assert.ok(privacy.includes(config.issuesUrl));
});

test('development folders and files are kept out of the package', () => {
  const ignore = read('.vscodeignore').split(/\r?\n/).map((l) => l.trim());
  for (const entry of ['test/**', 'demo/**', 'SPEC.md', 'media/screenshots/**', '**/*.vsix', 'scripts/**', 'docs/**', '.github/**', 'PRE-RELEASE-CHECKLIST.md', 'RELEASE-NOTES-*.md', 'QA-*.md', 'STATUS*', '*NOTES*.md', '*-SPEC.md', '**/*.log']) {
    assert.ok(ignore.includes(entry), entry);
  }
  assert.ok(!ignore.includes('media/walkthrough/**'), 'the walkthrough media must ship');
});

test('the continuous integration workflow covers three operating systems and two Node versions', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) assert.ok(ci.includes(os), os);
  assert.match(ci, /node: \[20, 22\]/);
  assert.match(ci, /run: node --test/);
  assert.ok(!/publish|vsce|ovsx/.test(ci), 'the workflow neither packages nor publishes');
  // The workflow runs in the public repository: it must not need a file that is kept out of it.
  const ignored = read('.gitignore').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const entry of ignored) {
    const name = entry.replace(/\*+/g, '').replace(/\/$/, '');
    if (name.length >= 4) assert.ok(!ci.includes(name), 'the workflow refers to ' + entry + ', which is not in the repository');
  }
  assert.ok(!/scripts\//.test(ci) && !/npm (run|test)/.test(ci), 'the workflow calls node directly, no script of the package');
});

test('the unit tests need no file that is kept out of the public repository', () => {
  const ignored = read('.gitignore').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const entry of ['scripts/', 'test/smoke/', 'test/private.*.test.js', 'PRE-RELEASE-CHECKLIST.md', 'RELEASE-NOTES-*.md', 'QA-*.md', '/STATUS*', '*NOTES*.md', '*-SPEC.md', 'demo/', '*.vsix']) {
    assert.ok(ignored.includes(entry), entry + ' is missing from .gitignore');
  }
  const publicTests = fs.readdirSync(__dirname).filter((f) => /\.js$/.test(f) && !/^private\./.test(f)).map((f) => 'test/' + f)
    .concat(fs.readdirSync(path.join(__dirname, 'helpers')).map((f) => 'test/helpers/' + f));
  for (const f of publicTests) {
    const text = read(f);
    for (const m of text.matchAll(/require\('(\.[^']+)'\)/g)) {
      assert.ok(!/smoke|scripts|private\./.test(m[1]), f + ' requires ' + m[1] + ', which is not in the repository');
    }
    if (f === 'test/shell.package.test.js') continue;
    assert.ok(!/PRE-RELEASE-CHECKLIST|RELEASE-NOTES-|scripts\/(release-gate|check-vsix)|QA-AUDIT/.test(text), f + ' reads a file that is not in the repository');
  }
});
