'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/validate-env.js');

const FIXTURES = [
  { file: 'edifact-valid.edi', format: 'edifact', prefix: 'EDIFACT-' },
  { file: 'edifact-multi.edi', format: 'edifact', prefix: 'EDIFACT-' },
  { file: 'edifact-groups.edi', format: 'edifact', prefix: 'EDIFACT-' },
  { file: 'x12-valid.x12', format: 'x12', prefix: 'X12-' },
  { file: 'x12-multi.x12', format: 'x12', prefix: 'X12-' },
  { file: 'hl7-valid.hl7', format: 'hl7', prefix: 'HL7-' },
  { file: 'hl7-batch.hl7', format: 'hl7', prefix: 'HL7-' },
];

/** Small deterministic pseudo-random sequence so failures are reproducible. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "+:'?*~|^&\\\r\n \u0000é﻿AZ09UNBUNHUNTISAIEAMSH";

function mutate(text, random) {
  const pick = (n) => Math.floor(random() * n);
  const op = pick(7);
  if (text.length === 0) return ALPHABET.charAt(pick(ALPHABET.length));
  const at = pick(text.length);
  switch (op) {
    case 0:
      return text.slice(0, at) + text.slice(at + 1 + pick(20));
    case 1:
      return text.slice(0, at) + ALPHABET.charAt(pick(ALPHABET.length)) + text.slice(at);
    case 2:
      return text.slice(0, at);
    case 3: {
      const lines = text.split('\n');
      const k = pick(lines.length);
      lines.splice(k, 0, lines[k]);
      return lines.join('\n');
    }
    case 4: {
      const lines = text.split('\n');
      const i = pick(lines.length);
      const j = pick(lines.length);
      const tmp = lines[i];
      lines[i] = lines[j];
      lines[j] = tmp;
      return lines.join('\n');
    }
    case 5:
      return text.slice(0, at) + ALPHABET.charAt(pick(ALPHABET.length)) + text.slice(at + 1);
    default: {
      let junk = '';
      for (let n = pick(10); n > 0; n--) junk += String.fromCharCode(pick(256));
      return text.slice(0, at) + junk + text.slice(at);
    }
  }
}

test('general: fuzz - validate never throws and keeps every range inside the text', () => {
  const random = makeRandom(20240115);
  let validated = 0;
  for (const f of FIXTURES) {
    const base = env.fixture(f.file);
    for (let n = 0; n < 250; n++) {
      let text = base;
      for (let k = 1 + Math.floor(random() * 3); k > 0; k--) text = mutate(text, random);
      const message = env.parseAs(text, f.format);
      let issues;
      assert.doesNotThrow(() => {
        issues = env.validate(message);
      }, 'validate threw for ' + f.file + ' mutation ' + n + ': ' + JSON.stringify(text));
      assert.ok(Array.isArray(issues));
      assert.ok(!issues.some((i) => /-INTERNAL$/.test(i.code)), 'internal error for ' + JSON.stringify(text));
      env.assertShape(issues, text, [f.prefix]);
      validated++;
    }
  }
  assert.equal(validated, FIXTURES.length * 250);
});

test('general: fuzz - random binary garbage in every format', () => {
  const random = makeRandom(7);
  for (const format of ['edifact', 'x12', 'hl7']) {
    for (let n = 0; n < 40; n++) {
      let text = '';
      for (let k = Math.floor(random() * 3000); k > 0; k--) text += String.fromCharCode(Math.floor(random() * 256));
      const issues = env.run(text, format);
      env.assertShape(issues, text, ['EDIFACT-', 'X12-', 'HL7-']);
    }
  }
});

test('general: fuzz - damaged message objects do not throw', () => {
  const random = makeRandom(99);
  const fields = ['id', 'index', 'offset', 'end', 'raw', 'elements', 'occurrence', 'line'];
  for (const f of FIXTURES) {
    const text = env.fixture(f.file);
    for (let n = 0; n < 40; n++) {
      const message = env.parseAs(text, f.format);
      for (const seg of message.segments) {
        if (random() < 0.3) delete seg[fields[Math.floor(random() * fields.length)]];
        if (random() < 0.1 && Array.isArray(seg.elements)) seg.elements = seg.elements.map(() => null);
      }
      if (random() < 0.2) message.segments[Math.floor(random() * message.segments.length)] = null;
      assert.doesNotThrow(() => env.validate(message), f.file + ' damaged ' + n);
    }
  }
});

test('general: unusable input returns an empty list', () => {
  assert.deepEqual(env.validate(null), []);
  assert.deepEqual(env.validate(undefined), []);
  assert.deepEqual(env.validate('text'), []);
  assert.deepEqual(env.validate({}), []);
  assert.deepEqual(env.validate({ format: 'csv', text: 'a,b', segments: [] }), []);
});

test('general: message objects with missing arrays and null entries', () => {
  const none = { format: 'edifact', text: '', segments: null };
  assert.deepEqual(env.codes(env.validate(none)), ['EDIFACT-NO-SEGMENTS']);
  const odd = { format: 'x12', text: 'ISA', segments: [null, { id: 'ISA' }, 5, {}] };
  assert.doesNotThrow(() => env.validate(odd));
});

test('general: maxIssues caps and orders the result', () => {
  let text = 'MSH|^~\\&|A|B|C|D|20240115||ADT^A01|M1|P|2.5\n';
  for (let i = 0; i < 700; i++) text += 'x' + (i % 10) + 'y|1\n';
  const all = env.run(text, 'hl7', { maxIssues: 5000 });
  assert.equal(all.length, 700);
  assert.equal(env.run(text, 'hl7').length, 500);
  const few = env.run(text, 'hl7', { maxIssues: 3 });
  assert.equal(few.length, 3);
  assert.deepEqual(few, all.slice(0, 3));
  assert.deepEqual(env.run(text, 'hl7', { maxIssues: 0 }), []);
});

test('general: issues are returned sorted by offset', () => {
  const text = env.fixture('hl7-batch.hl7').replace('BTS|2', 'BTS|9').replace('FTS|2', 'FTS|9').replace('M1', '');
  const issues = env.run(text, 'hl7');
  assert.ok(issues.length >= 3);
  for (let i = 1; i < issues.length; i++) assert.ok(issues[i - 1].offset <= issues[i].offset);
});

test('general: includeParseIssues prepends the syntax issues stored by the parser', () => {
  const message = env.parseAs(env.fixture('x12-valid.x12'), 'x12');
  message.issues = [{ severity: 'warning', code: 'bad-thing', message: 'Parser note.', offset: 2, end: 4, segmentIndex: 0 }];
  assert.deepEqual(env.validate(message), []);
  const issues = env.validate(message, { includeParseIssues: true });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'bad-thing');
  assert.equal(issues[0].severity, 'warning');
});

test('general: validate does not modify the message', () => {
  const message = env.parseAs(env.fixture('edifact-multi.edi'), 'edifact');
  const before = JSON.stringify(message);
  env.validate(message);
  assert.equal(JSON.stringify(message), before);
});

test('general: validation is deterministic', () => {
  const text = env.fixture('edifact-multi.edi').replace('UNT+5+2', 'UNT+6+3');
  assert.deepEqual(env.run(text, 'edifact'), env.run(text, 'edifact'));
});

test('general: every issue has a stable code prefix and a plain message', () => {
  const broken = [
    ['edifact', env.fixture('edifact-truncated.edi')],
    ['x12', env.fixture('x12-valid.x12').slice(0, 130)],
    ['hl7', 'PID|1\n\nMSH|'],
  ];
  for (const [format, text] of broken) {
    const issues = env.run(text, format);
    assert.ok(issues.length > 0);
    for (const i of issues) {
      assert.match(i.code, /^(EDIFACT|X12|HL7)-[A-Z0-9-]+$/);
      assert.ok(!/undefined|NaN|\[object/.test(i.message), i.message);
    }
  }
});

test('general: a 5 MB interchange validates in under two seconds', (t) => {
  if (env.parser.name !== 'core') {
    t.skip('needs the main parser to build the message quickly');
    return;
  }
  const body = ['BGM+220+PO12345+9', 'DTM+137:20240115:102', 'NAD+BY+BUYER01::9', 'LIN+1++ITEM-A:SRV', 'QTY+21:5', 'LIN+2++ITEM-B:SRV', 'QTY+21:7', 'UNS+S', 'CNT+2:2'];
  const parts = ["UNB+UNOC:3+SENDER01:ZZ+RECEIVER01:ZZ+240115:1030+REF0001'\n"];
  let size = 0;
  let count = 0;
  while (size < 5 * 1024 * 1024) {
    count++;
    const message = ['UNH+' + count + '+ORDERS:D:96A:UN'].concat(body, ['UNT+' + (body.length + 2) + '+' + count]).join("'\n") + "'\n";
    parts.push(message);
    size += message.length;
  }
  parts.push('UNZ+' + count + "+REF0001'\n");
  const text = parts.join('');
  const message = env.parser.parse(text);
  const started = Date.now();
  const issues = env.validate(message, { maxIssues: 10 });
  const elapsed = Date.now() - started;
  assert.deepEqual(issues, []);
  assert.ok(elapsed < 2000, 'validation took ' + elapsed + ' ms');
});
