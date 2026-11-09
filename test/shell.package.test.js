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
  assert.equal(pkg.name, 'edi-lens');
  assert.equal(pkg.displayName, 'EDI Lens');
  assert.equal(pkg.publisher, 'ImadMuratspahic');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.engines.vscode, '^1.82.0');
  assert.equal(pkg.license, 'SEE LICENSE IN LICENSE.txt');
  assert.equal(pkg.icon, 'media/icon.png');
  assert.equal(pkg.main, './src/extension.js');
  assert.equal(pkg.homepage, 'https://imadmuratspahic-dev.carrd.co');
  assert.equal(pkg.repository.url, 'https://github.com/ImadMuratspahic/edi-lens');
  assert.ok(pkg.bugs && pkg.bugs.url);
  assert.deepEqual(pkg.categories, ['Formatters', 'Linters', 'Visualization', 'Other']);
  assert.ok(pkg.keywords.length >= 5);
  assert.ok(pkg.galleryBanner.color && pkg.galleryBanner.theme);
  assert.ok(pkg.description.length > 20 && pkg.description.length <= 200);
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, true);
  assert.equal(pkg.capabilities.virtualWorkspaces.supported, 'limited');
  assert.ok(pkg.capabilities.virtualWorkspaces.description);
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(pkg.devDependencies, undefined);
});

test('every file the manifest points to exists', () => {
  const files = [pkg.icon, pkg.main, 'language-configuration.json', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'PRIVACY.md', '.vscodeignore'];
  for (const l of contributes.languages) files.push(l.configuration);
  for (const g of contributes.grammars) files.push(g.path);
  for (const c of contributes.viewsContainers.activitybar) files.push(c.icon);
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f + ' is missing');
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
  for (const free of ['prettyPrint', 'minify', 'goToSegment', 'copyPath', 'jumpToTrailer', 'detectFormat', 'buyPro', 'enterKey', 'licenceStatus', 'removeLicence']) {
    assert.ok(ids.includes('ediLens.' + free), free);
  }
});

test('activation events reference real commands and the three languages', () => {
  const ids = new Set(contributes.commands.map((c) => c.command));
  for (const e of pkg.activationEvents) {
    if (e.startsWith('onCommand:')) assert.ok(ids.has(e.slice('onCommand:'.length)), e);
  }
  for (const id of OUR_LANGUAGES) assert.ok(pkg.activationEvents.includes('onLanguage:' + id), id);
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
  for (const hidden of ['ediLens.revealRange', 'ediLens.copyTreePath', 'ediLens.refreshTree']) assert.equal(palette[hidden], 'false');
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
  assert.equal(props['ediLens.licenceMode'].default, 'test');
  assert.deepEqual(props['ediLens.licenceMode'].enum, ['test', 'live']);
  assert.equal(props['ediLens.licenceMode'].scope, 'application');

  const source = read('src/extension.js');
  const read_keys = [...source.matchAll(/c\.get\('([A-Za-z.]+)'/g)].map((m) => 'ediLens.' + m[1]);
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
    if (['ediLens.refreshTree', 'ediLens.copyTreePath', 'ediLens.revealRange'].includes(c.command)) continue;
    const name = c.title.replace(/ \(Pro\)$/, '');
    const short = name.replace('EDI Lens: ', '');
    assert.ok(readme.includes(short), 'README does not mention "' + short + '"');
  }
});

test('shipped text carries no tool, model or generator wording', () => {
  const shipped = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE.txt', 'PRIVACY.md', 'language-configuration.json', 'media/activity.svg']
    .concat(listFiles('src', []), listFiles('syntaxes', []));
  // The words are assembled from fragments so that this list is not itself a hit in a text search.
  const words = [['a', 'i'], ['a.', 'i.'], ['artificial', ' intelligence'], ['l', 'lm'], ['chat', 'gpt'], ['g', 'pt'], ['cla', 'ude'],
    ['anthro', 'pic'], ['open', 'ai'], ['co', 'pilot'], ['assis', 'tant'], ['prom', 'pts?'], ['gener', 'ated by'], ['gener', 'ator'], ['language', ' model']]
    .map((p) => p[0].replace(/\./g, '\\.') + p[1].replace(/\./g, '\\.'));
  const banned = new RegExp('\\b(' + words.join('|') + ')\\b', 'i');
  for (const f of shipped) {
    const text = read(f);
    const m = banned.exec(text);
    assert.equal(m, null, f + ' contains "' + (m && m[0]) + '"');
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

test('licence file states the terms the task requires', () => {
  const text = read('LICENSE.txt');
  assert.match(text, /free features/i);
  assert.match(text, /paid licence key/i);
  assert.match(text, /redistribute/i);
  assert.match(text, /without warranty/i);
  assert.match(text, /no bundled third-party components/i);
});

test('privacy statement and README agree on the single network call', () => {
  const privacy = read('PRIVACY.md');
  const readme = read('README.md');
  assert.match(privacy, /VS Code on <platform>/);
  assert.match(readme, /VS Code on <platform>/);
  assert.match(privacy, /no telemetry/i);
  assert.match(readme, /no telemetry/i);
  assert.match(privacy, /24 hours/);
  assert.match(privacy, /14 days/);
  assert.match(readme, /24 hours/);
  assert.match(readme, /14 days/);
});

test('development folders and files are kept out of the package', () => {
  const ignore = read('.vscodeignore').split(/\r?\n/).map((l) => l.trim());
  for (const entry of ['test/**', 'demo/**', 'SPEC.md', 'media/screenshots/**', '**/*.vsix']) {
    assert.ok(ignore.includes(entry), entry);
  }
});
