'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/core/parse');
const { pretty, minify, toJSON, unescapeValue } = require('../src/core/serialize');
const { fixture, fixtureNames, checkInvariants } = require('./core.helpers');

test('serialize: pretty puts one segment per line, keeps UNA first and the terminators', () => {
  const message = parse(fixture('invoic-d01b-single-line.edi'));
  const text = pretty(message);
  const lines = text.split('\n');
  assert.equal(lines.length, 19);
  assert.ok(lines.every((line) => line.endsWith("'")));
  assert.ok(lines[0].startsWith('UNB+'));

  const withUna = pretty(parse(fixture('orders-d96a.edi')));
  assert.ok(withUna.startsWith("UNA:+.? '\nUNB+"));
  assert.ok(withUna.endsWith("UNZ+1+ORD0000101'"));
});

test('serialize: pretty uses LF only and has no blank lines, also for CRLF input', () => {
  const text = pretty(parse(fixture('x12-856-asn-crlf.x12')));
  assert.ok(!text.includes('\r'));
  assert.ok(!text.includes('\n\n'));
  assert.equal(text.split('\n').length, 19);
});

test('serialize: pretty for HL7 separates segments with line breaks and does not touch the content', () => {
  const message = parse(fixture('hl7-oru-r01.hl7'));
  const text = pretty(message);
  assert.equal(text.split('\n').length, 7);
  assert.ok(text.includes('Positive&Strong&Marked'));
  const fromCr = pretty(parse(fixture('hl7-adt-a01-cr.hl7')));
  assert.equal(fromCr, pretty(parse(fixture('hl7-adt-a01.hl7'))));
});

test('serialize: pretty keeps an unterminated last segment unterminated', () => {
  const message = parse("UNB+A+B'UNZ+1+1");
  assert.equal(pretty(message), "UNB+A+B'\nUNZ+1+1");
});

test('serialize: pretty does not double the line break when the terminator is a newline', () => {
  const message = parse(fixture('x12-214-newline.x12'));
  const text = pretty(message);
  assert.ok(!text.includes('\n\n'));
  assert.equal(text.split('\n').length, 10);
  assert.deepEqual(parse(text).segments.map((s) => s.raw), message.segments.map((s) => s.raw));
});

test('serialize: pretty accepts a different line ending', () => {
  const text = pretty(parse(fixture('orders-d96a.edi')), { eol: '\r\n' });
  assert.ok(text.includes("'\r\nUNB+"));
});

test('serialize: minify removes line breaks between EDIFACT and X12 segments', () => {
  const edifact = minify(parse(fixture('orders-d96a.edi')));
  assert.ok(!/[\r\n]/.test(edifact));
  assert.ok(edifact.startsWith("UNA:+.? 'UNB+"));
  assert.ok(edifact.endsWith("UNZ+1+ORD0000101'"));
  const x12 = minify(parse(fixture('x12-850-po.x12')));
  assert.ok(!/[\r\n]/.test(x12));
  assert.equal(x12.length, 106 + x12.slice(106).length);
  assert.ok(x12.includes('~GS*PO*'));
});

test('serialize: minify keeps CR between HL7 segments', () => {
  const text = minify(parse(fixture('hl7-adt-a01.hl7')));
  assert.ok(!text.includes('\n'));
  assert.equal(text.split('\r').length - 1, 5);
  assert.ok(text.startsWith('MSH|^~\\&|REGADT'));
});

test('serialize: pretty and minify are idempotent for every fixture', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    const once = pretty(message);
    const twice = pretty(parse(once));
    assert.equal(twice, once, 'pretty ' + name);
    const small = minify(message);
    assert.equal(minify(parse(small)), small, 'minify ' + name);
  }
});

test('serialize: pretty and minify keep every segment and every value', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    const raws = message.segments.map((s) => s.raw);
    for (const text of [pretty(message), minify(message)]) {
      const again = parse(text);
      assert.deepEqual(again.issues, [], name);
      assert.deepEqual(again.segments.map((s) => s.raw), raws, name);
      assert.deepEqual(again.delimiters.element || again.delimiters.field, message.delimiters.element || message.delimiters.field);
      checkInvariants(again);
    }
  }
});

