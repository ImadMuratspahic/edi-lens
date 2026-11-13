'use strict';
// The documentation of the Pro tools and the two licence types: the example files do what the
// pages say, the JSON schemas agree with the loaders, every problem code is documented, and the
// one sentence about Business keys is the same everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const anon = require('../src/pro/anonymise');
const rules = require('../src/pro/rules');
const query = require('../src/pro/query');
const env = require('../src/pro/envelope');
const config = require('../src/licence/config');
const { parse } = require('../src/core/parse');
const { validate } = require('../src/core/validate');
const pkg = require('../package.json');

const MESSAGES = { edifact: 'docs/examples/messages/orders-three.edi', x12: 'docs/examples/messages/po-two.x12', hl7: 'docs/examples/messages/adt-two.hl7' };
const issues = (text) => validate(parse(text), { includeParseIssues: true }).map((i) => i.code);
const units = (text, q) => { const r = query.scanText(text, query.compile(q)); return r.matches.map((m) => m.unit); };

// The fenced code blocks of a Markdown text with the given language ('' for a fence without one).
function codeBlocks(text, lang) {
  const out = [];
  let open = null;
  for (const line of text.split('\n')) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence && open === null) open = { lang: fence[1], lines: [] };
    else if (fence) { if (open.lang === lang) out.push(open.lines.join('\n') + '\n'); open = null; } else if (open) open.lines.push(line);
  }
  return out;
}

test('examples: the sample messages are valid, use invented data and have the shape the pages describe', () => {
  for (const [format, rel] of Object.entries(MESSAGES)) {
    const text = read(rel);
    assert.ok(!/\r/.test(text), rel + ' uses LF line ends');
    assert.equal(parse(text).format, format);
    assert.deepEqual(issues(text), [], rel);
    assert.ok(!/Acme|Contoso|Globex|Initech|Microsoft|Google|Amazon/i.test(text));
  }
  assert.equal(read(MESSAGES.x12).split('\n')[0].length, 106);
  assert.equal(env.split(read(MESSAGES.edifact)).parts.length, 3);
  assert.equal(env.split(read(MESSAGES.x12)).parts.length, 2);
  assert.equal(env.split(read(MESSAGES.hl7)).parts.length, 2);
  // E-mail addresses use a reserved name that can never exist.
  for (const m of Object.values(MESSAGES).map(read).join('\n').matchAll(/[\w.]+@([\w.-]+)/g)) assert.match(m[1], /\.(example|invalid)$/, m[0]);
});

test('examples: the partner rule files load and give exactly the violations the pages name', () => {
  const load = (rel) => { const r = rules.loadRules(read(rel)); assert.equal(r.ok, true, rel + ': ' + JSON.stringify(r.errors)); return r.guide; };
  const orders = rules.validateText(read(MESSAGES.edifact), load('docs/examples/rules-edifact-orders.json'));
  assert.deepEqual([orders.units, orders.unitsChecked], [3, 3]);
  assert.deepEqual(orders.violations.map((v) => v.ruleId + '#' + v.unit).sort(), ['PW-01#3', 'PW-02#3', 'PW-03#3', 'PW-04#3', 'PW-07#3'], 'the third order breaks five rules, the first two none');
  assert.equal(orders.violations.find((v) => v.ruleId === 'PW-01').message, '[PW-01] The delivery party (NAD+DP) is missing.');
  const po = rules.validateText(read(MESSAGES.x12), load('docs/examples/rules-x12-850.json'));
  assert.deepEqual(po.violations.map((v) => v.ruleId + '#' + v.unit + ' ' + v.severity).sort(), ['PO-05#2 warning', 'PO-09#2 warning']);
  const adt = rules.validateText(read(MESSAGES.hl7), load('docs/examples/rules-hl7-adt.json'));
  assert.deepEqual([adt.unitsChecked, adt.violations.length], [2, 0]);
  // The README example and the one in the docs page load as well.
  for (const page of ['README.md', 'docs/partner-rules.md']) {
    const blocks = codeBlocks(read(page), 'json').filter((b) => /"rules"/.test(b) && /"format": "(edifact|x12|hl7)",/.test(b) && /"type"/.test(b));
    assert.ok(blocks.length >= 1, page);
    for (const b of blocks) assert.equal(rules.loadRules(b).ok, true, page + ': ' + JSON.stringify(rules.loadRules(b).errors));
  }
  for (const m of read('docs/partner-rules.md').matchAll(/^\{ "id": [^\n]+\}$/gm)) {
    assert.equal(rules.loadRules(JSON.stringify({ format: 'edifact', rules: [JSON.parse(m[0])] })).ok, true, m[0]);
  }
});

