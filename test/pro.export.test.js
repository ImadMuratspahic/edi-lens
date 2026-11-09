'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/core/parse.js');
const { toJSON } = require('../src/core/serialize.js');
const { toJsonText, toCsv, toXml, walk, csvField, xmlEscape } = require('../src/pro/export.js');
const { EDIFACT_ORDER, HL7_ADT, X12_PO, buildMessage, parseCsv, checkXml } = require('./fixtures/pro/samples.js');

const BOM = String.fromCharCode(0xfeff);
const FFFE = String.fromCharCode(0xfffe);
const REPLACEMENT = String.fromCharCode(0xfffd);

const EDI = parse(EDIFACT_ORDER);
const HL7 = parse(HL7_ADT);

/* ---------------------------------------------------------------- CSV */

test('csv: first row is the header and every line ends with CRLF', () => {
  const csv = toCsv(EDI);
  assert.ok(csv.startsWith('segment,occurrence,path,value\r\n'));
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(csv), 'found a bare line feed');
});

test('csv: rows carry segment, occurrence, path and value', () => {
  const rows = parseCsv(toCsv(EDI));
  const bgm = rows.find((r) => r[2] === 'BGM[1]-2.1');
  assert.deepEqual(bgm, ['BGM', '1', 'BGM[1]-2.1', 'PO-100']);
  const nad2 = rows.find((r) => r[2] === 'NAD[2]-2.1');
  assert.deepEqual(nad2, ['NAD', '2', 'NAD[2]-2.1', 'SELLER01']);
  assert.ok(rows.every((r) => r.length === 4));
});

test('csv: one row per component, empty components included', () => {
  const rows = parseCsv(toCsv(EDI));
  const nad = rows.filter((r) => r[0] === 'NAD' && r[1] === '1');
  assert.deepEqual(nad.map((r) => [r[2], r[3]]), [
    ['NAD[1]-1.1', 'BY'],
    ['NAD[1]-2.1', 'BUYER01'],
    ['NAD[1]-2.2', ''],
    ['NAD[1]-2.3', '9'],
  ]);
});

test('csv: every value in the message appears in order', () => {
  const rows = parseCsv(toCsv(EDI)).slice(1);
  const seen = [];
  walk(EDI, (v) => seen.push([v.segment, String(v.occurrence), v.path, v.value]));
  assert.deepEqual(rows, seen);
});

test('csv: fields with commas are quoted', () => {
  const m = buildMessage('hl7', [['ZZ1', ['a,b']]]);
  const csv = toCsv(m);
  assert.match(csv, /ZZ1\[1\]-1\.1,"a,b"\r\n/);
  assert.deepEqual(parseCsv(csv)[1], ['ZZ1', '1', 'ZZ1[1]-1.1', 'a,b']);
});

test('csv: double quotes are doubled and the field is quoted', () => {
  const m = buildMessage('hl7', [['ZZ1', ['say "hi"']]]);
  const csv = toCsv(m);
  assert.match(csv, /"say ""hi"""\r\n/);
  assert.equal(parseCsv(csv)[1][3], 'say "hi"');
});

test('csv: line breaks inside a value stay inside quotes', () => {
  const m = buildMessage('hl7', [['ZZ1', ['one\ntwo', 'three\r\nfour', 'five\rsix']]]);
  const rows = parseCsv(toCsv(m));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(1).map((r) => r[3]), ['one\ntwo', 'three\r\nfour', 'five\rsix']);
});

test('csv: a value with all the special characters round-trips', () => {
  const nasty = 'a,"b"\r\n,c';
  const rows = parseCsv(toCsv(buildMessage('hl7', [['ZZ1', [nasty]]])));
  assert.equal(rows[1][3], nasty);
});

test('csv: plain values are not quoted', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(''), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField('a b'), 'a b');
});

