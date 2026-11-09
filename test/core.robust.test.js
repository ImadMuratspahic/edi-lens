'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/core/parse');
const { pretty, minify, toJSON } = require('../src/core/serialize');
const { locate, resolvePath } = require('../src/core/path');
const { fixture, fixtureNames, checkInvariants } = require('./core.helpers');

/** Small seeded pseudo-random sequence so failures can be repeated. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const FORMATS = [undefined, 'edifact', 'x12', 'hl7'];

test('robust: parse never throws on empty, missing and non-string input', () => {
  for (const input of ['', ' ', '\n', undefined, null, 42, {}, []]) {
    for (const format of FORMATS) {
      const message = parse(input, format ? { format } : undefined);
      assert.ok(['edifact', 'x12', 'hl7'].includes(message.format));
      assert.ok(Array.isArray(message.segments));
      assert.ok(Array.isArray(message.issues));
    }
  }
  assert.ok(parse('').issues.some((i) => i.code === 'empty-input'));
});

test('robust: unrecognised text gives an unknown-format issue and no segments', () => {
  const message = parse('This is just a letter to a friend.');
  assert.equal(message.segments.length, 0);
  const issue = message.issues.find((i) => i.code === 'unknown-format');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
  assert.equal(issue.segmentIndex, -1);
});

test('robust: random binary garbage never throws and keeps the structure consistent', () => {
  const random = makeRandom(12345);
  for (let n = 0; n < 150; n++) {
    const length = Math.floor(random() * 400);
    let text = '';
    for (let i = 0; i < length; i++) {
      text += String.fromCharCode(Math.floor(random() * (n % 2 === 0 ? 256 : 65536)));
    }
    for (const format of FORMATS) {
      const message = parse(text, format ? { format } : undefined);
      checkInvariants(message);
      pretty(message);
      minify(message);
      toJSON(message);
    }
  }
});

test('robust: garbage built from delimiter characters never throws', () => {
  const random = makeRandom(777);
  const alphabet = ["'", '+', ':', '?', '*', '~', '|', '^', '&', '\\', '\r', '\n', 'U', 'N', 'B', 'I', 'S', 'A', 'M', 'H', '1', ' '];
  for (let n = 0; n < 300; n++) {
    let text = n % 3 === 0 ? 'UNA:+.? ' : n % 3 === 1 ? 'ISA*' : 'MSH|';
    const length = Math.floor(random() * 300);
    for (let i = 0; i < length; i++) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    for (const format of FORMATS) {
      const message = parse(text, format ? { format } : undefined);
      checkInvariants(message);
      for (let o = 0; o < text.length; o += 7) {
        locate(message, o);
        locate(message, o, { inclusiveEnd: true });
      }
    }
  }
});

test('robust: every fixture cut off at any point still parses with a consistent structure', () => {
  for (const name of fixtureNames()) {
    const text = fixture(name);
    const step = Math.max(1, Math.floor(text.length / 150));
    for (let cut = 0; cut <= text.length; cut += step) {
      const message = parse(text.slice(0, cut));
      checkInvariants(message);
      assert.equal(message.text.length, cut);
    }
  }
});

test('robust: a truncated interchange reports the missing terminator', () => {
  const text = fixture('orders-d96a.edi');
  const cut = text.indexOf('QTY+21:60') + 6;
  const message = parse(text.slice(0, cut));
  assert.ok(message.issues.some((i) => i.code === 'unterminated-segment'));
  assert.equal(message.segments[message.segments.length - 1].id, 'QTY');
  const hl7 = parse(fixture('hl7-adt-a01.hl7').slice(0, 70));
  assert.equal(hl7.segments.length, 1);
  assert.deepEqual(hl7.issues, []);
});

test('robust: a file made of terminators only reports empty segment ids', () => {
  const message = parse("UNB+A'''''UNZ+1'");
  assert.equal(message.segments.filter((s) => s.id === '').length, 4);
  assert.equal(message.issues.filter((i) => i.code === 'empty-segment-id').length, 4);
  checkInvariants(message);
});

test('robust: the number of recorded issues is limited', () => {
  const text = "UNB+A'" + "'".repeat(5000);
  const message = parse(text);
  assert.ok(message.issues.length <= 1001);
  assert.equal(message.issues[message.issues.length - 1].code, 'too-many-issues');
  const small = parse(text, { maxIssues: 10 });
  assert.equal(small.issues.length, 11);
});

test('robust: resolvePath and locate stay safe on messages without segments', () => {
  const message = parse('nothing here');
  assert.equal(resolvePath(message, 'UNB[1]'), null);
  assert.equal(locate(message, 0), null);
});

/** Builds a large message of roughly the requested size from repeated lines. */
function build(lineFor, header, footer, size) {
  const parts = [header];
  let length = header.length + footer.length;
  let i = 0;
  while (length < size) {
    const line = lineFor(i++);
    parts.push(line);
    length += line.length;
  }
  parts.push(footer);
  return parts.join('');
}

