'use strict';

/*
 * Adversarial tests for the Pro modules: comparison (diff), export,
 * dictionaries and the workspace report. They check ignore rules, escaping
 * against hostile content, purity (inputs are never changed) and behaviour on
 * damaged or unusual objects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/core/parse.js');
const { toJSON } = require('../src/core/serialize.js');
const { compare, toText, toHtml, escapeHtml } = require('../src/pro/diff.js');
const { toJsonText, toCsv, toXml, walk, csvField, xmlEscape } = require('../src/pro/export.js');
const { loadDictionary, describe, limits } = require('../src/pro/dictionary.js');
const { scanFiles, toMarkdown, escapeMarkdown, lineStarts, positionAt } = require('../src/pro/workspace.js');
const kit = require('./helpers/attack-kit.js');

/** Freezes an object and everything inside it. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.keys(value).forEach((k) => deepFreeze(value[k]));
  }
  return value;
}

const wrap = (body) => "UNB+UNOA:1+S+R+200101:1200+1'UNH+1+X'" + body + "UNT+3+1'UNZ+1+1'";

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('diff: ignorePaths accepts every spelling of a path and covers everything below it', () => {
  const a = parse(wrap("NAD+BY+123:A:9+x*y'NAD+SU+456'"));
  const b = parse(wrap("NAD+BY+999:A:9+x*z'NAD+SU+456'"));
  assert.equal(compare(a, b).summary.changed, 1);
  for (const pattern of ['NAD[1]-2.1', 'NAD-2.1', 'nad[1]-2.1', ' NAD[1]-2.1 ', 'NAD[1]-2(1).1', 'NAD-2(1).1', 'NAD[1]-2*', 'NAD-2*', 'NAD[1]-2', 'NAD-2', 'NAD[1]', 'NAD', 'NAD*', '*-2.1', '*']) {
    const r = compare(a, b, { ignorePaths: [pattern, 'NAD[1]-3'] });
    assert.ok(r.identical, 'pattern ' + JSON.stringify(pattern));
  }
  const partly = compare(a, b, { ignorePaths: ['NAD[1]-2.1'] });
  assert.ok(!partly.identical, 'the change in element 3 is not ignored');
  assert.equal(partly.segments.find((e) => e.status === 'changed').differences.length, 1);
  assert.equal(compare(a, b, { ignorePaths: ['NAD[2]-2.1', 'NAD[1]-1', 'NAD[1]-2.2', 'NAD[1]-4'] }).summary.changed, 1);
});

test('diff: ignore patterns that contain regular expression characters are plain text', () => {
  const a = parse(wrap("NAD+BY+1'"));
  const b = parse(wrap("NAD+BY+2'"));
  for (const pattern of ['NAD.+', '(NAD)', 'NAD|DTM', '^NAD$', 'NAD\\-2', 'NAD[1]-2{1}', '[', '(', '\\', '?', '+', '.*+?^${}()|[]\\']) {
    const r = compare(a, b, { ignorePaths: [pattern] });
    assert.equal(r.identical, false, 'pattern ' + JSON.stringify(pattern) + ' must not match');
  }
  assert.ok(compare(a, b, { ignorePaths: ['NAD[1]-2(1)'] }).identical, 'an explicit first repetition is accepted');
});

test('diff: ignoreSegments is case blind and does not renumber the other segments', () => {
  const a = parse(wrap("DTM+1'NAD+BY+1'DTM+2'NAD+SU+2'"));
  const b = parse(wrap("NAD+BY+1'DTM+9'NAD+SU+2'"));
  const r = compare(a, b, { ignoreSegments: ['dtm', ' UNB ', '', 5, null] });
  assert.ok(!r.segments.some((e) => e.id === 'DTM'));
  const nads = r.segments.filter((e) => e.id === 'NAD');
  assert.deepEqual(nads.map((e) => e.a.path), ['NAD[1]', 'NAD[2]']);
  assert.ok(r.segments.some((e) => e.id === 'UNH'), 'only the listed ids are dropped');
  assert.ok(!r.segments.some((e) => e.id === 'UNB'));
});

test('diff: unrelated option values are ignored instead of failing', () => {
  const a = parse(wrap("NAD+BY+1'"));
  for (const opts of [undefined, null, {}, { ignorePaths: 'x', ignoreSegments: 5 }, { ignorePaths: [null, 5, {}, ''], ignoreCase: 'yes', trimValues: 1 }]) {
    assert.ok(compare(a, parse(a.text), opts).identical);
  }
});

test('diff: a moved segment is reported as removed and added with the moved flag', () => {
  const a = parse(wrap("DTM+1'NAD+BY+1'LIN+7'"));
  const b = parse(wrap("NAD+BY+1'LIN+7'DTM+1'"));
  const r = compare(a, b);
  assert.equal(r.summary.changed, 0);
  assert.equal(r.summary.added, 1);
  assert.equal(r.summary.removed, 1);
  assert.ok(r.segments.filter((e) => e.moved).length === 2);
  assert.ok(toText(r).includes('[moved]'));
});

test('diff: a trailing empty element on one side is not a difference, a trailing value is', () => {
  const a = parse(wrap("NAD+BY+1'"));
  assert.ok(compare(a, parse(wrap("NAD+BY+1+'"))).identical);
  assert.ok(compare(a, parse(wrap("NAD+BY+1+++'"))).identical);
  const r = compare(a, parse(wrap("NAD+BY+1+x'")));
  assert.equal(r.summary.changed, 1);
  assert.deepEqual(r.segments.find((e) => e.status === 'changed').differences.map((d) => [d.kind, d.a, d.b]), [['added', null, 'x']]);
  const back = compare(parse(wrap("NAD+BY+1+x'")), a);
  assert.deepEqual(back.segments.find((e) => e.status === 'changed').differences.map((d) => [d.kind, d.a, d.b]), [['removed', 'x', null]]);
});

test('diff: repetitions, components and HL7 subcomponents get their own paths', () => {
  const a = parse('MSH|^~\\&|A\rPID|1|a&b^c~d^e&f');
  const b = parse('MSH|^~\\&|A\rPID|1|a&B^c~d^e&g~h');
  const r = compare(a, b);
  const paths = r.segments.find((e) => e.status === 'changed').differences.map((d) => d.path + '=' + d.a + '>' + d.b);
  assert.deepEqual(paths, ['PID[1]-2.1.2=b>B', 'PID[1]-2(2).2.2=f>g', 'PID[1]-2(3).1=null>h']);
});

test('diff: two empty messages, an empty and a full one, and messages of different formats', () => {
  const empty = parse('');
  assert.ok(compare(empty, empty).identical);
  const full = parse(wrap("NAD+BY'"));
  const r = compare(empty, full);
  assert.equal(r.summary.added, full.segments.length);
  assert.equal(r.summary.removed, 0);
  assert.equal(compare(full, empty).summary.removed, full.segments.length);
  const mixed = compare(full, parse('MSH|^~\\&|A\rPID|1'));
  assert.equal(mixed.summary.added + mixed.summary.removed, full.segments.length + 2);
});

test('diff: damaged message objects do not throw', () => {
  const objs = [null, undefined, {}, { segments: null }, { segments: [] }, { segments: [{ id: 'X' }] }, { segments: [{ id: 5, elements: 'x' }] }, { segments: [{ id: 'X', elements: [{ repetitions: null }, null].slice(0, 1) }] }];
  for (const a of objs) {
    for (const b of objs) {
      const r = compare(a, b);
      assert.equal(typeof r.identical, 'boolean');
      assert.ok(typeof toText(r) === 'string' && typeof toHtml(r) === 'string');
    }
  }
});

test('diff: comparing and exporting never change the messages', () => {
  const a = deepFreeze(parse(wrap("NAD+BY+1:2'DTM+7'")));
  const b = deepFreeze(parse(wrap("NAD+BY+1:3'LIN+7'")));
  const before = JSON.stringify([a, b]);
  const r = compare(a, b, { ignorePaths: ['DTM*'], ignoreCase: true, trimValues: true });
  toText(r);
  toHtml(r);
  toCsv(a);
  toXml(a);
  toJsonText(a, { pretty: true, unescape: true });
  toJSON(a, { unescape: true });
  walk(a, () => {});
  assert.equal(JSON.stringify([a, b]), before);
});

test('diff: the HTML report escapes everything that comes from the messages and the options', () => {
  const evil = "<script>alert(1)</script>";
  const a = parse("UNB+UNOA:1+" + evil + "+\"onload=x+R+1'UNZ+0+1'");
  const b = parse("UNB+UNOA:1+<img src=x onerror=1>+&amp;+R+1'UNZ+0+1'");
  const html = toHtml(compare(a, b), { labelA: '<b>A</b>', labelB: '"B"', title: '</title><script>x</script>' });
  const body = html.replace(/<style>[\s\S]*<\/style>/, '');
  assert.ok(!/<script/i.test(body));
  assert.ok(!/<img/i.test(body));
  assert.ok(!/<b>/.test(body));
  assert.ok(!/onerror=1>/.test(body));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(!/<(a|img|link|iframe|object|embed|form|input|base|meta\s+http-equiv="refresh")\b/i.test(body.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')), 'no external resources');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(5), '5');
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

test('diff: segment ids and values with markup, quotes and astral characters survive the text report unchanged', () => {
  const smile = String.fromCodePoint(0x1f600);
  const a = parse(wrap("NAD+<b>+" + smile + "'"));
  const b = parse(wrap("NAD+<b>+" + smile + smile + "'"));
  const text = toText(compare(a, b), { labelA: 'left', labelB: 'right' });
  assert.ok(text.includes('Compared left with right'));
  assert.ok(text.includes(JSON.stringify(smile)));
  assert.ok(text.includes(JSON.stringify(smile + smile)));
});

test('diff: toText and toHtml options', () => {
  const a = parse(wrap("NAD+BY'"));
  const same = compare(a, a);
  assert.ok(toText(same).includes('The messages are identical.'));
  assert.ok(!toText(same).includes('= UNB[1]'));
  assert.ok(toText(same, { showUnchanged: true }).includes('= UNB[1]'));
  assert.ok(!toHtml(same, { showUnchanged: false }).includes('<td class="status">Same'));
  assert.ok(toHtml(same).includes('Same'));
  const stripped = toHtml(same, {});
  assert.ok(stripped.startsWith('<!DOCTYPE html>'));
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test('export: csvField follows RFC 4180 for every awkward value', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(''), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField(12), '12');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField('cr\rbreak'), '"cr\rbreak"');
  assert.equal(csvField('  padded  '), '  padded  ');
  assert.equal(csvField('"'), '""""');
  assert.equal(csvField(',,,'), '",,,"');
  assert.equal(csvField('=1+1', true), "'=1+1");
  assert.equal(csvField('=1+1', false), '=1+1');
  assert.equal(csvField('+1,2', true), '"\'+1,2"');
  assert.equal(csvField('safe', true), 'safe');
});

test('export: CSV of a message with awkward values reads back to exactly the values', () => {
  const smile = String.fromCodePoint(0x1f600);
  const m = parse("UNB+UNOA:1+A+B+1'FTX+\"q\"+a,b+?'c+x" + String.fromCharCode(13) + "y+" + smile + "+" + kit.NUL + "'UNZ+0+1'");
  const rows = kit.readCsv(toCsv(m));
  assert.deepEqual(rows.slice(1), kit.expectedCsvRows(m));
  const values = rows.map((r) => r[3]);
  assert.ok(values.includes('"q"') && values.includes('a,b') && values.includes("?'c") && values.includes('x\ry') && values.includes(smile));
});

test('export: XML names stay valid for unusual segment ids and large element numbers', () => {
  const smile = String.fromCodePoint(0x1f600);
  // The fourth segment has no id and 121 elements, the last of them holding "z".
  const text = "UNB+UNOA:1+A+B+1'A B+x'" + smile + "+x'1ab+x'" + '+'.repeat(121) + "z'UNZ+0+1'";
  const m = parse(text);
  const root = kit.readXml(toXml(m));
  assert.equal(root.children.length, m.segments.length);
  for (const node of root.children) assert.ok(/^s_[A-Za-z0-9_.-]*$/.test(node.name), node.name);
  const wide = root.children[root.children.length - 2];
  assert.equal(wide.attrs.id, '');
  assert.equal(wide.children.length, 121);
  assert.equal(wide.children[120].name, 'e121', 'element numbers above 99 get three digits');
  assert.equal(wide.children[98].name, 'e99');
  assert.ok(root.children.some((c) => c.attrs.id === 'A B'));
  assert.ok(root.children.some((c) => c.attrs.id === smile));
});

test('export: XML escapes markup and replaces characters XML 1.0 cannot hold', () => {
  const bad = [0, 1, 8, 11, 12, 14, 31, 0xfffe, 0xffff].map((c) => String.fromCharCode(c)).join('');
  const lone = String.fromCharCode(0xd800) + 'x' + String.fromCharCode(0xdc00);
  const text = "UNB+UNOA:1+A+B+1'FTX+<a href=\"x\">&amp;]]>'</a>+" + bad + '+' + lone + "'UNZ+0+1'";
  const m = parse(text.replace("'</a>", '?\'</a>'));
  const xml = toXml(m);
  const root = kit.readXml(xml);
  const leaves = [];
  (function collect(n) {
    if (n.children.length === 0) leaves.push(n.text);
    else n.children.forEach(collect);
  })(root.children[1]);
  assert.ok(leaves.includes('<a href="x">&amp;]]>?\'</a>'));
  assert.ok(leaves.includes(kit.REPLACEMENT.repeat(bad.length)));
  assert.ok(leaves.includes(kit.REPLACEMENT + 'x' + kit.REPLACEMENT));
  assert.equal(xmlEscape("a&b<c>d\"e'f\r\tg"), 'a&amp;b&lt;c&gt;d&quot;e&apos;f&#13;&#9;g');
});

test('export: tabs, carriage returns and line breaks in XML values survive a round trip', () => {
  const m = parse("UNB+UNOA:1+A+B+1'FTX+a\tb\rc\nd'UNZ+0+1'");
  const root = kit.readXml(toXml(m));
  const leaf = root.children[1].children[0].children[0];
  assert.equal(leaf.text, 'a\tb\rc\nd');
});

test('export: a message with no segments, and format names with markup', () => {
  assert.equal(toXml(parse('')), '<?xml version="1.0" encoding="UTF-8"?>\n<message format="edifact"/>\n');
  assert.equal(toCsv(parse('')), 'segment,occurrence,path,value\r\n');
  assert.equal(JSON.parse(toJsonText(parse(''))).segments.length, 0);
  const forged = { format: '<"&>', segments: [] };
  assert.equal(kit.readXml(toXml(forged)).attrs.format, '<"&>');
  for (const bad of [null, undefined, 5, 'x', {}, { segments: 'x' }]) {
    assert.equal(typeof toXml(bad), 'string');
    assert.equal(typeof toCsv(bad), 'string');
    assert.equal(typeof toJsonText(bad), 'string');
  }
});

test('export: JSON text honours pretty and unescape and never ends with a line break', () => {
  const m = parse("UNB+UNOA:1+A+B+1'FTX+It?'s+1?+1'UNZ+0+1'");
  assert.ok(!toJsonText(m).includes('\n'));
  assert.ok(toJsonText(m, { pretty: true }).includes('\n  '));
  assert.ok(!toJsonText(m, { pretty: true }).endsWith('\n'));
  assert.equal(JSON.parse(toJsonText(m, { unescape: true })).segments[1].elements[0], "It's");
  assert.equal(JSON.parse(toJsonText(m)).segments[1].elements[0], "It?'s");
});

test('export: walk reports every value once, in file order, with the path the report uses', () => {
  const m = parse('MSH|^~\\&|A\rPID|1|a&b^c~d|');
  const seen = [];
  walk(m, (v) => seen.push(v.path + '=' + v.value));
  assert.deepEqual(seen, [
    'MSH[1]-1.1=|', 'MSH[1]-2.1=^~\\&', 'MSH[1]-3.1=A',
    'PID[1]-1.1=1', 'PID[1]-2.1.1=a', 'PID[1]-2.1.2=b', 'PID[1]-2.2=c', 'PID[1]-2(2).1=d', 'PID[1]-3.1=',
  ]);
});

// ---------------------------------------------------------------------------
// dictionary
// ---------------------------------------------------------------------------

/** A small correct dictionary as JSON text. */
function dictText(patch) {
  const base = { format: 'edifact', name: 'Test', segments: { BGM: { name: 'Beginning', elements: { 1: { name: 'Doc', components: { 1: 'Code' }, values: { 220: 'Order' } } } } } };
  return JSON.stringify(Object.assign(base, patch));
}