test('examples: the queries of the example page and of the README find what the text says', () => {
  const orders = read(MESSAGES.edifact);
  assert.deepEqual(units(orders, 'count(LIN) > 2'), [2]);
  assert.deepEqual(units(orders, 'MOA[86]-1.2 > 500'), [1, 2]);
  assert.deepEqual(units(orders, 'NOT exists(NAD[DP])'), [3]);
  for (const page of ['README.md', 'docs/query.md', 'media/walkthrough/pro-tools.md']) {
    const blocks = codeBlocks(read(page), '');
    let lines = 0;
    for (const b of blocks) for (const line of b.split('\n').filter((l) => l.trim())) {
      lines++;
      assert.equal(query.compile(line).ok, true, page + ': ' + line + ' -> ' + query.compile(line).message);
    }
    assert.ok(lines >= 1, page + ' shows at least one query');
  }
  // Every query in the table of docs/query.md compiles ("a or b" cells hold two).
  const table = [...read('docs/query.md').matchAll(/^\| [^|`]+ \| (`[^\n]+`) \|$/gm)].map((m) => m[1]);
  assert.ok(table.length >= 8);
  for (const cell of table) for (const q of cell.split(' or `').map((x) => x.replace(/`/g, '').replace(/\\\|/g, '|'))) assert.equal(query.compile(q).ok, true, q + ' -> ' + query.compile(q).message);
  // The selectors listed in the selector tables are selectors.
  const { parseSelector } = require('../src/pro/shared');
  for (const page of ['README.md', 'docs/query.md']) {
    const section = read(page).split(/^#+ Selectors.*$/m)[1].split(/^#+ /m)[0];
    const cells = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1].replace(/\\\|/g, '|'));
    assert.ok(cells.length >= 7, page);
    for (const s of cells) assert.equal(parseSelector(s).ok, true, page + ': ' + s);
  }
});

test('examples: the anonymise rule file loads, and the copy keeps the two messages of one patient consistent', () => {
  const loaded = anon.loadRules(read('docs/examples/anonymise.json'));
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
  const compiled = anon.compile(loaded.config, []);
  for (const rel of Object.values(MESSAGES)) {
    const text = read(rel);
    const r = anon.anonymiseText(text, compiled, { seed: 'docs' });
    assert.equal(r.ok, true, rel);
    assert.equal(r.text.length, text.length);
    assert.deepEqual(issues(r.text), [], rel);
    assert.ok(r.report.changed >= 8, rel + ': ' + r.report.changed);
  }
  const adt = anon.anonymiseText(read(MESSAGES.hl7), compiled, { seed: 'docs' }).text;
  for (const gone of ['Varga', 'Elin', 'Tibor', 'NF-5503187', '19790321', 'Orchard Rise', 'Kestrel Bay', 'Lindqvist', '555-0171']) assert.ok(!adt.includes(gone), gone);
  const pids = adt.split('\n').filter((l) => l.startsWith('PID')).map((l) => l.split('|').slice(3, 8).join('|'));
  assert.equal(pids[0], pids[1], 'both messages show the same patient after anonymising');
  assert.ok(adt.includes('|F|') && adt.includes('^OR^'), 'what the rules keep is kept');
  for (const page of ['README.md', 'docs/anonymise.md']) {
    const blocks = codeBlocks(read(page), 'json').filter((b) => /"action"/.test(b));
    assert.ok(blocks.length >= 1, page);
    for (const b of blocks) assert.equal(anon.loadRules(b).ok, true, page);
  }
  // The examples in the action table of docs/anonymise.md are what the code does.
  const rw = anon.createRewriter('s1');
  const ctx = { format: 'hl7', release: '', escape: '\\', fixedWidth: false };
  assert.equal(rw.rewrite('mask', 'RS-4471902', ctx).value, 'XX-9999999');
  assert.match(read('docs/anonymise.md'), /`RS-4471902` becomes `XX-9999999`/);
  assert.match(rw.rewrite('pseudonym', 'RS-4471902', ctx).value, /^[A-Z]{2}-\d{7}$/);
  assert.match(rw.rewrite('fake-date', '19840712', ctx).value, /^198[34]\d{4}$/);
  // The table of protected values is the table in the code.
  const doc = read('docs/anonymise.md');
  for (const id of ['UNA', 'UNH', 'UNT', 'UNE', 'UNZ', 'ST', 'SE', 'GE', 'IEA', 'BTS', 'FTS']) assert.ok(doc.includes('`' + id + '`'), id);
  assert.deepEqual(anon.PROTECTED.x12.ISA, [1, 3, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16], 'every ISA element except 2, 4, 6 and 8');
  assert.deepEqual(anon.PROTECTED.x12.GS, [1, 6, 7, 8]);
  assert.deepEqual(anon.PROTECTED.hl7.MSH, [1, 2, 9, 10, 11, 12]);
  assert.deepEqual(anon.PROTECTED.edifact.UNB, [1, 5]);
});

test('docs: every problem code of the Pro tools is documented, and no page lists a code that does not exist', () => {
  const pages = { 'docs/anonymise.md': [anon.CODES, 'ANON'], 'docs/partner-rules.md': [rules.CODES, 'RULES'], 'docs/query.md': [query.CODES, 'QUERY'], 'docs/envelope-tools.md': [env.CODES, 'ENV'] };
  for (const [page, [codes, prefix]] of Object.entries(pages)) {
    const text = read(page);
    for (const code of Object.values(codes)) {
      assert.match(code, new RegExp('^' + prefix + '-[A-Z-]+$'));
      assert.ok(text.includes('`' + code + '`'), page + ' does not document ' + code);
    }
    for (const m of text.matchAll(new RegExp('`(' + prefix + '-[A-Z-]+)`', 'g'))) assert.ok(Object.values(codes).includes(m[1]), page + ' documents ' + m[1] + ', which does not exist');
    assert.match(text, /Pro feature/);
    assert.match(text, /14-day trial/);
  }
});

test('docs: the JSON schemas are valid, are contributed for the rule files and agree with the loaders', () => {
  assert.deepEqual(pkg.contributes.jsonValidation.map((v) => v.url), ['./schemas/rules.schema.json', './schemas/anonymise.schema.json']);
  for (const v of pkg.contributes.jsonValidation) {
    assert.ok(v.fileMatch.some((p) => p.startsWith('**/.edilens/')), JSON.stringify(v.fileMatch));
    const schema = JSON.parse(read(v.url.slice(2)));
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(schema.type, 'object');
    // Every regular expression in a schema compiles.
    JSON.stringify(schema, (key, value) => { if (key === 'pattern' && typeof value === 'string' && value.startsWith('^')) new RegExp(value); return value; });
  }
  const rulesSchema = JSON.parse(read('schemas/rules.schema.json'));
  const types = rulesSchema.definitions.simpleRule.properties.type.enum.concat(['condition', 'equal']);
  for (const type of types) assert.ok(rules.CODES[type], 'the schema offers the rule type ' + type + ', which the loader does not know');
  assert.deepEqual(rulesSchema.properties.format.enum, ['edifact', 'x12', 'hl7']);
  const anonSchema = JSON.parse(read('schemas/anonymise.schema.json'));
  assert.deepEqual(anonSchema.properties.rules.items.properties.action.enum, anon.ACTIONS);
  assert.equal(anonSchema.properties.rules.items.properties.action.enumDescriptions.length, anon.ACTIONS.length);
  assert.deepEqual(anonSchema.properties.profiles.items.enum.slice().sort(), Object.keys(anon.PROFILES).sort());
  assert.deepEqual(pkg.contributes.configuration.properties['ediLens.anonymise.profiles'].items.enum.slice().sort(), Object.keys(anon.PROFILES).sort());
  // The selector patterns of the schemas accept the selectors of the example files and refuse a path where a segment is wanted.
  const seg = new RegExp(rulesSchema.definitions.segmentSelector.pattern);
  const pathRe = new RegExp(rulesSchema.definitions.pathSelector.pattern);
  for (const rel of ['docs/examples/rules-edifact-orders.json', 'docs/examples/rules-x12-850.json', 'docs/examples/rules-hl7-adt.json']) {
    for (const rule of JSON.parse(read(rel)).rules) {
      if (rule.segment) assert.match(rule.segment, seg, rel);
      if (rule.path) assert.match(rule.path, pathRe, rel);
      if (rule.within) assert.match(rule.within, seg, rel);
    }
  }
  assert.ok(!seg.test('NAD-2') && !pathRe.test('NAD') && pathRe.test('PID-13(2).1') && seg.test('OBX[3.1=2345-7]'));
  const anonPath = new RegExp(anonSchema.properties.rules.items.properties.path.pattern);
  for (const rule of JSON.parse(read('docs/examples/anonymise.json')).rules) assert.match(rule.path, anonPath);
});

test('docs: the sentence about Business keys is one sentence, the same in every text that sells or explains the licence', () => {
  const sentence = config.businessSeatsText;
  assert.equal(sentence, 'One key per user: set the number of users with the Buy command, or add ?quantity=N to the checkout link.');
  for (const rel of ['README.md', 'TERMS.md', 'LICENSE.txt', 'docs/licence.md', 'CHANGELOG.md']) {
    assert.ok(read(rel).replace(/\s+/g, ' ').includes(sentence), rel + ' does not carry the sentence about Business keys');
  }
  const readme = read('README.md');
  assert.ok(readme.split('## For IT and procurement')[1].split('\n## ')[0].includes(sentence), 'the IT and procurement section carries it too');
  // Nowhere does a text say that the number of users is chosen on the checkout page.
  for (const rel of ['README.md', 'TERMS.md', 'LICENSE.txt', 'PRIVACY.md', 'docs/licence.md', 'CHANGELOG.md', 'media/walkthrough/pro.md', 'src/licence/messages.js']) {
    const text = read(rel);
    assert.ok(!/(choose|chosen|select|set|change|enter)[^.\n]{0,60}(quantity|number of users)[^.\n]{0,40}(at|on) (the )?checkout(?! link)/i.test(text), rel + ' says the quantity is chosen at checkout');
  }
});

test('docs: prices, licence types and the procurement facts agree between README, terms, licence text and the code', () => {
  const readme = read('README.md');
  for (const rel of ['README.md', 'TERMS.md', 'docs/licence.md', 'media/walkthrough/pro.md']) {
    const text = read(rel);
    assert.match(text, /USD 29/, rel);
    assert.match(text, /USD 59 per user/, rel);
    assert.match(text, /Personal/, rel);
    assert.match(text, /Business/, rel);
  }
  assert.equal(config.priceText, 'USD 29');
  assert.equal(config.businessPriceText, 'USD 59 per user');
  assert.equal(config.activationLimit, 3);
  const it = readme.split('## For IT and procurement')[1].split('\n## ')[0];
  for (const fact of ['publisher Small Steps Studio', '`SmallStepsStudio.edi-lens-viewer`', '`live.dodopayments.com`', 'No telemetry', config.repositoryUrl, 'PRIVACY.md', 'purchase orders', 'questionnaires', 'three computers']) assert.ok(it.includes(fact), 'the IT and procurement section lacks: ' + fact);
  assert.ok(it.includes(config.checkoutBaseLive + config.products.live.business + '?quantity=N'));
  assert.equal(new URL(config.apiBaseLive).host, 'live.dodopayments.com');
  assert.match(readme, /Can we pay by purchase order[\s\S]{0,400}not offered/);
  const licence = read('LICENSE.txt');
  for (const fact of [/Personal licence\./, /Business licence\./, /up to three computers/, /move a key to another of its users/, /Remove Licence From This Machine/, /resell/]) assert.match(licence.replace(/\s+/g, ' '), fact);
  const terms = read('TERMS.md');
  for (const fact of [/Pro Personal/, /Pro Business/, /three computers/, /moved to a colleague/, /reselling/, /Purchase orders/]) assert.match(terms, fact);
  const privacy = read('PRIVACY.md');
  assert.match(privacy, /Not stored:[\s\S]{0,200}buyer's name, e-mail address/);
  assert.match(privacy, /id of the product/);
  assert.match(privacy, /Export Pseudonym Map/);
  // Nothing that was free in 0.1.1 is now a Pro command.
  for (const id of ['detectFormat', 'prettyPrint', 'minify', 'goToSegment', 'copyPath', 'jumpToTrailer', 'validateFile', 'unloadDictionary', 'clearWorkspaceResults', 'buyPro', 'enterKey', 'licenceStatus', 'removeLicence']) {
    assert.ok(!/\(Pro\)$/.test(pkg.contributes.commands.find((c) => c.command === 'ediLens.' + id).title), id);
  }
});

test('docs: the README shows the new tools with screenshots that exist, and the tier table lists them', () => {
  const readme = read('README.md');
  for (const shot of ['anonymise-pro', 'partner-rules-pro', 'query-pro', 'acknowledgement-pro', 'split-pro']) {
    assert.ok(readme.includes('](media/screenshots/' + shot + '.png)'), shot);
    const file = path.join(root, 'media', 'screenshots', shot + '.png');
    assert.ok(fs.existsSync(file), shot + '.png is missing');
    const data = fs.readFileSync(file);
    assert.deepEqual([...data.subarray(0, 4)], [137, 80, 78, 71], shot + ' is a PNG');
    assert.ok(data.length > 20000 && data.length < 1500000, shot + ' has a plausible size: ' + data.length);
  }
  const table = readme.split('## Free, trial and Pro')[1].split('\n## ')[0];
  for (const row of ['Anonymise Message and Anonymise Folder', 'Partner rules', 'Query', 'Envelope tools']) assert.match(table, new RegExp('\\| ' + row + '[^|]*\\| \\| yes \\| yes \\|'), row);
  for (const heading of ['### Anonymise Message and Anonymise Folder (Pro)', '### Partner rules (Pro)', '### Query (Pro)', '### Envelope tools (Pro)', '## Pricing', '## For IT and procurement']) assert.ok(readme.includes('\n' + heading + '\n'), heading);
  for (const page of ['docs/anonymise.md', 'docs/partner-rules.md', 'docs/query.md', 'docs/envelope-tools.md', 'docs/examples/README.md']) {
    assert.ok(fs.existsSync(path.join(root, page)), page);
    assert.ok(read(page).length > 1500, page);
  }
  // Every relative link of the README and the docs pages points at a file that exists.
  for (const page of ['README.md', 'docs/anonymise.md', 'docs/partner-rules.md', 'docs/query.md', 'docs/envelope-tools.md', 'docs/getting-started.md', 'docs/licence.md', 'docs/troubleshooting.md', 'docs/examples/README.md']) {
    for (const m of read(page).matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^(https?:|command:|mailto:)/.test(m[1])) continue;
      assert.ok(fs.existsSync(path.join(root, path.dirname(page), m[1])), page + ' links to ' + m[1] + ', which does not exist');
    }
  }
});