test('csv: repetitions and subcomponents have their own paths', () => {
  const rows = parseCsv(toCsv(HL7));
  const find = (p) => rows.find((r) => r[2] === p);
  assert.equal(find('PID[1]-3.1')[3], '1001');
  assert.equal(find('PID[1]-3(2).1')[3], '1002');
  assert.equal(find('PID[1]-3(2).4')[3], 'ALT');
  assert.equal(find('PID[1]-5.2.1')[3], 'Jane');
  assert.equal(find('PID[1]-5.2.2')[3], 'Q');
});

test('csv: a segment without elements still gets a row', () => {
  const rows = parseCsv(toCsv(buildMessage('hl7', [['ZZ1', []], ['ZZ1', ['x']]])));
  assert.deepEqual(rows[1], ['ZZ1', '1', 'ZZ1[1]', '']);
  assert.deepEqual(rows[2], ['ZZ1', '2', 'ZZ1[2]-1.1', 'x']);
});

test('csv: an empty message gives just the header', () => {
  assert.equal(toCsv(parse('')), 'segment,occurrence,path,value\r\n');
  assert.equal(toCsv(null), 'segment,occurrence,path,value\r\n');
});

test('csv: formulas are changed only when asked', () => {
  const m = buildMessage('hl7', [['ZZ1', ['=SUM(A1)', '+1', '-2', '@x', 'ok']]]);
  const plain = parseCsv(toCsv(m)).slice(1).map((r) => r[3]);
  assert.deepEqual(plain, ['=SUM(A1)', '+1', '-2', '@x', 'ok']);
  const safe = parseCsv(toCsv(m, { neutraliseFormulas: true })).slice(1).map((r) => r[3]);
  assert.deepEqual(safe, ["'=SUM(A1)", "'+1", "'-2", "'@x", 'ok']);
});

test('csv: a byte order mark is added only when asked', () => {
  assert.ok(!toCsv(EDI).startsWith(BOM));
  assert.ok(toCsv(EDI, { bom: true }).startsWith(BOM + 'segment,'));
});

test('csv: non-ASCII text is kept as it is', () => {
  const m = buildMessage('hl7', [['ZZ1', ['Müller 中文 \u{1F600}']]]);
  assert.equal(parseCsv(toCsv(m))[1][3], 'Müller 中文 \u{1F600}');
});

test('csv: X12 and HL7 messages export too', () => {
  const x12 = parseCsv(toCsv(parse(X12_PO)));
  assert.ok(x12.some((r) => r[2] === 'BEG[1]-3.1' && r[3] === 'PO12345'));
  const hl7 = parseCsv(toCsv(HL7));
  assert.ok(hl7.some((r) => r[2] === 'MSH[1]-9.2' && r[3] === 'A01'));
});

/* ---------------------------------------------------------------- XML */

test('xml: output of the sample messages is well formed', () => {
  [EDI, HL7, parse(X12_PO)].forEach((m) => {
    const checked = checkXml(toXml(m));
    assert.equal(checked.ok, true, checked.error);
  });
});

test('xml: starts with the declaration and has one root', () => {
  const xml = toXml(EDI);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<message format="edifact">\n'));
  assert.ok(xml.endsWith('</message>\n'));
});

test('xml: tag names follow s_ID, eNN and cNN', () => {
  const xml = toXml(EDI);
  assert.match(xml, /<s_NAD id="NAD" n="2">/);
  assert.match(xml, /<e02>/);
  assert.match(xml, /<c01>SELLER01<\/c01>/);
  assert.match(xml, /<c03>9<\/c03>/);
});

test('xml: the five special characters are escaped in text', () => {
  const m = buildMessage('hl7', [['ZZ1', ['a & b < c > d "e" \'f\'']]]);
  const xml = toXml(m);
  assert.match(xml, /<c01>a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;<\/c01>/);
  assert.equal(checkXml(xml).ok, true);
  assert.equal(checkXml(xml).root.children[0].children[0].children[0].text, 'a & b < c > d "e" \'f\'');
});