test('dictionary: keys that would pollute prototypes or clash with built-in names are rejected or harmless', () => {
  const polluted = '{"format":"edifact","name":"x","segments":{"__proto__":{"name":"evil"},"BGM":{"elements":{"1":{"values":{"__proto__":"x","constructor":"c","toString":"t"}}}}}}';
  const r = loadDictionary(polluted);
  assert.equal(r.ok, false);
  assert.equal({}.name, undefined, 'Object.prototype was not changed');
  assert.equal(({}).evil, undefined);
  const ok = loadDictionary('{"format":"hl7","name":"x","segments":{"PID":{"elements":{"1":{"values":{"constructor":"c","toString":"t","hasOwnProperty":"h"}}}}}}');
  assert.equal(ok.ok, true);
  assert.equal(describe(ok.dictionary, 'PID', 1, 1, 'constructor').valueName, 'c');
  assert.equal(describe(ok.dictionary, 'PID', 1, 1, 'valueOf').valueName, undefined);
  assert.deepEqual(describe(ok.dictionary, '__proto__', 1), {});
  assert.deepEqual(describe(ok.dictionary, 'constructor', 1), {});
  assert.deepEqual(describe(ok.dictionary, 'toString'), {});
});

test('dictionary: describe tolerates every odd argument', () => {
  const dict = loadDictionary(dictText()).dictionary;
  assert.deepEqual(describe(dict, 'bgm', 1, 1, ' 220 '), { segmentName: 'Beginning', elementName: 'Doc', componentName: 'Code', valueName: 'Order' });
  assert.deepEqual(describe(dict, 'BGM', '1', '1', 220), { segmentName: 'Beginning', elementName: 'Doc', componentName: 'Code', valueName: 'Order' });
  for (const args of [[null], [undefined], [{}], [dict, null], [dict, 5], [dict, 'XXX'], [dict, 'BGM', 0], [dict, 'BGM', -1], [dict, 'BGM', 1.5], [dict, 'BGM', '01'], [dict, 'BGM', '1e0'], [dict, 'BGM', 99999], [dict, 'BGM', NaN], [dict, 'BGM', 1, 0], [dict, 'BGM', 1, 5, null]]) {
    const out = describe(...args);
    assert.equal(typeof out, 'object');
  }
  assert.deepEqual(describe(dict, 'BGM', 0), { segmentName: 'Beginning' });
  assert.deepEqual(describe(dict, 'BGM', 1, 5, null), { segmentName: 'Beginning', elementName: 'Doc' });
  assert.deepEqual(describe({ segments: null }, 'BGM'), {});
});