test('serialize: minify of the pretty text equals minify of the original', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    assert.equal(minify(parse(pretty(message))), minify(message), name);
  }
});

test('serialize: toJSON writes simple elements as strings and composites as arrays', () => {
  const json = toJSON(parse(fixture('orders-d96a.edi')));
  assert.equal(json.format, 'edifact');
  assert.equal(json.delimiters.element, '+');
  const bgm = json.segments.find((s) => s.id === 'BGM');
  assert.deepEqual(bgm.elements, ['220', 'PO-100234', '9']);
  const dtm = json.segments.find((s) => s.id === 'DTM');
  assert.deepEqual(dtm.elements, [['137', '20240115', '102']]);
  const lin = json.segments.find((s) => s.id === 'LIN');
  assert.deepEqual(lin.elements, ['1', '', ['4000000000015', 'EN']]);
});

test('serialize: toJSON writes repetitions and subcomponents as documented', () => {
  const json = toJSON(parse(fixture('hl7-oru-r01.hl7')));
  const pid = json.segments.find((s) => s.id === 'PID');
  assert.deepEqual(pid.elements[2], {
    repetitions: [
      ['100200300', '', '', 'GENHOSP', 'MR'],
      ['900800700', '', '', 'NATID', 'NI'],
    ],
  });
  const obx = json.segments.filter((s) => s.id === 'OBX')[2];
  assert.deepEqual(obx.elements[4], ['POS', ['Positive', 'Strong', 'Marked'], 'L']);
  const msh = json.segments[0];
  assert.equal(msh.elements[0], '|');
  assert.deepEqual(msh.elements[8], ['ORU', 'R01', 'ORU_R01']);
});

test('serialize: toJSON is plain, stable and survives JSON.stringify', () => {
  for (const name of fixtureNames()) {
    const message = parse(fixture(name));
    const a = JSON.stringify(toJSON(message));
    const b = JSON.stringify(toJSON(parse(message.text)));
    assert.equal(a, b, name);
    assert.deepEqual(JSON.parse(a), toJSON(message));
  }
});

test('serialize: toJSON can remove release characters and escape sequences', () => {
  const edifact = toJSON(parse(fixture('release-chars.edi')), { unescape: true });
  const bgm = edifact.segments.find((s) => s.id === 'BGM');
  assert.equal(bgm.elements[1], "PO-'77");
  const raw = toJSON(parse(fixture('release-chars.edi')));
  assert.equal(raw.segments.find((s) => s.id === 'BGM').elements[1], "PO-?'77");
  const hl7 = toJSON(parse(fixture('hl7-oru-r01.hl7')), { unescape: true });
  const obx = hl7.segments.filter((s) => s.id === 'OBX')[1];
  assert.equal(obx.elements[4], 'Sample haemolysed\\.br\\recheck advised | pipe');
});

test('serialize: unescapeValue handles each format', () => {
  const edifact = parse("UNB+A'");
  assert.equal(unescapeValue(edifact, 'a?+b?:c??d'), 'a+b:c?d');
  assert.equal(unescapeValue(edifact, 'plain'), 'plain');
  assert.equal(unescapeValue(edifact, 'end?'), 'end?');
  const hl7 = parse('MSH|^~\\&|A\r');
  assert.equal(unescapeValue(hl7, 'a\\F\\b\\S\\c\\T\\d\\R\\e\\E\\f'), 'a|b^c&d~e\\f');
  assert.equal(unescapeValue(hl7, 'x\\.br\\y'), 'x\\.br\\y');
  assert.equal(unescapeValue(hl7, 'open\\F'), 'open\\F');
  const x12 = parse(fixture('x12-850-po.x12'));
  assert.equal(unescapeValue(x12, 'a?b'), 'a?b');
});
