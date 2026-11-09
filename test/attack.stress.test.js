'use strict';

/*
 * Size and speed tests: 20 MB inputs (run in their own processes so the
 * memory figures are real), 100,000 repeated segments, very long segments,
 * long runs of blank lines and a 5 MB file within the two second budget of
 * the specification. Set EDI_LENS_SKIP_STRESS=1 to leave out the 20 MB runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parse } = require('../src/core/parse.js');
const { pretty, minify } = require('../src/core/serialize.js');
const { validate } = require('../src/core/validate.js');
const { resolvePath, locate } = require('../src/core/path.js');
const { compare, toText, toHtml } = require('../src/pro/diff.js');
const { toCsv, toXml, toJsonText } = require('../src/pro/export.js');
const kit = require('./helpers/attack-kit.js');

const SKIP_BIG = process.env.EDI_LENS_SKIP_STRESS === '1';

/** Runs the child process for one format and size and returns its measurements. */
function runChild(format, megabytes) {
  const script = path.join(__dirname, 'helpers', 'attack-stress-child.js');
  const run = spawnSync(process.execPath, ['--max-old-space-size=4096', script, format, String(megabytes)], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 240000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, 'child failed: ' + run.stderr);
  return JSON.parse(run.stdout);
}

for (const format of ['edifact', 'x12', 'hl7']) {
  test('stress: a 20 MB ' + format + ' file is read, validated and reformatted within time and memory limits', { skip: SKIP_BIG }, () => {
    const r = runChild(format, 20);
    assert.ok(r.chars >= 20 * 1024 * 1024);
    assert.equal(r.segments, r.expectedSegments);
    assert.equal(r.issues, 0, 'parse issues');
    assert.equal(r.validateIssues, 0, 'validation issues');
    assert.ok(r.parseMs < 30000, 'parse took ' + r.parseMs + ' ms');
    assert.ok(r.validateMs < 30000, 'validate took ' + r.validateMs + ' ms');
    assert.ok(r.minifyMs < 15000 && r.prettyMs < 15000, 'reformat took ' + r.minifyMs + ' and ' + r.prettyMs + ' ms');
    assert.ok(r.pathMs < 5000 && r.locateMs < 1000, 'lookups took ' + r.pathMs + ' and ' + r.locateMs + ' ms');
    assert.ok(r.heapPeakMB < 3500, 'peak heap ' + r.heapPeakMB + ' MB');
    assert.equal(r.pathFound, true);
    assert.ok(/^[A-Z0-9]+\[\d+\]/.test(r.locatePath), r.locatePath);
    assert.equal(r.minifyEqualsLength, true);
  });
}

test('stress: a 5 MB file is read in under two seconds, as the specification requires', () => {
  const text = kit.bigEdifact(Math.ceil((5 * 1024 * 1024) / 40));
  assert.ok(text.length >= 5 * 1024 * 1024);
  const started = Date.now();
  const m = parse(text);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, 'took ' + elapsed + ' ms');
  assert.deepEqual(m.issues, []);
  assert.deepEqual(validate(m), []);
});

/** Returns a message with count repeated body segments for the given format. */
function repeated(format, count) {
  if (format === 'edifact') return "UNB+UNOA:1+A+B+200101:1200+1'UNH+1+X'" + "NAD+BY+123::9'".repeat(count) + 'UNT+' + (count + 2) + "+1'UNZ+1+1'";
  if (format === 'x12') {
    const isa = ['ISA', '00', ''.padEnd(10), '00', ''.padEnd(10), 'ZZ', 'S'.padEnd(15), 'ZZ', 'R'.padEnd(15), '210101', '1200', '^', '00501', '000000001', '0', 'P', ':'].join('*') + '~';
    return isa + 'GS*PO*A*B*20210101*1200*1*X*005010~ST*850*0001~' + 'REF*AB*1^2~'.repeat(count) + 'SE*' + (count + 2) + '*0001~GE*1*1~IEA*1*000000001~';
  }
  return 'MSH|^~\\&|A|B|C|D|20200101||ADT^A01|1|P|2.5\r' + 'OBX|1|ST|a^b|1|x&y~z\r'.repeat(count);
}

for (const format of ['edifact', 'x12', 'hl7']) {
  test('stress: 100,000 repeated ' + format + ' segments through every function', () => {
    const text = repeated(format, 100000);
    const started = Date.now();
    const m = parse(text);
    assert.equal(m.segments.length, format === 'edifact' ? 100004 : format === 'x12' ? 100006 : 100001);
    assert.deepEqual(m.issues, []);
    assert.deepEqual(validate(m), []);
    const last = m.segments[m.segments.length - 4];
    assert.equal(resolvePath(m, last.id + '[' + last.occurrence + ']').value, last.raw);
    assert.equal(locate(m, last.offset + 1).segment.index, last.index);
    assert.equal(parse(minify(m)).segments.length, m.segments.length);
    assert.equal(parse(pretty(m)).segments.length, m.segments.length);
    const same = compare(m, parse(text));
    assert.ok(same.identical);
    assert.equal(same.summary.unchanged, m.segments.length);
    assert.ok(Date.now() - started < 20000, 'took ' + (Date.now() - started) + ' ms');
  });
}