test('dictionary: structure errors give readable messages and never throw', () => {
  const bad = [
    '', ' ', 'null', '[]', '5', '"x"', '{', '{"format":"edifact"}', '{"format":"EDIFACT","name":"x","segments":{}}', '{"format":"x12","segments":{}}',
    '{"format":"x12","name":"","segments":{}}', '{"format":"x12","name":5,"segments":{}}', '{"format":"x12","name":"x","segments":[]}',
    '{"format":"x12","name":"x","segments":{"A":{}}}', '{"format":"x12","name":"x","segments":{"ABCD":{}}}', '{"format":"x12","name":"x","segments":{"1AB":{}}}',
    '{"format":"x12","name":"x","segments":{"AB":5}}', '{"format":"x12","name":"x","segments":{"AB":{"elements":5}}}',
    '{"format":"x12","name":"x","segments":{"AB":{"elements":{"0":{}}}}}', '{"format":"x12","name":"x","segments":{"AB":{"elements":{"10000":{}}}}}',
    '{"format":"x12","name":"x","segments":{"AB":{"elements":{"1":{"components":{"x":"y"}}}}}}', '{"format":"x12","name":"x","segments":{"AB":{"elements":{"1":{"values":{"":"y"}}}}}}',
    '{"format":"x12","name":"x","segments":{"AB":{"elements":{"1":{"values":{"a":5}}}}}}', '{"format":"x12","name":"x","segments":{"AB":{},"ab":{}}}',
  ];
  for (const text of bad) {
    const r = loadDictionary(text);
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e === 'string' && e.length > 5), JSON.stringify(text));
  }
  for (const text of [undefined, null, 5, {}, []]) assert.equal(loadDictionary(text).ok, false);
});