test('robust: a 5 MB UN/EDIFACT input parses in under 2 seconds', () => {
  const text = build(
    (i) => 'LIN+' + (i + 1) + '++40000' + String(i).padStart(7, '0') + ":EN'QTY+21:" + (i % 90) + "'PRI+AAA:12.50:CT'\n",
    "UNA:+.? 'UNB+UNOC:3+SENDER+RECEIVER+240101:1200+1'UNH+1+ORDERS:D:96A:UN'\n",
    "UNT+3+1'UNZ+1+1'\n",
    5 * 1024 * 1024
  );
  assert.ok(text.length >= 5 * 1024 * 1024);
  const started = Date.now();
  const message = parse(text);
  const elapsed = Date.now() - started;
  assert.ok(message.segments.length > 100000);
  assert.deepEqual(message.issues, []);
  assert.ok(elapsed < 2000, 'took ' + elapsed + ' ms');
});

test('robust: a 5 MB X12 input parses in under 2 seconds', () => {
  const isa = fixture('x12-850-po.x12').slice(0, 106);
  const text = build(
    (i) => 'PO1*' + (i + 1) + '*24*EA*12.50**UP*0400000' + String(i).padStart(5, '0') + '~REF*DP*045~\n',
    isa + '\nGS*PO*A*B*20240115*0930*101*X*004010~ST*850*0001~\n',
    'SE*3*0001~GE*1*101~IEA*1*000000101~\n',
    5 * 1024 * 1024
  );
  const started = Date.now();
  const message = parse(text);
  const elapsed = Date.now() - started;
  assert.ok(message.segments.length > 100000);
  assert.deepEqual(message.issues, []);
  assert.ok(elapsed < 2000, 'took ' + elapsed + ' ms');
});

test('robust: a 5 MB HL7 input parses in under 2 seconds', () => {
  const text = build(
    (i) => 'OBX|' + (i + 1) + '|NM|718-7^Hemoglobin^LN||13.' + (i % 10) + '|g/dL|12.0-16.0|N|||F\r',
    'MSH|^~\\&|LABSYS|CITYLAB|EHR|GENHOSP|20240116101500||ORU^R01^ORU_R01|LAB00042|P|2.5.1\r',
    'NTE|1||done\r',
    5 * 1024 * 1024
  );
  const started = Date.now();
  const message = parse(text);
  const elapsed = Date.now() - started;
  assert.ok(message.segments.length > 50000);
  assert.deepEqual(message.issues, []);
  assert.ok(elapsed < 2000, 'took ' + elapsed + ' ms');
});

test('robust: 5 MB of garbage without any delimiter parses in under 2 seconds', () => {
  const text = 'x'.repeat(5 * 1024 * 1024);
  for (const format of ['edifact', 'x12', 'hl7']) {
    const started = Date.now();
    const message = parse(text, { format });
    const elapsed = Date.now() - started;
    assert.ok(message.segments.length <= 1);
    assert.ok(elapsed < 2000, format + ' took ' + elapsed + ' ms');
  }
});