test('stress: 100,000 segments with one change in the middle give exactly one difference', () => {
  const half = 'NAD+BY+123::9\'';
  const a = "UNB+UNOA:1+A+B+1'UNH+1+X'" + half.repeat(50000) + "NAD+BY+123::9'" + half.repeat(50000) + "UNT+100003+1'UNZ+1+1'";
  const b = a.replace(half.repeat(50000) + "NAD+BY+123::9'", half.repeat(50000) + "NAD+BY+123::8'");
  assert.notEqual(a, b);
  const started = Date.now();
  const r = compare(parse(a), parse(b));
  assert.equal(r.summary.changed, 1);
  assert.equal(r.summary.added + r.summary.removed, 0);
  const entry = r.segments.find((e) => e.status === 'changed');
  assert.equal(entry.differences[0].path, 'NAD[50001]-2.3');
  assert.ok(Date.now() - started < 10000);
});

test('stress: two long unrelated segment lists fall back to the fast alignment and still add up', () => {
  const ids = ['LIN', 'QTY', 'NAD', 'DTM', 'MOA'];
  const make = (offset, count) => {
    let t = "UNB+UNOA:1+A+B+1'UNH+1+X'";
    for (let i = 0; i < count; i++) t += ids[(i * 7 + offset + (i >> 3)) % ids.length] + '+' + (i % 13) + "'";
    return t + "UNT+1+1'UNZ+1+1'";
  };
  const A = parse(make(0, 6000));
  const B = parse(make(2, 6000));
  const started = Date.now();
  const r = compare(A, B);
  assert.equal(r.approximate, true);
  const s = r.summary;
  assert.equal(s.added + s.changed + s.unchanged, B.segments.length);
  assert.equal(s.removed + s.changed + s.unchanged, A.segments.length);
  assert.ok(toText(r).length > 0 && toHtml(r).length > 0);
  assert.ok(Date.now() - started < 20000, 'took ' + (Date.now() - started) + ' ms');
});

test('stress: one segment with 2,000,000 elements, one element with 2,000,000 components', () => {
  const started = Date.now();
  const wide = parse("UNB+UNOA:1+A+B+1'NAD" + '+'.repeat(2000000) + "'UNZ+0+1'");
  assert.equal(wide.segments[1].elements.length, 2000000);
  assert.equal(resolvePath(wide, 'NAD[1]-2000000').value, '');
  assert.equal(resolvePath(wide, 'NAD[1]-2000001'), null);
  const deep = parse("UNB+UNOA:1+A+B+1'NAD+" + ':'.repeat(2000000) + "'UNZ+0+1'");
  assert.equal(deep.segments[1].elements[0].repetitions[0].components.length, 2000001);
  assert.equal(resolvePath(deep, 'NAD[1]-1.2000001').value, '');
  assert.ok(Date.now() - started < 20000);
});

test('stress: a million subcomponent separators in one HL7 component', () => {
  const m = parse('MSH|^~\\&|A\rPID|' + '&'.repeat(1000000));
  assert.equal(m.segments[1].elements[0].repetitions[0].components[0].subcomponents.length, 1000001);
});

test('stress: 200,000 blank lines and 200,000 empty segments are cheap', () => {
  const started = Date.now();
  const blanks = parse('MSH|^~\\&|A\r' + '\r\n'.repeat(200000) + 'PID|1');
  assert.equal(blanks.segments.length, 2);
  assert.equal(blanks.segments[1].line, 200001);
  assert.ok(Array.isArray(validate(blanks)));
  const empty = parse("UNB+UNOA:1+A+B+1'" + "'".repeat(200000));
  assert.equal(empty.segments.length, 200001);
  assert.equal(empty.issues.length, 1001, 'issues are capped at the default limit plus one note');
  assert.equal(validate(empty).length, 500);
  assert.ok(Date.now() - started < 10000);
});

test('stress: a single huge unterminated segment and a huge garbage line', () => {
  const started = Date.now();
  const x = 'UNB+' + 'abc?'.repeat(500000);
  const m = parse(x);
  assert.equal(m.segments.length, 1);
  assert.ok(m.issues.some((i) => i.code === 'unterminated-segment'));
  assert.ok(m.issues.some((i) => i.code === 'unclosed-release'));
  assert.ok(Array.isArray(validate(m)));
  const h = parse('MSH|^~\\&|' + 'x'.repeat(5000000));
  assert.equal(h.segments[0].elements[2].raw.length, 5000000);
  assert.ok(Date.now() - started < 10000);
});

test('stress: a one million character path or an enormous number is rejected quickly', () => {
  const m = parse("UNB+UNOA:1+A+B+1'NAD+BY'UNZ+0+1'");
  const started = Date.now();
  assert.equal(resolvePath(m, 'NAD[' + '9'.repeat(1000000) + ']'), null);
  assert.equal(resolvePath(m, 'N'.repeat(1000000)), null);
  assert.equal(resolvePath(m, 'NAD-1' + '.1'.repeat(100000)), null);
  assert.ok(Date.now() - started < 3000);
});

test('stress: exports of 100,000 segments finish and stay consistent', () => {
  const m = parse(repeated('hl7', 100000));
  const started = Date.now();
  const csv = toCsv(m);
  const rows = kit.readCsv(csv);
  assert.equal(rows.length, 1 + kit.expectedCsvRows(m).length);
  const json = toJsonText(m);
  assert.equal(JSON.parse(json).segments.length, 100001);
  const xml = toXml(parse(repeated('x12', 20000)));
  const root = kit.readXml(xml);
  assert.equal(root.children.length, 20006);
  assert.ok(Date.now() - started < 30000, 'took ' + (Date.now() - started) + ' ms');
});