test('xml: markup in a value cannot add elements', () => {
  const m = buildMessage('hl7', [['ZZ1', ['</c01><injected/>']]]);
  const checked = checkXml(toXml(m));
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.root.children[0].children.length, 1);
  assert.ok(!toXml(m).includes('<injected/>'));
});

test('xml: repetitions repeat the element tag with a rep attribute', () => {
  const xml = toXml(HL7);
  const checked = checkXml(xml);
  assert.equal(checked.ok, true, checked.error);
  const pid = checked.root.children.find((s) => s.name === 's_PID');
  const e03 = pid.children.filter((e) => e.name === 'e03');
  assert.equal(e03.length, 2);
  assert.equal(e03[0].attrs.rep, undefined);
  assert.equal(e03[1].attrs.rep, '2');
});

test('xml: subcomponents get their own tags', () => {
  const checked = checkXml(toXml(HL7));
  const pid = checked.root.children.find((s) => s.name === 's_PID');
  const e05 = pid.children.find((e) => e.name === 'e05');
  const c02 = e05.children.find((c) => c.name === 'c02');
  assert.deepEqual(c02.children.map((u) => [u.name, u.text]), [['u01', 'Jane'], ['u02', 'Q']]);
});

test('xml: element numbers of 10 and above are not truncated', () => {
  const els = [];
  for (let i = 1; i <= 12; i += 1) {
    els.push('v' + i);
  }
  const xml = toXml(buildMessage('hl7', [['ZZ1', els]]));
  assert.match(xml, /<e09>/);
  assert.match(xml, /<e12>/);
  assert.equal(checkXml(xml).ok, true);
});

test('xml: unusual segment ids still give valid tag names and keep the id', () => {
  const m = buildMessage('hl7', [['A/B C', ['x']], ['', ['y']], ['9XY', ['z']]]);
  const checked = checkXml(toXml(m));
  assert.equal(checked.ok, true, checked.error);
  assert.deepEqual(checked.root.children.map((s) => s.name), ['s_A_B_C', 's__', 's_9XY']);
  assert.equal(checked.root.children[0].attrs.id, 'A/B C');
});

test('xml: characters that XML forbids are replaced', () => {
  const m = buildMessage('hl7', [['ZZ1', ['a\u0000b\u0007c\u001fd' + FFFE + 'e\uD800f', 'ok\ttab']]]);
  const xml = toXml(m);
  const checked = checkXml(xml);
  assert.equal(checked.ok, true, checked.error);
  const comps = checked.root.children[0].children;
  assert.equal(comps[0].children[0].text, ['a', 'b', 'c', 'd', 'e', 'f'].join(REPLACEMENT));
  assert.equal(comps[1].children[0].text, 'ok\ttab');
});

test('xml: valid surrogate pairs and carriage returns survive', () => {
  const m = buildMessage('hl7', [['ZZ1', ['\u{1F600}', 'a\rb']]]);
  const checked = checkXml(toXml(m));
  assert.equal(checked.ok, true, checked.error);
  const comps = checked.root.children[0].children;
  assert.equal(comps[0].children[0].text, '\u{1F600}');
  assert.equal(comps[1].children[0].text, 'a\rb');
});

test('xml: the text of every component matches the message', () => {
  const checked = checkXml(toXml(EDI));
  const found = [];
  checked.root.children.forEach((s) => s.children.forEach((e) => e.children.forEach((c) => found.push(c.text))));
  const expected = [];
  walk(EDI, (v) => {
    if (v.element !== undefined) {
      expected.push(v.value);
    }
  });
  assert.deepEqual(found, expected);
});

test('xml: an empty message is a single empty root', () => {
  const xml = toXml(parse(''));
  assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?>\n<message format="edifact"/>\n'.replace('edifact', parse('').format));
  assert.equal(checkXml(xml).ok, true);
});