test('dictionary: the size limits hold', () => {
  assert.equal(loadDictionary(' '.repeat(limits.maxTextLength + 1)).ok, false);
  const many = {};
  for (let i = 0; i < limits.maxSegments + 1; i++) many['S' + String(i).padStart(2, '0') + String.fromCharCode(65 + (i % 26))] = {};
  assert.equal(loadDictionary(JSON.stringify({ format: 'hl7', name: 'x', segments: many })).ok, false);
  const longName = 'x'.repeat(limits.maxNameLength + 1);
  assert.equal(loadDictionary(dictText({ name: longName })).ok, false);
  const faults = {};
  for (let i = 1; i <= 120; i++) faults[i] = 5;
  const r = loadDictionary(dictText({ segments: { BGM: { elements: faults } } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.length <= 51, 'the error list is capped');
});

test('dictionary: a byte order mark, unknown keys and unicode names are fine', () => {
  const r = loadDictionary(kit.BOM + dictText({ extra: 1, name: 'Wörterbuch ' + String.fromCodePoint(0x1f600) }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length > 0);
  assert.equal(r.dictionary.name, 'Wörterbuch ' + String.fromCodePoint(0x1f600));
  assert.equal(describe(r.dictionary, 'BGM', 1, undefined, '220').valueName, 'Order');
});

// ---------------------------------------------------------------------------
// workspace report
// ---------------------------------------------------------------------------

/** An in-memory file system for scanFiles. */
function memoryAdapter(files, extra) {
  const ids = Object.keys(files);
  return Object.assign({
    findFiles: async (glob, exclude, max) => ids.slice(0, max),
    stat: async (id) => ({ size: Buffer.byteLength(files[id]) }),
    readText: async (id) => files[id],
    label: (id) => id,
  }, extra || {});
}

test('workspace: hostile file names and messages cannot create links, markup or table cells in the report', async () => {
  const evilName = '[click](javascript:alert(1))|<script>x</script>`tick`\nnext line# heading';
  const files = {};
  files[evilName] = "UNB+UNOA:1+A+B+1'UNZ+5+9'";
  files['ok.edi'] = "UNB+UNOA:1+A+B+1'UNZ+0+1'";
  const summary = await scanFiles(memoryAdapter(files), {});
  const md = toMarkdown(summary, { title: '<b>x</b> [t](u)' });
  assert.ok(!/(^|[^\\])[<>`]/m.test(md), 'every angle bracket and backtick is escaped');
  assert.ok(!/(^|[^\\])\]\(/m.test(md), 'a link can only start with an unescaped bracket');
  assert.ok(!/(^|[^\\])\[/m.test(md.replace(/\| ---[^\n]*/g, '')), 'no unescaped opening bracket');
  let inIssueTable = false;
  let rows = 0;
  for (const line of md.split('\n')) {
    if (line.startsWith('| Line |')) inIssueTable = true;
    else if (!line.startsWith('|')) inIssueTable = false;
    if (inIssueTable) {
      rows++;
      const cells = line.replace(/\\\|/g, '').split('|').length - 2;
      assert.equal(cells, 5, 'table row has the wrong number of cells: ' + line);
    }
  }
  assert.ok(rows >= 6, 'the issue tables were checked');
  assert.equal(escapeMarkdown('a\nb\r\nc\rd'), 'a b c d');
  assert.equal(escapeMarkdown(undefined), '');
  assert.equal(escapeMarkdown(String.fromCharCode(0, 1, 7, 8) + 'x'), 'x');
});

test('workspace: a scan survives adapters that return duplicates, odd sizes and unreadable files', async () => {
  const files = { 'a.edi': "UNB+UNOA:1+A+B+1'UNZ+0+1'", 'b.edi': 'not an edi file', 'c.edi': '', 'd.edi': "UNB+UNOA:1+A+B+1'UNZ+0+1'" };
  const adapter = memoryAdapter(files, {
    findFiles: async () => ['d.edi', 'a.edi', 'b.edi', 'c.edi', 'a.edi', 'd.edi', 'missing.edi'],
    stat: async (id) => {
      if (id === 'missing.edi') throw new Error('gone');
      return { size: id === 'd.edi' ? undefined : Buffer.byteLength(files[id]) };
    },
  });
  const s = await scanFiles(adapter, {});
  assert.deepEqual(s.files.map((f) => f.path), ['a.edi', 'b.edi', 'c.edi', 'd.edi', 'missing.edi']);
  assert.deepEqual(s.files.map((f) => f.status), ['ok', 'skipped', 'skipped', 'ok', 'failed']);
  assert.equal(s.totals.scanned, 2);
  assert.equal(s.totals.skipped, 2);
  assert.equal(s.totals.failed, 1);
  assert.ok(toMarkdown(s).includes('Files that could not be read | 1'));
});

test('workspace: a file that is not text, not a string or huge is contained', async () => {
  const adapter = {
    findFiles: async () => ['n.edi', 'o.edi', 'p.edi'],
    stat: async () => ({ size: 10 }),
    readText: async (id) => (id === 'n.edi' ? null : id === 'o.edi' ? 12345 : "UNB+UNOA:1+A+B+1'\u0000\u0000UNZ+0+1'"),
  };
  const s = await scanFiles(adapter, {});
  assert.deepEqual(s.files.map((f) => f.status), ['failed', 'failed', 'ok']);
});

test('workspace: line and column of an issue follow CR, LF and CRLF exactly', async () => {
  const text = "UNB+UNOA:1+A+B+1'\rUNH+1+X'\r\nNAD+BY'\nUNT+9+1'\n\rUNZ+1+1'";
  const s = await scanFiles(memoryAdapter({ 'x.edi': text }), {});
  const issue = s.files[0].issues.find((i) => i.code === 'EDIFACT-UNT-COUNT');
  const expectedLine = text.slice(0, issue.offset).split(/\r\n|\r|\n/).length;
  assert.equal(issue.line, expectedLine);
  assert.equal(issue.column, issue.offset - Math.max(text.lastIndexOf('\n', issue.offset - 1), text.lastIndexOf('\r', issue.offset - 1)));
  assert.deepEqual(lineStarts('a\r\nb\rc\nd'), [0, 3, 5, 7]);
  assert.deepEqual(lineStarts(''), [0]);
  const starts = lineStarts('ab\ncd');
  assert.deepEqual(positionAt(starts, 0), { line: 0, character: 0 });
  assert.deepEqual(positionAt(starts, 2), { line: 0, character: 2 });
  assert.deepEqual(positionAt(starts, 3), { line: 1, character: 0 });
  assert.deepEqual(positionAt(starts, 99), { line: 1, character: 96 });
});

test('workspace: cancellation between files keeps what was scanned and marks the result', async () => {
  const files = {};
  for (let i = 0; i < 10; i++) files['f' + i + '.edi'] = "UNB+UNOA:1+A+B+1'UNZ+0+1'";
  let calls = 0;
  const s = await scanFiles(memoryAdapter(files), {}, { isCancelled: () => ++calls > 4 });
  assert.equal(s.cancelled, true);
  assert.ok(s.files.length > 0 && s.files.length < 10);
  assert.ok(toMarkdown(s).includes('cancelled'));
});