test('xml: a segment without elements is an empty tag', () => {
  const xml = toXml(buildMessage('hl7', [['ZZ1', []]]));
  assert.match(xml, /<s_ZZ1 id="ZZ1" n="1"\/>/);
  assert.equal(checkXml(xml).ok, true);
});

test('xml: the checker used here really rejects bad XML', () => {
  assert.equal(checkXml('<a>1 & 2</a>').ok, false);
  assert.equal(checkXml('<a><b></a>').ok, false);
  assert.equal(checkXml('<a/><b/>').ok, false);
  assert.equal(checkXml('<a>1 < 2</a>').ok, false);
  assert.equal(checkXml('<a x=1/>').ok, false);
  assert.equal(checkXml('<a>1 &amp; 2</a>').ok, true);
});

test('xml: xmlEscape handles non-string input', () => {
  assert.equal(xmlEscape(null), '');
  assert.equal(xmlEscape(7), '7');
});

/* --------------------------------------------------------------- JSON */

test('json: compact output is one line and parses back', () => {
  const text = toJsonText(EDI);
  assert.ok(!text.includes('\n'));
  const data = JSON.parse(text);
  assert.equal(data.format, 'edifact');
  assert.equal(data.segments.length, EDI.segments.length);
});

test('json: pretty output is indented and has no trailing line break', () => {
  const text = toJsonText(EDI, { pretty: true });
  assert.match(text, /\n {2}"format": "edifact"/);
  assert.ok(!text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), JSON.parse(toJsonText(EDI)));
});

test('json: simple elements are strings and composite elements are arrays', () => {
  const data = JSON.parse(toJsonText(EDI));
  const nad = data.segments.find((s) => s.id === 'NAD');
  assert.deepEqual(nad.elements, ['BY', ['BUYER01', '', '9']]);
  const bgm = data.segments.find((s) => s.id === 'BGM');
  assert.deepEqual(bgm.elements, ['220', 'PO-100', '9']);
});

test('json: repetitions and subcomponents are nested arrays', () => {
  const data = JSON.parse(toJsonText(HL7));
  const pid = data.segments.find((s) => s.id === 'PID');
  assert.deepEqual(pid.elements[2], { repetitions: [['1001', '', '', 'HOSP'], ['1002', '', '', 'ALT']] });
  assert.deepEqual(pid.elements[4], ['Doe', ['Jane', 'Q'], 'M']);
  assert.equal(pid.elements[1], '');
});

test('json: delimiters are included and the output matches the core serializer', () => {
  const data = JSON.parse(toJsonText(EDI));
  assert.equal(typeof data.delimiters, 'object');
  assert.deepEqual(data, JSON.parse(JSON.stringify(toJSON(EDI))));
  assert.equal(data.segments.filter((s) => s.id === 'LIN').length, 2);
});

test('json: unescape removes release characters when asked', () => {
  const m = parse("UNH+1+A?+B'");
  const raw = JSON.parse(toJsonText(m)).segments[0].elements[1];
  const plain = JSON.parse(toJsonText(m, { unescape: true })).segments[0].elements[1];
  assert.equal(raw, 'A?+B');
  assert.equal(plain, 'A+B');
});

test('json: an empty message exports an empty segment list', () => {
  const data = JSON.parse(toJsonText(parse('')));
  assert.deepEqual(data.segments, []);
  assert.doesNotThrow(() => toJsonText(null));
});

test('export: the message is not modified', () => {
  const copy = structuredClone(EDI);
  toJsonText(EDI, { pretty: true });
  toCsv(EDI);
  toXml(EDI);
  assert.deepEqual(EDI, copy);
});

test('export: files with line breaks between segments export the same values', () => {
  const pretty = parse(EDIFACT_ORDER.replace(/'/g, "'\r\n"));
  assert.equal(toCsv(pretty), toCsv(EDI));
  assert.equal(toXml(pretty), toXml(EDI));
});
